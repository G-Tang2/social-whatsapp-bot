// test/vacancyReminderCancelWarningMedia.test.js
// Coverage for the VACANCY_CANCEL_WARNING_MEDIA_PATH option (lib/vacancyReminder.js's
// sendCancelWarning) - own file/process, same reasoning as
// test/vacancyReminderImage.test.js/test/vacancyReminderGif.test.js: the
// config value is read once at require time, so it can't be toggled
// per-test within test/vacancyReminder.test.js (which deliberately leaves
// it unset to cover the plain-text default).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-vacancy-cancel-media-test-'));
const GROUP_IDS = Array.from({ length: 5 }, (_, i) => `vacancy-cancel-media-test-${i + 1}@g.us`);
process.env.DATA_DIR = tmpDir;
process.env.ALLOWED_GROUPS = GROUP_IDS.join(',');
process.env.TIMEZONE = 'UTC';

const fakeVideoPath = path.join(tmpDir, 'cancel.mp4');
const fakeVideoBytes = Buffer.from('not a real mp4, just needs to round-trip as bytes');
fs.writeFileSync(fakeVideoPath, fakeVideoBytes);
process.env.VACANCY_CANCEL_WARNING_MEDIA_PATH = fakeVideoPath;

const store = require('../store');
const { createFakeSock } = require('./helpers/mockBaileys');
const { checkVacancyReminders, CANCEL_WARNING_HOURS } = require('../lib/vacancyReminder');

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

// hoursFromNow is deliberately within BOTH FIRST_WARNING_HOURS and
// CANCEL_WARNING_HOURS (same setup test/vacancyReminder.test.js's own
// cancel-warning tests use) - so both warnings fire in the same check;
// find() picks out the cancel-warning message specifically rather than
// assuming it's the only one sent.
test('sendCancelWarning sends the configured .mp4 as a looping video, tagging only the court-canceller', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ participantIds: ['a@s.whatsapp.net', 'canceller@s.whatsapp.net'] });
  store.setCourtCanceller(groupId, { jid: 'canceller@s.whatsapp.net' });
  setUpList(groupId, { hoursFromNow: CANCEL_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  const cancelMsg = sock.sentMessages.find((m) => /cancel some courts/i.test(m.content.caption || ''));
  assert.ok(cancelMsg, 'expected a court-cancellation warning');
  const sent = cancelMsg.content;
  assert.equal(sent.image, undefined, 'an .mp4 must not be sent via the image field');
  assert.ok(Buffer.isBuffer(sent.video), 'expected the video buffer to be attached');
  assert.ok(sent.video.equals(fakeVideoBytes));
  assert.equal(sent.gifPlayback, true, 'gifPlayback is what makes WhatsApp render this as a looping "GIF"');
  assert.equal(sent.text, undefined, 'plain text should not be sent alongside a video - it goes in the caption instead');
  assert.deepEqual(sent.mentions, ['canceller@s.whatsapp.net'], 'only the court-canceller should be tagged, not the whole group');
});

test('re-reads the cancel-warning media fresh from disk on every send, rather than caching it at startup', async () => {
  const groupId = freshGroupId();
  const updatedBytes = Buffer.from('a different video, swapped in without restarting the bot');
  fs.writeFileSync(fakeVideoPath, updatedBytes);

  const sock = createFakeSock({ participantIds: ['canceller@s.whatsapp.net'] });
  store.setCourtCanceller(groupId, { jid: 'canceller@s.whatsapp.net' });
  setUpList(groupId, { hoursFromNow: CANCEL_WARNING_HOURS - 1, limit: 10, entryCount: 0 });

  await checkVacancyReminders(sock);

  const cancelMsg = sock.sentMessages.find((m) => /cancel some courts/i.test(m.content.caption || ''));
  assert.ok(cancelMsg, 'expected a court-cancellation warning');
  assert.ok(cancelMsg.content.video.equals(updatedBytes));
});
