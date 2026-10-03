// commands/autokick.js
// !autokick [on|off] - whether the SENDER of a message deleted by spam
// filtering also gets removed from the group, not just their message.
// Deliberately a separate toggle from !spamfilter (see spam.js's
// isAutoKickEnabled/setAutoKickEnabled) - a group can turn this off while
// keeping deletion itself on. Same on/off/view structure as
// commands/spamfilter.js.

const spam = require('../spam');
const { isGroupAdmin } = require('../lib/adminCheck');
const { COMMAND_PREFIX } = require('../lib/config');

async function handleAutokick(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;
  // Always replies, even on success - on/off is a state flip with no
  // list to re-post as proof.
  const normalizedArg = (argText || '').trim().toLowerCase();

  if (!normalizedArg) {
    const enabled = spam.isAutoKickEnabled(groupId);
    await reply(
      enabled
        ? `Auto-kick is *ON* for this group - whoever sends a message spam filtering deletes also gets removed from the group (admins exempt).\nTo turn it off (admins only): ${COMMAND_PREFIX}autokick off`
        : `Auto-kick is *OFF* for this group - spam messages still get deleted, but the sender stays in the group.\nTo turn it on (admins only): ${COMMAND_PREFIX}autokick on`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can turn auto-kick on or off - nice try, though!');
    return;
  }

  if (normalizedArg === 'on') {
    if (spam.isAutoKickEnabled(groupId)) {
      await reply('Auto-kick is already on for this group - spammers already get shown the door.');
      return;
    }
    spam.setAutoKickEnabled(groupId, true);
    await reply(
      `Auto-kick turned *on* for this group. Whoever sends a message spam filtering deletes will also be removed from the group (admins exempt).\nNote: removing someone only works if Snoopy's own WhatsApp account is a group admin here - if it isn't, their message will still be deleted, but they won't be removed.`
    );
    return;
  }

  if (normalizedArg === 'off') {
    if (!spam.isAutoKickEnabled(groupId)) {
      await reply('Auto-kick is already off for this group - spam still gets deleted, the sender just isn\'t removed.');
      return;
    }
    spam.setAutoKickEnabled(groupId, false);
    await reply('Auto-kick turned *off* for this group. Spam will still be deleted; the sender just won\'t be removed.');
    return;
  }

  await reply(
    `Usage: ${COMMAND_PREFIX}autokick on, or ${COMMAND_PREFIX}autokick off\n(No argument shows the current state without changing it.)`
  );
}

module.exports = { handleAutokick };
