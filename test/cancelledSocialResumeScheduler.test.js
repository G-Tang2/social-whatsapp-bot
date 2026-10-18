// test/cancelledSocialResumeScheduler.test.js
// Coverage for lib/cancelledSocialResumeScheduler.js: the periodic check
// that automatically starts a fresh, non-cancelled list once the LAST of a
// !cancelsocial'd group's cancelled weeks is assumed to have "ended" - see
// commands/admin.js's handleCancelSocial for the typed `!cancelsocial
// [weeks]` command this resumes from.
//
// Same scaffolding as test/autoNewlistScheduler.test.js - a fixed pool of
// pre-registered group ids (ALLOWED_GROUPS has to be known before store.js/
// lib/config.js are required), and TIMEZONE fixed to 'UTC' so a test can
// construct a "started N hours ago" scenario with plain UTC date-math.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-cancelledresume-test-'));
const GROUP_IDS = Array.from({ length: 20 }, (_, i) => `cancelledresume-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
process.env.TIMEZONE = 'UTC';

const store = require('../store');
const { AUTO_NEWLIST_DELAY_HOURS } = require('../lib/config');
const { createFakeSock } = require('./helpers/mockBaileys');
const { checkCancelledSocialResume } = require('../lib/cancelledSocialResumeScheduler');

let groupIdx = 0;
function freshGroupId() {
  const id = GROUP_IDS[groupIdx];
  groupIdx += 1;
  if (!id) throw new Error('ran out of pre-registered test group ids - add more to GROUP_IDS above');
  return id;
}

// Builds { isoDate, time } describing a real UTC instant `hoursAgo` hours
// in the past - same helper as test/autoNewlistScheduler.test.js, since
// this feature only ever acts on a cancelled week whose start time has
// already passed.
function pastDateTime(hoursAgo) {
  const target = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  return { isoDate: `${y}-${m}-${d}`, time: `${hh}:${mm} start` };
}

function setUpCancelledList(groupId, { hoursAgo, time, location = 'EBC', weeks = 1 }) {
  const { isoDate, time: computedTime } = pastDateTime(hoursAgo);
  store.setDate(groupId, isoDate);
  store.setTime(groupId, time !== undefined ? time : computedTime);
  store.setLocation(groupId, location);
  store.cancelSocial(groupId, weeks);
  return isoDate;
}

test('does nothing for a group that is not cancelled at all', async () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-20');
  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);
  assert.equal(sock.sentMessages.length, 0);
});

test('does nothing before the assumed end time (start + delay) of the LAST cancelled week has passed', async () => {
  const groupId = freshGroupId();
  // Started less than AUTO_NEWLIST_DELAY_HOURS ago - not "ended" yet.
  const originalDate = setUpCancelledList(groupId, { hoursAgo: Math.max(AUTO_NEWLIST_DELAY_HOURS - 1, 0.1) });
  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);
  assert.equal(sock.sentMessages.length, 0);
  assert.equal(store.getCurrentEvent(groupId).date, originalDate);
  assert.equal(store.getCurrentEvent(groupId).cancelled, true);
});

test('starts a fresh, non-cancelled list one week out once past the assumed end time, for a plain 1-week cancellation', async () => {
  const groupId = freshGroupId();
  store.setRegularPlayers(groupId, ['Alice']);
  const originalDate = setUpCancelledList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 1, location: 'EBC', weeks: 1 });

  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);

  const event = store.getCurrentEvent(groupId);
  const [y, m, d] = originalDate.split('-').map(Number);
  const expected = new Date(Date.UTC(y, m - 1, d));
  expected.setUTCDate(expected.getUTCDate() + 7);
  const expectedDate = `${expected.getUTCFullYear()}-${String(expected.getUTCMonth() + 1).padStart(2, '0')}-${String(expected.getUTCDate()).padStart(2, '0')}`;

  assert.equal(event.date, expectedDate);
  assert.equal(event.location, 'EBC');
  assert.equal(event.cancelled, false);
  assert.ok(event.entries.some((e) => e.name === 'Alice'));
  assert.equal(sock.sentMessages.length, 1);
  assert.equal(sock.sentMessages[0].jid, groupId);
});

// The real point of a multi-week cancellation: the resume only fires once
// the LAST cancelled week's assumed end-time has passed, not the first.
test('a 3-week cancellation does NOT resume once just the FIRST week has "ended"', async () => {
  const groupId = freshGroupId();
  setUpCancelledList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 1, weeks: 3 });

  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);

  assert.equal(sock.sentMessages.length, 0);
  assert.equal(store.getCurrentEvent(groupId).cancelled, true);
});

test('a 3-week cancellation resumes 3 weeks out, once the LAST cancelled week has "ended"', async () => {
  const groupId = freshGroupId();
  // The LAST (3rd) cancelled week is 2 weeks after the original date - set
  // the ORIGINAL date 2 weeks + (delay + 1h) before now, so that 3rd
  // week's own start instant is already past the assumed end time.
  const hoursAgo = 2 * 7 * 24 + AUTO_NEWLIST_DELAY_HOURS + 1;
  const originalDate = setUpCancelledList(groupId, { hoursAgo, weeks: 3 });

  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);

  const event = store.getCurrentEvent(groupId);
  const [y, m, d] = originalDate.split('-').map(Number);
  const expected = new Date(Date.UTC(y, m - 1, d));
  expected.setUTCDate(expected.getUTCDate() + 21); // 3 weeks after the original
  const expectedDate = `${expected.getUTCFullYear()}-${String(expected.getUTCMonth() + 1).padStart(2, '0')}-${String(expected.getUTCDate()).padStart(2, '0')}`;

  assert.equal(event.date, expectedDate);
  assert.equal(event.cancelled, false);
  assert.equal(sock.sentMessages.length, 1);
});

test('a second check right after does not double-fire', async () => {
  const groupId = freshGroupId();
  setUpCancelledList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 1, weeks: 1 });

  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);
  assert.equal(sock.sentMessages.length, 1);

  await checkCancelledSocialResume(sock);
  assert.equal(sock.sentMessages.length, 1); // still just the one - the new list starts 7 days out, not past its own end time, and isn't cancelled anyway
});

test('an unparseable !time is skipped without crashing', async () => {
  const groupId = freshGroupId();
  setUpCancelledList(groupId, { hoursAgo: AUTO_NEWLIST_DELAY_HOURS + 1, time: 'TBC', weeks: 1 });

  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);
  assert.equal(sock.sentMessages.length, 0);
  assert.equal(store.getCurrentEvent(groupId).cancelled, true);
});

test('a cancellation from before this feature existed (cancelledWeeks 0/undefined) is left alone, not auto-resumed', async () => {
  const groupId = freshGroupId();
  const { isoDate, time } = pastDateTime(AUTO_NEWLIST_DELAY_HOURS + 1);
  store.setDate(groupId, isoDate);
  store.setTime(groupId, time);
  // Directly wipe the list and mark it cancelled WITHOUT going through
  // cancelSocial()'s own weeks handling, to simulate data saved before
  // this field existed.
  store.cancelSocial(groupId, 1);
  const all = JSON.parse(fs.readFileSync(path.join(tmpDir, 'lists.json'), 'utf8'));
  delete all[groupId].current.cancelledWeeks;
  fs.writeFileSync(path.join(tmpDir, 'lists.json'), JSON.stringify(all, null, 2));

  const sock = createFakeSock({});
  await checkCancelledSocialResume(sock);
  assert.equal(sock.sentMessages.length, 0);
  assert.equal(store.getCurrentEvent(groupId).cancelled, true);
});
