import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useGuild } from '../GuildContext.jsx';
import { useAuth } from '../AuthContext.jsx';
import { Page, PageHead } from '../components/Page.jsx';
import { Icon, Empty } from '../components/ui.jsx';
import { fmtRelative } from '../lib/format.js';

export function useIsAdmin() {
  const { user, authEnabled } = useAuth();
  return !authEnabled || !!user?.isAdmin;
}

function CreateCampaign({ guildId, onCancel }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [channels, setChannels] = useState([]);
  const [channelId, setChannelId] = useState('');
  const [includePast, setIncludePast] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.voiceChannels(guildId).then((rows) => setChannels(Array.isArray(rows) ? rows : [])).catch(() => setChannels([]));
  }, [guildId]);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    const ch = channels.find((c) => c.id === channelId);
    try {
      const res = await api.createCampaign(guildId, {
        name: name.trim(), channelId: channelId || undefined, channelName: ch?.name, includePast,
      });
      navigate(`/campaigns/${res.campaign.id}`);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  const free = channels.filter((c) => c.campaignId == null);
  return (
    <form onSubmit={submit} className="card p-5 mb-6 animate-fade-in">
      <h2 className="text-sm font-bold text-ink mb-4">New campaign</h2>
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-xs font-semibold text-muted mb-1.5">Name</span>
          <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
            placeholder="e.g. Curse of Strahd" autoFocus />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-muted mb-1.5">Voice channel (recordings there join this campaign)</span>
          <select className="input w-full" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">None — I'll add sessions by hand</option>
            {free.map((c) => <option key={c.id} value={c.id}>🔊 {c.name}</option>)}
          </select>
        </label>
      </div>
      {channelId && (
        <label className="flex items-center gap-2 mt-3 text-sm text-ink-2">
          <input type="checkbox" className="pcheck" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
          Also add earlier recordings from this channel
        </label>
      )}
      {err && <p className="mt-3 text-sm text-error" role="alert">{err}</p>}
      <div className="flex gap-2 mt-4">
        <button type="submit" className="btn btn-primary !py-2" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create campaign'}</button>
        <button type="button" className="btn btn-ghost !py-2" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function CampaignCard({ c }) {
  return (
    <Link to={`/campaigns/${c.id}`} className="card p-5 no-underline hover:border-primary transition-colors block group">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-display text-lg font-extrabold text-ink leading-tight">{c.name}</h3>
        <Icon.ArrowUpRight width={16} height={16} className="text-muted group-hover:text-primary shrink-0 mt-1" />
      </div>
      <p className="text-sm text-muted mt-1.5">
        {c.session_count} session{c.session_count === 1 ? '' : 's'}
        {c.last_session_at && <> · last played {fmtRelative(c.last_session_at)}</>}
      </p>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {c.channels.map((ch) => <span key={ch.channel_id} className="chip">🔊 {ch.channel_name || ch.channel_id}</span>)}
        {!c.has_journal && c.session_count > 0 && <span className="chip">Journal not started</span>}
        {c.pending_count > 0 && c.has_journal && <span className="chip !text-primary !bg-primary-soft">{c.pending_count} not in journal</span>}
      </div>
    </Link>
  );
}

export default function Campaigns() {
  const { guildId } = useGuild();
  const isAdmin = useIsAdmin();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!guildId) return;
    let stale = false;
    setRows(null); setError(null);
    api.campaigns(guildId)
      .then((r) => { if (!stale) setRows(Array.isArray(r) ? r : []); })
      .catch((e) => { if (!stale) setError(e?.message || 'Failed to load'); });
    return () => { stale = true; };
  }, [guildId]);

  return (
    <Page max="980px">
      <PageHead
        title="Campaigns"
        subtitle="Memory across sessions: a living journal, campaign-wide questions, and recaps."
        actions={isAdmin && !creating && (
          <button className="btn btn-primary !py-2" onClick={() => setCreating(true)}>
            <Icon.Plus width={16} height={16} />New campaign
          </button>
        )}
      />
      {creating && guildId && <CreateCampaign guildId={guildId} onCancel={() => setCreating(false)} />}
      {error ? <Empty icon={Icon.Book} title="Couldn't load campaigns" body={error} />
        : !rows ? (
          <div className="grid sm:grid-cols-2 gap-4">{[0, 1].map((i) => <div key={i} className="h-36 skeleton rounded-[14px]" />)}</div>
        ) : rows.length === 0 && !creating ? (
          <Empty icon={Icon.Book} title="No campaigns yet"
            body="Create a campaign and link your game's voice channel. Every session recorded there feeds one shared journal you can ask questions about."
            action={isAdmin && <button className="btn btn-primary !py-2" onClick={() => setCreating(true)}><Icon.Plus width={16} height={16} />New campaign</button>} />
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">{rows.map((c) => <CampaignCard key={c.id} c={c} />)}</div>
        )}
    </Page>
  );
}
