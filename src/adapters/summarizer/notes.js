export function emptyNotes() {
  return { tldr: '', topics: [], decisions: [], openQuestions: [], actionItems: [] };
}

export function normalizeNotes(obj = {}) {
  const base = emptyNotes();
  return {
    tldr: typeof obj.tldr === 'string' ? obj.tldr : base.tldr,
    topics: Array.isArray(obj.topics) ? [...obj.topics] : base.topics,
    decisions: Array.isArray(obj.decisions) ? [...obj.decisions] : base.decisions,
    openQuestions: Array.isArray(obj.openQuestions) ? [...obj.openQuestions] : base.openQuestions,
    actionItems: Array.isArray(obj.actionItems) ? [...obj.actionItems] : base.actionItems,
  };
}

export const SUMMARY_PROMPT = `You are a meeting-notes assistant. Read the speaker-labeled transcript and return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "tldr": "2-4 sentence overview",
  "topics": [{"title": "string", "points": ["string"]}],
  "decisions": ["string"],
  "openQuestions": ["string"],
  "actionItems": [{"assignee": "speaker display name or null", "task": "string"}]
}
Rules:
- Assign each action item to the speaker responsible using their display name; use null only if truly unassigned.
- Use the speaker names exactly as they appear in the transcript.
- Coverage scales with the meeting: every distinct subject discussed is its own topic. Do not collapse a long meeting into 2–3 topics. A later or shorter thread is still a topic.
- Points name people, tools, numbers, and decisions; "discussed X" is not a point.
- Density belongs in topics, decisions, openQuestions, and actionItems — not the tldr (2–4 sentences).
- If the transcript is short or unclear, still return the JSON with best-effort empty arrays.`;

export function summaryPrompt(meta = {}) {
  const base = meta.summaryPrompt ?? SUMMARY_PROMPT;
  return meta.campaignContext ? `${base}${campaignContextBlock(meta.campaignContext)}` : base;
}

// Background from earlier sessions of the same campaign (the campaign journal).
// It helps the model resolve names and references, but the notes must still
// describe only what happens in this transcript.
export function campaignContextBlock(context) {
  return `

Background from earlier sessions of this campaign (for reference only — use it to recognise names, places and running plot threads, and to spell names consistently when speech-to-text garbles them; summarise ONLY what happens in the transcript below):
<campaign_background>
${context}
</campaign_background>`;
}
