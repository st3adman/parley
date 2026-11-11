import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Page, PageHead, SectionHead } from '../components/Page.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import Markdown from '../components/Markdown.jsx';
import Transcript from '../components/Transcript.jsx';
import { fmtDateShort, fmtRelative } from '../lib/format.js';
import { useIsAdmin } from './Campaigns.jsx';

const ASK_SUGGESTIONS = [
  'Who are the important NPCs so far?',
  'Which quests are still open?',
  'What loot is the party carrying?',
  'What do we know about the main villain?',
];

/* ── Ask the whole campaign ───────────────────────────────────────────── */
function AskCampaign({ campaignId }) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);

  async function ask(qStr) {
    const q = (qStr ?? question).trim();
    if (!q || loading) return;
    setQuestion(q); setLoading(true); setAnswer(null); setError(null);
    try { setAnswer((await api.askCampaign(campaignId, q)).answer); }
    catch (err) { setError(err?.message || 'Request failed'); }
    finally { setLoading(false); }
  }

  return (
    <section className="card p-5" style={{ background: 'linear-gradient(180deg, var(--primary-soft), transparent)' }}>
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink mb-3">
        <Icon.Sparkle width={16} height={16} className="text-primary" /> Ask the campaign
      </h2>
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex gap-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} disabled={loading} maxLength={500}
          placeholder="When did we first meet the lich? What did the innkeeper tell us?" className="input flex-1 min-w-0" />
        <button type="submit" disabled={!question.trim() || loading} className="btn btn-primary">{loading ? 'Thinking…' : 'Ask'}</button>
      </form>
      {!answer && !loading && (
        <div className="flex flex-wrap gap-2 mt-3">
          {ASK_SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="chip hover:!bg-surface-2 transition-colors">{s}</button>)}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-error" role="alert">{error}</p>}
      {answer && (
        <div className="mt-4 text-[14.5px] text-ink leading-relaxed bg-surface-2 rounded-sm p-4 border border-border animate-fade-in">
          <Markdown text={answer} />
        </div>
      )}
    </section>
  );
}

/* ── "Previously on…" recap ───────────────────────────────────────────── */
function Recap({ campaignId, sessionCount }) {
  const [count, setCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [recap, setRecap] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  async function run() {
    setLoading(true); setError(null); setCopied(false);
    try { setRecap((await api.recapCampaign(campaignId, count)).recap); }
    catch (err) { setError(err?.message || 'Request failed'); }
    finally { setLoading(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(recap); setCopied(true); } catch { /* clipboard blocked */ }
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">🎲 Previously on…</h2>
        <div className="flex items-center gap-2">
          <select className="input !py-1.5 !w-auto text-sm" value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Sessions to cover">
            {[1, 2, 3, 4, 5].filter((n) => n === 1 || n <= sessionCount).map((n) => (
              <option key={n} value={n}>{n === 1 ? 'Last session' : `Last ${n} sessions`}</option>
            ))}
          </select>
          <button className="btn btn-primary !py-1.5" onClick={run} disabled={loading || sessionCount === 0}>
            {loading ? 'Writing…' : recap ? 'Rewrite' : 'Write recap'}
          </button>
        </div>
      </div>
      {sessionCount === 0 && <p className="text-sm text-muted mt-2">A recap needs at least one summarized session.</p>}
      {error && <p className="mt-3 text-sm text-error" role="alert">{error}</p>}
      {recap && (
        <div className="mt-4 animate-fade-in">
          <div className="text-[15px] text-ink leading-relaxed bg-surface-2 rounded-sm p-4 border border-border italic whitespace-pre-line">{recap}</div>
          <button className="btn btn-ghost !py-1.5 mt-2" onClick={copy}><Icon.Copy width={14} height={14} />{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
    </section>
  );
}

/* ── Journal ──────────────────────────────────────────────────────────── */
function Journal({ campaign, pending, sessionCount, isAdmin, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const updating = campaign.journal_status === 'updating';

  async function act(fn) {
    setBusy(true); setErr(null);
    try { await fn(); await onChange(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  const save = () => act(async () => { await api.updateCampaign(campaign.id, { journal: draft }); setEditing(false); });
  const update = () => act(() => api.updateJournal(campaign.id));
  const rebuild = () => {
    if (!window.confirm(`Rebuild the journal from all ${sessionCount} sessions? This replaces the current journal, including any hand edits, and makes one AI call per session.`)) return;
    act(() => api.updateJournal(campaign.id, true));
  };

  return (
    <section>
      <SectionHead title="Campaign journal" action={isAdmin && !editing && (
        <div className="flex gap-1.5">
          <button className="btn btn-ghost !py-1.5" disabled={busy || updating} onClick={() => { setDraft(campaign.journal || ''); setEditing(true); }}>
            <Icon.Pencil width={14} height={14} />Edit
          </button>
          <button className="btn btn-ghost !py-1.5" disabled={busy || updating || sessionCount === 0} onClick={rebuild} title="Start over from every session">
            <Icon.Refresh width={14} height={14} />Rebuild
          </button>
        </div>
      )} />
      <div className="card p-5">
        {updating && (
          <p className="flex items-center gap-2 text-sm text-primary mb-3">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            Updating the journal from session transcripts… this can take a minute per session.
          </p>
        )}
        {campaign.journal_status === 'error' && campaign.journal_error && (
          <p className="text-sm text-error mb-3" role="alert">Last update failed: {campaign.journal_error}</p>
        )}
        {pending > 0 && !updating && (
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4 p-3 rounded-sm bg-primary-soft">
            <span className="text-sm text-ink">{pending} session{pending === 1 ? ' isn’t' : 's aren’t'} in the journal yet.</span>
            {isAdmin && <button className="btn btn-primary !py-1.5" disabled={busy} onClick={update}>Update journal</button>}
          </div>
        )}
        {err && <p className="text-sm text-error mb-3" role="alert">{err}</p>}
        {editing ? (
          <>
            <textarea className="input w-full min-h-[480px] font-mono text-xs resize-y" aria-label="Campaign journal"
              value={draft} onChange={(e) => setDraft(e.target.value)} />
            <p className="text-xs text-muted mt-2">Markdown. The next session's update starts from your edited version, so corrections stick.</p>
            <div className="flex gap-2 mt-3">
              <button className="btn btn-primary !py-1.5" disabled={busy} onClick={save}>Save journal</button>
              <button className="btn btn-ghost !py-1.5" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : campaign.journal ? (
          <>
            <div className="text-[14px] text-ink leading-relaxed journal"><Markdown text={campaign.journal} /></div>
            {campaign.journal_updated_at && <p className="text-xs text-faint mt-4">Updated {fmtRelative(campaign.journal_updated_at)}</p>}
          </>
        ) : (
          <p className="text-sm text-muted">
            Empty so far. It fills in automatically after each session recorded in this campaign — party, NPCs, places,
            quests, loot and lore{sessionCount > 0 ? ', or use Update journal to build it from the sessions already here' : ''}.
          </p>
        )}
      </div>
    </section>
  );
}

/* ── Sessions ─────────────────────────────────────────────────────────── */
function Sessions({ sessions, unassigned, campaignId, isAdmin, onChange }) {
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState(null);
  async function move(meetingId, target) {
    setErr(null);
    try { await api.setMeetingCampaign(meetingId, target); await onChange(); }
    catch (e) { setErr(e.message); }
  }
  return (
    <section>
      <SectionHead title={`Sessions (${sessions.length})`} />
      <div className="card divide-y divide-border">
        {sessions.length === 0 && <p className="p-4 text-sm text-muted">No sessions yet.</p>}
        {[...sessions].reverse().map((s) => (
          <div key={s.id} className="flex items-start gap-3 p-3.5 group">
            <span className="shrink-0 w-9 h-9 grid place-items-center rounded-sm bg-surface-2 text-xs font-bold text-ink">{s.number}</span>
            <Link to={`/meetings/${s.id}`} className="min-w-0 flex-1 no-underline">
              <p className="text-sm font-semibold text-ink">
                {fmtDateShort(s.started_at)}
                {!s.journaled_at && s.status === 'done' && <span className="ml-2 text-[11px] font-medium text-primary">not in journal</span>}
                {s.status !== 'done' && <span className="ml-2 text-[11px] font-medium text-muted">{s.status.replace('_', ' ')}</span>}
              </p>
              {s.tldr && <p className="text-[13px] text-muted line-clamp-2 mt-0.5">{s.tldr}</p>}
            </Link>
            {isAdmin && (
              <button className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted hover:text-error transition"
                title="Remove from campaign" aria-label={`Remove session ${s.number} from campaign`} onClick={() => move(s.id, null)}>
                <Icon.X width={16} height={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      {isAdmin && unassigned.length > 0 && (
        <div className="flex gap-2 mt-3">
          <select className="input flex-1 min-w-0 !py-1.5 text-sm" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a recording">
            <option value="">Add an existing recording…</option>
            {unassigned.map((m) => <option key={m.id} value={m.id}>{fmtDateShort(m.started_at)} · {m.channel_name}{m.tldr ? ` — ${m.tldr.slice(0, 60)}` : ''}</option>)}
          </select>
          <button className="btn btn-ghost !py-1.5" disabled={!adding} onClick={() => { move(Number(adding), campaignId); setAdding(''); }}>Add</button>
        </div>
      )}
      {err && <p className="text-sm text-error mt-2" role="alert">{err}</p>}
    </section>
  );
}

/* ── Settings: name, linked channels, delete ──────────────────────────── */
function Settings({ campaign, channels, onChange }) {
  const navigate = useNavigate();
  const [name, setName] = useState(campaign.name);
  const [voice, setVoice] = useState([]);
  const [channelId, setChannelId] = useState('');
  const [includePast, setIncludePast] = useState(true);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { setName(campaign.name); }, [campaign.name]);
  useEffect(() => {
    api.voiceChannels(campaign.guild_id).then((r) => setVoice(Array.isArray(r) ? r : [])).catch(() => setVoice([]));
  }, [campaign.guild_id, channels.length]);

  async function act(fn) {
    setErr(null); setMsg(null);
    try { await fn(); await onChange(); } catch (e) { setErr(e.message); }
  }
  const linkable = voice.filter((v) => v.campaignId !== campaign.id);

  return (
    <section>
      <SectionHead title="Settings" />
      <div className="card p-4 space-y-5">
        <div>
          <span className="block text-xs font-semibold text-muted mb-1.5">Name</span>
          <div className="flex gap-2">
            <input className="input flex-1 min-w-0" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-ghost !py-1.5" disabled={!name.trim() || name.trim() === campaign.name}
              onClick={() => act(() => api.updateCampaign(campaign.id, { name }))}>Rename</button>
          </div>
        </div>
        <div>
          <span className="block text-xs font-semibold text-muted mb-1.5">Linked voice channels</span>
          <p className="text-xs text-muted mb-2">New recordings in these channels join this campaign automatically.</p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {channels.length === 0 && <span className="text-sm text-muted">None</span>}
            {channels.map((ch) => (
              <span key={ch.channel_id} className="chip">
                🔊 {ch.channel_name || ch.channel_id}
                <button className="ml-1 text-muted hover:text-error" aria-label={`Unlink ${ch.channel_name}`}
                  onClick={() => act(() => api.unlinkChannel(campaign.id, ch.channel_id))}><Icon.X width={12} height={12} /></button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <select className="input flex-1 min-w-0 !py-1.5 text-sm" value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Voice channel to link">
              <option value="">Link a voice channel…</option>
              {linkable.map((v) => <option key={v.id} value={v.id}>🔊 {v.name}{v.campaignId ? ' (moves from another campaign)' : ''}</option>)}
            </select>
            <button className="btn btn-ghost !py-1.5" disabled={!channelId} onClick={() => act(async () => {
              const ch = voice.find((v) => v.id === channelId);
              const r = await api.linkChannel(campaign.id, { channelId, channelName: ch?.name, includePast });
              setChannelId('');
              if (r.attached) setMsg(`Added ${r.attached} earlier recording${r.attached === 1 ? '' : 's'}.`);
            })}>Link</button>
          </div>
          {channelId && (
            <label className="flex items-center gap-2 mt-2 text-sm text-ink-2">
              <input type="checkbox" className="pcheck" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
              Also add earlier recordings from this channel
            </label>
          )}
          {msg && <p className="text-sm text-primary mt-2">{msg}</p>}
        </div>
        {err && <p className="text-sm text-error" role="alert">{err}</p>}
        <div className="pt-4 border-t border-border">
          <button className="btn btn-ghost !py-1.5 !text-error" onClick={() => {
            if (!window.confirm(`Delete "${campaign.name}"? Its journal is deleted; the recordings stay in Sessions.`)) return;
            act(async () => { await api.deleteCampaign(campaign.id); navigate('/campaigns'); });
          }}><Icon.Trash width={14} height={14} />Delete campaign</button>
        </div>
      </div>
    </section>
  );
}

/* ── Full session log (notes + line-by-line transcript per session) ──── */
function SessionNotes({ notes }) {
  const block = (title, items, render) => items?.length > 0 && (
    <div className="mt-4">
      <h4 className="text-xs font-bold uppercase tracking-wider text-faint mb-1.5">{title}</h4>
      <ul className="space-y-1">{items.map((x, i) => <li key={i} className="text-[14px] text-ink-2 leading-relaxed flex gap-2"><span className="text-faint mt-2 h-1 w-1 rounded-full bg-current shrink-0" /><span>{render ? render(x) : x}</span></li>)}</ul>
    </div>
  );
  return (
    <>
      {notes.tldr && <p className="text-[15px] text-ink leading-relaxed font-medium">{notes.tldr}</p>}
      {notes.topics?.map((t, i) => (
        <div key={i} className="mt-4 pl-4 border-l-2" style={{ borderColor: 'var(--border-strong)' }}>
          <h4 className="text-[14.5px] font-semibold text-ink">{t.title}</h4>
          {t.points?.length > 0 && (
            <ul className="mt-1.5 space-y-1">{t.points.map((p, j) => <li key={j} className="text-[14px] text-ink-2 leading-relaxed">{p}</li>)}</ul>
          )}
        </div>
      ))}
      {block('Decisions', notes.decisions)}
      {block('Open questions', notes.openQuestions)}
      {block('Action items', notes.actionItems, (a) => <>{a.assignee && <strong className="text-ink">{a.assignee}: </strong>}{a.task}</>)}
    </>
  );
}

function SessionEntry({ session, open, onToggle }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!open || detail) return;
    api.meeting(session.id).then(setDetail).catch((e) => setErr(e?.message || 'Failed to load'));
  }, [open, detail, session.id]);

  return (
    <div className="card overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-start gap-3 p-4 text-left hover:bg-surface-2 transition-colors">
        <Icon.Chevron width={16} height={16} className={`mt-0.5 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">Session {session.number} <span className="font-normal text-muted">· {fmtDateShort(session.started_at)}</span></p>
          {!open && session.tldr && <p className="text-[13px] text-muted line-clamp-1 mt-0.5">{session.tldr}</p>}
        </div>
        <Link to={`/meetings/${session.id}`} onClick={(e) => e.stopPropagation()} className="text-xs text-muted hover:text-primary no-underline inline-flex items-center gap-1 shrink-0">
          Open <Icon.ArrowUpRight width={12} height={12} />
        </Link>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-border animate-fade-in">
          {err ? <p className="text-sm text-error mt-3">{err}</p>
            : !detail ? <div className="h-24 skeleton rounded-md mt-3" />
            : (
              <>
                <div className="mt-3">
                  {detail.summary?.notes ? <SessionNotes notes={detail.summary.notes} /> : <p className="text-sm text-muted">No notes for this session.</p>}
                </div>
                {detail.utterances?.length > 0
                  ? <Transcript utterances={detail.utterances} className="mt-6 pt-5 border-t border-border" />
                  : <p className="text-sm text-muted mt-4">No transcript.</p>}
              </>
            )}
        </div>
      )}
    </div>
  );
}

function SessionLog({ sessions }) {
  const [openIds, setOpenIds] = useState(() => new Set());
  if (!sessions.length) return null;
  const allOpen = openIds.size === sessions.length;
  const toggle = (id) => setOpenIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <section className="mt-10">
      <SectionHead title="Session log" action={
        <button className="btn btn-ghost !py-1.5" onClick={() => setOpenIds(allOpen ? new Set() : new Set(sessions.map((s) => s.id)))}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      } />
      <p className="text-xs text-muted -mt-1 mb-3">Every session's notes and full transcript, oldest first.</p>
      <div className="space-y-3">
        {sessions.map((s) => <SessionEntry key={s.id} session={s} open={openIds.has(s.id)} onToggle={() => toggle(s.id)} />)}
      </div>
    </section>
  );
}

export default function Campaign() {
  const { id } = useParams();
  const isAdmin = useIsAdmin();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.campaign(id).then(setData).catch((e) => setError(e?.message || 'Failed to load')), [id]);
  useEffect(() => { setData(null); setError(null); load(); }, [load]);

  // Poll while a background journal update runs.
  const updating = data?.campaign?.journal_status === 'updating';
  useEffect(() => {
    if (!updating) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [updating, load]);

  if (error) return <Page><Empty icon={Icon.Book} title="Couldn't load campaign" body={error} /></Page>;
  if (!data) return <Page><div className="h-10 w-64 skeleton rounded-md mb-6" /><div className="h-40 skeleton rounded-[14px]" /></Page>;

  const { campaign, channels, sessions, unassigned } = data;
  const summarized = sessions.filter((s) => s.has_summary).length;
  const pending = sessions.filter((s) => s.status === 'done' && !s.journaled_at).length;

  return (
    <Page max="1180px">
      <Link to="/campaigns" className="text-xs text-muted hover:text-primary no-underline inline-flex items-center gap-1 mb-2">
        <Icon.Chevron width={12} height={12} className="rotate-180" />Campaigns
      </Link>
      <PageHead title={campaign.name}
        subtitle={`${sessions.length} session${sessions.length === 1 ? '' : 's'}${channels.length ? ` · recorded in ${channels.map((c) => c.channel_name || c.channel_id).join(', ')}` : ''}`}
        actions={(
          <a href={api.exportCampaignUrl(campaign.id)} download className="btn btn-ghost !py-2 no-underline"
            title="Journal plus every session's notes and full transcript">
            <Icon.Download width={15} height={15} />Download .md
          </a>
        )} />

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <AskCampaign campaignId={campaign.id} />
          <Recap campaignId={campaign.id} sessionCount={summarized} />
          <Journal campaign={campaign} pending={pending} sessionCount={sessions.length} isAdmin={isAdmin} onChange={load} />
        </div>
        <div className="space-y-6 min-w-0">
          <Sessions sessions={sessions} unassigned={unassigned} campaignId={campaign.id} isAdmin={isAdmin} onChange={load} />
          {isAdmin && <Settings campaign={campaign} channels={channels} onChange={load} />}
        </div>
      </div>

      <SessionLog sessions={sessions} />
    </Page>
  );
}
