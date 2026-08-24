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

// markPaidEarly - paying ahead of !newlist even archiving this cycle into
// duePayments yet (see its own doc comment in store.js).

test('markPaidEarly tags a confirmed attendance entry as paid, and is idempotent', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  assert.equal(store.getCurrentEvent(groupId).entries[0].paidEarly, false);

  const result = store.markPaidEarly(groupId, 'Alex');
  assert.equal(result.ok, true);
  assert.equal(store.getCurrentEvent(groupId).entries[0].paidEarly, true);

  const again = store.markPaidEarly(groupId, 'Alex'); // idempotent, not an error
  assert.equal(again.ok, true);
  assert.equal(store.getCurrentEvent(groupId).entries[0].paidEarly, true);
});

test('markPaidEarly fails for a name not on the attendance list at all', () => {
  const groupId = freshGroupId();
  const result = store.markPaidEarly(groupId, 'Ghost');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('markPaidEarly never matches the waitlist - only confirmed attendance', () => {
  const groupId = freshGroupId();
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 's@s.whatsapp.net', false); // over the limit - waitlisted
  assert.deepEqual(store.getCurrentEvent(groupId).waitlist.map((e) => e.name), ['Sam']);

  const result = store.markPaidEarly(groupId, 'Sam');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('newList skips a paidEarly entry entirely when carrying attendance into duePayments - they never show up owing anything', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Chakriya', 'c@s.whatsapp.net', false);
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.markPaidEarly(groupId, 'Chakriya');
  store.newList(groupId, '2026-08-20', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.name), ['Alex']);
});

test('newList never carries paidEarly forward onto the fresh cycle\'s own (unrelated, brand new) entries', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Chakriya', 'c@s.whatsapp.net', false);
  store.markPaidEarly(groupId, 'Chakriya');
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Chakriya', 'c@s.whatsapp.net', false); // signs up again, fresh cycle

  assert.equal(store.getCurrentEvent(groupId).entries[0].paidEarly, false);
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

// --- waiveDuePaymentsForWinners() -----------------------------------------
// Tournament winners don't have to pay for the social they won - see
// commands/admin.js's handleTournamentWinners, which calls this right
// alongside setTournamentWinners.

test('waiveDuePaymentsForWinners clears the winners\' debt for the most recent week they were charged for', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Irfan', 'i@s.whatsapp.net', false);
  store.addEntry(groupId, 'Tu', 't@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 's@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Irfan/Tu/Sam now owe for 8/13

  const waived = store.waiveDuePaymentsForWinners(groupId, ['Irfan', 'Tu']);
  assert.deepEqual(waived.sort(), ['Irfan', 'Tu']);

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.name), ['Sam']); // winners cleared, Sam still owes
});

test('waiveDuePaymentsForWinners leaves a winner\'s UNRELATED earlier debt untouched', () => {
  const groupId = freshGroupId();
  store.setDate(groupId, '2026-08-06');
  store.addEntry(groupId, 'Irfan', 'i@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-13', {}); // Irfan owes for 8/06 (a missed, unrelated cycle)

  store.addEntry(groupId, 'Irfan', 'i@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Irfan now ALSO owes for 8/13 - the week won

  store.waiveDuePaymentsForWinners(groupId, ['Irfan', 'Tu']);

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.owedSince), ['2026-08-06']); // only the 8/13 entry was waived
});

test('waiveDuePaymentsForWinners is a no-op when nobody currently owes anything', () => {
  const groupId = freshGroupId();
  const waived = store.waiveDuePaymentsForWinners(groupId, ['Irfan', 'Tu']);
  assert.deepEqual(waived, []);
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

test('applyListUpdate: with no tournamentPlayers field at all (an ordinary, non-tournament caller), tournament flags on kept entries are left completely untouched', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true); // in the tournament

  const result = store.applyListUpdate(
    groupId,
    { attendance: ['Keith', 'NewPerson'], waitlist: [], duePayments: [] }, // no tournamentPlayers key
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.tournamentChanged, []);
  const keith = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Keith');
  assert.equal(keith.tournament, true); // untouched
});

test('applyListUpdate: tournamentPlayers null (the pasted text had no "🏆 Tournament players" header at all) also leaves tournament flags untouched', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);

  const result = store.applyListUpdate(
    groupId,
    { attendance: ['Keith'], waitlist: [], duePayments: [], tournamentPlayers: null, tournamentWaitlistedNames: [] },
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.tournamentChanged, []);
  assert.equal(store.getCurrentEvent(groupId).entries[0].tournament, true);
});

test('applyListUpdate: tournamentPlayers [] (header present, but nobody listed under it) clears EVERYONE\'s tournament flag - "nobody\'s in it anymore"', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true);

  const result = store.applyListUpdate(
    groupId,
    { attendance: ['Keith', 'Bao'], waitlist: [], duePayments: [], tournamentPlayers: [], tournamentWaitlistedNames: [] },
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(
    result.tournamentChanged.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'Bao', from: 'tournament', to: 'social only' },
      { name: 'Keith', from: 'tournament', to: 'social only' },
    ]
  );
  const entries = store.getCurrentEvent(groupId).entries;
  assert.ok(entries.every((e) => e.tournament === false));
});

test('applyListUpdate: moving a name from Social only up into "🏆 Tournament players" (and another back down) actually swaps their tournament status', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 2);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Garvin', 'garvin@s.whatsapp.net', false, true, false);

  const result = store.applyListUpdate(
    groupId,
    {
      attendance: ['Keith', 'Garvin', 'Bao'],
      waitlist: [],
      duePayments: [],
      tournamentPlayers: ['Keith', 'Garvin'], // Garvin promoted in, Bao's spot given up
      tournamentWaitlistedNames: [],
    },
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(
    result.tournamentChanged.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'Bao', from: 'tournament', to: 'social only' },
      { name: 'Garvin', from: 'social only', to: 'tournament' },
    ]
  );
  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Keith').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Garvin').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, false);
});

test('applyListUpdate: listing MORE names under "🏆 Tournament players" than tournamentLimit allows caps it - the overflow (in the given order) ends up tournamentWaitlisted instead, not silently over the cap', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true);

  const result = store.applyListUpdate(
    groupId,
    {
      attendance: ['Keith', 'Bao'],
      waitlist: [],
      duePayments: [],
      tournamentPlayers: ['Keith', 'Bao'], // both listed, but the cap is 1
      tournamentWaitlistedNames: [],
    },
    'editor@s.whatsapp.net',
    true
  );
  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Keith').tournament, true); // first in order, gets the real spot
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, false);
  assert.equal(entries.find((e) => e.name === 'Bao').tournamentWaitlisted, true); // queued instead
  assert.deepEqual(
    result.tournamentChanged.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'Bao', from: 'social only', to: 'queued' },
      { name: 'Keith', from: 'social only', to: 'tournament' },
    ]
  );
});

test('applyListUpdate: a "(🏆 WL)" tag on a Social-only name round-trips correctly (previously a real bug: the tagged text got treated as a literal, different name, corrupting the entry)', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // full - queued (🏆 WL)
  assert.equal(store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao').tournamentWaitlisted, true);

  // Round-tripping the exact same arrangement back through !update (as
  // lib/listParser.js would parse it - the WL tag already stripped from
  // the name, recorded in tournamentWaitlistedNames instead) should be a
  // complete no-op: no removal, no bogus new entry, no lost metadata.
  const result = store.applyListUpdate(
    groupId,
    {
      attendance: ['Keith', 'Bao'],
      waitlist: [],
      duePayments: [],
      tournamentPlayers: ['Keith'],
      tournamentWaitlistedNames: ['Bao'],
    },
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.tournamentChanged, []);
  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.name === 'Bao').tournamentWaitlisted, true);
  assert.equal(entries.find((e) => e.name === 'Bao').addedBy, 'bao@s.whatsapp.net'); // original metadata intact
});

test('applyListUpdate: a brand-new name listed directly under "🏆 Tournament players" is added AND opted into the tournament in one pass', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);

  const result = store.applyListUpdate(
    groupId,
    {
      attendance: ['NewPlayer'],
      waitlist: [],
      duePayments: [],
      tournamentPlayers: ['NewPlayer'],
      tournamentWaitlistedNames: [],
    },
    'editor@s.whatsapp.net',
    true
  );
  assert.deepEqual(result.added, ['NewPlayer']);
  assert.deepEqual(result.tournamentChanged, [{ name: 'NewPlayer', from: 'social only', to: 'tournament' }]);
  const entry = store.getCurrentEvent(groupId).entries[0];
  assert.equal(entry.tournament, true);
  assert.equal(entry.addedBy, 'editor@s.whatsapp.net');
});

test('newList recomputes the limit to match carried-forward courts, overriding a manual !limit from the previous cycle', () => {
  const groupId = freshGroupId();
  store.setCourts(groupId, '13-18'); // 6 courts -> limit auto-scales to 36
  assert.equal(store.getCurrentEvent(groupId).limit, 36);

  store.setLimit(groupId, 40); // admin manually bumps it for this one-off cycle
  assert.equal(store.getCurrentEvent(groupId).limit, 40);

  // Courts not respecified in this !newlist call - they carry forward...
  store.newList(groupId, '2026-08-20', {});
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courtCount, 6); // carried forward, unchanged
  // ...but the limit is NOT the stale manual override - it's freshly
  // recomputed from the carried-forward court count, same as if !courts
  // 13-18 had been retyped.
  assert.equal(event.limit, 36);
});

test('newList recomputes the limit even when the previous cycle had an explicit !limit off (no cap)', () => {
  const groupId = freshGroupId();
  store.setCourts(groupId, '1-4'); // 4 courts -> limit auto-scales to 24
  store.setLimit(groupId, null); // admin explicitly removes the cap

  store.newList(groupId, '2026-08-20', {});
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courtCount, 4); // carried forward, unchanged
  assert.equal(event.limit, 24); // court-based default reasserted, not null
});

test('newList leaves the limit carried forward as-is when no court count is known at all', () => {
  const groupId = freshGroupId();
  store.setLimit(groupId, 15); // no courts ever set for this group

  store.newList(groupId, '2026-08-20', {});
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courtCount, null);
  assert.equal(event.limit, 15); // nothing to scale against - carried forward unchanged
});

test('parseCourtCount handles ranges and comma lists, rejects invalid input', () => {
  assert.equal(store.parseCourtCount('13-18'), 6);
  assert.equal(store.parseCourtCount('1, 2, 5-8'), 6);
  assert.equal(store.parseCourtCount('not courts'), null);
});

test('getRegularPlayers: an unconfigured group has an empty roster, not an error', () => {
  const groupId = freshGroupId();
  assert.deepEqual(store.getRegularPlayers(groupId), []);
});

test('setRegularPlayers: replaces the whole roster and getRegularPlayers reflects it', () => {
  const groupId = freshGroupId();
  const result = store.setRegularPlayers(groupId, ['Peter', 'Chris', 'Linda']);
  assert.deepEqual(result, ['Peter', 'Chris', 'Linda']);
  assert.deepEqual(store.getRegularPlayers(groupId), ['Peter', 'Chris', 'Linda']);

  store.setRegularPlayers(groupId, ['Only Peter']);
  assert.deepEqual(store.getRegularPlayers(groupId), ['Only Peter']);
});

test('regularPlayers survives newList() and clearList() - it is not part of the current cycle', () => {
  const groupId = freshGroupId();
  store.setRegularPlayers(groupId, ['Peter', 'Chris']);

  store.newList(groupId, '2026-08-20', {});
  assert.deepEqual(store.getRegularPlayers(groupId), ['Peter', 'Chris']);

  store.clearList(groupId);
  assert.deepEqual(store.getRegularPlayers(groupId), ['Peter', 'Chris']);
});

test('getUndoSnapshot: null for a group with no saved undo point yet', () => {
  const groupId = freshGroupId();
  assert.equal(store.getUndoSnapshot(groupId), null);
});

test('getUndoableState: reflects current/history/regularPlayers as of right now', () => {
  const groupId = freshGroupId();
  store.addEntry(groupId, 'Peter', 'sender@s.whatsapp.net', false, true);
  store.setRegularPlayers(groupId, ['Chris']);

  const snapshot = store.getUndoableState(groupId);
  assert.deepEqual(snapshot.current.entries.map((e) => e.name), ['Peter']);
  assert.deepEqual(snapshot.regularPlayers, ['Chris']);
  assert.deepEqual(snapshot.history, []);
});

test('saveUndoSnapshot/getUndoSnapshot: round-trips a snapshot and its description', () => {
  const groupId = freshGroupId();
  const before = store.getUndoableState(groupId);
  store.addEntry(groupId, 'Peter', 'sender@s.whatsapp.net', false, true);

  store.saveUndoSnapshot(groupId, before, '!in Peter');
  const entry = store.getUndoSnapshot(groupId);
  assert.equal(entry.description, '!in Peter');
  assert.deepEqual(entry.snapshot.current.entries, []); // the pre-add snapshot, not current state
});

test('restoreUndoableState: overwrites current/history/regularPlayers wholesale from a snapshot, leaving undo itself alone', () => {
  const groupId = freshGroupId();
  const before = store.getUndoableState(groupId);
  store.addEntry(groupId, 'Peter', 'sender@s.whatsapp.net', false, true);
  store.setRegularPlayers(groupId, ['Chris']);
  store.saveUndoSnapshot(groupId, before, '!in Peter');

  store.restoreUndoableState(groupId, before);
  assert.deepEqual(store.getCurrentEvent(groupId).entries, []);
  assert.deepEqual(store.getRegularPlayers(groupId), []);
  // restoreUndoableState itself doesn't touch the undo slot - that's the
  // dispatch wrapper's job (commands/index.js), not this primitive's.
  assert.equal(store.getUndoSnapshot(groupId).description, '!in Peter');
});

// --- Tournament sub-feature (see commands/admin.js's !tournament/
// !tournamentlimit/!tournamentwinners, and commands/list.js's handleIn) ---

test('isTournamentEnabled: OFF by default (each group opts in individually), reflects setTournamentEnabled', () => {
  const groupId = freshGroupId();
  assert.equal(store.isTournamentEnabled(groupId), false);
  store.setTournamentEnabled(groupId, true);
  assert.equal(store.isTournamentEnabled(groupId), true);
  store.setTournamentEnabled(groupId, false);
  assert.equal(store.isTournamentEnabled(groupId), false);
});

test('getTournamentLimit/setTournamentLimit: null (no cap) by default, returns { limit, promoted }', () => {
  const groupId = freshGroupId();
  assert.equal(store.getTournamentLimit(groupId), null);
  assert.deepEqual(store.setTournamentLimit(groupId, 16), { limit: 16, promoted: [] });
  assert.equal(store.getTournamentLimit(groupId), 16);
  assert.deepEqual(store.setTournamentLimit(groupId, null), { limit: null, promoted: [] });
});

test('setTournamentLimit: raising the limit auto-promotes off the front of the (🏆 WL) queue, in order', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true); // in
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // WL'd - full
  store.addEntry(groupId, 'Wendy', 'wendy@s.whatsapp.net', false, true, true); // WL'd - full

  // Room for exactly one more - Bao (first in the queue) gets it, not Wendy.
  const { promoted } = store.setTournamentLimit(groupId, 2);
  assert.deepEqual(promoted.map((e) => e.name), ['Bao']);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Bao').tournamentWaitlisted, false);
  assert.equal(entries.find((e) => e.name === 'Wendy').tournament, false);
  assert.equal(entries.find((e) => e.name === 'Wendy').tournamentWaitlisted, true);

  // Clearing the cap entirely promotes everyone still queued.
  const { promoted: promotedAll } = store.setTournamentLimit(groupId, null);
  assert.deepEqual(promotedAll.map((e) => e.name), ['Wendy']);
  const entriesAfter = store.getCurrentEvent(groupId).entries;
  assert.equal(entriesAfter.find((e) => e.name === 'Wendy').tournament, true);
});

test('removeEntry: removing someone from the tournament frees a spot and auto-promotes the front of the (🏆 WL) queue', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true); // in
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // WL'd - full

  const result = store.removeEntry(groupId, 'Keith');
  assert.equal(result.ok, true);
  assert.deepEqual(result.tournamentPromoted.map((e) => e.name), ['Bao']);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Bao').tournamentWaitlisted, false);
});

test('removeEntry: removing someone NOT in the tournament does not touch the (🏆 WL) queue', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true); // in
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // WL'd - full
  store.addEntry(groupId, 'Wendy', 'wendy@s.whatsapp.net', false, true, false); // plain social, no ask

  const result = store.removeEntry(groupId, 'Wendy');
  assert.equal(result.ok, true);
  assert.deepEqual(result.tournamentPromoted, []);
  assert.equal(store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao').tournament, false);
});

test('getTournamentWinners/setTournamentWinners: null by default, round-trips a 2-element array', () => {
  const groupId = freshGroupId();
  assert.equal(store.getTournamentWinners(groupId), null);
  const result = store.setTournamentWinners(groupId, ['Irfan', 'Tu']);
  assert.deepEqual(result, ['Irfan', 'Tu']);
  assert.deepEqual(store.getTournamentWinners(groupId), ['Irfan', 'Tu']);
});

test('getTournamentRules/setTournamentRules: null by default, round-trips free text', () => {
  const groupId = freshGroupId();
  assert.equal(store.getTournamentRules(groupId), null);
  const result = store.setTournamentRules(groupId, 'Best of 3, single elimination');
  assert.equal(result, 'Best of 3, single elimination');
  assert.equal(store.getTournamentRules(groupId), 'Best of 3, single elimination');
});

test('addEntry: a wantsTournament=true entry is flagged tournament:true when enabled and under the limit', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  const result = store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  assert.equal(result.ok, true);
  const entry = store.getCurrentEvent(groupId).entries[0];
  assert.equal(entry.tournament, true);
});

test('addEntry: wantsTournament is ignored (tournament stays false) when the feature is disabled', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, false);
  const result = store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  assert.equal(result.ok, true);
  assert.equal(store.getCurrentEvent(groupId).entries[0].tournament, false);
});

test('addEntry: wantsTournament is ignored once the tournament limit is reached, but the person still joins socially, tagged (🏆 WL)', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  const second = store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true);
  assert.equal(second.ok, true);
  assert.equal(second.waitlisted, false); // still joins the social list...
  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Keith').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, false); // ...just not the tournament
  assert.equal(entries.find((e) => e.name === 'Bao').tournamentWaitlisted, true); // ...tagged instead
  assert.equal(entries.find((e) => e.name === 'Keith').tournamentWaitlisted, false);
});

test('addEntry: someone waitlisted (over the MAIN limit) never gets tournament:true, even if they asked', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true);
  const second = store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true);
  assert.equal(second.waitlisted, true);
  const waitlisted = store.getCurrentEvent(groupId).waitlist[0];
  assert.equal(waitlisted.tournament, false);
  // The (🏆 WL) tag is for tournament-full, not main-list-full - someone on
  // the real waitlist doesn't also get the tournament tag.
  assert.equal(waitlisted.tournamentWaitlisted, false);
});

test('joinTournament: opts an existing attendance entry in, subject to enabled/room/already-in checks', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, false);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true);

  // Not enabled yet.
  assert.deepEqual(store.joinTournament(groupId, 'Keith'), { ok: false, reason: 'disabled' });

  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  const joined = store.joinTournament(groupId, 'Keith');
  assert.equal(joined.ok, true);
  assert.equal(store.getCurrentEvent(groupId).entries[0].tournament, true);

  // Already in - a no-op, not an error.
  assert.deepEqual(store.joinTournament(groupId, 'Keith'), { ok: true, alreadyIn: true });

  // A second person can't fit under the limit of 1.
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true);
  assert.deepEqual(store.joinTournament(groupId, 'Bao'), { ok: false, reason: 'full' });
  assert.equal(store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao').tournamentWaitlisted, true);

  // Someone not on the list at all.
  assert.deepEqual(store.joinTournament(groupId, 'Nobody'), { ok: false, reason: 'not_found' });
});

test('joinTournament: (🏆 WL) tag clears on a later successful retry once room opens up', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true);

  let bao = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournamentWaitlisted, true);

  // Still full - repeated attempts keep the tag, no reason to clear it early.
  assert.deepEqual(store.joinTournament(groupId, 'Bao'), { ok: false, reason: 'full' });
  bao = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournamentWaitlisted, true);

  // Room opens up - a manual retry succeeds and clears the tag.
  store.setTournamentLimit(groupId, 2);
  const retry = store.joinTournament(groupId, 'Bao');
  assert.equal(retry.ok, true);
  bao = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournament, true);
  assert.equal(bao.tournamentWaitlisted, false);
});

test('joinTournament: only looks at entries, not the waitlist - a waitlisted person cannot opt in yet', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true); // waitlisted

  assert.deepEqual(store.joinTournament(groupId, 'Bao'), { ok: false, reason: 'not_found' });
});

test('leaveTournament: no matching entry at all', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true);

  assert.deepEqual(store.leaveTournament(groupId, 'Nobody'), { ok: false, reason: 'not_found' });
});

test('leaveTournament: already out (never opted in at all) is a no-op, not an error', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true); // plain social entry, never opted in

  assert.deepEqual(store.leaveTournament(groupId, 'Keith'), { ok: true, alreadyOut: true, promoted: [] });
  const keith = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Keith');
  assert.equal(keith.tournament, false);
  assert.equal(Boolean(keith.tournamentWaitlisted), false);
});

test('leaveTournament: someone only queued (🏆 WL), never an actual spot - clears the tag, no promotion (never occupied a spot)', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // full - queued instead

  let bao = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournamentWaitlisted, true);

  const result = store.leaveTournament(groupId, 'Bao');
  assert.deepEqual(result, { ok: true, promoted: [] });
  bao = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournament, false);
  assert.equal(bao.tournamentWaitlisted, false);
  // Keith's actual spot is untouched - Bao only ever occupied the queue.
  const keith = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Keith');
  assert.equal(keith.tournament, true);
});

test('leaveTournament: leaving an actual spot with nobody queued behind just frees it, no promotion', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);

  const result = store.leaveTournament(groupId, 'Keith');
  assert.deepEqual(result, { ok: true, promoted: [] });
  const keith = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Keith');
  assert.equal(keith.tournament, false);
  assert.equal(Boolean(keith.tournamentWaitlisted), false);
});

test('leaveTournament: leaving an actual spot promotes the front of the (🏆 WL) queue into it', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // queued, full
  store.addEntry(groupId, 'Han', 'han@s.whatsapp.net', false, true, true); // queued behind Bao, full

  const result = store.leaveTournament(groupId, 'Keith');
  assert.equal(result.ok, true);
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].name, 'Bao'); // front of the queue, not Han

  const bao = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournament, true);
  assert.equal(bao.tournamentWaitlisted, false);
  const han = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Han');
  assert.equal(han.tournament, false);
  assert.equal(han.tournamentWaitlisted, true); // still queued
  const keith = store.getCurrentEvent(groupId).entries.find((e) => e.name === 'Keith');
  assert.equal(keith.tournament, false);
});

test('newList: tournamentEnabled/tournamentLimit/tournamentRules carry forward, but entries (and their tournament flags) reset', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 16);
  store.setTournamentRules(groupId, 'Best of 3, single elimination');
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);

  store.newList(groupId, '2026-08-20', {});
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.tournamentEnabled, true);
  assert.equal(event.tournamentLimit, 16);
  assert.equal(event.tournamentRules, 'Best of 3, single elimination');
  assert.equal(event.entries.length, 0); // fresh cycle - nobody's opted in yet
});

test('newList: tournamentWinners is cleared, unlike every other tournament setting - it announces the cycle that just ended, not a standing setting', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentWinners(groupId, ['Irfan', 'Tu']);

  store.newList(groupId, '2026-08-20', {});
  assert.equal(store.getTournamentWinners(groupId), null);
});

test('setTournamentEnabled(false) does not clear entries\' tournament flags - they reappear if re-enabled', () => {
  const groupId = freshGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  assert.equal(store.getCurrentEvent(groupId).entries[0].tournament, true);

  store.setTournamentEnabled(groupId, false);
  assert.equal(store.getCurrentEvent(groupId).entries[0].tournament, true); // still remembered

  store.setTournamentEnabled(groupId, true);
  assert.equal(store.getCurrentEvent(groupId).entries[0].tournament, true);
});