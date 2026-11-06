// lib/autoNewlistScheduler.js
// Periodically checks every configured group's current list and, for any
// group that's turned !autonewlist on, automatically starts NEXT WEEK's
// list as soon as this one's social is assumed to have "ended" - same day
// of the week, same location/courts/time, with the saved !regulars roster
// merged in, posted to the chat exactly like a manual !newlist would be.
// See commands/autonewlist.js for the on/off toggle and autoNewlist.js for
// where that per-group state lives.
//
// Needs a REAL computable start instant, which the list's `date` alone
// isn't - see dates.js's parseTimeOfDay()/zonedDateTimeToUtc(), same
// best-effort parsing of the freeform !time text lib/vacancyReminder.js
// already relies on (nothing else in this codebase parses it). A list
// whose !time doesn't contain a recognizable time is simply skipped, with
// a console warning (see warnUnparseableTimeOnce below), same as vacancy
// reminders.
//
// There's no real END-time/duration field anywhere in this codebase
// either (see !time's own doc comments) - "ended" here is a deliberate
// approximation: the computed start instant, plus a fixed assumed
// duration (see lib/config.js's AUTO_NEWLIST_DELAY_HOURS/_MS). Each fires
// AT MOST ONCE per list cycle - store.js's autoNewlistCreated flag on the
// CURRENT event, reset back to false whenever newList() starts a fresh one
// - no matter how often checkAutoNewlist() itself runs. See index.js for
// the periodic setInterval that drives this, same "read currentSock fresh
// each tick, tolerate a briefly-null sock between reconnects" pattern as
// lib/lastSeenStatus.js/lib/vacancyReminder.js.
//
// The actual "mark -> newList -> merge !regulars -> post" sequence and the
// per-group sweep loop are shared with lib/cancelledSocialResumeScheduler.js
// (the !cancelsocial auto-resume feature) via lib/scheduledListAdvance.js -
// see that file's own comment for exactly what is (and deliberately isn't)
// shared between the two.

const { getCurrentEvent, markAutoNewlistCreated } = require('../store');
const { parseTimeOfDay, oneWeekAfter } = require('../dates');
const autoNewlist = require('../autoNewlist');
const { computeAssumedEndInstant, advanceToFreshList, sweepAllGroups } = require('./scheduledListAdvance');

const LOG_PREFIX = '[autoNewlistScheduler]';

// Same "warn once per distinct (date, time) combination, not every tick"
// reasoning as lib/vacancyReminder.js's own warnUnparseableTimeOnce -
// in-memory only, a bot restart just re-warns once more.
const warnedUnparseableTime = new Set();
function warnUnparseableTimeOnce(groupId, event) {
  const key = `${groupId}:${event.date}:${event.time}`;
  if (warnedUnparseableTime.has(key)) return;
  warnedUnparseableTime.add(key);
  console.error(
    `${LOG_PREFIX} Group ${groupId} has !autonewlist on, but !time (${event.time ? `"${event.time}"` : 'not set'}) couldn't be read as a real start time - next week's list won't be auto-started until an admin re-sets !time with a recognizable time in it (e.g. "8PM start").`
  );
}

async function checkOneGroup(sock, groupId) {
  if (!autoNewlist.isEnabled(groupId)) return; // feature not turned on for this group

  const event = getCurrentEvent(groupId);
  if (!event.date) return; // no list running at all - nothing to advance

  if (event.autoNewlistCreated) return; // already handled this cycle

  const parsedTime = parseTimeOfDay(event.time || '');
  if (!parsedTime) {
    warnUnparseableTimeOnce(groupId, event);
    return;
  }

  const endInstant = computeAssumedEndInstant(event.date, parsedTime);
  if (endInstant === null) return; // malformed stored date - shouldn't happen, but never crash the periodic tick over it
  if (Date.now() < endInstant) return; // social hasn't "ended" yet

  const nextDate = oneWeekAfter(event.date);
  if (!nextDate) return; // shouldn't happen - event.date was already validated by computeAssumedEndInstant above

  await advanceToFreshList(sock, groupId, nextDate, markAutoNewlistCreated, LOG_PREFIX);
}

async function checkAutoNewlist(sock) {
  await sweepAllGroups(sock, checkOneGroup, LOG_PREFIX);
}

module.exports = { checkAutoNewlist };
