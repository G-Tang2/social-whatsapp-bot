// lib/inactivityCheck.js
// Periodic per-group inactivity sweep. See activity.js and the top-of-file
// comment in commands/inactivity.js for the feature description.

const activity = require('../activity');
const {
  INACTIVITY_WARN_AFTER_DAYS,
  INACTIVITY_WARN_AFTER_MS,
  INACTIVITY_REMOVE_AFTER_DAYS,
} = require('./config');
const { getApprovedGroups } = require('./allowedGroups');

// Runs one inactivity sweep for a single group: refreshes tracking against
// current membership (seeds newcomers, drops people who left), finds
// anyone who's crossed the warn threshold, exempts admins, and sends a
// single batched tagged warning covering everyone newly due. Errors are
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

    const candidates = activity.getInactiveCandidates(groupId, INACTIVITY_WARN_AFTER_MS).filter(
      (c) => !adminIds.has(c.id)
    );
    // Always-on (not DEBUG-gated) one-line summary of every sweep, so a
    // "why didn't I get warned" report can be diagnosed straight from the
    // logs (e.g. `pm2 logs`) instead of guessing - deliberately terse (one
    // line per group per check interval) rather than dumping the full
    // candidate list, to stay readable over a long-running deployment.
    console.log(`[bot] Inactivity sweep for ${groupId}: ${participantIds.length} participant(s) tracked, ${candidates.length} candidate(s) due for a warning.`);
    if (!candidates.length) return;

    const mentions = candidates.map((c) => c.id);
    const tags = candidates.map((c) => `@${c.id.split('@')[0]}`).join(' ');
    await sock.sendMessage(groupId, {
      text: `${tags}\nPsst, is this thing on? You haven't sent a message here in ${INACTIVITY_WARN_AFTER_DAYS}d+. If you stay quiet for another ${INACTIVITY_REMOVE_AFTER_DAYS}d, an admin may remove you from the group for inactivity. Send anything to reset this - even a wave would do.`,
      mentions,
    });
    activity.markWarned(groupId, mentions);
    console.log(`[bot] Inactivity sweep for ${groupId}: sent a warning covering ${mentions.length} member(s).`);
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
  for (const groupId of getApprovedGroups()) {
    try {
      await checkGroupInactivity(sock, groupId);
    } catch (err) {
      console.error(`[inactivityCheck] Failed checking ${groupId}:`, err.message);
    }
  }
}

module.exports = { checkGroupInactivity, checkAllGroupsInactivity };
