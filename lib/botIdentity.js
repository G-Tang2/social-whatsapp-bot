// lib/botIdentity.js
// Tracks the bot's own WhatsApp LID (the newer, privacy-focused addressing
// format - see index.js's messageMentionsBot() for the full "two parallel
// addressing formats for the same account" background) per group, for the
// case where sock.user.lid itself never gets populated.
//
// Real bug this fixes: Baileys is supposed to set sock.user.lid from the
// login handshake's own success stanza, but a real production log showed
// it staying undefined for an entire connection, even in a group that
// was clearly lid-addressed (every mention/participant there used a
// "@lid" JID) - meaning genuine "@Snoopy ..." mentions of the bot were
// silently never recognized, with sock.user offering no way to tell.
//
// An earlier version of this fix tried asking sock.groupMetadata() for
// the bot's own participant entry and reading ITS lid field - that turned
// out to be unreliable too: in a fully lid-migrated group, groupMetadata()
// reports every participant's `id` (and often `jid`) as their LID
// already, with no reliable phone-number cross-reference left to match
// sock.user.id (still phone-number form) against, so "which participant
// is me" couldn't actually be determined from that data.
//
// What DOES work, confirmed directly from that same production log: any
// message the bot itself sends (`fromMe: true`) has its own
// `msg.key.participant` set to the bot's own lid, by WhatsApp itself, in
// a lid-addressed group - because that field always reports the actual
// SENDER, and the bot is the sender of its own messages. So instead of
// asking a separate API for this, the bot just learns it by watching its
// own outgoing messages - see index.js's handleMessage(), which calls
// recordBotLid() for every fromMe message before discarding it.
//
// Per-group (not a single global value) purely out of caution - nothing
// currently suggests a lid could differ by group for the same account,
// but there's no downside to scoping it this way, and it costs nothing
// extra once learned. In-memory only, like lastLiveMessageByGroup and the
// other plain runtime Maps in index.js - doesn't survive a restart, but
// self-heals within moments of the bot sending anything at all in a
// group (a list repost, a reply, ...), which happens constantly.

// groupId -> the bot's own lid, as last observed on one of its own
// messages in that group.
const knownLidByGroup = new Map();

// Records `lid` as the bot's own lid for `groupId` - called for every
// fromMe message (see index.js), harmless to call redundantly since a
// lid never actually changes for the life of an account.
function recordBotLid(groupId, lid) {
  if (!groupId || !lid) return;
  knownLidByGroup.set(groupId, lid);
}

// Returns the bot's own previously-learned lid for `groupId`, or
// undefined if the bot hasn't sent anything in that group yet since this
// process started.
function getKnownBotLid(groupId) {
  return knownLidByGroup.get(groupId);
}

module.exports = {
  recordBotLid,
  getKnownBotLid,
};
