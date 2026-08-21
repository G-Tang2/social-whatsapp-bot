// test/ai.test.js
// Coverage for ai.js - the per-group on/off toggle for natural-language
// command interpretation (see lib/geminiCommand.js for the actual Gemini
// call, test/geminiCommand.test.js for its coverage, and
// test/commands.test.js for the !ai chat command). Same shape/pattern as
// spam.js's toggle (see test/spam.test.js), except the default here
// depends on whether GEMINI_API_KEY is configured (see ai.js's own doc
// comment) rather than being unconditionally on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-ai-test-'));
process.env.DATA_DIR = tmpDir;
// Deliberately FORCED empty (not just "not set") - this is the one place
// that specifically covers the "no key configured -> stays off" path,
// which needs GEMINI_API_KEY to be genuinely unset. Merely omitting an
// assignment here isn't enough: ai.js's own `require('dotenv').config()`
// only fills in currently-UNSET vars, so a real key sitting in this
// machine's own .env (common on a dev box that's actually configured
// !ai for real testing) would otherwise silently leak in here and break
// every assumption below - see test/commands.test.js's opposite move
// (forcing a FAKE key) for the same reasoning in the other direction.
process.env.GEMINI_API_KEY = '';

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

test('ai: isEnabled defaults to false with no GEMINI_API_KEY configured (see test/commands.test.js for the with-a-key default-true case) and setEnabled persists', () => {
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
