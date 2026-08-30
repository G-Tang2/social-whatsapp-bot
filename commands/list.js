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

const { getCurrentEvent, addEntry, removeEntry, markPaid, joinTournament, leaveTournament, normalizeName } = require('../store');
const { checkEntry } = require('../moderation');
const { isGroupAdmin } = require('../lib/adminCheck');
const { COMMAND_PREFIX, MAX_NAMES_PER_COMMAND } = require('../lib/config');
const {
  parseNames,
  PLUS_N_TOKEN,
  ME_TOKEN,
  expandRegularPlayersToken,
  maxNamesReply,
  stripLeadingInKeywords,
  formatPromotedMessage,
  formatTournamentPromotedMessage,
  resolveDuePaymentNumber,
  resolveAttendanceOrWaitlistNumber,
} = require('../lib/helpers');

// Bare-self resolution against the payment-due list, shared by handleIn/
// handleOut below when a leading "paid" keyword is present but no
// explicit name was given (e.g. "!in paid", not "!in paid Grace"). Matches
// by WhatsApp ID (addedBy) FIRST, not display name, same reasoning as every
// other bare-self lookup in this file: your current push name doesn't
// always match whatever name ended up on a list - and here specifically,
// it doesn't always match whatever name ended up on the SEPARATE
// duePayments list either, which could've been recorded on a different
// cycle under a different name. Also requires `self !== false` - if you
// signed OTHER people up (e.g. "!in Alice, Bob, Carla"), those entries
// carry your `addedBy` too, but they're not YOU, so a later bare lookup
// shouldn't claim you're "Alice, Bob, and Carla" (see store.js's
// addEntry doc comment for the full reasoning).
//
// Someone can now legitimately have MORE THAN ONE due entry under the
// SAME name at once - once per event they owe for (see store.js's
// newList()) - so having multiple own entries ISN'T itself ambiguous
// anymore; only having them under two or more DIFFERENT names is (e.g.
// self-added as "Grace" one cycle and "Grace T" another - genuinely unclear
// which one a plain "!paid <name>" should target). A same-name group
// resolves to that one name, and markPaid() (store.js) already clears
// every entry matching a name at once, so one !paid clears all of them in
// a single go. Returns { names } on a clean match, or { noEntry: true } /
// { ambiguous: [...] } otherwise - the same three shapes handlePaid's own
// bare branch resolves to.
//
// If the ID match comes up empty - e.g. the due entry was carried over
// from a cycle recorded under a different WhatsApp identity (linked
// device, number change) or was typed in for you by someone else (which
// sets `self: false`, per store.js's addEntry/applyListUpdate) - falls
// back to a plain text match against the sender's current push name
// (`senderName`), exactly like an explicit "!paid <name>" would (see
// markPaid()'s normalizeName comparison in store.js). Not restricted to
// `self !== false` here: this is name-driven, not ID-driven, so it's no
// more permissive than just typing your own name explicitly already is -
// see handlePaid's doc comment ("anyone can mark any name paid").
function resolveOwnDue(groupId, senderId, senderName) {
  const due = getCurrentEvent(groupId).duePayments || [];
  const own = due.filter((e) => e.addedBy === senderId && e.self !== false);
  if (own.length > 0) {
    const uniqueNames = [...new Set(own.map((e) => normalizeName(e.name)))];
    if (uniqueNames.length > 1) return { ambiguous: own.map((e) => e.name) };
    return { names: [own[0].name] };
  }
  if (senderName) {
    const byName = due.filter((e) => normalizeName(e.name) === normalizeName(senderName));
    if (byName.length > 0) return { names: [byName[0].name] };
  }
  return { noEntry: true };
}

// Whether `senderId`/`name` is found on the CURRENT attendance list or
// waitlist (tournament entries included - they're stored in `entries`
// too, see store.js's addEntry) - used by handlePaid below to tell apart
// two genuinely different reasons a "!paid" attempt comes up empty:
// actually not owing anything (the honest "you're all clear" case) versus
// trying to pay EARLY, for a list that hasn't been archived into the
// payment-due list yet (see store.js's newList() - that only happens when
// the NEXT !newlist runs). Same ID-then-name matching order as every
// other bare-self lookup in this file (see resolveOwnDue's doc comment
// above for why ID is checked first) - `senderId` is optional so an
// explicit "!paid <name>" (no sender identity involved) can still check
// by name alone.
function isOnCurrentAttendance(event, senderId, name) {
  const all = [...event.entries, ...(event.waitlist || [])];
  if (senderId && all.some((e) => e.addedBy === senderId && e.self !== false)) return true;
  if (name) return all.some((e) => normalizeName(e.name) === normalizeName(name));
  return false;
}

// Matches "me, +N" or "+N, me" (ME_TOKEN/PLUS_N_TOKEN, both from
// lib/helpers.js) as the ENTIRE `rest` of an !in command - the sender
// explicitly asking to be added alongside N unnamed guests, in either
// order. Returns the guest count N, or null if `rest` isn't exactly this
// two-token combo (e.g. "me, Henry, +2" falls through to the generic
// parseNames path instead, same as any other multi-name list).
function matchMeAndPlusN(rest) {
  const tokens = rest
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length !== 2) return null;
  const [a, b] = tokens;
  if (ME_TOKEN.test(a) && PLUS_N_TOKEN.test(b)) return Number(b.match(PLUS_N_TOKEN)[1]);
  if (ME_TOKEN.test(b) && PLUS_N_TOKEN.test(a)) return Number(a.match(PLUS_N_TOKEN)[1]);
  return null;
}

// Resolves "!in +N" / "!in me, +N" (see PLUS_N_TOKEN/ME_TOKEN in
// lib/helpers.js) into the actual names to add, ADDITIVELY on top of
// whatever the sender already has on the list right now - unlike
// parseNames()' own (context-free) "+N" expansion, which always starts
// guest numbering at +1 and would just collide with (and be rejected as
// duplicates of) guests already added by an earlier "+N". E.g. the sender
// already has "Preston+1, Preston+2, Preston+3" on the list (from an
// earlier "!in +3") and says "add 3 more friends" (-> another "+3"): this
// returns ["Preston+4", "Preston+5", "Preston+6"], continuing the
// numbering, not a second "Preston+1, Preston+2, Preston+3" that would
// all be rejected as already-on-the-list duplicates.
//
// `includeSelf` distinguishes bare "+N" (guests only, sender excluded -
// pass false) from "me, +N" (sender explicitly included alongside the
// guests - pass true). Only actually adds the sender when they don't
// already have a self entry (see `ownSelfEntries` below) - "me, +2" said
// AFTER already being on the list just adds 2 more guests, same as bare
// "+2" would, since the sender is already there.
//
// Only ever called for handleIn's ADD path - !out/!paid's own "+N"/"me"
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
function resolveAdditiveGuestNames(groupId, senderId, senderName, guestCount, includeSelf) {
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

  const names = includeSelf && !ownSelfEntries.length ? [baseName] : [];
  for (let i = 1; i <= guestCount; i += 1) {
    names.push(`${baseName}+${existingMax + i}`);
  }
  return names;
}

// Widest a single "N-M" range token is ever expanded to (see
// expandRangeToken below) - well beyond any legitimate bulk removal, but
// bounded regardless so a wildly large range ("remove 1-99999") can't
// balloon into an enormous per-name loop. A range past this is treated as
// a literal (unmatched) token instead, same as any other malformed input -
// safe, just not smoothed over.
const MAX_RANGE_EXPANSION = 50;

// Expands a "N-M" range token (e.g. "1-5") into its individual numbers as
// separate string tokens ("1","2","3","4","5"). The model is told to do
// this expansion itself (see NUMBERED LIST REFERENCES in
// lib/geminiCommand.js), but doesn't always - the deterministic resolver
// below shouldn't depend on that compliance to stay correct, so it
// re-expands here too if a raw range token slips through unexpanded.
// Returns [token] unchanged for anything that isn't exactly this shape.
function expandRangeToken(token) {
  const match = token.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return [token];
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end || end - start + 1 > MAX_RANGE_EXPANSION) return [token];
  const expanded = [];
  for (let n = start; n <= end; n += 1) expanded.push(String(n));
  return expanded;
}

// A purely-numeric token in a !paid name list (e.g. "!paid 7,8") is
// resolved against the Payment section's OWN printed numbering (see
// resolveDuePaymentNumber in lib/helpers.js) instead of being looked up
// as a literal name - so referring to whoever the posted list currently
// shows as "7." works the same as typing their name. A non-numeric
// token, or a number resolveDuePaymentNumber can't resolve to exactly
// one entry (out of range, or the same number appearing in more than one
// payment-date group), is returned completely unchanged - it just flows
// into the ordinary literal-name lookup below and fails with the same
// "not on the payment list" rejection a nonsense name already gets,
// rather than a separate, more confusing error for what looks to the
// sender like the same kind of mistake either way.
//
// Takes `due` as a pre-fetched snapshot rather than fetching it itself -
// callers resolve every token in a batch against the SAME snapshot,
// taken before any of them are actually applied. Re-fetching fresh per
// token would let marking "7" paid shift everyone after it down one
// position, so "8" (originally the very next name) silently resolves to
// whoever *became* 8 only after 7 was removed - a real, sender-invisible
// mismatch for exactly the multi-name case ("!paid 7,8") this exists to
// support.
//
// Returns an ARRAY - almost always one item, but a raw "N-M" range token
// (see expandRangeToken above) expands into several.
function resolvePaidTokens(due, token) {
  return expandRangeToken(token).map((piece) => {
    if (!/^\d+$/.test(piece.trim())) return piece;
    const match = resolveDuePaymentNumber(due, Number(piece.trim()));
    return match ? match.name : piece;
  });
}

// Same idea as resolvePaidTokens above, but for !out - a purely-numeric
// token (e.g. "!out 7,8") is resolved against the Attendance/Waitlist
// section's OWN printed numbering (resolveAttendanceOrWaitlistNumber in
// lib/helpers.js) instead of being looked up as a literal name. Same
// "leave anything that doesn't resolve to exactly one entry alone"
// fallback - out of range, or ambiguous between Attendance and Waitlist
// both having an entry at that position, just flows into the ordinary
// literal-name lookup and fails with the existing "not on the list"
// rejection.
//
// Takes `event` as a pre-fetched snapshot for the same reason
// resolvePaidTokens takes `due` pre-fetched - callers resolve every token
// in a batch against ONE snapshot, taken before any of them are actually
// removed, so removing "7" can't shift "8" into a different person
// before it's looked up.
//
// Returns an ARRAY - see resolvePaidTokens above for why.
function resolveOutTokens(event, token) {
  return expandRangeToken(token).map((piece) => {
    if (!/^\d+$/.test(piece.trim())) return piece;
    const match = resolveAttendanceOrWaitlistNumber(event, Number(piece.trim()));
    return match ? match.name : piece;
  });
}

// Applies a leading "paid" keyword (see stripLeadingInKeywords) for
// handleIn/handleOut. `explicitNames`, when given, is the SAME name list
// !in/!out just processed - "!in paid Grace, Henry" marks both Grace and Henry
// paid, matched literally by name, exactly like standalone "!paid Grace,
// Henry" would. With no explicit names (the bare "!in paid" / "!out paid"
// case), falls back to resolveOwnDue() above instead of just reusing the
// sender's push name, since that's the identity-correct match for the
// SEPARATE duePayments list. Deliberately independent of whatever the
// !in/!out half of the command did - "already on the list, but let me pay
// what I owe" is a legitimate combo, so paying is attempted regardless of
// whether the add/remove itself succeeded for a given name.
async function runPaidIfFlagged(groupId, senderId, senderName, paidFlag, explicitNames) {
  if (!paidFlag) return { paid: [], paidRejected: [], paidAmbiguous: null };

  let names;
  if (explicitNames) {
    names = explicitNames;
  } else {
    const resolved = resolveOwnDue(groupId, senderId, senderName);
    if (resolved.noEntry) return { paid: [], paidRejected: [], paidAmbiguous: null };
    if (resolved.ambiguous) return { paid: [], paidRejected: [], paidAmbiguous: resolved.ambiguous };
    names = resolved.names;
  }

  // Only fetched if actually needed below (a rejection occurs) - see
  // isOnCurrentAttendance's doc comment (near resolveOwnDue above) for
  // what this is for: telling "genuinely not owed anything" apart from
  // "trying to pay EARLY, before this list is archived into a real
  // payment-due one" - the same distinction handlePaid's own standalone
  // path makes, applied here too since "!in paid"/"!out paid" is just as
  // common a way to attempt paying early as bare "!paid" is.
  let event = null;

  const paid = [];
  const paidRejected = [];
  for (const name of names) {
    const result = markPaid(groupId, name);
    if (result.ok) {
      paid.push(name.trim());
    } else {
      if (!event) event = getCurrentEvent(groupId);
      if (isOnCurrentAttendance(event, null, name)) {
        paidRejected.push(`${name.trim()} isn't on the payment list yet - they're on the CURRENT list, which only turns into the payment list once it wraps up and ${COMMAND_PREFIX}newlist starts the next one`);
      } else {
        paidRejected.push(
          `${name.trim()} is not on the payment list, perhaps they signed up under a different name or someone already marked them as paid`
        );
      }
    }
  }
  return { paid, paidRejected, paidAmbiguous: null };
}

// Shared reply lines for a runPaidIfFlagged() outcome - used from every
// call site in handleIn/handleOut below so the wording stays in exactly
// one place. A clean paid outcome
// (paidOutcome.paid.length) intentionally gets no reply of its own here -
// same as standalone !paid, the reposted list (with the payment-due
// section shrunk) is proof enough; callers are still responsible for
// triggering that postList() themselves.
async function replyPaidOutcome(reply, paidOutcome) {
  if (paidOutcome.paidAmbiguous) {
    await reply(
      `Which one, though? You have more than one entry on the Payment list - say which one: ${COMMAND_PREFIX}paid <name>\nYours: ${paidOutcome.paidAmbiguous.join(', ')}`
    );
  }
  if (paidOutcome.paidRejected.length) {
    await reply(`Hmm, couldn't mark paid:\n${paidOutcome.paidRejected.join('\n')}`);
  }
}

// Applies a leading "tournament" keyword (see stripLeadingInKeywords) to a
// list of names that are ALREADY on the attendance list - someone who
// joined plain "!in" earlier (themselves, or someone else) and comes back
// later with "!in tournament" (or "!in tournament Grace, Henry", naming people
// already on the list) to additionally opt in, without re-adding anyone.
// Deliberately separate from the brand-new-entry path below, which handles
// its own tournament opt-in via addEntry()'s `wantsTournament` param -
// this one instead upgrades entries that already exist, via
// store.js's joinTournament() (by name - it doesn't need entry objects).
// Returns { joined, disabled, full, notFound }: `joined` lists names newly
// opted in (already-in entries are silently skipped, not re-counted, not an
// error); `disabled`/`full` flag whether the request as a whole hit either
// failure reason (for the caller's reply - see handleIn below); `notFound`
// lists names joinTournament() couldn't find in `entries` at all (e.g.
// someone on the WAITLIST rather than confirmed attendance - see
// joinTournament()'s doc comment for why that's not eligible yet).
async function applyTournamentUpgradeIfFlagged(groupId, names, tournamentFlag) {
  if (!tournamentFlag) return { joined: [], disabled: false, full: false, notFound: [] };
  const joined = [];
  const notFound = [];
  let disabled = false;
  let full = false;
  for (const name of names) {
    const result = joinTournament(groupId, name);
    if (result.ok && !result.alreadyIn) {
      joined.push(name);
    } else if (!result.ok && result.reason === 'disabled') {
      disabled = true;
    } else if (!result.ok && result.reason === 'full') {
      full = true;
    } else if (!result.ok && result.reason === 'not_found') {
      notFound.push(name);
    }
  }
  return { joined, disabled, full, notFound };
}

async function handleIn(ctx) {
  const { sock, msg, groupId, senderId, senderName, argText, upsertType, reply, postList } = ctx;
  const isCatchUp = upsertType === 'append';
  // Leading "paid" and/or "tournament" keywords (either order, e.g. "!in
  // paid", "!in tournament paid", "!in tournament Grace, Henry") let someone
  // join, confirm payment, and/or opt into the tournament all in one
  // message - see stripLeadingInKeywords' doc comment. `rest` (the
  // argText with both keywords stripped off) is used everywhere below in
  // place of the raw argText for name resolution.
  const { rest, paid: paidFlag, tournament: tournamentFlag } = stripLeadingInKeywords(argText);

  // "me" (ME_TOKEN, lib/helpers.js) said on its own is the explicit way to
  // add yourself - treated exactly like no argText at all. Distinct from
  // "me, +N" below, which ALSO adds N unnamed guests alongside yourself.
  const isBareSelfAdd = !rest || ME_TOKEN.test(rest.trim());

  if (isBareSelfAdd) {
    // Bare !in (optionally "!in paid"/"!in tournament", or "!in me") - add
    // "myself." Your WhatsApp display name can differ from (or change
    // since) whatever name you're already on the list (or waitlist) under,
    // so check by WhatsApp ID first rather than blindly adding your current
    // push name as a second, duplicate entry. Also requires
    // `self !== false` - otherwise, having previously typed "!in Alice,
    // Bob, Carla" (entries attributed to you via `addedBy` for removal
    // purposes, but not YOU) would make the bot claim you're already on as
    // "Alice, Bob, and Carla" - see store.js's addEntry doc comment.
    const event = getCurrentEvent(groupId);
    const own = [...event.entries, ...(event.waitlist || [])].filter(
      (e) => e.addedBy === senderId && e.self !== false
    );
    if (own.length) {
      const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, null);
      // Only entries actually on `entries` (not the waitlist) can opt into
      // the tournament - see joinTournament()'s doc comment.
      const tournamentOutcome = await applyTournamentUpgradeIfFlagged(
        groupId,
        own.filter((e) => event.entries.includes(e)).map((e) => e.name),
        tournamentFlag
      );
      if (!isCatchUp) {
        await reply(`Ha, nice try - you're already on the list as "${own.map((e) => e.name).join('", "')}".`);
        await replyPaidOutcome(reply, paidOutcome);
        if (tournamentOutcome.disabled) {
          await reply(`Tournament isn't enabled for this group (see ${COMMAND_PREFIX}tournament).`);
        }
        if (paidOutcome.paid.length || tournamentOutcome.joined.length) {
          await postList();
        }
      }
      return {
        command: 'in',
        senderName,
        argText,
        alreadyOn: own.map((e) => e.name),
        ...paidOutcome,
        tournamentJoined: tournamentOutcome.joined,
      };
    }
  }

  // Only the true bare-!in path (no name, or literal "me", typed) represents
  // the sender signing THEMSELVES up - parseNames resolves to a single-
  // element [senderName] array in both cases (see its doc comment), so
  // `isBareSelfAdd` here is equivalent to "this loop's one name is the
  // sender." Any explicitly-typed name (even the sender's own, even
  // alongside other names) is NOT marked self - see store.js's addEntry
  // doc comment for why that distinction matters.
  //
  // "!in +2" adds 2 unnamed guests WITHOUT the sender (PLUS_N_TOKEN, see
  // lib/helpers.js) - say "!in me, +2" (or the AI mapping "add me and 2
  // friends" to argText "me, +2" - see lib/geminiCommand.js) to ALSO sign
  // the sender up alongside those guests. Either way, only the bare self
  // entry (if newly added, see resolveAdditiveGuestNames) is really "the
  // sender" for `self` purposes; the +1/+2 entries are separate people,
  // same as if the sender had typed "Henry, Henry+1" for someone else.
  // Only applies when the ENTIRE argText is just "+N" or "me, +N"/"+N, me"
  // - "Alice, +2" is treated as an explicit multi-name list instead, same
  // as any other combination of names, with no entry marked self.
  const bareGuestMatch = isBareSelfAdd ? null : rest.trim().match(PLUS_N_TOKEN);
  const meAndGuestCount = isBareSelfAdd ? null : matchMeAndPlusN(rest);
  const isAdditiveGuestAdd = Boolean(bareGuestMatch) || meAndGuestCount != null;
  const additiveIncludesSelf = meAndGuestCount != null;
  // "+N"/"me, +N" additively resolves against what the sender already has
  // on the list (see resolveAdditiveGuestNames's doc comment) rather than
  // parseNames()' simpler, always-starts-at-+1 expansion, so a repeat
  // "add N more friends" continues the numbering instead of colliding
  // with (and being rejected as duplicates of) guests already added by an
  // earlier "+N".
  let names = isAdditiveGuestAdd
    ? resolveAdditiveGuestNames(
        groupId,
        senderId,
        senderName,
        bareGuestMatch ? Number(bareGuestMatch[1]) : meAndGuestCount,
        additiveIncludesSelf
      )
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
  const tournamentJoined = []; // names already on the list, upgraded into the tournament below
  if (regularPlayersExpansion.usedEmptyRegularPlayers) {
    rejected.push(`regular players - none saved yet (see ${COMMAND_PREFIX}regulars to set them)`);
  }

  // Checked once up front (not re-fetched per name) - whether tournament is
  // actually on for this group right now, so a leading "tournament"
  // keyword (see stripLeadingInKeywords above) knows whether it can take
  // effect. Applies to EVERY name in this command, same as "paid" does -
  // "!in tournament Grace, Henry" opts both Grace and Henry in.
  const tournamentEnabled = getCurrentEvent(groupId).tournamentEnabled;
  let tournamentRequestedButDisabled = false;

  for (const name of names) {
    const modResult = checkEntry(name);
    if (!modResult.ok) {
      rejected.push(`${name} - ${modResult.reason}`);
      continue;
    }
    const isSelfEntry = isBareSelfAdd || (additiveIncludesSelf && name === senderName);
    if (tournamentFlag && !tournamentEnabled) tournamentRequestedButDisabled = true;
    const result = addEntry(groupId, name, senderId, senderIsAdmin, isSelfEntry, tournamentFlag);
    if (!result.ok) {
      // A "duplicate" here just means this name is already on the list (or
      // waitlist) - normally that's simply rejected. But with a leading
      // "tournament" keyword (e.g. "!in tournament Grace, Henry" where Grace
      // and Henry already joined earlier via plain "!in"), that's not a
      // failure at all - it's a request to opt an EXISTING entry into the
      // tournament, same as the bare-self "already on the list" branch
      // above handles for a lone sender. See applyTournamentUpgradeIfFlagged
      // (used by both).
      if (tournamentFlag) {
        const upgrade = await applyTournamentUpgradeIfFlagged(groupId, [name], true);
        if (upgrade.joined.length) {
          tournamentJoined.push(name.trim());
        } else if (upgrade.notFound.length) {
          // On the waitlist, not `entries` - joinTournament() can't reach
          // them yet (see its doc comment); this genuinely IS a rejection.
          rejected.push(`${name.trim()} - already on the waitlist, not eligible for the tournament until promoted (see ${COMMAND_PREFIX}allow)`);
        }
        // upgrade.disabled is already reflected in tournamentRequestedButDisabled above.
        // upgrade.full and "already in the tournament, no-op" both need no
        // rejection line - a full tournament tags them (🏆 WL) right on
        // their existing entry (visible in the reposted list below), and
        // "already in" isn't an error, just nothing new to do.
      } else {
        rejected.push(`${name.trim()} - already on the list`);
      }
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
  const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, rest ? names : null);

  if (!isCatchUp) {
    if (rejected.length) {
      await reply(`Couldn't add:\n${rejected.join('\n')}`);
    }
    await replyPaidOutcome(reply, paidOutcome);
    // Unlike a full tournament (capacity reached) - which is quietly
    // visible from the reposted list itself, tagged "(🏆 WL)" under
    // "Social only" (see store.js's addEntry()/entry.tournamentWaitlisted
    // and lib/helpers.js's formatList()) - tournament not being enabled AT
    // ALL gets an explicit reply, since there'd be no tournament UI in the
    // list at all to hint at why.
    if (tournamentRequestedButDisabled) {
      await reply(`Tournament isn't enabled for this group (see ${COMMAND_PREFIX}settournament) - joined the social list only, no trophy for you yet.`);
    }
    // No separate "added to the waitlist" (or "tournament is full"/"joined
    // the tournament") reply - the posted list below (with them shown in
    // its Waitlist section, under 🏆 Tournament, or tagged
    // "(🏆 WL)" under "Social only") is proof enough, same as any other
    // successful, authorized change.
    if (added.length || waitlisted.length || tournamentJoined.length || paidOutcome.paid.length) {
      await postList();
    }
  }

  return { command: 'in', senderName, argText, added, waitlisted, rejected, tournamentJoined, ...paidOutcome };
}

// Handles a leading "tournament" keyword on !out (see stripLeadingInKeywords
// above) - takes someone OUT of the tournament (or off its (🏆 WL) queue)
// while leaving them on the social list, via store.js's leaveTournament().
// Deliberately separate from handleOut's own removeEntry() loop below, same
// relationship as handleIn's applyTournamentUpgradeIfFlagged has to its own
// add loop - this only flips a flag on an entry that stays right where it
// is, it never removes anyone from the list (that's still plain "!out
// <name>", handled below). Bare "!out tournament" resolves the sender's own
// entry the same way handleOut's own bare-self path does, but only against
// `entries` (not the waitlist) - the tournament flags only ever live on
// confirmed entries, never a waitlist one - see joinTournament()'s doc
// comment for why. If the sender has NO entry at all to remove from the
// tournament, this adds them fresh instead (social only) rather than just
// rejecting - see its own doc comment inside, right where that happens.
async function handleLeaveTournament(ctx, rest, paidFlag) {
  const { sock, msg, groupId, senderId, senderName, argText, upsertType, reply, postList } = ctx;
  const isCatchUp = upsertType === 'append';

  let names;
  if (!rest) {
    const event = getCurrentEvent(groupId);
    const own = event.entries.filter((e) => e.addedBy === senderId && e.self !== false);
    let resolvedByExistingDuplicate = false;
    if (own.length === 0) {
      // No entry FLAGGED as the sender's own to take OUT of the tournament
      // - rather than a dead end, add the sender fresh instead, social only
      // (no tournament flag). Real bug report: a bare self "social only"
      // request (e.g. natural language "make me social only"/"take me out
      // of the tournament") always maps to THIS command (see
      // lib/geminiCommand.js's "out" SPECIAL CASE) even when the sender
      // turns out to have never joined at all - the model has no way to
      // check "is 'me' currently in the tournament" against the CURRENT
      // LIST the way it can for a NAMED target (it can't match a WhatsApp
      // ID to a printed name), so it can't reliably choose "in" vs "out"
      // itself here. This code CAN check (via addedBy, just above), so it
      // resolves the ambiguity the same way the "in"/"out" SPECIAL CASE
      // already does for a named target - ending up social-only either way
      // achieves what "social only" actually asked for, whether that's
      // satisfied by removing an existing tournament entry or by adding a
      // fresh non-tournament one.
      const modResult = checkEntry(senderName);
      let addResult = { ok: false };
      if (modResult.ok) {
        const senderIsAdmin = await isGroupAdmin(sock, groupId, senderId);
        addResult = addEntry(groupId, senderName, senderId, senderIsAdmin, true, false);
        if (addResult.ok) {
          const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, null);
          if (!isCatchUp) {
            await reply(
              addResult.waitlisted
                ? `Weren't even on the tournament to begin with, so I've added you to the list instead (social only) - you're on the waitlist for now, promoted the moment a spot frees up.`
                : `Weren't even on the tournament to begin with, so I've added you to the list instead - social only, as asked.`
            );
            await replyPaidOutcome(reply, paidOutcome);
            await postList();
          }
          return { command: 'out', senderName, argText, addedSocialOnly: [senderName], waitlisted: addResult.waitlisted, ...paidOutcome };
        }
      }

      if (addResult.reason === 'duplicate') {
        // A name exactly matching the sender's own push name is ALREADY on
        // the list - almost always genuinely the sender's own entry, just
        // never flagged `self` (e.g. added via !update, a bulk "!newlist
        // ... with ..." list, or someone typing their name explicitly
        // instead of a bare !in - see addEntry's own doc comment on `self`
        // for why that doesn't cover every real self-add). Real bug
        // report: this used to fall straight through to the generic "not
        // even on the list" rejection below, even with the sender's exact
        // name sitting right there on the list under "🏆 Tournament" -
        // resolve it the same way the explicit "!out tournament <name>"
        // form already would, rather than assuming it must be a different
        // real person of the same name (that assumption is no more/less
        // risky than what the explicit named form already accepts).
        names = [senderName];
        resolvedByExistingDuplicate = true; // skip the ambiguity/empty checks below - a name is already resolved
      } else {
        const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, null);
        if (!isCatchUp) {
          await reply(
            `Can't take you out of the tournament if you're not even on the list! If your WhatsApp name doesn't match what's on the list, use ${COMMAND_PREFIX}out tournament <name>.`
          );
          await replyPaidOutcome(reply, paidOutcome);
          if (paidOutcome.paid.length) {
            await postList();
          }
        }
        return { command: 'out', senderName, argText, noEntry: true, ...paidOutcome };
      }
    }
    if (!resolvedByExistingDuplicate && own.length > 1) {
      const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, null);
      if (!isCatchUp) {
        await reply(
          `Which one, though? You have more than one entry - say which one: ${COMMAND_PREFIX}out tournament <name>\nYours: ${own.map((e) => e.name).join(', ')}`
        );
        await replyPaidOutcome(reply, paidOutcome);
        if (paidOutcome.paid.length) {
          await postList();
        }
      }
      return { command: 'out', senderName, argText, ambiguous: own.map((e) => e.name), ...paidOutcome };
    }
    if (!resolvedByExistingDuplicate) {
      names = [own[0].name];
    }
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

  const tournamentLeft = [];
  const rejected = [];
  const alreadyOut = [];
  const tournamentPromoted = [];

  for (const name of names) {
    const result = leaveTournament(groupId, name);
    if (!result.ok) {
      rejected.push(`${name.trim()} - not on the list`);
    } else if (result.alreadyOut) {
      alreadyOut.push(name.trim());
    } else {
      tournamentLeft.push(name.trim());
      if (result.promoted && result.promoted.length) {
        tournamentPromoted.push(...result.promoted);
      }
    }
  }

  // Same independent-of-the-leave-outcome reasoning as handleIn/handleOut's
  // paid handling - see runPaidIfFlagged's doc comment.
  const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, rest ? names : null);

  if (!isCatchUp) {
    if (rejected.length) {
      await reply(`Couldn't move to social only, alas:\n${rejected.join('\n')}`);
    }
    await replyPaidOutcome(reply, paidOutcome);
    if (tournamentPromoted.length) {
      // A tournament spot just freed up, auto-promoting the front of the
      // (🏆 WL) queue - see leaveTournament()'s doc comment. Sent directly
      // (not via the `reply` helper) so we can pass `mentions` to actually
      // notify them, not just print their name as plain text.
      const { text, mentions } = formatTournamentPromotedMessage(tournamentPromoted);
      await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
    }
    // No separate reply for a clean tournamentLeft/alreadyOut outcome - the
    // reposted list (now showing them under "Social only" instead of "🏆
    // Tournament", with no (🏆 WL) tag) is proof enough, same as
    // any other successful, authorized change.
    if (tournamentLeft.length || tournamentPromoted.length || paidOutcome.paid.length) {
      await postList();
    }
  }

  return { command: 'out', senderName, argText, tournamentLeft, rejected, alreadyOut, tournamentPromoted, ...paidOutcome };
}

async function handleOut(ctx) {
  const { sock, msg, groupId, senderId, senderName, argText, upsertType, reply, postList } = ctx;
  const isCatchUp = upsertType === 'append';
  // See handleIn's matching comment - a leading "paid" keyword (e.g.
  // "!out paid" or "!out paid Grace, Henry") lets someone leave and confirm
  // payment in one message. A leading "tournament" keyword (e.g. "!out
  // tournament" or "!out tournament Isaac") instead branches off entirely
  // to handleLeaveTournament above - taking someone OUT of the tournament
  // only, NOT off the list - since that's a fundamentally different
  // operation from the removeEntry() loop below.
  const { rest, paid: paidFlag, tournament: tournamentFlag } = stripLeadingInKeywords(argText);
  if (tournamentFlag) {
    return handleLeaveTournament(ctx, rest, paidFlag);
  }
  let names;

  // "me" (ME_TOKEN, lib/helpers.js) said on its own is the explicit way to
  // remove yourself - treated exactly like no argText at all. A bare "+N"
  // (no "me") only removes N of your own unnamed guest entries, NOT you -
  // see PLUS_N_TOKEN's doc comment.
  if (!rest || ME_TOKEN.test(rest.trim())) {
    // No name given - remove "myself." Match by WhatsApp ID rather than
    // display name: your push name doesn't always match whatever text
    // ended up on the list (yours or whoever added you may have typed
    // a nickname), so name-matching alone can miss your own entry.
    // Covers the waitlist too, in case that's where you ended up. Also
    // requires `self !== false` - entries you added FOR someone else
    // (e.g. via "!in Alice, Bob, Carla") carry your `addedBy` too, but
    // aren't you - see store.js's addEntry doc comment.
    const event = getCurrentEvent(groupId);
    const own = [...event.entries, ...(event.waitlist || [])].filter(
      (e) => e.addedBy === senderId && e.self !== false
    );
    if (own.length === 0) {
      const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, null);
      if (!isCatchUp) {
        await reply(
          `Can't remove you from a list you're not even on! If your WhatsApp name doesn't match what's on the list, use ${COMMAND_PREFIX}out <name>.`
        );
        await replyPaidOutcome(reply, paidOutcome);
        if (paidOutcome.paid.length) {
          await postList();
        }
      }
      return { command: 'out', senderName, argText, noEntry: true, ...paidOutcome };
    }
    if (own.length > 1) {
      const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, null);
      if (!isCatchUp) {
        await reply(
          `Which one, though? You have more than one entry - say which one: ${COMMAND_PREFIX}out <name>\nYours: ${own.map((e) => e.name).join(', ')}`
        );
        await replyPaidOutcome(reply, paidOutcome);
        if (paidOutcome.paid.length) {
          await postList();
        }
      }
      return { command: 'out', senderName, argText, ambiguous: own.map((e) => e.name), ...paidOutcome };
    }
    names = [own[0].name];
  } else {
    names = parseNames(rest, senderName);
    // One snapshot, taken before any name in this batch is actually
    // removed - see resolveOutTokens' own doc comment for why re-fetching
    // per token would corrupt "!out 7,8" the moment 7 is removed. flatMap,
    // not map - a raw "N-M" range token (see expandRangeToken) expands
    // into several names, and the MAX_NAMES_PER_COMMAND check right below
    // needs to see the real, expanded count.
    const event = getCurrentEvent(groupId);
    names = names.flatMap((name) => resolveOutTokens(event, name));
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
  const promoted = [];
  const tournamentPromoted = [];

  for (const name of names) {
    const result = removeEntry(groupId, name);
    if (!result.ok) {
      if (result.reason === 'not_found') {
        rejected.push(`${name.trim()} - not on the list`);
      }
    } else {
      removed.push(name.trim());
      if (result.promoted && result.promoted.length) {
        promoted.push(...result.promoted);
      }
      if (result.tournamentPromoted && result.tournamentPromoted.length) {
        tournamentPromoted.push(...result.tournamentPromoted);
      }
    }
  }

  // Same independent-of-the-remove-outcome reasoning as handleIn's paid
  // handling - see its comment above.
  const paidOutcome = await runPaidIfFlagged(groupId, senderId, senderName, paidFlag, rest ? names : null);

  if (!isCatchUp) {
    if (rejected.length) {
      await reply(`Couldn't remove, my apologies:\n${rejected.join('\n')}`);
    }
    await replyPaidOutcome(reply, paidOutcome);
    if (promoted.length) {
      // A spot freed up, so someone was auto-promoted off the waitlist -
      // worth calling out (and tagging) since it's a status change for a
      // name that wasn't even part of this command. Sent directly (not
      // via the `reply` helper) so we can pass `mentions` to actually
      // notify them, not just print their name as plain text.
      const { text, mentions } = formatPromotedMessage(promoted);
      await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
    }
    if (tournamentPromoted.length) {
      // Same idea, but for whoever was leaving had entry.tournament: true -
      // that frees a tournament spot, auto-promoting the front of the
      // (🏆 WL) queue. Separate message from the main-waitlist one above
      // since they're two different queues.
      const { text, mentions } = formatTournamentPromotedMessage(tournamentPromoted);
      await sock.sendMessage(groupId, { text, mentions }, { quoted: msg });
    }
    if (removed.length || promoted.length || tournamentPromoted.length || paidOutcome.paid.length) {
      await postList();
    }
  }

  return { command: 'out', senderName, argText, removed, rejected, promoted, tournamentPromoted, ...paidOutcome };
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
  // One snapshot, taken before any name in this batch is actually marked
  // paid - see resolvePaidTokens' own doc comment for why re-fetching per
  // token would corrupt "!paid 7,8" the moment 7 is removed. Also doubles
  // as the source for isOnCurrentAttendance's entries/waitlist check below
  // - nothing in this function ever touches attendance, so one snapshot is
  // safe to reuse throughout.
  const event = getCurrentEvent(groupId);
  const dueSnapshot = event.duePayments || [];

  // "me" (ME_TOKEN, lib/helpers.js) said on its own is the explicit way to
  // mark yourself paid - treated exactly like no argText at all.
  if (!argText || ME_TOKEN.test(argText.trim())) {
    // No name given - mark "myself" paid. Delegates to resolveOwnDue()
    // above (its own doc comment covers the WhatsApp-ID matching and why
    // multiple entries under the SAME name aren't ambiguous anymore - only
    // different names are, since owing for two separate events is now
    // normal, not a sign something's wrong).
    const resolved = resolveOwnDue(groupId, senderId, senderName);
    if (resolved.noEntry) {
      if (!isCatchUp) {
        // Two genuinely different reasons this comes up empty - see
        // isOnCurrentAttendance's own doc comment: actually owing nothing
        // (the plain "good news" case) versus being on the CURRENT list
        // already, which reads as trying to pay EARLY, before this list
        // has even been archived into a real payment-due one.
        if (isOnCurrentAttendance(event, senderId, senderName)) {
          await reply(
            `Whoa, eager! The payment list isn't up yet for this one - it only gets created once this list wraps up and ${COMMAND_PREFIX}newlist starts the next one. Nothing to pay right now - check back once the new list's up.`
          );
        } else {
          await reply(
            `Good news - you're not on the payment list! If your WhatsApp name doesn't match what's on the list, mention @Snoopy with "paid <name>".`
          );
        }
      }
      return { command: 'paid', senderName, argText, noEntry: true };
    }
    if (resolved.ambiguous) {
      if (!isCatchUp) {
        await reply(
          `Which one, though? You have more than one entry on the Payment list - say which one: ${COMMAND_PREFIX}paid <name>\nYours: ${resolved.ambiguous.join(', ')}`
        );
      }
      return { command: 'paid', senderName, argText, ambiguous: resolved.ambiguous };
    }
    names = resolved.names;
  } else {
    names = parseNames(argText, senderName);
    // flatMap, not map - a raw "N-M" range token (see expandRangeToken)
    // expands into several names, and the MAX_NAMES_PER_COMMAND check
    // right below needs to see the real, expanded count.
    names = names.flatMap((name) => resolvePaidTokens(dueSnapshot, name));
  }

  const senderIsAdmin = await isGroupAdmin(sock, groupId, senderId);
  if (!senderIsAdmin && names.length > MAX_NAMES_PER_COMMAND) {
    if (!isCatchUp) {
      await reply(maxNamesReply('mark', ' paid'));
    }
    return { command: 'paid', senderName, argText, tooMany: true };
  }

  const paid = [];
  const rejected = [];

  for (const name of names) {
    const result = markPaid(groupId, name);
    if (!result.ok) {
      // Same "trying to pay early" distinction as the bare-self branch
      // above (see isOnCurrentAttendance's doc comment) - a name that's on
      // the CURRENT attendance/waitlist but not yet due gets a clearer,
      // more accurate reason than the generic "not on the payment list"
      // one, which would otherwise wrongly suggest a typo/wrong name.
      if (isOnCurrentAttendance(event, null, name)) {
        rejected.push(`${name.trim()} isn't on the payment list yet - they're on the CURRENT list, which only turns into the payment list once it wraps up and ${COMMAND_PREFIX}newlist starts the next one`);
      } else {
        rejected.push(
          `${name.trim()} is not on the payment list, perhaps they signed up under a different name or someone already marked them as paid`
        );
      }
    } else {
      paid.push(name.trim());
    }
  }

  if (!isCatchUp) {
    if (rejected.length) {
      await reply(`Hmm, couldn't mark paid:\n${rejected.join('\n')}`);
    }
    if (paid.length) {
      await postList();
    }
  }

  return { command: 'paid', senderName, argText, paid, rejected };
}

module.exports = { handleIn, handleOut, handleList, handlePaid };