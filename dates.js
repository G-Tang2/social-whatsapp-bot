// dates.js
// Small helper for parsing, validating, and displaying the dates used by
// !newlist.
//
// You TYPE a date as DD/MM (day/month, no year - e.g. "20/08"). The year
// isn't typed; it's inferred as the next upcoming occurrence of that
// day/month (today counts as upcoming). Internally that gets resolved to a
// canonical "YYYY-MM-DD" string for storage/sorting, and
// formatDisplayDate() turns that into a friendlier "20th Aug Thu" for list
// headers and messages.

function isValidDateString(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;

  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  // Catches things like 2026-02-30 (rolls over to March in JS Date math).
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

// Shared by parseTypedDate/parseDisplayDate below: given an already-parsed
// day/month pair, resolves the year as the NEXT UPCOMING occurrence of
// that day/month relative to `referenceDate` (today counts as upcoming),
// returning a canonical "YYYY-MM-DD" string, or null if the day/month
// combo doesn't exist at all (e.g. 30/02 - Date math would otherwise
// silently roll it into March).
function resolveNextOccurrence(day, month, referenceDate) {
  const today = referenceDate || new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  let year = today.getUTCFullYear();
  let candidate = Date.UTC(year, month - 1, day);

  const rolledOver = new Date(candidate);
  if (rolledOver.getUTCMonth() !== month - 1 || rolledOver.getUTCDate() !== day) {
    return null;
  }

  if (candidate < todayUTC) {
    // Already passed this year - assume the next occurrence, i.e. next year.
    year += 1;
    candidate = Date.UTC(year, month - 1, day);
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Parses "DD/MM" (day/month, 1-2 digits each, e.g. "20/08" or "5/8") into a
// canonical "YYYY-MM-DD" string. The year is chosen as the next upcoming
// occurrence of that day/month relative to `referenceDate` (today counts as
// upcoming, i.e. typing today's own date resolves to this year, not next).
// Returns null if the input isn't a valid DD/MM date.
function parseTypedDate(str, referenceDate) {
  if (typeof str !== 'string') return null;
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(str.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return resolveNextOccurrence(day, month, referenceDate);
}

const MONTH_ABBREVIATIONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Shared by parseDisplayDate/parseDisplayDateForUpdate below: pulls the
// day/month out of "20th Aug Thu" (or just "20th Aug"/"20 Aug" - the
// weekday abbreviation isn't required, and if present is NOT validated
// against anything - it's derived/redundant display text in the original,
// and may well be stale after a hand-edit that only changed the day
// number). Returns { day, month } (month 1-12) or null if the text doesn't
// start with a day-number-plus-month-name shape at all (an ordinary
// sentence, or a typed "DD/MM" - use parseTypedDate for that instead).
function parseDayMonthFromDisplayText(str) {
  if (typeof str !== 'string') return null;
  const match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})/.exec(str.trim());
  if (!match) return null;

  const day = Number(match[1]);
  if (day < 1 || day > 31) return null;

  const monthIdx = MONTH_ABBREVIATIONS.indexOf(match[2].slice(0, 3).toLowerCase());
  if (monthIdx === -1) return null;

  return { day, month: monthIdx + 1 };
}

// Opposite resolution of resolveNextOccurrence above: given an already-
// parsed day/month pair, resolves the year as the closest occurrence NOT
// AFTER `referenceDate` (today, if omitted; today itself counts as
// eligible) - i.e. the most recent PAST-or-current occurrence, stepping
// back a year if the current year's candidate hasn't happened yet. Shared
// by parseOwedSinceDisplayDate below, for the same reason
// parseDisplayDateForUpdate exists alongside parseDisplayDate: a payment
// section's date-group header (e.g. "16th Aug Sun") always describes an
// ALREADY-FINISHED list, so resolving it as "next upcoming" would bump a
// recently-passed date a full year into the future the moment its month/day
// is behind today's - wrong for a debt that's actually still recent.
function resolveMostRecentOccurrence(day, month, referenceDate) {
  const today = referenceDate || new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  let year = today.getUTCFullYear();
  let candidate = Date.UTC(year, month - 1, day);

  const rolledOver = new Date(candidate);
  if (rolledOver.getUTCMonth() !== month - 1 || rolledOver.getUTCDate() !== day) {
    return null;
  }

  if (candidate > todayUTC) {
    year -= 1;
    candidate = Date.UTC(year, month - 1, day);
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Parses a payment section's date-group header text (e.g. "16th Aug Sun",
// the exact shape formatDisplayDate() below produces) into a canonical
// owed-since ISO date, for lib/listParser.js's parseListSections() to
// reattach to the payment entries pasted underneath it via !update. Uses
// resolveMostRecentOccurrence above rather than plain parseDisplayDate's
// "next upcoming" resolution - see that function's own doc comment for why
// an owed-since date needs the opposite direction. Returns null under the
// same conditions parseDayMonthFromDisplayText does (not a day-plus-month
// shape at all - e.g. the payment label line, or "No date", which
// listParser.js checks for separately).
function parseOwedSinceDisplayDate(str, referenceDate) {
  const parsed = parseDayMonthFromDisplayText(str);
  if (!parsed) return null;
  return resolveMostRecentOccurrence(parsed.day, parsed.month, referenceDate);
}

// The reverse of formatDisplayDate() below: parses "20th Aug Thu" back into
// a canonical "YYYY-MM-DD" - same "no year, next upcoming occurrence"
// resolution as parseTypedDate above, via the same resolveNextOccurrence()
// helper. Returns null under the same conditions
// parseDayMonthFromDisplayText above does.
//
// NOT used for !update's header-block round-trip (see
// parseDisplayDateForUpdate below instead, and its own doc comment for
// why) - this plain version is for anywhere a display-format date string
// needs parsing WITHOUT reference to any specific already-stored date.
function parseDisplayDate(str, referenceDate) {
  const parsed = parseDayMonthFromDisplayText(str);
  if (!parsed) return null;
  return resolveNextOccurrence(parsed.day, parsed.month, referenceDate);
}

// Parses "20th Aug Thu"-style header text as an EDIT to a list's current
// stored date - used by lib/listParser.js's parseHeaderFields() for
// !update's header-block editing (see that function's own doc comment for
// the full feature). This is NOT the same thing as parseDisplayDate above,
// and using that instead of this here was a real, reproduced bug: !update
// works by having an admin copy the bot's own last-posted list (date line
// included) and edit ONLY what they actually want to change, often nothing
// about the header at all. formatDisplayDate() never prints a year, so
// parseDisplayDate's "resolve the year as the next upcoming occurrence
// from right now" resolution - exactly right for a freshly TYPED date like
// !date's own DD/MM argument - silently reinterprets an UNCHANGED,
// copied-back date line as a brand new one the moment the list's actual
// date is no longer in the future relative to whenever the update happens
// to be sent (which is the ordinary case for any list on or close to its
// own date, not an edge case) - bumping it a full year forward and
// reporting a spurious "Date: ... changed" in the update summary, even
// though the admin never touched the date line at all.
//
// The fix: compare the parsed day/month against `currentIsoDate`'s OWN
// day/month FIRST. If they match, the header line is read as UNCHANGED and
// `currentIsoDate` is returned verbatim - preserving its exact original
// year regardless of how much real time has passed since it was set. Only
// when the day/month genuinely differs from the current stored date (a
// REAL edit, e.g. "9th Aug" hand-changed to "16th Aug") does this fall
// through to the same "next upcoming occurrence from `referenceDate`"
// resolution parseDisplayDate itself uses - exactly the right behavior for
// an intentional date change, same as !date DD/MM.
//
// `currentIsoDate` may be null/invalid/omitted (no current date to compare
// against, e.g. a list that never had one set) - the "next upcoming
// occurrence" resolution is used unconditionally in that case, same as if
// this were plain parseDisplayDate. Returns null under the same conditions
// parseDayMonthFromDisplayText above does.
function parseDisplayDateForUpdate(str, currentIsoDate, referenceDate) {
  const parsed = parseDayMonthFromDisplayText(str);
  if (!parsed) return null;

  if (currentIsoDate && isValidDateString(currentIsoDate)) {
    const [, currentMonth, currentDay] = currentIsoDate.split('-').map(Number);
    if (currentMonth === parsed.month && currentDay === parsed.day) {
      return currentIsoDate; // unchanged - preserve the exact original year
    }
  }

  return resolveNextOccurrence(parsed.day, parsed.month, referenceDate);
}

// Given the CURRENT list's stored date, returns the closest occurrence of
// the SAME weekday from `referenceDate` (today, if omitted) onward - today
// itself counts as eligible if it happens to already be that weekday, same
// "closest occurrence, today counts" semantics as a bare weekday name
// request (e.g. "next list is on Wednesday") gets under
// lib/geminiCommand.js's RELATIVE DATES rules. Used for !newlist's "same"
// date token (see commands/admin.js's handleNewlist and
// lib/geminiCommand.js's matching SPECIAL CASE) so "create a new list"
// (no date mentioned at all) can deterministically reuse whatever day of
// the week the group normally meets on - entirely in code, without asking
// the AI to work out the arithmetic itself.
//
// Deliberately computed relative to TODAY, not relative to the current
// list's own date - the current list might still be for a date in the
// future (e.g. an admin restarting the cycle early), and "same day" should
// still mean "the next upcoming occurrence of that weekday from right
// now," not a date that could be in the past relative to today.
//
// Returns null if there's no current date to go off of (a list that never
// had a date set) or the stored date is malformed.
function nextOccurrenceOfSameWeekday(currentIsoDate, referenceDate) {
  if (!currentIsoDate || !isValidDateString(currentIsoDate)) return null;

  const [cy, cm, cd] = currentIsoDate.split('-').map(Number);
  const currentWeekday = new Date(Date.UTC(cy, cm - 1, cd)).getUTCDay();

  const today = referenceDate || new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const todayWeekday = new Date(todayUTC).getUTCDay();

  const diffDays = (currentWeekday - todayWeekday + 7) % 7;
  const target = new Date(todayUTC);
  target.setUTCDate(target.getUTCDate() + diffDays);

  const yy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(target.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th'; // 11th, 12th, 13th are exceptions
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

// "2026-08-20" -> "20th Aug Thu". Deliberately no year, matching how a
// recurring weekly/local list is usually talked about. Returns null for a
// null/empty input (a list with no date set yet).
function formatDisplayDate(isoDate) {
  if (!isoDate || !isValidDateString(isoDate)) return isoDate || null;

  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const month = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

  return `${d}${ordinalSuffix(d)} ${month} ${weekday}`;
}

module.exports = {
  isValidDateString,
  formatDisplayDate,
  parseTypedDate,
  parseDisplayDate,
  parseDisplayDateForUpdate,
  parseOwedSinceDisplayDate,
  nextOccurrenceOfSameWeekday,
};