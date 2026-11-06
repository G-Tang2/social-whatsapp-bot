// test/scheduledListAdvance.test.js
// Coverage for lib/scheduledListAdvance.js: the mechanics shared by
// lib/autoNewlistScheduler.js and lib/cancelledSocialResumeScheduler.js
// (extracted since both previously hand-rolled an identical "compute the
// assumed end instant -> mark -> newList -> merge !regulars -> post"
// sequence and sweep loop). Those two files' own test suites already
// exercise this indirectly end-to-end - this covers computeAssumedEndInstant()
// directly, since it's the one piece of real, independently-testable logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-scheduledlistadvance-test-'));
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = 'scheduledlistadvance-test@g.us';
process.env.TIMEZONE = 'UTC';

const { AUTO_NEWLIST_DELAY_MS } = require('../lib/config');
const { computeAssumedEndInstant } = require('../lib/scheduledListAdvance');

test('computeAssumedEndInstant resolves a real date+time into start instant + AUTO_NEWLIST_DELAY_MS', () => {
  const result = computeAssumedEndInstant('2026-08-26', { hour: 20, minute: 0 });
  const expectedStart = Date.UTC(2026, 7, 26, 20, 0); // TIMEZONE=UTC here, so no offset to account for
  assert.equal(result, expectedStart + AUTO_NEWLIST_DELAY_MS);
});

test('computeAssumedEndInstant returns null for a malformed date, rather than throwing', () => {
  assert.equal(computeAssumedEndInstant('not-a-date', { hour: 20, minute: 0 }), null);
});
