// commands/list.js
// The self-service, non-admin-gated commands: !in, !out, !list, !paid.
// Faithful ports of the corresponding switch cases from the old monolithic
// index.js - reply strings and control flow are unchanged for LIVE
// ('notify') messages.
//
// !in/!out/!paid additionally run for catch-up ('append') messages after a
// reconnect (see index.js's CATCH_UP_COMMANDS). In that mode, each handler
// skips its own individual reply()/postList()/promotion-tag send (guarded
// by `isCatchUp` below) - sending one immediately per caught-up message
// would spam the group with a burst of repeated list reposts if several
// people used the bot while it was offline. Instead, every handler always
// returns a small outcome object describing what happened; index.js
// collects these (only in catch-up mode - the return value is simply
// ignored for a live message) and hands them to lib/catchUpQueue.js, which
// batches them into ONE combined summary message once the backlog settles.
// See lib/catchUpSummary.js for how that summary is worded.

const { getCurrentEvent, getDuePaymentsLabel, addEntry, removeEntry, markPaid, normalizeName } = require('../store');
const { checkEntry } = require('../moderation');
const { isGroupAdmin } = require('../lib/adminCheck');
const { COMMAND_PREFIX, MAX_NAMES_PER_COMMAND } = require('../lib/config');
const {
  parseNames,
  PLUS_N_TOKEN,
  expandRegularPlayersToken,
  maxNamesReply,
  stripLeadingPaidKeyword,
  formatPromotedMessage,
} = require('../lib/helpers');

// Bare-self resolution against the payment-due list, shared by handleIn/
// handleOut below when a leading "paid" keyword is present but no
// explicit name was given (e.g. "!in paid", not "!in paid Alex"). Matches
// by WhatsApp ID (addedBy), not display name, same reasoning as every
// other bare-self lookup in this file: your current push name doesn't
// always match whatever name ended up on a list - and here specifically,
// it doesn't always match whatever name ended up on the SEPARATE
// duePayments list either, which could've been recorded on a different
// cycle under a different name. Also requires `self !== false` - if you
// signed OTHER people up (e.g. "!in Peter, Chris, Linda"), those entries
// carry your `addedBy` too, but they're not YOU, so a later bare lookup
// shouldn't claim you're "Peter, Chris, and Linda" (see store.js's
// addEntry doc comment for the full reasoning).
//
// Someone can now legitimately have MORE THAN ONE due entry under the
// SAME name at once - once per event they owe for (see store.js's
// newList()) - so having multiple own entries ISN'T itself ambiguous
// anymore; only having them under two or more DIFFERENT names is (e.g.
// self-added as "Alex" one cycle and "Alex T" another - genuinely unclear
// which one a plain "!paid <name>" should target). A same-name group
// resolves to that one name, and markPaid() (store.js) already clears
// every entry matching a name at once, so one !paid clears all of them in
// a single go. Returns { names } on a clean match, or { noEntry: true } /
// { ambiguous: [...] } otherwise - the same three shapes handlePaid's own
// bare branch resolves to.
function resolveOwnDue(groupId, senderId) {
  const due = getCurrentEvent(groupId).duePayments || [];
  const own = due.filter((e) => e.addedBy === senderId && e.self !== false);
  if (own.length === 0) return { noEntry: true };
  const uniqueNames = [...new Set(own.map((e) => normalizeName(e.name)))];
  if (uniqueNames.length > 1) return { ambiguous: own.map((e) => e.name) };
  return { names: [own[0].name] };
}

// Resolves "!in +N" (see PLUS_N_TOKEN in lib/helpers.js) into the actual
// names to add, ADDITIVELY on top of whatever the sender already has on
// the list right now - unlike parseNames()' own (context-free) "+N"
// expansion, which always starts guest numbering at +1 and would just
// collide with (and be rejected as duplicates of) guests already added by
// an earlier "+N". E.g. the sender already has "Jordan, Jordan+1,
// Jordan+2, Jordan+3" on the list (from an earlier "!in +3") and says
// "add 3 more friends" (-> another "+3"): this returns ["Jordan+4",
// "Jordan+5", "Jordan+6"], continuing the numbering, not a second
// "Jordan, Jordan+1, Jordan+2, Jordan+3" that would all be rejected as
// already-on-the-list duplicates.
//
// Only ever called for handleIn's ADD path - !out/!paid's own "+N"
// handling (via parseNames, unchanged) stays literal/non-cumulative,
// since "remove/mark paid N of my entries" doesn't have the same
// "on top of what's there" semantics as adding more does.
//
// Anchors both the self-entry name and the existing-guest-count check to
// the sender's ALREADY-RECORDED self entry (found the same robust way as
// every other bare-self lookup in this file: `addedBy === senderId &&
// self !== false`) rather than blindly trusting today's `senderName` -
// so this keeps working correctly even if the sender's WhatsApp push name
// has changed since they first added themselves (their existing
// "OldName+1..3" guests are still found and continued from, rather than
// starting a second, disconnected "NewName+1" chain).
function resolveAdditiveGuestNames(groupId, senderId, senderName, guestCount) {
  const event = getCurrentEvent(groupId);
  const allSenderEntries = [...event.entries, ...(event.waitlist || [])].filter((e) => e.addedBy === senderId);
  const ownSelfEntries = allSenderEntries.filter((e) => e.self !== false);
  const baseName = ownSelfEntries.length ? ownSelfEntries[0].name : senderName;

  const prefix = `${baseName}+`;
  let existingMax = 0;
  for (const e of allSenderEntries) {
    if (!e.name.startsWith(prefix)) continue;
    const suffix = e.name.slice(prefix.length);
    if (/^\d+$/.test(suffix)) existingMax = Math.max(existingMax, Number(suffix));
  }

  const names = ownSelfEntries.length ? [] : [baseName];
  for (let i = 1; i <= guestCount; i += 1) {
    names.push(`${baseName}+${existingMax + i}`);
  }
  return names;
}

// Applies a leading "paid" keyword (see stripLeadingPaidKeyword) for
// handleIn/handleOut. `explicitNames`, when given, is the SAME name list
// !in/!out just processed - "!in paid Alex, Sam" marks both Alex and Sam
// paid, matched literally by name, exactly like standalone "!paid Alex,
// Sam" would. With no explicit names (the bare "!in paid" / "!out paid"
// case), falls back to resolveOwnDue() above instead of just reusing the
// sender's push name, since that's the identity-correct match for the
// SEPARATE duePayments list. Deliberately independent of whatever the
// !in/!out half of the command did - "already on the list, but let me pay
// what I owe" is a legitimate combo, so paying is attempted regardless of
// whether the add/remove itself succeeded for a given name.
async function runPaidIfFlagged(groupId, senderId, paidFlag, explicitNames) {
  if (!paidFlag) return { paid: [], paidRejected: [], paidAmbiguous: null };

  let names;
  if (explicitNames) {
    names = explicitNames;
  } else {
    const resolved = resolveOwnDue(groupId, senderId);
    if (resolved.noEntry) return { paid: [], paidRejected: [], paidAmbiguous: null };
    if (resolved.ambiguous) return { paid: [], paidRejected: [], paidAmbiguous: resolved.ambiguous };
    names = resolved.names;
  }

  const dueLabel = getDuePaymentsLabel(groupId);
  const paid = [];
  const paidRejected = [];
  for (const name of names) {
    const result = markPaid(groupId, name);
    if (result.ok) {
      paid.push(name.trim());
    } else {
      paidRejected.push(`${name.trim()} - not on the ${dueLabel} list`);
    }
  }
  return { paid, paidRejected, paidAmbiguous: null };
}

// Shared reply lines for a runPaidIfFlagged() outcome - used from every
// call site in handleIn/handleOut below so the wording (and the
// dueLabel lookup) stays in exactly one place. A clean paid outcome
// (paidOutcome.paid.length) intentionally gets no reply of its own here -
// same as standalone !paid, the reposted list (with the payment-due
// section shrunk) is proof enough; callers are still responsible for
// triggering that postList() themselves.
async function replyPaidOutcome(reply, groupId, paidOutcome) {
  if (paidOutcome.paidAmbiguous) {
    const dueLabel = getDuePaymentsLabel(groupId);
    await reply(
      `You have more than one entry on the ${dueLabel} list - say which one: ${COMMAND_PREFIX}paid <name>\nYours: ${paidOutcome.paidAmbiguous.join(', ')}`
    );
  }
  if (paidOutcome.paidRejected.length) {
    await reply(`Couldn't mark paid:\n${paidOutcome.paidRejected.join('\n')}`);
  }
}

async function handleIn(ctx) {
  const { sock, msg, groupId, senderId, senderName, argText, upsertType, reply, postList } = ctx;
  const isCatchUp = upsertType === 'append';
  // Leading "paid" keyword (e.g. "!in paid") lets someone join and confirm
  // payment in one message - see stripLeadingPaidKeyword's doc comment.
  // `rest` (the argText with the keyword stripped off) is used everywhere
  // below in place of the raw argText for name resolution.
  const { rest, paid: paidFlag } = stripLeadingPaidKeyword(argText);

  if (!rest) {
    // Bare !in (optionally "!in paid") - add "myself." Your WhatsApp
    // display name can differ from (or change since) whatever name you're
    // already on the list (or waitlist) under, so check by WhatsApp ID
    // first rather than blindly adding your current push name as a second,
    // duplicate entry. Also requires `self !== false` - otherwise, having
    // previously typed "!in Peter, Chris, Linda" (entries attributed to you
    // via `addedBy` for removal purposes, but not YOU) would make the bot
    // claim you're already on as "Peter, Chris, and Linda" - see store.js's
    // addEntry doc comment.
    const event = getCurrentEvent(groupId);
    const own = [...event.entries, ...(event.waitlist || [])].filter(
      (e) => e.addedBy === senderId && e.self !== false
    );
    if (own.length) {
      const paidOutcome = await runPaidIfFlagged(groupId, senderId, paidFlag, null);
      if (!isCatchUp) {
        await reply(`You're already on the list as "${own.map((e) => e.name).join('", "')}".`);
        await replyPaidOutcome(reply, groupId, paidOutcome);
        if (paidOutcome.paid.length) {
          await postList();
        }
      }
      return {
        command: 'in',
        senderName,
        argText,
        alreadyOn: own.map((e) => e.name),
        ...paidOutcome,
      };
    }
  }

  // Only the true bare-!in path (no name typed at all) represents the
  // sender signing THEMSELVES up - parseNames falls back to a single-
  // element [senderName] array in that case (see its doc comment), so
  // `!rest` here is equivalent to "this loop's one name is the sender."
  // Any explicitly-typed name (even the sender's own, even alongside
  // other names) is NOT marked self - see store.js's addEntry doc comment
  // for why that distinction matters.
  const isBareSelfAdd = !rest;
  // "!in +2" (or the AI mapping "add me and 2 friends" to argText "+2" -
  // see lib/geminiCommand.js) is ALSO the sender signing themselves up,
  // just with N unnamed friends tagged along - and only the bare self
  // entry (if newly added, see resolveAdditiveGuestNames) is really "the
  // sender" for `self` purposes; the +1/+2 entries are separate people,
  // same as if the sender had typed "Sam, Sam+1" for someone else. Only
  // applies when the ENTIRE argText is just that one "+N" token
  // (PLUS_N_TOKEN) - "Peter, +2" is treated as an explicit multi-name
  // list instead, same as any other combination of names, with no entry
  // marked self.
  const plusNMatch = isBareSelfAdd ? null : rest.trim().match(PLUS_N_TOKEN);
  const isPlusNSelfAdd = Boolean(plusNMatch);
  // "+N" additively resolves against what the sender already has on the
  // list (see resolveAdditiveGuestNames's doc comment) rather than
  // parseNames()' simpler, always-starts-at-+1 expansion, so a repeat
  // "add N more friends" continues the numbering instead of colliding
  // with (and being rejected as duplicates of) guests already added by an
  // earlier "+N".
  let names = isPlusNSelfAdd
    ? resolveAdditiveGuestNames(groupId, senderId, senderName, Number(plusNMatch[1]))
    : parseNames(rest, senderName);

  // "regular players" (see REGULAR_PLAYERS_TOKEN/expandRegularPlayersToken in
  // lib/helpers.js, and commands/admin.js's !regulars for how the roster
  // itself is set) lets someone sign up the group's whole saved roster in
  // one message, e.g. "!in regular players" or "!in Extra Guest, regular
  // players" - a cheap no-op (same array back) for the overwhelmingly
  // common case where the phrase isn't present, so this is safe to run
  // unconditionally, even for the bare-self-add/"+N" paths above whose
  // own `names` can never actually contain the literal token.
  const regularPlayersExpansion = expandRegularPlayersToken(names, groupId);
  names = regularPlayersExpansion.names;

  const senderIsAdmin = await isGroupAdmin(sock, groupId, senderId);
  if (!senderIsAdmin && names.length > MAX_NAMES_PER_COMMAND) {
    if (!isCatchUp) {
      await reply(maxNamesReply('add'));
    }
    return { command: 'in', senderName, argText, tooMany: true };
  }

  const added = [];
  const waitlisted = [];
  const rejected = [];
  if (regularPlayersExpansion.usedEmptyRegularPlayers) {
    rejected.push(`regular players - none saved yet (see ${COMMAND_PREFIX}regulars to set them)`);
  }

  for (const name of names) {
    const modResult = checkEntry(name);
    if (!modResult.ok) {
      rejected.push(`${name} - ${modResult.reason}`);
      continue;
    }
    const isSelfEntry = isBareSelfAdd || (isPlusNSelfAdd && name === senderName);
    const result = addEntry(groupId, name, senderId, senderIsAdmin, isSelfEntry);
    if (!result.ok) {
      rejected.push(`${name.trim()} - already on the list`);
    } else if (result.waitlisted) {
      waitlisted.push(name.trim());
    } else {
      added.push(name.trim());
    }
  }

  // "paid" targets the exact same names just processed above when they
  // were given explicitly; with no explicit names (bare !in/"!in paid"),
  // runPaidIfFlagged resolves the payer by identity instead - see its doc
  // comment for why that differs from just reusing `names` (which would
  // be [senderName] here).
  const paidOutcome = await runPaidIfFlagged(groupId, senderId, paidFlag, rest ? names : null);

  if (!isCatchUp) {
    if (rejected.length) {
      await reply(`Couldn't add:\n${rejected.join('\n')}`);
    }
    await replyPaidOutcome(reply, groupId, paidOutcome);
    // No separate "added to the waitlist" reply - the posted list below
    // (with them shown in its Waitlist section) is proof enough, same as
    // any other successful, authorized change.
    if (added.length || waitlisted.length || paidOutcome.paid.length) {
      await postList();
    }
  }

  return { command: 'in', senderName, argText, added, waitlisted, rejected, ...paidOutcome };
}

async function handleOut(ctx) {
  const { sock, msg, groupId, senderId, senderName, argText, upsertType, reply, postList } = ctx;
  const isCatchUp = upsertType === 'append';
  // See handleIn's matching comment - a leading "paid" keyword (e.g.
  // "!out paid" or "!out paid Alex, Sam") lets someone leave and confirm
  // payment in one message.
  const { rest, paid: paidFlag } = stripLeadingPaidKeyword(argText);
  let names;

  if (!rest) {
    // No name given - remove "myself." Match by WhatsApp ID rather than
    // display name: your push name doesn't always match whatever text
    // ended up on the list (yours or whoever added you may have typed
    // a nickname), so name-matching alone can miss your own entry.
    // Covers the waitlist too, in case that's where you ended up. Also
    // requires `self !== false` - entries you added FOR someone else
    // (e.g. via "!in Peter, Chris, Linda") carry your `addedBy` too, but
    // aren't you - see store.js's addEntry doc comment.
    const event = getCurrentEvent(groupId);
    const own = [...event.entries, ...(event.waitlist || [])].filter(
      (e) => e.addedBy === senderId && e.self !== false
    );
    if (own.length === 0) {
      const paidOutcome = await runPaidIfFlagged(groupId, senderId, paidFlag, null);
      if (!isCatchUp) {
        await reply(
          `You don't have an entry on the list. If your WhatsApp name doesn't match what's on the list, use ${COMMAND_PREFIX}out <name>.`
        );
        await replyPaidOutcome(reply, groupId, paidOutcome);
        if (paidOutcome.paid.length) {
          await postList();
        }
      }
      return { command: 'out', senderName, argText, noEntry: true, ...paidOutcome };
    }
    if (own.length > 1) {
      const paidOutcome = await runPaidIfFlagged(groupId, senderId, paidFlag, null);
      if (!isCatchUp) {
        await reply(
          `You have more than one entry - say which one: ${COMMAND_PREFIX}out <name>\nYours: ${own.map((e) => e.name).join(', ')}`
        );
        await replyPaidOutcome(reply, groupId, paidOutcome);
        if (paidOutcome.paid.length) {
          await postList();
        }
      }
      return { command: 'out', senderName, argText, ambiguous: own.map((e) => e.name), ...paidOutcome };
    }
    names = [own[0].name];
  } else {
    names = parseNames(rest, senderName);
  }

  const admin = await isGroupAdmin(sock, groupId, senderId);
  if (!admin && names.length > MAX_NAMES_PER_COMMAND) {
    if (!isCatchUp) {
      await reply(maxNamesReply('remove'));
    }
    return { command: 'out', senderName, argText, tooMany: true };
  }

  const removed = [];
  const rejected = [];
  const flagged = [];
  const promoted = [];

  for (const name of names) {
    const result = removeEntry(groupId, name, senderId, admin);
    if (!result.ok) {
      if (result.reason === 'not_found') {
        rejected.push(`${name.trim()} - not on the list`);
      } else if (result.reason === 'not_authorized') {
        flagged.push(`${name.trim()} - this request will be reviewed and decided by an admin (moved to the bottom of the list and tagged (TBC) in the meantime)`);
      }
    } else {
      removed.push(name.trim());
      if (result.promoted && result.promoted.length) {
        promoted.push(...result.promoted);
      }
    }
  }

  // Same independent-of-the-remove-outcome reasoning as handleIn's paid
  // handling - see its comment above.
  const paidOutcome = await runPaidIfFlagged(groupId, senderId, paidFlag, rest ? names : null);

  if (!isCatchUp) {
    if (rejected.length) {
      await reply(`Couldn't remove:\n${rejected.join('\n')}`);
    }
    if (flagged.length) {
      await reply(`Pending admin review:\n${flagged.join('\n')}`);
    }
    await replyPaidOutcome(reply, groupId, paidOutcome);
    if (promoted.length) {
      // A spot freed up, so someone was auto-promoted off the waitlist -
      // worth calling out (and tagging) since it's a status change for a
      // name that wasn't even part of this command. Sent directly (not
      // via the `reply` helper) so we can pass `mentions` to actually
      // notify them, not just print their name as plain text.
      const { text, mentions } = formatPromotedMessage(promoted);
      await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
    }
    if (removed.length || flagged.length || promoted.length || paidOutcome.paid.length) {
      await postList();
    }
  }

  return { command: 'out', senderName, argText, removed, rejected, flagged, promoted, ...paidOutcome };
}

async function handleList(ctx) {
  await ctx.postList();
}

async function handlePaid(ctx) {
  const { sock, groupId, senderId, senderName, argText, upsertType, reply, postList } = ctx;
  const isCatchUp = upsertType === 'append';
  // Anyone can mark any name paid here - no owner/admin restriction,
  // unlike !out. Whoever collects the money (not necessarily an
  // admin, and not necessarily whoever originally signed the person up)
  // can clear it. Admin status is only checked below for the bulk-name
  // cap, not for authorization.
  let names;

  if (!argText) {
    // No name given - mark "myself" paid. Delegates to resolveOwnDue()
    // above (its own doc comment covers the WhatsApp-ID matching and why
    // multiple entries under the SAME name aren't ambiguous anymore - only
    // different names are, since owing for two separate events is now
    // normal, not a sign something's wrong).
    const resolved = resolveOwnDue(groupId, senderId);
    const dueLabelForSelf = getDuePaymentsLabel(groupId);
    if (resolved.noEntry) {
      if (!isCatchUp) {
        await reply(
          `You're not on the ${dueLabelForSelf} list. If your WhatsApp name doesn't match what's on the list, use ${COMMAND_PREFIX}paid <name>.`
        );
      }
      return { command: 'paid', senderName, argText, noEntry: true };
    }
    if (resolved.ambiguous) {
      if (!isCatchUp) {
        await reply(
          `You have more than one entry on the ${dueLabelForSelf} list - say which one: ${COMMAND_PREFIX}paid <name>\nYours: ${resolved.ambiguous.join(', ')}`
        );
      }
      return { command: 'paid', senderName, argText, ambiguous: resolved.ambiguous };
    }
    names = resolved.names;
  } else {
    names = parseNames(argText, senderName);
  }

  const senderIsAdmin = await isGroupAdmin(sock, groupId, senderId);
  if (!senderIsAdmin && names.length > MAX_NAMES_PER_COMMAND) {
    if (!isCatchUp) {
      await reply(maxNamesReply('mark', ' paid'));
    }
    return { command: 'paid', senderName, argText, tooMany: true };
  }

  const dueLabel = getDuePaymentsLabel(groupId);
  const paid = [];
  const rejected = [];

  for (const name of names) {
    const result = markPaid(groupId, name);
    if (!result.ok) {
      rejected.push(`${name.trim()} - not on the ${dueLabel} list`);
    } else {
      paid.push(name.trim());
    }
  }

  if (!isCatchUp) {
    if (rejected.length) {
      await reply(`Couldn't mark paid:\n${rejected.join('\n')}`);
    }
    if (paid.length) {
      await postList();
    }
  }

  return { command: 'paid', senderName, argText, paid, rejected };
}

module.exports = { handleIn, handleOut, handleList, handlePaid };