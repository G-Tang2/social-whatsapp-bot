// commands/inactivity.js
// !inactivity [on|off] and !stale - faithful ports of the corresponding
// switch cases from the old monolithic index.js.

const activity = require('../activity');
const { isGroupAdmin } = require('../lib/adminCheck');
const {
  COMMAND_PREFIX,
  INACTIVITY_WARN_AFTER_DAYS,
  INACTIVITY_REMOVE_AFTER_DAYS,
  INACTIVITY_REMOVE_AFTER_MS,
} = require('../lib/config');
const { formatElapsed } = require('../lib/helpers');

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
        ? `Inactivity checking is *ON* for this group. Members quiet for ${INACTIVITY_WARN_AFTER_DAYS}d get tagged with a warning, and show as overdue in ${COMMAND_PREFIX}stale after another ${INACTIVITY_REMOVE_AFTER_DAYS}d.\nTo turn it off (admins only): ${COMMAND_PREFIX}inactivity off`
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
    // otherwise turning this on could immediately flood the group with
    // warnings for time that passed while it was off.
    let participantIds = [];
    try {
      participantIds = (await sock.groupMetadata(groupId)).participants.map((p) => p.id);
    } catch (err) {
      console.error('[bot] Failed to fetch group metadata for !inactivity on:', err.message);
    }
    activity.resetBaseline(groupId, participantIds);
    activity.setEnabled(groupId, true);
    await reply(
      `Inactivity checking turned *on* for this group. Members quiet for ${INACTIVITY_WARN_AFTER_DAYS}d will get tagged with a warning here, starting from now - Snoopy can't see chat history from before this moment, so nobody's flagged for the past.`
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

async function handleStale(ctx) {
  const { sock, msg, groupId, senderId, reply } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can check who\'s been warned for inactivity - rules are rules, even for a mischievous beagle.');
    return;
  }

  if (!activity.isEnabled(groupId)) {
    await reply(`Inactivity checking is off for this group. Turn it on with ${COMMAND_PREFIX}inactivity on (admins only).`);
    return;
  }

  const warnedList = activity.getWarned(groupId);
  if (!warnedList.length) {
    await reply('Nobody is currently warned for inactivity - everyone\'s behaving!');
    return;
  }

  const now = Date.now();
  const lines = warnedList.map((entry) => {
    const warnedMs = now - new Date(entry.warnedAt).getTime();
    const overdue = warnedMs >= INACTIVITY_REMOVE_AFTER_MS;
    return `@${entry.id.split('@')[0]} - warned ${formatElapsed(warnedMs)} ago${overdue ? ' - OVERDUE for removal' : ''}`;
  });

  // Sent directly (not via the `reply` helper) so we can pass
  // `mentions` - tagging each person makes it obvious at a glance who
  // this is about, same as the automatic warning message does.
  await sock.sendMessage(
    groupId,
    {
      text: `*Inactivity warnings*\n\n${lines.join('\n')}`,
      mentions: warnedList.map((entry) => entry.id),
    },
    { quoted: msg }
  );
}

module.exports = { handleInactivityToggle, handleStale };
