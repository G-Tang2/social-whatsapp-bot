// test/inactivityCheck.test.js
// Direct unit coverage for lib/inactivityCheck.js: checkGroupInactivity()
// against a fake sock (not the full e2e pipeline in test/e2e.test.js) so
// the sweep's own guards/branches can be exercised precisely - the
// sock/isEnabled early-outs, the "0 participants" defensive skip added
// after a real incident, admin exemption, and the normal auto-kick path -
// plus checkAllGroupsInactivity(), the sweep-every-configured-group driver
// index.js's periodic setInterval calls (same "read currentSock fresh each
// tick, isolate one group's failure from the rest" pattern as
// lib/vacancyReminder.js's checkVacancyReminders()/
// lib/autoNewlistScheduler.js's checkAutoNewlist(), see their own test
// files for the matching scaffolding this mirrors).
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
// Tiny (but still positive - parsePositiveNumberEnv rejects <= 0) kick
// threshold so a participant seeded "now" counts as past-cutoff after
// only a few real milliseconds, instead of needing to wait the real
// default (~9 months) or fake the clock.
process.env.INACTIVITY_KICK_AFTER_DAYS = '0.000000001'; // ~0.09ms

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
  const kicked = [];
  return {
    kicked,
    groupMetadata: async () => ({ participants }),
    groupParticipantsUpdate: async (jid, ids, action) => {
      kicked.push({ jid, ids, action });
      return ids.map((id) => ({ id, status: '200' }));
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
  const before = activity.getKickCandidates(groupId, 0);
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
  const after = activity.getKickCandidates(groupId, 0);
  assert.equal(after.length, 1);
  assert.equal(after[0].lastSeen, before[0].lastSeen);
});

test('checkGroupInactivity auto-kicks a participant past the cutoff, exempts admins, and clears their tracking', async () => {
  const groupId = freshGroupId();
  activity.setEnabled(groupId, true);
  const quietId = 'quiet@s.whatsapp.net';
  const adminId = 'admin@s.whatsapp.net';
  activity.seedParticipants(groupId, [quietId, adminId]);
  await tinyDelay(); // let both cross the (tiny) kick threshold

  const sock = buildFakeSock({
    participants: [
      { id: quietId, admin: null },
      { id: adminId, admin: 'admin' },
    ],
  });

  await checkGroupInactivity(sock, groupId);

  assert.equal(sock.kicked.length, 1, 'expected exactly one batched removal call');
  const [kick] = sock.kicked;
  assert.deepEqual(kick.ids, [quietId], 'the admin must be exempt from auto-kick');
  assert.equal(kick.action, 'remove');

  // Tracking for the removed member is cleared immediately (not debounced).
  const remaining = activity.getKickCandidates(groupId, 0).map((c) => c.id);
  assert.ok(!remaining.includes(quietId));
});

test('checkGroupInactivity does not remove anyone again if groupParticipantsUpdate fails (retries next sweep instead)', async () => {
  const groupId = freshGroupId();
  activity.setEnabled(groupId, true);
  const quietId = 'quiet2@s.whatsapp.net';
  activity.seedParticipants(groupId, [quietId]);
  await tinyDelay();

  const sock = {
    groupMetadata: async () => ({ participants: [{ id: quietId, admin: null }] }),
    groupParticipantsUpdate: async () => { throw new Error('bot is not a group admin'); },
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(() => checkGroupInactivity(sock, groupId));
  } finally {
    console.error = originalError;
  }

  // A failed removal must NOT clear tracking - the candidate should still
  // be there (and still due) so the next sweep retries instead of forever
  // forgetting about them.
  const stillThere = activity.getKickCandidates(groupId, 0).map((c) => c.id);
  assert.ok(stillThere.includes(quietId));
});

test('checkAllGroupsInactivity(null) (briefly disconnected) is a safe no-op', async () => {
  await assert.doesNotReject(() => checkAllGroupsInactivity(null));
});

test('checkAllGroupsInactivity sweeps every ALLOWED_GROUPS entry, kicking only from the ones that opted in and are actually due', async () => {
  const groupA = freshGroupId();
  const groupB = freshGroupId();
  activity.setEnabled(groupA, true);
  // groupB deliberately left off - never ran !inactivity on.
  const quietId = 'quiet3@s.whatsapp.net';
  activity.seedParticipants(groupA, [quietId]);
  await tinyDelay();

  const kickedByGroup = {};
  const sock = {
    groupMetadata: async (jid) => ({ participants: [{ id: quietId, admin: null }] }),
    groupParticipantsUpdate: async (jid, ids) => {
      (kickedByGroup[jid] ||= []).push(ids);
      return ids.map((id) => ({ id, status: '200' }));
    },
  };

  await checkAllGroupsInactivity(sock);

  assert.equal((kickedByGroup[groupA] || []).length, 1, 'groupA opted in and had someone due - expected one removal call');
  assert.equal(kickedByGroup[groupB], undefined, 'groupB never opted in - must not be touched at all');
});

test('checkAllGroupsInactivity isolates one group\'s failure from the rest of the sweep', async () => {
  const failingGroup = freshGroupId();
  const okGroup = freshGroupId();
  activity.setEnabled(failingGroup, true);
  activity.setEnabled(okGroup, true);
  const quietId = 'quiet4@s.whatsapp.net';
  activity.seedParticipants(okGroup, [quietId]);
  await tinyDelay();

  const kickedByGroup = {};
  const sock = {
    groupMetadata: async (jid) => {
      if (jid === failingGroup) throw new Error('simulated transient network failure');
      return { participants: [{ id: quietId, admin: null }] };
    },
    groupParticipantsUpdate: async (jid, ids) => {
      (kickedByGroup[jid] ||= []).push(ids);
      return ids.map((id) => ({ id, status: '200' }));
    },
  };

  await assert.doesNotReject(() => checkAllGroupsInactivity(sock));
  assert.equal((kickedByGroup[okGroup] || []).length, 1, 'a failure in one group must not stop the rest of the sweep');
});

// The daily sweep is scheduled at a fixed local hour (8pm in the group's
// TIMEZONE) - see index.js's scheduleDailyInactivityCheck(). These pin the
// "later today vs. tomorrow" arithmetic, including a non-UTC zone.
test('msUntilNextDailyTime: before 8pm today, the next run is later today', () => {
  const { msUntilNextDailyTime } = require('../lib/inactivityCheck');
  const now = new Date('2026-10-06T10:00:00Z'); // 10:00 UTC
  assert.equal(msUntilNextDailyTime(now, 20, 'UTC'), 10 * 60 * 60 * 1000);
});

test('msUntilNextDailyTime: after 8pm today, the next run is tomorrow', () => {
  const { msUntilNextDailyTime } = require('../lib/inactivityCheck');
  const now = new Date('2026-10-06T21:00:00Z'); // 21:00 UTC
  assert.equal(msUntilNextDailyTime(now, 20, 'UTC'), 23 * 60 * 60 * 1000);
});

test('msUntilNextDailyTime: exactly 8pm counts as already passed, so the next run is tomorrow', () => {
  const { msUntilNextDailyTime } = require('../lib/inactivityCheck');
  const now = new Date('2026-10-06T20:00:00Z');
  assert.equal(msUntilNextDailyTime(now, 20, 'UTC'), 24 * 60 * 60 * 1000);
});

test('msUntilNextDailyTime: 8pm is measured in the given timezone, not UTC', () => {
  const { msUntilNextDailyTime } = require('../lib/inactivityCheck');
  // 08:00 UTC is 19:00 in Sydney (AEDT, UTC+11 in early October) - one hour to 8pm local.
  const now = new Date('2026-10-06T08:00:00Z');
  assert.equal(msUntilNextDailyTime(now, 20, 'Australia/Sydney'), 60 * 60 * 1000);
});
