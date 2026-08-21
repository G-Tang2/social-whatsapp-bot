// lib/vacancyReminder.js
// Periodically checks every configured group's current list for a real
// risk of empty courts, and sends two escalating warnings if there's
// still plenty of room as the social's start time closes in:
//   - 52 hours out, 6+ vacant spots: @-mentions the WHOLE group, asking
//     people to sign up or courts may be cancelled - with an image/video
//     attached if VACANCY_REMINDER_IMAGE_PATH is set (see
//     readReminderMedia() below), plain text otherwise.
//   - 26 hours out, 6+ vacant spots: @-mentions the specific person
//     configured via !courtcanceller (commands/admin.js), as a heads-up
//     to actually go cancel the courts if nobody's filled in by then -
//     with its own independently configured image/video attached if
//     VACANCY_CANCEL_WARNING_MEDIA_PATH is set, plain text otherwise.
// Each warning fires AT MOST ONCE per list cycle - store.js's
// notifiedVacancy50h/notifiedVacancyCancelWarning flags on the CURRENT
// event, reset back to false whenever !newlist starts a fresh one - no
// matter how often checkVacancyReminders() itself runs. See index.js for
// the periodic setInterval that drives this, same "read currentSock fresh
// each tick, tolerate a briefly-null sock between reconnects" pattern as
// lib/lastSeenStatus.js's updateLastSeenStatus().
//
// Needs a REAL computable start instant, which the list's `date` alone
// isn't - see dates.js's parseTimeOfDay()/zonedDateTimeToUtc(), and their
// own doc comments for the best-effort nature of parsing the freeform
// !time text (nothing else in this codebase parses it - !time has always
// been pure display text). A list whose !time doesn't contain a
// recognizable time is simply skipped for vacancy reminders, with a
// console warning (see warnUnparseableTimeOnce below) so that's a visible
// operational gap, not a silent one.

const fs = require('fs');
const path = require('path');
const { ALLOWED_GROUPS, TIMEZONE, VACANCY_REMINDER_IMAGE_PATH, VACANCY_CANCEL_WARNING_MEDIA_PATH } = require('./config');
const { getCurrentEvent, getCourtCanceller, markVacancy50hNotified, markVacancyCancelWarningNotified } = require('../store');
const { parseTimeOfDay, zonedDateTimeToUtc } = require('../dates');

// The two thresholds/floor from the actual feature request this
// implements: mention everyone at 52 hours out, mention the designated
// court-canceller at 26 hours out, both gated on 6+ vacant spots.
const MIN_VACANCIES = 6;
const FIRST_WARNING_HOURS = 52;
const CANCEL_WARNING_HOURS = 26;

// `limit == null` means no cap is set at all - "vacant spots" isn't a
// meaningful concept without one (see store.js's `current.limit` doc
// comment), so this deliberately returns null (not 0/Infinity) to let
// checkOneGroup tell "no cap configured" apart from "cap configured, but
// full" - both real states, only one of which vacancy reminders apply to.
function computeVacancies(event) {
  if (event.limit == null) return null;
  return Math.max(0, event.limit - event.entries.length);
}

// A group whose !time text can't be parsed only gets warned about it ONCE
// per distinct (date, time) combination it's actually eligible for a
// reminder on - not every single check interval forever, which would
// bury the console in repeats of the same line until someone fixes
// !time. In-memory only (not persisted) - a bot restart just re-warns
// once more, which is harmless.
const warnedUnparseableTime = new Set();
function warnUnparseableTimeOnce(groupId, event, vacancies) {
  const key = `${groupId}:${event.date}:${event.time}`;
  if (warnedUnparseableTime.has(key)) return;
  warnedUnparseableTime.add(key);
  console.error(
    `[vacancyReminder] Group ${groupId}'s current list has ${vacancies} vacant spots but !time (${event.time ? `"${event.time}"` : 'not set'}) couldn't be read as a real start time - vacancy reminders are skipped until an admin re-sets !time with a recognizable time in it (e.g. "8PM start").`
  );
}

// An animated "GIF" isn't a real message type on WhatsApp - there's no
// .gif support at all. What looks like one is actually a muted, looping
// MP4 video with the `gifPlayback` flag set (see sendFirstWarning below) -
// Baileys doesn't transcode anything for you, so VACANCY_REMINDER_IMAGE_PATH
// has to already point at a real .mp4 file for this, not a raw .gif. If
// you're starting from an actual .gif, convert it first, e.g.:
//   ffmpeg -i reminder.gif -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" reminder.mp4
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

// Reads `mediaPath` (VACANCY_REMINDER_IMAGE_PATH for sendFirstWarning,
// VACANCY_CANCEL_WARNING_MEDIA_PATH for sendCancelWarning - see both
// below) fresh off disk (not cached at startup, so swapping the file
// takes effect on the very next warning without a restart) - returns
// { buffer, isVideo }, or null if unset, missing, or unreadable, in which
// case the caller just falls back to a plain-text message like it always
// has. Logged (not thrown) on failure - a bad path should never be the
// reason the actual warning doesn't go out; `envVarName` (just the
// setting's own name, e.g. "VACANCY_REMINDER_IMAGE_PATH") is only used to
// make that log line point at the right one of the two independent
// settings. `isVideo` (from the file extension - see VIDEO_EXTENSIONS
// above) picks the message shape the caller sends it as: `video` +
// `gifPlayback: true` for a looping "GIF"-style clip, or plain `image`
// for anything else (jpg/png/etc).
function readReminderMedia(mediaPath, envVarName) {
  if (!mediaPath) return null;
  try {
    const buffer = fs.readFileSync(mediaPath);
    const isVideo = VIDEO_EXTENSIONS.has(path.extname(mediaPath).toLowerCase());
    return { buffer, isVideo };
  } catch (err) {
    console.error(`[vacancyReminder] Couldn't read ${envVarName} ("${mediaPath}") - sending the warning as plain text instead:`, err.message);
    return null;
  }
}

// @-mentions EVERY current member of `groupId` - the 50-hour "plenty of
// spots" warning is a broadcast to the whole group, not just people
// already on the list (the entire point is reaching people who AREN'T
// signed up yet). Same `{ text, mentions }` shape as
// lib/helpers.js's formatPromotedMessage - WhatsApp needs the "@<number>"
// tokens actually present in the text for the mention to render/highlight
// for each tagged person, not just their JID listed in `mentions` alone.
async function sendFirstWarning(sock, groupId, vacancies) {
  const metadata = await sock.groupMetadata(groupId);
  const participantIds = (metadata.participants || []).map((p) => p.id);
  // WhatsApp's own "@all" - restricted to group ADMINS once a group has
  // more than 32 members (see
  // https://www.macrumors.com/2026/08/04/whatsapp-adds-all-mentions-and-poll-upgrades/),
  // which is fine here: same requirement spam-filter deletion already has
  // (see spam.js's doc comment) - the bot's own WhatsApp account needs to
  // be a group admin for this message to actually reach everyone. `mentions`
  // still carries every participant's JID (unaffected by the visible "@all"
  // text) so the notification itself doesn't depend on WhatsApp rendering
  // any special "@all" chip - only on the bot's admin status.
  const spotWord = vacancies === 1 ? 'spot' : 'spots';
  const text = `@all 📢 *${vacancies} ${spotWord}* still open! Plenty of room for you (and your friends) - sign up soon, or we'll have to cancel the courts tomorrow, and nobody wants that.`;
  const media = readReminderMedia(VACANCY_REMINDER_IMAGE_PATH, 'VACANCY_REMINDER_IMAGE_PATH');
  let content;
  if (!media) {
    content = { text, mentions: participantIds };
  } else if (media.isVideo) {
    // gifPlayback renders as WhatsApp's own muted, looping "GIF" - see
    // VIDEO_EXTENSIONS/readReminderMedia's doc comment above for why the
    // file has to already be a real .mp4, not a raw .gif.
    content = { video: media.buffer, caption: text, gifPlayback: true, mentions: participantIds };
  } else {
    content = { image: media.buffer, caption: text, mentions: participantIds };
  }
  await sock.sendMessage(groupId, content);
}

// @-mentions only the designated court-canceller (see !courtcanceller,
// commands/admin.js) - a direct heads-up, not a group broadcast. Same
// optional-media attachment as sendFirstWarning above, just its own
// independently configured path (VACANCY_CANCEL_WARNING_MEDIA_PATH) -
// see readReminderMedia()'s doc comment for the fresh-off-disk/video-vs-
// image behavior both warnings share.
async function sendCancelWarning(sock, groupId, vacancies, cancellerJid) {
  const spotWord = vacancies === 1 ? 'spot' : 'spots';
  const text = `⏰ Still *${vacancies} ${spotWord}* open. @${cancellerJid.split('@')[0]} - looks like we may need to cancel some courts, unless a miracle happens.`;
  const media = readReminderMedia(VACANCY_CANCEL_WARNING_MEDIA_PATH, 'VACANCY_CANCEL_WARNING_MEDIA_PATH');
  let content;
  if (!media) {
    content = { text, mentions: [cancellerJid] };
  } else if (media.isVideo) {
    content = { video: media.buffer, caption: text, gifPlayback: true, mentions: [cancellerJid] };
  } else {
    content = { image: media.buffer, caption: text, mentions: [cancellerJid] };
  }
  await sock.sendMessage(groupId, content);
}

async function checkOneGroup(sock, groupId) {
  const event = getCurrentEvent(groupId);
  if (!event.date) return; // no list running at all - nothing to warn about

  const vacancies = computeVacancies(event);
  if (vacancies === null || vacancies < MIN_VACANCIES) return;

  const parsedTime = parseTimeOfDay(event.time || '');
  if (!parsedTime) {
    warnUnparseableTimeOnce(groupId, event, vacancies);
    return;
  }

  const startInstant = zonedDateTimeToUtc(event.date, parsedTime.hour, parsedTime.minute, TIMEZONE);
  if (!startInstant) return; // malformed stored date - shouldn't happen, but never crash the periodic tick over it

  const hoursUntilStart = (startInstant.getTime() - Date.now()) / (60 * 60 * 1000);
  if (hoursUntilStart <= 0) return; // already started (or passed) - too late for either warning

  if (hoursUntilStart <= FIRST_WARNING_HOURS && !event.notifiedVacancy50h) {
    try {
      await sendFirstWarning(sock, groupId, vacancies);
    } catch (err) {
      console.error(`[vacancyReminder] Failed to send the 50-hour vacancy warning in ${groupId}:`, err.message);
    }
    markVacancy50hNotified(groupId);
  }

  if (hoursUntilStart <= CANCEL_WARNING_HOURS && !event.notifiedVacancyCancelWarning) {
    const canceller = getCourtCanceller(groupId);
    if (!canceller || !canceller.jid) {
      // Nobody configured to tag - deliberately does NOT mark this
      // notified, so it keeps trying every tick (harmlessly cheap - no
      // network call happens) until an admin either sets !courtcanceller
      // or the social's own start time runs out and hoursUntilStart <= 0
      // above stops it for good.
      return;
    }
    try {
      await sendCancelWarning(sock, groupId, vacancies, canceller.jid);
    } catch (err) {
      console.error(`[vacancyReminder] Failed to send the court-cancellation warning in ${groupId}:`, err.message);
    }
    markVacancyCancelWarningNotified(groupId);
  }
}

// Fire-and-forget from index.js's setInterval callback - one group's
// failure (a transient groupMetadata()/sendMessage() error) is logged and
// skipped rather than aborting the whole sweep, same isolation as
// index.js's own per-message try/catch around handleMessage().
async function checkVacancyReminders(sock) {
  if (!sock) return; // briefly null between a disconnect and the next reconnect - just skip this tick, the next one will catch up
  for (const groupId of ALLOWED_GROUPS) {
    try {
      await checkOneGroup(sock, groupId);
    } catch (err) {
      console.error(`[vacancyReminder] Failed checking ${groupId}:`, err.message);
    }
  }
}

module.exports = {
  checkVacancyReminders,
  computeVacancies,
  MIN_VACANCIES,
  FIRST_WARNING_HOURS,
  CANCEL_WARNING_HOURS,
};
