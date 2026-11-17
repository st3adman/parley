// test/recording-api.test.js — the dashboard's recording routes. DATA_DIR must be
// set before the API module loads (env.js resolves it once), hence the dynamic imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'candlekeep-recapi-'));
process.env.DATA_DIR = dataDir;
const express = (await import('express')).default;
const { openDb } = await import('../src/store/db.js');
const { apiRouter } = await import('../src/web/api.js');

async function serve(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, client: null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('recording routes: stream, download, delete', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'dnd', startedAt: '2026-11-01T19:00:00Z' });
  const { base, close } = await serve(db);
  try {
    assert.equal((await fetch(`${base}/api/meetings/${id}/recording`)).status, 404);

    mkdirSync(join(dataDir, 'recordings'), { recursive: true });
    writeFileSync(join(dataDir, 'recordings', `${id}.ogg`), 'OggS-fake');
    db.setMeetingRecording(id, { bytes: 9, durationMs: 1000, startMs: 5 });

    const inline = await fetch(`${base}/api/meetings/${id}/recording`);
    assert.equal(inline.status, 200);
    assert.match(inline.headers.get('content-type'), /audio\/ogg/);
    assert.equal(await inline.text(), 'OggS-fake');

    const dl = await fetch(`${base}/api/meetings/${id}/recording?download=1`);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="dnd-2026-11-01\.ogg"/);

    const ranged = await fetch(`${base}/api/meetings/${id}/recording`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206, 'seeking in the player needs Range support');

    const meeting = await (await fetch(`${base}/api/meetings/${id}`)).json();
    assert.equal(meeting.meeting.recording_bytes, 9);

    assert.equal((await fetch(`${base}/api/meetings/${id}/recording`, { method: 'DELETE' })).status, 200);
    assert.ok(!existsSync(join(dataDir, 'recordings', `${id}.ogg`)));
    assert.equal(db.getMeeting(id).recording_bytes, null);
  } finally { close(); }
});

test('deleting a session deletes its recording', async () => {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'dnd', startedAt: '2026-11-01T19:00:00Z' });
  mkdirSync(join(dataDir, 'recordings'), { recursive: true });
  writeFileSync(join(dataDir, 'recordings', `${id}.ogg`), 'x');
  const { base, close } = await serve(db);
  try {
    assert.equal((await fetch(`${base}/api/meetings/${id}`, { method: 'DELETE' })).status, 200);
    assert.ok(!existsSync(join(dataDir, 'recordings', `${id}.ogg`)));
  } finally { close(); }
});
