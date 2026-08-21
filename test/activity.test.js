// test/activity.test.js
// Coverage for activity.js (per-group toggle, recording, inactive-candidate
// detection, warning lifecycle) - used by !inactivity/!stale
// (commands/inactivity.js) and lib/inactivityCheck.js's periodic sweep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-activity-test-'));
process.env.DATA_DIR = tmpDir;

const activity = require('../activity');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `activity-test-${groupCounter}@g.us`;
}

test('activity: isEnabled defaults to false and setEnabled persists', () => {
  const groupId = freshGroupId();
  assert.equal(activity.isEnabled(groupId), false);
  activity.setEnabled(groupId, true);
  assert.equal(activity.isEnabled(groupId), true);
  activity.setEnabled(groupId, false);
  assert.equal(activity.isEnabled(groupId), false);
});

test('activity: recordActivity sets lastSeen and clears warnedAt', () => {
  const groupId = freshGroupId();
  activity.markWarned(groupId, ['alex@s.whatsapp.net']);
  let warned = activity.getWarned(groupId);
  assert.equal(warned.length, 1);

  activity.recordActivity(groupId, 'alex@s.whatsapp.net');
  warned = activity.getWarned(groupId);
  assert.equal(warned.length, 0); // activity clears the warning
});

test('activity: getInactiveCandidates finds only unwarned participants past the cutoff', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net']);
  // Force alex's lastSeen far into the past by recording, then manually
  // rewinding via a second seed call is not possible (seed won't overwrite) -
  // instead use resetBaseline with a fabricated "long ago" by recording now
  // and checking with inactiveMs = 0, which always counts as past-cutoff.
  const candidates = activity.getInactiveCandidates(groupId, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'alex@s.whatsapp.net');
});

test('activity: markWarned + getWarned lifecycle, sorted oldest-warned first', () => {
  const groupId = freshGroupId();
  activity.markWarned(groupId, ['first@s.whatsapp.net']);
  activity.markWarned(groupId, ['second@s.whatsapp.net']);
  const warned = activity.getWarned(groupId);
  assert.equal(warned.length, 2);
  assert.equal(warned[0].id, 'first@s.whatsapp.net'); // warned first, sorts first
});

test('activity: pruneParticipants drops anyone still missing on a SECOND consecutive sweep', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net', 'sam@s.whatsapp.net']);
  activity.pruneParticipants(groupId, ['alex@s.whatsapp.net']);
  activity.pruneParticipants(groupId, ['alex@s.whatsapp.net']); // still missing a second time
  const candidates = activity.getInactiveCandidates(groupId, 0);
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes('alex@s.whatsapp.net'));
  assert.ok(!ids.includes('sam@s.whatsapp.net'));
});

// Regression coverage for a real incident: a single sock.groupMetadata()
// call transiently came back missing some real, still-present members
// (observed around a reconnect), and the old immediate-delete
// pruneParticipants() wiped their tracked lastSeen - seedParticipants()
// then silently reseeded them with a fresh "now" baseline on the very next
// sweep, resetting their inactivity clock and masking genuinely-long
// quiet periods. Deleting is now debounced across two consecutive sweeps
// instead of one, specifically so a one-off flaky/incomplete metadata
// response can't do this.
test('activity: pruneParticipants does NOT drop someone missing from only a single snapshot (debounced against a flaky/incomplete metadata fetch)', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net', 'sam@s.whatsapp.net']);
  activity.pruneParticipants(groupId, ['alex@s.whatsapp.net']); // sam missing just this once
  const candidates = activity.getInactiveCandidates(groupId, 0);
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes('sam@s.whatsapp.net'), 'a single missed snapshot must not delete tracked activity');
});

test('activity: pruneParticipants clears the "missing" mark if someone reappears on a later snapshot (their lastSeen survives, not reset)', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['sam@s.whatsapp.net']);
  const before = activity.getInactiveCandidates(groupId, 0).find((c) => c.id === 'sam@s.whatsapp.net');
  assert.ok(before, 'sanity check: sam is tracked from the start');

  activity.pruneParticipants(groupId, []); // sam missing from one snapshot
  activity.pruneParticipants(groupId, ['sam@s.whatsapp.net']); // reappears before a second consecutive miss
  activity.pruneParticipants(groupId, []); // missing again - must count as a fresh first miss, not a second

  const candidates = activity.getInactiveCandidates(groupId, 0);
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes('sam@s.whatsapp.net'), 'reappearing should reset the debounce, not just delay the delete by one cycle');
  // lastSeen itself (seeded once, at the very start) must be untouched by
  // any of this - the whole point is that transient misses don't silently
  // reset someone's inactivity clock.
  const after = candidates.find((c) => c.id === 'sam@s.whatsapp.net');
  assert.equal(after.lastSeen, before.lastSeen);
});

test('activity: resetBaseline overwrites stale records with a clean baseline', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net']);
  activity.markWarned(groupId, ['alex@s.whatsapp.net']);
  assert.equal(activity.getWarned(groupId).length, 1);

  activity.resetBaseline(groupId, ['alex@s.whatsapp.net']);
  assert.equal(activity.getWarned(groupId).length, 0); // warning cleared by the reset
});
