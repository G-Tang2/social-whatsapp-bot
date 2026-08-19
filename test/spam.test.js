// test/spam.test.js
// Coverage for spam.js (per-group toggle, and its two independent
// detection rules: a bare WhatsApp group invite link, or a link plus a
// finance/crypto keyword together).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-spam-test-'));
process.env.DATA_DIR = tmpDir;

const spam = require('../spam');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `spam-test-${groupCounter}@g.us`;
}

test('spam: isEnabled defaults to true (on by default) and setEnabled persists both ways', () => {
  const groupId = freshGroupId();
  // A group that's never touched !spamfilter gets protection automatically.
  assert.equal(spam.isEnabled(groupId), true);
  spam.setEnabled(groupId, false);
  assert.equal(spam.isEnabled(groupId), false);
  spam.setEnabled(groupId, true);
  assert.equal(spam.isEnabled(groupId), true);
});

test('spam: isSpamMessage (rule 2 - finance spam) requires BOTH a link and a keyword', () => {
  assert.equal(spam.isSpamMessage('check out this bitcoin opportunity https://sketchy.xyz/abc'), true);
  assert.equal(spam.isSpamMessage('just a link https://example.com'), false);
  assert.equal(spam.isSpamMessage('I love bitcoin and crypto'), false);
  assert.equal(spam.isSpamMessage('see you at 8pm for practice'), false);
  assert.equal(spam.isSpamMessage(''), false);
  assert.equal(spam.isSpamMessage(null), false);
});

test('spam: isSpamMessage (rule 1 - WhatsApp group invite link) flags a bare invite link with NO keyword needed', () => {
  assert.equal(spam.isSpamMessage('come join our group https://chat.whatsapp.com/AbCdEfGhIjKlMnOp'), true);
  // No scheme, still a valid WhatsApp invite share.
  assert.equal(spam.isSpamMessage('chat.whatsapp.com/AbCdEfGhIjKlMnOp'), true);
  // No finance/crypto keyword anywhere in either message above - rule 1 is
  // independent of rule 2's keyword requirement.
});

test('spam: isSpamMessage - an ordinary (non-WhatsApp-invite) link with no keyword is still not spam', () => {
  assert.equal(spam.isSpamMessage('here\'s the doc https://docs.google.com/abc'), false);
  // Bare mention of the domain with no invite code/path after it doesn't
  // count as an invite link - rule 1 specifically requires the
  // "chat.whatsapp.com/<something>" shape, not just the domain name.
  assert.equal(spam.isSpamMessage('is chat.whatsapp.com down for anyone else right now?'), false);
});

// Regression coverage for a real incident: this exact message (a common
// WhatsApp scam-group invite template) was NOT being flagged, because the
// keyword list only had the singular/base forms ('cryptocurrency', 'forex')
// and this message used the plural/synonym forms ('cryptocurrencies',
// 'foreign exchange') instead - exact whole-word matching doesn't stem or
// fuzzy-match, so a reworded variant slipped through entirely even though
// it's obviously the same spam. See SPAM_KEYWORDS' comment in spam.js.
test('spam: isSpamMessage catches a real-world investment-group invite spam message (plural/synonym keyword forms)', () => {
  const realSpamMessage =
    'This is a group that shares hot investment information for free every day, including '
    + '(stocks, options, funds, bonds, foreign exchange, cryptocurrencies, etc.). Here you can '
    + 'get more investment information and knowledge and skills, which can help your investment '
    + 'go more smoothly. Investment enthusiasts are welcome to join. '
    + 'https://chat.whatsapp.com/D97UaMtc7VG6RtM4QWbpe';
  assert.equal(spam.isSpamMessage(realSpamMessage), true);
});
