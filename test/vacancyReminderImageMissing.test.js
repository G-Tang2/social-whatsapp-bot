// test/vacancyReminderImageMissing.test.js
// Coverage for VACANCY_REMINDER_IMAGE_PATH pointing at a file that doesn't
// exist (or isn't readable) - lib/vacancyReminder.js's readReminderImage()
// must fall back to the plain-text message rather than let a bad path
// silently swallow the warning entirely. Own file/process, same reasoning
// as test/vacancyReminderImage.test.js: the config value is read once at
// require time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-vacancy-image-missing-test-'));
const GROUP_IDS = Array.from({ length: 5 }, (_, i) => `vacancy-image-missing-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
process.env.TIMEZONE = 'UTC';
process.env.VACANCY_REMINDER_IMAGE_PATH = path.join(tmpDir, 'does-not-exist.jpg');

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

test('falls back to plain text (and logs, but does not throw) when VACANCY_REMINDER_IMAGE_PATH points at a missing file', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net'] });
  setUpList(groupId, { hoursFromNow: FIRST_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await assert.doesNotReject(() => checkVacancyReminders(sock));
  } finally {
    console.error = originalError;
  }

  assert.equal(sock.sentMessages.length, 1);
  const sent = sock.sentMessages[0].content;
  assert.equal(sent.image, undefined);
  assert.match(sent.text, /sign up/i);
  assert.ok(logged.some((line) => /Couldn't read VACANCY_REMINDER_IMAGE_PATH/.test(line)));
});
