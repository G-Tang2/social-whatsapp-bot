// lib/botIdentity.js
// Resolves the bot's own WhatsApp LID (the newer, privacy-focused
// addressing format - see index.js's messageMentionsBot() for the full
// "two parallel addressing formats for the same account" background) for
// a specific group, for the one case where sock.user.lid itself doesn't
// already have it.
//
// Real bug this fixes: Baileys normally sets sock.user.lid from the login
// handshake's own success stanza, but that stanza doesn't always carry a
// lid for every account/session - a real production log showed
// sock.user.lid staying undefined for an entire connection, even though
// that SAME group clearly used @lid-form mentions (the incoming message's
// own contextInfo.mentionedJid was a @lid address) - meaning a genuine
// "@Snoopy ..." mention of the bot was silently never recognized as one,
// with no way to tell from sock.user alone. groupMetadata()'s own
// participant list carries each participant's lid independently of
// sock.user, so this looks the bot's own entry up there instead, as a
// fallback source of truth.
//
// Same "wrap a network call in a short-TTL per-group cache" pattern
// lib/adminCheck.js already uses, for the identical performance reason -
// a busy group shouldn't pay for a fresh groupMetadata() call on every
// message just to re-derive something that essentially never changes for
// the life of a connection.

const { normalizeJid } = require('./helpers');

const CACHE_TTL_MS = 60 * 1000;

// groupId -> { expiresAt: number, lid: string | null }
const cache = new Map();

async function fetchBotLid(sock, groupId) {
  const botId = sock?.user?.id;
  if (!botId) return null;
  const normalizedBotId = normalizeJid(botId);
  const metadata = await sock.groupMetadata(groupId);
  const self = (metadata.participants || []).find((p) => {
    return (p.id && normalizeJid(p.id) === normalizedBotId) || (p.jid && normalizeJid(p.jid) === normalizedBotId);
  });
  return (self && self.lid) || null;
}

// Returns the bot's own lid for `groupId` (using the cache when fresh), or
// null if it genuinely has none / couldn't be determined (e.g. the group
// hasn't migrated to lid-based addressing at all, or the lookup failed) -
// callers should treat null exactly like "no lid available", the same as
// a falsy sock.user.lid.
async function resolveBotLid(sock, groupId) {
  const cached = cache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.lid;
  }
  let lid = null;
  try {
    lid = await fetchBotLid(sock, groupId);
  } catch (err) {
    console.error(`[botIdentity] Failed to resolve the bot's own lid for ${groupId}:`, err.message);
  }
  cache.set(groupId, { expiresAt: Date.now() + CACHE_TTL_MS, lid });
  return lid;
}

// Drops any cached entry for `groupId` - not used by the running bot
// today, but useful for tests, same escape-hatch reasoning as
// lib/adminCheck.js's own invalidate().
function invalidate(groupId) {
  cache.delete(groupId);
}

module.exports = {
  resolveBotLid,
  invalidate,
};
