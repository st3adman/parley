// test/recording.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OggOpusWriter, readOpusPackets, splitRecording, concatRecordings, oggCrc, PRE_SKIP } from '../src/recording/ogg.js';
import { layoutTracks, mixBlocks, encodeRecording, createEncoder } from '../src/recording/mix.js';
import { saveRecording, mergeRecordings, uploadLimitBytes, recordingPath, recordingFilename, formatDuration, postRecording } from '../src/recording/index.js';
import { openDb } from '../src/store/db.js';
import { getGuildConfig, setGuildConfig } from '../src/store/config.js';
import { validateSetup } from '../src/commands/setup-logic.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'candlekeep-rec-test-'));
const packet = (i, len = 40) => Buffer.alloc(len, i % 256);

// 16 kHz mono s16le: `ms` milliseconds of a constant sample value.
function pcm(ms, value) {
  const a = new Int16Array(ms * 16).fill(value);
  return Buffer.from(a.buffer);
}

test('oggCrc matches the Ogg reference polynomial', () => {
  // CRC-32/MPEG-2 style without final xor/reflection; "123456789" → 0x89a1897f.
  assert.equal(oggCrc(Buffer.from('123456789')), 0x89a1897f);
});

test('OggOpusWriter round-trips packets, including ones over 255 bytes', () => {
  const dir = tmp();
  const path = join(dir, 'a.ogg');
  const w = new OggOpusWriter(path);
  const sent = [];
  for (let i = 0; i < 120; i++) { const p = packet(i, i === 7 ? 700 : 40); sent.push(p); w.write(p); }
  const res = w.close();
  assert.equal(res.durationMs, 120 * 20);
  assert.equal(res.bytes, statSync(path).size);
  const back = readOpusPackets(path);
  assert.equal(back.length, 120);
  assert.ok(back.every((p, i) => p.equals(sent[i])));
  const buf = readFileSync(path);
  assert.equal(buf.toString('ascii', 0, 4), 'OggS');
  assert.equal(buf[5], 0x02, 'first page is beginning-of-stream');
  assert.equal(buf.readUInt16LE(28 + 10), PRE_SKIP, 'OpusHead pre-skip');
  rmSync(dir, { recursive: true });
});

test('splitRecording keeps every part under the limit and every packet in order', () => {
  const dir = tmp();
  const path = join(dir, 'a.ogg');
  const w = new OggOpusWriter(path);
  const sent = [];
  for (let i = 0; i < 3000; i++) { const p = packet(i, 30 + (i % 50)); sent.push(p); w.write(p); }
  w.close();
  const limit = 40 * 1024;
  const parts = splitRecording(path, limit, (n) => join(dir, `p${n}.ogg`));
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(statSync(p).size <= limit, `${p} is ${statSync(p).size} bytes`);
  const joined = parts.flatMap((p) => readOpusPackets(p));
  assert.equal(joined.length, sent.length);
  assert.ok(joined.every((p, i) => p.equals(sent[i])));
  // Fits already: returned as-is.
  assert.deepEqual(splitRecording(path, 10 * 1024 * 1024, () => 'unused'), [path]);
  rmSync(dir, { recursive: true });
});

test('concatRecordings joins files in order', () => {
  const dir = tmp();
  const make = (name, from, n) => {
    const w = new OggOpusWriter(join(dir, name));
    for (let i = from; i < from + n; i++) w.write(packet(i));
    w.close();
    return join(dir, name);
  };
  const a = make('a.ogg', 0, 10);
  const b = make('b.ogg', 10, 5);
  const res = concatRecordings([a, b], join(dir, 'ab.ogg'));
  assert.equal(res.durationMs, 15 * 20);
  const back = readOpusPackets(join(dir, 'ab.ogg'));
  assert.deepEqual(back.map((p) => p[0]), [...Array(15).keys()]);
  rmSync(dir, { recursive: true });
});

test('mixBlocks lays tracks on one timeline and sums overlaps with clipping', () => {
  const dir = tmp();
  const t0 = 1_700_000_000_000;
  writeFileSync(join(dir, 'a.pcm'), pcm(1500, 1000)); // 0 – 1.5 s
  writeFileSync(join(dir, 'b.pcm'), pcm(1000, 2000)); // 1 – 2 s
  writeFileSync(join(dir, 'c.pcm'), pcm(500, 32000)); // 1.2 – 1.7 s (clips with b)
  writeFileSync(join(dir, 'empty.pcm'), Buffer.alloc(0));
  const tracks = [
    { startMs: t0 + 1000, pcmPath: join(dir, 'b.pcm') },
    { startMs: t0, pcmPath: join(dir, 'a.pcm') },
    { startMs: t0 + 1200, pcmPath: join(dir, 'c.pcm') },
    { startMs: t0 + 5, pcmPath: join(dir, 'empty.pcm') },
    { startMs: t0, pcmPath: join(dir, 'missing.pcm') },
  ];
  const layout = layoutTracks(tracks);
  assert.equal(layout.originMs, t0);
  assert.equal(layout.totalSamples, 2000 * 16);
  const mixed = Buffer.concat([...mixBlocks(tracks)]);
  const at = (ms) => mixed.readInt16LE(ms * 16 * 2);
  assert.equal(mixed.length, 2000 * 16 * 2);
  assert.equal(at(500), 1000);
  assert.equal(at(1100), 3000);
  assert.equal(at(1300), 32767, 'clipped');
  assert.equal(at(1600), 32767);
  assert.equal(at(1800), 2000);
  rmSync(dir, { recursive: true });
});

test('encodeRecording produces a playable-length Ogg Opus file with a real encoder', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.pcm'), pcm(3000, 500));
  writeFileSync(join(dir, 'b.pcm'), pcm(1010, -500));
  const t0 = 1_700_000_000_000;
  const out = join(dir, 'out.ogg');
  const res = await encodeRecording([
    { startMs: t0, pcmPath: join(dir, 'a.pcm') },
    { startMs: t0 + 4000, pcmPath: join(dir, 'b.pcm') },
  ], out, { encoder: createEncoder() });
  assert.equal(res.startMs, t0);
  assert.equal(res.durationMs, 5020, '5.01 s rounds up to whole 20 ms frames');
  assert.equal(readOpusPackets(out).length, 251);
  assert.equal(await encodeRecording([], join(dir, 'none.ogg')), null);
  rmSync(dir, { recursive: true });
});

test('saveRecording stores the file and its size/length on the meeting; merge joins them', async () => {
  const dataDir = tmp();
  const db = openDb(':memory:');
  const a = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'Tavern Talk', startedAt: '2026-11-01T19:00:00Z' });
  const b = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'Tavern Talk', startedAt: '2026-11-01T20:00:00Z' });
  const t0 = 1_700_000_000_000;
  writeFileSync(join(dataDir, 'a.pcm'), pcm(2000, 100));
  writeFileSync(join(dataDir, 'b.pcm'), pcm(1000, 100));
  const fake = { encode: () => packet(1) };
  const ra = await saveRecording(db, a, [{ startMs: t0, pcmPath: join(dataDir, 'a.pcm') }], { dataDir, encoder: fake });
  await saveRecording(db, b, [{ startMs: t0, pcmPath: join(dataDir, 'b.pcm') }], { dataDir, encoder: fake });
  const m = db.getMeeting(a);
  assert.equal(m.recording_bytes, statSync(recordingPath(dataDir, a)).size);
  assert.equal(m.recording_ms, 2000);
  assert.equal(m.recording_start_ms, t0);
  assert.equal(ra.durationMs, 2000);
  assert.equal(recordingFilename(m), 'tavern-talk-2026-11-01.ogg');

  // Merge b into a: one file of both, b's file gone, start unknown (gaps dropped).
  db.mergeMeetings(a, [b]);
  mergeRecordings(db, a, [a, b], { dataDir });
  assert.equal(db.getMeeting(a).recording_ms, 3000);
  assert.equal(db.getMeeting(a).recording_start_ms, null);
  assert.ok(!existsSync(recordingPath(dataDir, b)));
  rmSync(dataDir, { recursive: true });
});

test('postRecording posts one file, or numbered parts over the upload limit', async () => {
  const dataDir = tmp();
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'dnd', startedAt: '2026-11-01T19:00:00Z' });
  writeFileSync(join(dataDir, 'a.pcm'), pcm(1000, 100));
  await saveRecording(db, id, [{ startMs: 0, pcmPath: join(dataDir, 'a.pcm') }], { dataDir, encoder: { encode: () => packet(1, 200) } });
  const sent = [];
  const target = { send: async (m) => { sent.push({ ...m, size: statSync(m.files[0].attachment).size }); } };
  assert.deepEqual(await postRecording(target, db.getMeeting(id), { dataDir }), { posted: 1 });
  assert.equal(sent[0].files[0].name, 'dnd-2026-11-01.ogg');
  assert.match(sent[0].content, /Session recording/);
  assert.equal(await postRecording(target, { id: 999 }, { dataDir }).then((r) => r.posted), 0);
  rmSync(dataDir, { recursive: true });
});

test('uploadLimitBytes follows the server boost level', () => {
  assert.equal(uploadLimitBytes(0), 10 * 1024 * 1024);
  assert.equal(uploadLimitBytes(1), 10 * 1024 * 1024);
  assert.equal(uploadLimitBytes(2), 50 * 1024 * 1024);
  assert.equal(uploadLimitBytes(3), 100 * 1024 * 1024);
  assert.equal(formatDuration(3 * 3600_000 + 5 * 60_000), '3h 05m');
  assert.equal(formatDuration(42 * 60_000), '42m');
});

test('keepAudio is off by default, settable via /setup and stored', () => {
  const db = openDb(':memory:');
  assert.equal(getGuildConfig(db, 'g').keepAudio, false);
  const r = validateSetup({ keepAudio: true }, {});
  assert.deepEqual(r, { ok: true, patch: { keepAudio: true } });
  setGuildConfig(db, 'g', r.patch);
  assert.equal(getGuildConfig(db, 'g').keepAudio, true);
  setGuildConfig(db, 'g', { nickname: 'st3bot' });
  assert.equal(getGuildConfig(db, 'g').keepAudio, true, 'other changes keep it');
});
