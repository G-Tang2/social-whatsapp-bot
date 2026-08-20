// commands/autonewlist.js
// !autonewlist [on|off] - turns automatic "start next week's list once this
// one's social has ended" on/off for THIS group (see
// lib/autoNewlistScheduler.js for what that actually does). Modeled on
// commands/ai.js (same "always replies" on/off-toggle shape, OFF by
// default).

const autoNewlist = require('../autoNewlist');
const { isGroupAdmin } = require('../lib/adminCheck');
const { COMMAND_PREFIX, AUTO_NEWLIST_DELAY_HOURS } = require('../lib/config');

async function handleAutonewlist(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;
  const normalizedArg = (argText || '').trim().toLowerCase();

  if (!normalizedArg) {
    const enabled = autoNewlist.isEnabled(groupId);
    await reply(
      enabled
        ? `Auto-newlist is *ON* for this group - I'll start next week's list on my own, ${AUTO_NEWLIST_DELAY_HOURS} hours after this one's start time (needs a real time set via ${COMMAND_PREFIX}time to work from).\nTo turn it off (admins only): ${COMMAND_PREFIX}autonewlist off`
        : `Auto-newlist is *OFF* for this group.\nTo turn it on (admins only): ${COMMAND_PREFIX}autonewlist on`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can turn auto-newlist on or off.');
    return;
  }

  if (normalizedArg === 'on') {
    if (autoNewlist.isEnabled(groupId)) {
      await reply('Auto-newlist is already on for this group.');
      return;
    }
    autoNewlist.setEnabled(groupId, true);
    await reply(
      `Auto-newlist turned *on* for this group. Once this list's social has been going for ${AUTO_NEWLIST_DELAY_HOURS} hours (from whatever time ${COMMAND_PREFIX}time is set to), I'll automatically start next week's list - same day of the week, same location/courts/time, with the saved ${COMMAND_PREFIX}regulars roster - and post it here.`
    );
    return;
  }

  if (normalizedArg === 'off') {
    if (!autoNewlist.isEnabled(groupId)) {
      await reply('Auto-newlist is already off for this group.');
      return;
    }
    autoNewlist.setEnabled(groupId, false);
    await reply('Auto-newlist turned *off* for this group.');
    return;
  }

  await reply(
    `Usage: ${COMMAND_PREFIX}autonewlist on, or ${COMMAND_PREFIX}autonewlist off\n(No argument shows the current state without changing it.)`
  );
}

module.exports = { handleAutonewlist };
