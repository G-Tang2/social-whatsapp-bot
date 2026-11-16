// test/activity.test.js
// Coverage for activity.js (per-group toggle, recording, kick-candidate
// detection) - used by !inactivity (commands/inactivity.js) and
// lib/inactivityCheck.js's periodic auto-kick sweep.

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

test('activity: recordActivity sets/updates lastSeen', () => {
  const groupId = freshGroupId();
  activity.recordActivity(groupId, 'alex@s.whatsapp.net');
  const before = activity.getKickCandidates(groupId, 0).find((c) => c.id === 'alex@s.whatsapp.net');
  assert.ok(before);

  activity.recordActivity(groupId, 'alex@s.whatsapp.net');
  const after = activity.getKickCandidates(groupId, 0).find((c) => c.id === 'alex@s.whatsapp.net');
  assert.ok(new Date(after.lastSeen).getTime() >= new Date(before.lastSeen).getTime());
});

test('activity: getKickCandidates finds participants past the cutoff', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net']);
  const candidates = activity.getKickCandidates(groupId, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'alex@s.whatsapp.net');
});

test('activity: a long enough inactiveMs excludes someone just seeded (not actually due yet)', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net']);
  const candidates = activity.getKickCandidates(groupId, 24 * 60 * 60 * 1000);
  assert.equal(candidates.length, 0);
});

test('activity: clearParticipants immediately drops tracking (not debounced), leaving others untouched', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net', 'sam@s.whatsapp.net']);
  activity.clearParticipants(groupId, ['alex@s.whatsapp.net']);
  const ids = activity.getKickCandidates(groupId, 0).map((c) => c.id);
  assert.ok(!ids.includes('alex@s.whatsapp.net'));
  assert.ok(ids.includes('sam@s.whatsapp.net'));
});

test('activity: pruneParticipants drops anyone still missing on a SECOND consecutive sweep', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net', 'sam@s.whatsapp.net']);
  activity.pruneParticipants(groupId, ['alex@s.whatsapp.net']);
  activity.pruneParticipants(groupId, ['alex@s.whatsapp.net']); // still missing a second time
  const candidates = activity.getKickCandidates(groupId, 0);
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
  const candidates = activity.getKickCandidates(groupId, 0);
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes('sam@s.whatsapp.net'), 'a single missed snapshot must not delete tracked activity');
});

test('activity: pruneParticipants clears the "missing" mark if someone reappears on a later snapshot (their lastSeen survives, not reset)', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['sam@s.whatsapp.net']);
  const before = activity.getKickCandidates(groupId, 0).find((c) => c.id === 'sam@s.whatsapp.net');
  assert.ok(before, 'sanity check: sam is tracked from the start');

  activity.pruneParticipants(groupId, []); // sam missing from one snapshot
  activity.pruneParticipants(groupId, ['sam@s.whatsapp.net']); // reappears before a second consecutive miss
  activity.pruneParticipants(groupId, []); // missing again - must count as a fresh first miss, not a second

  const candidates = activity.getKickCandidates(groupId, 0);
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes('sam@s.whatsapp.net'), 'reappearing should reset the debounce, not just delay the delete by one cycle');
  // lastSeen itself (seeded once, at the very start) must be untouched by
  // any of this - the whole point is that transient misses don't silently
  // reset someone's inactivity clock.
  const after = candidates.find((c) => c.id === 'sam@s.whatsapp.net');
  assert.equal(after.lastSeen, before.lastSeen);
});

test('activity: resetBaseline overwrites a stale lastSeen with a clean "now" baseline', () => {
  const groupId = freshGroupId();
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net']);

  // Manually age the record to simulate time having passed with the
  // feature on - resetBaseline must discard this, not build on it.
  const dataFile = path.join(tmpDir, 'activity.json');
  const all = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  all[groupId].participants['alex@s.whatsapp.net'].lastSeen = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(dataFile, JSON.stringify(all));
  assert.equal(activity.getKickCandidates(groupId, 24 * 60 * 60 * 1000).length, 1, 'sanity check: the manually-aged record should be a candidate for a 1-day threshold');

  activity.resetBaseline(groupId, ['alex@s.whatsapp.net']);
  assert.equal(activity.getKickCandidates(groupId, 24 * 60 * 60 * 1000).length, 0, 'resetBaseline must overwrite lastSeen to now, not leave the old value in place');
});
