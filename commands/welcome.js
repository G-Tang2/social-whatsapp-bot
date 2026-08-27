// commands/welcome.js
// !welcome [on|off] - toggles the "someone joined the group" welcome
// message (see index.js's handleGroupParticipantsUpdate) on or off for
// this group. Faithful sibling of commands/spamfilter.js's own on/off
// toggle - same shape, same ON-by-default philosophy.

const welcome = require('../welcome');
const { isGroupAdmin } = require('../lib/adminCheck');
const { COMMAND_PREFIX } = require('../lib/config');

async function handleWelcome(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;
  // Always replies, even on success - on/off is a state flip with no
  // list to re-post as proof.
  const normalizedArg = (argText || '').trim().toLowerCase();

  if (!normalizedArg) {
    const enabled = welcome.isEnabled(groupId);
    await reply(
      enabled
        ? `The welcome message is *ON* for this group - I'll greet, explain how to join, and show the current list to anyone who joins.\nTo turn it off (admins only): ${COMMAND_PREFIX}welcome off`
        : `The welcome message is *OFF* for this group.\nTo turn it on (admins only): ${COMMAND_PREFIX}welcome on`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can turn the welcome message on or off - nice try, though!');
    return;
  }

  if (normalizedArg === 'on') {
    if (welcome.isEnabled(groupId)) {
      await reply('The welcome message is already on for this group - I\'m already greeting people at the door.');
      return;
    }
    welcome.setEnabled(groupId, true);
    await reply(
      `The welcome message turned *on* for this group. I'll greet, explain how to join, and show the current list to anyone who joins from now on.`
    );
    return;
  }

  if (normalizedArg === 'off') {
    if (!welcome.isEnabled(groupId)) {
      await reply('The welcome message is already off for this group - quiet at the door.');
      return;
    }
    welcome.setEnabled(groupId, false);
    await reply('The welcome message turned *off* for this group.');
    return;
  }

  await reply(
    `Usage: ${COMMAND_PREFIX}welcome on, or ${COMMAND_PREFIX}welcome off\n(No argument shows the current state without changing it.)`
  );
}

module.exports = { handleWelcome };
