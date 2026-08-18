// test/ai.test.js
// Coverage for ai.js - the per-group on/off toggle for natural-language
// command interpretation (see lib/geminiCommand.js for the actual Gemini
// call, test/geminiCommand.test.js for its coverage, and
// test/commands.test.js for the !ai chat command, including the
// "on by default once a key IS configured" case this file can't exercise -
// see the note by GEMINI_API_KEY below). Same shape/pattern as spam.js's
// toggle (see test/activity-spam.test.js): on by default - except here
// that default only actually kicks in once GEMINI_API_KEY is configured,
// which this file deliberately never does (see below), so every default
// observed in this file is the "no key configured" off case.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-ai-test-'));
process.env.DATA_DIR = tmpDir;
// Deliberately NOT setting GEMINI_API_KEY in this file (unlike
// test/commands.test.js and test/geminiCommand.test.js) - this is the one
// place that specifically covers the "!ai on refuses without a configured
// key" path, which only reproduces when the key is genuinely unset.

const ai = require('../ai');
const { handleAi } = require('../commands/ai');
const { createFakeSock } = require('./helpers/mockBaileys');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `ai-test-${groupCounter}@g.us`;
}

function makeCtx({ sock, groupId, senderId, argText }) {
  const replies = [];
  const reply = async (body) => {
    replies.push(body);
  };
  return {
    ctx: { sock, msg: {}, groupId, senderId, senderName: senderId, argText, upsertType: 'notify', reply, postList: async () => {} },
    replies,
  };
}

test('ai: isEnabled defaults to false with no GEMINI_API_KEY configured (would default true otherwise, same as spam.js), and setEnabled persists', () => {
  const groupId = freshGroupId();
  assert.equal(ai.isEnabled(groupId), false);
  ai.setEnabled(groupId, true);
  assert.equal(ai.isEnabled(groupId), true);
  ai.setEnabled(groupId, false);
  assert.equal(ai.isEnabled(groupId), false);
});

test('ai: isEnabled is independent per group', () => {
  const groupA = freshGroupId();
  const groupB = freshGroupId();
  ai.setEnabled(groupA, true);
  assert.equal(ai.isEnabled(groupA), true);
  assert.equal(ai.isEnabled(groupB), false);
});

test('handleAi: "!ai on" refuses (and does not turn it on) when GEMINI_API_KEY is not configured', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'on' });
  await handleAi(ctx);
  assert.match(replies[0], /Can't turn this on yet/);
  assert.equal(ai.isEnabled(groupId), false);
});
