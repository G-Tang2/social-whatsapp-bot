// test/helpers/mockBaileys.js
// Reusable fake-Baileys-socket harness for tests that need to exercise
// index.js's handleMessage() (or any command handler) end-to-end without a
// real WhatsApp connection. Extracted from a pattern used repeatedly during
// manual testing throughout this project's development.
//
// Usage:
//   const { createFakeSock, makeTextMessage } = require('./mockBaileys');
//   const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
//   await handleMessage(sock, makeTextMessage({ from: 'alice@s.whatsapp.net', groupId, text: '!in' }), 'notify');
//   assert.match(sock.sentMessages[0].content.text, /.../);

// Creates a fake `sock` object matching the subset of the real Baileys
// socket surface this bot actually uses: sendMessage() (recording every
// call, and honoring `content.delete`/`content.react` as a deletion/reaction
// rather than a send - each collected into its own array instead of
// `sentMessages`, so existing assertions against `sentMessages` don't have
// to account for the bot's incidental reactions on every @-mention),
// groupMetadata() (returning fake participants, admins flagged via the
// `admins` option), sendPresenceUpdate() (recording every call into its own
// `presenceUpdates` array - see index.js's composing/available typing
// indicator around live command/mention handling), and `user.id` - the
// bot's own JID, used by
// index.js's messageMentionsBot() (see the natural-language command
// feature, lib/geminiCommand.js) to tell whether a message @-mentions the
// bot itself. Defaults to a JID WITH a device-id suffix (like the real
// Baileys sock.user.id always has) specifically so tests exercise the
// normalizeJid() stripping that comparison depends on, rather than
// accidentally passing via a same-shape coincidence.
function createFakeSock({ admins = [], participantIds = [], botJid = 'bot:7@s.whatsapp.net' } = {}) {
  const sentMessages = [];
  const deleted = [];
  const reactions = [];
  const presenceUpdates = [];

  const allParticipantIds = Array.from(new Set([...admins, ...participantIds]));

  const sock = {
    sentMessages,
    deleted,
    reactions,
    presenceUpdates,
    user: { id: botJid },
    sendPresenceUpdate: async (type, jid) => {
      presenceUpdates.push({ type, jid });
    },
    sendMessage: async (jid, content, options) => {
      if (content && content.delete) {
        deleted.push({ jid, key: content.delete });
        return { key: content.delete };
      }
      if (content && content.react) {
        reactions.push({ jid, emoji: content.react.text, key: content.react.key });
        return { key: content.react.key };
      }
      const entry = { jid, content, options };
      sentMessages.push(entry);
      return { key: { id: `fake-${sentMessages.length}` } };
    },
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Fake Group',
      participants: allParticipantIds.map((id) => ({
        id,
        admin: admins.includes(id) ? 'admin' : null,
      })),
    }),
    // Lets a test add a participant (e.g. simulating someone joining)
    // after the sock was created, so later group-metadata fetches pick
    // them up.
    _addParticipant(id, isAdmin = false) {
      if (!allParticipantIds.includes(id)) allParticipantIds.push(id);
      if (isAdmin && !admins.includes(id)) admins.push(id);
    },
  };

  return sock;
}

let fakeMsgCounter = 0;

// Builds a minimal Baileys-shaped message object for `text` sent by `from`
// in `groupId`. `pushName` defaults to the local part of `from`.
//
// `mentions`, if given (an array of JIDs), and/or `quotedParticipant`, if
// given (a single JID), shape this as an extendedTextMessage with
// contextInfo.mentionedJid/contextInfo.participant instead of a plain
// `conversation` message - matching how real WhatsApp/Baileys represents
// an @-mention or a "Reply" to someone's message respectively (see
// lib/helpers.js's getMentionedJids/getQuotedParticipant doc comments for
// why a plain `conversation` message can never carry either - typing "@"
// or tapping Reply is what causes the client to send an extendedTextMessage
// with contextInfo instead). Used by the natural-language command
// feature's tests (lib/geminiCommand.js, index.js's messageMentionsBot()).
function makeTextMessage({ from, groupId, text, pushName, fromMe = false, mentions, quotedParticipant }) {
  fakeMsgCounter += 1;
  const contextInfo = {};
  if (mentions && mentions.length) contextInfo.mentionedJid = mentions;
  if (quotedParticipant) contextInfo.participant = quotedParticipant;
  return {
    key: {
      remoteJid: groupId,
      participant: from,
      fromMe,
      id: `FAKE${fakeMsgCounter}`,
    },
    pushName: pushName || (from ? from.split('@')[0] : undefined),
    message: Object.keys(contextInfo).length ? { extendedTextMessage: { text, contextInfo } } : { conversation: text },
  };
}

module.exports = { createFakeSock, makeTextMessage };
