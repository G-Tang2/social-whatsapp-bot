// test/store.test.js
// Coverage for store.js's core list operations: add/remove, waitlisting and
// promotion/demotion, limits, courts, clear, paid, and newlist archiving.
// Each test uses its own groupId to stay isolated from the others within
// this file's shared DATA_DIR/module instance (see the DATA_DIR setup
// below - store.js reads it once at require time).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-store-test-'));
process.env.DATA_DIR = tmpDir;

const store = require('../store');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `store-test-${groupCounter}@g.us`;
}

test('addEntry adds to the list and rejects duplicates', () => {
  const groupId = freshGroupId();
  const result = store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  assert.equal(result.ok, true);
  assert.equal(result.waitlisted, false);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);

  const dup = store.addEntry(groupId, 'alex', 'someoneelse@s.whatsapp.net', false);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate');
});

test('addEntry records `self` from its 5th argument, defaulting to false when omitted, and undefined (legacy data) is treated as "possibly self" by callers', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Gary', 'gary@s.whatsapp.net', false, true); // explicit self: true
  store.addEntry(groupId, 'Peter', 'gary@s.whatsapp.net', false); // 5th arg omitted -> self: false
  store.addEntry(groupId, 'Chris', 'gary@s.whatsapp.net', false, false); // explicit self: false

  const entries = store.getCurrentEvent(groupId).entries;
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName.Gary.self, true);
  assert.equal(byName.Peter.self, false);
  assert.equal(byName.Chris.self, false);
});

test('addEntry waitlists once the limit is reached, and removal promotes the next person', () => {
  const groupId = freshGroupId();
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  const second = store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false);
  assert.equal(second.ok, true);
  assert.equal(second.waitlisted, true);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);
  assert.equal(store.getCurrentEvent(groupId).waitlist.length, 1);

  const removed = store.removeEntry(groupId, 'Alex');
  assert.equal(removed.ok, true);
  assert.equal(removed.promoted.length, 1);
  assert.equal(removed.promoted[0].name, 'Sam');
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);
  assert.equal(store.getCurrentEvent(groupId).entries[0].name, 'Sam');
  assert.equal(store.getCurrentEvent(groupId).waitlist.length, 0);
});

test('removeEntry: anyone can remove any entry, regardless of who added it or whether they were an admin', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false); // regular member, self-added
  store.addEntry(groupId, 'Peter', 'gary@s.whatsapp.net', false); // regular member, added by Gary on Peter's behalf
  store.addEntry(groupId, 'Sam', 'admin@s.whatsapp.net', true); // admin-added

  const removeAlex = store.removeEntry(groupId, 'Alex');
  assert.equal(removeAlex.ok, true);
  const removePeter = store.removeEntry(groupId, 'Peter');
  assert.equal(removePeter.ok, true);
  const removeSam = store.removeEntry(groupId, 'Sam');
  assert.equal(removeSam.ok, true);

  assert.equal(store.getCurrentEvent(groupId).entries.length, 0);
});

test('allowFromWaitlist does NOT raise the limit, so attendance can sit over it and a later removal does not auto-promote until back under the limit', () => {
  const groupId = freshGroupId();
  store.setLimit(groupId, 2);
  store.addEntry(groupId, 'A', 'a@s.whatsapp.net', false);
  store.addEntry(groupId, 'B', 'b@s.whatsapp.net', false);
  store.addEntry(groupId, 'C', 'c@s.whatsapp.net', false); // waitlisted
  store.addEntry(groupId, 'D', 'd@s.whatsapp.net', false); // waitlisted

  const result = store.allowFromWaitlist(groupId, 1);
  assert.deepEqual(result.moved.map((e) => e.name), ['C']);
  // Limit stays exactly what it was - !allow doesn't change it.
  assert.equal(result.limit, 2);
  assert.equal(store.getLimit(groupId), 2);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['A', 'B', 'C']);

  // A leaves - attendance drops to 2, still AT the (unraised) limit, so D
  // should NOT be auto-promoted.
  const removedA = store.removeEntry(groupId, 'A');
  assert.equal(removedA.ok, true);
  assert.deepEqual(removedA.promoted, []);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['B', 'C']);
  assert.deepEqual(store.getCurrentEvent(groupId).waitlist.map((e) => e.name), ['D']);

  // B also leaves - attendance drops to 1, now genuinely UNDER the limit of
  // 2, so normal auto-promotion resumes and D gets pulled in.
  const removedB = store.removeEntry(groupId, 'B');
  assert.equal(removedB.ok, true);
  assert.deepEqual(removedB.promoted.map((e) => e.name), ['D']);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['C', 'D']);
  assert.deepEqual(store.getCurrentEvent(groupId).waitlist, []);
});

test('setLimit demotes the most recently added entries when lowered below headcount', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'b@s.whatsapp.net', false);
  store.addEntry(groupId, 'Jo', 'c@s.whatsapp.net', false);
  const { demoted } = store.setLimit(groupId, 1);
  assert.equal(demoted.length, 2);
  assert.deepEqual(demoted.map((e) => e.name), ['Sam', 'Jo']);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 1);
  assert.equal(event.entries[0].name, 'Alex');
  assert.equal(event.waitlist.length, 2);
});

test('setCourts auto-scales the limit to courtCount * PLAYERS_PER_COURT', () => {
  const groupId = freshGroupId();
  const result = store.setCourts(groupId, '13-18'); // 6 courts
  assert.equal(result.ok, true);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courtCount, 6);
  assert.equal(event.limit, 6 * store.PLAYERS_PER_COURT);
});

test('addCourts merges new numbers into what\'s already booked, compacting into ranges, and auto-scales the limit', () => {
  const groupId = freshGroupId();
  store.setCourts(groupId, '13-18'); // 6 courts

  const result = store.addCourts(groupId, '1');
  assert.equal(result.ok, true);
  assert.equal(result.courts, '1, 13-18');
  assert.equal(result.courtCount, 7);
  assert.deepEqual(result.added, [1]);
  assert.equal(result.limit, 7 * store.PLAYERS_PER_COURT);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courts, '1, 13-18');
  assert.equal(event.courtCount, 7);
  assert.equal(event.limit, 7 * store.PLAYERS_PER_COURT);
});

test('addCourts merges an adjacent range into an existing one rather than listing it separately', () => {
  const groupId = freshGroupId();
  store.setCourts(groupId, '13-18');
  const result = store.addCourts(groupId, '12-14'); // 12-14 overlaps/extends 13-18
  assert.equal(result.ok, true);
  assert.equal(result.courts, '12-18'); // compacted into one run, not "12-14, 13-18"
  assert.equal(result.courtCount, 7);
  assert.deepEqual(result.added, [12]); // 13 and 14 were already booked
});

test('addCourts treats a number already booked as a no-op, not double-counted', () => {
  const groupId = freshGroupId();
  store.setCourts(groupId, '13-18');
  const result = store.addCourts(groupId, '15'); // already within 13-18
  assert.equal(result.ok, true);
  assert.equal(result.courts, '13-18'); // unchanged
  assert.equal(result.courtCount, 6);
  assert.deepEqual(result.added, []);
});

test('addCourts with nothing booked yet behaves like setCourts for that same text', () => {
  const groupId = freshGroupId();
  const result = store.addCourts(groupId, '12-14');
  assert.equal(result.ok, true);
  assert.equal(result.courts, '12-14');
  assert.equal(result.courtCount, 3);
  assert.deepEqual(result.added, [12, 13, 14]);
});

test('addCourts rejects invalid or empty input, and a merged total over MAX_COURT_COUNT', () => {
  const groupId = freshGroupId();
  store.setCourts(groupId, '1-90'); // 90 courts, under the 100 cap on its own
  assert.equal(store.addCourts(groupId, '').ok, false);
  assert.equal(store.addCourts(groupId, 'not-a-court').ok, false);
  assert.equal(store.addCourts(groupId, '91-105').ok, false); // 90 + 15 new = 105, over MAX_COURT_COUNT
});

test('addCourts promotes off the waitlist when the merged total raises the limit, same as setCourts', () => {
  const groupId = freshGroupId();
  store.setCourts(groupId, '1'); // 1 court -> limit = PLAYERS_PER_COURT
  for (let i = 0; i < store.PLAYERS_PER_COURT + 1; i += 1) {
    store.addEntry(groupId, `Player${i}`, `p${i}@s.whatsapp.net`, false);
  }
  assert.equal(store.getCurrentEvent(groupId).waitlist.length, 1); // one overflowed

  const result = store.addCourts(groupId, '2'); // now 2 courts -> more room
  assert.equal(result.promoted.length, 1);
  assert.equal(store.getCurrentEvent(groupId).waitlist.length, 0);
});

test('clearList wipes entries and waitlist but keeps duePayments and header fields', () => {
  const groupId = freshGroupId();
  store.setLocation(groupId, 'EBC');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // archives Alex into duePayments
  const beforeClear = store.getCurrentEvent(groupId);
  assert.equal(beforeClear.duePayments.length, 1);

  store.addEntry(groupId, 'Sam', 'b@s.whatsapp.net', false);
  store.clearList(groupId);
  const after = store.getCurrentEvent(groupId);
  assert.equal(after.entries.length, 0);
  assert.equal(after.waitlist.length, 0);
  assert.equal(after.location, 'EBC'); // preserved
  assert.equal(after.duePayments.length, 1); // preserved - clearList doesn't touch payments
});

test('markPaid removes someone from duePayments', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // archives Alex as owing payment
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 1);

  const result = store.markPaid(groupId, 'Alex');
  assert.equal(result.ok, true);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);

  const again = store.markPaid(groupId, 'Alex');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'not_found');
});

test('clearDuePayments wipes duePayments but keeps entries/waitlist and header fields', () => {
  const groupId = freshGroupId();
  store.setLocation(groupId, 'EBC');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // archives Alex into duePayments
  store.addEntry(groupId, 'Sam', 'b@s.whatsapp.net', false);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 1);

  const result = store.clearDuePayments(groupId);
  assert.deepEqual(result, []);

  const after = store.getCurrentEvent(groupId);
  assert.equal(after.duePayments.length, 0);
  assert.equal(after.entries.length, 1); // preserved - clearDuePayments doesn't touch the list
  assert.equal(after.entries[0].name, 'Sam');
  assert.equal(after.location, 'EBC'); // preserved
});

test('newList carries forward location/courts/time and merges unpaid debt across cycles', () => {
  const groupId = freshGroupId();
  store.setLocation(groupId, 'EBC');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex now owes for cycle 1

  store.addEntry(groupId, 'Sam', 'b@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Sam now owes for cycle 2; Alex still owes from cycle 1

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.location, 'EBC'); // carried forward, never respecified
  assert.equal(event.date, '2026-08-27');
  const names = event.duePayments.map((e) => e.name).sort();
  assert.deepEqual(names, ['Alex', 'Sam']);
});

// --- newList()'s owedSince tagging ----------------------------------------
// A duePayments entry now remembers which OLD list it's actually owed for
// (entry.owedSince, an ISO date) - see newList()'s own doc comment. Covers
// both halves: a freshly-transitioned entry gets tagged with the list that
// just ended, and an already-owing entry carried forward from an earlier
// cycle keeps its ORIGINAL date rather than being re-tagged with the
// newer one.

test('newList tags a newly-transitioned duePayments entry with the OLD list\'s date', () => {
  const groupId = freshGroupId(); // starts with no date - set one first so there's something real to tag with
  store.setDate(groupId, '2026-08-20');
  store.addEntry(groupId, 'Sam', 'b@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'Sam');
  assert.equal(due[0].owedSince, '2026-08-20'); // the OLD list's date, not the new one
});

test('newList leaves an ALREADY-owing entry\'s owedSince untouched across a further cycle (keeps the ORIGINAL date, not the newest)', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex now owes for 8/13

  store.addEntry(groupId, 'Jordan', 'j@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Jordan now owes for 8/20; Alex still owes from 8/13

  const due = store.getCurrentEvent(groupId).duePayments;
  const alex = due.find((e) => e.name === 'Alex');
  const jordan = due.find((e) => e.name === 'Jordan');
  assert.equal(alex.owedSince, '2026-08-13'); // unchanged - the FIRST list Alex missed
  assert.equal(jordan.owedSince, '2026-08-20');
});

test('newList does not set owedSince at all when the old list never had a date', () => {
  const groupId = freshGroupId(); // no date set
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(due.length, 1);
  assert.equal(due[0].owedSince, undefined);
});

// --- newList(): owing separately for MULTIPLE missed events at once ------
// Someone who still owes from an earlier cycle AND attends (without paying)
// a LATER cycle too now gets a SEPARATE second duePayments entry for that
// cycle, rather than being collapsed into a single "still behind" line -
// see newList()'s own doc comment for the reasoning.

test('newList gives someone a SEPARATE second entry if they still owe from before AND attend (without paying) again', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex owes for 8/13

  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false); // Alex attends again, still hasn't paid
  store.newList(groupId, '2026-08-27', {}); // Alex now owes for BOTH 8/13 and 8/20

  const due = store.getCurrentEvent(groupId).duePayments;
  const alexEntries = due.filter((e) => e.name === 'Alex');
  assert.equal(alexEntries.length, 2);
  const owedDates = alexEntries.map((e) => e.owedSince).sort();
  assert.deepEqual(owedDates, ['2026-08-13', '2026-08-20']);
});

test('newList: a THIRD consecutive missed cycle for the same person adds a THIRD entry, each with its own distinct owedSince', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-06');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-13', {});
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  const alexEntries = due.filter((e) => e.name === 'Alex');
  assert.equal(alexEntries.length, 3);
  assert.deepEqual(alexEntries.map((e) => e.owedSince).sort(), ['2026-08-06', '2026-08-13', '2026-08-20']);
});

// --- markPaid(): clears EVERY entry for a name at once --------------------

test('markPaid clears ALL of a name\'s entries at once, not just the first one found', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Alex now owes twice

  assert.equal(store.getCurrentEvent(groupId).duePayments.filter((e) => e.name === 'Alex').length, 2);

  const result = store.markPaid(groupId, 'Alex');
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(store.getCurrentEvent(groupId).duePayments.filter((e) => e.name === 'Alex').length, 0);
});

test('markPaid leaves an unrelated name\'s entries untouched when clearing a different name', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'b@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});

  store.markPaid(groupId, 'Alex');
  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.name), ['Sam']);
});

// --- applyListUpdate() (!update): round-trips duplicate payment names -----
// A name can legitimately appear more than once in the pasted payment
// section now (once per event it owes for) - each occurrence should match
// up with one of that name's existing entries (preserving ITS OWN
// owedSince), in order, rather than the second occurrence being silently
// dropped or treated as a brand-new no-owedSince entry.

test('applyListUpdate: pasting a name back TWICE (once per date group it was under) preserves BOTH original entries, each keeping its own owedSince', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Alex now owes twice: 8/13 and 8/20

  const result = store.applyListUpdate(
    groupId,
    { attendance: [], waitlist: [], duePayments: ['Alex', 'Alex'] },
    'editor@s.whatsapp.net',
    true
  );

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((e) => e.owedSince).sort(), ['2026-08-13', '2026-08-20']);
  // Both occurrences matched existing entries - nothing new was added, nothing removed.
  assert.deepEqual(result.paidAdded, []);
  assert.deepEqual(result.paidRemoved, []);
});

test('applyListUpdate: pasting a name back only ONCE when it had TWO entries clears the unmatched one (reported as paidRemoved), keeps the other', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Alex owes twice: 8/13 and 8/20

  const result = store.applyListUpdate(
    groupId,
    { attendance: [], waitlist: [], duePayments: ['Alex'] },
    'editor@s.whatsapp.net',
    true
  );

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(due.length, 1);
  assert.equal(result.paidRemoved.length, 1);
});

test('applyListUpdate: a genuinely NEW second occurrence of an existing name (more pasted-back copies than real entries) is added as a fresh no-owedSince entry', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex owes once, for 8/13

  const result = store.applyListUpdate(
    groupId,
    { attendance: [], waitlist: [], duePayments: ['Alex', 'Alex'] },
    'editor@s.whatsapp.net',
    true
  );

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(due.length, 2);
  assert.deepEqual(result.paidAdded, ['Alex']);
  const withDate = due.filter((e) => e.owedSince === '2026-08-13');
  const withoutDate = due.filter((e) => !e.owedSince);
  assert.equal(withDate.length, 1);
  assert.equal(withoutDate.length, 1);
});

// --- Payment-exempt roster (!exempt) ---------------------------------------
// getPaymentExempt/setPaymentExempt persist a per-group roster of names who
// never get carried into duePayments by newList() - see that function's
// own doc comment, and commands/admin.js's handleExempt for the command
// itself.

test('getPaymentExempt starts empty for a brand-new group', () => {
  const groupId = freshGroupId();
  assert.deepEqual(store.getPaymentExempt(groupId), []);
});

test('setPaymentExempt replaces the whole roster and getPaymentExempt reads it back', () => {
  const groupId = freshGroupId();
  const result = store.setPaymentExempt(groupId, ['Peter', 'Chris']);
  assert.deepEqual(result, ['Peter', 'Chris']);
  assert.deepEqual(store.getPaymentExempt(groupId), ['Peter', 'Chris']);
});

test('newList skips an exempt name entirely when carrying attendance into duePayments - they never show up owing anything', () => {
  const groupId = freshGroupId();
  store.setPaymentExempt(groupId, ['Peter']);
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Peter', 'h@s.whatsapp.net', false);
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.name), ['Alex']);
});

test('newList exemption is forward-looking only - an existing debt from BEFORE someone was exempted is left untouched', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Peter', 'h@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Peter owes for 8/13, before being exempted

  store.setPaymentExempt(groupId, ['Peter']); // exempted AFTER already owing
  store.newList(groupId, '2026-08-27', {}); // nothing new happens - Peter didn't attend this cycle anyway

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.name), ['Peter']); // the OLD debt is still there
  assert.equal(due[0].owedSince, '2026-08-13');
});

test('newList exemption is case/whitespace-insensitive, same normalizeName() matching as everywhere else', () => {
  const groupId = freshGroupId();
  store.setPaymentExempt(groupId, ['  peter  ']);
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Peter', 'h@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});

  assert.deepEqual(store.getCurrentEvent(groupId).duePayments, []);
});

// getCourtCanceller/setCourtCanceller persist a per-group court-
// cancellation contact - see !courtcanceller (commands/admin.js) and
// lib/vacancyReminder.js's 26-hours-before check.

test('getCourtCanceller starts unset for a brand-new group', () => {
  const groupId = freshGroupId();
  assert.equal(store.getCourtCanceller(groupId), null);
});

test('setCourtCanceller stores the JID and getCourtCanceller reads it back', () => {
  const groupId = freshGroupId();
  const result = store.setCourtCanceller(groupId, { jid: 'alex@s.whatsapp.net' });
  assert.deepEqual(result, { jid: 'alex@s.whatsapp.net' });
  assert.deepEqual(store.getCourtCanceller(groupId), { jid: 'alex@s.whatsapp.net' });
});

test('setCourtCanceller(groupId, null) clears a previously-set contact', () => {
  const groupId = freshGroupId();
  store.setCourtCanceller(groupId, { jid: 'alex@s.whatsapp.net' });
  store.setCourtCanceller(groupId, null);
  assert.equal(store.getCourtCanceller(groupId), null);
});

test('setCourtCanceller persists across newList/clearList, same lifecycle as regularPlayers/paymentExempt', () => {
  const groupId = freshGroupId();
  store.setCourtCanceller(groupId, { jid: 'alex@s.whatsapp.net' });
  store.newList(groupId, '2026-08-20', {});
  assert.deepEqual(store.getCourtCanceller(groupId), { jid: 'alex@s.whatsapp.net' });
  store.clearList(groupId);
  assert.deepEqual(store.getCourtCanceller(groupId), { jid: 'alex@s.whatsapp.net' });
});

// markVacancy50hNotified/markVacancyCancelWarningNotified - the one-shot-
// per-list-cycle flags lib/vacancyReminder.js checks before sending each
// of its two escalating warnings.

test('a brand-new list has neither vacancy warning marked as sent', () => {
  const groupId = freshGroupId();
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.notifiedVacancy50h, false);
  assert.equal(event.notifiedVacancyCancelWarning, false);
});

test('markVacancy50hNotified/markVacancyCancelWarningNotified flip only their own flag on the current event', () => {
  const groupId = freshGroupId();
  store.markVacancy50hNotified(groupId);
  let event = store.getCurrentEvent(groupId);
  assert.equal(event.notifiedVacancy50h, true);
  assert.equal(event.notifiedVacancyCancelWarning, false);

  store.markVacancyCancelWarningNotified(groupId);
  event = store.getCurrentEvent(groupId);
  assert.equal(event.notifiedVacancy50h, true);
  assert.equal(event.notifiedVacancyCancelWarning, true);
});

test('newList resets both vacancy-notified flags for the fresh cycle', () => {
  const groupId = freshGroupId();
  store.markVacancy50hNotified(groupId);
  store.markVacancyCancelWarningNotified(groupId);
  store.newList(groupId, '2026-08-20', {});

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.notifiedVacancy50h, false);
  assert.equal(event.notifiedVacancyCancelWarning, false);
});

test('clearList does NOT reset the vacancy-notified flags - same list cycle, still only warn once', () => {
  const groupId = freshGroupId();
  store.markVacancy50hNotified(groupId);
  store.clearList(groupId);

  assert.equal(store.getCurrentEvent(groupId).notifiedVacancy50h, true);
});

test('getUndoableState/restoreUndoableState round-trip courtCanceller alongside regularPlayers/paymentExempt', () => {
  const groupId = freshGroupId();
  store.setCourtCanceller(groupId, { jid: 'alex@s.whatsapp.net' });
  const snapshot = store.getUndoableState(groupId);
  assert.deepEqual(snapshot.courtCanceller, { jid: 'alex@s.whatsapp.net' });

  store.setCourtCanceller(groupId, { jid: 'sam@s.whatsapp.net' });
  store.restoreUndoableState(groupId, snapshot);
  assert.deepEqual(store.getCourtCanceller(groupId), { jid: 'alex@s.whatsapp.net' });
});

test('setDate corrects the current list\'s date in place, without touching entries/waitlist/location/courts/time/limit/duePayments', () => {
  const groupId = freshGroupId();
  store.setLocation(groupId, 'EBC');
  store.setCourts(groupId, '13-18');
  store.setTime(groupId, '8PM start');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex now owes payment; date is 2026-08-20
  store.addEntry(groupId, 'Sam', 'b@s.whatsapp.net', false);

  const before = store.getCurrentEvent(groupId);
  assert.equal(before.date, '2026-08-20');

  const result = store.setDate(groupId, '2026-08-27'); // admin typo'd the date - correcting it
  assert.equal(result, '2026-08-27');

  const after = store.getCurrentEvent(groupId);
  assert.equal(after.date, '2026-08-27');
  // Nothing else moved.
  assert.equal(after.location, 'EBC');
  assert.equal(after.courts, '13-18');
  assert.equal(after.time, '8PM start');
  assert.deepEqual(after.entries.map((e) => e.name), ['Sam']);
  assert.equal(after.duePayments.length, 1);
  assert.equal(after.duePayments[0].name, 'Alex');
});

test('applyListUpdate: kept names preserve their original addedBy/addedByIsAdmin metadata', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'admin@s.whatsapp.net', true); // added by an admin, on Sam's behalf

  const parsed = { attendance: ['Sam', 'Alex'], waitlist: [], duePayments: [] }; // reordered
  store.applyListUpdate(groupId, parsed, 'editor@s.whatsapp.net', true);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'Sam');
  assert.equal(entries[0].addedBy, 'admin@s.whatsapp.net'); // original adder preserved, not the editor
  assert.equal(entries[0].addedByIsAdmin, true);
  assert.equal(entries[1].name, 'Alex');
  assert.equal(entries[1].addedBy, 'alex@s.whatsapp.net');
});

test('applyListUpdate: a brand-new name is attributed to the editor', () => {
  const groupId = freshGroupId();
  store.applyListUpdate(
    groupId,
    { attendance: ['NewPerson'], waitlist: [], duePayments: [] },
    'editor@s.whatsapp.net',
    true
  );
  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'NewPerson');
  assert.equal(entries[0].addedBy, 'editor@s.whatsapp.net');
  assert.equal(entries[0].addedByIsAdmin, true);
});

test('applyListUpdate: a name dropped entirely from the edited text is removed', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false);

  const result = store.applyListUpdate(
    groupId,
    { attendance: ['Alex'], waitlist: [], duePayments: [] }, // Sam left out
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.removed, ['Sam']);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);
});

test('applyListUpdate: moving a name from Waitlist to Attendance in the edited text actually promotes them, keeping their metadata', () => {
  const groupId = freshGroupId();
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Jo', 'jo@s.whatsapp.net', false); // waitlisted (limit 1)
  assert.equal(store.getCurrentEvent(groupId).waitlist.length, 1);

  const result = store.applyListUpdate(
    groupId,
    { attendance: ['Alex', 'Jo'], waitlist: [], duePayments: [] },
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.moved, [{ name: 'Jo', from: 'waitlist', to: 'attendance' }]);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 2);
  assert.equal(event.waitlist.length, 0);
  const jo = event.entries.find((e) => e.name === 'Jo');
  assert.equal(jo.addedBy, 'jo@s.whatsapp.net'); // original metadata survives the move
});

test('applyListUpdate: a name listed in more than one section keeps only its first placement', () => {
  const groupId = freshGroupId();
  const result = store.applyListUpdate(
    groupId,
    { attendance: ['Alex'], waitlist: ['Alex'], duePayments: [] }, // duplicated by mistake
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.added, ['Alex']);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 1);
  assert.equal(event.waitlist.length, 0); // NOT also on the waitlist
});

test('applyListUpdate: reconciles the payment section independently (added/removed = new debt / marked paid)', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex now owes
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 1);

  const result = store.applyListUpdate(
    groupId,
    { attendance: [], waitlist: [], duePayments: ['Jo'] }, // Alex removed (paid), Jo added (new debt)
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.paidRemoved, ['Alex']);
  assert.deepEqual(result.paidAdded, ['Jo']);
  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'Jo');
  assert.equal(due[0].addedBy, 'editor@s.whatsapp.net');
});

test('applyListUpdate: does NOT auto-demote to the waitlist even if Attendance ends up over the limit', () => {
  const groupId = freshGroupId();
  store.setLimit(groupId, 1);
  store.applyListUpdate(
    groupId,
    { attendance: ['Alex', 'Sam', 'Jo'], waitlist: [], duePayments: [] }, // 3 people, limit is 1
    'editor@s.whatsapp.net',
    true
  );
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 3); // editor's explicit placement is authoritative
  assert.equal(event.waitlist.length, 0);
});

