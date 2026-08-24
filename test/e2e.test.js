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
// lib/snoopyVoice.js's speakAsSnoopy() (see index.js's shared `reply`
// closure) ALSO goes through this same fake module - GEMINI_API_KEY is
// set (see the top of this file) for the interpretMessage tests below, so
// every reply() call in the WHOLE file now attempts a restyle call too.
// Deliberately kept entirely separate from geminiCallCount/
// lastGeminiCallArgs/geminiResponseQueue above (all reserved for
// interpretMessage's own schema-bearing calls) via the one real
// structural difference between the two call shapes: only
// interpretMessage's ever sets `config.responseJsonSchema`. A restyle
// call instead gets its own simple default here - echo the original
// message straight back, extracted from the prompt's own "Message: "..."
// wrapper (see lib/snoopyVoice.js's buildPrompt()) - so isSafeRestyle()
// passes trivially and every EXISTING interpretMessage-focused test in
// this file keeps seeing the exact reply text it always expected,
// completely unaffected by this second call now happening. See the
// dedicated speakAsSnoopy tests further down for real restyle-behavior
// coverage instead.
function defaultRestyleEcho(args) {
  const match = args.contents && args.contents.match(/Message: "([\s\S]*)"$/);
  return { text: match ? match[1] : '' };
}
const fakeGenaiModule = {
  GoogleGenAI: class {
    constructor() {
      this.models = {
        generateContent: async (args) => {
          const isRestyleCall = !(args.config && args.config.responseJsonSchema);
          if (isRestyleCall) return defaultRestyleEcho(args);

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
function makeMsg({ from, text, fromMe = false, mentions, quotedParticipant, quotedMessageText }) {
  fakeMsgCounter += 1;
  const contextInfo = {};
  if (mentions && mentions.length) contextInfo.mentionedJid = mentions;
  if (quotedParticipant) contextInfo.participant = quotedParticipant;
  if (quotedMessageText) contextInfo.quotedMessage = { conversation: quotedMessageText };
  return {
    key: { remoteJid: GROUP_ID, participant: from, fromMe, id: `E2E${fakeMsgCounter}` },
    pushName: from ? from.split('@')[0] : undefined,
    message: Object.keys(contextInfo).length ? { extendedTextMessage: { text, contextInfo } } : { conversation: text },
  };
}

async function deliver(text, { from = 'alex@s.whatsapp.net', type = 'notify', mentions, quotedParticipant, quotedMessageText } = {}) {
  const upsertHandler = capturedHandlers['messages.upsert'];
  assert.ok(upsertHandler, 'expected index.js to have registered a messages.upsert handler');
  await upsertHandler({ messages: [makeMsg({ from, text, mentions, quotedParticipant, quotedMessageText })], type });
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

  try {
    await deliver(key, { from: 'admin@s.whatsapp.net', type: 'notify' });
  } finally {
    commands[key] = original;
  }

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /something went wrong/i);
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

  try {
    await deliver('show me the list', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });
  } finally {
    rawCommands[key] = original;
  }

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  assert.match(fakeSockInstance.sentMessages[0].content.text, /something went wrong/i);
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

test('e2e: "@bot add me and 2 friends" (mapped to argText "+2") adds the sender plus 2 guest entries via the real handler', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({ command: 'in', argText: '+2', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('add me and 2 friends', { from: 'casey@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /casey\+2/i.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to show casey, casey+1, and casey+2');
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

test('e2e: a fully-low-confidence AI mention with a "question" from the model asks that question and tells the sender to reply, instead of the generic "not capable" fallback', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    command: 'out',
    argText: 'Janelle',
    confidence: 'low',
    question: 'Did you mean to remove Janelle from the payment list, or take her off the attendance list?',
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('Janelle paid Janelle in', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  assert.equal(fakeSockInstance.sentMessages.length, 1);
  const sent = fakeSockInstance.sentMessages[0];
  assert.match(sent.content.text, /Did you mean to remove Janelle from the payment list, or take her off the attendance list\?/);
  assert.match(sent.content.text, /reply to this message/i);
  assert.doesNotMatch(sent.content.text, /not capable of doing that/i);
  // Same "quote the triggering message" mechanism every AI-mention reply
  // already uses - this is what lets a plain WhatsApp reply to it be
  // treated as a continuation (see messageMentionsBot() in index.js).
  assert.ok(sent.options && sent.options.quoted, 'expected the clarifying question to be sent as a quote-reply');
  assert.equal(sent.options.quoted.message.extendedTextMessage.text, 'Janelle paid Janelle in');
});

test('e2e: replying to the bot\'s own clarifying question includes it as REPLY CONTEXT in the follow-up prompt sent to Gemini', async () => {
  ai.setEnabled(GROUP_ID, true);
  setNextGeminiResponse({
    command: 'out',
    argText: 'Janelle',
    confidence: 'low',
    question: 'Did you mean to remove Janelle from the payment list, or take her off the attendance list?',
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('Janelle paid Janelle in', { from: 'jordan@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });
  const clarifyingText = fakeSockInstance.sentMessages[0].content.text;

  setNextGeminiResponse({ command: 'update', argText: 'remove Janelle from the payment list', confidence: 'high' });
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
  assert.match(promptText, /Did you mean to remove Janelle from the payment list/, 'expected the bot\'s own prior question to be quoted back into the prompt');
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
  setNextGeminiResponse({ command: 'newlist', argText: '19/08 with Peter, Chris, Linda', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('create a new list for next Wednesday with Peter, Chris, and Linda', {
    from: 'admin@s.whatsapp.net',
    type: 'notify',
    mentions: [BOT_JID],
  });

  const posted = fakeSockInstance.sentMessages.find((m) => /Peter/.test(m.content.text || ''));
  assert.ok(posted, 'expected the posted list to show the pre-populated names');
  assert.match(posted.content.text, /Chris/);
  assert.match(posted.content.text, /Linda/);
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
  await deliver('!in Alex', { from: 'alex@s.whatsapp.net', type: 'notify' });

  const pastedEdit = 'here\'s the updated list:\n*Attendance*\n\n1. Alex\n2. AiUpdateProbe';
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
  await deliver('!in Keith', { from: 'keith@s.whatsapp.net', type: 'notify' });
  await deliver('!in Bao', { from: 'bao@s.whatsapp.net', type: 'notify' });
  await deliver('!in Garvin', { from: 'garvin@s.whatsapp.net', type: 'notify' });
  await deliver('!in tournament Keith, Bao', { from: 'admin@s.whatsapp.net', type: 'notify' }); // Garvin starts social-only

  const pastedEdit = [
    'update the list to be',
    '',
    '*Attendance* (3/6)',
    '',
    '🏆 *Tournament players* (2/2)',
    '',
    '1. Keith',
    '2. Garvin', // swapped in for Bao
    '',
    'Social only',
    '',
    '3. Bao',
  ].join('\n');
  setNextGeminiResponse({ command: 'update', argText: pastedEdit, confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver(pastedEdit, { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const summary = fakeSockInstance.sentMessages.find((m) => /Tournament:/.test(m.content.text || ''));
  assert.ok(summary, 'expected a "Tournament: ..." summary line, not "No changes found"');
  assert.match(summary.content.text, /Garvin \(social only → tournament\)/);
  assert.match(summary.content.text, /Bao \(tournament → social only\)/);

  const entries = store.getCurrentEvent(GROUP_ID).entries;
  assert.equal(entries.find((e) => e.name === 'Garvin').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, false);
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
  await deliver('!in Michael b', { from: 'admin@s.whatsapp.net', type: 'notify' });

  const posted = formatList(GROUP_ID);
  const edited = posted.replace('Michael b', 'Michael Brown');
  fakeSockInstance.sentMessages.length = 0;

  await deliver(`!update ${edited}`, { from: 'admin@s.whatsapp.net', type: 'notify' });

  const summaryMsg = fakeSockInstance.sentMessages.find((m) => /Added: Michael Brown/.test(m.content.text || ''));
  assert.ok(summaryMsg, 'expected the rename to be applied and summarized');
  assert.doesNotMatch(summaryMsg.content.text, /Date:/); // the actual bug: this used to always show up

  const event = store.getCurrentEvent(GROUP_ID);
  assert.equal(event.date, '2020-01-01'); // exact original year preserved, not bumped forward
  assert.ok(event.entries.find((e) => e.name === 'Michael Brown'));
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

test('e2e: an admin @-mentioning "make @Alex the court canceller" (bot mentioned too) sets it to the ACTUAL named person, not the bot itself - regression for the bot\'s own @-mention leaking into the mentioned-JID list', async () => {
  ai.setEnabled(GROUP_ID, true);
  const ALEX_JID = 'e2ecourtcancellerprobe@s.whatsapp.net';
  setNextGeminiResponse({ command: 'courtcanceller', argText: 'Alex', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  // The bot's own JID necessarily appears in mentions too (that's how AI
  // interpretation gets triggered at all) - order matters for the
  // regression this guards: the bot is mentioned FIRST, same as it would
  // be in a real "@Snoopy make @Alex the court canceller" message.
  await deliver('make @Alex the court canceller', {
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

test('e2e: an admin @-mentioning "Chakriya paid" for someone confirmed on the tournament list, but not yet due for payment, dispatches to the real !paid handler and pays EARLY instead of refusing', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  await deliver('!in tournament Chakriya', { from: 'admin@s.whatsapp.net', type: 'notify' });
  setNextGeminiResponse({ command: 'paid', argText: 'Chakriya', confidence: 'high' });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('Chakriya paid', { from: 'admin@s.whatsapp.net', type: 'notify', mentions: [BOT_JID] });

  const posted = fakeSockInstance.sentMessages.find((m) => /Chakriya \(paid\)/.test(m.content.text || ''));
  assert.ok(posted, 'expected the reposted list to show Chakriya tagged "(paid)"');
  const refused = fakeSockInstance.sentMessages.some((m) => /couldn't mark paid/i.test(m.content.text || ''));
  assert.equal(refused, false, 'expected the early-pay fallback to succeed, not a rejection');
  assert.equal(store.getCurrentEvent(GROUP_ID).entries.find((e) => e.name === 'Chakriya').paidEarly, true);
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

test('e2e: an admin @-mentioning "create a new list for tomorrow and the tournament winners are Peter and Rob" runs !newlist FIRST, then !tournamentwinners - the winners land on the fresh list instead of being immediately cleared by it', async () => {
  ai.setEnabled(GROUP_ID, true);
  await deliver('!settournament on', { from: 'admin@s.whatsapp.net', type: 'notify' });
  setNextGeminiResponse({
    actions: [
      { command: 'newlist', argText: '25/08', confidence: 'high' },
      { command: 'tournamentwinners', argText: 'Peter, Rob', confidence: 'high' },
    ],
  });
  fakeSockInstance.sentMessages.length = 0;

  await deliver('create a new list for tomorrow and the tournament winners are Peter and Rob', {
    from: 'admin@s.whatsapp.net',
    type: 'notify',
    mentions: [BOT_JID],
  });

  // If "tournamentwinners" had run BEFORE "newlist" (wrong order), newList()
  // would have immediately cleared it right back to null - this is a real
  // regression guard for that ordering bug, not just a "does the field get
  // set at all" check.
  assert.deepEqual(store.getTournamentWinners(GROUP_ID), ['Peter', 'Rob']);
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
// tournament limit is 12 ... add Keith, Tu and Bao to the tournament") ever
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

test('e2e: an AI-eligible mention in a catch-up (append) message is never interpreted', async () => {
  ai.setEnabled(GROUP_ID, true);
  const callsBefore = geminiCallCount;
  fakeSockInstance.sentMessages.length = 0;

  await deliver('put me down please', { from: 'jordan@s.whatsapp.net', type: 'append', mentions: [BOT_JID] });

  assert.equal(geminiCallCount, callsBefore, 'Gemini should never be called for a catch-up/append message');
  assert.equal(fakeSockInstance.sentMessages.length, 0);
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
  await deliver('!in Sam', { from: 'jordan@s.whatsapp.net', type: 'append' });
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'a caught-up !in must not post its own immediate reply/list');

  await new Promise((resolve) => setTimeout(resolve, 400)); // let the catch-up summary flush
  const posted = fakeSockInstance.sentMessages.find((m) => /Sam/.test(m.content.text || ''));
  assert.ok(posted, 'expected !in to have actually been honored (Sam appears once the catch-up summary/list flushes)');
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

  await deliver('!in Priya', { from: 'admin@s.whatsapp.net', type: 'append' });
  await deliver('!paid NobodyOnDueList', { from: 'alex@s.whatsapp.net', type: 'append' });
  assert.equal(fakeSockInstance.sentMessages.length, 0, 'caught-up commands must not send anything immediately');

  await new Promise((resolve) => setTimeout(resolve, 400)); // let the catch-up summary flush

  assert.equal(fakeSockInstance.sentMessages.length, 2, 'expected exactly one combined summary and one list post, not one per caught-up command');
  const [summaryMsg, listMsg] = fakeSockInstance.sentMessages;
  assert.match(summaryMsg.content.text, /Caught up on 2 messages sent while I was offline/);
  // Bulleted, bold-command format - see lib/catchUpSummary.js / test/catchUp.test.js.
  assert.match(summaryMsg.content.text, /• \*!in\* \(admin\): added Priya/);
  assert.match(summaryMsg.content.text, /• \*!paid\* \(alex\): not on the payment-due list/);
  assert.match(listMsg.content.text, /Priya/);
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

  await deliver('!in Alex', { from: 'alex@s.whatsapp.net', type: 'notify' });
  fakeSockInstance.sentMessages.length = 0;

  const pastedEdit = '!update\n*Attendance*\n\n1. Alex\n2. NewPerson';
  await deliver(pastedEdit, { from: 'admin@s.whatsapp.net', type: 'notify' });

  const summary = fakeSockInstance.sentMessages.find((m) => /Added: NewPerson/.test(m.content.text || ''));
  assert.ok(summary, 'expected !update to have been recognized as the command, with the pasted text parsed as its argument');
  const posted = fakeSockInstance.sentMessages.find((m) => /\*Attendance\*/.test(m.content.text || '') && /NewPerson/.test(m.content.text || ''));
  assert.ok(posted, 'expected the updated list to have been reposted');
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