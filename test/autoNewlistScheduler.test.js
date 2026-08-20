// test/autoNewlistScheduler.test.js
// Coverage for lib/autoNewlistScheduler.js: the periodic check that, for
// any group with !autonewlist turned on, automatically starts next week's
// list once this one's social is assumed to have "ended" (see
// commands/autonewlist.js for the toggle).
//
// Same scaffolding as test/vacancyReminder.test.js - a fixed pool of
// pre-registered group ids (ALLOWED_GROUPS has to be known before store.js/
// lib/config.js are required), and TIMEZONE fixed to 'UTC' so a test can
// construct a "started N hours ago" scenario with plain UTC date-math.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-autonewlist-test-'));
const GROUP_IDS = Array.from({ length: 20 }, (_, i) => `autonewlist-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
process.env.TIMEZONE = 'UTC';

const store = require('../store');
const autoNewlist = require('../autoNewlist');
const { AUTO_NEWLIST_DELAY_HOURS } = require('../lib/config');
const { createFakeSock } = require('./helpers/mockBaileys');
const { checkAutoNewlist } = require('../lib/autoNewlistScheduler');

let groupIdx = 0;
function freshGroupId() {
  const id = GROUP_IDS[groupIdx];
  groupIdx += 1;
  if (!id) throw new Error('ran out of pre-registered test group ids - add more to GROUP_IDS above');
  return id;
}

// Builds { isoDate, time } describing a real UTC instant `hoursAgo` hours
// in the past - the mirror image of vacancyReminder.test.js's
// futureDateTime, since this feature only ever acts on a list whose start
// time has already passed.
function pastDateTime(hoursAgo) {
  const target = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  return { isoDate: `${y}-${m}-${d}`, time: `${hh}:${mm} start` };
}

function setUpList(groupId, { hoursAgo, time, location = 'EBC' }) {
  const { isoDate, time: computedTime } = pastDateTime(hoursAgo);
  store.setDate(groupId, isoDate);
  store.setTime(groupId, time !== undefined ? time : computedTime);
  store.setLocation(groupId, location);
  return isoDate;
}

test('does nothing for a group with no date set at all, even with the toggle on', async () => {
  const groupId = freshGroupId();
  autoNewlist.setEnabled(groupId, true);
  const sock = createFakeSock({});
  await checkAutoNewlist(sock);
  assert.equal(sock.sentMessages.length, 0);
});

test('does nothing while the toggle is off (the default), no matter how long ago the social started', async () => {
  const groupId = freshGroupId();
  setUpList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 10 });
  const sock = createFakeSock({});
  await checkAutoNewlist(sock);
  assert.equal(sock.sentMessages.length, 0);
  assert.equal(store.getCurrentEvent(groupId).autoNewlistCreated, false);
});

test('does nothing before the assumed end time (start + delay) has passed', async () => {
  const groupId = freshGroupId();
  autoNewlist.setEnabled(groupId, true);
  // Started less than AUTO_NEWLIST_DELAY_HOURS ago - not "ended" yet.
  const originalDate = setUpList(groupId, { hoursAgo: Math.max(AUTO_NEWLIST_DELAY_HOURS - 1, 0.1) });
  const sock = createFakeSock({});
  await checkAutoNewlist(sock);
  assert.equal(sock.sentMessages.length, 0);
  assert.equal(store.getCurrentEvent(groupId).date, originalDate);
});

test('starts next week\'s list once past the assumed end time, carrying forward details and regulars, and posts it', async () => {
  const groupId = freshGroupId();
  autoNewlist.setEnabled(groupId, true);
  store.setRegularPlayers(groupId, ['Alice']);
  const originalDate = setUpList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 1, location: 'EBC' });

  const sock = createFakeSock({});
  await checkAutoNewlist(sock);

  const event = store.getCurrentEvent(groupId);
  const [y, m, d] = originalDate.split('-').map(Number);
  const expected = new Date(Date.UTC(y, m - 1, d));
  expected.setUTCDate(expected.getUTCDate() + 7);
  const expectedDate = `${expected.getUTCFullYear()}-${String(expected.getUTCMonth() + 1).padStart(2, '0')}-${String(expected.getUTCDate()).padStart(2, '0')}`;

  assert.equal(event.date, expectedDate);
  assert.equal(event.location, 'EBC');
  // autoNewlistCreated is back to false here - not a bug: newList() resets
  // it for the FRESH cycle it just started, same as notifiedVacancy48h.
  // What actually proves the one-shot guard worked is the next test below
  // (a second check right after doesn't send a second message).
  assert.equal(event.autoNewlistCreated, false);
  assert.ok(event.entries.some((e) => e.name === 'Alice'));
  assert.equal(sock.sentMessages.length, 1);
  assert.equal(sock.sentMessages[0].jid, groupId);
});

test('a second check right after does not double-fire', async () => {
  const groupId = freshGroupId();
  autoNewlist.setEnabled(groupId, true);
  setUpList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 1 });

  const sock = createFakeSock({});
  await checkAutoNewlist(sock);
  assert.equal(sock.sentMessages.length, 1);

  await checkAutoNewlist(sock);
  assert.equal(sock.sentMessages.length, 1); // still just the one - the new list starts 7 days out, not past its own end time
});

test('an unparseable !time is skipped without crashing', async () => {
  const groupId = freshGroupId();
  autoNewlist.setEnabled(groupId, true);
  setUpList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 1, time: 'TBC' });

  const sock = createFakeSock({});
  await checkAutoNewlist(sock);
  assert.equal(sock.sentMessages.length, 0);
  assert.equal(store.getCurrentEvent(groupId).autoNewlistCreated, false);
});
