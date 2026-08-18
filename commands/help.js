// commands/help.js
// !help - shows the everyday, non-admin commands (joining/leaving, listing,
// payments). !admin - shows the admin-only list-management commands. Split
// out of one combined HELP_TEXT so regular players aren't shown a wall of
// admin-only commands they can't use.
//
// !tips / !admintips are the FURTHER split-out companions to !help/!admin -
// the fiddlier caveats and longer explanations (comma lists, ID-based
// "yourself" matching, how !update's header block works, etc.) that used to
// be crammed into a "_Tips_" footer under each of those replies. Moved out
// to their own commands so !help/!admin themselves stay a quick, scannable
// command reference - someone who just wants to know what commands exist
// isn't forced to scroll past several paragraphs of caveats first; the tips
// are still one command away (and pointed to right from !help/!admin) for
// whoever wants the detail.

const { PLAYERS_PER_COURT } = require('../store');
const {
  COMMAND_PREFIX,
  PAYMENT_LABEL,
  MAX_NAMES_PER_COMMAND,
  INACTIVITY_WARN_AFTER_DAYS,
} = require('../lib/config');
const { isGroupAdmin } = require('../lib/adminCheck');

// Grouped into short sections rather than one long line per command -
// easier to scan on a phone than a wall of text. Each command's name is
// bolded and bulleted so it pops out from its description at a glance. The
// fiddlier caveats (comma lists, ID-based "yourself" matching, and so on)
// used to be crammed in here as a "_Tips_" footer - they now live in their
// own !tips command instead (see TIPS_TEXT/handleTips below), pointed to
// from the "Other" section, so this stays a quick reference rather than a
// wall of text someone has to scroll past just to see what commands exist.
const HELP_TEXT = [
  '*Commands*',
  '',
  '*Joining and leaving*',
  `• *${COMMAND_PREFIX}in [name]* - add yourself, or [name]`,
  `• *${COMMAND_PREFIX}out [name]* - remove yourself, or [name]`,
  `• *${COMMAND_PREFIX}list* - show the current list`,
  '',
  '*Payments*',
  `• *${COMMAND_PREFIX}paid [name]* - mark yourself, or [name], as paid`,
  '',
  '*Other*',
  `• *@-mention me* - plain English works too instead of typing a command, e.g. "@Snoopy put me down" (if this group has it turned on - see ${COMMAND_PREFIX}tips for more)`,
  `• *${COMMAND_PREFIX}help* - show this message`,
  `• *${COMMAND_PREFIX}tips* - tips and caveats for the everyday commands above (comma lists, +N guests, and more)`,
  `• *${COMMAND_PREFIX}admin* - show admin-only commands`,
].join('\n');

// The everyday tips/caveats that used to be HELP_TEXT's own "_Tips_"
// footer - unchanged content, just its own reply now (see !tips below).
const TIPS_TEXT = [
  '*Tips*',
  '',
  '*Natural language*',
  `_• Prefer plain English? @-mention me instead of typing a command, e.g. @Snoopy put me down - only works if an admin has turned on ${COMMAND_PREFIX}ai_`,
  '',
  '*Joining and leaving*',
  `_• ${COMMAND_PREFIX}in/${COMMAND_PREFIX}out/${COMMAND_PREFIX}paid accept comma-separated names, e.g. ${COMMAND_PREFIX}in Alex, Sam, Sam+1 - up to ${MAX_NAMES_PER_COMMAND} at once (no limit for admins)_`,
  '',
  `_• Bringing unnamed friends? ${COMMAND_PREFIX}in +2 adds yourself plus 2 guests (you, you+1, you+2) - same for ${COMMAND_PREFIX}out/${COMMAND_PREFIX}paid_`,
  '',
  '_• No [name] means yourself - matched by your WhatsApp account, not your display name_',
  '',
  '_• Anyone can remove an entry a regular member added. An admin\'s entry needs an admin to remove - others just get flagged (TBC) for review instead_',
  '',
  `_• Past the limit, ${COMMAND_PREFIX}in waitlists instead - auto-promoted (and tagged) when a spot opens_`,
  '',
  '*Payments*',
  `_• Lead with "paid" on ${COMMAND_PREFIX}in/${COMMAND_PREFIX}out to confirm payment in one message, e.g. ${COMMAND_PREFIX}in paid Alex, Sam_`,
  '',
  '*Other*',
  `_• ${COMMAND_PREFIX}in/${COMMAND_PREFIX}out/${COMMAND_PREFIX}paid sent while Snoopy's briefly offline still go through once it reconnects_`,
].join('\n');

// Admin-only commands, split out so !help stays short for everyday use.
// Same "tips live in their own command" split as HELP_TEXT/TIPS_TEXT above
// - see ADMIN_TIPS_TEXT/handleAdminTips below for the admin-side tips
// footer this used to include inline.
const ADMIN_HELP_TEXT = [
  '*Admin commands*',
  '',
  '*List setup*',
  `• *${COMMAND_PREFIX}newlist DD/MM|same [location] | [courts] | [time] [with name1, name2, ...]* - start a new dated list, optionally signing people straight up on it. Use "same" instead of a date to reuse whatever day of the week the current list is already on`,
  `• *${COMMAND_PREFIX}date [DD/MM]* - correct the current list's date without starting a new one (admins to change)`,
  `• *${COMMAND_PREFIX}location [text]* - location (admins to change)`,
  `• *${COMMAND_PREFIX}courts [numbers]* - courts booked, e.g. 13-18 (admins to change; lead with "add"/"extra", e.g. ${COMMAND_PREFIX}courts add 1, to add to the courts already booked instead of replacing them)`,
  `• *${COMMAND_PREFIX}time [text]* - start time (admins to change)`,
  `• *${COMMAND_PREFIX}limit [number]* - max people, auto-set from courts (admins to override; ${COMMAND_PREFIX}limit off removes it)`,
  `• *${COMMAND_PREFIX}allow <count>* - let that many extra people in from the waitlist, over the limit if needed - the limit itself doesn't change (admins only)`,
  `• *${COMMAND_PREFIX}clear* - wipe the current list's entries`,
  '',
  '*Payments*',
  `• *${COMMAND_PREFIX}paymentlabel [text]* - payment-due header, e.g. "${PAYMENT_LABEL}" (admins to change)`,
  `• *${COMMAND_PREFIX}exempt [name1, name2, ...]* - saved roster of people who never need to pay, e.g. the organizer or a sponsor (admins to change)`,
  `• *${COMMAND_PREFIX}clearpayments* - wipe who currently owes payment`,
  '',
  '*Rosters*',
  `• *${COMMAND_PREFIX}regulars [name1, name2, ...]* - saved roster of regular players, reusable later via "regular players" in ${COMMAND_PREFIX}in/${COMMAND_PREFIX}newlist (admins to change)`,
  '',
  '*Group settings*',
  `• *${COMMAND_PREFIX}inactivity [on|off]* - inactivity reminders for this group, off by default (admins to change)`,
  `• *${COMMAND_PREFIX}stale* - who's been warned for inactivity, and who's overdue`,
  `• *${COMMAND_PREFIX}spamfilter [on|off]* - auto-delete stock/crypto spam in this group, ON by default (admins to change)`,
  `• *${COMMAND_PREFIX}ai [on|off]* - let people @-mention me with a plain-English request instead of exact commands, ON by default once set up (admins to change)`,
  '',
  '*Other*',
  `• *${COMMAND_PREFIX}update <paste the list, edited>* - bulk-edit Attendance/Waitlist/Payment by pasting the list back with changes`,
  `• *${COMMAND_PREFIX}undo* - reverse the last change made in this group, whatever it was (admins only)`,
  `• *${COMMAND_PREFIX}admintips* - tips and caveats for the admin commands above (${COMMAND_PREFIX}update's header block, and more)`,
].join('\n');

// The admin-side tips/caveats that used to be ADMIN_HELP_TEXT's own
// "_Tips_" footer - unchanged content, just its own reply now (see
// !admintips below).
const ADMIN_TIPS_TEXT = [
  '*Admin tips*',
  '',
  '*List setup*',
  `_• ${COMMAND_PREFIX}newlist's location/courts/time carry forward if left out, e.g. ${COMMAND_PREFIX}newlist 20/08 EBC | 13-18 | 8PM start - or change one any time with ${COMMAND_PREFIX}location/${COMMAND_PREFIX}courts/${COMMAND_PREFIX}time. Typo'd the date? ${COMMAND_PREFIX}date DD/MM fixes just that. ${COMMAND_PREFIX}newlist same reuses the current list's day of the week instead of a date - same as "@Snoopy create a new list" with no date mentioned_`,
  '',
  `_• Add "with name1, name2, ..." to the end of ${COMMAND_PREFIX}newlist to sign everyone up on the new list at once, e.g. ${COMMAND_PREFIX}newlist 20/08 with Harry, Bonny, Ron - respects the limit, waitlisting anyone over it like ${COMMAND_PREFIX}in would_`,
  '',
  `_• ${COMMAND_PREFIX}courts headcount is automatic, e.g. ${COMMAND_PREFIX}courts 13-18 shows as (6), and the limit auto-scales to courts × ${PLAYERS_PER_COURT} (override with ${COMMAND_PREFIX}limit). Plain ${COMMAND_PREFIX}courts REPLACES the list - lead with "add"/"extra" (e.g. ${COMMAND_PREFIX}courts add 1) to add to what's booked instead_`,
  '',
  '*Payments*',
  `_• ${COMMAND_PREFIX}exempt works like ${COMMAND_PREFIX}regulars (set/add/remove/clear) but for who never owes money - skipped every time ${COMMAND_PREFIX}newlist carries attendance into payment-due. Forward-looking only - use ${COMMAND_PREFIX}paid <name> too to also clear an existing balance_`,
  '',
  '*Rosters*',
  `_• Save your regulars once with ${COMMAND_PREFIX}regulars Harry, Bonny, Ron (add/remove/clear to tweak), then reuse them any time with "regular players" in place of names - ${COMMAND_PREFIX}in regular players, or ${COMMAND_PREFIX}newlist 20/08 with regular players. Sticks around across ${COMMAND_PREFIX}newlist/${COMMAND_PREFIX}clear until changed_`,
  '',
  '*Group settings*',
  `_• ${COMMAND_PREFIX}inactivity is per-group, off by default - going quiet for ${INACTIVITY_WARN_AFTER_DAYS}d gets you tagged (any message clears it); admins are always exempt_`,
  '',
  `_• ${COMMAND_PREFIX}spamfilter is per-group, ON by default - deletes WhatsApp invite links and link+stock/crypto messages automatically (admins exempt); ${COMMAND_PREFIX}spamfilter off to allow them_`,
  '',
  `_• ${COMMAND_PREFIX}ai is per-group, ON by default once it's set up (off everywhere until then) - @-mentioning me with a plain request maps to a command (including admin ones for admins, relative dates like "next Wednesday", and the saved ${COMMAND_PREFIX}regulars roster). One message can bundle several requests, done in order. Unsure or unrelated? I say so rather than guess - I always reply when tagged_`,
  '',
  '*Other*',
  `_• ${COMMAND_PREFIX}update reads back a copy-pasted, edited list: type ${COMMAND_PREFIX}update on its own line, then paste the list with your edits underneath. Keep the date/location/courts/time block above *Attendance* to edit those too - any field left out of it gets cleared; leave the whole block out to leave them untouched. The payment header itself is never read this way - use ${COMMAND_PREFIX}paymentlabel_`,
  '',
  `_• ${COMMAND_PREFIX}undo reverses whatever the last change was - a join/leave, a ${COMMAND_PREFIX}clear, a whole ${COMMAND_PREFIX}newlist, anything. Only one step back is remembered, and running it twice flips back and forth (doubling as a redo)_`,
].join('\n');

async function handleHelp(ctx) {
  await ctx.reply(HELP_TEXT);
}

async function handleTips(ctx) {
  await ctx.reply(TIPS_TEXT);
}

async function handleAdminHelp(ctx) {
  const { sock, groupId, senderId, reply } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can view the admin commands.');
    return;
  }
  await reply(ADMIN_HELP_TEXT);
}

// Same admin gate as handleAdminHelp above - the admin tips reference
// admin-only commands (!update's header-block behavior, etc.), so there's
// nothing useful in here for a non-admin anyway.
async function handleAdminTips(ctx) {
  const { sock, groupId, senderId, reply } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can view the admin tips.');
    return;
  }
  await reply(ADMIN_TIPS_TEXT);
}

module.exports = {
  HELP_TEXT,
  handleHelp,
  TIPS_TEXT,
  handleTips,
  ADMIN_HELP_TEXT,
  handleAdminHelp,
  ADMIN_TIPS_TEXT,
  handleAdminTips,
};