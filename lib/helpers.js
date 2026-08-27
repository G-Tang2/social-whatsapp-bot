// lib/helpers.js
// Pure-ish formatting/parsing helpers shared across command handlers. Moved
// here verbatim from the old monolithic index.js as part of splitting that
// file into lib/ + commands/ - behavior is unchanged, only the location and
// how config values are imported (from ./config instead of module-scope
// constants) have changed.

const { getCurrentEvent } = require('../store');
const { parseCourtCount } = require('../store');
const { getRegularPlayers } = require('../store');
const { formatDisplayDate } = require('../dates');
const { PAYMENT_LABEL, MAX_NAMES_PER_COMMAND } = require('./config');

// Plain-text divider printed in formatList() below, both above Attendance
// (setting it apart from the header/winners banner) and above the
// payment-due section header (setting it apart from Attendance/Waitlist),
// so each major block reads as visually distinct at a glance. Deliberately
// plain (no bold asterisks) - see the comment at its payment-section use
// site for why.
const SECTION_DIVIDER = '──────────';

// Matches a bare "+N" token, e.g. "+1" or "+ 2" - shorthand for N unnamed
// guests (see parseNames below). Deliberately distinct from an explicit
// "Henry+1"-style name (that's a real name with a literal "+1" suffix
// typed by whoever's adding Henry, not this shorthand) - this only
// matches a token that is ENTIRELY "+" then digits, nothing else.
//
// Deliberately does NOT include the sender - "+N" alone means N guests
// and nothing else, never "+N" AND the sender too. Say "me" as its own
// token (see ME_TOKEN below) to also add yourself - "me, +2" is you plus
// 2 guests, "+2" by itself is just the 2 guests, not you. This split (a
// real bug report: someone typing a bare "+2" kept getting themselves
// added along with 2 guests when they only meant 2 unnamed friends) is
// why this ISN'T simply "sender + N guests" the way it used to be.
const PLUS_N_TOKEN = /^\+\s*(\d+)$/;

// Matches a bare "me" token, case-insensitively - the explicit way to
// include the sender alongside other tokens in the SAME comma list (most
// commonly "me, +N" - see PLUS_N_TOKEN above), since a "+N" token no
// longer includes the sender on its own. Also works as argText on its
// own ("!in me") - resolves to `fallbackName`, same as no argText at all.
// Deliberately a whole-token match, not a substring search, so a real
// name that merely contains "me" (e.g. "Amelia") is never mistaken for
// this.
const ME_TOKEN = /^me$/i;

// Splits "!in Grace, Henry, Henry+1" style input into ["Grace", "Henry", "Henry+1"].
// A bare command with no argument falls back to a single-element list
// containing the sender's own name.
//
// Recognizes two special tokens within the comma-separated list, in
// addition to literal names:
// - "me" (ME_TOKEN above) resolves to `fallbackName` - the explicit way
//   to include the sender alongside other tokens, e.g. "me, +2" or
//   "me, Henry".
// - A bare "+N" (PLUS_N_TOKEN above, e.g. "!in +2", or "@bot add 2
//   friends" mapped by the AI - see lib/geminiCommand.js's
//   COMMAND_ARG_GUIDE) expands to `${fallbackName}+1`, ...,
//   `${fallbackName}+N` ONLY - N unnamed guests, reusing the existing
//   "Name+1" convention (see the README/help text) but generated
//   automatically instead of requiring the sender to type it out per
//   guest. Does NOT include the sender itself - combine with an explicit
//   "me" token for that (e.g. "me, +2").
// Works the same way for !in/!out/!paid, since all three call this - "!out
// +2" removes both your +1/+2 guest entries (not you) by the same
// expansion; "!out me, +2" removes you and both guest entries.
// A token matching neither (a real name, or an explicit "Henry+1")
// passes through unchanged. See commands/list.js's handleIn for the one
// place this matters beyond simple name-matching: it separately figures
// out which resulting name (if any) is really "the sender", so it's
// recorded with the correct `self` flag - the `+1`/`+2` entries are
// treated as separate people the sender is vouching for, same as if
// they'd typed "Henry, Henry+1" for someone else.
function parseNames(argText, fallbackName) {
  if (!argText) return [fallbackName];
  const rawTokens = argText
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  const names = [];
  for (const token of rawTokens) {
    if (ME_TOKEN.test(token)) {
      names.push(fallbackName);
      continue;
    }
    const plusMatch = token.match(PLUS_N_TOKEN);
    if (!plusMatch) {
      names.push(token);
      continue;
    }
    const guestCount = Number(plusMatch[1]);
    for (let i = 1; i <= guestCount; i += 1) {
      names.push(`${fallbackName}+${i}`);
    }
  }
  return names;
}

// Matches a placeholder reference to the group's saved "regular
// players" roster (see store.js's getRegularPlayers/setRegularPlayers and
// commands/admin.js's !regulars) as its OWN token within an already
// comma-split name list - "regular players", "regulars", "the regular
// players", or "regular player" (singular), case-insensitively. Deliberately
// narrow (whole-token match, not a substring search) so a real person
// actually named e.g. "Newsual Players" isn't accidentally swallowed.
const REGULAR_PLAYERS_TOKEN = /^(?:the\s+)?regulars?(?:\s+players?)?$/i;

// Expands any "regular players" placeholder token (see REGULAR_PLAYERS_TOKEN)
// found within `names` (an already comma-split array, e.g. from
// parseNames() or !newlist's "with ..." clause) into the group's actual
// stored regular-players roster, spliced in at the same position - e.g.
// `["Extra Guest", "regular players"]` with a stored roster of `["Alice",
// "Bob"]` becomes `["Extra Guest", "Alice", "Bob"]`. Shared by
// commands/list.js's handleIn ("add the regular players") and
// commands/admin.js's handleNewlist ("!newlist ... with regular players"),
// so both features expand the SAME literal token identically rather than
// each reimplementing their own detection.
//
// The bot does this expansion itself rather than relying on the AI to
// have enumerated the stored names correctly - same reasoning as "+N"
// (see PLUS_N_TOKEN above): the model is told to emit the literal token
// unexpanded (see lib/geminiCommand.js's COMMAND_ARG_GUIDE), and this
// function is the single place that turns it into real names,
// deterministically, from the actual current data.
//
// Returns `names` completely UNCHANGED (the same array reference, not a
// copy) when the token isn't present at all - a cheap no-op for the
// overwhelmingly common case where nobody mentioned "regular players", and
// safe for callers that assume "no token present" means nothing to do.
// When the token IS present but the group has no regular players saved
// yet, it's simply dropped rather than left in as a literal "regular
// players" string that would go on to fail moderation or be added as a
// bogus name - `usedEmptyRegularPlayers` flags this so callers can mention
// it in their reply instead of silently doing nothing.
function expandRegularPlayersToken(names, groupId) {
  if (!names.some((n) => REGULAR_PLAYERS_TOKEN.test(n.trim()))) {
    return { names, usedEmptyRegularPlayers: false };
  }

  const regulars = getRegularPlayers(groupId);
  const expanded = [];
  let usedEmptyRegularPlayers = false;
  for (const n of names) {
    if (REGULAR_PLAYERS_TOKEN.test(n.trim())) {
      if (regulars.length) {
        expanded.push(...regulars);
      } else {
        usedEmptyRegularPlayers = true;
      }
    } else {
      expanded.push(n);
    }
  }
  return { names: expanded, usedEmptyRegularPlayers };
}

// The "too many names" rejection message for !in/!out/!paid, shared so the
// wording stays consistent across all three. Only ever shown to non-admins -
// admins have no cap, so callers should skip the length check entirely for
// them rather than call this.
function maxNamesReply(verb, suffix = '') {
  return `Whoa, slow down! You can ${verb} up to ${MAX_NAMES_PER_COMMAND} names${suffix} in one command (no limit for group admins).`;
}

// Parses the optional "[location] | [courts] | [time]" portion of
// !newlist (the text after the DD/MM date, already trimmed).
//   - No text at all -> nothing set, everything carries forward.
//   - No "|" anywhere -> treated as location only (courts/time carry
//     forward) - the common case of just updating where it's happening.
//   - One or two "|"s -> up to three segments: location, courts, time.
//     A segment that's present but empty (e.g. two "|"s with nothing
//     between them) explicitly clears that field; a segment left off the
//     end entirely (fewer than 3 after splitting) carries forward.
// Returns { details } - a details object matching newList()'s expected
// shape (undefined = carry forward, null = clear, value = set) - or
// { error } if the courts segment doesn't parse as a valid court list.
function parseNewListDetails(rest) {
  const details = {};
  if (!rest) return { details };

  if (!rest.includes('|')) {
    details.location = rest;
    return { details };
  }

  const segs = rest.split('|').map((s) => s.trim());
  details.location = segs[0] === '' ? null : segs[0];

  if (segs.length > 1) {
    const courtsRaw = segs[1];
    if (courtsRaw === '') {
      details.courts = null;
    } else {
      const count = parseCourtCount(courtsRaw);
      if (count === null) {
        return {
          error: `"${courtsRaw}" isn't a valid court list - use numbers and/or ranges separated by commas, e.g. 13-18 or 1, 2, 5-8`,
        };
      }
      details.courts = { raw: courtsRaw, count };
    }
  }

  if (segs.length > 2) {
    details.time = segs[2] === '' ? null : segs[2];
  }

  return { details };
}

// Detects a LEADING standalone "paid" keyword at the START of !in/!out's
// argument text, e.g. "!in paid" (yourself) or "!in paid Grace, Henry" (a
// comma list, all of whom just got confirmed paid too) - lets someone
// join/leave the list and settle what they owe in the same message
// instead of sending !in (or !out) and !paid separately. Only strips a
// whole leading word "paid" (\b on both sides), followed by a comma,
// whitespace, or nothing at all - a name that merely STARTS with "paid" as
// part of a longer word (e.g. someone actually named "Paidence") is left
// alone, since \b requires a real word break rather than a substring
// match. Returns { rest, paid }: `rest` is argText with the leading
// "paid" keyword (and its separator) removed, ready to hand to
// parseNames() exactly as before; `paid` is true if the keyword was found.
function stripLeadingPaidKeyword(argText) {
  const trimmed = (argText || '').trim();
  if (!trimmed) return { rest: '', paid: false };
  const match = trimmed.match(/^\bpaid\b[\s,]*(.*)$/i);
  if (!match) return { rest: trimmed, paid: false };
  return { rest: match[1].trim(), paid: true };
}

// Like stripLeadingPaidKeyword above, but for !in specifically, which
// recognizes TWO independent leading keywords - "paid" (see above) and
// "tournament" (opt into the group's tournament sub-feature at the same
// time as joining - see store.js's addEntry()/joinTournament() and
// commands/admin.js's !settournament) - in EITHER order, e.g. "!in paid
// tournament Grace, Henry", "!in tournament paid Grace, Henry", or either alone.
// A single stripLeadingPaidKeyword-style call only ever strips ONE keyword
// off the very front, so it can't handle "tournament" coming after "paid"
// was already stripped off first (that leaves "tournament" as the new
// start-of-string, which a second, independent strip handles fine) - hence
// the small loop below, which just keeps trying both keywords against
// whatever's currently at the front until neither matches anymore, rather
// than assuming a fixed order.
//
// Only used by handleIn (commands/list.js) - !out doesn't take a
// "tournament" keyword, since leaving removes the whole entry (tournament
// flag included) regardless.
//
// Returns { rest, paid, tournament }: `rest` is argText with both
// keywords (and their separators) removed, ready to hand to parseNames()
// exactly as stripLeadingPaidKeyword's `rest` would be; `paid`/
// `tournament` are true if that keyword was found (in any order, any
// number of times - though realistically at most once each).
function stripLeadingInKeywords(argText) {
  let rest = (argText || '').trim();
  let paid = false;
  let tournament = false;
  let strippedSomething = true;
  while (strippedSomething) {
    strippedSomething = false;
    const paidMatch = rest.match(/^\bpaid\b[\s,]*(.*)$/i);
    if (paidMatch) {
      rest = paidMatch[1].trim();
      paid = true;
      strippedSomething = true;
      continue;
    }
    const tournamentMatch = rest.match(/^\btournament\b[\s,]*(.*)$/i);
    if (tournamentMatch) {
      rest = tournamentMatch[1].trim();
      tournament = true;
      strippedSomething = true;
    }
  }
  return { rest, paid, tournament };
}

// Detects a LEADING "add" or "extra" keyword on !courts' argText, e.g.
// "!courts add 1" or "!courts extra 12-14" - lets an admin ADD to the
// courts already booked instead of replacing them outright (see
// store.js's addCourts()), same idea as stripLeadingInKeywords above but
// for a single flag with two accepted spellings rather than two
// independent flags. Both words are recognized as synonyms specifically
// because natural-language phrasing (via the AI command feature - see
// lib/geminiCommand.js) is just as likely to say "I got extra courts
// 12-14" as "add courts 12-14"; the bot doesn't need to distinguish them,
// just recognize either as "merge, don't replace." Only strips ONE match
// at the front (unlike stripLeadingInKeywords' loop) - there's only one
// flag here, so nothing to keep looping for.
//
// Returns { rest, additive }: `rest` is argText with the leading keyword
// (and its separator) removed, ready to hand to setCourts()/addCourts()
// exactly as the raw argText would be; `additive` is true if either
// keyword was found (and therefore addCourts() should be used instead of
// setCourts()).
function stripLeadingCourtsAddKeyword(argText) {
  const trimmed = (argText || '').trim();
  if (!trimmed) return { rest: '', additive: false };
  const match = trimmed.match(/^\b(?:add|extra)\b[\s,]*(.*)$/i);
  if (!match) return { rest: trimmed, additive: false };
  return { rest: match[1].trim(), additive: true };
}

// Detects a trailing " with <names>" clause on !newlist's argText (the
// text after the DD/MM date has already been split off - see
// commands/admin.js's handleNewlist), letting an admin pre-populate a
// brand new list with specific people in the very same command that
// creates it, e.g. "!newlist 20/08 EBC | 13-18 | 8PM start with Alice,
// Bob, Carla" or, with no location/courts/time mentioned at all, just
// "!newlist 20/08 with Alice, Bob, Carla".
//
// Deliberately a SEPARATE keyword clause rather than a 4th "|"-delimited
// segment tacked onto parseNewListDetails: that function's existing
// pipe segments treat an EMPTY segment as "explicitly clear this field"
// (see its own doc comment/tests) - reusing the same "|" delimiter for
// names would make "20/08 | | | Alice, Bob" (admin didn't mention
// location/courts/time at all) silently wipe out whatever location/
// courts/time carried forward from the previous list, which isn't what
// "I didn't mention it" should mean. A distinct " with " keyword sidesteps
// that collision entirely, and is looked for by splitting on the FIRST
// standalone whole-word "with" (word-boundaried both sides, same \b
// technique as stripLeadingPaidKeyword's "paid" detection above) -
// BEFORE parseNewListDetails's pipe-segment parsing ever runs, so that
// function doesn't need to know anything about this clause.
//
// Caveat: a location/time value that itself legitimately contains the
// standalone word "with" (e.g. a time of "8PM with warmup at 7:30") would
// be misread as the start of the names clause - rare enough in practice
// that this isn't specially guarded against, the same tradeoff
// stripLeadingPaidKeyword already makes for a name that happens to
// contain "paid" as a substring (see its own caveat above).
//
// Returns { rest, namesText }: `rest` is the location/courts/time portion
// with the "with ..." clause (if any) removed, ready to hand to
// parseNewListDetails exactly as before; `namesText` is the raw
// comma-separated text after "with" (not yet split into individual
// names - see commands/admin.js's handleNewlist for that), or null if
// there was no such clause.
function stripTrailingWithNames(argText) {
  const trimmed = (argText || '').trim();
  if (!trimmed) return { rest: '', namesText: null };
  const match = trimmed.match(/^(.*?)\bwith\b\s+(.+)$/i);
  if (!match) return { rest: trimmed, namesText: null };
  const namesText = match[2].trim();
  return { rest: match[1].trim(), namesText: namesText || null };
}

function getMessageText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

// The WhatsApp JIDs (e.g. "1234567890@s.whatsapp.net") @-mentioned in
// `msg`, if any - powers the natural-language command feature (see
// lib/geminiCommand.js and index.js): only messages that @-mention the
// bot's own JID are ever considered for that. WhatsApp/Baileys only
// carries mention data on extendedTextMessage (a plain `conversation`
// message can't have mentions at all - typing "@" in the WhatsApp app is
// what causes the client to send an extendedTextMessage with contextInfo
// instead), so a plain-text message with no mentions correctly returns [].
function getMentionedJids(msg) {
  const m = msg.message;
  if (!m) return [];
  return m.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

// The WhatsApp JID that SENT the message `msg` is replying to (via
// WhatsApp's own "Reply" feature, i.e. a quoted message), or null if `msg`
// isn't a reply at all. Same extendedTextMessage/contextInfo carrier as
// getMentionedJids() above (a plain `conversation` message can't quote
// anything either), but a different field: `participant` here names the
// ORIGINAL sender being quoted, not anyone @-mentioned in the reply's own
// text - a reply carries no mention token of its own unless the replier
// also typed an explicit "@something". Powers index.js's
// messageMentionsBot(), which treats replying to one of the bot's own
// messages the same as @-mentioning it - so following up on the bot's
// reply with a plain "remove me", no "@Snoopy" typed at all, still works.
function getQuotedParticipant(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.extendedTextMessage?.contextInfo?.participant || null;
}

// The TEXT of the message `msg` is replying to (via WhatsApp's "Reply"
// feature), or '' if `msg` isn't a reply, or the quoted message had no
// text of its own. Same `contextInfo` carrier as getQuotedParticipant()
// above (that gets WHO sent the quoted message; this gets WHAT it said) -
// `contextInfo.quotedMessage` is a full message object in its own right,
// same shape as the top-level `message` getMessageText() reads, so this
// mirrors that function's exact field-priority logic against the nested
// object instead. Powers the natural-language command feature
// (lib/geminiCommand.js's `priorBotMessage` context, via index.js's
// handleAiMention): when someone replies to one of the bot's OWN
// messages, this lets the model see what it actually asked, rather than
// re-interpreting a bare "the list" or "yes" completely cold.
function getQuotedMessageText(msg) {
  const m = msg.message;
  const quoted = m?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return '';
  return (
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    ''
  );
}

// Strips every "@<number>" mention token (matched against `mentionedJids`,
// e.g. from getMentionedJids() above) out of `text` - used before handing
// a message off to Gemini for natural-language interpretation (see
// lib/geminiCommand.js), so it sees "put me down for Saturday" rather
// than "@61412345678 put me down for Saturday". The raw WhatsApp text for
// an @-mention is literally "@" followed by the mentioned person's phone
// number (not their display name), which the model has no way to
// otherwise know is just an address token rather than meaningful content.
//
// Also used by index.js's handleAiMention as the REAL argText for an
// "update" action, bypassing whatever the model itself returned (see that
// call site's doc comment for why) - which means this function's output
// has to stay byte-for-byte line-structure-faithful to the original
// message, since lib/listParser.js's parseListSections() splits a pasted
// list on LINE breaks to find its *Attendance*/*Waitlist*/numbered-entry
// structure. Only collapses runs of spaces/tabs (the double-space a
// removed mention token can leave behind, e.g. "hello  how are you") and
// trims stray horizontal whitespace hugging a line break - it deliberately
// does NOT collapse newlines themselves the way a single blanket `\s+` ->
// `' '` replace previously did (a real bug: that turned an entire
// multi-line pasted list into one giant line, which no longer matched any
// of parseListSections's per-line header/entry patterns at all).
function stripMentionTokens(text, mentionedJids) {
  let cleaned = text || '';
  for (const jid of mentionedJids || []) {
    const number = jid.split('@')[0].split(':')[0];
    if (!number) continue;
    cleaned = cleaned.replace(new RegExp(`@${number}\\b`, 'g'), ' ');
  }
  cleaned = cleaned.replace(/[ \t]+/g, ' '); // collapse horizontal whitespace only
  cleaned = cleaned.replace(/[ \t]*\n[ \t]*/g, '\n'); // trim spaces hugging a line break
  return cleaned.trim();
}

// Normalizes a WhatsApp JID by stripping any device-id suffix (the
// ":12" in "1234567890:12@s.whatsapp.net") so JIDs from different
// sources compare equal regardless of whether they include one - Baileys'
// own sock.user.id includes a device suffix, but mentionedJid entries
// (and most other JIDs elsewhere in this codebase) never do.
function normalizeJid(jid) {
  if (!jid) return jid;
  return jid.replace(/:\d+(?=@)/, '');
}

// Date, then whichever of location/courts/time are set, each on their own
// line, e.g.:
//   20th Aug Thu
//   EBC
//   Courts 13-18 (6)
//   8PM start
// Location/courts/time are each omitted entirely if unset (e.g. a
// brand-new group that hasn't run !newlist/!location/!courts/!time yet),
// so a group that's only set a date gets just the date line.
function formatEventHeader(event) {
  const lines = [event.date ? formatDisplayDate(event.date) : 'No date set'];
  if (event.location) lines.push(event.location);
  if (event.courts) lines.push(`Courts ${event.courts} (${event.courtCount})`);
  if (event.time) lines.push(event.time);
  return lines.join('\n');
}

// "(8)" normally, or "(8/20)" once a !limit is set - so capacity is visible
// at a glance without having to run !limit separately.
function formatCount(count, limit) {
  return limit ? `(${count}/${limit})` : `(${count})`;
}

// Renders a millisecond duration as a compact "Xd Yh" / "Xh Ym" / "Xm"
// string for !stale, e.g. 90000000 -> "1d 1h". Always at least "0m" so a
// just-now warning doesn't render as an empty string.
function formatElapsed(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Builds a tagged "you're off the waitlist" notice for entries that just
// got promoted, so WhatsApp actually pings each person instead of just
// listing their name as plain text. Tags whoever ADDED the entry
// (entry.addedBy) - for a self-added entry that's the same person the
// entry is about, so the tag lands on the right person. For an entry an
// admin added on someone else's behalf, the bot has no way to know that
// other person's WhatsApp ID (they never messaged the bot themselves, so
// their ID was never captured) - the tag falls back to the admin who added
// it rather than silently tagging nobody, but that IS a known limitation
// worth knowing about (see the README's waitlist section).
// Returns null (nothing to send) if `promotedEntries` is empty - callers
// should check that themselves before calling, but this is a safe no-op
// either way.
function formatPromotedMessage(promotedEntries) {
  if (!promotedEntries || !promotedEntries.length) return null;
  const lines = promotedEntries.map((e) => `@${e.addedBy.split('@')[0]} — ${e.name}`);
  return {
    text: `Off the waitlist — you're in! 🎉 Told you it'd work out.\n${lines.join('\n')}`,
    mentions: promotedEntries.map((e) => e.addedBy),
  };
}

// Same idea as formatPromotedMessage() above, but for entries auto-promoted
// off the (🏆 WL) tournament queue (see store.js's
// promoteFromTournamentWaitlist()) rather than the main attendance
// waitlist - worded separately since "off the waitlist" alone would be
// ambiguous about which one now that there are two. Returns null (nothing
// to send) for an empty/missing list.
function formatTournamentPromotedMessage(promotedEntries) {
  if (!promotedEntries || !promotedEntries.length) return null;
  const lines = promotedEntries.map((e) => `@${e.addedBy.split('@')[0]} — ${e.name}`);
  return {
    text: `🏆 A tournament spot opened up — you're in! Go get 'em.\n${lines.join('\n')}`,
    mentions: promotedEntries.map((e) => e.addedBy),
  };
}

// Renders one attendance entry as its numbered line, e.g. "3. Alice" -
// shared by formatList()'s plain and tournament-aware Attendance rendering
// below, and by formatTournamentRoster() (also below).
function formatEntryLine(entry, number) {
  return `${number}. ${entry.name}`;
}

// Renders JUST the "🏆 Tournament (n/limit)" block (header, a pointer to
// ask the bot for the rules text, plus numbered roster - no
// Attendance/waitlist/payment context around it) - shared by formatList()
// below (embedded inside its Attendance section) and by
// commands/admin.js's handleSettournament (the standalone !settournament
// info view), so both places number/format the tournament roster
// identically. Names are NOT hidden here - the roster stays fully visible
// and numbered exactly as before; only the header text and the added
// pointer line changed when !tournament was repurposed as the rules-view
// command (see commands/admin.js's handleTournament/handleSettournament
// doc comments). `startNumber` lets formatList() continue Attendance's own
// numbering (tournament players are numbered 1.. from the top of
// Attendance, not restarted at 1) while handleSettournament's standalone
// view always starts at 1 - see call sites.
function formatTournamentRoster(tournamentEntries, limit, startNumber = 1) {
  const header = `🏆 *Tournament* ${formatCount(tournamentEntries.length, limit)}\nAsk @Snoopy for details`;
  if (!tournamentEntries.length) return `${header}\n\n(none yet)`;
  const lines = tournamentEntries.map((entry, i) => formatEntryLine(entry, startNumber + i));
  return `${header}\n\n${lines.join('\n')}`;
}

// Groups+orders a raw duePayments array exactly the way formatList()'s
// Payment section renders it below: an undated group first (if any), then
// one group per owedSince date, most-recently-owed first - each numbered
// from 1 within its own group. Factored out so a numeric shorthand like
// "!paid 7" (see resolveDuePaymentNumber below) can resolve against the
// EXACT same numbers a reader sees in the posted list, not a
// hand-maintained second copy of this ordering that could quietly drift
// out of sync with it.
function groupDuePayments(due) {
  const noDateGroup = due.filter((entry) => !entry.owedSince);
  const datedGroups = new Map(); // isoDate -> entries[], insertion order == first-seen order
  for (const entry of due) {
    if (!entry.owedSince) continue;
    if (!datedGroups.has(entry.owedSince)) datedGroups.set(entry.owedSince, []);
    datedGroups.get(entry.owedSince).push(entry);
  }
  const sortedDates = [...datedGroups.keys()].sort().reverse();

  const groups = [];
  if (noDateGroup.length) groups.push({ heading: 'No date', entries: noDateGroup });
  for (const isoDate of sortedDates) {
    groups.push({ heading: formatDisplayDate(isoDate), entries: datedGroups.get(isoDate) });
  }
  return groups;
}

// Resolves a bare number (as typed in e.g. "!paid 7") against the payment
// section's OWN printed numbering (groupDuePayments above) - the same
// numbers a reader actually sees in the posted list. Returns the matching
// entry, or null for either "no group has an entry N" (out of range) or
// "more than one date group has an entry N" (the printed list itself has
// two different lines both starting "N." - no way to tell which was
// meant without asking) - callers treat both the same way a nonexistent
// name already is, rather than guessing.
function resolveDuePaymentNumber(due, number) {
  const groups = groupDuePayments(due);
  const matches = [];
  for (const group of groups) {
    if (number >= 1 && number <= group.entries.length) matches.push(group.entries[number - 1]);
  }
  return matches.length === 1 ? matches[0] : null;
}

// Returns event.entries in the exact order/numbering formatList()'s
// Attendance section displays them in when the tournament sub-feature is
// on: tournament opt-ins first, then anyone waitlisted for the
// tournament, then everyone else - one continuous numbered sequence
// rather than resetting per group (see formatList()'s own comment for
// the full reasoning). Just `entries` in plain join order when
// tournament mode is off. Factored out so a numeric shorthand like
// "!out 7" (see resolveAttendanceOrWaitlistNumber below) can resolve
// against the SAME numbers a reader sees - formatList() itself reuses
// this too, so the two can never drift apart.
function getAttendanceDisplayOrder(event) {
  if (!event.tournamentEnabled) return event.entries;
  return [
    ...event.entries.filter((entry) => entry.tournament),
    ...event.entries.filter((entry) => !entry.tournament && entry.tournamentWaitlisted),
    ...event.entries.filter((entry) => !entry.tournament && !entry.tournamentWaitlisted),
  ];
}

// Resolves a bare number (as typed in e.g. "!out 7") against the
// Attendance list's own printed numbering (getAttendanceDisplayOrder
// above) OR the Waitlist's (a separate section, numbered independently
// from 1) - whichever ONE of the two has an entry at that position.
// Returns null for either "neither does" (out of range) or "both do"
// (ambiguous - Attendance and Waitlist are numbered independently, so
// the same number can be two different people depending on which
// section was meant) - callers fall back to an ordinary name lookup
// (which then fails the normal "not on the list" way) rather than
// guessing which section was intended.
function resolveAttendanceOrWaitlistNumber(event, number) {
  const attendanceOrder = getAttendanceDisplayOrder(event);
  const waitlist = event.waitlist || [];
  const inAttendance = number >= 1 && number <= attendanceOrder.length ? attendanceOrder[number - 1] : null;
  const inWaitlist = number >= 1 && number <= waitlist.length ? waitlist[number - 1] : null;
  if (inAttendance && inWaitlist) return null;
  return inAttendance || inWaitlist;
}

// Always reads fresh from the store, so it reflects whatever the most
// recent add/remove/clear/newlist/paid call just wrote - callers don't need
// to thread list state through themselves.
function formatList(groupId) {
  const event = getCurrentEvent(groupId);
  const sections = [];

  sections.push(formatEventHeader(event));

  // Winners banner (see store.js's tournamentWinners/setTournamentWinners
  // and commands/admin.js's !tournamentwinners) - shown right above the
  // divider that leads into Attendance, so it reads as a pinned
  // announcement right before the list itself. Only shown while the
  // tournament sub-feature itself is still on - if an admin turns it off,
  // the banner (and the rest of the tournament UI below) goes quiet along
  // with it, even though the winners themselves are still remembered
  // underneath in case it's turned back on.
  if (event.tournamentEnabled && event.tournamentWinners && event.tournamentWinners.length === 2) {
    const [winner1, winner2] = event.tournamentWinners;
    sections.push(`🎉 *Congrats to ${winner1} and ${winner2} for winning last week's tournament*`);
  }

  // Built into a local variable rather than pushed straight into `sections`
  // so the SECTION_DIVIDER below can be prefixed onto it uniformly - same
  // divider treatment the payment section gets further down, so Attendance
  // is visually set apart from whatever's above it (the header, and the
  // winners banner when present) every time, not just in some branches.
  let attendanceSection;
  if (!event.entries.length && !event.tournamentEnabled) {
    const limitNote = event.limit ? `, limit ${event.limit}` : '';
    attendanceSection = `*Attendance*\n\n(empty${limitNote} - @Snoopy to add your name)`;
  } else if (event.tournamentEnabled) {
    // Split Attendance into its tournament opt-ins (numbered first, from
    // the top) and everyone else ("Social only", numbering continuing on
    // from where the tournament roster left off) - see the format this
    // mirrors in commands/admin.js's !settournament doc comment. Relative
    // order within each group is preserved from `entries` itself (the
    // order people actually joined in), just partitioned by
    // `entry.tournament` for display - the underlying array/order used for
    // removal/promotion/etc. elsewhere is untouched. Anyone under "Social
    // only" who asked for the tournament but couldn't fit gets a "(🏆 WL)"
    // tag (see store.js's `entry.tournamentWaitlisted` and its
    // addEntry()/joinTournament()/promoteFromTournamentWaitlist() doc
    // comments) AND is listed first within "Social only", ahead of anyone
    // who never asked - that ordering (front of the group = front of the
    // queue) IS the tournament waitlist; there's no separate array behind
    // it. Order among the tagged entries themselves is preserved from
    // `entries` (first come, first served), matching the FIFO order
    // promoteFromTournamentWaitlist() promotes them in.
    //
    // Both the "🏆 Tournament" and "Social only" headers are ALWAYS
    // shown while the tournament is on - even with zero entries overall
    // (a brand new list, nobody's joined at all yet) or zero entries in
    // just one of the two sections (e.g. everyone who's joined so far
    // opted into the tournament, nobody's social-only yet) - each empty
    // section gets a "(none yet)" placeholder line instead of vanishing,
    // same idea as formatTournamentRoster()'s own empty-roster handling
    // (used here for the tournament half), so the breakdown's shape stays
    // visually consistent and predictable regardless of who's joined so
    // far, rather than the section headers themselves coming and going.
    const displayOrder = getAttendanceDisplayOrder(event);
    const tournamentEntries = displayOrder.filter((entry) => entry.tournament);
    const socialOnlyEntries = displayOrder.filter((entry) => !entry.tournament);
    const tournamentBlock = formatTournamentRoster(tournamentEntries, event.tournamentLimit, 1);
    const socialLines = socialOnlyEntries.length
      ? socialOnlyEntries.map(
          (entry, i) => formatEntryLine(entry, tournamentEntries.length + 1 + i) + (entry.tournamentWaitlisted ? ' (🏆 WL)' : '')
        ).join('\n')
      : '(none yet)';
    const socialBlock = `Social only\n\n${socialLines}`;
    const body = `${tournamentBlock}\n\n${socialBlock}`;
    attendanceSection = `*Attendance* ${formatCount(event.entries.length, event.limit)}\n\n${body}`;
  } else {
    const lines = event.entries.map((entry, i) => formatEntryLine(entry, i + 1));
    attendanceSection = `*Attendance* ${formatCount(event.entries.length, event.limit)}\n\n${lines.join('\n')}`;
  }
  sections.push(`${SECTION_DIVIDER}\n${attendanceSection}`);

  const waitlist = event.waitlist || [];
  if (waitlist.length) {
    const waitLines = waitlist.map((entry, i) => formatEntryLine(entry, i + 1));
    sections.push(`*Waitlist* (${waitlist.length})\n\n${waitLines.join('\n')}`);
  }

  const due = event.duePayments || [];
  if (due.length) {
    const label = event.duePaymentsLabel || PAYMENT_LABEL;
    // Grouped by `owedSince` (store.js's newList()) - the date of the OLD
    // list each entry's debt is actually for - so a reader can see at a
    // glance who owes for which cycle instead of scanning each name's own
    // tag one at a time. Each group is a bold date header line (dates.js's
    // formatDisplayDate(), e.g. "20th Aug Thu") followed by that group's
    // names, renumbered from 1; dated groups are sorted MOST RECENT first
    // (the freshest debt at the top, the longest-overdue one at the
    // bottom). An entry with no owedSince at all - predates this feature,
    // or was added straight into the payment section by hand via !update
    // rather than carried over automatically - gets its own "No date"
    // group, placed BEFORE every dated group regardless of this ordering
    // (same wording as the "No date set" header line used when the event
    // itself has no date - see NO_DATE_SET_LINE in lib/listParser.js).
    // Bolding these is safe for listParser.js's parseListSections()
    // (powering !update) even though a bold-only line is what it looks for
    // to START the payment section: by the time one of these date headers
    // is reached, the REAL `*${label}*` line above has already put the
    // parser into the payment section, so a bold date header just
    // re-confirms that (harmless) rather than being mistaken for anything
    // else. (Older, already-sent messages may still show the previous
    // inline "Name (9th Aug Sun)" format - see OWED_SINCE_SUFFIX in
    // lib/listParser.js, kept around so pasting one of those back still
    // round-trips correctly.)
    const groupBlocks = groupDuePayments(due).map(
      ({ heading, entries }) => `*${heading}*\n${entries.map((entry, i) => `${i + 1}. ${entry.name}`).join('\n')}`
    );

    // Plain (unbolded) divider line, just to visually separate the payment
    // section from whatever's above it (Attendance and/or Waitlist) -
    // deliberately not wrapped in asterisks, since a bold-only line after
    // *Attendance* is what listParser.js's parseListSections() (powering
    // !update) takes as the start of the payment section; a plain divider
    // is silently skipped there like any other stray text instead, so the
    // REAL payment header (the fixed `*Payment*` line right after it) is
    // still what actually triggers that detection.
    //
    // The header itself is always the fixed, bold word "*Payment*" -
    // matching *Attendance*/*Waitlist*'s own styling - with the actual
    // (possibly !paymentlabel-customized) label directly underneath it,
    // unbolded, no blank line in between. Omitted entirely when the label
    // is just the unmodified default ("Payment" itself - see PAYMENT_LABEL
    // in lib/config.js), so an admin who's never run !paymentlabel doesn't
    // see the word "Payment" printed twice in a row. Plain text either way
    // (not bold, unlike the header above it) so listParser.js's
    // parseListSections() never mistakes it for one of the group headers
    // right below it - it's simply read past as stray text, same as the
    // divider.
    const labelLine = label === 'Payment' ? '' : `\n${label}`;
    sections.push(`${SECTION_DIVIDER}\n*Payment*${labelLine}\n\n${groupBlocks.join('\n\n')}`);
  }

  return sections.join('\n\n');
}

module.exports = {
  parseNames,
  PLUS_N_TOKEN,
  ME_TOKEN,
  REGULAR_PLAYERS_TOKEN,
  expandRegularPlayersToken,
  maxNamesReply,
  stripLeadingPaidKeyword,
  stripLeadingInKeywords,
  stripLeadingCourtsAddKeyword,
  stripTrailingWithNames,
  parseNewListDetails,
  getMessageText,
  getMentionedJids,
  getQuotedParticipant,
  getQuotedMessageText,
  stripMentionTokens,
  normalizeJid,
  formatEventHeader,
  formatCount,
  formatElapsed,
  formatPromotedMessage,
  formatTournamentPromotedMessage,
  formatEntryLine,
  formatTournamentRoster,
  formatList,
  groupDuePayments,
  resolveDuePaymentNumber,
  resolveAttendanceOrWaitlistNumber,
};