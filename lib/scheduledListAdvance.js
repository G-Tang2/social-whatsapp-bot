// lib/scheduledListAdvance.js
// Shared mechanics behind lib/autoNewlistScheduler.js's !autonewlist and
// lib/cancelledSocialResumeScheduler.js's !cancelsocial auto-resume - both
// features advance a group's list automatically once a computed "trigger
// date" is assumed to have "ended" (start instant + AUTO_NEWLIST_DELAY_MS).
//
// Deliberately factors out only the parts that are genuinely IDENTICAL
// between the two: computing the assumed end instant from an already-
// parsed !time, the mark-before-work -> newList -> merge !regulars ->
// post sequence, and the per-group sweep loop. What's NOT shared (on
// purpose, per each file's own file-level comment): the gating condition
// for whether a group is even eligible this tick (the !autonewlist
// toggle vs. current.cancelled/cancelledWeeks), which date counts as the
// "trigger" in the first place, which date the fresh list should resume
// on, and the exact wording of each feature's own unparseable-!time
// warning (different enough - "has !autonewlist on" vs. "is cancelled" -
// that collapsing them into one parametrized message read awkwardly
// without actually removing any real duplication).

const { ALLOWED_GROUPS, TIMEZONE, AUTO_NEWLIST_DELAY_MS } = require('./config');
const { newList } = require('../store');
const { zonedDateTimeToUtc } = require('../dates');
const { formatList } = require('./helpers');
const { addRegularsToCurrentList } = require('../commands/admin');

// Resolves `triggerDate`'s real start instant (via the CALLER's own
// already-parsed `parsedTime` - see dates.js's parseTimeOfDay(), which
// each caller still runs itself so it can warn in its own wording if
// !time isn't parseable at all) into the instant the social is assumed
// to have "ended": start + AUTO_NEWLIST_DELAY_MS. Returns null only for
// a malformed `triggerDate` (shouldn't happen - callers validate it
// first) - deliberately NOT used to signal "unparseable !time" too,
// since that's a different failure the caller already knows about by
// the time this is called.
function computeAssumedEndInstant(triggerDate, parsedTime) {
  const startInstant = zonedDateTimeToUtc(triggerDate, parsedTime.hour, parsedTime.minute, TIMEZONE);
  if (!startInstant) return null;
  return startInstant.getTime() + AUTO_NEWLIST_DELAY_MS;
}

// Starts a fresh list dated `nextDate` for `groupId` - the actual
// "equivalent of !newlist same" sequence both schedulers need once
// they've decided the trigger date has "ended": mark `markCreated` FIRST
// (closing the same narrow race window both tolerate - two overlapping
// ticks before the first tick's await resolves; once newList() below
// replaces state.current wholesale, the feature is naturally self-
// guarding against re-firing anyway), carry location/time/courts forward
// unchanged, merge in the saved !regulars roster, and post the result.
// `logPrefix` (e.g. "[autoNewlistScheduler]") attributes the regulars-
// rejected/post-failed warnings to whichever caller this is.
async function advanceToFreshList(sock, groupId, nextDate, markCreated, logPrefix) {
  markCreated(groupId);
  newList(groupId, nextDate, {});
  const { rejected } = addRegularsToCurrentList(groupId, null, true, []);
  if (rejected.length) {
    console.warn(`${logPrefix} Couldn't add everyone from ${groupId}'s regulars roster to the auto-started list:\n${rejected.join('\n')}`);
  }
  try {
    await sock.sendMessage(groupId, { text: formatList(groupId) });
  } catch (err) {
    console.error(`${logPrefix} Failed to post the auto-started list in ${groupId}:`, err.message);
  }
}

// Fire-and-forget per-group sweep shared by checkAutoNewlist()/
// checkCancelledSocialResume() - one group's failure is logged and
// skipped rather than aborting the whole sweep. `checkOneGroup` is the
// caller's own per-group check (gating condition included).
async function sweepAllGroups(sock, checkOneGroup, logPrefix) {
  if (!sock) return; // briefly null between a disconnect and the next reconnect - just skip this tick, the next one will catch up
  for (const groupId of ALLOWED_GROUPS) {
    try {
      await checkOneGroup(sock, groupId);
    } catch (err) {
      console.error(`${logPrefix} Error checking ${groupId}:`, err);
    }
  }
}

module.exports = { computeAssumedEndInstant, advanceToFreshList, sweepAllGroups };
