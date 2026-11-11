import { SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { SUPPORTED_PROVIDERS } from '../adapters/summarizer/index.js';
import { WHISPER_MODELS } from './setup-logic.js';
import { STT_PROVIDERS, STT_MODELS } from '../adapters/stt/index.js';
import { LANGUAGES } from '../adapters/summarizer/languages.js';

// Discord caps a string option at 25 choices; the cloud STT model ids comfortably
// fit. Flatten every provider's models into one choice list for `stt_model`.
const STT_MODEL_CHOICES = [...new Set(Object.values(STT_MODELS).flat())];

export function buildCommands() {
  return [
    new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and start recording'),
    new SlashCommandBuilder().setName('leave').setDescription('Stop recording and leave'),
    new SlashCommandBuilder().setName('summary').setDescription('Show notes for a meeting')
      .addIntegerOption((o) => o.setName('meeting').setDescription('Meeting id (default: most recent)')),
    new SlashCommandBuilder().setName('post').setDescription('Post a meeting summary publicly in this channel')
      .addIntegerOption((o) => o.setName('meeting').setDescription('Meeting id (default: most recent)')),
    new SlashCommandBuilder().setName('history').setDescription('List recent meetings'),
    new SlashCommandBuilder().setName('status').setDescription('Check bot status and current recording'),
    new SlashCommandBuilder().setName('raw').setDescription('Dump raw meeting data')
      .addIntegerOption((o) => o.setName('meeting').setDescription('Meeting id (default: most recent)')),
    new SlashCommandBuilder().setName('search').setDescription('Search past meetings')
      .addStringOption((o) => o.setName('keyword').setDescription('Word or phrase').setRequired(true)),
    new SlashCommandBuilder().setName('ask').setDescription('Ask a question across every session of a campaign')
      .addStringOption((o) => o.setName('question').setDescription('e.g. "What did the lich want with the amulet?"').setRequired(true).setMaxLength(500))
      .addStringOption((o) => o.setName('campaign').setDescription('Campaign (default: the one linked to your voice channel, else the latest)').setAutocomplete(true))
      .addBooleanOption((o) => o.setName('public').setDescription('Post the answer for everyone (default: only you)')),
    new SlashCommandBuilder().setName('recap').setDescription('"Previously on…" recap of the last session(s)')
      .addStringOption((o) => o.setName('campaign').setDescription('Campaign (default: the one linked to your voice channel, else the latest)').setAutocomplete(true))
      .addIntegerOption((o) => o.setName('sessions').setDescription('How many recent sessions to cover (1-5, default 1)').setMinValue(1).setMaxValue(5))
      .addBooleanOption((o) => o.setName('public').setDescription('Post the recap for everyone (default: only you)')),
    new SlashCommandBuilder().setName('journal').setDescription('Show the campaign journal (party, NPCs, places, quests, loot)')
      .addStringOption((o) => o.setName('campaign').setDescription('Campaign (default: the one linked to your voice channel, else the latest)').setAutocomplete(true)),
    new SlashCommandBuilder().setName('campaign').setDescription('Manage campaigns (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sc) => sc.setName('create').setDescription('Create a campaign, optionally linked to a voice channel')
        .addStringOption((o) => o.setName('name').setDescription('Campaign name').setRequired(true).setMaxLength(100))
        .addChannelOption((o) => o.setName('voice_channel').setDescription('Recordings in this channel join the campaign')
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
        .addBooleanOption((o) => o.setName('include_past').setDescription('Also add earlier recordings from that channel')))
      .addSubcommand((sc) => sc.setName('link').setDescription('Link a voice channel to a campaign')
        .addStringOption((o) => o.setName('campaign').setDescription('Campaign').setRequired(true).setAutocomplete(true))
        .addChannelOption((o) => o.setName('voice_channel').setDescription('Voice channel').setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
        .addBooleanOption((o) => o.setName('include_past').setDescription('Also add earlier recordings from that channel')))
      .addSubcommand((sc) => sc.setName('list').setDescription('List campaigns and their linked channels')),
    new SlashCommandBuilder().setName('setup').setDescription('Configure the bot (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName('provider').setDescription('Summarizer provider')
        .addChoices(...SUPPORTED_PROVIDERS.map((p) => ({ name: p, value: p }))))
      .addStringOption((o) => o.setName('model').setDescription('Summarizer model — type to search the provider catalog').setAutocomplete(true))
      .addStringOption((o) => o.setName('fallback_provider').setDescription('Backup summarizer used only if the primary fails')
        .addChoices(...SUPPORTED_PROVIDERS.map((p) => ({ name: p, value: p })), { name: 'none', value: 'none' }))
      .addStringOption((o) => o.setName('fallback_model').setDescription('Backup summarizer model — type to search the provider catalog').setAutocomplete(true))
      .addStringOption((o) => o.setName('stt_provider').setDescription('Speech-to-text provider')
        .addChoices(...STT_PROVIDERS.map((p) => ({ name: p, value: p }))))
      .addStringOption((o) => o.setName('stt_model').setDescription('Cloud STT model (OpenAI)')
        .addChoices(...STT_MODEL_CHOICES.map((m) => ({ name: m, value: m }))))
      .addStringOption((o) => o.setName('whisper_model').setDescription('Whisper model size (local sidecar)')
        .addChoices(...WHISPER_MODELS.map((m) => ({ name: m, value: m }))))
      .addChannelOption((o) => o.setName('notes_channel').setDescription('Where to post notes').addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o.setName('thread').setDescription('Post notes in a thread'))
      .addBooleanOption((o) => o.setName('autojoin').setDescription('Auto-join when 2+ people are in voice'))
      .addStringOption((o) => o.setName('language').setDescription('Spoken language (pick German to fix DE/EN mixing)')
        .addChoices(...LANGUAGES.map((l) => ({ name: l.name, value: l.code })), { name: 'Auto-detect', value: 'auto' }))
      .addStringOption((o) => o.setName('summary_language').setDescription('Language for the notes/summary')
        .addChoices(...LANGUAGES.map((l) => ({ name: l.name, value: l.code })), { name: 'Match transcription', value: 'match' })),
  ];
}

export function commandsJSON() {
  return buildCommands().map((c) => c.toJSON());
}

// UI-facing catalog of the slash commands (single source for the dashboard's
// Commands page). Kept next to buildCommands() so they stay in sync. `admin`
// marks commands gated behind the Manage Server permission; `args` is a short
// human description of the options.
export const COMMAND_CATALOG = [
  { name: 'join', category: 'Recording', admin: false, args: null,
    summary: 'Join your current voice channel and start recording.',
    detail: 'Parley joins the voice channel you are in and begins capturing a separate audio track per speaker. Its nickname shows [REC] while recording.' },
  { name: 'leave', category: 'Recording', admin: false, args: null,
    summary: 'Stop recording, transcribe, and post the notes.',
    detail: 'Ends the meeting, transcribes every track locally, and posts the structured notes to the configured channel or a thread.' },
  { name: 'status', category: 'Recording', admin: false, args: null,
    summary: 'Show whether the bot is recording, plus recent meetings.' },
  { name: 'summary', category: 'Notes', admin: false, args: '[meeting]',
    summary: 'Show the notes for a meeting (defaults to the most recent).',
    detail: 'Posts the TL;DR, topics, decisions, open questions, action items and talk-time for a meeting, only visible to you.' },
  { name: 'post', category: 'Notes', admin: false, args: '[meeting]',
    summary: 'Post a meeting summary publicly in this channel.',
    detail: 'Like /summary but posts the notes visibly (in a thread if threads are enabled) so the whole channel can see them.' },
  { name: 'history', category: 'Notes', admin: false, args: null,
    summary: 'List recent meetings with their status.' },
  { name: 'raw', category: 'Notes', admin: false, args: '[meeting]',
    summary: 'Dump raw meeting data: metadata, attendees, utterances, summary.',
    detail: 'A JSON dump for debugging or exporting a meeting.' },
  { name: 'search', category: 'Notes', admin: false, args: '<keyword>',
    summary: 'Full-text search across every past meeting transcript.' },
  { name: 'ask', category: 'Campaigns', admin: false, args: '<question> [campaign] [public]',
    summary: 'Ask a question across every session of a campaign.',
    detail: 'Answers from the campaign journal, every session\'s notes, and the transcript passages that best match your question, citing the session numbers. Defaults to the campaign linked to your voice channel, or the most recently active one.' },
  { name: 'recap', category: 'Campaigns', admin: false, args: '[campaign] [sessions] [public]',
    summary: 'Write a "Previously on…" recap to read at the start of the next game.',
    detail: 'A short, read-aloud recap of the last session (or up to 5), ending on where the party stands. Set public to post it for the whole table.' },
  { name: 'journal', category: 'Campaigns', admin: false, args: '[campaign]',
    summary: 'Show the campaign journal: party, NPCs, places, quests, loot, lore.',
    detail: 'The journal is updated automatically after each session in the campaign. Edit it or rebuild it from the dashboard\'s Campaigns page.' },
  { name: 'campaign', category: 'Campaigns', admin: true, args: 'create <name> [voice_channel] [include_past] · link <campaign> <voice_channel> [include_past] · list',
    summary: 'Create campaigns and link voice channels to them (admin only).',
    detail: 'Recordings in a linked voice channel join that campaign automatically, feed its journal, and become searchable with /ask. include_past also adds earlier recordings from the channel (use "Update journal" on the dashboard to fold them in).' },
  { name: 'setup', category: 'Configuration', admin: true,
    args: '[provider] [model] [fallback_provider] [fallback_model] [stt_provider] [stt_model] [whisper_model] [notes_channel] [thread] [autojoin] [language] [summary_language]',
    summary: 'Configure the bot for this server (admin only).',
    detail: 'Set the summarizer provider/model, an optional fallback summarizer used only when the primary fails (set fallback_provider to "none" to disable), the speech-to-text provider (local sidecar or OpenAI) and model, notes channel, threading, auto-join, and languages. You can also do all of this from this dashboard under Settings.' },
];
;
