// src/campaign/journal.js
// The campaign journal: one living Markdown document per campaign (party,
// NPCs, places, quests, loot, lore) that the LLM rewrites after each session.
// The session-by-session log is NOT part of it — each session's own notes
// already serve that role — so the document tracks world state and stays
// compact instead of growing with every session.
import { getSummarizer } from '../adapters/summarizer/index.js';
import { resolveSummaryLanguage, summaryLanguageInstruction } from '../adapters/summarizer/languages.js';
import { describeSummarizerError } from '../adapters/summarizer/errors.js';
import { getGuildConfig } from '../store/config.js';
import { buildTranscript } from '../pipeline/summarize.js';

export const JOURNAL_SECTIONS = [
  'Party',
  'NPCs',
  'Locations',
  'Quests & Plot Threads',
  'Items & Loot',
  'Lore & World',
  'Open Mysteries',
];

export const EMPTY_JOURNAL = JOURNAL_SECTIONS.map((s) => `## ${s}\n- (nothing yet)`).join('\n\n');

export function buildJournalUpdatePrompt({
  campaignName, journal, transcript, sessionNumber, date, attendees = [], tldr, summaryLanguage,
}) {
  const sections = JOURNAL_SECTIONS.map((s) => `## ${s}`).join('\n');
  return `You keep the campaign journal for a tabletop role-playing campaign called "${campaignName}". Below are the CURRENT JOURNAL and the TRANSCRIPT of session ${sessionNumber}${date ? ` (${date.slice(0, 10)})` : ''}.

Speakers are labelled with the players' Discord names. One of them is usually the Game Master, who narrates the world and voices the NPCs. Players: ${attendees.join(', ') || 'unknown'}.

Return the COMPLETE updated journal in Markdown, using exactly these sections in this order:
${sections}

Rules:
- Keep everything already in the journal unless this session clearly contradicts or resolves it. Never drop an entry just because it did not come up this session.
- Merge new information into existing entries instead of duplicating them. One bullet per entity, e.g. "- **Name** — who or what they are; relationship to the party; latest status (session ${sessionNumber})."
- Party: map each player to their character (name, ancestry/class, notable traits) when it can be inferred, e.g. "- **Thorin** (played by Alex) — dwarf fighter …". Identify the Game Master here too if clear.
- Mark finished quests "(completed, session N)" and dead characters "(deceased, session N)" instead of deleting them.
- Out-of-character table talk (rules lookups, snacks, scheduling, jokes) does not belong in the journal.
- Speech-to-text garbles fantasy names. When a name in the transcript is clearly an entity already in the journal, use the journal's spelling.
- Do not add a session-by-session log; that is kept separately.
- Output only the journal Markdown: no preamble, no closing remarks, no code fences.${summaryLanguageInstruction(summaryLanguage).replace('summary', 'journal')}
${tldr ? `\nThis session's summary, for orientation: ${tldr}\n` : ''}
<current_journal>
${journal?.trim() || EMPTY_JOURNAL}
</current_journal>

<session_transcript>
${transcript}
</session_transcript>`;
}

// Models sometimes wrap the document in a fence or add a sentence before it.
export function cleanJournal(raw = '') {
  let text = String(raw).trim();
  const fence = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();
  const firstHeading = text.search(/^## /m);
  if (firstHeading > 0) text = text.slice(firstHeading);
  return text.trim();
}

// Guard against a model reply that would wipe out the journal: a refusal, an
// error string, or a truncated rewrite. Throws with a readable reason.
export function checkJournalUpdate(previous, next) {
  if (!/^## /m.test(next)) {
    throw new Error('The model did not return a journal (no sections found).');
  }
  const prev = (previous || '').trim();
  if (prev.length > 800 && next.length < prev.length * 0.5) {
    throw new Error(`The model's journal was less than half the length of the current one (${next.length} vs ${prev.length} characters), so it was rejected to avoid losing notes.`);
  }
}

// One update at a time per campaign: two sessions finishing together must not
// both read the old journal and overwrite each other's additions.
const locks = new Map();
export function withCampaignLock(campaignId, fn) {
  const prev = locks.get(campaignId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(campaignId, tail);
  tail.then(() => { if (locks.get(campaignId) === tail) locks.delete(campaignId); });
  return run;
}

// The journal to give the summarizer as background for a session, if any.
export function campaignContextFor(db, meeting) {
  if (!meeting?.campaign_id) return undefined;
  const journal = db.getCampaign(meeting.campaign_id)?.journal?.trim();
  return journal || undefined;
}

function toPipelineUtterances(rows) {
  return rows.map((u) => ({
    userId: u.user_id, displayName: u.display_name, startMs: u.start_ms, endMs: u.end_ms, text: u.text,
  }));
}

// Fold one finished session into its campaign's journal. A no-op (returns
// { skipped }) for meetings outside a campaign or already folded in.
async function foldUnlocked(db, meetingId, { cfg, summarizer }) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting?.campaign_id) return { skipped: 'not in a campaign' };
  if (meeting.journaled_at) return { skipped: 'already in the journal' };
  const campaign = db.getCampaign(meeting.campaign_id);
  if (!campaign) return { skipped: 'campaign not found' };
  const utterances = db.listUtterances(meetingId);
  if (utterances.length === 0) return { skipped: 'no transcript' };

  const session = db.listCampaignSessions(campaign.id).find((s) => s.id === meeting.id);
  const prompt = buildJournalUpdatePrompt({
    campaignName: campaign.name,
    journal: campaign.journal,
    transcript: buildTranscript(toPipelineUtterances(utterances)),
    sessionNumber: session?.number ?? '?',
    date: meeting.started_at,
    attendees: db.listAttendees(meetingId).map((a) => a.display_name),
    tldr: session?.notes?.tldr,
    summaryLanguage: resolveSummaryLanguage(cfg),
  });
  const next = cleanJournal(await summarizer.ask(prompt));
  checkJournalUpdate(campaign.journal, next);
  db.setCampaignJournal(campaign.id, next);
  db.markJournaled(meetingId);
  return { updated: true, campaignId: campaign.id };
}

export function foldMeetingIntoJournal(db, meetingId, { cfg, summarizer, env } = {}) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting?.campaign_id) return Promise.resolve({ skipped: 'not in a campaign' });
  const c = cfg || getGuildConfig(db, meeting.guild_id);
  const s = summarizer || getSummarizer(c, env);
  return withCampaignLock(meeting.campaign_id, () => foldUnlocked(db, meetingId, { cfg: c, summarizer: s }));
}

/**
 * Fold every finished session that isn't in the journal yet, oldest first.
 * With rebuild, start over from an empty journal (hand edits are lost).
 * Tracks progress in campaigns.journal_status so the UI can show it.
 */
export function catchUpJournal(db, campaignId, { rebuild = false, cfg, summarizer, env } = {}) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return Promise.reject(new Error('campaign not found'));
  const c = cfg || getGuildConfig(db, campaign.guild_id);
  const s = summarizer || getSummarizer(c, env);
  db.setJournalStatus(campaignId, 'updating');
  return withCampaignLock(campaignId, async () => {
    try {
      if (rebuild) {
        db.setCampaignJournal(campaignId, null);
        db.clearJournaled(campaignId);
      }
      let folded = 0;
      const pending = db.listCampaignSessions(campaignId)
        .filter((m) => m.status === 'done' && !m.journaled_at);
      for (const m of pending) {
        const r = await foldUnlocked(db, m.id, { cfg: c, summarizer: s });
        if (r.updated) folded++;
      }
      db.setJournalStatus(campaignId, 'idle');
      return { folded };
    } catch (err) {
      const reason = err.userMessage || (err.status ? describeSummarizerError(err, c.summarizerProvider) : err.message);
      db.setJournalStatus(campaignId, 'error', reason);
      throw err;
    }
  });
}
