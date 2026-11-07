// test/paymentReminder.test.js
// Coverage for lib/paymentReminder.js: the "still owes money" reminder
// that fires whenever a fresh !newlist is started (see
// commands/admin.js's handleNewlist and lib/scheduledListAdvance.js's
// advanceToFreshList, the only two real call sites).
//
// isDueForReminder() is tested directly with controlled `now`/entry
// values - the pure date-threshold logic needs no real store.js round-
// trip. checkPaymentReminders() is tested against a real store.js group
// (via a fake sock), using store.applyListUpdate() to seed duePayments
// entries with an exact, arbitrary `owedSince` directly - much simpler
// than trying to backdate a real !newlist cycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-paymentreminder-test-'));
const GROUP_IDS = Array.from({ length: 20 }, (_, i) => `paymentreminder-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');

const store = require('../store');
const { checkPaymentReminders, isDueForReminder, REMINDER_INTERVAL_MS } = require('../lib/paymentReminder');

let groupIdx = 0;
function freshGroupId() {
  const id = GROUP_IDS[groupIdx];
  groupIdx += 1;
  if (!id) throw new Error('ran out of pre-registered test group ids - add more to GROUP_IDS above');
  return id;
}

function daysAgoIso(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// --- isDueForReminder: pure date-threshold logic ---

test('isDueForReminder: false for an entry with no owedSince at all - nothing to compute an age from', () => {
  assert.equal(isDueForReminder({ name: 'Grace' }, Date.now()), false);
});

test('isDueForReminder: false when owedSince is under 7 days old and never reminded', () => {
  const now = Date.now();
  const entry = { name: 'Grace', owedSince: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString() };
  assert.equal(isDueForReminder(entry, now), false);
});

test('isDueForReminder: true once owedSince is exactly 7+ days old and never reminded', () => {
  const now = Date.now();
  const entry = { name: 'Grace', owedSince: new Date(now - REMINDER_INTERVAL_MS).toISOString() };
  assert.equal(isDueForReminder(entry, now), true);
});

test('isDueForReminder: uses remindedAt (not owedSince) once a reminder has already fired - the 7-day clock restarts from the last reminder', () => {
  const now = Date.now();
  const entry = {
    name: 'Grace',
    owedSince: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), // owes for a month
    remindedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), // but reminded just 3 days ago
  };
  assert.equal(isDueForReminder(entry, now), false, 'expected NOT due yet - only 3 days since the last reminder, despite the debt itself being a month old');
});

test('isDueForReminder: true again once 7+ days have passed since the LAST reminder', () => {
  const now = Date.now();
  const entry = {
    name: 'Grace',
    owedSince: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    remindedAt: new Date(now - REMINDER_INTERVAL_MS).toISOString(),
  };
  assert.equal(isDueForReminder(entry, now), true);
});

// --- checkPaymentReminders: integration against a real store.js group ---

function seedDuePayment(groupId, name, owedSinceIso) {
  store.applyListUpdate(groupId, { attendance: [], waitlist: [], duePayments: [{ name, owedSince: owedSinceIso }] }, 'editor@s.whatsapp.net', true);
}

function makeFakeSock() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: {} };
    },
  };
}

test('checkPaymentReminders: does nothing when nobody owes anything', async () => {
  const groupId = freshGroupId();
  const sock = makeFakeSock();
  await checkPaymentReminders(sock, groupId);
  assert.equal(sock.sentMessages.length, 0);
});

test('checkPaymentReminders: does nothing yet for a debt under 7 days old', async () => {
  const groupId = freshGroupId();
  seedDuePayment(groupId, 'Grace', daysAgoIso(3));
  const sock = makeFakeSock();

  await checkPaymentReminders(sock, groupId);

  assert.equal(sock.sentMessages.length, 0);
});

test('checkPaymentReminders: tags and reminds, then stamps remindedAt, for a debt 7+ days old', async () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Grace', 'grace@s.whatsapp.net', false);
  store.setDate(groupId, daysAgoIso(10));
  store.newList(groupId, daysAgoIso(3), {}); // Grace now owes, since 10 days ago
  const sock = makeFakeSock();

  await checkPaymentReminders(sock, groupId);

  assert.equal(sock.sentMessages.length, 1);
  const sent = sock.sentMessages[0];
  assert.match(sent.content.text, /Grace/);
  assert.deepEqual(sent.content.mentions, ['grace@s.whatsapp.net']);

  const entry = store.getCurrentEvent(groupId).duePayments.find((e) => e.name === 'Grace');
  assert.ok(entry.remindedAt, 'expected remindedAt to be stamped after a successful send');
});

test('checkPaymentReminders: does not re-remind within 7 days of the last reminder', async () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Grace', 'grace@s.whatsapp.net', false);
  store.setDate(groupId, daysAgoIso(10));
  store.newList(groupId, daysAgoIso(3), {});
  const sock = makeFakeSock();

  await checkPaymentReminders(sock, groupId); // first reminder fires
  assert.equal(sock.sentMessages.length, 1);

  await checkPaymentReminders(sock, groupId); // immediately again - should be silent
  assert.equal(sock.sentMessages.length, 1, 'expected no second reminder right after the first');
});

test('checkPaymentReminders: skips an entry with no owedSince at all (predates the field, or added via !update with no date)', async () => {
  const groupId = freshGroupId();
  store.applyListUpdate(groupId, { attendance: [], waitlist: [], duePayments: ['Grace'] }, 'editor@s.whatsapp.net', true); // bare string = no owedSince
  const sock = makeFakeSock();

  await checkPaymentReminders(sock, groupId);

  assert.equal(sock.sentMessages.length, 0);
});

test('checkPaymentReminders: combines multiple qualifying debts into ONE tagged message', async () => {
  const groupId = freshGroupId();
  // Both seeded in ONE applyListUpdate call - calling it twice separately
  // would have each call's pasted list reconcile against (and "pay off")
  // whatever the PREVIOUS call left, since applyListUpdate replaces the
  // whole duePayments list wholesale rather than adding to it.
  store.applyListUpdate(
    groupId,
    { attendance: [], waitlist: [], duePayments: [{ name: 'Grace', owedSince: daysAgoIso(10) }, { name: 'Henry', owedSince: daysAgoIso(8) }] },
    'editor@s.whatsapp.net',
    true
  );
  const sock = makeFakeSock();

  await checkPaymentReminders(sock, groupId);

  assert.equal(sock.sentMessages.length, 1, 'expected one combined message, not one per person');
  assert.match(sock.sentMessages[0].content.text, /Grace/);
  assert.match(sock.sentMessages[0].content.text, /Henry/);
});

test('checkPaymentReminders: a failed send does NOT stamp remindedAt, so it retries on the next check', async () => {
  const groupId = freshGroupId();
  seedDuePayment(groupId, 'Grace', daysAgoIso(10));
  const sock = { sendMessage: async () => { throw new Error('simulated transient failure'); } };

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await checkPaymentReminders(sock, groupId);
  } finally {
    console.error = originalError;
  }

  assert.ok(logged.some((line) => /Failed to send the payment reminder/.test(line)));
  const entry = store.getCurrentEvent(groupId).duePayments.find((e) => e.name === 'Grace');
  assert.equal(entry.remindedAt, undefined, 'expected remindedAt to stay unset after a failed send');
});

test('checkPaymentReminders(sock=null) is a safe no-op', async () => {
  const groupId = freshGroupId();
  seedDuePayment(groupId, 'Grace', daysAgoIso(10));
  await assert.doesNotReject(checkPaymentReminders(null, groupId));
});
