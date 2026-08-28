// test/e2e.test.js
// End-to-end tests that exercise index.js's actual message-handling
// pipeline (not just individual command handlers), via a mocked Baileys
// module. Focused on the wiring that only shows up at the pipeline level:
// catch-up ('append') gating, spam-deletion happening before a message is
// ever treated as a command, and the ALLOWED_GROUPS
// gate - reusing the pattern used throughout this project's manual testing
// (see test/helpers/mockBaileys.js).
//
// Requires ALLOWED_GROUPS/DATA_DIR to be set via process.env BEFORE
// index.js (and its requires) are loaded, since lib/config.js reads them
// once at require time - this is why the injected-module setup below
// happens at the top of the file rather than inside a test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-e2e-test-'));
const GROUP_ID = '111111111@g.us';
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_ID;
process.env.AUTH_DIR = path.join(tmpDir, 'auth_info');
// Real default is 5s (see lib/config.js) - shortened here so catch-up-batch
// tests don't have to wait several real seconds per assertion.
process.env.CATCH_UP_FLUSH_DELAY_SECONDS = '0.2';
// Real default is 5 minutes (see lib/config.js) - shortened here so the
// "last seen" heartbeat interval test doesn't have to wait several real
// minutes per assertion.
process.env.LAST_SEEN_STATUS_INTERVAL_MINUTES = '0.01'; // ~600ms
process.env.TIMEZONE = 'UTC';
// Off by default (see lib/config.js) - opted in here so this file's DM
// redirect tests below actually exercise the reply path, same reasoning
// as GEMINI_API_KEY just below for the natural-language tests.
process.env.DM_REPLIES_ENABLED = 'true';
// Fake (never-reaches-a-real-network) key - just enough for !ai on to be
// allowed and for lib/geminiCommand.js's interpretMessage() to attempt a
// call at all. The fake @google/genai module injected below is what
// actually intercepts that call - see BOT_JID/geminiResponseQueue below.
process.env.GEMINI_API_KEY = 'test-key-not-real';

const BOT_JID = 'bot:7@s.whatsapp.net';
// The bot's "LID" (privacy-addressing) JID - a completely different
// numeric ID for the SAME account as BOT_JID, in some groups WhatsApp
// puts this form in contextInfo.mentionedJid instead of the classic
// phone-number form. See messageMentionsBot() in index.js, which checks
// both sock.user.id and sock.user.lid for exactly this reason.
const BOT_LID = '999888777@lid';

// --- Inject a fake @whiskeysockets/baileys before index.js requires it ---
// index.js calls makeWASocket()/useMultiFileAuthState()/
// fetchLatestBaileysVersion() at module load time (via start(), invoked at
// the bottom of the file), so the fake needs to be in place before
// require('../index') runs.
let capturedHandlers = {};
let fakeSockInstance;
let socketCreateCount = 0;

function buildFakeSock() {
  const sentMessages = [];
  const deleted = [];
  const reactions = [];
  const statusUpdates = [];
  const presenceUpdates = [];
  const admins = new Set(['admin@s.whatsapp.net']);
  const participants = new Set(['admin@s.whatsapp.net', 'alex@s.whatsapp.net', 'sam@s.whatsapp.net']);

  const sock = {
    sentMessages,
    deleted,
    reactions,
    statusUpdates,
    presenceUpdates,
    // The bot's own JID - used by index.js's messageMentionsBot() to tell
    // whether an incoming message @-mentions the bot (see the natural-
    // language command feature below). Includes a device-id suffix, same
    // as real Baileys, to exercise the normalizeJid() comparison.
    user: { id: BOT_JID, lid: BOT_LID },
    ev: {
      on: (event, handler) => {
        capturedHandlers[event] = handler;
      },
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
      sentMessages.push({ jid, content, options });
      return { key: { id: `fake-${sentMessages.length}` } };
    },
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Fake Group',
      participants: [...participants].map((id) => ({ id, admin: admins.has(id) ? 'admin' : null })),
    }),
    updateProfileStatus: async (status) => {
      statusUpdates.push(status);
    },
    sendPresenceUpdate: async (type, jid) => {
      presenceUpdates.push({ type, jid });
    },
  };
  return sock;
}

const fakeBaileysModule = {
  default: () => {
    socketCreateCount += 1;
    fakeSockInstance = buildFakeSock();
    return fakeSockInstance;
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
  fetchLatestBaileysVersion: async () => ({ version: [2, 0, 0] }),
  DisconnectReason: { loggedOut: 401 },
  // Real Baileys' own generics.js: unwraps a protobuf Long (via .toNumber())
  // or passes a plain number through - see index.js's effectiveUpsertType(),
  // the only thing that actually calls this.
  toNumber: (t) => (typeof t === 'object' && t ? (typeof t.toNumber === 'function' ? t.toNumber() : t.low) : t || 0),
};

const baileysPath = require.resolve('@whiskeysockets/baileys');
require.cache[baileysPath] = new Module(baileysPath);
require.cache[baileysPath].exports = fakeBaileysModule;
require.cache[baileysPath].loaded = true;

// --- Inject a fake @google/genai before lib/geminiCommand.js requires it ---
// Same require.cache-swap technique as @whiskeysockets/baileys above.
// geminiResponseQueue lets each test control exactly what the "Gemini
// API" returns for its next call (shift()ed off on each generateContent
// call) - see setNextGeminiResponse()/setNextGeminiError() below, used by
// the natural-language command tests further down this file.
let geminiCallCount = 0;
let geminiResponseQueue = [];
let lastGeminiCallArgs = null; // captures the last generateContent({...}) call - see getLastGeminiPromptText() below
const fakeGenaiModule = {
  GoogleGenAI: class {
    constructor() {
      this.models = {
        generateContent: async (args) => {
          geminiCallCount += 1;
          lastGeminiCallArgs = args;
          const next = geminiResponseQueue.shift();
          if (next && next.timeout) {
            // Real timed-out fetch() rejects with a DOMException whose
            // `.name` is the fetch spec's standard "AbortError" - see
            // lib/geminiCommand.js's interpretMessage(), which checks
            // exactly this to tell "took too long" apart from every other
            // failure (see setNextGeminiError below for that case).
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          if (next && next.error) throw new Error(next.error);
          return { text: next ? next.text : JSON.stringify({ actions: [{ command: 'none', argText: '', confidence: 'high' }] }) };
        },
      };
    }
  },
};
const genaiPath = require.resolve('@google/genai');
require.cache[genaiPath] = new Module(genaiPath);
require.cache[genaiPath].exports = fakeGenaiModule;
require.cache[genaiPath].loaded = true;

// Accepts EITHER a single flat { command, argText, confidence } object
// (auto-wrapped into a one-item actions array, for the common
// single-request case - most tests in this file) OR an already-shaped
// { actions: [...] } object directly (for a genuine multi-action/compound
// response - see the "compound @-mention" tests further down) - see
// lib/geminiCommand.js's RESPONSE_SCHEMA doc comment for why the real
// interpretMessage() always returns the array shape either way.
function setNextGeminiResponse(objOrActions) {
  const payload = objOrActions && Array.isArray(objOrActions.actions) ? objOrActions : { actions: [objOrActions] };
  geminiResponseQueue.push({ text: JSON.stringify(payload) });
}
function setNextGeminiError(message) {
  geminiResponseQueue.push({ error: message });
}
function setNextGeminiTimeout() {
  geminiResponseQueue.push({ timeout: true });
}
// The exact prompt text index.js sent Gemini for the most recent AI-mention
// call - used to confirm the current (numbered) list was actually included,
// see the "includes list context" test below.
function getLastGeminiPromptText() {
  return lastGeminiCallArgs && lastGeminiCallArgs.contents;
}

// qrcode-terminal just prints to the console during a real QR login; no
// need to fake it, it's never invoked since our fake connection.update
// flow never emits a qr.

require('../index'); // runs start() -> captures the 'messages.upsert' handler
const ai = require('../ai'); // same DATA_DIR as index.js, so toggling here is visible to it
const welcome = require('../welcome'); // same DATA_DIR as index.js, so toggling here is visible to it
const store = require('../store'); // same DATA_DIR as index.js, so seeding regularPlayers here is visible to it
// Same module-cache instance index.js itself dispatches through - mutating
// a handler on these objects (see the "unexpected error" tests below) is
// visible to index.js's real handleMessage()/handleAiMention(), since both
// just read `commands[rawCmd]`/`rawCommands[...]` off this shared object at
// call time rather than holding their own destructured copy.
const { commands, rawCommands } = require('../commands');
const { COMMAND_PREFIX } = require('../lib/config');
const { formatList } = require('../lib/helpers');

let fakeMsgCounter = 0;
function makeMsg({ from, text, fromMe = false, mentions, quotedParticipant, quotedMessageText, messageTimestamp }) {
  fakeMsgCounter += 1;
  const contextInfo = {};
  if (mentions && mentions.length) contextInfo.mentionedJid = mentions;
  if (quotedParticipant) contextInfo.participant = quotedParticipant;
  if (quotedMessageText) contextInfo.quotedMessage = { conversation: quotedMessageText };
  return {
    key: { remoteJid: GROUP_ID, participant: from, fromMe, id: `E2E${fakeMsgCounter}` },
    pushName: from ? from.split('@')[0] : undefined,
    message: Object.keys(contextInfo).length ? { extendedTextMessage: { text, contextInfo } } : { conversation: text },
    // Real Baileys messages always carry this (seconds since epoch, set
    // server-side) - defaults to "right now" so every existing test gets a
    // realistic, genuinely-live timestamp without having to think about it.
    // See effectiveUpsertType() (index.js) for the one thing this actually
    // affects: a 'notify' message old enough gets treated as 'append'.
    messageTimestamp: messageTimestamp != null ? messageTimestamp : Math.floor(Date.now() / 1000),
  };
}

async function deliver(text, { from = 'alex@s.whatsapp.net', type = 'notify', mentions, quotedParticipant, quotedMessageText, messageTimestamp } = {}) {
  const upsertHandler = capturedHandlers['messages.upsert'];
  assert.ok(upsertHandler, 'expected index.js to have registered a messages.upsert handler');
  const msg = makeMsg({ from, text, mentions, quotedParticipant, quotedMessageText, messageTimestamp });
  await upsertHandler({ messages: [msg], type });
  return msg; // so a test can build an edit (see deliverEdit below) against this exact message's key
}

// Simulates WhatsApp's "message.update" edit-notification event (see
// index.js's handleMessageEdit) for `originalMsg` (whatever deliver()
// returned for the message being edited) - same key.id, new text. Real
// Baileys sends the edit's own messageTimestamp too; defaults to "right
// now" for the same reason makeMsg's default does.
async function deliverEdit(originalMsg, newText, { messageTimestamp } = {}) {
  const updateHandler = capturedHandlers['messages.update'];
  assert.ok(updateHandler, 'expected index.js to have registered a messages.update handler');
  await updateHandler([
    {
      key: originalMsg.key,
      update: {
        message: { editedMessage: { message: { conversation: newText } } },
        messageTimestamp: messageTimestamp != null ? messageTimestamp : Math.floor(Date.now() / 1000),
      },
    },
  ]);
}

// Simulates Baileys' 'group-participants.update' event (see index.js's
// handleGroupParticipantsUpdate) - `jids` joined/left/were promoted/demoted
// together in ONE event, per real WhatsApp's own batching.
async function deliverGroupParticipantsUpdate(jids, { groupId = GROUP_ID, action = 'add' } = {}) {
  const handler = capturedHandlers['group-participants.update'];
  assert.ok(handler, 'expected index.js to have registered a group-participants.update handler');
  await handler({ id: groupId, author: jids[0], participants: jids, action });
}

test('e2e: a live !in command is processed and posts the updated list', async () => {
  fakeSockInstance.sentMessages.length = 0;
  await deliver('!in', { from: 'alex@s.whatsapp.net', type: 'notify' });
  // Bare !in uses the sender's pushName, which our fake derives as the
  // lowercase local part of the JID (see makeMsg above) - match case
  // -insensitively rather than assuming a particular capitalization.
  const posted = fakeSockInstance.sentMessages.find((m) => /alex/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the list (containing alex) to have been posted');
});

// --- Welcoming a new member: index.js's handleGroupParticipantsUpdate,
// triggered by Baileys' 'group-participants.update' event (see
// deliverGroupParticipantsUpdate above) - welcome.js's own doc comment
// covers the per-group ON-by-default toggle (!welcome). ---

test('e2e: someone joining the group gets a tagged welcome message with the current list', async () => {
  welcome.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  await deliverGroupParticipantsUpdate(['newperson@s.whatsapp.net']);

  const posted = fakeSockInstance.sentMessages.find((m) => /[Ww]elcome/.test(m.content.text || ''));
  assert.ok(posted, 'expected a welcome message to have been posted');
  assert.deepEqual(posted.content.mentions, ['newperson@s.whatsapp.net']);
  assert.match(posted.content.text, /newperson/);
  assert.ok(posted.content.text.includes(`${COMMAND_PREFIX}in`)); // mentions how to join
  assert.match(posted.content.text, /\*Attendance\*/); // includes the current list
});

test('e2e: multiple people joining together get ONE combined welcome message, not one each', async () => {
  welcome.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  await deliverGroupParticipantsUpdate(['newperson1@s.whatsapp.net', 'newperson2@s.whatsapp.net']);

  const welcomeMessages = fakeSockInstance.sentMessages.filter((m) => /[Ww]elcome/.test(m.content.text || ''));
  assert.equal(welcomeMessages.length, 1, 'expected exactly one combined welcome message');
  assert.deepEqual(welcomeMessages[0].content.mentions, ['newperson1@s.whatsapp.net', 'newperson2@s.whatsapp.net']);
  assert.match(welcomeMessages[0].content.text, /newperson1/);
  assert.match(welcomeMessages[0].content.text, /newperson2/);
});

test('e2e: the bot\'s own JID being added (it just joined the group) never welcomes itself', async () => {
  welcome.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  await deliverGroupParticipantsUpdate([BOT_JID]);

  const welcomeMessages = fakeSockInstance.sentMessages.filter((m) => /[Ww]elcome/.test(m.content.text || ''));
  assert.equal(welcomeMessages.length, 0, 'expected no welcome message for the bot\'s own JID');
});

test('e2e: the bot\'s own JID is filtered out of a mixed batch, leaving only the real newcomer welcomed', async () => {
  welcome.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  await deliverGroupParticipantsUpdate([BOT_JID, 'newperson3@s.whatsapp.net']);

  const welcomeMessages = fakeSockInstance.sentMessages.filter((m) => /[Ww]elcome/.test(m.content.text || ''));
  assert.equal(welcomeMessages.length, 1);
  assert.deepEqual(welcomeMessages[0].content.mentions, ['newperson3@s.whatsapp.net']);
});

test('e2e: !welcome off silences the join message entirely', async () => {
  welcome.setEnabled(GROUP_ID, false);
  fakeSockInstance.sentMessages.length = 0;

  try {
    await deliverGroupParticipantsUpdate(['newperson4@s.whatsapp.net']);
  } finally {
    welcome.setEnabled(GROUP_ID, true); // restore for tests after this one
  }

  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

test('e2e: a non-"add" action (someone leaving, or an admin promotion/demotion) never sends a welcome', async () => {
  welcome.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  await deliverGroupParticipantsUpdate(['leaving@s.whatsapp.net'], { action: 'remove' });
  await deliverGroupParticipantsUpdate(['promoted@s.whatsapp.net'], { action: 'promote' });

  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

test('e2e: a join in a group the bot is not configured to moderate is silently ignored', async () => {
  fakeSockInstance.sentMessages.length = 0;
  await deliverGroupParticipantsUpdate(['newperson5@s.whatsapp.net'], { groupId: 'someOtherUnconfiguredGroup@g.us' });
  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

// --- "typing..." presence while a live message is being processed ---
// index.js sets the chat's presence to 'composing' right before dispatching
// a live command/mention to a handler, and back to 'available' once that
// handler settles (success or failure) - see the setPresence() helper and
// its call sites in handleMessage().

test('e2e: a live typed command sets presence to composing then available, around the handler call', async () => {
  fakeSockInstance.presenceUpdates.length = 0;
  await deliver(`${COMMAND_PREFIX}help`, { from: 'alex@s.whatsapp.net', type: 'notify' });
  assert.deepEqual(fakeSockInstance.presenceUpdates, [
    { type: 'composing', jid: GROUP_ID },
    { type: 'available', jid: GROUP_ID },
  ]);
});

test('e2e: a catch-up (append) command does not touch presence at all', async () => {
  fakeSockInstance.presenceUpdates.length = 0;
  await deliver(`${COMMAND_PREFIX}in`, { from: 'alex@s.whatsapp.net', type: 'append' });
  assert.equal(fakeSockInstance.presenceUpdates.length, 0);
});

// --- Real observed bug: WhatsApp/Baileys occasionally redelivers (or
// relabels) an already-handled message as 'notify' well after the fact,
// making the bot fully "wake up" and respond - react, reply, repost the
// list - to something long since resolved, sometimes hours later. index.js's
// effectiveUpsertType() cross-checks 'notify' against the message's OWN
// messageTimestamp and downgrades it to 'append' (the same quiet,
// self-service-only handling a genuine offline-backlog redelivery already
// gets) once it's older than LIVE_MESSAGE_MAX_AGE_MS - see that constant's
// doc comment in lib/config.js. ---

test('e2e: a "notify" message far older than LIVE_MESSAGE_MAX_AGE_MS is treated as a quiet catch-up, not a live response', async () => {
  fakeSockInstance.presenceUpdates.length = 0;
  fakeSockInstance.reactions.length = 0;
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
  await deliver(`${COMMAND_PREFIX}in`, { from: 'alex@s.whatsapp.net', type: 'notify', messageTimestamp: twoHoursAgo });
  // Same assertions as the genuine 'append' test above - no live-only
  // side effects (reactions, presence) fired for this message.
  assert.equal(fakeSockInstance.presenceUpdates.length, 0);
  assert.equal(fakeSockInstance.reactions.length, 0);
});

test('e2e: a "notify" message within LIVE_MESSAGE_MAX_AGE_MS is still treated as genuinely live', async () => {
  fakeSockInstance.presenceUpdates.length = 0;
  const justNow = Math.floor(Date.now() / 1000) - 1;
  await deliver(`${COMMAND_PREFIX}in`, { from: 'alex@s.whatsapp.net', type: 'notify', messageTimestamp: justNow });
  assert.deepEqual(fakeSockInstance.presenceUpdates, [
    { type: 'composing', jid: GROUP_ID },
    { type: 'available', jid: GROUP_ID },
  ]);
});

test('e2e: a typed command whose handler throws still resets presence back to available', async () => {
  const key = `${COMMAND_PREFIX}help`;
  const original = commands[key];
  commands[key] = async () => {
    throw new Error('simulated handler crash');
  };
  fakeSockInstance.presenceUpdates.length = 0;

  try {
    await deliver(key, { from: 'admin@s.whatsapp.net', type: 'notify' });
  } finally {
    commands[key] = original;
  }

  assert.deepEqual(fakeSockInstance.presenceUpdates, [
    { type: 'composing', jid: GROUP_ID },
    { type: 'available', jid: GROUP_ID },
  ]);
});

test('e2e: an AI-dispatched @-mention sets presence to composing then available too', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'list', argText: '', confidence: 'high' });
  fakeSockInstance.presenceUpdates.length = 0;
  await deliver('show me the list', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });
  assert.deepEqual(fakeSockInstance.presenceUpdates, [
    { type: 'composing', jid: GROUP_ID },
    { type: 'available', jid: GROUP_ID },
  ]);
});

// --- Unexpected errors get a visible reply, not silence ---
// Regression coverage for a real gap: a handler throwing used to be caught
// only by the outermost try/catch around handleMessage() in index.js's
// messages.upsert listener, which just logs server-side - the sender got no
// reply at all, indistinguishable from the bot having ignored them. See
// UNEXPECTED_ERROR_REPLY/the try/catch around both dispatch points in
// index.js.

test('e2e: a typed command whose handler throws replies with an unexpected-error message instead of staying silent', async () => {
  const key = `${COMMAND_PREFIX}help`;
  const original = commands[key];
  commands[key] = async () => {
    throw new Error('simulated handler crash');
  };
  fakeSockInstance.sentMessages.length = 0;
  fakeSockInstance.reactions.length = 0;

  try {
    await deliver(key, { from: 'admin@s.whatsapp.net', type: 'notify' });
  } finally {
    commands[key] = original;
  }

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /something went wrong/i);
  // ❌, not the usual ✅ - a thrown error means the command did NOT
  // actually complete (see index.js's catch block around this dispatch).
  assert.deepEqual(fakeSockInstance.reactions.map((r) => r.emoji), ['💬', '❌']);
});

test('e2e: a typed command that succeeds reacts with ✅, not ❌', async () => {
  fakeSockInstance.reactions.length = 0;
  await deliver(`${COMMAND_PREFIX}help`, { from: 'admin@s.whatsapp.net', type: 'notify' });
  assert.deepEqual(fakeSockInstance.reactions.map((r) => r.emoji), ['💬', '✅']);
});

test('e2e: a catch-up (append) command whose handler throws stays quiet, same as it does on success', async () => {
  const key = `${COMMAND_PREFIX}in`;
  const original = commands[key];
  commands[key] = async () => {
    throw new Error('simulated handler crash');
  };
  fakeSockInstance.sentMessages.length = 0;

  try {
    await deliver(key, { from: 'alex@s.whatsapp.net', type: 'append' });
  } finally {
    commands[key] = original;
  }

  assert.equal(fakeSockInstance.sentMessages.length, 0, 'expected no error reply for a delayed catch-up redelivery');
});

test('e2e: an AI-dispatched action whose handler throws replies with an unexpected-error message instead of staying silent', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'list', argText: '', confidence: 'high' });
  const key = `${COMMAND_PREFIX}list`;
  const original = rawCommands[key];
  rawCommands[key] = async () => {
    throw new Error('simulated handler crash');
  };
  fakeSockInstance.sentMessages.length = 0;
  fakeSockInstance.reactions.length = 0;

  try {
    await deliver('show me the list', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });
  } finally {
    rawCommands[key] = original;
  }

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /something went wrong/i);
  // ❌, not ✅ - same "don't lie about what just happened" reasoning as the
  // typed-command path (see index.js's `errored` tracking for AI mentions).
  assert.deepEqual(fakeSockInstance.reactions.map((r) => r.emoji), ['💬', '❌']);
});

test('e2e: a bare @-mention whose handler throws reacts with ❌, not ✅', async () => {
  ai.setEnabled(GROUP_ID, false);
  const key = `${COMMAND_PREFIX}in`;
  const original = commands[key];
  commands[key] = async () => {
    throw new Error('simulated handler crash');
  };
  fakeSockInstance.reactions.length = 0;

  try {
    await deliver('@bot', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });
  } finally {
    commands[key] = original;
  }

  assert.deepEqual(fakeSockInstance.reactions.map((r) => r.emoji), ['💬', '❌']);
});

// --- Bare @-mention ("just tag me") is a quick sign-up shortcut ----------
// @-mentioning the bot with no other text attached is treated the same as
// typing bare !in - dispatched straight to the real handler, no Gemini call
// involved (there's nothing to interpret) and independent of !ai, so it
// works even in a group that's never turned natural-language commands on.
// See index.js's `bareMention` check.

test('e2e: a bare @-mention with no other text signs the sender up, same as bare !in, without calling Gemini - and works even with !ai off', async () => {
  ai.setEnabled(GROUP_ID, false); // deliberately off - this shortcut shouldn't need it
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('@bot', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(geminiCallCount, callsBefore, 'a bare mention has nothing to interpret - Gemini should never be called');
  const posted = fakeSockInstance.sentMessages.find((m) => /jordan/i.test(m.content.text || ''));
  assert.ok(posted, 'expected jordan to have been added and the list posted, same as a real bare !in would');
});

test('e2e: a bare @-mention still skips Gemini even with !ai turned ON - the bare-mention shortcut is checked before natural-language interpretation', async () => {
  ai.setEnabled(GROUP_ID, true);
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('@bot', { from: 'sam@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(geminiCallCount, callsBefore, 'still should not call Gemini even with !ai on');
  const posted = fakeSockInstance.sentMessages.find((m) => /sam/i.test(m.content.text || ''));
  assert.ok(posted, 'expected sam to have been added and the list posted');
});

test('e2e: a bare @-mention arriving as a catch-up (append) redelivery is dropped, same as any other catch-up mention', async () => {
  ai.setEnabled(GROUP_ID, false);
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('@bot', { from: 'jordan@s.whatsapp.net', type: 'append', mentions: [BOT_JID] });

  assert.equal(geminiCallCount, callsBefore);
  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

// --- Natural-language command interpretation (lib/geminiCommand.js) ---
// Exercises the real messageMentionsBot()/handleAiMention() wiring in
// index.js end-to-end - real mention detection against the fake sock's
// user.id, real ai.js on/off gating, real dispatch into commands/list.js
// on a confident interpretation - with only the Gemini API call itself
// faked (see setNextGeminiResponse/setNextGeminiError above).

test('e2e: AI mention with high confidence dispatches straight to the real command handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down for Saturday', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /jordan/i.test(m.content.text || ''));
  assert.ok(posted, 'expected jordan to have been added and the list posted, same as a real !in would');
});

test('e2e: AI mention still triggers when WhatsApp sends the bot\'s LID (not its phone-number JID) as the mentionedJid - regression for the LID-addressing bug', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  // mentions BOT_LID, NOT BOT_JID - some groups/senders address the bot by
  // its @lid form instead of its classic @s.whatsapp.net form for the
  // exact same underlying account. messageMentionsBot() must recognize
  // this via sock.user.lid, or the mention silently never triggers.
  await deliver('put me down for Saturday', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_LID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /jordan/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the LID-form mention to still be recognized as mentioning the bot');
});

test('e2e: replying to one of the bot\'s own messages (no "@Snoopy" typed at all) triggers AI interpretation, same as an explicit @-mention', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  // No `mentions` at all here - just `quotedParticipant: BOT_JID`, exactly
  // what WhatsApp sends when someone taps "Reply" on a message the bot
  // sent and types a plain follow-up with no "@" anywhere in it.
  await deliver('put me down for Saturday', { from: 'jordan@s.whatsapp.net', type: 'notify', quotedParticipant: BOT_JID });

  const posted = fakeSockInstance.sentMessages.find((m) => /jordan/i.test(m.content.text || ''));
  assert.ok(posted, 'expected a reply to the bot\'s own message to be recognized as addressing the bot');
});

test('e2e: replying to the bot still triggers when WhatsApp sends its LID (not its phone-number JID) as the quoted participant', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down for Saturday', { from: 'jordan@s.whatsapp.net', type: 'notify', quotedParticipant: BOT_LID });

  const posted = fakeSockInstance.sentMessages.find((m) => /jordan/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the LID-form quoted participant to still be recognized as a reply to the bot');
});

test('e2e: typing "@Snoopy" as literal text (not a real, JID-based mention) still triggers AI interpretation - regression for a real bug where the contact picker wasn\'t used', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  // Deliberately no `mentions` at all - a real mention's raw text is always
  // "@<phone number>", never "@Snoopy" itself, so this can only be
  // reproduced by omitting `mentions` and just typing the name.
  await deliver('@Snoopy put me down for Saturday', { from: 'morgan@s.whatsapp.net', type: 'notify' });

  const posted = fakeSockInstance.sentMessages.find((m) => /morgan/i.test(m.content.text || ''));
  assert.ok(posted, 'expected a literal "@Snoopy" (no real mention) to still be recognized as addressing the bot');
});

test('e2e: a literal "@Snoopy" is stripped out of the text sent to Gemini, same as a real mention token would be', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'high' });

  await deliver('@Snoopy put me down for Saturday', { from: 'reese@s.whatsapp.net', type: 'notify' });

  // SYSTEM_PROMPT itself talks about "Snoopy" (the bot's own persona name)
  // throughout, so a blanket /snoopy/i check against the whole prompt would
  // pass regardless of stripping - isolate just the `Message: "..."`
  // section buildPrompt() appends at the end instead.
  const promptText = getLastGeminiPromptText();
  const messageSection = promptText.match(/Message: "([^]*)"$/)[1];
  assert.ok(!/snoopy/i.test(messageSection), 'expected the literal "@Snoopy" text to be stripped out of the message section before reaching Gemini');
  assert.ok(messageSection.includes('put me down for Saturday'), 'expected the rest of the message to reach Gemini untouched');
});

test('e2e: a bare "@Snoopy" with nothing else signs the sender up, same as a bare real @-mention, without calling Gemini', async () => {
  ai.setEnabled(GROUP_ID, false); // deliberately off - this shortcut shouldn't need it
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('@Snoopy', { from: 'harper@s.whatsapp.net', type: 'notify' });

  assert.equal(geminiCallCount, callsBefore, 'a bare "@Snoopy" has nothing left to interpret once stripped - Gemini should never be called');
  const posted = fakeSockInstance.sentMessages.find((m) => /harper/i.test(m.content.text || ''));
  assert.ok(posted, 'expected harper to have been added and the list posted, same as a real bare @-mention would');
});

test('e2e: replying to someone OTHER than the bot does not trigger AI interpretation (Gemini never even called)', async () => {
  ai.setEnabled(GROUP_ID, true);
  // Deliberately does NOT queue a fake Gemini response - Gemini must never
  // be called at all here, and queuing one anyway would leave it stranded
  // in geminiResponseQueue (never shifted off), silently misattributed to
  // whichever LATER test calls interpretMessage next. Assert on
  // geminiCallCount instead, same pattern as the "!ai off" test above.
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  // Quotes a real group member (alex), not the bot - must be treated as
  // ordinary chat, never as though the bot itself were addressed.
  await deliver('put me down for Saturday', { from: 'jordan@s.whatsapp.net', type: 'notify', quotedParticipant: 'alex@s.whatsapp.net' });

  assert.equal(geminiCallCount, callsBefore, 'Gemini should never be called for a reply to someone other than the bot');
  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

test('e2e: "@bot add me and 2 friends" (mapped to argText "me, +2") adds the sender plus 2 guest entries via the real handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: 'me, +2', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('add me and 2 friends', { from: 'casey@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /casey\+2/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to show casey, casey+1, and casey+2');
});

test('e2e: "@bot add 2 friends" (mapped to argText "+2", no "me") adds ONLY 2 guest entries, WITHOUT the sender', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '+2', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  // A sender not used anywhere else in this file - this suite shares ONE
  // running list/GROUP_ID across tests (see GROUP_ID above), so reusing
  // "casey" here would collide with that other test's leftover "casey,
  // casey+1, casey+2" entries and make this assertion meaningless.
  await deliver('add 2 friends', { from: 'wesley@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /wesley\+2/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to show wesley+1 and wesley+2');
  assert.ok(!/\bwesley\b(?!\+)/i.test(posted.content.text), 'the sender "wesley" alone should NOT be on the list');
});

test('e2e: the prompt sent to Gemini includes the current (numbered) list, so position references like "remove 1-3" can be resolved', async () => {
  ai.setEnabled(GROUP_ID, true);
  // A known name onto the attendance list first, via a normal typed
  // command, so we have something distinctive to look for in the prompt.
  await deliver('!in ListContextProbe', { from: 'alex@s.whatsapp.net', type: 'notify' });

  setNextGeminiResponse({ command: 'none', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('what happened', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const promptText = getLastGeminiPromptText();
  assert.ok(promptText, 'expected a prompt to have been sent to Gemini');
  assert.match(promptText, /ListContextProbe/, 'expected the current Attendance list (with the just-added name) to be included in the prompt');
});

test('e2e: AI mention with low confidence replies "I don\'t understand" instead of guessing or acting', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'out', argText: 'Nobody', confidence: 'low' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('maybe take someone off?', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /not capable of doing that/i);
  // No guessed !command shown, and !out was NOT actually run against "Nobody".
  assert.doesNotMatch(fakeSockInstance.sentMessages[0].content.text, /!out/);
});

test('e2e: AI mention that is not list-related (command: none) still gets an "I don\'t understand" reply, not silence', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'none', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('haha good one', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /not capable of doing that/i);
});

test('e2e: an off-topic AI mention (command: none) with an "offTopicReply" from the model gets that reply plus the fixed "join the social" reminder, instead of the generic "not capable" fallback', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    command: 'none',
    argText: '',
    confidence: 'high',
    offTopicReply: 'Layer bread, filling, and condiments - simple as that!',
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('how do I make a sandwich', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  const sent = fakeSockInstance.sentMessages[0].content.text;
  assert.match(sent, /Layer bread, filling, and condiments - simple as that!/);
  assert.match(sent, /running the signup list/i);
  assert.match(sent, /join the social/i);
  assert.doesNotMatch(sent, /not capable of doing that/i);
});

test('e2e: a compound @-mention with a real dispatchable action plus an off-topic aside dispatches the real one AND separately replies to the off-topic part', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    actions: [
      { command: 'in', argText: '', confidence: 'high' },
      { command: 'none', argText: '', confidence: 'high', offTopicReply: 'Layer bread, filling, and condiments - simple as that!' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('how do I make a sandwich, also sign me up', {
    from: 'e2eoffTopicComboProbe@s.whatsapp.net', type: 'notify', mentions: [BOT_JID],
  });

  const posted = fakeSockInstance.sentMessages.find((m) => /e2eoffTopicComboProbe/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the real "in" action to have dispatched and posted the updated list');
  const offTopic = fakeSockInstance.sentMessages.find((m) => /Layer bread, filling, and condiments/.test(m.content.text || ''));
  assert.ok(offTopic, 'expected a separate reply addressing the off-topic sandwich question');
  assert.match(offTopic.content.text, /join the social/i);
});

// Real bug report: "@Snoopy I paid and me to social only" from someone who
// owed payment from a PAST cycle but wasn't on the CURRENT attendance list
// at all (under any name) - the model (correctly, per lib/geminiCommand.js's
// "out" SPECIAL CASE) maps the bare self "social only" half to "out"
// "tournament", the one dispatch that also works when the sender genuinely
// IS still in the tournament - but commands/list.js's handleLeaveTournament
// used to just reject with "you're not even on the list" when there was no
// existing entry, instead of ending up social-only like the sender asked.
test('e2e: "I paid and me to social only" from someone not on the current list at all marks them paid AND adds them fresh, social only', async () => {
  ai.setEnabled(GROUP_ID, true);
  store.setTournamentEnabled(GROUP_ID, true);
  // Removes the cap first - GROUP_ID accumulates entries across this whole
  // file's other tests, and a capped limit would silently waitlist this
  // seed instead of landing it in `entries` (newList only archives
  // `entries` into duePayments, never the waitlist - see store.js's own
  // newList()), breaking the sanity checks just below for a reason
  // completely unrelated to what this test actually covers.
  store.setLimit(GROUP_ID, null);
  store.addEntry(GROUP_ID, 'weellie', 'weellieProbe@s.whatsapp.net', false, true); // self-added, owes payment
  store.newList(GROUP_ID, '2026-08-23', {}); // archives into duePayments; entries reset - weellie is on NEITHER now
  assert.ok(store.getCurrentEvent(GROUP_ID).duePayments.some((e) => e.name === 'weellie'));
  assert.ok(!store.getCurrentEvent(GROUP_ID).entries.some((e) => e.name === 'weellie'));

  setNextGeminiResponse({
    actions: [
      { command: 'paid', argText: '', confidence: 'high' },
      { command: 'out', argText: 'tournament', confidence: 'high' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('I paid and me to social only', { from: 'weellieProbe@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.ok(!store.getCurrentEvent(GROUP_ID).duePayments.some((e) => e.name === 'weellie'), 'expected weellie to be marked paid');
  // The fresh add uses the sender's CURRENT push name ("weellieProbe", from
  // the message's own from JID - see makeMsg), not the old list name
  // ("weellie") the payment side matched by WhatsApp ID instead - same
  // "a brand new add always uses today's push name" behavior as a normal
  // bare "!in" from someone whose display name has changed since.
  const entry = store.getCurrentEvent(GROUP_ID).entries.find((e) => e.name === 'weellieProbe');
  assert.ok(entry, 'expected the sender to have been added to the current list, social only');
  assert.equal(entry.tournament, false);
  assert.ok(
    !fakeSockInstance.sentMessages.some((m) => /not even on the list/.test(m.content.text || '')),
    'expected no dead-end "not even on the list" rejection'
  );
});

test('e2e: a fully-low-confidence AI mention with a "question" from the model asks that question and tells the sender to reply, instead of the generic "not capable" fallback', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    command: 'out',
    argText: 'Megan',
    confidence: 'low',
    question: 'Did you mean to remove Megan from the payment list, or take her off the attendance list?',
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('Megan paid Megan in', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  const sent = fakeSockInstance.sentMessages[0];
  assert.match(sent.content.text, /Did you mean to remove Megan from the payment list, or take her off the attendance list\?/);
  assert.match(sent.content.text, /reply to this message/i);
  assert.doesNotMatch(sent.content.text, /not capable of doing that/i);
  // Same "quote the triggering message" mechanism every AI-mention reply
  // already uses - this is what lets a plain WhatsApp reply to it be
  // treated as a continuation (see messageMentionsBot() in index.js).
  assert.ok(sent.options && sent.options.quoted, 'expected the clarifying question to be sent as a quote-reply');
  assert.equal(sent.options.quoted.message.extendedTextMessage.text, 'Megan paid Megan in');
});

test('e2e: replying to the bot\'s own clarifying question includes it as REPLY CONTEXT in the follow-up prompt sent to Gemini', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    command: 'out',
    argText: 'Megan',
    confidence: 'low',
    question: 'Did you mean to remove Megan from the payment list, or take her off the attendance list?',
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('Megan paid Megan in', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });
  const clarifyingText = fakeSockInstance.sentMessages[0].content.text;

  setNextGeminiResponse({ command: 'update', argText: 'remove Megan from the payment list', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  // A plain WhatsApp reply to the bot's own message - no fresh @-mention
  // needed, same as any other reply-to-bot exchange (see
  // messageMentionsBot() in index.js).
  await deliver('the payment list one', {
    from: 'jordan@s.whatsapp.net',
    type: 'notify',
    quotedParticipant: BOT_JID,
    quotedMessageText: clarifyingText,
  });

  const promptText = getLastGeminiPromptText();
  assert.match(promptText, /^REPLY CONTEXT:/m, 'expected an injected REPLY CONTEXT section on the follow-up prompt');
  assert.match(promptText, /Did you mean to remove Megan from the payment list/, 'expected the bot\'s own prior question to be quoted back into the prompt');
});

// --- Admin commands via AI mention (lib/geminiCommand.js's MAPPABLE_COMMANDS
// now includes !clear/!limit/etc, not just the everyday commands) ---

test('e2e: an admin @-mentioning an admin action (e.g. "clear the list") dispatches straight to the real admin handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  // admin@s.whatsapp.net is in the fake sock's admin set (see buildFakeSock).
  setNextGeminiResponse({ command: 'clear', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('clear the attendance list please', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  // handleClear() posts the (now-empty) list with no separate "cleared!"
  // confirmation - same success shape as a typed !clear. Just confirm it
  // did NOT get refused for lacking admin rights.
  const refused = fakeSockInstance.sentMessages.some((m) => /only a group admin can clear/i.test(m.content.text || ''));
  assert.equal(refused, false, 'expected the admin sender to be allowed to clear the list');
});

test('e2e: a non-admin @-mentioning an admin action gets refused by the real handler, exactly like typing !clear themselves would', async () => {
  ai.setEnabled(GROUP_ID, true);
  // jordan@s.whatsapp.net is NOT in the fake sock's admin set.
  setNextGeminiResponse({ command: 'clear', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('clear the attendance list please', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /only a group admin can clear the list/i);
});

test('e2e: an admin action with a real argument (e.g. "limit") passes argText through to the real handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'limit', argText: '20', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('cap the list at 20 people', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /20/.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to reflect the new limit of 20');
});

test('e2e: an admin @-mentioning "create a new list ... with <names>" dispatches to the real handler, which both starts the list and signs everyone up', async () => {
  ai.setEnabled(GROUP_ID, true);
  // The model is the one that would resolve "next Wednesday" into an
  // actual DD/MM (see the todayLabel test below for that half) - here we
  // stub its output directly and confirm index.js/commands/admin.js
  // dispatch it correctly, same as every other admin-command e2e test in
  // this file.
  setNextGeminiResponse({ command: 'newlist', argText: '19/08 with Alice, Bob, Carla', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('create a new list for next Wednesday with Alice, Bob, and Carla', {
    from: 'admin@s.whatsapp.net',
    type: 'notify',
    mentions: [BOT_JID],
  });

  const posted = fakeSockInstance.sentMessages.find((m) => /Alice/.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to show the pre-populated names');
  assert.match(posted.content.text, /Bob/);
  assert.match(posted.content.text, /Carla/);
});

test('e2e: the prompt sent to Gemini includes today\'s date/weekday, so relative dates like "next Wednesday" can be resolved for !newlist/!date', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'none', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('what day is it', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const promptText = getLastGeminiPromptText();
  assert.match(promptText, /Today is \w+ \d{2}\/\d{2}/, 'expected a "Today is <weekday> DD/MM" reference in the prompt sent to the model');
});

test('e2e: the prompt sent to Gemini includes the saved regular-players roster, so "add the regular players" can be told apart from redefining it', async () => {
  ai.setEnabled(GROUP_ID, true);
  store.setRegularPlayers(GROUP_ID, ['RegularPlayersProbe1', 'RegularPlayersProbe2']);
  setNextGeminiResponse({ command: 'none', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('what day is it', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const promptText = getLastGeminiPromptText();
  assert.match(promptText, /REGULAR PLAYERS: RegularPlayersProbe1, RegularPlayersProbe2/, 'expected the saved roster to appear in the prompt sent to the model');
});

test('e2e: an admin @-mentioning "add the regular players" dispatches to the real !in handler, which signs up the saved roster', async () => {
  ai.setEnabled(GROUP_ID, true);
  store.setRegularPlayers(GROUP_ID, ['RosterPlayerA', 'RosterPlayerB']);
  setNextGeminiResponse({ command: 'in', argText: 'regular players', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('add the regular players please', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /RosterPlayerA/.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to show the saved roster');
  assert.match(posted.content.text, /RosterPlayerB/);
});

test('e2e: an admin @-mentioning "these are the regular players: ..." dispatches to the real !regulars handler, saving the roster for later', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'regulars', argText: 'DeclaredPlayerA, DeclaredPlayerB', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('these people are regular players: DeclaredPlayerA, DeclaredPlayerB', {
    from: 'admin@s.whatsapp.net',
    type: 'notify',
    mentions: [BOT_JID],
  });

  assert.deepEqual(store.getRegularPlayers(GROUP_ID), ['DeclaredPlayerA', 'DeclaredPlayerB']);
});

test('e2e: a non-admin @-mentioning "these are the regular players: ..." is refused, exactly like typing !regulars themselves would', async () => {
  ai.setEnabled(GROUP_ID, true);
  store.setRegularPlayers(GROUP_ID, ['UnchangedPlayer']);
  setNextGeminiResponse({ command: 'regulars', argText: 'SomeoneElse', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('these people are regular players: SomeoneElse', {
    from: 'jordan@s.whatsapp.net',
    type: 'notify',
    mentions: [BOT_JID],
  });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /only a group admin/i);
  assert.deepEqual(store.getRegularPlayers(GROUP_ID), ['UnchangedPlayer']);
});

test('e2e: an admin @-mentioning "regulars are X, Y, Z. Exempt them from paying." dispatches BOTH the real !regulars and !exempt handlers, resolving "them" back to the same names', async () => {
  ai.setEnabled(GROUP_ID, true);
  store.setRegularPlayers(GROUP_ID, []);
  store.setPaymentExempt(GROUP_ID, []);
  setNextGeminiResponse({
    actions: [
      { command: 'regulars', argText: 'E2eExemptKeith, E2eExemptTu, E2eExemptBao', confidence: 'high' },
      { command: 'exempt', argText: 'E2eExemptKeith, E2eExemptTu, E2eExemptBao', confidence: 'high' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('regulars are E2eExemptKeith, E2eExemptTu and E2eExemptBao. Exempt them from paying.', {
    from: 'admin@s.whatsapp.net',
    type: 'notify',
    mentions: [BOT_JID],
  });

  assert.deepEqual(store.getRegularPlayers(GROUP_ID), ['E2eExemptKeith', 'E2eExemptTu', 'E2eExemptBao']);
  assert.deepEqual(store.getPaymentExempt(GROUP_ID), ['E2eExemptKeith', 'E2eExemptTu', 'E2eExemptBao']);
});

// --- !undo (store.js's before/after snapshot mechanism, wired in via
// commands/index.js's dispatch wrapper - see its withUndoTracking() doc
// comment) ---

test('e2e: an admin @-mentioning "undo that" after a typed !clear reverses it via the real dispatch table', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!in UndoProbeJordan', { from: 'jordan@s.whatsapp.net', type: 'notify' });
  await deliver('!clear', { from: 'admin@s.whatsapp.net', type: 'notify' });
  assert.ok(
    !fakeSockInstance.sentMessages.slice(-1)[0].content.text.includes('UndoProbeJordan'),
    'expected the list to be empty right after !clear'
  );

  setNextGeminiResponse({ command: 'undo', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('undo that, that was a mistake', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const undidReply = fakeSockInstance.sentMessages.find((m) => /Undid: !clear/.test(m.content.text || ''));
  assert.ok(undidReply, 'expected an "Undid: !clear" confirmation reply');
  const posted = fakeSockInstance.sentMessages.find((m) => /UndoProbeJordan/.test(m.content.text || ''));
  assert.ok(posted, 'expected the reposted list to show the un-cleared entry');
});

test('e2e: a non-admin @-mentioning "undo that" is refused, exactly like typing !undo themselves would', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!in UndoRefuseProbe', { from: 'jordan@s.whatsapp.net', type: 'notify' });

  setNextGeminiResponse({ command: 'undo', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('undo that', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /only a group admin/i);
});

// --- Every command is mappable via AI mention, including !update/!help/
// !admin (lib/geminiCommand.js's MAPPABLE_COMMANDS has no exceptions) ---

test('e2e: an admin @-mentioning a message that itself contains a pasted list dispatches to the real !update handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!in Grace', { from: 'alex@s.whatsapp.net', type: 'notify' });

  const pastedEdit = 'here\'s the updated list:\n*Attendance*\n\n1. Grace\n2. AiUpdateProbe';
  setNextGeminiResponse({ command: 'update', argText: pastedEdit, confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver(pastedEdit, { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find(
    (m) => /\*Attendance\*/.test(m.content.text || '') && /AiUpdateProbe/.test(m.content.text || '')
  );
  assert.ok(posted, 'expected the updated list (with the new name from the pasted text) to have been reposted');
});

test('e2e: a non-admin @-mentioning a pasted list is refused, exactly like typing !update themselves would', async () => {
  ai.setEnabled(GROUP_ID, true);
  const pastedEdit = '*Attendance*\n\n1. AiUpdateRefuseProbe';
  setNextGeminiResponse({ command: 'update', argText: pastedEdit, confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver(pastedEdit, { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /only a group admin can bulk-update/i);
});

test('e2e: an admin @-mentioning a tournament-formatted pasted list (🏆 Tournament players / Social only) correctly reconciles tournament membership via the real !update handler - regression for a real bug where this silently did nothing', async () => {
  ai.setEnabled(GROUP_ID, true);
  store.setTournamentEnabled(GROUP_ID, true);
  store.setTournamentLimit(GROUP_ID, 2);
  await deliver('!in Derek', { from: 'keith@s.whatsapp.net', type: 'notify' });
  await deliver('!in Frank', { from: 'bao@s.whatsapp.net', type: 'notify' });
  await deliver('!in Isaac', { from: 'isaac@s.whatsapp.net', type: 'notify' });
  await deliver('!in tournament Derek, Frank', { from: 'admin@s.whatsapp.net', type: 'notify' }); // Isaac starts social-only

  const pastedEdit = [
    'update the list to be',
    '',
    '*Attendance* (3/6)',
    '',
    '🏆 *Tournament players* (2/2)',
    '',
    '1. Derek',
    '2. Isaac', // swapped in for Frank
    '',
    'Social only',
    '',
    '3. Frank',
  ].join('\n');
  setNextGeminiResponse({ command: 'update', argText: pastedEdit, confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver(pastedEdit, { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const summary = fakeSockInstance.sentMessages.find((m) => /Tournament:/.test(m.content.text || ''));
  assert.ok(summary, 'expected a "Tournament: ..." summary line, not "No changes found"');
  assert.match(summary.content.text, /Isaac \(social only → tournament\)/);
  assert.match(summary.content.text, /Frank \(tournament → social only\)/);

  const entries = store.getCurrentEvent(GROUP_ID).entries;
  assert.equal(entries.find((e) => e.name === 'Isaac').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Frank').tournament, false);
  assert.equal(entries.length, 3); // still all on the list - this only ever touches tournament placement
});

test('e2e: an "update" AI action uses the REAL original message, not whatever argText the model returned - regression for a real bug where the model\'s own copy lost the "*Attendance*" header in transit', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!in E2eUpdateFidelityProbe', { from: 'probe@s.whatsapp.net', type: 'notify' });

  // The REAL message the admin actually sent - a genuine, well-formed
  // pasted list that should parse and apply cleanly.
  const realPastedEdit = [
    'update the list to be',
    '',
    '*Attendance* (2/26)',
    '',
    '1. E2eUpdateFidelityProbe',
    '2. E2eUpdateFidelityAdded',
  ].join('\n');

  // What the "model" claims argText is - deliberately mangled (asterisks
  // stripped, as if it "cleaned up" the markdown on the way through) so
  // it has NO recognizable *Attendance*/*Waitlist* header at all. If the
  // bot trusted this, handleUpdate would refuse with "Couldn't find an
  // *Attendance*, *Waitlist*, or payment section in that".
  const mangledArgText = [
    'update the list to be',
    '',
    'Attendance (2/26)',
    '',
    '1. E2eUpdateFidelityProbe',
    '2. E2eUpdateFidelityAdded',
  ].join('\n');
  setNextGeminiResponse({ command: 'update', argText: mangledArgText, confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver(realPastedEdit, { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  // Proves the bot used the REAL message (which has the genuine
  // "*Attendance*" header), not the model's mangled copy - the new name
  // actually got added, and no "Couldn't find an *Attendance*..." refusal
  // ever showed up.
  const entries = store.getCurrentEvent(GROUP_ID).entries;
  assert.ok(entries.find((e) => e.name === 'E2eUpdateFidelityAdded'), 'expected the new name from the REAL pasted text to have been added');
  const combinedText = fakeSockInstance.sentMessages.map((m) => m.content.text || '').join('\n');
  assert.doesNotMatch(combinedText, /Couldn't find an \*Attendance\*/);
});

test('e2e: an admin @-mentioning a pasted list whose header block includes date/location/courts/time applies those changes too - regression for the exact reported scenario ("should change everything on the list such as date, location, time, courts")', async () => {
  ai.setEnabled(GROUP_ID, true);
  store.newList(GROUP_ID, '2026-08-09', { location: 'Old Park', time: '6pm-8pm' });
  await deliver('!in E2eHeaderProbe', { from: 'admin@s.whatsapp.net', type: 'notify' });

  const pastedEdit = [
    'update the list to be',
    '16th Aug Sun',
    'Noble Park',
    'Courts 11-14 (4)',
    '7pm-9pm',
    '',
    '*Attendance* (1/26)',
    '',
    '1. E2eHeaderProbe',
    '',
    'Should change everything on the list such as date, location, time, courts.',
  ].join('\n');
  setNextGeminiResponse({ command: 'update', argText: pastedEdit, confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver(pastedEdit, { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const event = store.getCurrentEvent(GROUP_ID);
  assert.match(event.date, /-08-16$/);
  assert.equal(event.location, 'Noble Park');
  assert.equal(event.courts, '11-14');
  assert.equal(event.courtCount, 4);
  assert.equal(event.time, '7pm-9pm');

  const summary = fakeSockInstance.sentMessages.find((m) => /Location: Old Park → Noble Park/.test(m.content.text || ''));
  assert.ok(summary, 'expected a header-field-change summary, not just the roster summary');
  assert.match(summary.content.text, /Courts: not set → 11-14/);
  assert.match(summary.content.text, /Time: 6pm-8pm → 7pm-9pm/);
});

test('e2e: a plain typed !update that only renames someone does NOT spuriously change the date, even once the list\'s date is in the past relative to today - regression for a real report ("even !update doesn\'t work, even when just renaming a person")', async () => {
  store.newList(GROUP_ID, '2020-01-01', { location: 'Old Park', courts: { raw: '1-2', count: 2 }, time: '7pm-9pm' });
  await deliver('!in Nathan b', { from: 'admin@s.whatsapp.net', type: 'notify' });

  const posted = formatList(GROUP_ID);
  const edited = posted.replace('Nathan b', 'Nathan Brown');
  fakeSockInstance.sentMessages.length = 0;

  await deliver(`!update ${edited}`, { from: 'admin@s.whatsapp.net', type: 'notify' });

  const summaryMsg = fakeSockInstance.sentMessages.find((m) => /Added: Nathan Brown/.test(m.content.text || ''));
  assert.ok(summaryMsg, 'expected the rename to be applied and summarized');
  assert.doesNotMatch(summaryMsg.content.text, /Date:/); // the actual bug: this used to always show up

  const event = store.getCurrentEvent(GROUP_ID);
  assert.equal(event.date, '2020-01-01'); // exact original year preserved, not bumped forward
  assert.ok(event.entries.find((e) => e.name === 'Nathan Brown'));
});

test('e2e: "@bot what can you do" dispatches to the real !help handler, for any sender, not just admins', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'help', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('what can you do', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, new RegExp(`${COMMAND_PREFIX}in`));
});

test('e2e: "@bot what admin commands are there" dispatches to the real !admin handler, refusing a non-admin exactly like typing !admin themselves would', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'admin', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('what admin commands are there', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /only a group admin can view the admin commands/i);
});

test('e2e: "@bot any tips" dispatches to the real !tips handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'tips', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('any tips for using this', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /\*Tips\*/);
});

test('e2e: "@bot any admin tips" dispatches to the real !admintips handler, refusing a non-admin exactly like typing !admintips themselves would', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'admintips', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('any admin tips', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /only a group admin can view the admin tips/i);
});

test('e2e: an admin @-mentioning "turn on auto-newlist" dispatches to the real !autonewlist handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'autonewlist', argText: 'on', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('turn on auto-newlist for this group', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /auto-newlist turned \*on\*/i);
});

test('e2e: an admin @-mentioning "make @Grace the court canceller" (bot mentioned too) sets it to the ACTUAL named person, not the bot itself - regression for the bot\'s own @-mention leaking into the mentioned-JID list', async () => {
  ai.setEnabled(GROUP_ID, true);
  const ALEX_JID = 'e2ecourtcancellerprobe@s.whatsapp.net';
  setNextGeminiResponse({ command: 'courtcanceller', argText: 'Grace', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  // The bot's own JID necessarily appears in mentions too (that's how AI
  // interpretation gets triggered at all) - order matters for the
  // regression this guards: the bot is mentioned FIRST, same as it would
  // be in a real "@Snoopy make @Grace the court canceller" message.
  await deliver('make @Grace the court canceller', {
    from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID, ALEX_JID],
  });

  const posted = fakeSockInstance.sentMessages.find((m) => /Court-cancellation reminder set to/.test(m.content.text || ''));
  assert.ok(posted, 'expected a confirmation that the court-canceller was set');
  assert.deepEqual(posted.content.mentions, [ALEX_JID]);
});

// --- Tournament sub-feature: !settournament/!tournament/!tournamentlimit/
// !tournamentwinners, and !in's "tournament" opt-in keyword ---

test('e2e: a typed !in tournament joins both the social list and the tournament, once an admin has turned it on', async () => {
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!in tournament', { from: 'e2etournamentprobe1@s.whatsapp.net', type: 'notify' });

  const posted = fakeSockInstance.sentMessages.find((m) => /🏆 \*Tournament\*/.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to include the tournament roster section');
  assert.match(posted.content.text, /e2etournamentprobe1/i);
});

test('e2e: an admin @-mentioning "sign me up for the tournament" dispatches to the real !in handler with the tournament keyword', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  setNextGeminiResponse({ command: 'in', argText: 'tournament', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('sign me up for the tournament', { from: 'e2etournamentprobe2@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /🏆 \*Tournament\*/.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to show the tournament section');
  assert.match(posted.content.text, /e2etournamentprobe2/i);
});

test('e2e: !tournamentwinners sets the "Congrats to ..." banner, which then shows above every posted list', async () => {
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  await deliver('!tournamentwinners E2eWinnerA, E2eWinnerB', { from: 'admin@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!list', { from: 'jordan@s.whatsapp.net', type: 'notify' });

  const posted = fakeSockInstance.sentMessages.find((m) => /Congrats to E2eWinnerA and E2eWinnerB/.test(m.content.text || ''));
  assert.ok(posted, 'expected the winners banner to appear above the posted list');
});

test('e2e: !newlist clears the previous cycle\'s tournament winners banner', async () => {
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  await deliver('!tournamentwinners E2eClearedWinnerA, E2eClearedWinnerB', { from: 'admin@s.whatsapp.net', type: 'notify' });
  await deliver('!newlist 25/08', { from: 'admin@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!list', { from: 'jordan@s.whatsapp.net', type: 'notify' });

  const posted = fakeSockInstance.sentMessages[0].content.text;
  assert.doesNotMatch(posted, /Congrats to/);
});

test('e2e: an admin @-mentioning "create a new list for tomorrow and the tournament winners are Alice and Ethan" runs !newlist FIRST, then !tournamentwinners - the winners land on the fresh list instead of being immediately cleared by it', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  setNextGeminiResponse({
    actions: [
      { command: 'newlist', argText: '25/08', confidence: 'high' },
      { command: 'tournamentwinners', argText: 'Alice, Ethan', confidence: 'high' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('create a new list for tomorrow and the tournament winners are Alice and Ethan', {
    from: 'admin@s.whatsapp.net',
    type: 'notify',
    mentions: [BOT_JID],
  });

  // If "tournamentwinners" had run BEFORE "newlist" (wrong order), newList()
  // would have immediately cleared it right back to null - this is a real
  // regression guard for that ordering bug, not just a "does the field get
  // set at all" check.
  assert.deepEqual(store.getTournamentWinners(GROUP_ID), ['Alice', 'Ethan']);
});

test('e2e: a non-admin typing !settournament on is refused, and the feature stays off', async () => {
  // Explicitly off first - earlier tests in this file may have already
  // turned it on for GROUP_ID (shared across this whole file, unlike
  // store.test.js/commands.test.js's per-test freshGroupId()).
  await deliver('!settournament off', { from: 'admin@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!settournament on', { from: 'jordan@s.whatsapp.net', type: 'notify' });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /only a group admin/i);
  assert.equal(store.isTournamentEnabled(GROUP_ID), false);
});

test('e2e: !settournament rules <text> sets the rules, and anyone can read them back with bare !tournament', async () => {
  await deliver('!settournament rules Best of 3, single elimination', { from: 'admin@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!tournament', { from: 'jordan@s.whatsapp.net', type: 'notify' });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /Best of 3, single elimination/);
});

// --- Compound @-mentions: a single message bundling multiple distinct
// requests together maps to MULTIPLE actions (see lib/geminiCommand.js's
// RESPONSE_SCHEMA/SYSTEM_PROMPT "MULTIPLE ACTIONS" and index.js's
// handleAiMention) - regression coverage for a real bug report where only
// the first part of a compound request (e.g. "create a new list ... the
// tournament limit is 12 ... add Derek, Ellen and Frank to the tournament") ever
// took effect, because the old single-action shape could only dispatch one
// of the three. ---

test('e2e: a compound @-mention (new list + tournament limit + add named people to the tournament) dispatches all three actions in order', async () => {
  ai.setEnabled(GROUP_ID, true);
  // Isolate from an earlier test's saved regulars roster on this shared
  // GROUP_ID - !newlist now always merges the roster into the tournament
  // (see commands/admin.js's handleNewlist), which would otherwise inflate
  // the tournament count/roster this test asserts on below.
  store.setRegularPlayers(GROUP_ID, []);
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  setNextGeminiResponse({
    actions: [
      { command: 'newlist', argText: '23/08 Noble Park | 1, 2 | 7pm-9pm', confidence: 'high' },
      { command: 'tournamentlimit', argText: '12', confidence: 'high' },
      { command: 'in', argText: 'tournament, E2eCompoundKeith, E2eCompoundTu, E2eCompoundBao', confidence: 'high' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver(
    'create a new list for next Sunday at Noble Park courts 1,2 at 7pm-9pm. The tournament limit is 12. Add E2eCompoundKeith, E2eCompoundTu and E2eCompoundBao to the tournament',
    { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] }
  );

  assert.equal(store.getTournamentLimit(GROUP_ID), 12);
  const entries = store.getCurrentEvent(GROUP_ID).entries;
  for (const name of ['E2eCompoundKeith', 'E2eCompoundTu', 'E2eCompoundBao']) {
    const entry = entries.find((e) => e.name === name);
    assert.ok(entry, `expected ${name} to be on the new list`);
    assert.equal(entry.tournament, true, `expected ${name} to be opted into the tournament`);
  }

  // All three actions succeeded quietly (no refusal/warning text from any
  // of them), so the group should see the FINAL state in exactly one
  // posted-list message - not three separate reposts, one per action, each
  // immediately made stale by the next action running right after it.
  assert.equal(fakeSockInstance.sentMessages.length, 1, 'expected exactly one posted-list message for the whole batch, not one per action');
  const posted = fakeSockInstance.sentMessages[0];
  assert.match(posted.content.text, /🏆 \*Tournament\* \(3\/12\)/);
  assert.match(posted.content.text, /E2eCompoundKeith/);
  assert.match(posted.content.text, /E2eCompoundTu/);
  assert.match(posted.content.text, /E2eCompoundBao/);
});

test('e2e: a compound @-mention where only SOME actions are confident dispatches just those, silently skipping the uncertain one', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  setNextGeminiResponse({
    actions: [
      { command: 'location', argText: 'E2eCompoundVenue', confidence: 'high' },
      { command: 'out', argText: 'Nobody In Particular', confidence: 'low' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('change the venue to E2eCompoundVenue, and also remove that one person, you know who', {
    from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID],
  });

  assert.equal(store.getCurrentEvent(GROUP_ID).location, 'E2eCompoundVenue');
  // The low-confidence "out" action never dispatched at all - no "not on
  // the list"/refusal reply for it, it's just silently skipped, same
  // "never guess out loud" treatment as a fully uncertain single mention.
  const combinedText = fakeSockInstance.sentMessages.map((m) => m.content.text || '').join('\n');
  assert.doesNotMatch(combinedText, /not capable of doing that/i);
});

test('e2e: a compound @-mention where one action is confident and the other is low-confidence WITH a question dispatches the real one AND separately asks the clarifying question', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    actions: [
      { command: 'location', argText: 'E2eCompoundVenue2', confidence: 'high' },
      {
        command: 'out',
        argText: 'Nobody In Particular',
        confidence: 'low',
        question: 'Who did you want removed from the list?',
      },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('change the venue to E2eCompoundVenue2, and also remove that one person, you know who', {
    from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID],
  });

  // The confident action still ran for real.
  assert.equal(store.getCurrentEvent(GROUP_ID).location, 'E2eCompoundVenue2');
  // ...and the uncertain one, instead of being silently dropped, gets its
  // own clarifying-question reply alongside the normal posted-list message.
  const clarifying = fakeSockInstance.sentMessages.find((m) => /Who did you want removed from the list\?/.test(m.content.text || ''));
  assert.ok(clarifying, 'expected a separate clarifying-question reply for the uncertain action');
  assert.match(clarifying.content.text, /reply to this message/i);
});

test('e2e: a compound @-mention where EVERY action is uncertain falls back to the plain "not capable" reply', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    actions: [
      { command: 'out', argText: 'Ambiguous Person', confidence: 'low' },
      { command: 'none', argText: '', confidence: 'high' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('do something vague', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /not capable of doing that/i);
});

test('e2e: !undo reverses an ENTIRE compound @-mention (new list + add names + payment label) in one step, not just the last action - regression for a real bug report where the batch saved one overwritten undo snapshot per action', async () => {
  ai.setEnabled(GROUP_ID, true);
  const before = store.getCurrentEvent(GROUP_ID);
  const beforeNames = [...before.entries, ...(before.waitlist || [])].map((e) => e.name);
  const beforeDate = before.date;
  const beforeLabel = before.duePaymentsLabel;

  setNextGeminiResponse({
    actions: [
      { command: 'newlist', argText: '27/08 E2eUndoBatchVenue with E2eUndoAndy, E2eUndoPeter, E2eUndoLucy', confidence: 'high' },
      { command: 'paymentlabel', argText: '$17 owing', confidence: 'high' },
    ],
  });

  await deliver(
    'create a new list for next Thursday at E2eUndoBatchVenue. Add E2eUndoAndy, E2eUndoPeter and E2eUndoLucy. Set the new payment cost to $17',
    { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] }
  );

  const afterBatch = store.getCurrentEvent(GROUP_ID);
  assert.notEqual(afterBatch.date, beforeDate, 'expected the new list to actually be created');
  assert.equal(afterBatch.duePaymentsLabel, '$17 owing');
  for (const name of ['E2eUndoAndy', 'E2eUndoPeter', 'E2eUndoLucy']) {
    assert.ok(afterBatch.entries.some((e) => e.name === name), `expected ${name} to be on the new list`);
  }

  await deliver('!undo', { from: 'admin@s.whatsapp.net', type: 'notify' });

  const afterUndo = store.getCurrentEvent(GROUP_ID);
  assert.equal(afterUndo.date, beforeDate, 'expected the whole batch - including !newlist - to be undone in one step');
  assert.equal(afterUndo.duePaymentsLabel, beforeLabel);
  const afterUndoNames = [...afterUndo.entries, ...(afterUndo.waitlist || [])].map((e) => e.name);
  assert.deepEqual(afterUndoNames, beforeNames, 'expected the added names to be gone too, not left behind from a partial undo');
});

// --- Editing a message: index.js's handleMessageEdit(), triggered by
// Baileys' 'messages.update' event (see deliverEdit() above) - undoes
// whatever the ORIGINAL processing of a message changed (if anything),
// then reprocesses the edited text as if it had just arrived live.
// Deliberately scoped to only the group's single most recent live message
// (lastLiveMessageByGroup in index.js) - see its own doc comment for why
// that matches store.js's own single-level (not per-message-history) undo
// mechanism. ---

test('e2e: editing your own last message undoes what it changed and processes the new text instead', async () => {
  const original = await deliver('!in', { from: 'ian@s.whatsapp.net', type: 'notify' });
  assert.ok(
    store.getCurrentEvent(GROUP_ID).entries.some((e) => e.name === 'ian'),
    'expected the original "!in" to have added ian'
  );

  // "!list" makes no change at all - so after the edit, ian's original add
  // should be undone, and nothing new added in its place.
  await deliverEdit(original, `${COMMAND_PREFIX}list`);

  assert.ok(
    !store.getCurrentEvent(GROUP_ID).entries.some((e) => e.name === 'ian'),
    'expected ian\'s original add to be undone once their message was edited'
  );
});

test('e2e: editing a message that originally changed nothing just processes the edited text - nothing to undo', async () => {
  const original = await deliver('asdkfjasldkfj not a real command', { from: 'kyra@s.whatsapp.net', type: 'notify' });
  assert.ok(
    !store.getCurrentEvent(GROUP_ID).entries.some((e) => e.name === 'kyra'),
    'expected the original gibberish message to have added nobody'
  );

  await deliverEdit(original, `${COMMAND_PREFIX}in`);

  assert.ok(
    store.getCurrentEvent(GROUP_ID).entries.some((e) => e.name === 'kyra'),
    'expected the edited-in "!in" to have added kyra'
  );
});

test('e2e: editing a message that is NO LONGER the group\'s most recent live message is ignored, with a diagnostic log line', async () => {
  const original = await deliver(`${COMMAND_PREFIX}in`, { from: 'lincoln@s.whatsapp.net', type: 'notify' });
  // A second, later message from someone else supersedes `original` as the
  // group's most recent live message.
  await deliver(`${COMMAND_PREFIX}in`, { from: 'nolan@s.whatsapp.net', type: 'notify' });

  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await deliverEdit(original, `${COMMAND_PREFIX}out`);
  } finally {
    console.log = originalLog;
  }

  const names = store.getCurrentEvent(GROUP_ID).entries.map((e) => e.name);
  assert.ok(names.includes('lincoln'), 'expected lincoln to still be on the list - the stale edit should be ignored');
  assert.ok(names.includes('nolan'), 'expected nolan (the newer message) to be unaffected');
  assert.ok(
    logged.some((line) => /Ignored an edit.*isn't the most recent/.test(line)),
    `expected a diagnostic log line about the ignored stale edit, got: ${JSON.stringify(logged)}`
  );
});

test('e2e: editing the SAME message twice correctly undoes the PREVIOUS edit each time, not just the original', async () => {
  const original = await deliver(`${COMMAND_PREFIX}in`, { from: 'omar@s.whatsapp.net', type: 'notify' });
  assert.deepEqual(
    store.getCurrentEvent(GROUP_ID).entries.filter((e) => e.addedBy === 'omar@s.whatsapp.net').map((e) => e.name),
    ['omar']
  );

  // First edit: bare "+2" adds 2 unnamed guests WITHOUT omar himself (see
  // PLUS_N_TOKEN/ME_TOKEN in lib/helpers.js) - the original bare "!in"
  // (which added omar) should be undone first.
  await deliverEdit(original, `${COMMAND_PREFIX}in +2`);
  assert.deepEqual(
    store.getCurrentEvent(GROUP_ID).entries.filter((e) => e.addedBy === 'omar@s.whatsapp.net').map((e) => e.name),
    ['omar+1', 'omar+2']
  );

  // Second edit of the SAME original message (WhatsApp edits always target
  // the original message's id) - should undo the first EDIT's effect
  // (omar+1/omar+2), not the long-gone original bare add.
  await deliverEdit(original, `${COMMAND_PREFIX}in me, +1`);
  assert.deepEqual(
    store.getCurrentEvent(GROUP_ID).entries.filter((e) => e.addedBy === 'omar@s.whatsapp.net').map((e) => e.name),
    ['omar', 'omar+1']
  );
});

test('e2e: editing into an admin-only command still gets refused for a non-admin, exactly like typing it fresh would - no privilege escalation via edit', async () => {
  const original = await deliver('just chatting', { from: 'patrick@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;
  const beforeDate = store.getCurrentEvent(GROUP_ID).date;

  await deliverEdit(original, `${COMMAND_PREFIX}clear`);

  assert.equal(store.getCurrentEvent(GROUP_ID).date, beforeDate, 'expected !clear to be refused, not actually run');
  const refusal = fakeSockInstance.sentMessages.find((m) => /Only a group admin can clear the list/.test(m.content.text || ''));
  assert.ok(refusal, 'expected the same admin-refusal reply a fresh, typed "!clear" from a non-admin would get');
});

test('e2e: AI mention is ignored (Gemini never even called) when the group has !ai off', async () => {
  ai.setEnabled(GROUP_ID, false);
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down please', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(geminiCallCount, callsBefore, 'Gemini should never be called when !ai is off');
  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

test('e2e: a message that does not @-mention the bot never triggers AI interpretation, even with !ai on', async () => {
  ai.setEnabled(GROUP_ID, true);
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down please', { from: 'jordan@s.whatsapp.net', type: 'notify' }); // no mentions

  assert.equal(geminiCallCount, callsBefore, 'Gemini should never be called without an @-mention');
  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

test('e2e: pasting an edited copy of the list as plain chat (no !update, no @-mention) is not silently ignored - the bot sends a short reply pointing to an @-mention, with an example, instead of naming !in/!out/!paid/!update', async () => {
  ai.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  const pastedEdit = '*Attendance*\n\n1. PastedNoMentionProbe';
  await deliver(pastedEdit, { from: 'jordan@s.whatsapp.net', type: 'notify' }); // no @-mention at all

  // Nothing was actually applied - PastedNoMentionProbe never really joined.
  assert.equal(store.getCurrentEvent(GROUP_ID).entries.find((e) => e.name === 'PastedNoMentionProbe'), undefined);

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  const replyText = fakeSockInstance.sentMessages[0].content.text;
  assert.match(replyText, /nothing was recorded/i);
  assert.match(replyText, /@Snoopy/); // points to an @-mention...
  assert.match(replyText, /e\.g\./i); // ...with a worked example
  assert.doesNotMatch(replyText, new RegExp(`${COMMAND_PREFIX}(in|out|paid|update)\\b`)); // never names a specific command
});

test('e2e: the same pasted-list reply is sent even when !ai is off for the group - it is a short static heads-up, not conditioned on whether an @-mention would actually be interpreted', async () => {
  ai.setEnabled(GROUP_ID, false);
  fakeSockInstance.sentMessages.length = 0;

  const pastedEdit = '*Attendance*\n\n1. PastedNoAiProbe';
  await deliver(pastedEdit, { from: 'jordan@s.whatsapp.net', type: 'notify' });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /nothing was recorded/i);
});

test('e2e: an ordinary chat message that just happens to be numbered lines (not a real pasted list) triggers no reply at all', async () => {
  ai.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  await deliver('grocery list for tonight:\n1. milk\n2. eggs', { from: 'jordan@s.whatsapp.net', type: 'notify' });

  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

test('e2e: pasting an edited copy of the list as plain chat during a catch-up (append) redelivery triggers no reply - only live messages get the heads-up', async () => {
  ai.setEnabled(GROUP_ID, true);
  fakeSockInstance.sentMessages.length = 0;

  await deliver('*Attendance*\n\n1. PastedCatchUpProbe', { from: 'jordan@s.whatsapp.net', type: 'append' });

  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

test('e2e: an @-mention in a catch-up (append) message IS interpreted, and dispatches if it resolves to a real !in/!out/!paid action - regression for a real report ("I @-mentioned the bot while it was offline and nothing happened")', async () => {
  ai.setEnabled(GROUP_ID, true);
  const callsBefore = geminiCallCount;
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down please', { from: 'catchupaiprobe@s.whatsapp.net', type: 'append', mentions: [BOT_JID] });

  assert.equal(geminiCallCount, callsBefore + 1, 'expected the caught-up @-mention to actually be interpreted');
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'a caught-up @-mention must not post its own immediate reply/list, same as a caught-up !in');

  await new Promise((resolve) => setTimeout(resolve, 400)); // let the catch-up summary flush
  const posted = fakeSockInstance.sentMessages.find((m) => /catchupaiprobe/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the "in" action to have actually been honored once the catch-up summary/list flushes');
});

test('e2e: an @-mention in a catch-up (append) message that resolves to something unsafe (e.g. an admin command) is silently skipped, same as a typed admin command would be', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'clear', argText: '', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('clear the list please', { from: 'admin@s.whatsapp.net', type: 'append', mentions: [BOT_JID] });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'an admin action resolved from a caught-up @-mention must never dispatch');
});

test('e2e: an @-mention in a catch-up (append) message that resolves to LOW confidence is silently skipped - never a clarifying question for an offline-backlog message', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '', confidence: 'low', question: 'Did you mean to sign up?' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('maybe put me down?', { from: 'jordan@s.whatsapp.net', type: 'append', mentions: [BOT_JID] });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'a low-confidence action must never dispatch or ask a clarifying question for a caught-up message');
});

// --- Diagnostic logging for silently-dropped @-mentions ------------------
// A real bug report ("I @-mentioned the bot and got no response at all")
// turned out to have no trace anywhere at default log verbosity - these
// two gates (catch-up redelivery, and !ai being off) are the two
// precisely-detectable ways that happens. See index.js's own comments at
// each console.log call for why a third possible cause (messageMentionsBot()
// not matching) is deliberately NOT logged here - no way to tell that
// apart from "mentioned someone else entirely" without spamming ordinary
// chat.

test('e2e: a genuine @-mention arriving as a catch-up (append) redelivery logs a diagnostic line instead of vanishing with no trace', async () => {
  ai.setEnabled(GROUP_ID, true);
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await deliver('put me down please', { from: 'jordan@s.whatsapp.net', type: 'append', mentions: [BOT_JID] });
  } finally {
    console.log = originalLog;
  }
  assert.ok(
    logged.some((line) => /Dropped an @-mention.*catch-up/.test(line)),
    `expected a diagnostic log line about the dropped catch-up mention, got: ${JSON.stringify(logged)}`
  );
});

test('e2e: a catch-up (append) message that does NOT mention the bot logs nothing extra (no false-positive diagnostic noise)', async () => {
  ai.setEnabled(GROUP_ID, true);
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await deliver('just some ordinary chat', { from: 'jordan@s.whatsapp.net', type: 'append' }); // no mentions at all
  } finally {
    console.log = originalLog;
  }
  assert.ok(!logged.some((line) => /Dropped an @-mention/.test(line)), `expected no dropped-mention diagnostic, got: ${JSON.stringify(logged)}`);
});

test('e2e: a live @-mention while !ai is off logs a diagnostic line instead of vanishing with no trace', async () => {
  ai.setEnabled(GROUP_ID, false);
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await deliver('put me down please', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });
  } finally {
    console.log = originalLog;
  }
  assert.equal(fakeSockInstance.sentMessages.length, 0); // still silent to the group - !ai off is a deliberate no-op
  assert.ok(
    logged.some((line) => /Dropped an @-mention.*ai is off/.test(line)),
    `expected a diagnostic log line about !ai being off, got: ${JSON.stringify(logged)}`
  );
});

test('e2e: a Gemini API failure does not crash, but still gets the same "I don\'t understand" reply (no reply is never OK for an @-mention)', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiError('simulated network failure');
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down please', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /not capable of doing that/i);
});

test('e2e: a Gemini call that times out gets a "took too long, try again" reply pointing to !help/!admin for typed commands, NOT the generic "not capable of doing that" one', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiTimeout();
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down please', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  const replyText = fakeSockInstance.sentMessages[0].content.text;
  assert.match(replyText, /took too long/i);
  assert.match(replyText, /try again/i);
  assert.match(replyText, new RegExp(`${COMMAND_PREFIX}help`));
  assert.doesNotMatch(replyText, /not capable of doing that/i);
});

// Regression coverage for the "last seen" About/status heartbeat
// (lib/lastSeenStatus.js): it should update immediately on every real
// 'open' connection event (not wait for the first timer tick, which could
// leave it stale for minutes right after a reconnect), and keep refreshing
// on the configured interval afterwards for as long as the connection
// stays up. Uses the real setInterval wiring in index.js (with
// LAST_SEEN_STATUS_INTERVAL_MINUTES shortened for this file - see the top
// of this file), not a re-derivation of the logic by hand. Deliberately
// placed right after the very first test/before any close-handler test
// touches currentSock - the 'open' branch in index.js only ever updates the
// About text through its own closure-local `sock`, not currentSock, so the
// interval tick (which does read currentSock) would otherwise depend on
// module-level state some other test happened to leave behind.
test('e2e: WhatsApp About/status text is updated immediately on connect and then on a timer', async () => {
  fakeSockInstance.statusUpdates.length = 0;
  const openHandler = capturedHandlers['connection.update'];
  assert.ok(openHandler, 'expected index.js to have registered a connection.update handler');

  openHandler({ connection: 'open' });
  // Immediate call happens synchronously inside the handler (fire-and-forget,
  // but the call itself is made before the handler returns) - give the
  // microtask queue a tick to let the fake async updateProfileStatus resolve.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fakeSockInstance.statusUpdates.length, 1, 'expected an immediate status update on connect');
  assert.match(fakeSockInstance.statusUpdates[0], /^Last seen: \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} (AM|PM) \[updates every [\d.]+ minutes?\]$/);

  // Now wait past the (shortened, ~600ms) interval and confirm it fires
  // again on its own, without another connection event.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(fakeSockInstance.statusUpdates.length >= 2, 'expected the heartbeat interval to have fired at least once more on its own');
});

test('e2e: catch-up (append) messages only honor !in/!out/!paid, not other commands', async () => {
  fakeSockInstance.sentMessages.length = 0;

  // !location is NOT in the catch-up allow-list - should be silently dropped.
  await deliver('!location Somewhere Else', { from: 'admin@s.whatsapp.net', type: 'append' });
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'a non-catch-up command must not be processed for an append message');

  // !in IS in the catch-up allow-list - it's honored (the list is actually
  // mutated), but it stays quiet immediately rather than posting its own
  // reply/list right away - it waits to be folded into the batched
  // catch-up summary instead (see the dedicated batching test below).
  await deliver('!in Henry', { from: 'jordan@s.whatsapp.net', type: 'append' });
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'a caught-up !in must not post its own immediate reply/list');

  await new Promise((resolve) => setTimeout(resolve, 400)); // let the catch-up summary flush
  const posted = fakeSockInstance.sentMessages.find((m) => /Henry/.test(m.content.text || ''));
  assert.ok(posted, 'expected !in to have actually been honored (Henry appears once the catch-up summary/list flushes)');
});

test('e2e: a real, known typed command (e.g. !limit/!allow) dropped by the catch-up gate logs a diagnostic line instead of vanishing with no trace - regression for a real report ("no response from !allow or !limit")', async () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await deliver('!limit 20', { from: 'admin@s.whatsapp.net', type: 'append' });
  } finally {
    console.log = originalLog;
  }
  assert.ok(
    logged.some((line) => /Dropped "!limit".*catch-up/.test(line)),
    `expected a diagnostic log line about the dropped !limit, got: ${JSON.stringify(logged)}`
  );
});

test('e2e: an unrecognized command word (a typo, or ordinary chat starting with "!") dropped by the catch-up gate logs nothing extra (no false-positive diagnostic noise)', async () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await deliver('!notarealcommand whatever', { from: 'admin@s.whatsapp.net', type: 'append' });
  } finally {
    console.log = originalLog;
  }
  assert.ok(!logged.some((line) => /Dropped "/.test(line)), `expected no dropped-command diagnostic, got: ${JSON.stringify(logged)}`);
});

test('e2e: multiple catch-up commands are batched into one combined summary plus one list post', async () => {
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!in Renee', { from: 'admin@s.whatsapp.net', type: 'append' });
  await deliver('!paid NobodyOnDueList', { from: 'alex@s.whatsapp.net', type: 'append' });
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'caught-up commands must not send anything immediately');

  await new Promise((resolve) => setTimeout(resolve, 400)); // let the catch-up summary flush

  assert.equal(fakeSockInstance.sentMessages.length, 2, 'expected exactly one combined summary and one list post, not one per caught-up command');
  const [summaryMsg, listMsg] = fakeSockInstance.sentMessages;
  assert.match(summaryMsg.content.text, /Caught up on 2 messages sent while I was offline/);
  // Bulleted, bold-command format - see lib/catchUpSummary.js / test/catchUp.test.js.
  assert.match(summaryMsg.content.text, /• \*!in\* \(admin\): added Renee/);
  assert.match(summaryMsg.content.text, /• \*!paid\* \(alex\): not on the payment-due list/);
  assert.match(listMsg.content.text, /Renee/);
});

// Regression coverage for a real incident: WhatsApp can redeliver an
// offline backlog across two separate bursts with a real gap in between -
// long enough that the old timer-only flush logic sent a summary covering
// only the first burst, then a second summary for the rest a moment later.
// index.js forwards Baileys' connection.update `receivedPendingNotifications`
// field to lib/catchUpQueue.js's setBacklogSynced() specifically so a
// quiet-period timer firing mid-sync holds the batch open instead of
// sending a partial one - this test drives that signal through the real
// connection.update handler (not by calling setBacklogSynced() directly,
// which test/catchUp.test.js already covers at the unit level) to prove
// the wiring itself is correct end-to-end.
test('e2e: a catch-up backlog delivered across two bursts still produces exactly one combined summary, gated on receivedPendingNotifications', async () => {
  fakeSockInstance.sentMessages.length = 0;
  const connectionHandler = capturedHandlers['connection.update'];
  assert.ok(connectionHandler, 'expected index.js to have registered a connection.update handler');

  try {
    connectionHandler({ receivedPendingNotifications: false }); // reconnect starting - backlog redelivery about to begin

    await deliver('!in Early', { from: 'admin@s.whatsapp.net', type: 'append' });
    await new Promise((resolve) => setTimeout(resolve, 400)); // well past the (0.2s) quiet-period delay
    assert.equal(fakeSockInstance.sentMessages.length, 0, 'must not flush a partial batch while WhatsApp is still mid-redelivery');

    // Second burst, as if WhatsApp took a bit longer to redeliver the rest.
    await deliver('!in Late', { from: 'jordan@s.whatsapp.net', type: 'append' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fakeSockInstance.sentMessages.length, 0, 'still must not flush - receivedPendingNotifications has not fired true yet');

    connectionHandler({ receivedPendingNotifications: true }); // WhatsApp confirms redelivery is complete
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(fakeSockInstance.sentMessages.length, 2, 'expected exactly one combined summary + one list post, covering BOTH bursts');
    assert.match(fakeSockInstance.sentMessages[0].content.text, /Caught up on 2 messages sent while I was offline/);
    assert.match(fakeSockInstance.sentMessages[0].content.text, /Early/);
    assert.match(fakeSockInstance.sentMessages[0].content.text, /Late/);
  } finally {
    // Reset shared catchUpQueue module state so every later test in this
    // file (which never touches receivedPendingNotifications at all) sees
    // its normal default behavior: flush on the quiet-period timer alone.
    connectionHandler({ receivedPendingNotifications: true });
  }
});

test('e2e: spam is deleted before ever being treated as a command', async () => {
  fakeSockInstance.sentMessages.length = 0;
  fakeSockInstance.deleted.length = 0;

  // Spam filtering is ON by default now, so this group is already
  // protected without ever touching !spamfilter - no setup command needed.
  const before = fakeSockInstance.sentMessages.length;
  await deliver('check out this guaranteed profit https://sketchy-coin.xyz/abc', { from: 'alex@s.whatsapp.net', type: 'notify' });
  assert.equal(fakeSockInstance.deleted.length, 1, 'expected the spam message to have been deleted');
  assert.equal(fakeSockInstance.sentMessages.length, before, 'no reply/list should be posted for a deleted spam message');
});

test('e2e: !spamfilter off actually turns off deletion for that group, and !spamfilter on restores it', async () => {
  fakeSockInstance.sentMessages.length = 0;
  fakeSockInstance.deleted.length = 0;

  await deliver('!spamfilter off', { from: 'admin@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('check out this guaranteed profit https://sketchy-coin.xyz/abc', { from: 'alex@s.whatsapp.net', type: 'notify' });
  assert.equal(fakeSockInstance.deleted.length, 0, 'spam should NOT be deleted while this group has opted out');

  await deliver('!spamfilter on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.deleted.length = 0;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('check out this guaranteed profit https://sketchy-coin.xyz/abc', { from: 'alex@s.whatsapp.net', type: 'notify' });
  assert.equal(fakeSockInstance.deleted.length, 1, 'spam should be deleted again once turned back on');
});

// Regression coverage for the multi-line command-splitting fix in
// index.js's handleMessage(): commands used to be split on the first SPACE
// character only, which would have sliced into the middle of a pasted
// multi-line !update argument instead of cleanly after the command word.
// This drives the fix through the real pipeline (not just a direct
// commands/admin.js call - see test/commands.test.js for those) with the
// exact shape an admin would actually type: "!update" on its own line,
// followed by the pasted, edited list underneath.
test('e2e: !update accepts a multi-line pasted/edited list, typed as "!update" on its own line', async () => {
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!in Grace', { from: 'alex@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  const pastedEdit = '!update\n*Attendance*\n\n1. Grace\n2. NewPerson';
  await deliver(pastedEdit, { from: 'admin@s.whatsapp.net', type: 'notify' });

  const summary = fakeSockInstance.sentMessages.find((m) => /Added: NewPerson/.test(m.content.text || ''));
  assert.ok(summary, 'expected !update to have been recognized as the command, with the pasted text parsed as its argument');
  const posted = fakeSockInstance.sentMessages.find((m) => /\*Attendance\*/.test(m.content.text || '') && /NewPerson/.test(m.content.text || ''));
  assert.ok(posted, 'expected the updated list to have been reposted');
});

// Multiline commands: a message where every non-blank line is independently
// a real, recognized command is dispatched as one command per line (see
// index.js's isMultilineCommands check in handleMessage). Deliberately
// exercised through the real messages.upsert pipeline (deliver()), not a
// direct handler call, since the whole point is index.js's own line
// splitting/recursive dispatch, not commands/*.js itself.
test('e2e: "!in Quinn\\n!paid Quinn" dispatches both lines as separate commands', async () => {
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!in Quinn\n!paid Quinn', { from: 'admin@s.whatsapp.net', type: 'notify' });

  const added = fakeSockInstance.sentMessages.find((m) => /\bQuinn\b/.test(m.content.text || '') && /\*Attendance\*/.test(m.content.text || ''));
  assert.ok(added, 'expected the first line (!in Quinn) to have added Quinn and reposted the list');
  // Quinn was just added to the CURRENT list, not a real payment-due one
  // (that only exists after !newlist), so !paid Quinn can never actually
  // succeed here - but it still proves the SECOND line was independently
  // dispatched as its own !paid command (rather than swallowed as part of
  // the first line's argText, e.g. as a garbled "Quinn\n!paid Quinn" name)
  // by producing !paid's own real "not on the payment list yet" rejection.
  const paidRejection = fakeSockInstance.sentMessages.find((m) => /couldn't mark paid/i.test(m.content.text || '') && /Quinn/.test(m.content.text || ''));
  assert.ok(paidRejection, 'expected the second line (!paid Quinn) to have been dispatched too, not swallowed as argText of the first');
});

test('e2e: multiline commands tolerate a blank line between commands', async () => {
  fakeSockInstance.sentMessages.length = 0;

  await deliver('!in Piper\n\n!paid Piper', { from: 'admin@s.whatsapp.net', type: 'notify' });

  const added = fakeSockInstance.sentMessages.find((m) => /\bPiper\b/.test(m.content.text || '') && /\*Attendance\*/.test(m.content.text || ''));
  assert.ok(added, 'expected !in Piper to still be recognized with a blank line separating the two commands');
  // Same "not on the payment list yet" rejection as the test above - proves
  // !paid Piper was dispatched as its own command despite the blank line.
  const paidRejection = fakeSockInstance.sentMessages.find((m) => /couldn't mark paid/i.test(m.content.text || '') && /Piper/.test(m.content.text || ''));
  assert.ok(paidRejection, 'expected !paid Piper to still be dispatched too');
});

test('e2e: a message whose SECOND line is not a real command is NOT treated as multiline commands - dispatched as ONE command with a multi-line argText, exactly like !update', async () => {
  fakeSockInstance.sentMessages.length = 0;

  // "!notacommand" isn't a recognized command word, so the whole message
  // must be dispatched as ONE !in command whose argText happens to contain
  // a newline (and gets folded into a single, if slightly odd, name - the
  // same pre-existing behavior any multi-line, comma-free argText already
  // has, unrelated to this feature), not two separate commands - same
  // principle the existing !update multi-line-paste test above already
  // covers, exercised here against the isMultilineCommands check directly
  // with a line that merely LOOKS command-shaped ("!"-prefixed) but isn't
  // one of the recognized commands.
  await deliver('!in Skylar\n!notacommand', { from: 'admin@s.whatsapp.net', type: 'notify' });

  const reposts = fakeSockInstance.sentMessages.filter((m) => /\*Attendance\*/.test(m.content.text || ''));
  assert.equal(reposts.length, 1, 'expected exactly ONE list repost, proving this was dispatched as a single !in command rather than split into two');
});

test('e2e: multiline commands still enforce per-line admin checks - an admin-only line among them is refused independently', async () => {
  fakeSockInstance.sentMessages.length = 0;

  // !in is open to anyone; !limit is admin-only (see commands/admin.js) -
  // "dakota" is a non-admin sender in this fake sock (see the isGroupAdmin
  // fake below), so the !limit line must be refused on its own, while the
  // !in line still goes through - each line re-derives its OWN permission
  // check via the real handleMessage() pipeline, rather than the whole
  // message inheriting one shared permission outcome.
  await deliver('!in Dakota\n!limit 5', { from: 'dakota@s.whatsapp.net', type: 'notify' });

  const added = fakeSockInstance.sentMessages.find((m) => /\bDakota\b/.test(m.content.text || '') && /\*Attendance\*/.test(m.content.text || ''));
  assert.ok(added, 'expected the !in line to still succeed');
  const refused = fakeSockInstance.sentMessages.find((m) => /admin/i.test(m.content.text || ''));
  assert.ok(refused, 'expected the !limit line to have been refused with an admin-only reply');
});

test('e2e: a multiline batch of three plain, all-successful !in commands posts the list only ONCE, not once per line', async () => {
  fakeSockInstance.sentMessages.length = 0;

  // Each !in on its own is "quiet on success" (see the README) - just a
  // list repost, no separate reply - so with nothing anomalous across all
  // three lines, the WHOLE batch should produce exactly one message: one
  // combined list repost showing all three names, reflecting the
  // cumulative effect of all three lines, not three separate reposts.
  await deliver('!in Riley\n!in Sasha\n!in Tatum', { from: 'admin@s.whatsapp.net', type: 'notify' });

  assert.equal(fakeSockInstance.sentMessages.length, 1, 'expected exactly ONE message for the whole 3-line batch, not one per line');
  const [posted] = fakeSockInstance.sentMessages;
  assert.ok(/\bRiley\b/.test(posted.content.text) && /\bSasha\b/.test(posted.content.text) && /\bTatum\b/.test(posted.content.text), 'expected the single posted list to include all three names');
});

test('e2e: a multiline batch also reacts only ONCE to the original message (not once per line)', async () => {
  fakeSockInstance.reactions.length = 0;

  await deliver('!in Ellis\n!in Fenn', { from: 'admin@s.whatsapp.net', type: 'notify' });

  // 💬 (acknowledged) then ✅ (done) - exactly two reactions total for the
  // WHOLE batch, same as a single ordinary command already gets, not two
  // per line (which would be 💬✅💬✅ for a 2-line batch if each line
  // reacted on its own).
  assert.equal(fakeSockInstance.reactions.length, 2, 'expected exactly one 💬 and one ✅ for the whole batch, not one pair per line');
  assert.deepEqual(fakeSockInstance.reactions.map((r) => r.emoji), ['💬', '✅']);
});

test('e2e: messages from an unconfigured/disallowed group are ignored entirely', async () => {
  fakeSockInstance.sentMessages.length = 0;
  const upsertHandler = capturedHandlers['messages.upsert'];
  await upsertHandler({
    messages: [{
      key: { remoteJid: 'someotherGroup@g.us', participant: 'alex@s.whatsapp.net', fromMe: false, id: 'OTHER1' },
      pushName: 'alex',
      message: { conversation: '!in' },
    }],
    type: 'notify',
  });
  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

// Direct messages (see the DM redirect branch in index.js's handleMessage,
// right where it first checks the chat JID ends in "@g.us") - a genuine
// 1:1 chat's remoteJid is the SENDER's own JID (no separate `participant`,
// unlike a group message), which real Baileys always sends as either the
// classic @s.whatsapp.net form or the newer @lid form.
test('e2e: a direct message gets one fixed redirect reply, not silence', async () => {
  fakeSockInstance.sentMessages.length = 0;
  const upsertHandler = capturedHandlers['messages.upsert'];

  await upsertHandler({
    messages: [{
      key: { remoteJid: 'morgan@s.whatsapp.net', fromMe: false, id: 'DM1' },
      pushName: 'morgan',
      message: { conversation: '!in' },
    }],
    type: 'notify',
  });

  assert.equal(fakeSockInstance.sentMessages.length, 1, 'expected exactly one reply to a DM');
  assert.equal(fakeSockInstance.sentMessages[0].jid, 'morgan@s.whatsapp.net');
  const replyText = fakeSockInstance.sentMessages[0].content.text;
  assert.ok(/bot/i.test(replyText), 'expected the reply to explicitly state it\'s a bot');
  assert.ok(/organiser/i.test(replyText), 'expected the reply to point to the organiser');
  assert.ok(/group chat/i.test(replyText), 'expected the reply to say the organiser is reachable in the group chat');
});

test('e2e: the SAME direct message delivered twice (same message id, e.g. a genuine WhatsApp/Baileys redelivery) only gets ONE redirect reply, not two', async () => {
  fakeSockInstance.sentMessages.length = 0;
  const upsertHandler = capturedHandlers['messages.upsert'];
  const duplicateMsg = {
    key: { remoteJid: 'jamie@s.whatsapp.net', fromMe: false, id: 'DM-DUP-1' },
    pushName: 'jamie',
    message: { conversation: 'hello?' },
  };

  await upsertHandler({ messages: [duplicateMsg], type: 'notify' });
  await upsertHandler({ messages: [duplicateMsg], type: 'notify' });

  assert.equal(fakeSockInstance.sentMessages.length, 1, 'expected only ONE reply across both deliveries of the same message id');
});

test('e2e: a direct message from the newer @lid JID form also gets the redirect reply', async () => {
  fakeSockInstance.sentMessages.length = 0;
  const upsertHandler = capturedHandlers['messages.upsert'];

  await upsertHandler({
    messages: [{
      key: { remoteJid: '999888111@lid', fromMe: false, id: 'DM2' },
      pushName: 'reese',
      message: { conversation: 'hey are you there' },
    }],
    type: 'notify',
  });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
});

test('e2e: a WhatsApp Status update ("status@broadcast") never gets a reply - not a real DM', async () => {
  fakeSockInstance.sentMessages.length = 0;
  const upsertHandler = capturedHandlers['messages.upsert'];

  await upsertHandler({
    messages: [{
      key: { remoteJid: 'status@broadcast', participant: 'morgan@s.whatsapp.net', fromMe: false, id: 'STATUS1' },
      pushName: 'morgan',
      message: { conversation: 'some status text' },
    }],
    type: 'notify',
  });

  assert.equal(fakeSockInstance.sentMessages.length, 0, 'status@broadcast must never be treated as a DM');
});

test('e2e: a DM with no real message content (e.g. a bare protocol message) gets no reply', async () => {
  fakeSockInstance.sentMessages.length = 0;
  const upsertHandler = capturedHandlers['messages.upsert'];

  await upsertHandler({
    messages: [{
      key: { remoteJid: 'casey@s.whatsapp.net', fromMe: false, id: 'DM3' },
      pushName: 'casey',
      // no `message` at all - same "nothing real to respond to" shape the
      // group path already skips (see the !msg.message check just below
      // the DM branch).
    }],
    type: 'notify',
  });

  assert.equal(fakeSockInstance.sentMessages.length, 0);
});

// Regression coverage for the reconnect-after-sleep bug: a non-logged-out
// close used to call `start()` with no error handling and no delay, which
// (a) could crash the whole process via an unhandled rejection if the
// reconnect attempt failed, and (b) hammered the network instantly instead
// of giving a just-woken machine's Wi-Fi/DNS a moment to come back. These
// tests exercise the real scheduleReconnect() path (real timers, real
// backoff delay) rather than re-deriving the fix's logic by hand, so they
// actually catch a regression if this gets "simplified" back to a bare
// `start()` later.
test('e2e: a non-logged-out close schedules a real reconnect (new socket created) without crashing', async () => {
  const before = socketCreateCount;
  const closeHandler = capturedHandlers['connection.update'];
  assert.ok(closeHandler, 'expected index.js to have registered a connection.update handler');

  closeHandler({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });

  // First backoff step is 1s (see MAX_RECONNECT_DELAY_MS/reconnectAttempts
  // in index.js) - wait comfortably past that for the scheduled retry to
  // actually fire and create a new fake socket.
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.equal(socketCreateCount, before + 1, 'expected exactly one reconnect attempt (a fresh socket) after the backoff delay');
  // The freshly (re)created socket must still be fully wired up - same
  // pipeline as any other run, e.g. a live command still works post-reconnect.
  fakeSockInstance.sentMessages.length = 0;
  await deliver('!list', { from: 'alex@s.whatsapp.net', type: 'notify' });
  assert.ok(fakeSockInstance.sentMessages.length > 0, 'expected the reconnected socket to still process commands');
});

test('e2e: a logged-out close does NOT schedule a reconnect', async () => {
  const before = socketCreateCount;
  const closeHandler = capturedHandlers['connection.update'];

  closeHandler({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } }); // DisconnectReason.loggedOut in the fake module

  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.equal(socketCreateCount, before, 'a logged-out session must not trigger a reconnect attempt');
});