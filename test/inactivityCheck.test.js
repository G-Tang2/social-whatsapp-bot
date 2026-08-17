// test/inactivityCheck.test.js
// Direct unit coverage for lib/inactivityCheck.js's checkGroupInactivity(),
// against a fake sock (not the full e2e pipeline in test/e2e.test.js) so
// the sweep's own guards/branches can be exercised precisely: the
// sock/isEnabled early-outs, the "0 participants" defensive skip added
// after a real incident, admin exemption, and the normal
// warn-and-mark-warned path. Related debounced-prune coverage for the same
// incident lives in test/activity-spam.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-inactivitycheck-test-'));
process.env.DATA_DIR = tmpDir;
// Tiny (but still positive - parsePositiveNumberEnv rejects <= 0) warn
// threshold so a participant seeded "now" counts as past-cutoff after
// only a few real milliseconds, instead of needing to wait a real day (the
// default) or fake the clock (which these tests, unlike the workflow
// scripts elsewhere in this project, are actually free to do - but a tiny
// real delay is simpler and just as reliable here).
process.env.INACTIVITY_WARN_AFTER_DAYS = '0.000000001'; // ~0.09ms
process.env.INACTIVITY_CHECK_INTERVAL_DAYS = '1'; // irrelevant here - checkGroupInactivity is called directly, not via the timer

const activity = require('../activity');
const { checkGroupInactivity } = require('../lib/inactivityCheck');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `inactivitycheck-test-${groupCounter}@g.us`;
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
