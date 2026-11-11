// src/campaign/ask.js
// Campaign-wide Q&A and "Previously on…" recaps. Whole-campaign transcripts are
// far too big to send (a 4-hour session is ~50k tokens), so the model gets:
//   1. the campaign journal (world state),
//   2. every session's notes, numbered (oldest trimmed to the TL;DR when the
//      campaign is long),
//   3. transcript passages matching the question's keywords (full-text search),
//      with a little surrounding conversation for each hit.
import { getSummarizer } from '../adapters/summarizer/index.js';
import { getGuildConfig } from '../store/config.js';
import { formatMs } from '../pipeline/summarize.js';

const NOTES_BUDGET = 60_000; // characters of session notes
const EXCERPT_BUDGET = 30_000; // characters of transcript excerpts
const EXCERPT_HITS = 15;
const WINDOW_MS = 30_000; // conversation kept on each side of a hit

const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been
before being below between both but by can could did do does doing down during each few for from
further had has have having he her here hers herself him himself his how i if in into is it its itself
just me more most my myself no nor not now of off on once only or other our ours ourselves out over own
same she should so some such than that the their theirs them themselves then there these they this
those through to too under until up very was we were what when where which while who whom why will
with would you your yours yourself yourselves ever never also still yet again ago last first next
tell remind know remember happened happen happens said say says thing things get got go went going
party session sessions campaign game time did does anyone someone something name named called`.split(/\s+/));

/** Search terms from a natural-language question (lowercased, deduped, stopwords dropped). */
export function extractTerms(question, max = 8) {
  const words = String(question).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  const out = [];
  for (const w of words) {
    const t = w.replace(/['’]s$/, '').replace(/['’-]+$/, '');
    if (t.length < 3 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** FTS5 query matching any term, with prefix matching so "goblin" finds "goblins". */
export function ftsQuery(terms) {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

function notesBlock(session, full) {
  const head = `### Session ${session.number} — ${(session.started_at || '').slice(0, 10)}`;
  const n = session.notes;
  if (!n) return `${head}\n(no notes)`;
  const lines = [head, n.tldr || ''];
  if (full) {
    for (const t of n.topics || []) {
      lines.push(`- ${t.title}${(t.points || []).length ? `: ${t.points.join('; ')}` : ''}`);
    }
    if ((n.decisions || []).length) lines.push(`- Decisions: ${n.decisions.join('; ')}`);
    if ((n.openQuestions || []).length) lines.push(`- Open questions: ${n.openQuestions.join('; ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

/** Session notes oldest→newest; when over budget, older sessions shrink to their TL;DR. */
export function sessionNotesBlock(sessions, budget = NOTES_BUDGET) {
  const full = sessions.map((s) => notesBlock(s, true));
  const short = sessions.map((s) => notesBlock(s, false));
  const blocks = [...full];
  let total = blocks.reduce((n, b) => n + b.length, 0);
  for (let i = 0; i < blocks.length - 1 && total > budget; i++) {
    total -= blocks[i].length - short[i].length;
    blocks[i] = short[i];
  }
  return blocks.join('\n\n');
}

/** Transcript passages around the best full-text matches for the question. */
export function transcriptExcerpts(db, campaignId, question, sessions, budget = EXCERPT_BUDGET) {
  const terms = extractTerms(question);
  if (!terms.length) return '';
  let hits;
  try { hits = db.searchCampaignUtterances(campaignId, ftsQuery(terms), EXCERPT_HITS); }
  catch { return ''; } // malformed FTS input should never sink the answer
  const numberOf = new Map(sessions.map((s) => [s.id, s]));
  // Merge overlapping windows per session.
  const windows = new Map();
  for (const h of hits) {
    const list = windows.get(h.meeting_id) || [];
    const from = h.start_ms - WINDOW_MS, to = h.start_ms + WINDOW_MS;
    const overlap = list.find((w) => from <= w.to && to >= w.from);
    if (overlap) { overlap.from = Math.min(overlap.from, from); overlap.to = Math.max(overlap.to, to); }
    else list.push({ from, to });
    windows.set(h.meeting_id, list);
  }
  const parts = [];
  let used = 0;
  const ordered = [...windows.entries()].sort((a, b) => (numberOf.get(a[0])?.number ?? 0) - (numberOf.get(b[0])?.number ?? 0));
  for (const [meetingId, list] of ordered) {
    const session = numberOf.get(meetingId);
    // start_ms is absolute; show times relative to the session's first line.
    const origin = db.firstUtteranceMs(meetingId) ?? 0;
    for (const w of list.sort((a, b) => a.from - b.from)) {
      const rows = db.utterancesBetween(meetingId, w.from, w.to);
      if (!rows.length) continue;
      const text = `[Session ${session?.number ?? '?'}, around ${formatMs(Math.max(0, rows[0].start_ms - origin))}]\n`
        + rows.map((u) => `${u.display_name}: ${u.text}`).join('\n');
      if (used + text.length > budget) return parts.join('\n\n');
      parts.push(text);
      used += text.length;
    }
  }
  return parts.join('\n\n');
}

export function buildCampaignAskPrompt({ campaignName, question, journal, notes, excerpts }) {
  return `You are the lore-keeper for a tabletop role-playing campaign called "${campaignName}". Answer the question using ONLY the campaign material below. Speakers in the transcript excerpts are players' Discord names; the journal's Party section maps players to their characters.

- Say which session(s) the answer comes from, e.g. "(Session 4)".
- If the material doesn't contain the answer, say so plainly. Don't invent details.
- Be concise; use a short list when listing several things.

<campaign_journal>
${journal?.trim() || '(empty)'}
</campaign_journal>

<session_notes>
${notes || '(no sessions yet)'}
</session_notes>

<transcript_excerpts>
${excerpts || '(no matching passages)'}
</transcript_excerpts>

Question: ${question}`;
}

export function buildRecapPrompt({ campaignName, journal, notes, lastTranscriptTail, sessionCount }) {
  return `Write a "Previously on…" recap for the tabletop role-playing campaign "${campaignName}", to be read aloud by the Game Master at the start of the next session.

- Cover the last ${sessionCount === 1 ? 'session' : `${sessionCount} sessions`}, weighting the most recent most heavily, and end on where the party stands now: the cliffhanger, the open choice, the immediate threat.
- 150–250 words. Dramatic narrator voice, past tense, addressing the party ("Our heroes…" or "you").
- Use character names, not players' Discord names (the journal's Party section maps them). Leave out out-of-character table talk.
- Output only the recap text.

<campaign_journal>
${journal?.trim() || '(empty)'}
</campaign_journal>

<recent_sessions>
${notes}
</recent_sessions>
${lastTranscriptTail ? `
<end_of_last_session>
${lastTranscriptTail}
</end_of_last_session>` : ''}`;
}

function setup(db, campaignId, { cfg, summarizer, env }) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const c = cfg || getGuildConfig(db, campaign.guild_id);
  const s = summarizer || getSummarizer(c, env);
  if (typeof s.ask !== 'function') throw new Error(`Provider ${c.summarizerProvider} does not support Q&A`);
  const sessions = db.listCampaignSessions(campaignId);
  return { campaign, summarizer: s, sessions };
}

export async function askCampaign(db, campaignId, question, opts = {}) {
  const { campaign, summarizer, sessions } = setup(db, campaignId, opts);
  const prompt = buildCampaignAskPrompt({
    campaignName: campaign.name,
    question,
    journal: campaign.journal,
    notes: sessionNotesBlock(sessions),
    excerpts: transcriptExcerpts(db, campaignId, question, sessions),
  });
  return summarizer.ask(prompt);
}

export async function recapCampaign(db, campaignId, { sessions: count = 1, ...opts } = {}) {
  const { campaign, summarizer, sessions } = setup(db, campaignId, opts);
  const done = sessions.filter((s) => s.notes);
  if (!done.length) throw new Error('This campaign has no summarized sessions yet.');
  const n = Math.max(1, Math.min(5, Number(count) || 1));
  const recent = done.slice(-n);
  const last = recent[recent.length - 1];
  const tail = db.listUtterances(last.id).slice(-60).map((u) => `${u.display_name}: ${u.text}`).join('\n').slice(-6000);
  return summarizer.ask(buildRecapPrompt({
    campaignName: campaign.name,
    journal: campaign.journal,
    notes: recent.map((s) => notesBlock(s, true)).join('\n\n'),
    lastTranscriptTail: tail,
    sessionCount: recent.length,
  }));
}

/**
 * Pick the campaign a Discord command refers to: an explicit id/name, else the
 * campaign linked to the user's current voice channel, else the guild's most
 * recently active campaign.
 */
export function resolveCampaign(db, guildId, { campaign, voiceChannelId } = {}) {
  const all = db.listCampaigns(guildId);
  if (campaign) {
    const byId = all.find((c) => String(c.id) === String(campaign));
    if (byId) return byId;
    const needle = String(campaign).toLowerCase();
    return all.find((c) => c.name.toLowerCase() === needle) || all.find((c) => c.name.toLowerCase().includes(needle)) || null;
  }
  if (voiceChannelId) {
    const linked = db.campaignForChannel(voiceChannelId);
    if (linked && linked.guild_id === guildId) return linked;
  }
  return all[0] || null;
}
