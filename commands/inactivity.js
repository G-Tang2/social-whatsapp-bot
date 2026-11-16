// commands/inactivity.js
// !inactivity [on|off] - whether members quiet in chat for
// INACTIVITY_KICK_AFTER_DAYS are automatically removed from the group (see
// lib/inactivityCheck.js's daily sweep). No warning first - this is a
// faithful port of the corresponding switch case from the old monolithic
// index.js, since simplified from a two-stage warn-then-flag-overdue
// design (which used to also have a companion !stale command) down to a
// single auto-kick threshold.

const activity = require('../activity');
const { isGroupAdmin } = require('../lib/adminCheck');
const {
  COMMAND_PREFIX,
  INACTIVITY_KICK_AFTER_DAYS,
} = require('../lib/config');

async function handleInactivityToggle(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;
  // Unlike most admin-gated commands, this one always replies - even
  // on success - since "on"/"off" is a state flip with no other visible
  // proof (there's no list to re-post that would show the new state).
  const normalizedArg = (argText || '').trim().toLowerCase();

  if (!normalizedArg) {
    const enabled = activity.isEnabled(groupId);
    await reply(
      enabled
        ? `Inactivity checking is *ON* for this group. Members quiet for ${INACTIVITY_KICK_AFTER_DAYS}d get automatically removed from the group - no warning first.\nTo turn it off (admins only): ${COMMAND_PREFIX}inactivity off`
        : `Inactivity checking is *OFF* for this group.\nTo turn it on (admins only): ${COMMAND_PREFIX}inactivity on`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can turn inactivity checking on or off - the doghouse has rules, and I\'m sworn to uphold them.');
    return;
  }

  if (normalizedArg === 'on') {
    if (activity.isEnabled(groupId)) {
      await reply('Inactivity checking is already on for this group - I\'m already watching, hehe.');
      return;
    }
    // Give everyone a fresh "just seen" baseline right now, rather than
    // trusting any stale data left over from a previous on/off stint -
    // otherwise turning this on could immediately auto-kick people for
    // time that passed while it was off.
    let participantIds = [];
    try {
      participantIds = (await sock.groupMetadata(groupId)).participants.map((p) => p.id);
    } catch (err) {
      console.error('[bot] Failed to fetch group metadata for !inactivity on:', err.message);
    }
    activity.resetBaseline(groupId, participantIds);
    activity.setEnabled(groupId, true);
    await reply(
      `Inactivity checking turned *on* for this group. Members quiet for ${INACTIVITY_KICK_AFTER_DAYS}d will be automatically removed, counting from now - Snoopy can't see chat history from before this moment, so nobody's flagged for the past.`
    );
    return;
  }

  if (normalizedArg === 'off') {
    if (!activity.isEnabled(groupId)) {
      await reply('Inactivity checking is already off for this group - nothing to see here.');
      return;
    }
    activity.setEnabled(groupId, false);
    await reply('Inactivity checking turned *off* for this group.');
    return;
  }

  await reply(
    `Usage: ${COMMAND_PREFIX}inactivity on, or ${COMMAND_PREFIX}inactivity off\n(No argument shows the current state without changing it.)`
  );
}

module.exports = { handleInactivityToggle };
