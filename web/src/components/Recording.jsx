import { forwardRef, useRef } from 'react';
import { api } from '../api.js';
import { Icon } from './ui.jsx';
import { fmtClock } from '../lib/format.js';

function fmtSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Player + download for a session's kept recording. The ref is the <audio>
// element, so the transcript can seek it.
const Recording = forwardRef(function Recording({ meeting, className = 'mt-8' }, ref) {
  if (!meeting?.recording_bytes) return null;
  return (
    <section className={`card p-4 ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-bold text-ink inline-flex items-center gap-2">
          <Icon.Mic width={16} height={16} /> Recording
          <span className="text-xs font-normal text-muted">
            {meeting.recording_ms ? fmtClock(meeting.recording_ms) : ''}{meeting.recording_ms ? ' · ' : ''}{fmtSize(meeting.recording_bytes)}
          </span>
        </h2>
        <a href={api.recordingUrl(meeting.id, true)} className="btn btn-ghost !py-1.5 text-[13px] no-underline inline-flex items-center gap-1.5">
          <Icon.Download width={15} height={15} /> Download .ogg
        </a>
      </div>
      <audio ref={ref} controls preload="metadata" src={api.recordingUrl(meeting.id)} className="w-full" />
    </section>
  );
});

export default Recording;

/**
 * A ref for <Recording> plus a seek(startMs) for <Transcript onSeek>. seek is
 * null when the recording's start isn't known (none kept, or joined by a merge).
 */
export function useRecordingSeek(meeting) {
  const player = useRef(null);
  const seek = meeting?.recording_bytes && meeting.recording_start_ms != null
    ? (startMs) => {
        const a = player.current;
        if (!a) return;
        a.currentTime = Math.max(0, (startMs - meeting.recording_start_ms) / 1000);
        a.play().catch(() => {});
        a.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    : null;
  return { player, seek };
}
