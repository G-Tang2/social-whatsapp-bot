// test/vacancyReminderImage.test.js
// Coverage for the VACANCY_REMINDER_IMAGE_PATH option (lib/vacancyReminder.js's
// sendFirstWarning) - split into its own file/process because
// VACANCY_REMINDER_IMAGE_PATH, like every other lib/config.js setting, is
// read once at require time, so it can't be toggled per-test within
// test/vacancyReminder.test.js (which deliberately leaves it unset to
// cover the plain-text default). See test/vacancyReminderImageMissing.test.js
// for the "file doesn't exist" fallback case, which needs its own separate
// process for the same reason. Same ALLOWED_GROUPS/DATA_DIR/TIMEZONE setup
// as test/vacancyReminder.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-vacancy-image-test-'));
const GROUP_IDS = Array.from({ length: 10 }, (_, i) => `vacancy-image-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
process.env.TIMEZONE = 'UTC';

const fakeImagePath = path.join(tmpDir, 'reminder.jpg');
const fakeImageBytes = Buffer.from('not a real jpeg, just needs to round-trip as bytes');
fs.writeFileSync(fakeImagePath, fakeImageBytes);
process.env.VACANCY_REMINDER_IMAGE_PATH = fakeImagePath;

const store = require('../store');
const { createFakeSock } = require('./helpers/mockBaileys');
const { checkVacancyReminders, FIRST_WARNING_HOURS } = require('../lib/vacancyReminder');

let groupIdx = 0;
function freshGroupId() {
  const id = GROUP_IDS[groupIdx];
  groupIdx += 1;
  if (!id) throw new Error('ran out of pre-registered test group ids - add more to GROUP_IDS above');
  return id;
}

// Same helper as test/vacancyReminder.test.js.
function futureDateTime(hoursFromNow) {
  const target = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  return { isoDate: `${y}-${m}-${d}`, time: `${hh}:${mm} start` };
}

function setUpList(groupId, { hoursFromNow, limit, entryCount = 0 }) {
  const { isoDate, time } = futureDateTime(hoursFromNow);
  store.setDate(groupId, isoDate);
  store.setTime(groupId, time);
  if (limit !== undefined) store.setLimit(groupId, limit);
  for (let i = 0; i < entryCount; i += 1) {
    store.addEntry(groupId, `Player${i}`, `player${i}@s.whatsapp.net`, false, true, true);
  }
}

test('sendFirstWarning attaches the configured image instead of sending plain text', async () => {
  const groupId = freshGroupId();
  const participantIds = ['a@s.whatsapp.net', 'b@s.whatsapp.net'];
  const sock = createFakeSock({ participantIds });
  setUpList(groupId, { hoursFromNow: FIRST_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 1);
  const sent = sock.sentMessages[0].content;
  assert.ok(Buffer.isBuffer(sent.image), 'expected the image buffer to be attached');
  assert.ok(sent.image.equals(fakeImageBytes));
  assert.equal(sent.text, undefined, 'plain text should not be sent alongside an image - it goes in the caption instead');
  assert.match(sent.caption, /sign up/i);
  assert.deepEqual(new Set(sent.mentions), new Set(participantIds));
});

test('re-reads the image fresh from disk on every send, rather than caching it at startup', async () => {
  const groupId = freshGroupId();
  const updatedBytes = Buffer.from('a different image, swapped in without restarting the bot');
  fs.writeFileSync(fakeImagePath, updatedBytes);

  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: FIRST_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 1);
  assert.ok(sock.sentMessages[0].content.image.equals(updatedBytes));
});
