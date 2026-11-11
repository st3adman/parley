// src/campaign/export.js
// One Markdown document for a whole campaign: the journal, then every session
// oldest-first with its notes and full transcript.
import { formatMs } from '../pipeline/summarize.js';
import { groupActionItems } from '../delivery/discord-notes.js';

/** Transcript lines with times relative to the session's first line (start_ms is absolute). */
export function transcriptMarkdown(utterances) {
  if (!utterances.length) return [];
  const origin = Math.min(...utterances.map((u) => u.start_ms ?? 0));
  return utterances.map((u) => `**[${formatMs(Math.max(0, (u.start_ms ?? 0) - origin))}] ${u.display_name}:** ${u.text}`);
}

// Push the journal's headings one level down so they nest under "Campaign journal".
function demoteHeadings(md) {
  return md.replace(/^(#{1,5}) /gm, '#$1 ');
}

function slug(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'campaign';
}

function notesMarkdown(notes) {
  const lines = [];
  if (notes.tldr) lines.push(notes.tldr, '');
  for (const t of notes.topics || []) {
    lines.push(`**${t.title}**`);
    for (const p of t.points || []) lines.push(`- ${p}`);
    lines.push('');
  }
  const list = (title, items) => {
    if (!items?.length) return;
    lines.push(`**${title}**`, ...items.map((x) => `- ${x}`), '');
  };
  list('Decisions', notes.decisions);
  list('Open questions', notes.openQuestions);
  const grouped = groupActionItems(notes.actionItems || []);
  if (grouped.size) {
    lines.push('**Action items**');
    for (const [who, tasks] of grouped) for (const task of tasks) lines.push(`- [ ] ${who}: ${task}`);
    lines.push('');
  }
  return lines;
}

export function campaignMarkdown(db, campaignId, { now = new Date() } = {}) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return null;
  const sessions = db.listCampaignSessions(campaignId);
  const channels = db.listCampaignChannels(campaignId).map((c) => `#${c.channel_name || c.channel_id}`);
  const today = now.toISOString().slice(0, 10);

  const lines = [`# ${campaign.name}`, ''];
  const meta = [`Exported ${today}`, `${sessions.length} session${sessions.length === 1 ? '' : 's'}`];
  if (channels.length) meta.push(`recorded in ${channels.join(', ')}`);
  lines.push(`_${meta.join(' · ')}_`, '');

  lines.push('## Campaign journal', '');
  lines.push(campaign.journal?.trim() ? demoteHeadings(campaign.journal.trim()) : '_Empty._', '');

  lines.push('## Sessions', '');
  if (!sessions.length) lines.push('_No sessions yet._', '');
  for (const s of sessions) {
    lines.push(`### Session ${s.number} — ${(s.started_at || '').slice(0, 10)}`, '');
    const players = db.listAttendees(s.id).map((a) => a.display_name);
    if (players.length) lines.push(`**Players:** ${players.join(', ')}`, '');
    if (s.status !== 'done') lines.push(`_Status: ${s.status.replace(/_/g, ' ')}_`, '');
    if (s.notes) lines.push(...notesMarkdown(s.notes));
    const transcript = transcriptMarkdown(db.listUtterances(s.id));
    lines.push('#### Transcript', '');
    lines.push(...(transcript.length ? transcript.flatMap((l) => [l, '']) : ['_No transcript._', '']));
  }

  return { filename: `${slug(campaign.name)}-${today}.md`, markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n' };
}
