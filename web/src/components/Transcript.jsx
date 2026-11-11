import { useState } from 'react';
import { Avatar, Icon } from './ui.jsx';
import { fmtClock, colorOf } from '../lib/format.js';

// Collapsible, filterable line-by-line transcript. Used on the meeting page and
// for each session in a campaign's log. start_ms is an absolute timestamp, so
// times are shown relative to the first line.
export default function Transcript({ utterances, className = 'mt-10 pt-8 border-t border-border', defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [q, setQ] = useState('');
  if (!utterances.length) return null;

  const origin = Math.min(...utterances.map((u) => u.start_ms ?? 0));
  const filtered = q.trim()
    ? utterances.filter((u) => u.text.toLowerCase().includes(q.toLowerCase()))
    : utterances;

  return (
    <section className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-sm font-bold text-ink">
          <Icon.Chevron width={16} height={16} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          Transcript
          <span className="chip">{utterances.length} lines</span>
        </button>
        {open && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in transcript…"
            className="input !w-52 !py-1.5 text-[13px]" />
        )}
      </div>
      {open && (
        <div className="space-y-4">
          {filtered.length === 0 && <p className="text-sm text-muted">No lines match "{q}".</p>}
          {filtered.map((u, i) => (
            <div key={u.id ?? i} className="flex items-start gap-3">
              <Avatar name={u.display_name} size={28} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold" style={{ color: colorOf(u.display_name) }}>{u.display_name}</span>
                  <span className="text-[11px] text-faint tabular-nums">{fmtClock((u.start_ms ?? 0) - origin)}</span>
                </div>
                <p className="text-[14px] text-ink-2 leading-relaxed mt-0.5">{u.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
