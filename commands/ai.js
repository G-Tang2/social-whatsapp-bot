// commands/ai.js
// !ai [on|off] - turns natural-language command interpretation on/off for
// THIS group (see lib/geminiCommand.js for what that actually does, and
// index.js for how a message gets routed there - only live messages that
// @-mention the bot are ever considered). Modeled on commands/spamfilter.js
// (same "always replies" on/off-toggle shape), but OFF by default rather
// than on - see ai.js's file comment for why.

const ai = require('../ai');
const { isGroupAdmin } = require('../lib/adminCheck');
const { COMMAND_PREFIX, GEMINI_API_KEY } = require('../lib/config');

async function handleAi(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;
  const normalizedArg = (argText || '').trim().toLowerCase();

  if (!normalizedArg) {
    const enabled = ai.isEnabled(groupId);
    await reply(
      enabled
        ? `Natural-language commands are *ON* for this group - @-mention me with a plain request (e.g. "@Snoopy put me down", or an admin saying "@Snoopy clear the list") and I'll try to work out which command you meant, including admin ones (admin-only requests still need you to actually be an admin).\nTo turn it off (admins only): ${COMMAND_PREFIX}ai off`
        : `Natural-language commands are *OFF* for this group.\nTo turn it on (admins only): ${COMMAND_PREFIX}ai on`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can turn natural-language commands on or off.');
    return;
  }

  if (normalizedArg === 'on') {
    // Refuse outright rather than turning it "on" into a silently
    // non-functional state - GEMINI_API_KEY has to be set in .env (a
    // restart-required, operator-level step; not something a chat command
    // can fix), so failing loudly here beats every future @-mention just
    // quietly doing nothing with no explanation.
    if (!GEMINI_API_KEY) {
      await reply(
        `Can't turn this on yet - GEMINI_API_KEY isn't configured. Get a free key from https://aistudio.google.com/apikey, add it to .env as GEMINI_API_KEY, and restart Snoopy, then try ${COMMAND_PREFIX}ai on again.`
      );
      return;
    }
    if (ai.isEnabled(groupId)) {
      await reply('Natural-language commands are already on for this group.');
      return;
    }
    ai.setEnabled(groupId, true);
    await reply(
      `Natural-language commands turned *on* for this group. @-mention me with a plain request (e.g. "@Snoopy put me down for Saturday") and I'll try to work out which command you meant - including admin ones like ${COMMAND_PREFIX}clear or ${COMMAND_PREFIX}limit for admins.\nIf I'm not fully sure what you meant, I'll ask you to confirm rather than guessing - and I'll stay quiet entirely if your message doesn't look list-related at all.`
    );
    return;
  }

  if (normalizedArg === 'off') {
    if (!ai.isEnabled(groupId)) {
      await reply('Natural-language commands are already off for this group.');
      return;
    }
    ai.setEnabled(groupId, false);
    await reply('Natural-language commands turned *off* for this group.');
    return;
  }

  await reply(
    `Usage: ${COMMAND_PREFIX}ai on, or ${COMMAND_PREFIX}ai off\n(No argument shows the current state without changing it.)`
  );
}

module.exports = { handleAi };