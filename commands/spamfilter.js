// commands/spamfilter.js
// !spamfilter [on|off] - faithful port of the corresponding switch case
// from the old monolithic index.js.

const spam = require('../spam');
const { isGroupAdmin } = require('../lib/adminCheck');
const { COMMAND_PREFIX } = require('../lib/config');

async function handleSpamfilter(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;
  // Same "always replies" exception as !inactivity, for the same
  // reason - on/off is a state flip with no list to re-post as proof.
  const normalizedArg = (argText || '').trim().toLowerCase();

  if (!normalizedArg) {
    const enabled = spam.isEnabled(groupId);
    await reply(
      enabled
        ? `Spam filtering is *ON* for this group - WhatsApp group invite links, and messages with both a link and a stock/crypto keyword, get deleted automatically (admins exempt).\nTo turn it off (admins only): ${COMMAND_PREFIX}spamfilter off`
        : `Spam filtering is *OFF* for this group.\nTo turn it on (admins only): ${COMMAND_PREFIX}spamfilter on`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can turn spam filtering on or off.');
    return;
  }

  if (normalizedArg === 'on') {
    if (spam.isEnabled(groupId)) {
      await reply('Spam filtering is already on for this group.');
      return;
    }
    spam.setEnabled(groupId, true);
    await reply(
      `Spam filtering turned *on* for this group. WhatsApp group invite links, and messages with both a link and a stock/crypto keyword, will be deleted automatically (admins exempt).\nNote: deleting other people's messages only works if Snoopy's own WhatsApp account is a group admin here - if it isn't, matching messages will be detected but left in place.`
    );
    return;
  }

  if (normalizedArg === 'off') {
    if (!spam.isEnabled(groupId)) {
      await reply('Spam filtering is already off for this group.');
      return;
    }
    spam.setEnabled(groupId, false);
    await reply('Spam filtering turned *off* for this group.');
    return;
  }

  await reply(
    `Usage: ${COMMAND_PREFIX}spamfilter on, or ${COMMAND_PREFIX}spamfilter off\n(No argument shows the current state without changing it.)`
  );
}

module.exports = { handleSpamfilter };
