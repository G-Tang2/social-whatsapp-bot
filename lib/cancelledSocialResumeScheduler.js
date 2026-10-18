// lib/cancelledSocialResumeScheduler.js
// Periodically checks every configured group's current list and, for any
// group that's been called off via !cancelsocial (store.js's
// cancelSocial()/current.cancelled), automatically starts a fresh,
// non-cancelled list once the LAST of the cancelled weeks is assumed to
// have "ended" - same day of the week, same location/courts/time, with
// the saved !regulars roster merged in, posted to the chat exactly like a
// manual !newlist would be. See commands/admin.js's handleCancelSocial for
// the typed `!cancelsocial [weeks]` command this resumes from.
//
// Deliberately NOT gated on the separate !autonewlist toggle (see
// autoNewlist.js/commands/autonewlist.js) - that feature is about
// advancing an ordinary, never-cancelled week automatically; this one is
// about resuming from an explicit admin action (!cancelsocial), which
// should un-do itself on its own regardless of whether the group also
// wants ongoing weekly automation.
//
// Same "assumed end-time" heuristic as lib/autoNewlistScheduler.js (see
// its own file-level comment) - there's no real end-time/duration field
// anywhere in this codebase, so "ended" is the computed start instant for
// the LAST cancelled week, plus a fixed assumed duration
// (AUTO_NEWLIST_DELAY_HOURS/_MS, the exact same knob autoNewlistScheduler
// uses - no separate one of these for this feature). An unparseable !time
// is skipped with a console warning, same as that scheduler. Each fires AT
// MOST ONCE per cancelled cycle - store.js's cancelledResumeCreated flag on
// the CURRENT event, reset back to false whenever a fresh cancellation (or
// an ordinary !newlist) starts - no matter how often checkOneGroup() itself
// runs. See index.js for the periodic setInterval that drives this, same
// "read currentSock fresh each tick, tolerate a briefly-null sock between
// reconnects" pattern as lib/autoNewlistScheduler.js/lib/vacancyReminder.js.

const { ALLOWED_GROUPS, TIMEZONE, AUTO_NEWLIST_DELAY_MS } = require('./config');
const { getCurrentEvent, newList, markCancelledResumeCreated } = require('../store');
const { parseTimeOfDay, zonedDateTimeToUtc, addWeeks } = require('../dates');
const { formatList } = require('./helpers');
const { addRegularsToCurrentList } = require('../commands/admin');

// Same "warn once per distinct (date, time) combination, not every tick"
// reasoning as lib/autoNewlistScheduler.js's own warnUnparseableTimeOnce -
// in-memory only, a bot restart just re-warns once more. A separate Set
// from that module's (rather than a shared one) so a group hitting both
// warnings isn't silently deduped against the wrong feature's message.
const warnedUnparseableTime = new Set();
function warnUnparseableTimeOnce(groupId, event) {
  const key = `${groupId}:${event.date}:${event.time}`;
  if (warnedUnparseableTime.has(key)) return;
  warnedUnparseableTime.add(key);
  console.error(
    `[cancelledSocialResumeScheduler] Group ${groupId} is cancelled, but !time (${event.time ? `"${event.time}"` : 'not set'}) couldn't be read as a real start time - the fresh list won't be auto-started until an admin re-sets !time with a recognizable time in it (e.g. "8PM start"), or just runs !newlist manually.`
  );
}

async function checkOneGroup(sock, groupId) {
  const event = getCurrentEvent(groupId);
  if (!event.cancelled || !event.cancelledWeeks) return; // not cancelled, or cancelled before this feature existed (no week count to resume from)
  if (event.cancelledResumeCreated) return; // already handled this cancellation
  if (!event.date) return; // shouldn't happen - cancelSocial() never runs without a list already up - but never crash the periodic tick over it

  const parsedTime = parseTimeOfDay(event.time || '');
  if (!parsedTime) {
    warnUnparseableTimeOnce(groupId, event);
    return;
  }

  // The LAST of the cancelled weeks - `cancelledWeeks - 1` weeks after the
  // one !cancelsocial actually ran against (week 1 of a 2-week
  // cancellation IS that original date; week 2 is one week after it).
  const lastCancelledDate = addWeeks(event.date, event.cancelledWeeks - 1);
  if (!lastCancelledDate) return; // malformed stored date - shouldn't happen

  const startInstant = zonedDateTimeToUtc(lastCancelledDate, parsedTime.hour, parsedTime.minute, TIMEZONE);
  if (!startInstant) return;

  const endInstant = startInstant.getTime() + AUTO_NEWLIST_DELAY_MS;
  if (Date.now() < endInstant) return; // the last cancelled week hasn't "ended" yet

  // Mark BEFORE doing the actual work - closes the same narrow race window
  // autoNewlistScheduler.js tolerates (two overlapping ticks before the
  // first tick's await resolves), and once newList() below replaces
  // state.current wholesale, the feature is naturally self-guarding
  // against re-firing anyway.
  markCancelledResumeCreated(groupId);

  const resumeDate = addWeeks(event.date, event.cancelledWeeks);
  if (!resumeDate) return; // shouldn't happen - event.date was already validated above

  newList(groupId, resumeDate, {}); // carries forward location/time/courts unchanged, exactly like "!newlist same" with nothing else typed
  const { rejected } = addRegularsToCurrentList(groupId, null, true, []);
  if (rejected.length) {
    console.warn(`[cancelledSocialResumeScheduler] Couldn't add everyone from ${groupId}'s regulars roster to the auto-resumed list:\n${rejected.join('\n')}`);
  }

  try {
    await sock.sendMessage(groupId, { text: formatList(groupId) });
  } catch (err) {
    console.error(`[cancelledSocialResumeScheduler] Failed to post the auto-resumed list in ${groupId}:`, err.message);
  }
}

// Fire-and-forget from index.js's setInterval callback - one group's
// failure is logged and skipped rather than aborting the whole sweep, same
// isolation as lib/autoNewlistScheduler.js's checkAutoNewlist().
async function checkCancelledSocialResume(sock) {
  if (!sock) return; // briefly null between a disconnect and the next reconnect - just skip this tick, the next one will catch up

  for (const groupId of ALLOWED_GROUPS) {
    try {
      await checkOneGroup(sock, groupId);
    } catch (err) {
      console.error(`[cancelledSocialResumeScheduler] Error checking ${groupId}:`, err);
    }
  }
}

module.exports = { checkCancelledSocialResume };
