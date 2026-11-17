// src/recording/index.js
// Session recordings: one mixed Ogg Opus file per meeting, kept under
// DATA_DIR/recordings/ when the server has "Keep audio" on, downloadable from
// the dashboard and attached to the notes thread in Discord.
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { encodeRecording } from './mix.js';
import { concatRecordings, splitRecording } from './ogg.js';

export function recordingsDir(dataDir) { return join(dataDir, 'recordings'); }
export function recordingPath(dataDir, meetingId) { return join(recordingsDir(dataDir), `${meetingId}.ogg`); }

export function recordingFilename(meeting) {
  const slug = String(meeting.channel_name || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
  return `${slug}-${(meeting.started_at || '').slice(0, 10) || meeting.id}.ogg`;
}

/** Mix a meeting's PCM tracks into its recording. Returns { bytes, durationMs } or null. */
export async function saveRecording(db, meetingId, tracks, { dataDir, encoder } = {}) {
  const meeting = db.getMeeting(meetingId);
  mkdirSync(recordingsDir(dataDir), { recursive: true });
  const final = recordingPath(dataDir, meetingId);
  const tmp = `${final}.tmp`;
  try {
    const title = meeting ? `${meeting.channel_name} — ${(meeting.started_at || '').slice(0, 10)}` : null;
    const result = await encodeRecording(tracks, tmp, { title, ...(encoder ? { encoder } : {}) });
    if (!result) { rmSync(tmp, { force: true }); return null; }
    renameSync(tmp, final);
    db.setMeetingRecording(meetingId, result);
    return result;
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function deleteRecording(db, meetingId, { dataDir }) {
  rmSync(recordingPath(dataDir, meetingId), { force: true });
  db.setMeetingRecording(meetingId, null);
}

/**
 * After a merge: join the recordings of the merged meetings (in start order)
 * onto the target's. Missing recordings are skipped.
 */
export function mergeRecordings(db, targetId, orderedIds, { dataDir }) {
  const present = orderedIds.map((id) => recordingPath(dataDir, id)).filter((p) => existsSync(p));
  const final = recordingPath(dataDir, targetId);
  if (present.length > 1 || (present.length === 1 && present[0] !== final)) {
    const tmp = `${final}.tmp`;
    const result = concatRecordings(present, tmp);
    renameSync(tmp, final);
    db.setMeetingRecording(targetId, result);
  }
  for (const id of orderedIds) if (id !== targetId) rmSync(recordingPath(dataDir, id), { force: true });
}

// Discord's per-file upload cap for bots by server boost level (2025+): 10 MB
// unboosted and at level 1, 50 MB at level 2, 100 MB at level 3.
const MB = 1024 * 1024;
export function uploadLimitBytes(premiumTier = 0) {
  if (premiumTier >= 3) return 100 * MB;
  if (premiumTier === 2) return 50 * MB;
  return 10 * MB;
}

export function formatDuration(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/**
 * Post the recording to `target` (the notes thread/channel), split into parts
 * that fit the server's upload limit, one part per message.
 */
export async function postRecording(target, meeting, { dataDir, premiumTier = 0 } = {}) {
  const src = recordingPath(dataDir, meeting.id);
  if (!existsSync(src)) return { posted: 0 };
  // A little headroom under the cap for the multipart envelope.
  const limit = uploadLimitBytes(premiumTier) - 256 * 1024;
  const base = recordingFilename(meeting).replace(/\.ogg$/, '');
  const tmp = mkdtempSync(join(tmpdir(), 'candlekeep-rec-'));
  try {
    const parts = splitRecording(src, limit, (n) => join(tmp, `${base}-part${n}.ogg`));
    const total = meeting.recording_ms ? ` (${formatDuration(meeting.recording_ms)})` : '';
    for (const [i, path] of parts.entries()) {
      const name = parts.length === 1 ? `${base}.ogg` : `${base}-part${i + 1}.ogg`;
      const content = parts.length === 1
        ? `🎙️ Session recording${total}`
        : `🎙️ Session recording${total} — part ${i + 1} of ${parts.length}`;
      await target.send({ content, files: [{ attachment: path, name }] });
    }
    return { posted: parts.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
