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
// call, and honoring `content.delete` as a deletion rather than a send),
// groupMetadata() (returning fake participants, admins flagged via the
// `admins` option), and `user.id` - the bot's own JID, used by
// index.js's messageMentionsBot() (see the natural-language command
// feature, lib/geminiCommand.js) to tell whether a message @-mentions the
// bot itself. Defaults to a JID WITH a device-id suffix (like the real
// Baileys sock.user.id always has) specifically so tests exercise the
// normalizeJid() stripping that comparison depends on, rather than
// accidentally passing via a same-shape coincidence.
function createFakeSock({ admins = [], participantIds = [], botJid = 'bot:7@s.whatsapp.net' } = {}) {
  const sentMessages = [];
  const deleted = [];

  const allParticipantIds = Array.from(new Set([...admins, ...participantIds]));

  const sock = {
    sentMessages,
    deleted,
    user: { id: botJid },
    sendMessage: async (jid, content, options) => {
      if (content && content.delete) {
        deleted.push({ jid, key: content.delete });
        return { key: content.delete };
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
    // after the sock was created, so !inactivity-on-style group-metadata
    // fetches pick them up.
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
// `mentions`, if given (an array of JIDs), shapes this as an
// extendedTextMessage with contextInfo.mentionedJid instead of a plain
// `conversation` message - matching how real WhatsApp/Baileys represents
// an @-mention (see lib/helpers.js's getMentionedJids doc comment for why
// a plain `conversation` message can never carry mentions at all). Used
// by the natural-language command feature's tests (lib/geminiCommand.js,
// index.js's messageMentionsBot()).
function makeTextMessage({ from, groupId, text, pushName, fromMe = false, mentions }) {
  fakeMsgCounter += 1;
  return {
    key: {
      remoteJid: groupId,
      participant: from,
      fromMe,
      id: `FAKE${fakeMsgCounter}`,
    },
    pushName: pushName || (from ? from.split('@')[0] : undefined),
    message:
      mentions && mentions.length
        ? { extendedTextMessage: { text, contextInfo: { mentionedJid: mentions } } }
        : { conversation: text },
  };
}

module.exports = { createFakeSock, makeTextMessage };
