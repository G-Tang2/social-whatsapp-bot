// lib/listParser.js
// Parses the *Attendance*/*Waitlist*/payment-section name lists back out of
// a copy-pasted (and possibly hand-edited) list message - the exact text
// formatList() (lib/helpers.js) produces. Powers !update (see
// commands/admin.js's handleUpdate), which lets an admin bulk-edit the
// roster by copying the bot's own last posted list, editing it, and
// sending it back - instead of issuing a long run of individual
// !in/!out/!paid commands one at a time.
//
// Deliberately tolerant: anything that isn't a recognized section header or
// a numbered "N. Name" line - stray commentary, a note to the group, a
// repeated quote header, emoji, blank lines, whatever - is silently
// skipped rather than causing a parse error. This is what lets an admin
// freely add "extra text blocks" anywhere in the pasted message without it
// breaking the parse - the parser only ever reacts to lines that look like
// one of the three section headers or a numbered entry.
//
// Also captures (but doesn't itself interpret) the header block above
// *Attendance* - date/location/courts/time, in whatever hand-edited state
// the admin pasted back - as parseListSections' `headerLines` return
// value; see parseHeaderFields() further down, which DOES interpret it
// and is what actually lets !update (commands/admin.js's handleUpdate)
// apply changes to those fields, in addition to the three name lists.

const { parseDisplayDateForUpdate } = require('../dates');

const ATTENDANCE_HEADER = /^\*Attendance\*/i;
const WAITLIST_HEADER = /^\*Waitlist\*/i;
// The divider line formatList() (lib/helpers.js's SECTION_DIVIDER) prints
// directly above *Attendance* - matched structurally (a run of the
// box-drawing dash character) rather than the exact literal, so it's robust
// to length tweaks. Excluded from headerLines below the same way the
// winners banner is, so it never gets mistaken for a location/time value.
const HEADER_DIVIDER_LINE = /^─+$/;
// The "🎉 *Congrats to X and Y...*" tournament-winners banner formatList()
// prints above that divider when winners are set - excluded from
// headerLines below (see parseListSections) so parseHeaderFields() never
// mistakes it for a location/time freeform value; it isn't a header field
// !update can edit, it's set separately via !tournamentwinners.
const TOURNAMENT_WINNERS_BANNER = /^🎉\s*\*Congrats to .+ for winning last week's tournament\*$/;
// The "🏆 *Tournament*" sub-header formatList() prints INSIDE the
// Attendance section while the tournament sub-feature is on (see
// lib/helpers.js's formatList()/formatTournamentRoster()) - only
// recognized while already inside 'attendance' (see parseListSections
// below), so it can't be confused with a genuine *Attendance*/*Waitlist*
// section header. Also still matches the older "🏆 *Tournament players*"
// wording (pre-!settournament split) so a list copy-pasted from before
// that rename still round-trips through !update. The "type !tournament
// for details" pointer line formatTournamentRoster() now prints right
// after this header isn't numbered and doesn't match anything else below,
// so it's silently skipped as stray text same as any other non-matching
// line - no special handling needed for it here.
const TOURNAMENT_HEADER = /^🏆\s*\*Tournament(?:\s+players)?\*/;
// The bare (non-bold) "Social only" heading formatList() prints right
// after the tournament roster - only recognized once TOURNAMENT_HEADER has
// already been seen within the current Attendance section (see
// parseListSections), so an unrelated line that happens to say "social
// only" in ordinary chat text never triggers it.
const SOCIAL_ONLY_HEADER = /^Social only\b/i;
// A bold-only line ("*whatever*", nothing else on it) seen AFTER
// *Attendance* has already been found is treated as the payment section
// starting - whatever its !paymentlabel text happens to be. The payment
// section's header is a user-configurable label, not fixed text, so it
// can't be matched literally the way *Attendance*/*Waitlist* can; this
// structural rule (bold header, third one found, comes last) is what
// formatList() always produces instead.
const BOLD_ONLY_LINE = /^\*(.+)\*$/;
const NUMBERED_LINE = /^\d+\.\s*(.+?)\s*$/;
// Matches the "(TBC)" flag formatList() appends to a name (lib/helpers.js) -
// renamed from "(TBD)"; kept as its own named constant (rather than inlined)
// since it has to stay in lockstep with whatever formatList() actually
// prints, or a copy-pasted !update would stop recognizing the tag and treat
// it as literal trailing text in the name instead.
const TBC_SUFFIX = /\s*\(TBC\)\s*$/i;
// Matches the "(🏆 WL)" flag formatList() appends to a Social-only entry
// that's queued for the tournament (see lib/helpers.js's formatList() and
// store.js's entry.tournamentWaitlisted). Same reasoning as TBC_SUFFIX -
// has to stay in lockstep with formatList()'s own output, or a copy-pasted
// !update would treat "Bao (🏆 WL)" as a literal (and different) name
// instead of recognizing and stripping the tag - which is exactly what
// used to happen before this was added: the WL-tagged entry would get
// dropped and replaced with a garbage-named new one on every round-trip.
// Always the LAST thing formatList() appends (after any "(TBC)"), so it's
// stripped first, before TBC_SUFFIX - see parseEntryLine below.
const TOURNAMENT_WL_SUFFIX = /\s*\(🏆 WL\)\s*$/;
// Matches the "(9th Aug Sun)"-style owed-since date tag that an OLDER
// version of formatList() used to append inline to a payment-due name.
// formatList() no longer produces this shape itself - the payment section
// now groups names under a separate plain-text date header line instead
// (see formatList() in lib/helpers.js, and parseListSections() below,
// which doesn't need to do anything special to skip those header lines -
// they're not numbered "N. Name" lines, so they just fall through the
// generic stray-text tolerance). This stays purely for backward
// compatibility: a name copied from a list the bot posted before that
// change (still sitting in someone's chat history) still round-trips
// through !update correctly instead of "Alex (9th Aug Sun)" being treated
// as a literal (and different) name. Deliberately this specific/narrow (not
// just "any trailing parenthetical") so a name that genuinely happens to
// end in parentheses for some other reason isn't mistaken for this tag and
// silently mangled - has to stay in lockstep with dates.js's
// formatDisplayDate() output shape (ordinal day, 3-letter month, 3-letter
// weekday) even though nothing currently prints it inline anymore.
// !update never tried to preserve/re-derive owedSince from the pasted text
// either way (same as TBC's tbd flag) - a kept payment entry carries its
// ORIGINAL owedSince forward regardless of what text sits next to it (see
// store.js's applyListUpdate), and a brand-new payment name typed fresh via
// !update simply has no owedSince at all (there's no "old list" to
// attribute it to) - so the value itself is never read back out here, only
// stripped so it doesn't pollute the name.
const OWED_SINCE_SUFFIX = /\s*\(\d{1,2}(?:st|nd|rd|th) [A-Za-z]{3} [A-Za-z]{3}\)\s*$/;

// Strips a numbered entry's leading "N. " (already removed by NUMBERED_LINE
// before this runs) and any trailing "(TBC)"/"(🏆 WL)"/owed-since-date
// flags, returning { name, tournamentWaitlisted }. !update doesn't try to
// preserve TBC status from the pasted text either way (see store.js's
// applyListUpdate for why: a name kept from the current list keeps its
// ORIGINAL tbd/addedBy/addedByIsAdmin/owedSince metadata regardless of
// whether "(TBC)" (or the owed-since date) still appears next to it in the
// edited text - see that file for why the internal field is still named
// `tbd`, only the user-facing label changed) - but tournamentWaitlisted IS
// read back out and used (see parseListSections' tournamentWaitlistedNames
// below and store.js's applyListUpdate), since unlike TBC it isn't derived
// from anything else in the update; the tag itself is the only place that
// status appears in the pasted text at all.
function parseEntryLine(raw) {
  let text = raw;
  let tournamentWaitlisted = false;
  if (TOURNAMENT_WL_SUFFIX.test(text)) {
    tournamentWaitlisted = true;
    text = text.replace(TOURNAMENT_WL_SUFFIX, '');
  }
  text = text.replace(TBC_SUFFIX, '');
  text = text.replace(OWED_SINCE_SUFFIX, '');
  return { name: text.trim(), tournamentWaitlisted };
}

// Returns { attendance, waitlist, duePayments, sectionsFound,
// tournamentPlayers, tournamentWaitlistedNames }:
//  - attendance/waitlist/duePayments: string[], each section's names in
//    the order they appeared in the text, numbering and any trailing
//    "(TBC)"/"(🏆 WL)" flags stripped. `attendance` includes EVERY name
//    under the Attendance header regardless of tournament/social-only
//    sub-placement (unchanged from before tournament-awareness existed) -
//    it's tournamentPlayers below that carries the sub-placement itself.
//  - sectionsFound: how many of the three section headers were actually
//    located, so callers can tell "found nothing recognizable at all" (0)
//    from "found some sections, they just happened to be empty or omit
//    one" (>0).
//  - tournamentPlayers: null if the "🏆 Tournament players" sub-header was
//    never seen at all in the text (a plain, non-tournament-formatted
//    Attendance paste - callers should leave every entry's tournament
//    flags untouched in that case, see store.js's applyListUpdate), or the
//    (possibly empty) string[] of names listed under it otherwise - a
//    genuine [] means the header WAS present but nobody was listed
//    underneath, i.e. "nobody's in the tournament anymore."
//  - tournamentWaitlistedNames: string[] of Social-only names that carried
//    a "(🏆 WL)" tag, meaningful only when tournamentPlayers isn't null.
//  - headerLines: string[] of every non-blank line seen BEFORE the first
//    *Attendance*/*Waitlist* header was found (trimmed) - i.e. whatever
//    came above the pasted list proper. This is typically the
//    date/location/courts/time block formatList() itself prints (see
//    lib/helpers.js's formatEventHeader()), possibly hand-edited, but may
//    also have leading instruction text in front of it (e.g. an
//    @-mention's "update the list to be" line) or be empty entirely (a
//    plain !update with nothing pasted above *Attendance*). See
//    parseHeaderFields() below for how this gets interpreted.
function parseListSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const attendance = [];
  const waitlist = [];
  const duePayments = [];
  const headerLines = [];
  let section = null; // null | 'attendance' | 'waitlist' | 'payment'
  let sectionsFound = 0;

  let tournamentPlayers = null; // null | string[]
  const tournamentWaitlistedNames = [];
  let attendanceSubsection = null; // null | 'tournament' | 'social'

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue; // blank lines never start/end a section by themselves

    if (
      sectionsFound === 0
      && !ATTENDANCE_HEADER.test(line)
      && !WAITLIST_HEADER.test(line)
      && !HEADER_DIVIDER_LINE.test(line)
      && !TOURNAMENT_WINNERS_BANNER.test(line)
    ) {
      headerLines.push(line);
    }

    if (ATTENDANCE_HEADER.test(line)) {
      section = 'attendance';
      attendanceSubsection = null;
      sectionsFound += 1;
      continue;
    }
    if (WAITLIST_HEADER.test(line)) {
      section = 'waitlist';
      attendanceSubsection = null;
      sectionsFound += 1;
      continue;
    }
    if (section === 'attendance' && TOURNAMENT_HEADER.test(line)) {
      attendanceSubsection = 'tournament';
      if (tournamentPlayers === null) tournamentPlayers = [];
      continue;
    }
    if (section === 'attendance' && attendanceSubsection === 'tournament' && SOCIAL_ONLY_HEADER.test(line)) {
      attendanceSubsection = 'social';
      continue;
    }
    if (sectionsFound > 0 && BOLD_ONLY_LINE.test(line) && !NUMBERED_LINE.test(line)) {
      section = 'payment';
      attendanceSubsection = null;
      sectionsFound += 1;
      continue;
    }

    const numberedMatch = NUMBERED_LINE.exec(line);
    if (numberedMatch && section) {
      const { name, tournamentWaitlisted } = parseEntryLine(numberedMatch[1]);
      if (name) {
        if (section === 'attendance') {
          attendance.push(name);
          if (attendanceSubsection === 'tournament') {
            tournamentPlayers.push(name);
          } else if (tournamentWaitlisted) {
            tournamentWaitlistedNames.push(name);
          }
        } else if (section === 'waitlist') waitlist.push(name);
        else if (section === 'payment') duePayments.push(name);
      }
      continue;
    }

    // Anything else - the "(none yet)"/"(empty...)" placeholder lines,
    // stray commentary, a quoted header repeat, whatever - is silently
    // ignored. This is the tolerance that lets "extra text blocks"
    // coexist with the parse.
  }

  return { attendance, waitlist, duePayments, sectionsFound, tournamentPlayers, tournamentWaitlistedNames, headerLines };
}

const NO_DATE_SET_LINE = /^no date set$/i;
// Matches a "Courts <spec> (<count>)" line (see lib/helpers.js's
// formatEventHeader()) and captures just the <spec> part, e.g. "11-14" out
// of "Courts 11-14 (4)" - the "(<count>)" suffix (if a hand-edit even left
// it intact) is discarded, since setCourts() (store.js) recomputes
// courtCount itself from the spec, same as !courts does.
const COURTS_LINE = /^Courts\s+(.+?)\s*(?:\(\d+\))?\s*$/i;

// Reconstructs date/location/courts/time changes from `headerLines`
// (parseListSections' return value above) - the free-text lines !update
// found ABOVE the first recognized section header, i.e. a copy-pasted
// formatEventHeader() block, quite possibly hand-edited. See
// commands/admin.js's handleUpdate for how the returned changes actually
// get applied.
//
// Returns null if no header block was found at all - meaning !update
// should leave date/location/courts/time completely untouched, exactly as
// it did before this feature existed. This is what keeps a plain !update
// (just a name-list edit, nothing pasted above *Attendance*) - or one with
// unrelated commentary up there instead ("hey everyone, remember to pay up") -
// from accidentally clearing the header fields. Concretely: `headerLines`
// is scanned forward for the first line that's either "No date set" or
// parses via dates.js's parseDisplayDateForUpdate() (this also
// transparently skips past any leading instruction text before the real
// pasted block, e.g. an @-mention's own "update the list to be" line - see
// index.js's handleAiMention). If no such line exists anywhere in
// headerLines, there's no header block at all, and this returns null.
//
// The date line specifically is resolved against `currentEvent`'s OWN
// stored date, not just "whatever's next from today" - see
// parseDisplayDateForUpdate()'s own doc comment for why: the date printed
// in a posted list never includes a year, and re-deriving one purely from
// "today" would silently reinterpret an unedited, copied-back date line as
// a brand new one (bumping it a full year forward) the moment the list's
// actual date is no longer in the future relative to whenever the update
// happens to be sent - which is the ordinary case, not an edge case, for a
// list anywhere near its own date. A day/month that matches the current
// stored date is read as UNCHANGED and returns that exact stored value;
// only a genuine day/month difference is treated as an actual edit.
//
// Once a header block IS found, though, the edit is treated as final -
// same "your edit is the new truth" philosophy the roster-list side of
// !update already follows (see handleUpdate's own doc comment) - so any of
// the four fields that ISN'T present in the block comes back as an
// explicit CLEAR (null), not "leave alone." This mirrors exactly what
// formatEventHeader() itself does when posting a list: it omits a field's
// line entirely when that field is unset, so a header block that's
// missing (say) the time line is textually indistinguishable from "the
// time really was cleared" - and !update trusts the paste over guessing.
//
// Field detection, once the date line (see above) is located:
//  - COURTS is whichever later line matches COURTS_LINE above - matched
//    structurally by its distinctive "Courts " prefix, not by position.
//  - LOCATION/TIME are whatever's left (0, 1, or 2 lines), disambiguated
//    by POSITION relative to the courts line (or to each other, if
//    there's no courts line): formatEventHeader() always emits fields in
//    date/location/courts/time order, so whichever leftover line comes
//    first is location and whichever comes last is time. The one
//    genuinely ambiguous case is exactly one leftover line AND no courts
//    line to position it against (courts were never set, say) - there,
//    `currentEvent`'s own location/time presence is used as a tiebreak
//    hint (if exactly one of the two is currently set, the leftover line
//    is assumed to be an edit to THAT one); if that's ALSO ambiguous
//    (both or neither currently set), it defaults to location, since
//    that's the field formatEventHeader() would place first.
function parseHeaderFields(headerLines, currentEvent, referenceDate) {
  const lines = (headerLines || []).map((l) => String(l).trim()).filter(Boolean);

  let dateIdx = -1;
  let dateValue; // set below once found
  for (let i = 0; i < lines.length; i++) {
    if (NO_DATE_SET_LINE.test(lines[i])) {
      dateIdx = i;
      dateValue = null;
      break;
    }
    const resolved = parseDisplayDateForUpdate(lines[i], currentEvent && currentEvent.date, referenceDate);
    if (resolved) {
      dateIdx = i;
      dateValue = resolved;
      break;
    }
  }

  if (dateIdx === -1) return null; // no header block found at all - leave everything alone

  const rest = lines.slice(dateIdx + 1);

  let courtsIdx = -1;
  let courtsValue = null;
  for (let i = 0; i < rest.length; i++) {
    const m = COURTS_LINE.exec(rest[i]);
    if (m) {
      courtsIdx = i;
      courtsValue = m[1].trim();
      break;
    }
  }

  const freeform = [];
  for (let i = 0; i < rest.length; i++) {
    if (i === courtsIdx) continue;
    freeform.push({ text: rest[i], beforeCourts: courtsIdx === -1 ? null : i < courtsIdx });
  }

  let locationValue = null;
  let timeValue = null;

  if (courtsIdx !== -1) {
    const before = freeform.filter((f) => f.beforeCourts === true);
    const after = freeform.filter((f) => f.beforeCourts === false);
    if (before.length) locationValue = before[0].text;
    if (after.length) timeValue = after[0].text;
  } else if (freeform.length >= 2) {
    locationValue = freeform[0].text;
    timeValue = freeform[freeform.length - 1].text;
  } else if (freeform.length === 1) {
    const hasLocation = Boolean(currentEvent && currentEvent.location);
    const hasTime = Boolean(currentEvent && currentEvent.time);
    if (hasTime && !hasLocation) {
      timeValue = freeform[0].text;
    } else {
      // Default: location - covers both "neither currently set" and
      // "both currently set" (genuinely ambiguous either way), plus the
      // "location currently set, time isn't" case, which agrees with
      // this default anyway.
      locationValue = freeform[0].text;
    }
  }

  return { date: dateValue, location: locationValue, courts: courtsValue, time: timeValue };
}

module.exports = { parseListSections, parseHeaderFields };