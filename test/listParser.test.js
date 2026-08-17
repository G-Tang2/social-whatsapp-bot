// test/listParser.test.js
// Coverage for lib/listParser.js's parseListSections() - the tolerant
// text parser that powers !update (see commands/admin.js's handleUpdate
// and test/commands.test.js for the command-level tests). Pure/synchronous,
// no store access, so these tests don't need a DATA_DIR at all.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseListSections, parseHeaderFields } = require('../lib/listParser');

test('parseListSections reads back the exact format formatList() produces', () => {
  const text = [
    '27th Aug Thu',
    'EBC',
    'Courts 13-18 (6)',
    '8PM start',
    '',
    '*Attendance* (2/2)',
    '',
    '1. Jordan',
    '2. Alex',
    '',
    '*Waitlist* (1)',
    '',
    '1. Sam',
    '',
    '──────────',
    '*Payment*',
    '',
    '1. Riley',
  ].join('\n');

  const result = parseListSections(text);
  assert.deepEqual(result.attendance, ['Jordan', 'Alex']);
  assert.deepEqual(result.waitlist, ['Sam']);
  assert.deepEqual(result.duePayments, ['Riley']);
  assert.equal(result.sectionsFound, 3);
  assert.deepEqual(result.headerLines, ['27th Aug Thu', 'EBC', 'Courts 13-18 (6)', '8PM start']);
});

test('parseListSections: headerLines is empty when nothing precedes the first section header', () => {
  const result = parseListSections(['*Attendance*', '', '1. Alex'].join('\n'));
  assert.deepEqual(result.headerLines, []);
});

test('parseListSections: headerLines only captures lines before the FIRST section header, not stray text between later sections', () => {
  const text = [
    'update the list to be',
    '27th Aug Thu',
    '*Attendance*',
    '',
    '1. Alex',
    '',
    "Let me know if I got anyone's name wrong!",
    '*Waitlist*',
    '',
    '1. Sam',
  ].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.headerLines, ['update the list to be', '27th Aug Thu']);
});

test('parseListSections ignores the plain divider line formatList() prints above the payment section - it does not get mistaken for the payment-section header itself, and the REAL header right after it is still detected', () => {
  const text = [
    '*Attendance* (1/1)',
    '',
    '1. Jordan',
    '',
    '──────────',
    '*Payment*',
    '',
    '1. Jordan',
  ].join('\n');

  const result = parseListSections(text);
  assert.deepEqual(result.attendance, ['Jordan']);
  assert.deepEqual(result.waitlist, []);
  assert.deepEqual(result.duePayments, ['Jordan']);
  // Only 2 sections (Attendance, Payment) - the divider must NOT itself be
  // counted as a section header.
  assert.equal(result.sectionsFound, 2);
});

test('parseListSections handles a custom !paymentlabel header (not the literal word "Payment")', () => {
  const text = [
    '*Attendance*',
    '',
    '1. Alex',
    '',
    '*$20 please*',
    '',
    '1. Sam',
  ].join('\n');

  const result = parseListSections(text);
  assert.deepEqual(result.attendance, ['Alex']);
  assert.deepEqual(result.duePayments, ['Sam']);
});

test('parseListSections ignores stray "extra text blocks" anywhere in the message', () => {
  const text = [
    "Hey everyone, sorry for the mixup - here's the corrected list:",
    '',
    '*Attendance*',
    '',
    '1. Alex',
    '2. Sam',
    '',
    "Let me know if I got anyone's name wrong!",
    '',
    '*Waitlist*',
    '',
    '1. Jo',
    '',
    '🙏 thanks all',
  ].join('\n');

  const result = parseListSections(text);
  assert.deepEqual(result.attendance, ['Alex', 'Sam']);
  assert.deepEqual(result.waitlist, ['Jo']);
});

test('parseListSections strips the trailing "(TBC)" flag from a name', () => {
  const text = ['*Attendance*', '', '1. Alex (TBC)', '2. Sam'].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.attendance, ['Alex', 'Sam']);
});

test('parseListSections strips the owed-since date tag from a payment-due name, e.g. "Alex (13th Aug Thu)" -> "Alex" - backward-compat regression guard for round-tripping an OLDER inline-tag-format message (see OWED_SINCE_SUFFIX in lib/listParser.js - formatList() itself no longer prints this shape, it groups under a date header line instead; see the grouped-format tests below)', () => {
  const text = ['*Attendance*', '', '1. Sam', '', '*Payment*', '', '1. Alex (13th Aug Thu)', '2. Jordan'].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.duePayments, ['Alex', 'Jordan']);
});

test('parseListSections does NOT strip an ordinary parenthetical that just happens to be at the end of a payment name (only the exact owed-since date shape is recognized)', () => {
  const text = ['*Attendance*', '', '1. Sam', '', '*Payment*', '', '1. Michael (Mike)'].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.duePayments, ['Michael (Mike)']);
});

test('parseListSections reads the CURRENT grouped payment format - plain-text date/"No date" group headers are silently skipped as stray text, and every name from every group ends up in the flat duePayments list, in the order the groups were printed', () => {
  const text = [
    '*Attendance*',
    '',
    '1. Sam',
    '',
    '*Payment*',
    '',
    'No date',
    '1. Casey',
    '',
    '13th Aug Thu',
    '1. Alex',
    '',
    '20th Aug Thu',
    '1. Jordan',
    '2. Priya',
  ].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.duePayments, ['Casey', 'Alex', 'Jordan', 'Priya']);
});

test('parseListSections: a payment-section date-group header line, e.g. "13th Aug Thu", is never itself mistaken for a numbered entry or a new section - it has no leading "N." and isn\'t bold, so it just falls through the generic stray-text tolerance', () => {
  const text = ['*Attendance*', '', '1. Sam', '', '*Payment*', '', '13th Aug Thu', '1. Alex'].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.duePayments, ['Alex']);
  assert.equal(result.sectionsFound, 2); // Attendance + Payment only - the date header must not count as a 3rd section
});

test('parseListSections handles a missing waitlist/payment section (only Attendance present)', () => {
  const text = ['*Attendance* (1)', '', '1. Alex'].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.attendance, ['Alex']);
  assert.deepEqual(result.waitlist, []);
  assert.deepEqual(result.duePayments, []);
  assert.equal(result.sectionsFound, 1);
});

test('parseListSections ignores the "(empty...)" placeholder line for a zero-entry Attendance section', () => {
  const text = ['*Attendance*', '', '(empty, limit 6 - use !in to add your name)'].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.attendance, []);
  assert.equal(result.sectionsFound, 1);
});

test('parseListSections returns sectionsFound 0 for text with no recognizable sections at all', () => {
  assert.equal(parseListSections('just some random chat message, nothing list-like here').sectionsFound, 0);
  assert.equal(parseListSections('').sectionsFound, 0);
  assert.equal(parseListSections(null).sectionsFound, 0);
});

test('parseListSections honors names added, removed, or reordered by the editor', () => {
  const text = [
    '*Attendance*',
    '',
    '1. Priya', // reordered to the front
    '2. Alex',
    '3. NewPerson', // brand new, added by the editor
    // Sam removed entirely
  ].join('\n');
  const result = parseListSections(text);
  assert.deepEqual(result.attendance, ['Priya', 'Alex', 'NewPerson']);
});

// --- parseHeaderFields ---------------------------------------------------
// See lib/listParser.js's own doc comment above parseHeaderFields for the
// full design story (date-line-as-gate, courts matched by its "Courts "
// prefix, location/time disambiguated positionally). These tests use a
// fixed `referenceDate` throughout so the resolved date year is
// deterministic regardless of when the suite happens to run.

const REFERENCE = new Date(Date.UTC(2026, 7, 13)); // 2026-08-13 (Thursday)

test('parseHeaderFields: full 4-field header, exactly what formatEventHeader() itself would produce', () => {
  const fields = parseHeaderFields(['16th Aug Sun', 'Noble Park', 'Courts 11-14 (4)', '7pm-9pm'], {}, REFERENCE);
  assert.deepEqual(fields, { date: '2026-08-16', location: 'Noble Park', courts: '11-14', time: '7pm-9pm' });
});

test('parseHeaderFields: skips leading instruction text before the real header block (e.g. an @-mention\'s own preamble)', () => {
  const fields = parseHeaderFields(
    ['update the list to be', '16th Aug Sun', 'Noble Park', 'Courts 11-14 (4)', '7pm-9pm'],
    {},
    REFERENCE
  );
  assert.deepEqual(fields, { date: '2026-08-16', location: 'Noble Park', courts: '11-14', time: '7pm-9pm' });
});

test('parseHeaderFields: no header block at all (nothing date-shaped in headerLines) returns null - !update should leave the header untouched', () => {
  assert.equal(parseHeaderFields([], {}, REFERENCE), null);
  assert.equal(parseHeaderFields(["Here's the corrected list, sorry for the delay:"], {}, REFERENCE), null);
});

test('parseHeaderFields: "No date set" clears the date, and any field genuinely absent from the block clears too', () => {
  const fields = parseHeaderFields(['No date set'], { location: 'Old place', courts: '1,2', time: 'Old time' }, REFERENCE);
  assert.deepEqual(fields, { date: null, location: null, courts: null, time: null });
});

test('parseHeaderFields: date-only block clears location/courts/time', () => {
  const fields = parseHeaderFields(['16th Aug Sun'], { location: 'X', courts: '1,2', time: 'Y' }, REFERENCE);
  assert.deepEqual(fields, { date: '2026-08-16', location: null, courts: null, time: null });
});

test('parseHeaderFields: courts line is matched by its "Courts " prefix regardless of position, and its "(<count>)" suffix is stripped', () => {
  const fields = parseHeaderFields(['16th Aug Sun', 'Courts 1, 2, 5-8 (6)'], {}, REFERENCE);
  assert.deepEqual(fields.courts, '1, 2, 5-8');
});

test('parseHeaderFields: courts line without a "(<count>)" suffix still parses (e.g. a hand-edit that dropped it)', () => {
  const fields = parseHeaderFields(['16th Aug Sun', 'Courts 13-18'], {}, REFERENCE);
  assert.deepEqual(fields.courts, '13-18');
});

test('parseHeaderFields: with a courts line present, freeform lines are positioned as location (before courts) vs time (after courts)', () => {
  const fields = parseHeaderFields(['16th Aug Sun', 'Noble Park', 'Courts 11-14 (4)', '7pm-9pm'], {}, REFERENCE);
  assert.equal(fields.location, 'Noble Park');
  assert.equal(fields.time, '7pm-9pm');
});

test('parseHeaderFields: two freeform lines with no courts line - first is location, last is time', () => {
  const fields = parseHeaderFields(['16th Aug Sun', 'Noble Park', '7pm-9pm'], {}, REFERENCE);
  assert.deepEqual(fields, { date: '2026-08-16', location: 'Noble Park', courts: null, time: '7pm-9pm' });
});

test('parseHeaderFields: one ambiguous freeform line, no courts line - currentEvent has only a time set, so it\'s read as a time edit', () => {
  const fields = parseHeaderFields(['16th Aug Sun', '5pm-7pm'], { location: null, time: 'Old time' }, REFERENCE);
  assert.deepEqual(fields, { date: '2026-08-16', location: null, courts: null, time: '5pm-7pm' });
});

test('parseHeaderFields: one ambiguous freeform line, no courts line - currentEvent has only a location set, so it\'s read as a location edit', () => {
  const fields = parseHeaderFields(['16th Aug Sun', 'Somewhere'], { location: 'Old place', time: null }, REFERENCE);
  assert.deepEqual(fields, { date: '2026-08-16', location: 'Somewhere', courts: null, time: null });
});

test('parseHeaderFields: one ambiguous freeform line, no courts line, currentEvent has BOTH or NEITHER set - defaults to location', () => {
  const bothSet = parseHeaderFields(['16th Aug Sun', 'Something'], { location: 'Old place', time: 'Old time' }, REFERENCE);
  assert.deepEqual(bothSet, { date: '2026-08-16', location: 'Something', courts: null, time: null });

  const neitherSet = parseHeaderFields(['16th Aug Sun', 'Something'], { location: null, time: null }, REFERENCE);
  assert.deepEqual(neitherSet, { date: '2026-08-16', location: 'Something', courts: null, time: null });
});

// Regression coverage for a real, reproduced bug: an UNCHANGED, copied-back
// date line getting silently reinterpreted as a year-forward change - see
// dates.js's parseDisplayDateForUpdate() for the full story. This is the
// scenario !update actually hits in practice: an admin copies the bot's own
// last-posted list (whose date has, by now, often already passed relative
// to "today") and edits only the roster, never the header at all.

test('parseHeaderFields: an UNCHANGED date line round-trips to the exact stored ISO date, even when "today" has since passed it - not silently bumped a year forward', () => {
  const today = new Date(Date.UTC(2026, 7, 17)); // 2026-08-17 - after the stored date below
  const currentEvent = { date: '2026-08-09', location: 'Noble Park BC', courts: '1, 11-14', time: '7pm-10pm' };
  const fields = parseHeaderFields(['9th Aug Sun', 'Noble Park BC', 'Courts 1, 11-14 (5)', '7pm-10pm'], currentEvent, today);
  assert.equal(fields.date, '2026-08-09'); // exact original year preserved, NOT bumped to 2027
});

test('parseHeaderFields: a genuinely edited date (different day/month from the current stored date) still resolves via next-upcoming-occurrence', () => {
  const today = new Date(Date.UTC(2026, 7, 17));
  const currentEvent = { date: '2026-08-09' };

  const stillUpcoming = parseHeaderFields(['20th Aug Thu'], currentEvent, today);
  assert.equal(stillUpcoming.date, '2026-08-20'); // still upcoming relative to today - resolves this year

  const alreadyPassed = parseHeaderFields(['1st Jan Thu'], currentEvent, today);
  assert.equal(alreadyPassed.date, '2027-01-01'); // already passed this year - rolls to next year
});