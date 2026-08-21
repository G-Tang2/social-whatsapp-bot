// test/vacancyReminderGif.test.js
// Coverage for VACANCY_REMINDER_IMAGE_PATH pointing at an .mp4 file -
// lib/vacancyReminder.js's readReminderMedia() should route it through
// `video` + `gifPlayback: true` (WhatsApp's own "GIF" - a muted, looping
// video, since WhatsApp has no real .gif message type) instead of the
// plain `image` field test/vacancyReminderImage.test.js covers. Own
// file/process, same reasoning as that file: the config value is read
// once at require time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-vacancy-gif-test-'));
const GROUP_IDS = Array.from({ length: 5 }, (_, i) => `vacancy-gif-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
process.env.TIMEZONE = 'UTC';

const fakeVideoPath = path.join(tmpDir, 'reminder.mp4');
const fakeVideoBytes = Buffer.from('not a real mp4, just needs to round-trip as bytes');
fs.writeFileSync(fakeVideoPath, fakeVideoBytes);
process.env.VACANCY_REMINDER_IMAGE_PATH = fakeVideoPath;

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

test('sendFirstWarning sends an .mp4 VACANCY_REMINDER_IMAGE_PATH as a looping video, not a static image', async () => {
  const groupId = freshGroupId();
  const participantIds = ['a@s.whatsapp.net', 'b@s.whatsapp.net'];
  const sock = createFakeSock({ participantIds });
  setUpList(groupId, { hoursFromNow: FIRST_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  assert.equal(sock.sentMessages.length, 1);
  const sent = sock.sentMessages[0].content;
  assert.equal(sent.image, undefined, 'an .mp4 must not be sent via the image field');
  assert.ok(Buffer.isBuffer(sent.video), 'expected the video buffer to be attached');
  assert.ok(sent.video.equals(fakeVideoBytes));
  assert.equal(sent.gifPlayback, true, 'gifPlayback is what makes WhatsApp render this as a looping "GIF"');
  assert.match(sent.caption, /sign up/i);
  assert.deepEqual(new Set(sent.mentions), new Set(participantIds));
});
