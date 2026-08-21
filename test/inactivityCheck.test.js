// test/inactivityCheck.test.js
// Direct unit coverage for lib/inactivityCheck.js: checkGroupInactivity()
// against a fake sock (not the full e2e pipeline in test/e2e.test.js) so
// the sweep's own guards/branches can be exercised precisely - the
// sock/isEnabled early-outs, the "0 participants" defensive skip added
// after a real incident, admin exemption, and the normal
// warn-and-mark-warned path - plus checkAllGroupsInactivity(), the
// sweep-every-configured-group driver index.js's periodic setInterval
// calls (same "read currentSock fresh each tick, isolate one group's
// failure from the rest" pattern as lib/vacancyReminder.js's
// checkVacancyReminders()/lib/autoNewlistScheduler.js's checkAutoNewlist(),
// see their own test files for the matching scaffolding this mirrors).
// Related debounced-prune coverage for activity.js itself lives in
// test/activity.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-inactivitycheck-test-'));
// A fixed pool of pre-registered group ids, cycled through by
// freshGroupId() below - ALLOWED_GROUPS has to be known BEFORE any test
// runs (lib/config.js reads it once at require time), same reasoning as
// test/vacancyReminder.test.js/test/autoNewlistScheduler.test.js.
const GROUP_IDS = Array.from({ length: 20 }, (_, i) => `inactivitycheck-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
// Tiny (but still positive - parsePositiveNumberEnv rejects <= 0) warn
// threshold so a participant seeded "now" counts as past-cutoff after
// only a few real milliseconds, instead of needing to wait a real day (the
// default) or fake the clock.
process.env.INACTIVITY_WARN_AFTER_DAYS = '0.000000001'; // ~0.09ms
process.env.INACTIVITY_CHECK_INTERVAL_DAYS = '1'; // irrelevant here - both functions are called directly, not via the timer

const activity = require('../activity');
const { checkGroupInactivity, checkAllGroupsInactivity } = require('../lib/inactivityCheck');

let groupIdx = 0;
function freshGroupId() {
  const id = GROUP_IDS[groupIdx];
  groupIdx += 1;
  if (!id) throw new Error('ran out of pre-registered test group ids - add more to GROUP_IDS above');
  return id;
}

function buildFakeSock({ participants }) {
  const sentMessages = [];
  return {
    sentMessages,
    groupMetadata: async () => ({ participants }),
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: {} };
    },
  };
}

const tinyDelay = () => new Promise((resolve) => setTimeout(resolve, 20));

test('checkGroupInactivity is a no-op when sock is null', async () => {
  const groupId = freshGroupId();
  activity.setEnabled(groupId, true);
  await assert.doesNotReject(() => checkGroupInactivity(null, groupId));
});

test('checkGroupInactivity is a no-op (no network call) when the group has not opted in', async () => {
  const groupId = freshGroupId();
  let called = false;
  const sock = { groupMetadata: async () => { called = true; return { participants: [] }; } };
  await checkGroupInactivity(sock, groupId);
  assert.equal(called, false, 'groupMetadata must not be called for a group that never ran !inactivity on');
});

test('checkGroupInactivity skips the cycle (no prune/seed) if groupMetadata returns 0 participants', async () => {
  const groupId = freshGroupId();
  activity.setEnabled(groupId, true);
  activity.seedParticipants(groupId, ['alex@s.whatsapp.net']);
  const before = activity.getInactiveCandidates(groupId, 0);
  assert.equal(before.length, 1);

  const sock = buildFakeSock({ participants: [] });
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await checkGroupInactivity(sock, groupId);
  } finally {
    console.error = originalError;
  }

  assert.ok(logged.some((line) => /groupMetadata\(\) returned 0 participants/.test(line)));
  // alex must still be tracked exactly as before - not wiped by a bogus
  // empty snapshot, and not reseeded with a fresh "now" baseline either.
  const after = activity.getInactiveCandidates(groupId, 0);
  assert.equal(after.length, 1);
  assert.equal(after[0].lastSeen, before[0].lastSeen);
});

test('checkGroupInactivity sends one tagged warning for a participant past the cutoff, exempts admins, and marks them warned', async () => {
  const groupId = freshGroupId();
  activity.setEnabled(groupId, true);
  const quietId = 'quiet@s.whatsapp.net';
  const adminId = 'admin@s.whatsapp.net';
  activity.seedParticipants(groupId, [quietId, adminId]);
  await tinyDelay(); // let both cross the (tiny) warn threshold

  const sock = buildFakeSock({
    participants: [
      { id: quietId, admin: null },
      { id: adminId, admin: 'admin' },
    ],
  });

  await checkGroupInactivity(sock, groupId);

  assert.equal(sock.sentMessages.length, 1, 'expected exactly one batched warning message');
  const [sent] = sock.sentMessages;
  assert.deepEqual(sent.content.mentions, [quietId], 'the admin must be exempt from the warning');
  assert.match(sent.content.text, new RegExp(`@${quietId.split('@')[0]}`));
  assert.doesNotMatch(sent.content.text, new RegExp(`@${adminId.split('@')[0]}`));

  const warned = activity.getWarned(groupId);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].id, quietId);
});

test('checkGroupInactivity does not re-warn someone already warned (no duplicate message on the next sweep)', async () => {
  const groupId = freshGroupId();
  activity.setEnabled(groupId, true);
  const quietId = 'quiet2@s.whatsapp.net';
  activity.seedParticipants(groupId, [quietId]);
  await tinyDelay();

  const sock = buildFakeSock({ participants: [{ id: quietId, admin: null }] });
  await checkGroupInactivity(sock, groupId); // first sweep: warns
  assert.equal(sock.sentMessages.length, 1);

  await tinyDelay();
  await checkGroupInactivity(sock, groupId); // second sweep: already warned, must stay quiet
  assert.equal(sock.sentMessages.length, 1, 'must not send a second warning for someone already warned');
});

test('checkAllGroupsInactivity(null) (briefly disconnected) is a safe no-op', async () => {
  await assert.doesNotReject(() => checkAllGroupsInactivity(null));
});

test('checkAllGroupsInactivity sweeps every ALLOWED_GROUPS entry, warning only the ones that opted in and are actually due', async () => {
  const groupA = freshGroupId();
  const groupB = freshGroupId();
  activity.setEnabled(groupA, true);
  // groupB deliberately left off - never ran !inactivity on.
  const quietId = 'quiet3@s.whatsapp.net';
  activity.seedParticipants(groupA, [quietId]);
  await tinyDelay();

  const sentByGroup = {};
  const sock = {
    groupMetadata: async (jid) => ({ participants: [{ id: quietId, admin: null }] }),
    sendMessage: async (jid, content) => {
      (sentByGroup[jid] ||= []).push(content);
      return { key: {} };
    },
  };

  await checkAllGroupsInactivity(sock);

  assert.equal((sentByGroup[groupA] || []).length, 1, 'groupA opted in and had someone due - expected one warning');
  assert.equal(sentByGroup[groupB], undefined, 'groupB never opted in - must not be touched at all');
});

test('checkAllGroupsInactivity isolates one group\'s failure from the rest of the sweep', async () => {
  const failingGroup = freshGroupId();
  const okGroup = freshGroupId();
  activity.setEnabled(failingGroup, true);
  activity.setEnabled(okGroup, true);
  const quietId = 'quiet4@s.whatsapp.net';
  activity.seedParticipants(okGroup, [quietId]);
  await tinyDelay();

  const sentByGroup = {};
  const sock = {
    groupMetadata: async (jid) => {
      if (jid === failingGroup) throw new Error('simulated transient network failure');
      return { participants: [{ id: quietId, admin: null }] };
    },
    sendMessage: async (jid, content) => {
      (sentByGroup[jid] ||= []).push(content);
      return { key: {} };
    },
  };

  await assert.doesNotReject(() => checkAllGroupsInactivity(sock));
  assert.equal((sentByGroup[okGroup] || []).length, 1, 'a failure in one group must not stop the rest of the sweep');
});
