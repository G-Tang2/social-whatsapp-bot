// commands/admin.js
// Admin-gated list-management commands: !clear, !clearpayments, !newlist,
// !location, !courts, !time, !limit, !allow, !paymentlabel, !regulars,
// !exempt, !settournament, !tournamentlimit, !tournamentwinners, !undo,
// !update.
// (!tournament itself - the rules-viewing command - lives here too, but is
// NOT admin-gated; see its doc comment below for why it's in this file
// anyway.)
// Faithful ports of the corresponding switch cases from
// the old monolithic index.js - reply strings and control flow are
// unchanged. !clear and !clearpayments have no confirmation prompt or
// archive of their own - they're immediate - but that no longer means
// they're irreversible: see !undo/handleUndo below, which can reverse
// the LAST mutating command run in the group (any of them, not just
// these two) via a generic before/after snapshot mechanism in
// commands/index.js and store.js, not anything specific to !clear.

const {
  getCurrentEvent,
  getDuePayments,
  getDuePaymentsLabel,
  setDuePaymentsLabel,
  setDate,
  setLocation,
  setCourts,
  addCourts,
  setTime,
  getLimit,
  setLimit,
  allowFromWaitlist,
  clearList,
  clearDuePayments,
  applyListUpdate,
  newList,
  addEntry,
  getRegularPlayers,
  setRegularPlayers,
  getPaymentExempt,
  setPaymentExempt,
  isTournamentEnabled,
  setTournamentEnabled,
  getTournamentLimit,
  setTournamentLimit,
  getTournamentWinners,
  setTournamentWinners,
  waiveDuePaymentsForWinners,
  getTournamentRules,
  setTournamentRules,
  getCourtCanceller,
  setCourtCanceller,
  getUndoSnapshot,
  restoreUndoableState,
  normalizeName,
} = require('../store');
const { parseTypedDate, formatDisplayDate, nextOccurrenceOfSameWeekday } = require('../dates');
const { isGroupAdmin } = require('../lib/adminCheck');
const { checkEntry } = require('../moderation');
const { parseListSections, parseHeaderFields } = require('../lib/listParser');
const {
  COMMAND_PREFIX,
  MAX_LABEL_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_TIME_LENGTH,
  MAX_COURTS_LENGTH,
  MAX_LIMIT,
} = require('../lib/config');
const {
  parseNewListDetails,
  stripTrailingWithNames,
  stripLeadingCourtsAddKeyword,
  expandRegularPlayersToken,
  formatPromotedMessage,
  formatTournamentPromotedMessage,
  formatTournamentRoster,
  getMentionedJids,
  normalizeJid,
} = require('../lib/helpers');

async function handleClear(ctx) {
  const { sock, groupId, senderId, reply, postList } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can clear the list.');
    return;
  }
  clearList(groupId);
  await postList();
}

// Wipes who currently owes payment, without touching the list itself
// (entries/waitlist/date/location/courts/time all stay as they are) - the
// mirror image of !clear, which wipes the list but leaves duePayments
// alone. For forgiving debt in bulk (e.g. start of a new season) rather
// than one name at a time with !paid.
async function handleClearpayments(ctx) {
  const { sock, groupId, senderId, reply, postList } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can clear the payment list.');
    return;
  }
  if (getDuePayments(groupId).length === 0) {
    await reply('Nobody currently owes payment - nothing to clear.');
    return;
  }
  clearDuePayments(groupId);
  await postList();
}

// Merges the saved !regulars roster (plus any extra `names` already given,
// e.g. !newlist's own "with ..." clause) onto whatever list is CURRENT for
// `groupId` right now - shared by handleNewlist below and
// lib/autoNewlistScheduler.js's !autonewlist feature, which needs the exact
// same "regulars always get added" behavior for the list it starts on its
// own. `addedBy`/`addedByIsAdmin` are attributed to whoever/whatever
// triggered the add (the admin running !newlist, or null/true for an
// automatic add - see store.js's addEntry doc comment for what these
// fields are for). Respects whatever limit/waitlist the list ends up with,
// exactly like !in. Returns `{ rejected }`, a list of human-readable
// "name - reason" strings for anyone moderation blocked or who was already
// on the list - callers decide what (if anything) to do with them, since
// an automatic add has no message to reply to.
//
// Anyone who's actually on the saved !regulars roster is opted straight
// into the tournament too (wantsTournament: true on addEntry - a no-op per
// addEntry's own doc comment if the group's tournament isn't enabled or is
// already full, same as any other tournament add); an explicitly-passed
// `names` entry keeps its own (non-tournament) treatment unless it happens
// to literally match a saved regular's name, exactly like !newlist's old
// inline behavior this was extracted from.
//
// "regular players" (see REGULAR_PLAYERS_TOKEN/expandRegularPlayersToken in
// lib/helpers.js, and !regulars below for how that roster is set) still
// works as an explicit placeholder inside `names` too, e.g. to interleave
// regulars at a specific position alongside extra guests - harmless now
// that regulars are merged in automatically anyway, since the dedupe below
// just skips them the second time.
function addRegularsToCurrentList(groupId, addedBy, addedByIsAdmin, names = []) {
  const regularPlayersExpansion = expandRegularPlayersToken(names, groupId);
  const expandedNames = regularPlayersExpansion.names;

  const rejected = [];
  if (regularPlayersExpansion.usedEmptyRegularPlayers) {
    rejected.push(`regular players - none saved yet (see ${COMMAND_PREFIX}regulars to set them)`);
  }

  const regulars = getRegularPlayers(groupId);
  const regularNamesNormalized = new Set(regulars.map(normalizeName));
  const seen = new Set(expandedNames.map(normalizeName));
  for (const name of regulars) {
    if (seen.has(normalizeName(name))) continue;
    seen.add(normalizeName(name));
    expandedNames.push(name);
  }

  for (const name of expandedNames) {
    const modResult = checkEntry(name);
    if (!modResult.ok) {
      rejected.push(`${name} - ${modResult.reason}`);
      continue;
    }
    const result = addEntry(groupId, name, addedBy, addedByIsAdmin, false, regularNamesNormalized.has(normalizeName(name)));
    if (!result.ok) {
      rejected.push(`${name.trim()} - already on the list`);
    }
  }
  return { rejected };
}

async function handleNewlist(ctx) {
  const { sock, groupId, senderId, argText, reply, postList } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can start a new list.');
    return;
  }

  if (!argText) {
    await reply(
      `Usage: ${COMMAND_PREFIX}newlist DD/MM [location] | [courts] | [time] [with name1, name2, ...]\nExample: ${COMMAND_PREFIX}newlist 20/08 EBC | 13-18 | 8PM start with Peter, Chris, Linda\n(No year - it's inferred as the next upcoming occurrence of that day/month. Location/courts/time are optional and carry forward from the current list if left out. The optional trailing "with ..." clause immediately signs up everyone named, in order, on the brand new list. The saved regulars roster (see ${COMMAND_PREFIX}regulars) is always added too and opted straight into the tournament, whether or not "with ..." is used. Use "same" instead of a date, e.g. ${COMMAND_PREFIX}newlist same, to reuse whatever day of the week the current list is already on.)`
    );
    return;
  }

  const spaceIdx2 = argText.indexOf(' ');
  const dateStr = (spaceIdx2 === -1 ? argText : argText.slice(0, spaceIdx2)).trim();
  const rest = (spaceIdx2 === -1 ? '' : argText.slice(spaceIdx2 + 1)).trim();

  // "same" (in place of a DD/MM date) reuses whatever day of the week the
  // CURRENT list is already on, e.g. "!newlist same" or "!newlist same
  // with Peter, Chris" - handy for a recurring weekly/biweekly list where
  // the day never changes, and it's also what the natural-language AI
  // mapping falls back to for a bare "create a new list" request with no
  // date mentioned at all (see lib/geminiCommand.js's matching SPECIAL
  // CASE) - resolved deterministically here in code (via
  // dates.js's nextOccurrenceOfSameWeekday), not left to the AI to guess
  // the arithmetic itself. Computed relative to TODAY, not the current
  // list's own date - see that function's doc comment for why.
  let resolvedDate;
  if (dateStr.toLowerCase() === 'same') {
    const currentDate = getCurrentEvent(groupId).date;
    if (!currentDate) {
      await reply(
        `The current list doesn't have a date set yet, so there's no day to reuse - use ${COMMAND_PREFIX}newlist DD/MM instead.`
      );
      return;
    }
    resolvedDate = nextOccurrenceOfSameWeekday(currentDate);
  } else {
    resolvedDate = parseTypedDate(dateStr);
  }
  if (!resolvedDate) {
    await reply(
      `"${dateStr}" isn't a valid date - use DD/MM, e.g. ${COMMAND_PREFIX}newlist 20/08 EBC | 13-18 | 8PM start`
    );
    return;
  }

  // Split off an optional trailing "with <names>" clause BEFORE handing
  // the rest to parseNewListDetails - see stripTrailingWithNames's doc
  // comment (lib/helpers.js) for why this has to be a separate keyword
  // rather than a 4th "|" segment.
  const { rest: detailsRest, namesText } = stripTrailingWithNames(rest);

  const { details, error } = parseNewListDetails(detailsRest);
  if (error) {
    await reply(error);
    return;
  }

  // No separate confirmation message on success - you were authorized,
  // so the action just happens, and the posted list below is the proof.
  newList(groupId, resolvedDate, details);

  // Optional "with <names>" clause immediately pre-populates the brand
  // new list, so e.g. "!newlist 20/08 EBC | 13-18 | 8PM start with Peter,
  // Chris, Linda" both starts the new cycle AND signs everyone up in one
  // command, instead of needing a separate !in right after (particularly
  // handy for the natural-language AI mention path - see
  // lib/geminiCommand.js's COMMAND_ARG_GUIDE - where "create a new list
  // for next Wednesday with <25 names>" is one message, not 26 commands).
  // Reuses the same per-name moderation/insert building blocks as !in
  // (checkEntry, addEntry - respecting whatever limit/waitlist the new
  // list ends up with, exactly like any other add), just attributed to
  // the admin who ran !newlist rather than to whoever's being added -
  // `self` is always false here, even if the admin's own name happens to
  // be among them (same as typing "!in <own name>" explicitly rather than
  // a bare !in - see store.js's addEntry doc comment). No
  // MAX_NAMES_PER_COMMAND cap, matching !in's own no-cap-for-admins
  // policy, since !newlist is already admin-only.
  //
  // The saved regulars roster (see !regulars) is ALSO always merged in
  // here, every time - not just when "with regular players" is typed - via
  // the shared addRegularsToCurrentList helper above (see its own doc
  // comment for the tournament opt-in and dedupe behavior).
  const names = namesText ? namesText.split(',').map((n) => n.trim()).filter(Boolean) : [];
  const { rejected } = addRegularsToCurrentList(groupId, senderId, true, names);
  if (rejected.length) {
    await reply(`New list started. Couldn't add:\n${rejected.join('\n')}`);
  }

  await postList();
}

// Corrects the CURRENT list's date without starting a new one - unlike
// !newlist, this doesn't archive anything or touch entries/waitlist/
// duePayments/location/courts/time/limit, it just fixes the one field
// (e.g. an admin typo'd the date in !newlist, or the session moved to a
// different day). Same "view with no argument, admins-only to change"
// pattern as !location/!courts/!time below.
async function handleDate(ctx) {
  const { sock, groupId, senderId, argText, reply, postList } = ctx;
  if (!argText) {
    const currentDate = getCurrentEvent(groupId).date;
    await reply(
      currentDate
        ? `Current date: ${formatDisplayDate(currentDate)}\nTo change it (admins only): ${COMMAND_PREFIX}date DD/MM`
        : `No date set.\nTo set one (admins only): ${COMMAND_PREFIX}date DD/MM, e.g. ${COMMAND_PREFIX}date 20/08`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the date.');
    return;
  }

  const resolvedDate = parseTypedDate(argText);
  if (!resolvedDate) {
    await reply(`"${argText}" isn't a valid date - use DD/MM, e.g. ${COMMAND_PREFIX}date 20/08`);
    return;
  }

  // No separate confirmation message on success - you were authorized, so
  // the action just happens, and the posted list (with the corrected date
  // in its header) is the proof.
  setDate(groupId, resolvedDate);
  await postList();
}

async function handleLocation(ctx) {
  const { sock, groupId, senderId, argText, reply, postList } = ctx;
  if (!argText) {
    const currentLocation = getCurrentEvent(groupId).location;
    await reply(
      currentLocation
        ? `Current location: ${currentLocation}\nTo change it (admins only): ${COMMAND_PREFIX}location <new location>`
        : `No location set.\nTo set one (admins only): ${COMMAND_PREFIX}location <location>`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the location.');
    return;
  }

  if (argText.length > MAX_LOCATION_LENGTH) {
    await reply(`That location is too long (max ${MAX_LOCATION_LENGTH} characters).`);
    return;
  }

  // No separate confirmation message on success - you were authorized,
  // so the action just happens, and the posted list (with the new
  // location in its header) is the proof.
  setLocation(groupId, argText);
  await postList();
}

// Leading "add"/"extra" keyword (see stripLeadingCourtsAddKeyword) lets an
// admin ADD to whatever courts are already booked instead of replacing
// them outright, e.g. "!courts add 1" or "!courts extra 12-14" - covers
// both the typed command and the natural-language phrasing the AI command
// feature maps into it (see lib/geminiCommand.js's "courts" guide entry),
// since "I got extra courts 12-14" is exactly this case. With no leading
// keyword, plain "!courts 13-18" still REPLACES the courts entirely, same
// as always.
async function handleCourts(ctx) {
  const { sock, msg, groupId, senderId, argText, reply, postList } = ctx;
  if (!argText) {
    const event = getCurrentEvent(groupId);
    await reply(
      event.courts
        ? `Current courts: ${event.courts} (${event.courtCount})\nTo change it (admins only): ${COMMAND_PREFIX}courts <numbers>, e.g. ${COMMAND_PREFIX}courts 13-18\nTo add MORE courts on top of these (admins only): ${COMMAND_PREFIX}courts add <numbers>, e.g. ${COMMAND_PREFIX}courts add 1`
        : `No courts set.\nTo set some (admins only): ${COMMAND_PREFIX}courts <numbers>, e.g. ${COMMAND_PREFIX}courts 13-18`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the courts.');
    return;
  }

  if (argText.length > MAX_COURTS_LENGTH) {
    await reply(`That's too long (max ${MAX_COURTS_LENGTH} characters).`);
    return;
  }

  const { rest, additive } = stripLeadingCourtsAddKeyword(argText);
  const result = additive ? addCourts(groupId, rest) : setCourts(groupId, rest);
  if (!result.ok) {
    await reply(
      additive
        ? `"${rest}" isn't a valid court list to add - use numbers and/or ranges separated by commas, e.g. ${COMMAND_PREFIX}courts add 1 or ${COMMAND_PREFIX}courts extra 12-14`
        : `"${argText}" isn't a valid court list - use numbers and/or ranges separated by commas, e.g. ${COMMAND_PREFIX}courts 13-18 or ${COMMAND_PREFIX}courts 1, 2, 5-8`
    );
    return;
  }

  // Setting real courts auto-scales the limit (PLAYERS_PER_COURT per
  // court), which can free up room or push the current headcount over
  // it - worth calling out anyone that promoted or got moved to the
  // waitlist as a result, same as !limit does. Otherwise, no separate
  // confirmation message on success - you were authorized, so the
  // action just happens, and the posted list (with the new
  // courts/headcount/limit in its header) is the proof - including for
  // an "add" that turned out to be a total no-op because every number
  // given was already booked (result.added would just be empty).
  if (result.promoted.length) {
    // Sent directly (not `reply`) so we can pass `mentions` and
    // actually notify each promoted person.
    const { text, mentions } = formatPromotedMessage(result.promoted);
    await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
  }
  if (result.demoted.length) {
    await reply(`New limit is below the current headcount - moved to the waitlist, in order:\n${result.demoted.map((e) => e.name).join('\n')}`);
  }
  await postList();
}

async function handleTime(ctx) {
  const { sock, groupId, senderId, argText, reply, postList } = ctx;
  if (!argText) {
    const currentTime = getCurrentEvent(groupId).time;
    await reply(
      currentTime
        ? `Current time: ${currentTime}\nTo change it (admins only): ${COMMAND_PREFIX}time <text>`
        : `No time set.\nTo set one (admins only): ${COMMAND_PREFIX}time <text>, e.g. ${COMMAND_PREFIX}time 8PM start`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the time.');
    return;
  }

  if (argText.length > MAX_TIME_LENGTH) {
    await reply(`That's too long (max ${MAX_TIME_LENGTH} characters).`);
    return;
  }

  // No separate confirmation message on success - you were authorized,
  // so the action just happens, and the posted list (with the new
  // time in its header) is the proof.
  setTime(groupId, argText);
  await postList();
}

async function handleLimit(ctx) {
  const { sock, msg, groupId, senderId, argText, reply, postList } = ctx;
  if (!argText) {
    const currentLimit = getLimit(groupId);
    await reply(
      currentLimit
        ? `Current limit: ${currentLimit}\nTo change it (admins only): ${COMMAND_PREFIX}limit <number>, or ${COMMAND_PREFIX}limit off to remove it`
        : `No limit set - everyone who joins goes straight onto the list.\nTo set one (admins only): ${COMMAND_PREFIX}limit <number>`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the participant limit.');
    return;
  }

  const normalizedArg = argText.trim().toLowerCase();
  let newLimit;
  if (['off', 'none', 'clear', 'unlimited', '0'].includes(normalizedArg)) {
    newLimit = null;
  } else {
    const parsed = Number(argText.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      await reply(
        `"${argText}" isn't a valid limit - use a whole number, e.g. ${COMMAND_PREFIX}limit 20, or ${COMMAND_PREFIX}limit off to remove it`
      );
      return;
    }
    if (parsed > MAX_LIMIT) {
      await reply(`That limit is too high (max ${MAX_LIMIT}).`);
      return;
    }
    newLimit = parsed;
  }

  // No separate confirmation message on success - you were authorized,
  // so the action just happens, and the posted list (its count vs.
  // limit, and anyone freshly promoted/demoted) is the proof.
  const { promoted, demoted } = setLimit(groupId, newLimit);
  if (promoted.length) {
    // Sent directly (not `reply`) so we can pass `mentions` and
    // actually notify each promoted person.
    const { text, mentions } = formatPromotedMessage(promoted);
    await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
  }
  if (demoted.length) {
    await reply(`New limit is below the current headcount - moved to the waitlist, in order:\n${demoted.map((e) => e.name).join('\n')}`);
  }
  await postList();
}

async function handleAllow(ctx) {
  const { sock, msg, groupId, senderId, argText, reply, postList } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can let extra people in from the waitlist.');
    return;
  }

  const parsedCount = Number((argText || '').trim());
  if (!Number.isInteger(parsedCount) || parsedCount <= 0) {
    await reply(
      `Usage: ${COMMAND_PREFIX}allow <number>\nExample: ${COMMAND_PREFIX}allow 2 - moves the first 2 people off the waitlist onto the list, over the limit if needed (the limit itself doesn't change)`
    );
    return;
  }

  const { moved, limit } = allowFromWaitlist(groupId, parsedCount);

  if (moved.length === 0) {
    await reply('The waitlist is empty - nobody to let in.');
    return;
  }
  if (moved.length < parsedCount) {
    await reply(
      `Only ${moved.length} ${moved.length === 1 ? 'person was' : 'people were'} on the waitlist - moved ${moved.length === 1 ? 'them' : 'all of them'} onto the list. Limit is still ${limit == null ? 'unset' : limit}.`
    );
  }
  // Tag whoever just got moved up, same as any other promotion off the
  // waitlist - !allow is still a promotion from their point of view,
  // even though it was admin-triggered rather than a freed-up spot.
  const { text, mentions } = formatPromotedMessage(moved);
  await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
  // No further separate confirmation - the posted list (higher count,
  // possibly over the still-unchanged limit, shorter/empty waitlist) is
  // proof the rest went through.
  await postList();
}

async function handlePaymentlabel(ctx) {
  const { sock, groupId, senderId, argText, reply, postList } = ctx;
  if (!argText) {
    const current = getDuePaymentsLabel(groupId);
    await reply(
      `Current payment-due header: *${current}*\nTo change it (admins only): ${COMMAND_PREFIX}paymentlabel <new header>`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the payment-due header.');
    return;
  }

  if (argText.length > MAX_LABEL_LENGTH) {
    await reply(`That header is too long (max ${MAX_LABEL_LENGTH} characters).`);
    return;
  }

  // No separate confirmation message on success - you were authorized,
  // so the action just happens, and the posted list (with the new
  // header above the payment-due section) is the proof.
  setDuePaymentsLabel(groupId, argText);
  await postList();
}

// Formats the regular-players roster the same numbered way as any other
// list section in this bot, for both handleRegulars' own view/confirmation
// replies below.
function formatRegularPlayers(names) {
  if (!names.length) return '(none set)';
  return names.map((n, i) => `${i + 1}. ${n}`).join('\n');
}

// !regulars manages a per-group, persistent (see store.js's
// getRegularPlayers/setRegularPlayers - it survives !newlist/!clear, unlike
// everything in the current list itself) saved roster of "regular
// players" - purely a convenience for referencing them later without
// retyping every name, via the "regular players" placeholder token (see
// REGULAR_PLAYERS_TOKEN/expandRegularPlayersToken in lib/helpers.js) that
// !in and !newlist's "with ..." clause both understand, e.g. "!in regular
// players" or "!newlist 20/08 with regular players".
//
// Bare !regulars (no argument) just shows the current roster - anyone can
// do this, same "viewing: anyone" pattern as !location/!courts/!time.
// Changing it is admins-only, with four sub-forms recognized by a
// leading keyword (case-insensitive) in argText:
//   !regulars clear                -> empties the roster
//   !regulars add <names>          -> adds to the existing roster (no dupes)
//   !regulars remove <names>       -> removes matching names (by identity,
//                                    same normalizeName() case/whitespace
//                                    matching as everything else in this
//                                    bot - see store.js)
//   !regulars <names>              -> REPLACES the whole roster outright -
//                                    the natural mapping for someone just
//                                    declaring who the regulars are for
//                                    the first time, e.g. "these people
//                                    are regular players: Peter, Chris, Linda"
// Always replies with the resulting roster (there's no "list" to repost
// that would otherwise make the change visible, unlike most other admin
// commands here) rather than staying quiet on success.
async function handleRegulars(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;

  if (!argText) {
    const current = getRegularPlayers(groupId);
    await reply(
      `*Regular players*\n${formatRegularPlayers(current)}\n\nTo change (admins only): ${COMMAND_PREFIX}regulars Name1, Name2, ... (replaces the whole list), ${COMMAND_PREFIX}regulars add <names>, ${COMMAND_PREFIX}regulars remove <names>, or ${COMMAND_PREFIX}regulars clear`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the regular players list.');
    return;
  }

  const trimmed = argText.trim();

  if (/^clear$/i.test(trimmed)) {
    setRegularPlayers(groupId, []);
    await reply(`Regular players list cleared.`);
    return;
  }

  const addMatch = trimmed.match(/^add\s+(.+)$/i);
  const removeMatch = trimmed.match(/^remove\s+(.+)$/i);
  const mode = addMatch ? 'add' : removeMatch ? 'remove' : 'set';
  const namesPart = addMatch ? addMatch[1] : removeMatch ? removeMatch[1] : trimmed;

  const requestedNames = namesPart.split(',').map((n) => n.trim()).filter(Boolean);
  if (!requestedNames.length) {
    await reply(`Usage: ${COMMAND_PREFIX}regulars Name1, Name2, ... | ${COMMAND_PREFIX}regulars add <names> | ${COMMAND_PREFIX}regulars remove <names> | ${COMMAND_PREFIX}regulars clear`);
    return;
  }

  const rejected = [];
  const validNames = [];
  for (const name of requestedNames) {
    const modResult = checkEntry(name);
    if (!modResult.ok) {
      rejected.push(`${name} - ${modResult.reason}`);
    } else {
      validNames.push(name);
    }
  }

  const current = getRegularPlayers(groupId);
  let updated;
  if (mode === 'set') {
    updated = setRegularPlayers(groupId, validNames);
  } else if (mode === 'add') {
    const existingNormalized = new Set(current.map(normalizeName));
    const merged = [...current];
    for (const name of validNames) {
      const key = normalizeName(name);
      if (!existingNormalized.has(key)) {
        merged.push(name);
        existingNormalized.add(key);
      }
    }
    updated = setRegularPlayers(groupId, merged);
  } else {
    const toRemove = new Set(validNames.map(normalizeName));
    updated = setRegularPlayers(groupId, current.filter((n) => !toRemove.has(normalizeName(n))));
  }

  if (rejected.length) {
    await reply(`Couldn't include:\n${rejected.join('\n')}`);
  }
  await reply(`*Regular players*\n${formatRegularPlayers(updated)}`);
}

// Formats the payment-exempt roster the same numbered way as regular
// players/any other list section - shared by handleExempt's own
// view/confirmation replies below.
function formatPaymentExempt(names) {
  if (!names.length) return '(none set)';
  return names.map((n, i) => `${i + 1}. ${n}`).join('\n');
}

// !exempt manages a per-group, persistent (see store.js's
// getPaymentExempt/setPaymentExempt - it survives !newlist/!clear, same as
// !regulars' roster) saved list of names who never need to pay - the
// organizer themselves, a sponsor, a coach, whoever. Checked by newList()
// (store.js) when it carries the outgoing attendance list into
// duePayments: an exempt name is simply skipped, so it never ends up owing
// anything from attending, no matter how many cycles run.
//
// Deliberately forward-looking only, same as everything else that "carries
// forward" in this bot rather than rewriting history: adding someone here
// does NOT retroactively clear any debt they already owe from before - use
// !paid <name> for that if you want to also forgive an existing balance
// at the same time as exempting them going forward.
//
// Bare !exempt (no argument) just shows the current roster - anyone can do
// this, same "viewing: anyone" pattern as !regulars/!location/!courts.
// Changing it is admins-only, with the same four sub-forms !regulars uses:
//   !exempt clear                -> empties the roster (nobody's exempt anymore)
//   !exempt add <names>          -> adds to the existing roster (no dupes)
//   !exempt remove <names>       -> removes matching names (by identity,
//                                    same normalizeName() case/whitespace
//                                    matching as everything else in this bot)
//   !exempt <names>              -> REPLACES the whole roster outright
// Always replies with the resulting roster, same as !regulars.
async function handleExempt(ctx) {
  const { sock, groupId, senderId, argText, reply } = ctx;

  if (!argText) {
    const current = getPaymentExempt(groupId);
    await reply(
      `*Payment exempt*\n${formatPaymentExempt(current)}\n\nThese names never get added to the payment-due list, no matter how many lists they're on. To change (admins only): ${COMMAND_PREFIX}exempt Name1, Name2, ... (replaces the whole list), ${COMMAND_PREFIX}exempt add <names>, ${COMMAND_PREFIX}exempt remove <names>, or ${COMMAND_PREFIX}exempt clear`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the payment-exempt list.');
    return;
  }

  const trimmed = argText.trim();

  if (/^clear$/i.test(trimmed)) {
    setPaymentExempt(groupId, []);
    await reply(`Payment-exempt list cleared.`);
    return;
  }

  const addMatch = trimmed.match(/^add\s+(.+)$/i);
  const removeMatch = trimmed.match(/^remove\s+(.+)$/i);
  const mode = addMatch ? 'add' : removeMatch ? 'remove' : 'set';
  const namesPart = addMatch ? addMatch[1] : removeMatch ? removeMatch[1] : trimmed;

  const requestedNames = namesPart.split(',').map((n) => n.trim()).filter(Boolean);
  if (!requestedNames.length) {
    await reply(`Usage: ${COMMAND_PREFIX}exempt Name1, Name2, ... | ${COMMAND_PREFIX}exempt add <names> | ${COMMAND_PREFIX}exempt remove <names> | ${COMMAND_PREFIX}exempt clear`);
    return;
  }

  const rejected = [];
  const validNames = [];
  for (const name of requestedNames) {
    const modResult = checkEntry(name);
    if (!modResult.ok) {
      rejected.push(`${name} - ${modResult.reason}`);
    } else {
      validNames.push(name);
    }
  }

  const current = getPaymentExempt(groupId);
  let updated;
  if (mode === 'set') {
    updated = setPaymentExempt(groupId, validNames);
  } else if (mode === 'add') {
    const existingNormalized = new Set(current.map(normalizeName));
    const merged = [...current];
    for (const name of validNames) {
      const key = normalizeName(name);
      if (!existingNormalized.has(key)) {
        merged.push(name);
        existingNormalized.add(key);
      }
    }
    updated = setPaymentExempt(groupId, merged);
  } else {
    const toRemove = new Set(validNames.map(normalizeName));
    updated = setPaymentExempt(groupId, current.filter((n) => !toRemove.has(normalizeName(n))));
  }

  if (rejected.length) {
    await reply(`Couldn't include:\n${rejected.join('\n')}`);
  }
  await reply(`*Payment exempt*\n${formatPaymentExempt(updated)}`);
}

// !tournament is the view-only companion to !settournament (below) - anyone
// can run it, and all it does is show the tournament rules text an admin
// has set via !settournament rules <text>. It doesn't care whether the
// tournament sub-feature is even on (isTournamentEnabled) - rules can be
// posted ahead of time, same "not gated on the on/off toggle" precedent as
// handleTournamentWinners's bare view above. It lives in this file (rather
// than e.g. commands/list.js) simply to stay next to !settournament, which
// it's the read-only half of.
async function handleTournament(ctx) {
  const { groupId, reply } = ctx;
  const rules = getTournamentRules(groupId);
  await reply(
    rules
      ? `🏆 *Tournament rules*\n\n${rules}`
      : `No tournament rules set yet.\nAn admin can set them with: ${COMMAND_PREFIX}settournament rules <text>`
  );
}

// !settournament manages the group's tournament sub-feature - a subset of
// the regular social Attendance list that people can additionally opt into
// (see commands/list.js's handleIn, which recognizes a leading
// "tournament" keyword the same way it already recognizes "paid"), with
// its own headcount cap (!tournamentlimit, below), a "Congrats to X and Y
// for winning last week's tournament" banner (!tournamentwinners, below)
// shown above the list while it's on, and free-text rules an admin can post
// (below, "rules <text>") that anyone can read back via bare !tournament
// (see handleTournament above - this command used to BE bare !tournament,
// renamed to make room for that read-only rules view). Off by default -
// each group opts in individually, same "each group is independent"
// pattern as !spamfilter/!ai.
//
// Bare !settournament (no argument) is the "info" command anyone can run to
// see who's currently opted in, independent of the full !list - if the
// feature is off, it explains how to turn it on instead (mirroring
// !spamfilter's own bare-view text). Changing it (on/off,
// rules) is admins only, and - unlike most admin commands in this file,
// which stay quiet on success and let the reposted list speak for itself -
// on/off always replies even on success, since flipping tournament on/off
// changes how EVERY future !list looks (see lib/helpers.js's formatList),
// which is worth confirming explicitly, same reasoning as
// !spamfilter's own on/off replies.
async function handleSettournament(ctx) {
  const { sock, groupId, senderId, argText, reply, postList } = ctx;
  const trimmedArg = (argText || '').trim();
  const normalizedArg = trimmedArg.toLowerCase();

  // "rules <text>" (and bare "rules" to view/clear-hint) is handled before
  // the bare-view/on/off branches below since it's the one sub-form that
  // takes free text rather than a fixed keyword.
  if (normalizedArg === 'rules' || normalizedArg.startsWith('rules ')) {
    const rulesText = trimmedArg.slice('rules'.length).trim();
    if (!rulesText) {
      const currentRules = getTournamentRules(groupId);
      await reply(
        currentRules
          ? `Current tournament rules:\n\n${currentRules}\n\nTo change them (admins only): ${COMMAND_PREFIX}settournament rules <text>`
          : `No tournament rules set yet.\nTo set them (admins only): ${COMMAND_PREFIX}settournament rules <text>`
      );
      return;
    }

    const admin = await isGroupAdmin(sock, groupId, senderId);
    if (!admin) {
      await reply('Only a group admin can set the tournament rules.');
      return;
    }

    setTournamentRules(groupId, rulesText);
    await reply(`Tournament rules updated. Anyone can view them with ${COMMAND_PREFIX}tournament.`);
    return;
  }

  if (!normalizedArg) {
    if (!isTournamentEnabled(groupId)) {
      await reply(
        `Tournament is *OFF* for this group.\nTo turn it on (admins only): ${COMMAND_PREFIX}settournament on`
      );
      return;
    }
    const event = getCurrentEvent(groupId);
    const tournamentEntries = event.entries.filter((entry) => entry.tournament);
    // The (🏆 WL) queue, in the same front-of-the-line order they'll get
    // auto-promoted in (see store.js's promoteFromTournamentWaitlist and
    // lib/helpers.js's formatList(), which tags/orders them the same way).
    const waitlistedEntries = event.entries.filter((entry) => entry.tournamentWaitlisted);
    const waitlistedLine = waitlistedEntries.length
      ? `\n\n🏆 WL queue: ${waitlistedEntries.map((entry) => entry.name).join(', ')}`
      : '';
    await reply(
      `${formatTournamentRoster(tournamentEntries, event.tournamentLimit)}${waitlistedLine}\n\n`
        + `To join: @Snoopy sign me up for the tournament\n`
        + `To change (admins only): ${COMMAND_PREFIX}settournament off, ${COMMAND_PREFIX}tournamentlimit <number>, ${COMMAND_PREFIX}tournamentwinners Name1, Name2, ${COMMAND_PREFIX}settournament rules <text>`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can turn the tournament on or off.');
    return;
  }

  if (normalizedArg === 'on') {
    if (isTournamentEnabled(groupId)) {
      await reply('Tournament is already on for this group.');
      return;
    }
    setTournamentEnabled(groupId, true);
    await reply(
      `Tournament turned *on* for this group. Anyone joining (or already on) the social list can opt in - @Snoopy sign me up for the tournament. Set a cap with ${COMMAND_PREFIX}tournamentlimit (admins only) if needed.`
    );
    await postList();
    return;
  }

  if (normalizedArg === 'off') {
    if (!isTournamentEnabled(groupId)) {
      await reply('Tournament is already off for this group.');
      return;
    }
    setTournamentEnabled(groupId, false);
    await reply('Tournament turned *off* for this group. Who was opted in is still remembered, in case it gets turned back on.');
    await postList();
    return;
  }

  await reply(
    `Usage: ${COMMAND_PREFIX}settournament on, ${COMMAND_PREFIX}settournament off, or ${COMMAND_PREFIX}settournament rules <text>\n(No argument shows who's currently in the tournament without changing anything.)`
  );
}

// Same "view with no argument, admins-only to change" pattern as !limit -
// caps how many people can be opted into the tournament at once. Same
// auto-promotion behavior as !limit too when raising it: anyone queued at
// the front of the (🏆 WL) tournament waitlist gets pulled in to fill the
// new room (see store.js's setTournamentLimit/promoteFromTournamentWaitlist
// doc comments) and gets mentioned about it below.
async function handleTournamentLimit(ctx) {
  const { groupId, senderId, sock, msg, argText, reply, postList } = ctx;
  if (!argText) {
    const currentLimit = getTournamentLimit(groupId);
    await reply(
      currentLimit
        ? `Current tournament limit: ${currentLimit}\nTo change it (admins only): ${COMMAND_PREFIX}tournamentlimit <number>, or ${COMMAND_PREFIX}tournamentlimit off to remove it`
        : `No tournament limit set - anyone who opts in gets in.\nTo set one (admins only): ${COMMAND_PREFIX}tournamentlimit <number>`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the tournament limit.');
    return;
  }

  const normalizedArg = argText.trim().toLowerCase();
  let newLimit;
  if (['off', 'none', 'clear', 'unlimited', '0'].includes(normalizedArg)) {
    newLimit = null;
  } else {
    const parsed = Number(argText.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      await reply(
        `"${argText}" isn't a valid limit - use a whole number, e.g. ${COMMAND_PREFIX}tournamentlimit 16, or ${COMMAND_PREFIX}tournamentlimit off to remove it`
      );
      return;
    }
    if (parsed > MAX_LIMIT) {
      await reply(`That limit is too high (max ${MAX_LIMIT}).`);
      return;
    }
    newLimit = parsed;
  }

  // No separate "limit changed" confirmation - you were authorized, so the
  // action just happens, and the posted list (its tournament count vs. the
  // new limit) is the proof. Anyone auto-promoted off the (🏆 WL) queue DOES
  // get an explicit mention though, same as !limit does for its own
  // waitlist - that's a status change for someone who isn't even part of
  // this command, worth calling out on its own.
  const { promoted } = setTournamentLimit(groupId, newLimit);
  if (promoted.length) {
    const { text, mentions } = formatTournamentPromotedMessage(promoted);
    await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
  }
  await postList();
}

// Sets the two-winner "Congrats to X and Y for winning last week's
// tournament" banner formatList() shows above the list while tournament is
// on (see lib/helpers.js) - keeps announcing the same result until an
// admin sets it again next time, same "sticks until you change it"
// carry-forward as duePaymentsLabel/location/etc. Also waives the winners'
// payment debt for that same week (see store.js's
// waiveDuePaymentsForWinners) - tournament winners don't have to pay for
// the social they won. Deliberately always
// exactly two names (that's the template) rather than !regulars-style
// add/remove/clear sub-forms - there's nothing to incrementally edit here,
// just replace both names each time.
async function handleTournamentWinners(ctx) {
  const { groupId, senderId, sock, argText, reply, postList } = ctx;
  if (!argText) {
    const winners = getTournamentWinners(groupId);
    await reply(
      winners
        ? `Current tournament winners: ${winners[0]} and ${winners[1]}\nTo change them (admins only): ${COMMAND_PREFIX}tournamentwinners Name1, Name2`
        : `No tournament winners set yet.\nTo set them (admins only): ${COMMAND_PREFIX}tournamentwinners Name1, Name2`
    );
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can set the tournament winners.');
    return;
  }

  const names = argText.split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length !== 2) {
    await reply(`Usage: ${COMMAND_PREFIX}tournamentwinners Name1, Name2\n(Exactly two names - that's the "Congrats to X and Y..." banner shown above the list.)`);
    return;
  }

  const rejected = [];
  for (const name of names) {
    const modResult = checkEntry(name);
    if (!modResult.ok) rejected.push(`${name} - ${modResult.reason}`);
  }
  if (rejected.length) {
    await reply(`Couldn't set:\n${rejected.join('\n')}`);
    return;
  }

  setTournamentWinners(groupId, names);
  const waived = waiveDuePaymentsForWinners(groupId, names);
  const waivedNote = waived.length ? ` (payment waived for ${waived.join(' and ')} for that week)` : '';
  await reply(`Tournament winners set: ${names[0]} and ${names[1]}${waivedNote}`);
  await postList();
}

// !courtcanceller sets (or views) the specific person lib/vacancyReminder.js
// @-mentions if the group's current list is still 6+ spots short with only
// 26 hours left before the social's start time - typically whoever
// actually books/pays for the courts, so they get a direct heads-up to go
// cancel them rather than eating the cost of an empty booking. Persistent
// across !newlist/!clear (see store.js's getCourtCanceller/
// setCourtCanceller) - same "sticks until an admin explicitly changes it"
// lifecycle as !regulars/!exempt above, since who books the courts doesn't
// usually change week to week.
//
// Requires a genuine @-mention in the message itself (e.g.
// "!courtcanceller @Alex"), never a typed name - a typed name has no
// reliable WhatsApp ID to actually tag later, and this bot's own
// convention throughout (see e.g. resolveOwnDue's doc comment in
// commands/list.js) is to match people by WhatsApp ID wherever it
// matters, not by whatever display text happens to be typed. If more than
// one person is @-mentioned, only the first is used.
//
// Bare !courtcanceller (no argument) just shows who's currently set -
// anyone can do this, same "viewing: anyone, changing: admins" pattern as
// !regulars/!exempt/!location. "!courtcanceller off" (or "clear"/"none")
// turns it off - the 26-hour warning is then simply never sent (see
// lib/vacancyReminder.js's own handling of a missing court-canceller)
// rather than falling back to some default.
async function handleCourtCanceller(ctx) {
  const { sock, msg, groupId, senderId, argText, reply } = ctx;

  if (!argText) {
    const current = getCourtCanceller(groupId);
    if (current && current.jid) {
      await sock.sendMessage(
        groupId,
        {
          text: `Court-cancellation reminder currently goes to @${current.jid.split('@')[0]}.\nTo change it (admins only): ${COMMAND_PREFIX}courtcanceller @name, or ${COMMAND_PREFIX}courtcanceller off to turn it off.`,
          mentions: [current.jid],
        },
        { quoted: msg }
      );
    } else {
      await reply(
        `No court-cancellation reminder set - nobody gets tagged if the social's still well short on people close to the start time.\nTo set one (admins only): ${COMMAND_PREFIX}courtcanceller @name`
      );
    }
    return;
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can change the court-cancellation reminder.');
    return;
  }

  if (/^(off|clear|none)$/i.test(argText.trim())) {
    setCourtCanceller(groupId, null);
    await reply('Court-cancellation reminder turned off.');
    return;
  }

  // Excludes the BOT's own JID(s) from candidates - reachable via a
  // natural-language @-mention too (see lib/geminiCommand.js's
  // MAPPABLE_COMMANDS), where the sender necessarily @-mentions the bot
  // itself to trigger AI interpretation at all, so `mentioned` would
  // otherwise carry the bot's own JID (usually first, e.g. "@Snoopy make
  // @Alex the court canceller") right alongside the actual target -
  // without this filter, mentioned[0] could silently set the bot itself
  // as its own court-canceller instead of refusing/picking the real target.
  const botJids = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map(normalizeJid);
  const mentioned = getMentionedJids(msg).filter((jid) => !botJids.includes(normalizeJid(jid)));
  if (!mentioned.length) {
    await reply(`@-mention the person directly, e.g. ${COMMAND_PREFIX}courtcanceller @Alex - a typed name alone can't be reliably tagged.`);
    return;
  }

  const jid = mentioned[0];
  setCourtCanceller(groupId, { jid });
  await sock.sendMessage(
    groupId,
    {
      text: `Court-cancellation reminder set to @${jid.split('@')[0]} - they'll be tagged if the list's still 6+ spots short with 26 hours to go.`,
      mentions: [jid],
    },
    { quoted: msg }
  );
}

// !undo reverses the LAST mutating command run in the group - typed or
// AI-mapped, self-service or admin-gated, anything from a single !in to a
// whole !newlist or !clear. It doesn't know or care WHAT that command
// was; commands/index.js's dispatch wrapper snapshots the group's
// current/history/regularPlayers before every command runs, compares
// before-vs-after once it finishes, and (only if something actually
// changed) saves that "before" snapshot as the thing !undo restores - see
// store.js's getUndoableState/restoreUndoableState/saveUndoSnapshot/
// getUndoSnapshot and their shared doc comment for the full mechanism,
// including why this is a single-level undo (not a full history stack)
// that naturally doubles as a toggle/redo if run twice in a row.
//
// Admin-gated like the other whole-group actions in this file - !undo
// can reverse ANYONE's change (another member's !in, another admin's
// !clear, ...), which is a bigger blast radius than most commands, so it
// gets the same trust level as !clear/!newlist rather than being open to
// everyone the way !in/!out are.
async function handleUndo(ctx) {
  const { sock, groupId, senderId, reply, postList } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can undo the last change.');
    return;
  }

  const entry = getUndoSnapshot(groupId);
  if (!entry) {
    await reply("Nothing to undo - either nothing's changed yet, or the last change was already undone.");
    return;
  }

  restoreUndoableState(groupId, entry.snapshot);
  await reply(`Undid: ${entry.description}`);
  await postList();
}

// Bulk-edits the roster by re-parsing a copy-pasted (and presumably
// hand-edited) list message - the admin copies the bot's last posted list,
// adds/removes/reorders names under *Attendance*/*Waitlist*/the payment
// section as needed, and sends it back after !update. See
// lib/listParser.js's parseListSections() for how the text is read (very
// tolerant - "extra text blocks" anywhere else in the message are simply
// ignored) and store.js's applyListUpdate() for exactly how the parsed
// result gets reconciled against the current list (kept names preserve
// their original metadata, new names are attributed to whoever ran this
// command, names left out entirely are dropped).
//
// If the pasted text also keeps the date/location/courts/time block above
// *Attendance* (whatever formatList() itself last printed there), those
// four fields get read and applied too - see lib/listParser.js's
// parseHeaderFields() for the parsing/disambiguation rules, and below for
// how each field's change actually gets applied (including courts'
// auto-promote/demote, same as !courts). A header block that's present but
// missing one of the four fields clears that field, same "your edit is
// final" philosophy as the roster edit above; no header block at all (the
// original, pre-this-feature behavior) leaves all four untouched.
//
// Only ever unconditionally replies with a summary (not the usual "quiet
// on success" pattern the rest of this file follows) - free-text parsing
// is inherently a bit fuzzy, so confirming exactly what was read back
// (added/removed/moved/rejected/header changes) matters more here than it
// does for a single, unambiguous !in/!out/!limit call.
async function handleUpdate(ctx) {
  const { sock, msg, groupId, senderId, argText, reply, postList } = ctx;
  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin) {
    await reply('Only a group admin can bulk-update the list this way.');
    return;
  }

  if (!argText) {
    await reply(
      `Usage: ${COMMAND_PREFIX}update <paste the list here, with your edits>\n`
        + `Copy Snoopy's last posted list (or run ${COMMAND_PREFIX}list to get a fresh copy), add/remove/reorder names under *Attendance*, *Waitlist*, or the payment section as needed, then send it back with ${COMMAND_PREFIX}update on its own first line, followed by the pasted text.\n`
        + `If you also keep the date/location/courts/time block above *Attendance* in your paste, edits there get applied too - and any of those four fields you leave OUT of that block gets cleared, since your edit is treated as final. Leave the whole block out entirely (nothing pasted above *Attendance*) to leave date/location/courts/time untouched. The plain (unbolded) line right under *Payment* works the same way for the payment-due header (same as ${COMMAND_PREFIX}paymentlabel) - keep the *Payment* line but drop that label line and the header resets to its default, same "your edit is final" rule; drop the payment section from your paste entirely to leave the header untouched. If the tournament's on, moving a name between "🏆 Tournament" and "Social only" in your edit updates their tournament status too.`
    );
    return;
  }

  const parsed = parseListSections(argText);
  if (parsed.sectionsFound === 0) {
    await reply(
      `Couldn't find an *Attendance*, *Waitlist*, or payment section in that - paste what ${COMMAND_PREFIX}list shows (with your edits) after ${COMMAND_PREFIX}update.`
    );
    return;
  }

  // Moderation only applies to genuinely NEW names - one already on the
  // current attendance/waitlist/duePayments list was already accepted once
  // when it was first added, so there's nothing to gain by re-checking it
  // just because it happens to be part of this edit too.
  const event = getCurrentEvent(groupId);
  // See lib/listParser.js's parseHeaderFields() doc comment for the full
  // story - null here means no date/location/courts/time block was found
  // above *Attendance* at all, so those fields are left completely alone
  // below (same as before this feature existed); a non-null result means
  // the block WAS found and every field in it (present or explicitly
  // absent) is applied.
  const headerFields = parseHeaderFields(parsed.headerLines, event);
  const existingRosterNames = new Set(
    [...event.entries, ...(event.waitlist || [])].map((e) => normalizeName(e.name))
  );
  const existingDueNames = new Set((event.duePayments || []).map((e) => normalizeName(e.name)));

  const rejected = [];
  function filterSection(names, existingNames) {
    return names.filter((name) => {
      if (existingNames.has(normalizeName(name))) return true; // already accepted before - skip re-checking
      const modResult = checkEntry(name);
      if (!modResult.ok) {
        rejected.push(`${name} - ${modResult.reason}`);
        return false;
      }
      return true;
    });
  }
  // Same moderation rule as filterSection above, but for parsed.duePayments'
  // { name, owedSince? } shape (see lib/listParser.js's parseListSections()
  // doc comment) rather than plain name strings - keeps each item intact
  // (owedSince included) so applyListUpdate (store.js) still sees whichever
  // date-group signal the paste carried for it.
  function filterDueSection(items, existingNames) {
    return items.filter((item) => {
      if (existingNames.has(normalizeName(item.name))) return true; // already accepted before - skip re-checking
      const modResult = checkEntry(item.name);
      if (!modResult.ok) {
        rejected.push(`${item.name} - ${modResult.reason}`);
        return false;
      }
      return true;
    });
  }

  const filteredAttendance = filterSection(parsed.attendance, existingRosterNames);
  const filteredWaitlist = filterSection(parsed.waitlist, existingRosterNames);
  const filteredDue = filterDueSection(parsed.duePayments, existingDueNames);

  const result = applyListUpdate(
    groupId,
    {
      attendance: filteredAttendance,
      waitlist: filteredWaitlist,
      duePayments: filteredDue,
      // Tournament/social-only sub-placement within Attendance (see
      // lib/listParser.js's parseListSections() and store.js's
      // applyListUpdate doc comments) - passed straight through, unfiltered:
      // every name here is necessarily also in `parsed.attendance` (same
      // numbered lines, just additionally bucketed), so if moderation
      // rejected one out of filteredAttendance, applyListUpdate's
      // tournament reconciliation simply won't find a matching entry in
      // current.entries for it either - nothing further to filter here.
      tournamentPlayers: parsed.tournamentPlayers,
      tournamentWaitlistedNames: parsed.tournamentWaitlistedNames,
    },
    senderId,
    admin
  );

  // Header-field changes (date/location/courts/time) - applied AFTER the
  // roster edit above, not before, so a courts change's auto-promote/demote
  // (setCourts()/store.js) reacts to the FINAL headcount from this same
  // update, not the pre-edit one. Every diff line below compares against
  // the pre-update `event` fetched earlier, though, since that's the
  // "before" a reader of the summary actually cares about.
  const headerChanges = [];
  let headerFieldsChanged = false;
  let courtsPromoted = [];
  let courtsDemoted = [];

  if (headerFields) {
    if (headerFields.date !== (event.date || null)) {
      setDate(groupId, headerFields.date || null);
      headerChanges.push(
        `Date: ${event.date ? formatDisplayDate(event.date) : 'not set'} → ${headerFields.date ? formatDisplayDate(headerFields.date) : 'not set'}`
      );
      headerFieldsChanged = true;
    }

    if ((headerFields.location || null) !== (event.location || null)) {
      if (headerFields.location && headerFields.location.length > MAX_LOCATION_LENGTH) {
        headerChanges.push(`Couldn't update location - too long (max ${MAX_LOCATION_LENGTH} characters), left as ${event.location || 'not set'}.`);
      } else {
        setLocation(groupId, headerFields.location || '');
        headerChanges.push(`Location: ${event.location || 'not set'} → ${headerFields.location || 'not set'}`);
        headerFieldsChanged = true;
      }
    }

    if ((headerFields.courts || null) !== (event.courts || null)) {
      if (headerFields.courts && headerFields.courts.length > MAX_COURTS_LENGTH) {
        headerChanges.push(`Couldn't update courts - too long (max ${MAX_COURTS_LENGTH} characters), left as ${event.courts || 'not set'}.`);
      } else {
        const courtsResult = setCourts(groupId, headerFields.courts || '');
        if (!courtsResult.ok) {
          headerChanges.push(`Couldn't update courts - "${headerFields.courts}" isn't a valid court list, left as ${event.courts || 'not set'}.`);
        } else {
          headerChanges.push(`Courts: ${event.courts || 'not set'} → ${headerFields.courts || 'not set'}`);
          headerFieldsChanged = true;
          courtsPromoted = courtsResult.promoted;
          courtsDemoted = courtsResult.demoted;
        }
      }
    }

    if ((headerFields.time || null) !== (event.time || null)) {
      if (headerFields.time && headerFields.time.length > MAX_TIME_LENGTH) {
        headerChanges.push(`Couldn't update time - too long (max ${MAX_TIME_LENGTH} characters), left as ${event.time || 'not set'}.`);
      } else {
        setTime(groupId, headerFields.time || '');
        headerChanges.push(`Time: ${event.time || 'not set'} → ${headerFields.time || 'not set'}`);
        headerFieldsChanged = true;
      }
    }
  }

  // Payment-due header label (e.g. "$16 payID: 0413455423" - see
  // !paymentlabel) - applied independently of the `headerFields` block
  // above (a label edit can appear in a paste with no date/location/courts
  // /time block at all, and vice versa - they're two unrelated header
  // lines in two unrelated places in the message), but with the SAME "your
  // edit is final" rule: parsed.duePaymentsLabel is undefined only when the
  // paste had no payment section at all (leave the label alone); a payment
  // section that WAS present but had no label line comes back as an
  // explicit clear (null - see lib/listParser.js's parseListSections() doc
  // comment on duePaymentsLabel), resetting back to the configured default
  // exactly like a date/location/courts/time field left out of a present
  // header block does.
  let paymentLabelChanged = false;
  const currentStoredLabel = event.duePaymentsLabel || null; // raw stored value, not the PAYMENT_LABEL-resolved display text
  if (parsed.duePaymentsLabel !== undefined && parsed.duePaymentsLabel !== currentStoredLabel) {
    if (parsed.duePaymentsLabel && parsed.duePaymentsLabel.length > MAX_LABEL_LENGTH) {
      headerChanges.push(`Couldn't update the payment-due header - too long (max ${MAX_LABEL_LENGTH} characters), left as *${getDuePaymentsLabel(groupId)}*.`);
    } else {
      const beforeDisplay = getDuePaymentsLabel(groupId);
      setDuePaymentsLabel(groupId, parsed.duePaymentsLabel || '');
      headerChanges.push(`Payment-due header: *${beforeDisplay}* → *${getDuePaymentsLabel(groupId)}*`);
      paymentLabelChanged = true;
    }
  }

  const changed = Boolean(
    result.added.length || result.removed.length || result.moved.length
      || result.paidAdded.length || result.paidRemoved.length || result.tournamentChanged.length
      || headerFieldsChanged || paymentLabelChanged
  );

  if (courtsPromoted.length) {
    // Sent directly (not `reply`) so we can pass `mentions` and actually
    // notify each promoted person - same as !courts (handleCourts above).
    const { text, mentions } = formatPromotedMessage(courtsPromoted);
    await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
  }

  const summaryLines = [];
  summaryLines.push(...headerChanges);
  if (courtsDemoted.length) {
    summaryLines.push(`New court count moved these to the waitlist, in order:\n${courtsDemoted.map((e) => e.name).join('\n')}`);
  }
  if (result.added.length) summaryLines.push(`Added: ${result.added.join(', ')}`);
  if (result.removed.length) summaryLines.push(`Removed: ${result.removed.join(', ')}`);
  if (result.moved.length) {
    summaryLines.push(`Moved: ${result.moved.map((m) => `${m.name} (${m.from} → ${m.to})`).join(', ')}`);
  }
  if (result.tournamentChanged.length) {
    summaryLines.push(`Tournament: ${result.tournamentChanged.map((c) => `${c.name} (${c.from} → ${c.to})`).join(', ')}`);
  }
  if (result.paidAdded.length) summaryLines.push(`Added to payment-due: ${result.paidAdded.join(', ')}`);
  if (result.paidRemoved.length) summaryLines.push(`Marked paid: ${result.paidRemoved.join(', ')}`);
  if (rejected.length) summaryLines.push(`Couldn't add:\n${rejected.join('\n')}`);

  if (changed) {
    // !update deliberately doesn't auto-demote overflow to the waitlist -
    // the editor's explicit Attendance placement is taken as final (same
    // spirit as !allow overriding the cap) - but it's still worth flagging
    // if that leaves the list visibly over its own stated limit, so it
    // doesn't look like a silent inconsistency.
    const updatedEvent = getCurrentEvent(groupId);
    if (updatedEvent.limit && updatedEvent.entries.length > updatedEvent.limit) {
      summaryLines.push(
        `Heads up: Attendance is now over the limit (${updatedEvent.entries.length}/${updatedEvent.limit}) - this update didn't move anyone to the waitlist automatically, since your edit is treated as final. Adjust with ${COMMAND_PREFIX}limit/${COMMAND_PREFIX}allow if that wasn't intended.`
      );
    }
  }

  if (!summaryLines.length) {
    await reply('No changes found - that already matches the current list exactly.');
    return;
  }

  await reply(summaryLines.join('\n'));
  if (changed) {
    await postList();
  }
}

module.exports = {
  handleClear,
  handleClearpayments,
  handleNewlist,
  handleDate,
  handleLocation,
  handleCourts,
  handleTime,
  handleLimit,
  handleAllow,
  handlePaymentlabel,
  handleRegulars,
  handleExempt,
  handleTournament,
  handleSettournament,
  handleTournamentLimit,
  handleTournamentWinners,
  handleCourtCanceller,
  handleUndo,
  handleUpdate,
  addRegularsToCurrentList,
};