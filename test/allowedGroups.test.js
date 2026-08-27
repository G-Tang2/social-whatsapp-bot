// test/allowedGroups.test.js
// Coverage for lib/allowedGroups.js - the runtime-mutable, always-fresh-read
// replacement for .env's static ALLOWED_GROUPS (see that file's own doc
// comment), and manage-groups.js (repo root)'s underlying data layer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-allowedgroups-test-'));
process.env.DATA_DIR = tmpDir;
// Seeded here, before the very first read - see the "seeds..." test below,
// which MUST run first (within this file/DATA_DIR) to actually exercise
// that one-time migration path; every test after it shares this same
// already-seeded file, same "one DATA_DIR per test file" convention as
// every other test file in this project.
process.env.ALLOWED_GROUPS = 'seed1@g.us, seed2@g.us';

const allowedGroups = require('../lib/allowedGroups');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `allowedgroups-test-${groupCounter}@g.us`;
}

test('getApprovedGroups: seeds from ALLOWED_GROUPS on the very first read (backward compat for an existing .env-only deployment)', () => {
  assert.deepEqual(allowedGroups.getApprovedGroups(), ['seed1@g.us', 'seed2@g.us']);
});

test('getApprovedGroups: persists - a second read (a fresh module load, real Baileys process restart) sees the SAME list, not re-seeded/duplicated', () => {
  delete require.cache[require.resolve('../lib/allowedGroups')];
  const reloaded = require('../lib/allowedGroups');
  assert.deepEqual(reloaded.getApprovedGroups(), ['seed1@g.us', 'seed2@g.us']);
});

test('isGroupApproved: true for a seeded group, false for an unknown one', () => {
  assert.equal(allowedGroups.isGroupApproved('seed1@g.us'), true);
  assert.equal(allowedGroups.isGroupApproved('unknown@g.us'), false);
});

test('approveGroup: adds a new group, takes effect immediately for getApprovedGroups/isGroupApproved', () => {
  const result = allowedGroups.approveGroup('new1@g.us');
  assert.deepEqual(result, { ok: true });
  assert.ok(allowedGroups.getApprovedGroups().includes('new1@g.us'));
  assert.equal(allowedGroups.isGroupApproved('new1@g.us'), true);
});

test('approveGroup: approving an already-approved group (with nothing pending for it either) reports it rather than silently no-op-ing', () => {
  const result = allowedGroups.approveGroup('seed1@g.us');
  assert.deepEqual(result, { ok: false, reason: 'already_approved' });
});

test('approveGroup: clears the group out of pending too, since it is no longer "awaiting a decision"', () => {
  allowedGroups.recordPendingGroup('new2@g.us', 'New Group Two');
  assert.ok(allowedGroups.getPendingGroups().some((g) => g.jid === 'new2@g.us'));

  allowedGroups.approveGroup('new2@g.us');
  assert.ok(!allowedGroups.getPendingGroups().some((g) => g.jid === 'new2@g.us'));
  assert.ok(allowedGroups.isGroupApproved('new2@g.us'));
});

test('removeGroup: de-authorizes a currently-approved group', () => {
  allowedGroups.approveGroup('toRemove@g.us');
  assert.equal(allowedGroups.isGroupApproved('toRemove@g.us'), true);

  const result = allowedGroups.removeGroup('toRemove@g.us');
  assert.deepEqual(result, { ok: true });
  assert.equal(allowedGroups.isGroupApproved('toRemove@g.us'), false);
});

test('removeGroup: removing a group that is not approved reports that instead of silently no-op-ing', () => {
  const result = allowedGroups.removeGroup('neverApproved@g.us');
  assert.deepEqual(result, { ok: false, reason: 'not_approved' });
});

test('recordPendingGroup: a new sighting is added with matching first/last-seen timestamps', () => {
  allowedGroups.recordPendingGroup('pending1@g.us', 'Pending Group One');
  const entry = allowedGroups.getPendingGroups().find((g) => g.jid === 'pending1@g.us');
  assert.ok(entry);
  assert.equal(entry.subject, 'Pending Group One');
  assert.equal(entry.firstSeenAt, entry.lastSeenAt);
});

test('recordPendingGroup: a repeat sighting refreshes lastSeenAt/subject without duplicating the entry', async () => {
  allowedGroups.recordPendingGroup('pending2@g.us', 'Old Name');
  const first = allowedGroups.getPendingGroups().find((g) => g.jid === 'pending2@g.us');

  await new Promise((resolve) => setTimeout(resolve, 5)); // ensure a distinct timestamp
  allowedGroups.recordPendingGroup('pending2@g.us', 'New Name');

  const matches = allowedGroups.getPendingGroups().filter((g) => g.jid === 'pending2@g.us');
  assert.equal(matches.length, 1, 'expected one entry, not a duplicate');
  assert.equal(matches[0].subject, 'New Name');
  assert.equal(matches[0].firstSeenAt, first.firstSeenAt, 'firstSeenAt should never change on a repeat sighting');
  assert.notEqual(matches[0].lastSeenAt, first.lastSeenAt);
});

test('recordPendingGroup: a no-op for a group that\'s already approved - nothing to surface for something already being moderated', () => {
  allowedGroups.recordPendingGroup('seed1@g.us', 'Seed One');
  assert.ok(!allowedGroups.getPendingGroups().some((g) => g.jid === 'seed1@g.us'));
});

test('getPendingGroups: most-recently-seen first', async () => {
  const older = freshGroupId();
  const newer = freshGroupId();
  allowedGroups.recordPendingGroup(older, 'Older');
  await new Promise((resolve) => setTimeout(resolve, 5));
  allowedGroups.recordPendingGroup(newer, 'Newer');

  const order = allowedGroups.getPendingGroups().map((g) => g.jid);
  assert.ok(order.indexOf(newer) < order.indexOf(older), 'expected the more recently seen group first');
});

test('getApprovedGroups/getPendingGroups: corrupt data file resets to empty rather than throwing', () => {
  const dataFile = path.join(tmpDir, 'allowedGroups.json');
  fs.writeFileSync(dataFile, 'not valid json{{{');
  assert.deepEqual(allowedGroups.getApprovedGroups(), []);
  assert.deepEqual(allowedGroups.getPendingGroups(), []);
});
