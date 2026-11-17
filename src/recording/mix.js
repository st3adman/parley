// src/recording/mix.js
// Mix the per-speaker PCM tracks into one timeline and encode it as Ogg Opus.
// Captured PCM is s16le / 16 kHz / mono (see voice/audio.js); each track file
// starts at its `startMs` (absolute epoch ms). Works a second at a time so a
// multi-hour session never sits in memory.
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setImmediate as nextTick } from 'node:timers/promises';
import { OggOpusWriter } from './ogg.js';

export const SAMPLE_RATE = 16000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
const FRAME = 320; // 20 ms at 16 kHz
const BLOCK = SAMPLE_RATE; // mix one second at a time
// 16 kbps is clear for speech at 16 kHz and comes to about 7 MB per hour.
export const BITRATE = 16000;

const require = createRequire(import.meta.url);

/** An Opus encoder with `encode(pcm) → packet`; native if available, else opusscript. */
export function createEncoder({ bitrate = BITRATE } = {}) {
  try {
    const { OpusEncoder } = require('@discordjs/opus');
    const enc = new OpusEncoder(SAMPLE_RATE, 1);
    enc.setBitrate(bitrate);
    return { encode: (pcm) => enc.encode(pcm) };
  } catch {
    const OpusScript = require('opusscript');
    const enc = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
    enc.setBitrate(bitrate);
    return { encode: (pcm) => Buffer.from(enc.encode(pcm, FRAME)) };
  }
}

/** Lay the tracks out on a shared timeline (sample offsets from the earliest start). */
export function layoutTracks(tracks) {
  const withSize = tracks
    .map((t) => {
      let bytes = 0;
      try { bytes = statSync(t.pcmPath).size; } catch { /* missing track: skip */ }
      return { ...t, samples: Math.floor(bytes / 2) };
    })
    .filter((t) => t.samples > 0);
  if (!withSize.length) return { tracks: [], totalSamples: 0, originMs: null };
  const originMs = Math.min(...withSize.map((t) => t.startMs));
  const laid = withSize
    .map((t) => ({ ...t, offset: Math.round((t.startMs - originMs) * SAMPLES_PER_MS) }))
    .sort((a, b) => a.offset - b.offset);
  const totalSamples = Math.max(...laid.map((t) => t.offset + t.samples));
  return { tracks: laid, totalSamples, originMs };
}

/** Yields mixed mono s16le blocks (Buffers of up to BLOCK samples). */
export function* mixBlocks(tracks) {
  const { tracks: laid, totalSamples } = layoutTracks(tracks);
  const fds = new Map();
  const acc = new Int32Array(BLOCK);
  const samples = new Int16Array(BLOCK);
  const read = Buffer.from(samples.buffer);
  let first = 0; // tracks before this index have ended
  try {
    for (let start = 0; start < totalSamples; start += BLOCK) {
      const len = Math.min(BLOCK, totalSamples - start);
      acc.fill(0, 0, len);
      while (first < laid.length && laid[first].offset + laid[first].samples <= start) {
        const fd = fds.get(first);
        if (fd !== undefined) { closeSync(fd); fds.delete(first); }
        first++;
      }
      for (let i = first; i < laid.length && laid[i].offset < start + len; i++) {
        const t = laid[i];
        const from = Math.max(start, t.offset);
        const to = Math.min(start + len, t.offset + t.samples);
        if (to <= from) continue;
        if (!fds.has(i)) fds.set(i, openSync(t.pcmPath, 'r'));
        const n = readSync(fds.get(i), read, 0, (to - from) * 2, (from - t.offset) * 2) >> 1;
        for (let s = 0; s < n; s++) acc[from - start + s] += samples[s];
      }
      const out = new Int16Array(len);
      for (let s = 0; s < len; s++) out[s] = Math.max(-32768, Math.min(32767, acc[s]));
      yield Buffer.from(out.buffer);
    }
  } finally {
    for (const fd of fds.values()) closeSync(fd);
  }
}

/**
 * Mix `tracks` ({ startMs, pcmPath }) into one Ogg Opus file at `outPath`.
 * Returns { bytes, durationMs, startMs }, or null when there is no audio. Yields to the
 * event loop between seconds so a long encode never stalls the Discord gateway.
 */
export async function encodeRecording(tracks, outPath, { title = null, encoder = createEncoder() } = {}) {
  const { totalSamples, originMs } = layoutTracks(tracks);
  if (!totalSamples) return null;
  const w = new OggOpusWriter(outPath, { inputRate: SAMPLE_RATE, channels: 1, title });
  let carry = Buffer.alloc(0);
  for (const block of mixBlocks(tracks)) {
    const buf = carry.length ? Buffer.concat([carry, block]) : block;
    let off = 0;
    for (; off + FRAME * 2 <= buf.length; off += FRAME * 2) w.write(encoder.encode(buf.subarray(off, off + FRAME * 2)));
    carry = buf.subarray(off);
    await nextTick();
  }
  if (carry.length) {
    // Pad the final partial frame with silence.
    const last = Buffer.alloc(FRAME * 2);
    carry.copy(last);
    w.write(encoder.encode(last));
  }
  return { ...w.close(), startMs: originMs };
}
