// The bot's per-server nickname. While recording it gets a "🔴 " prefix so the
// voice channel shows it's live, e.g. "st3bot" → "🔴 st3bot".

export const REC_PREFIX = '🔴 ';
// Discord caps nicknames at 32 characters; keep room for the prefix (the emoji
// is 2 UTF-16 units, so this stays safe however Discord counts it).
export const MAX_NICKNAME = 32 - REC_PREFIX.length;

/**
 * The nickname to set. `nickname` is the server's configured name (or null),
 * `username` the bot's own account name. Returns null to clear the nickname
 * (Discord then shows the username).
 */
export function nicknameFor({ nickname, username, recording }) {
  if (!recording) return nickname || null;
  const base = (nickname || username || 'Parley').slice(0, MAX_NICKNAME);
  return `${REC_PREFIX}${base}`;
}

// A nickname left over from a recording that ended uncleanly (crash, restart),
// including older styles ("[REC] …", "… 🔴").
export function isStaleRecordingNickname(current) {
  return typeof current === 'string'
    && (current.startsWith(REC_PREFIX) || current.endsWith(' 🔴') || current.startsWith('[REC]'));
}
