// lib/inactivityCheck.js
// Periodic per-group inactivity sweep. See activity.js and the top-of-file
// comment in commands/inactivity.js for the feature description.

const activity = require('../activity');
const { zonedDateTimeToUtc } = require('../dates');
const {
  ALLOWED_GROUPS,
  INACTIVITY_KICK_AFTER_MS,
} = require('./config');

// Local hour (in the configured TIMEZONE) the daily sweep runs at - 8pm.
const INACTIVITY_CHECK_HOUR = 20;

// Milliseconds from `now` until the next occurrence of `hour`:00 in
// `timeZone` - later today if that hour hasn't passed yet, otherwise
// tomorrow. Used by index.js to schedule the daily sweep at a fixed
// wall-clock time rather than a fixed interval from process start.
function msUntilNextDailyTime(now, hour, timeZone) {
  const todayIso = now.toLocaleDateString('en-CA', { timeZone });
  let target = zonedDateTimeToUtc(todayIso, hour, 0, timeZone);
  if (target.getTime() <= now.getTime()) {
    const [y, m, d] = todayIso.split('-').map(Number);
    const tomorrowIso = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    target = zonedDateTimeToUtc(tomorrowIso, hour, 0, timeZone);
  }
  return target.getTime() - now.getTime();
}

// Runs one inactivity sweep for a single group: refreshes tracking against
// current membership (seeds newcomers, drops people who left), finds
// anyone who's crossed the kick threshold, exempts admins, and removes
// them from the group in one batched call - no warning first. Errors are
// caught and logged rather than thrown, since this runs unattended off a
// timer with nobody around to see an unhandled rejection.
async function checkGroupInactivity(sock, groupId) {
  if (!sock) return; // socket is mid-reconnect - skip this cycle, try again next tick
  if (!activity.isEnabled(groupId)) return; // this group hasn't opted in via !inactivity on - skip the network call entirely
  try {
    const metadata = await sock.groupMetadata(groupId);
    const participantIds = metadata.participants.map((p) => p.id);

    // Defensive: a real WhatsApp group always has at least the bot itself
    // as a participant, so an empty list here means groupMetadata()
    // returned something bogus without actually throwing - trusting it
    // would let pruneParticipants() below wipe everyone's tracked activity
    // and seedParticipants() silently reseed a fresh "now" baseline for
    // all of them, resetting every member's inactivity clock at once.
    // Skip the whole cycle instead and try again next tick. Logged
    // unconditionally (not behind DEBUG) since this should be rare and is
    // worth knowing about if it happens.
    if (!participantIds.length) {
      console.error(`[bot] Inactivity check for ${groupId}: groupMetadata() returned 0 participants - skipping this cycle rather than risk wiping tracked activity.`);
      return;
    }

    const adminIds = new Set(
      metadata.participants.filter((p) => p.admin === 'admin' || p.admin === 'superadmin').map((p) => p.id)
    );

    activity.seedParticipants(groupId, participantIds);
    activity.pruneParticipants(groupId, participantIds);

    const candidates = activity.getKickCandidates(groupId, INACTIVITY_KICK_AFTER_MS).filter(
      (c) => !adminIds.has(c.id)
    );
    // Always-on (not DEBUG-gated) one-line summary of every sweep, so a
    // "why wasn't X removed" report can be diagnosed straight from the
    // logs (e.g. `pm2 logs`) instead of guessing - deliberately terse (one
    // line per group per check interval) rather than dumping the full
    // candidate list, to stay readable over a long-running deployment.
    console.log(`[bot] Inactivity sweep for ${groupId}: ${participantIds.length} participant(s) tracked, ${candidates.length} candidate(s) due for auto-kick.`);
    if (!candidates.length) return;

    const ids = candidates.map((c) => c.id);
    try {
      // Removing a participant requires the bot's own WhatsApp account to
      // be a group admin - same restriction !autokick (commands/
      // autokick.js) runs into, and just as likely to throw if it isn't.
      await sock.groupParticipantsUpdate(groupId, ids, 'remove');
      activity.clearParticipants(groupId, ids);
      console.log(`[bot] Inactivity sweep for ${groupId}: auto-kicked ${ids.length} member(s) for inactivity.`);
    } catch (err) {
      console.error(`[bot] Failed to auto-kick ${ids.length} inactive member(s) in ${groupId} (is the bot a group admin?):`, err.message);
    }
  } catch (err) {
    console.error(`[bot] Inactivity check failed for group ${groupId}:`, err.message);
  }
}

// Fire-and-forget from index.js's setInterval callback - same
// "sweep every configured group, isolate one group's failure from the
// rest" pattern as lib/vacancyReminder.js's checkVacancyReminders() and
// lib/autoNewlistScheduler.js's checkAutoNewlist(). checkGroupInactivity()
// itself is the one that checks each group's own !inactivity on/off state
// and skips (cheaply, before any network call) groups that haven't opted
// in, so this runs unconditionally over every configured group.
async function checkAllGroupsInactivity(sock) {
  if (!sock) return; // briefly null between a disconnect and the next reconnect - just skip this tick, the next one will catch up
  for (const groupId of ALLOWED_GROUPS) {
    try {
      await checkGroupInactivity(sock, groupId);
    } catch (err) {
      console.error(`[inactivityCheck] Failed checking ${groupId}:`, err.message);
    }
  }
}

module.exports = { checkGroupInactivity, checkAllGroupsInactivity, msUntilNextDailyTime, INACTIVITY_CHECK_HOUR };
