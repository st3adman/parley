// src/recording/ogg.js
// Minimal Ogg Opus muxer/demuxer (RFC 7845). Enough to write the session
// recording, read its packets back, and remux them into one file (merge) or
// several smaller ones (Discord upload limits) without re-encoding.
import { openSync, writeSync, closeSync, readFileSync, statSync } from 'node:fs';
import { randomInt } from 'node:crypto';

// Ogg's CRC-32: polynomial 0x04c11db7, no bit reflection, init 0.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc;
}

// Opus always counts granule positions at 48 kHz, whatever the input rate.
export const SAMPLES_PER_FRAME_48K = 960; // one 20 ms packet
export const PRE_SKIP = 312; // libopus' standard encoder lookahead at 48 kHz

function opusHead({ inputRate, channels }) {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1; // version
  b[9] = channels;
  b.writeUInt16LE(PRE_SKIP, 10);
  b.writeUInt32LE(inputRate, 12);
  b.writeInt16LE(0, 16); // output gain
  b[18] = 0; // channel mapping family 0 (mono/stereo)
  return b;
}

function opusTags(title) {
  const vendor = Buffer.from('Candlekeep');
  const comments = title ? [Buffer.from(`TITLE=${title}`)] : [];
  const parts = [Buffer.from('OpusTags'), u32(vendor.length), vendor, u32(comments.length)];
  for (const c of comments) parts.push(u32(c.length), c);
  return Buffer.concat(parts);
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

function page({ headerType, granule, serial, seq, packets }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const h = Buffer.alloc(27 + lacing.length);
  h.write('OggS', 0, 'ascii');
  h[4] = 0;
  h[5] = headerType;
  h.writeBigInt64LE(BigInt(granule), 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h.writeUInt32LE(0, 22); // CRC, filled below
  h[26] = lacing.length;
  Buffer.from(lacing).copy(h, 27);
  const out = Buffer.concat([h, ...packets]);
  out.writeUInt32LE(oggCrc(out), 22);
  return out;
}

/**
 * Streams Opus packets into an .ogg file. Packets are grouped about one second
 * per page (a page per 20 ms packet would add ~11 kbps of header overhead).
 */
export class OggOpusWriter {
  constructor(path, { inputRate = 16000, channels = 1, title = null, packetsPerPage = 50 } = {}) {
    this.fd = openSync(path, 'w');
    this.serial = randomInt(1, 0xffffffff);
    this.seq = 0;
    this.frames = 0;
    this.bytes = 0;
    this.pending = [];
    this.pendingSegments = 0;
    this.packetsPerPage = packetsPerPage;
    this.#emit(page({ headerType: 0x02, granule: 0, serial: this.serial, seq: this.seq++, packets: [opusHead({ inputRate, channels })] }));
    this.#emit(page({ headerType: 0, granule: 0, serial: this.serial, seq: this.seq++, packets: [opusTags(title)] }));
  }

  #emit(buf) { writeSync(this.fd, buf); this.bytes += buf.length; }

  /** Size the file would have if the queued packets were flushed now. */
  get projectedBytes() {
    return this.bytes + (this.pending.length ? 27 + this.pendingSegments + this.pending.reduce((n, p) => n + p.length, 0) : 0);
  }

  get durationMs() { return this.frames * 20; }

  write(packet) {
    const segments = Math.floor(packet.length / 255) + 1;
    if (this.pending.length && (this.pendingSegments + segments > 255 || this.pending.length >= this.packetsPerPage)) this.#flush(0);
    this.pending.push(packet);
    this.pendingSegments += segments;
    this.frames++;
  }

  #flush(headerType) {
    this.#emit(page({
      headerType, granule: PRE_SKIP + this.frames * SAMPLES_PER_FRAME_48K,
      serial: this.serial, seq: this.seq++, packets: this.pending,
    }));
    this.pending = [];
    this.pendingSegments = 0;
  }

  close() {
    // The last page carries the end-of-stream flag (an empty one if needed).
    this.#flush(0x04);
    closeSync(this.fd);
    return { bytes: this.bytes, durationMs: this.durationMs };
  }
}

/** All Opus audio packets in an .ogg file, in order (header packets skipped). */
export function readOpusPackets(path) {
  const buf = readFileSync(path);
  const packets = [];
  let partial = [];
  let off = 0;
  while (off + 27 <= buf.length) {
    if (buf.toString('ascii', off, off + 4) !== 'OggS') throw new Error(`Not an Ogg page at byte ${off} of ${path}`);
    const nSeg = buf[off + 26];
    const lacing = buf.subarray(off + 27, off + 27 + nSeg);
    let pos = off + 27 + nSeg;
    for (const len of lacing) {
      partial.push(buf.subarray(pos, pos + len));
      pos += len;
      if (len < 255) { packets.push(Buffer.concat(partial)); partial = []; }
    }
    off = pos;
  }
  // A chained file (several streams back to back) has a header pair per stream.
  return packets.filter((p) => !isHeader(p));
}

function isHeader(p) {
  const tag = p.subarray(0, 8).toString('ascii');
  return tag === 'OpusHead' || tag === 'OpusTags';
}

/** Join several recordings into one continuous file. */
export function concatRecordings(inPaths, outPath, opts = {}) {
  const w = new OggOpusWriter(outPath, opts);
  for (const p of inPaths) for (const pkt of readOpusPackets(p)) w.write(pkt);
  return w.close();
}

/**
 * Split a recording into files no larger than `maxBytes` each. Returns the
 * input path untouched when it already fits.
 */
export function splitRecording(inPath, maxBytes, outPathFor, opts = {}) {
  if (statSync(inPath).size <= maxBytes) return [inPath];
  const out = [];
  let w = null;
  const open = () => { const p = outPathFor(out.length + 1); out.push(p); w = new OggOpusWriter(p, opts); };
  open();
  for (const pkt of readOpusPackets(inPath)) {
    // Leave room for the closing page's header before starting a new part.
    if (w.frames > 0 && w.projectedBytes + pkt.length + 300 > maxBytes) { w.close(); open(); }
    w.write(pkt);
  }
  w.close();
  return out;
}
