// test/vacancyReminder.test.js
// Coverage for lib/vacancyReminder.js: the periodic check that warns a
// group about a real risk of empty courts (see commands/admin.js's
// !courtcanceller for the companion admin command).
//
// Requires ALLOWED_GROUPS/DATA_DIR/TIMEZONE to be set via process.env
// BEFORE store.js/lib/vacancyReminder.js are required, since both read
// their config once at require time - same reason test/e2e.test.js does
// its own setup at the top of the file rather than inside a test.
// TIMEZONE is fixed to 'UTC' so a test can construct a "starts in N hours"
// scenario with plain UTC date-math, without needing real-timezone offset
// reasoning.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-vacancy-test-'));
// A fixed pool of pre-registered group ids, cycled through by
// freshGroupId() below - ALLOWED_GROUPS has to be known BEFORE any test
// runs (lib/config.js reads it once at require time), so tests can't each
// invent their own arbitrary id the way most other test files do.
const GROUP_IDS = Array.from({ length: 20 }, (_, i) => `vacancy-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
process.env.TIMEZONE = 'UTC';

const store = require('../store');
const { createFakeSock } = require('./helpers/mockBaileys');
const { checkVacancyReminders, computeVacancies, MIN_VACANCIES, CANCEL_WARNING_HOURS } = require('../lib/vacancyReminder');

let groupIdx = 0;
function freshGroupId() {
  const id = GROUP_IDS[groupIdx];
  groupIdx += 1;
  if (!id) throw new Error('ran out of pre-registered test group ids - add more to GROUP_IDS above');
  return id;
}

// Builds { isoDate, time } describing a real UTC instant `hoursFromNow`
// hours from the moment it's called - fed straight into store.js's
// setDate/setTime so the resulting list "starts" at a real, deterministic
// offset from whenever the test actually runs, without needing to fake
// the clock lib/vacancyReminder.js itself reads (Date.now()).
function futureDateTime(hoursFromNow) {
  const target = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  return { isoDate: `${y}-${m}-${d}`, time: `${hh}:${mm} start` };
}

// Sets up a list that's `hoursFromNow` hours from starting, with `limit`
// (or no cap at all, if omitted) and `entryCount` people already on it.
function setUpList(groupId, { hoursFromNow, limit, entryCount = 0 }) {
  const { isoDate, time } = futureDateTime(hoursFromNow);
  store.setDate(groupId, isoDate);
  store.setTime(groupId, time);
  if (limit !== undefined) store.setLimit(groupId, limit);
  for (let i = 0; i < entryCount; i += 1) {
    store.addEntry(groupId, `Player${i}`, `player${i}@s.whatsapp.net`, false, true, true);
  }
}

test('computeVacancies: null when no limit is set - "vacant spots" is not a meaningful concept', () => {
  assert.equal(computeVacancies({ limit: null, entries: [] }), null);
});

test('computeVacancies: limit minus current headcount, floored at 0', () => {
  assert.equal(computeVacancies({ limit: 10, entries: [1, 2, 3] }), 7);
  assert.equal(computeVacancies({ limit: 10, entries: Array(12).fill(0) }), 0); // over capacity, not negative
});

test('does nothing for a group with no date set at all', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net', 'b@s.whatsapp.net'] });
  await checkVacancyReminders(sock);
  assert.equal(sock.sentMessages.length, 0);
});

test('does nothing when no limit is set, no matter how close to start time', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: 10, limit: null, entryCount: 0 });
  await checkVacancyReminders(sock);
  assert.equal(sock.sentMessages.length, 0);
});

test(`does nothing when vacancies are below MIN_VACANCIES (${MIN_VACANCIES})`, async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: 10, limit: 10, entryCount: 10 - (MIN_VACANCIES - 1) }); // one short of the threshold
  await checkVacancyReminders(sock);
  assert.equal(sock.sentMessages.length, 0);
});

// The group-wide warning's own trigger is a FIXED wall-clock date+time -
// FIRST_WARNING_DAYS_BEFORE days before the social's own date, at
// FIRST_WARNING_HOUR:FIRST_WARNING_MINUTE local time (see
// lib/vacancyReminder.js) - not a smooth "N hours before start" countdown.
// That makes picking a test offset slightly less obvious than a pure-hours
// threshold would be: an offset has to be either comfortably LESS than a
// day (so the computed trigger date is unambiguously still in the past
// relative to right now, whatever the real wall-clock hour happens to be
// when this suite runs) or comfortably MORE than
// FIRST_WARNING_DAYS_BEFORE*24 hours PLUS a full extra day (so the
// trigger is unambiguously still in the future) - 10 and 80 below satisfy
// those margins unconditionally, not just "usually".
test('does nothing yet when the group-wide trigger (2 days before the social, at 4pm) hasn\'t arrived, even with plenty of vacancies', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: 80, limit: 10, entryCount: 0 });
  await checkVacancyReminders(sock);
  assert.equal(sock.sentMessages.length, 0);
});

test('sends the group-wide warning once vacancies>=MIN and the 2-days-before-at-4pm trigger has arrived, tagging every participant', async () => {
  const groupId = freshGroupId();
  const participantIds = ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net'];
  const sock = createFakeSock({ participantIds });
  setUpList(groupId, { hoursFromNow: 10, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 1);
  const sent = sock.sentMessages[0];
  assert.match(sent.content.text, /sign up/i);
  assert.deepEqual(new Set(sent.content.mentions), new Set(participantIds));
  assert.equal(store.getCurrentEvent(groupId).notifiedVacancy50h, true);
});

test('the group-wide warning fires AT MOST ONCE per list cycle, even across repeated checks', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: 10, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);
  await checkVacancyReminders(sock);
  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 1, 'expected exactly one group-wide warning, not one per check');
});

test('a fresh !newlist resets notifiedVacancy50h, allowing the warning to fire again for the new cycle', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: 10, limit: 10, entryCount: 0 });
  await checkVacancyReminders(sock);
  assert.equal(sock.sentMessages.length, 1);

  const { isoDate, time } = futureDateTime(10);
  store.newList(groupId, isoDate, { time });
  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 2, 'expected a second group-wide warning for the new list cycle');
});

test(`does nothing for the cancel warning yet when more than ${CANCEL_WARNING_HOURS} hours remain`, async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  store.setCourtCanceller(groupId, { jid: 'canceller@s.whatsapp.net' });
  setUpList(groupId, { hoursFromNow: CANCEL_WARNING_HOURS + 5, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  // Past the group-wide warning's own (earlier) 2-days-before-at-4pm
  // trigger, so IT still fires here - just not the cancel-specific one
  // yet, which is gated on the social's real start time instead.
  assert.equal(sock.sentMessages.length, 1);
  assert.doesNotMatch(sock.sentMessages[0].content.text, /cancel some courts/i);
});

test('sends the cancel warning to the configured court-canceller once within CANCEL_WARNING_HOURS', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  store.setCourtCanceller(groupId, { jid: 'canceller@s.whatsapp.net' });
  setUpList(groupId, { hoursFromNow: CANCEL_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  const cancelMsg = sock.sentMessages.find((m) => /cancel some courts/i.test(m.content.text || ''));
  assert.ok(cancelMsg, 'expected a court-cancellation warning');
  assert.deepEqual(cancelMsg.content.mentions, ['canceller@s.whatsapp.net']);
  assert.equal(store.getCurrentEvent(groupId).notifiedVacancyCancelWarning, true);
});

test('does NOT send the cancel warning when no court-canceller is configured, and keeps the flag false so it keeps trying', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: CANCEL_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  assert.ok(!sock.sentMessages.some((m) => /cancel some courts/i.test(m.content.text || '')));
  assert.equal(store.getCurrentEvent(groupId).notifiedVacancyCancelWarning, false);
});

test('a bot outage through the group-wide trigger still catches up: both warnings fire in the same check once already inside CANCEL_WARNING_HOURS', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  store.setCourtCanceller(groupId, { jid: 'canceller@s.whatsapp.net' });
  setUpList(groupId, { hoursFromNow: CANCEL_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 2, 'expected both the group-wide AND the cancel warning');
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.notifiedVacancy50h, true);
  assert.equal(event.notifiedVacancyCancelWarning, true);
});

test('does nothing once the social has already started, even with plenty of vacancies', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  store.setCourtCanceller(groupId, { jid: 'canceller@s.whatsapp.net' });
  setUpList(groupId, { hoursFromNow: -1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 0);
});

test('an unparseable !time is skipped entirely, without throwing, even with everything else eligible', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  store.setDate(groupId, '2026-08-26');
  store.setTime(groupId, 'TBC'); // no recognizable time anywhere in this text
  store.setLimit(groupId, 10);

  await assert.doesNotReject(checkVacancyReminders(sock));
  assert.equal(sock.sentMessages.length, 0);
});

test('checkVacancyReminders(null) (briefly disconnected) is a safe no-op', async () => {
  await assert.doesNotReject(checkVacancyReminders(null));
});
