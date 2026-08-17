// test/dates.test.js
// Coverage for dates.js: parseTypedDate, formatDisplayDate, and
// isValidDateString.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidDateString,
  formatDisplayDate,
  parseTypedDate,
  parseDisplayDate,
  parseDisplayDateForUpdate,
  nextOccurrenceOfSameWeekday,
} = require('../dates');

test('isValidDateString accepts real calendar dates and rejects rollovers', () => {
  assert.equal(isValidDateString('2026-08-20'), true);
  assert.equal(isValidDateString('2026-02-30'), false); // Feb has no 30th
  assert.equal(isValidDateString('not-a-date'), false);
  assert.equal(isValidDateString('2026-8-20'), false); // must be zero-padded
});

test('parseTypedDate resolves DD/MM to the next upcoming occurrence (today counts as upcoming)', () => {
  const reference = new Date(Date.UTC(2026, 7, 13)); // 2026-08-13 (Thursday)
  assert.equal(parseTypedDate('13/08', reference), '2026-08-13'); // today itself -> this year
  assert.equal(parseTypedDate('20/08', reference), '2026-08-20'); // later this year
  assert.equal(parseTypedDate('01/01', reference), '2027-01-01'); // already passed -> next year
});

test('parseTypedDate rejects malformed or non-existent dates', () => {
  const reference = new Date(Date.UTC(2026, 7, 13));
  assert.equal(parseTypedDate('not a date', reference), null);
  assert.equal(parseTypedDate('30/02', reference), null); // Feb 30 doesn't exist
  assert.equal(parseTypedDate('32/01', reference), null); // day out of range
  assert.equal(parseTypedDate(42, reference), null); // wrong type entirely
});

test('formatDisplayDate renders a friendly "Dth Mon Weekday" string with correct ordinal suffixes', () => {
  assert.equal(formatDisplayDate('2026-08-20'), '20th Aug Thu');
  assert.equal(formatDisplayDate('2026-08-01'), '1st Aug Sat');
  assert.equal(formatDisplayDate('2026-08-02'), '2nd Aug Sun');
  assert.equal(formatDisplayDate('2026-08-03'), '3rd Aug Mon');
  assert.equal(formatDisplayDate('2026-08-11'), '11th Aug Tue'); // exception case
});

test('formatDisplayDate passes through null/empty unchanged', () => {
  assert.equal(formatDisplayDate(null), null);
  assert.equal(formatDisplayDate(''), null);
});

test('nextOccurrenceOfSameWeekday: today already IS that weekday - counts as eligible, returns today', () => {
  // 2026-08-20 is a Thursday; reference is also a Thursday one week later.
  const reference = new Date(Date.UTC(2026, 7, 27)); // 2026-08-27, also Thu
  assert.equal(nextOccurrenceOfSameWeekday('2026-08-20', reference), '2026-08-27');
});

test('nextOccurrenceOfSameWeekday: weekday still ahead later this week', () => {
  const reference = new Date(Date.UTC(2026, 7, 16)); // 2026-08-16, Sunday
  assert.equal(nextOccurrenceOfSameWeekday('2026-08-20', reference), '2026-08-20'); // this Thursday
});

test('nextOccurrenceOfSameWeekday: weekday already passed this week - rolls to next week', () => {
  const reference = new Date(Date.UTC(2026, 7, 21)); // 2026-08-21, Friday - Thursday already passed
  assert.equal(nextOccurrenceOfSameWeekday('2026-08-20', reference), '2026-08-27'); // next Thursday
});

test('nextOccurrenceOfSameWeekday: rolls across a month/year boundary correctly', () => {
  const reference = new Date(Date.UTC(2026, 11, 30)); // 2026-12-30, Wednesday
  // 2026-12-31 is a Thursday - one day ahead.
  assert.equal(nextOccurrenceOfSameWeekday('2026-08-20', reference), '2026-12-31');
});

test('parseDisplayDate: parses the bot\'s own "Dth Mon Weekday" format back to ISO, resolving the next upcoming occurrence', () => {
  const reference = new Date(Date.UTC(2026, 7, 13)); // 2026-08-13 (Thursday)
  assert.equal(parseDisplayDate('20th Aug Thu', reference), '2026-08-20');
  assert.equal(parseDisplayDate('13th Aug Thu', reference), '2026-08-13'); // today itself -> this year
  assert.equal(parseDisplayDate('1st Jan Fri', reference), '2027-01-01'); // already passed -> next year
});

test('parseDisplayDate: the weekday abbreviation is not required, and not validated against the resolved date', () => {
  const reference = new Date(Date.UTC(2026, 7, 13));
  assert.equal(parseDisplayDate('20th Aug', reference), '2026-08-20');
  assert.equal(parseDisplayDate('20 Aug', reference), '2026-08-20');
  // "Thu" is the WRONG weekday for 2026-08-20 (which is really a Thursday,
  // so use a genuinely wrong one to prove it's not checked) - a stale
  // weekday label left over from a hand-edit shouldn't block the parse.
  assert.equal(parseDisplayDate('20th Aug Mon', reference), '2026-08-20');
});

test('parseDisplayDate: rejects text that doesn\'t start with a day-number-plus-month shape', () => {
  const reference = new Date(Date.UTC(2026, 7, 13));
  assert.equal(parseDisplayDate('No date set', reference), null);
  assert.equal(parseDisplayDate('20/08', reference), null); // typed DD/MM, not this format
  assert.equal(parseDisplayDate('Noble Park', reference), null);
  assert.equal(parseDisplayDate('', reference), null);
  assert.equal(parseDisplayDate(null, reference), null);
  assert.equal(parseDisplayDate('99th Aug', reference), null); // day out of range
  assert.equal(parseDisplayDate('20th Zzz', reference), null); // not a real month
});

// --- parseDisplayDateForUpdate ---------------------------------------
// Regression coverage for a real, reproduced bug: !update round-tripping
// an UNCHANGED, copied-back date header line through plain parseDisplayDate
// (which always resolves the year as "next upcoming occurrence from right
// now") silently bumped it a full year forward the moment the list's real
// date fell into the past relative to whenever the update was sent -
// reporting a spurious "Date: ... changed" and actually applying the wrong
// year, even though the admin never touched the date line, e.g. when just
// renaming someone in the roster. See lib/listParser.js's
// parseHeaderFields() for where this is actually used.

test('parseDisplayDateForUpdate: an UNCHANGED date line (day/month matches the current stored date) round-trips to the EXACT same ISO string, even when "today" has since passed it', () => {
  // The critical case: referenceDate ("now") is AFTER the stored date, so
  // plain "next upcoming occurrence" resolution would wrongly bump this to
  // next year - exactly the bug being regression-tested here.
  const reference = new Date(Date.UTC(2026, 7, 17)); // 2026-08-17 - after the stored 2026-08-09
  assert.equal(parseDisplayDateForUpdate('9th Aug Sun', '2026-08-09', reference), '2026-08-09');
});

test('parseDisplayDateForUpdate: a GENUINE date edit (day/month differs from the current stored date) still resolves via next-upcoming-occurrence, same as a real !date change', () => {
  const reference = new Date(Date.UTC(2026, 7, 13)); // 2026-08-13 (Thursday)
  assert.equal(parseDisplayDateForUpdate('20th Aug Thu', '2026-08-09', reference), '2026-08-20'); // later this year
  assert.equal(parseDisplayDateForUpdate('1st Jan Fri', '2026-08-09', reference), '2027-01-01'); // already passed -> next year
});

test('parseDisplayDateForUpdate: no current stored date to compare against falls back to next-upcoming-occurrence, same as plain parseDisplayDate', () => {
  const reference = new Date(Date.UTC(2026, 7, 13));
  assert.equal(parseDisplayDateForUpdate('20th Aug Thu', null, reference), '2026-08-20');
  assert.equal(parseDisplayDateForUpdate('20th Aug Thu', '', reference), '2026-08-20');
  assert.equal(parseDisplayDateForUpdate('20th Aug Thu', 'not-a-real-date', reference), '2026-08-20');
});

test('parseDisplayDateForUpdate: rejects text that doesn\'t start with a day-number-plus-month shape, same as plain parseDisplayDate', () => {
  const reference = new Date(Date.UTC(2026, 7, 13));
  assert.equal(parseDisplayDateForUpdate('No date set', '2026-08-09', reference), null);
  assert.equal(parseDisplayDateForUpdate('Noble Park', '2026-08-09', reference), null);
  assert.equal(parseDisplayDateForUpdate('', '2026-08-09', reference), null);
});

test('nextOccurrenceOfSameWeekday: no current date to go off of returns null', () => {
  const reference = new Date(Date.UTC(2026, 7, 16));
  assert.equal(nextOccurrenceOfSameWeekday(null, reference), null);
  assert.equal(nextOccurrenceOfSameWeekday('', reference), null);
  assert.equal(nextOccurrenceOfSameWeekday('not-a-date', reference), null);
});