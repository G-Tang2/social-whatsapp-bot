// store.js
// Simple JSON-file-backed persistence for the signup/attendance list.
//
// Each group's data is a "current" list (what !in/!out/!list operate on).
// An admin starting a new dated list (!newlist) discards whatever's
// currently active and starts a fresh, empty current list - only the
// current list is ever kept, nothing gets archived (see newList()'s own
// doc comment for what's carried forward vs dropped, and how this still
// stays undoable via the generic !undo mechanism below). `history` is a
// vestigial sibling field, always reset to empty by newList() - see its
// own doc comment - kept around only because getUndoableState()/
// restoreUndoableState() snapshot/restore the group's state generically
// without needing to know which fields are "live".
//
// `current.duePayments` tracks who still owes money: every time !newlist
// runs, everyone on the outgoing entries list gets carried into the new
// list's duePayments (they signed up for the thing that's now being billed
// for), merged with anyone already unpaid from before them so a debt never
// silently disappears just because another !newlist happened before they
// paid. !paid <name> removes someone from duePayments once they've paid.
//
// `current.duePaymentsLabel` is the header shown above that section (e.g.
// "$18 please"). Admins can change it with !paymentlabel; it carries forward to
// the next !newlist automatically if not respecified.
//
// Each entry also tracks `addedByIsAdmin` (was the adder a group admin at
// add time?) - historical, kept for existing data/tests; removeEntry() no
// longer restricts who can remove an entry based on it.
//
// `current.limit` is an optional max headcount for `entries` (null = no
// cap), seeded on brand-new groups from DEFAULT_LIMIT (6 unless overridden
// via the DEFAULT_LIMIT env var, used until real courts are known) and
// changeable any time by an admin with !limit. Once `courts` is actually
// (re)specified - via !courts, or the courts segment of !newlist - `limit`
// auto-scales to `courtCount * PLAYERS_PER_COURT` (6 people per court by
// default, e.g. 6 courts -> limit 36, 4 courts -> limit 24), overriding
// whatever it was before. An admin can still override the result any time
// with !limit; that manual value sticks until courts are next
// (re)specified, at which point it's recalculated again. While `entries`
// is at the cap, !in routes new signups into `current.waitlist` instead.
// Whenever a spot frees up - someone leaves the main list, an admin
// raises/clears the limit, or a fresh court count raises it - people are
// promoted off the front of the waitlist to fill it automatically (see
// promoteFromWaitlist()). Conversely, if a limit change (!limit, or a
// fresh court count) drops it BELOW the current headcount, the excess is
// demoted off the end of `entries` onto the front of `waitlist` -
// maintaining order both among the demoted group and ahead of anyone
// already waitlisted (see demoteToWaitlist()) - rather than just leaving
// the list silently over capacity. An admin can also explicitly override
// the cap with !allow <count> (see allowFromWaitlist()), which moves
// people up regardless of the current limit WITHOUT raising the limit
// itself - a one-off "let a couple extra in this time", after which
// attendance can sit above the limit until it naturally drains back down
// (removals won't auto-promote replacements while still at/over the
// limit). `duePaymentsLabel` carries forward to the next
// !newlist automatically as-is; `limit` is a bit different - every
// !newlist recomputes it from whatever court count the new list ends up
// with (whether that count was just respecified or simply carried
// forward unchanged), same as retyping !courts would, UNLESS no court
// count is known at all, in which case there's nothing to scale from and
// it carries forward as-is instead. In other words, a one-off manual
// !limit override (or an explicit !limit off) from a previous cycle does
// NOT survive into a new list once a real court count is involved -
// starting a fresh list is treated as "back to the venue's actual
// capacity" by default; run !limit again after !newlist if that cycle
// needs its own override too. `waitlist` does not carry forward at all -
// each new list starts with an empty one, and waitlisted people (never
// having gotten a confirmed spot) aren't carried into `duePayments` the
// way `entries` are.
//
// `current.location`, `current.courts`/`current.courtCount`, and
// `current.time` make up the rest of the list header (see
// formatEventHeader() in index.js for exactly how they're rendered).
// `location` and `time` are freeform text. `courts` is the raw text an
// admin typed (e.g. "13-18", or "1, 2, 5-8") - `courtCount` is the number
// of courts that works out to, computed by parseCourtCount() below (a
// dash-range like "13-18" counts as (end - start + 1); a comma-separated
// list sums each token). All three are optional, each independently
// settable any time (!location / !courts / !time, admins only) or all at
// once via !newlist, and all three carry forward to the next !newlist
// automatically if not respecified there - same "sticks until you change
// it" pattern as duePaymentsLabel/limit.
//
// Shape on disk (data/lists.json):
// {
//   "<groupId>": {
//     "current": {
//       "date": "2026-08-20" | null,
//       "location": "..." | null,
//       "courts": "13-18" | null,
//       "courtCount": 6 | null,
//       "time": "8PM start" | null,
//       "entries": [ { name, addedBy, addedByIsAdmin, addedAt }, ... ],
//       "limit": 20 | null,
//       "waitlist": [ { name, addedBy, addedByIsAdmin, addedAt }, ... ],
//       "duePayments": [ { name, addedBy, addedAt }, ... ],
//       "duePaymentsLabel": "$18 please"
//     },
//     "history": [] // vestigial - always reset empty by newList(), see the file-level comment above
//   },
//   ...
// }

// Concurrency note: every exported function in this file is fully
// synchronous (no async/await anywhere below) and does a fresh readAll()
// -> mutate -> writeAll() in one uninterruptible block. Because Node runs
// JS on a single thread, two "concurrent" callers (e.g. two commands
// arriving back-to-back from different group members) can never interleave
// their store calls - whichever call starts first always finishes (reading,
// mutating, AND writing) before the next one begins, and that next one
// always sees the fully-committed result of the first. This is what makes
// the read-modify-write cycle here safe without any explicit locking or a
// write queue. Adding `await` inside any of these functions (e.g. to swap
// in an async storage backend) would break that guarantee and reintroduce a
// real lost-update race - if that's ever needed, add an explicit per-group
// mutex/queue at the same time, don't assume the old synchronous safety
// still applies.

const fs = require('fs');
const path = require('path');
// Defensive: also loaded by lib/config.js (and, in the old monolithic
// index.js, by index.js itself), but this file reads process.env directly
// at module-load time below (DATA_DIR, PAYMENT_LABEL, DEFAULT_LIMIT) - so
// it loads .env itself too rather than depending on some other module
// having required dotenv first. Safe/idempotent to call more than once.
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'lists.json');
const DEFAULT_PAYMENT_LABEL = process.env.PAYMENT_LABEL || 'Payment';

// How many people count against the limit per court. Used to auto-scale
// `limit` whenever `courts` is (re)specified with a real value - see
// setCourts() and newList() below - e.g. 6 courts -> limit 36, 4 courts ->
// limit 24. Not currently exposed via an env var; edit this constant
// directly if a group needs a different ratio (e.g. doubles-only sessions).
const PLAYERS_PER_COURT = 6;

// DEFAULT_LIMIT seeds brand-new groups' participant cap before any real
// court count is known - admins can change it any time with !limit, same
// as PAYMENT_LABEL seeds duePaymentsLabel. Once courts are actually set,
// PLAYERS_PER_COURT takes over (see above).
// Unset/blank -> 6. "0"/"none"/"off"/"unlimited" -> no default cap. Anything
// else that doesn't parse to a positive whole number also falls back to 6.
function parseDefaultLimit(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') return 6;
  const normalized = raw.trim().toLowerCase();
  if (['0', 'none', 'off', 'unlimited'].includes(normalized)) return null;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 6;
}
const DEFAULT_LIMIT = parseDefaultLimit(process.env.DEFAULT_LIMIT);

// Sanity ceiling on the court headcount parseCourtCount() will accept. Now
// that a court count directly drives `limit` (courtCount * PLAYERS_PER_COURT
// - see setCourts()/newList()), a typo like "1-9999" needs to be rejected
// the same way !limit rejects an obviously-mistyped number, rather than
// silently producing a nonsense participant cap.
const MAX_COURT_COUNT = 100;

// Parses the court numbers an admin typed (e.g. "13-18", "5", or
// "1, 2, 5-8") into a headcount. Supports comma-separated tokens, each
// either a plain whole number (counts as 1) or a dash-range "start-end"
// (counts as end - start + 1, inclusive). Returns null if `raw` is empty,
// any token doesn't parse, or the total exceeds MAX_COURT_COUNT - callers
// should treat null as "invalid, reject the input" rather than "zero
// courts".
function parseCourtCount(raw) {
  if (typeof raw !== 'string') return null;
  const tokens = raw
    .trim()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return null;

  let count = 0;
  for (const token of tokens) {
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (end < start) return null;
      count += end - start + 1;
    } else if (/^\d+$/.test(token)) {
      count += 1;
    } else {
      return null;
    }
    if (count > MAX_COURT_COUNT) return null;
  }
  return count;
}

// Like parseCourtCount above, but expands the raw court text into the
// actual SET of individual court numbers it names, e.g. "13-18" ->
// {13,14,15,16,17,18}, "1, 2, 5-8" -> {1,2,5,6,7,8}. parseCourtCount just
// sums a headcount, which is all most callers need; this is for
// addCourts() below, which has to merge two court lists WITHOUT
// double-counting a number that appears in both (e.g. "add court 15" when
// 15 is already part of a booked "13-18" shouldn't grow the headcount - it
// was already included). Returns null under the same conditions
// parseCourtCount does (empty/invalid token/over MAX_COURT_COUNT).
function expandCourtNumbers(raw) {
  if (typeof raw !== 'string') return null;
  const tokens = raw
    .trim()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return null;

  const numbers = new Set();
  for (const token of tokens) {
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (end < start) return null;
      for (let n = start; n <= end; n += 1) numbers.add(n);
    } else if (/^\d+$/.test(token)) {
      numbers.add(Number(token));
    } else {
      return null;
    }
    if (numbers.size > MAX_COURT_COUNT) return null;
  }
  return numbers;
}

// The mirror of expandCourtNumbers() above - compacts a Set of court
// numbers back into the same kind of raw text an admin would type:
// consecutive runs collapse into a "start-end" range, standalone numbers
// stay as-is, all sorted ascending and comma-separated, e.g.
// {1,13,14,15,16,17,18} -> "1, 13-18". Used by addCourts() to turn its
// merged Set back into the display string current.courts actually stores.
function formatCourtNumbers(numbers) {
  const sorted = Array.from(numbers).sort((a, b) => a - b);
  const parts = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  }
}

function emptyGroupState() {
  return {
    current: {
      date: null,
      location: null,
      courts: null,
      courtCount: null,
      time: null,
      entries: [],
      limit: DEFAULT_LIMIT,
      waitlist: [],
      duePayments: [],
      duePaymentsLabel: DEFAULT_PAYMENT_LABEL,
      // Whether lib/vacancyReminder.js's two escalating low-signup
      // warnings have already fired for THIS list cycle - each is a
      // one-shot per list (not re-sent every time the periodic check
      // runs), and both reset to false whenever a fresh cycle starts (see
      // newList() below) - a new list is a fresh chance to fill up, so it
      // deserves its own fresh warning too.
      notifiedVacancy50h: false,
      notifiedVacancyCancelWarning: false,
      // Whether lib/autoNewlistScheduler.js's !autonewlist feature has
      // already started next week's list for THIS cycle - one-shot per
      // list, same reasoning/lifecycle as notifiedVacancy50h above (reset
      // to false whenever a fresh cycle starts via newList() below). See
      // markAutoNewlistCreated below.
      autoNewlistCreated: false,
    },
    history: [],
    // A saved roster of "regular players" for the group - see
    // getRegularPlayers/setRegularPlayers below and commands/admin.js's
    // !regulars. Deliberately lives here at the group-state top level
    // (a sibling of `current`/`history`), NOT inside `current` - unlike
    // everything in `current`, it should NOT be reset or archived away
    // every time !newlist starts a fresh cycle; it's meant to persist
    // indefinitely until an admin explicitly changes it.
    regularPlayers: [],
    // A saved roster of names an admin has marked as never needing to pay
    // (e.g. the organizer themselves, a sponsor, a coach) - see
    // getPaymentExempt/setPaymentExempt below and commands/admin.js's
    // !exempt. Same reasoning/lifecycle as `regularPlayers` immediately
    // above: lives at the group-state top level, NOT inside `current`,
    // since it's a standing admin decision that should survive every
    // !newlist/!clear, not something scoped to one cycle's list. Checked
    // by newList() below - a name on this roster is simply skipped when
    // the outgoing attendance list is carried into duePayments, so they
    // never end up owing anything in the first place. Deliberately
    // forward-looking only: adding someone here does NOT retroactively
    // remove any debt they already owe from before - see newList()'s own
    // doc comment for why.
    paymentExempt: [],
    // The specific person to @-mention if the group is still well short of
    // vacant spots as the social's start time closes in - see
    // !courtcanceller (commands/admin.js) and lib/vacancyReminder.js's
    // 26-hours-before check. `{ jid }` or null - same top-level,
    // persist-until-explicitly-changed lifecycle as regularPlayers/
    // paymentExempt above (a court-booking contact doesn't change every
    // list cycle), but a WhatsApp ID rather than a name: only ever set via
    // a genuine @-mention in the !courtcanceller message itself, never a
    // typed name - see that handler's own doc comment for why.
    courtCanceller: null,
    // A single-level "undo the last edit" slot - see getUndoableState/
    // restoreUndoableState/saveUndoSnapshot/getUndoSnapshot below and
    // commands/admin.js's !undo. Also a sibling of `current`/`history`
    // for the same reason as `regularPlayers`: it needs to survive being
    // the thing !newlist/!clear THEMSELVES are undoing, so it can't live
    // inside `current`. null until the first mutating command runs.
    undo: null,
  };
}

// Upgrades older on-disk shapes to the current one, in place, so existing
// installs never lose data:
//  - oldest: `all[groupId]` was a plain array of entries
//  - older: `all[groupId]` was `{ current, history }` but `current` had no
//    `duePayments` field yet (added when !paid/!newlist payment tracking
//    was introduced)
//  - older still: `current.duePayments` existed but `duePaymentsLabel`
//    didn't yet (added when !paymentlabel, then named !duelabel, was introduced)
//  - older still: no `limit`/`waitlist` yet (added when !limit was
//    introduced) - existing groups get seeded with DEFAULT_LIMIT (same as
//    a brand-new group) and an empty waitlist
//  - newest: the list header used to be `title` (freeform text, set via
//    !title/!newlist) - now it's `location`/`courts`/`courtCount`/`time`.
//    Old `title` values aren't reinterpreted as any of these (they're
//    semantically different - a title like "Saturday Football" isn't a
//    location), so `title` is just dropped and the new fields are seeded
//    null, same as a brand-new group. Archived `history` entries are left
//    untouched - old ones may still show a `title`, which is harmless.
function migrateIfNeeded(data) {
  let migrated = false;
  for (const groupId of Object.keys(data)) {
    if (Array.isArray(data[groupId])) {
      data[groupId] = {
        current: {
          date: null,
          location: null,
          courts: null,
          courtCount: null,
          time: null,
          entries: data[groupId],
          limit: DEFAULT_LIMIT,
          waitlist: [],
          duePayments: [],
          duePaymentsLabel: DEFAULT_PAYMENT_LABEL,
        },
        history: [],
      };
      migrated = true;
      continue;
    }
    if (data[groupId] && data[groupId].current) {
      if (!data[groupId].current.duePayments) {
        data[groupId].current.duePayments = [];
        migrated = true;
      }
      if (!data[groupId].current.duePaymentsLabel) {
        data[groupId].current.duePaymentsLabel = DEFAULT_PAYMENT_LABEL;
        migrated = true;
      }
      if (data[groupId].current.limit === undefined) {
        data[groupId].current.limit = DEFAULT_LIMIT;
        migrated = true;
      }
      if (!data[groupId].current.waitlist) {
        data[groupId].current.waitlist = [];
        migrated = true;
      }
      if (Object.prototype.hasOwnProperty.call(data[groupId].current, 'title')) {
        delete data[groupId].current.title;
        migrated = true;
      }
      if (data[groupId].current.location === undefined) {
        data[groupId].current.location = null;
        migrated = true;
      }
      if (data[groupId].current.courts === undefined) {
        data[groupId].current.courts = null;
        migrated = true;
      }
      if (data[groupId].current.courtCount === undefined) {
        data[groupId].current.courtCount = null;
        migrated = true;
      }
      if (data[groupId].current.time === undefined) {
        data[groupId].current.time = null;
        migrated = true;
      }
      if (data[groupId].current.notifiedVacancy50h === undefined) {
        data[groupId].current.notifiedVacancy50h = false;
        migrated = true;
      }
      if (data[groupId].current.notifiedVacancyCancelWarning === undefined) {
        data[groupId].current.notifiedVacancyCancelWarning = false;
        migrated = true;
      }
      if (data[groupId].current.autoNewlistCreated === undefined) {
        data[groupId].current.autoNewlistCreated = false;
        migrated = true;
      }
    }
  }
  return migrated;
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  let data;
  try {
    data = JSON.parse(raw || '{}');
  } catch (err) {
    console.error('[store] Corrupt data file, resetting.', err);
    data = {};
  }

  if (migrateIfNeeded(data)) {
    writeAll(data);
  }

  return data;
}

function writeAll(data) {
  ensureFile();
  // Atomic-ish write: write to temp file then rename, to avoid corruption
  // if the process is killed mid-write.
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function normalizeName(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getCurrentEvent(groupId) {
  const all = readAll();
  return (all[groupId] || emptyGroupState()).current;
}

function getList(groupId) {
  return getCurrentEvent(groupId).entries;
}

function getDuePayments(groupId) {
  return getCurrentEvent(groupId).duePayments || [];
}

function getDuePaymentsLabel(groupId) {
  return getCurrentEvent(groupId).duePaymentsLabel || DEFAULT_PAYMENT_LABEL;
}

// Sets the payment-due header for the group's current list. Persists and
// carries forward to future !newlist calls until changed again.
function setDuePaymentsLabel(groupId, label) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.duePaymentsLabel = label.trim();
  writeAll(all);
  return all[groupId].current.duePaymentsLabel;
}

// The group's saved "regular players" roster - see !regulars
// (commands/admin.js). `|| []` defensively covers a group whose data
// predates this field existing at all, same convention as the
// `if (!current.waitlist) current.waitlist = [];` fallbacks elsewhere in
// this file. Does NOT read from `current` and is untouched by newList()/
// clearList() - see emptyGroupState()'s comment for why it lives outside
// `current`.
function getRegularPlayers(groupId) {
  const all = readAll();
  return (all[groupId] || emptyGroupState()).regularPlayers || [];
}

// Replaces the ENTIRE regular-players roster with `names` (already
// trimmed/validated by the caller - see commands/admin.js's handleRegulars,
// which is also where add/remove/clear semantics are implemented, on top
// of this single "set the whole list" primitive). Returns the new list.
function setRegularPlayers(groupId, names) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].regularPlayers = names;
  writeAll(all);
  return all[groupId].regularPlayers;
}

// The group's saved "never needs to pay" roster - see !exempt
// (commands/admin.js). `|| []` defensively covers a group whose data
// predates this field existing at all, same convention as
// getRegularPlayers above (which this mirrors exactly - same lifecycle,
// same reasoning for living outside `current`). Checked by newList()
// below, NOT by markPaid()/applyListUpdate() - once someone's actually on
// the payment-due list (whether from before they were exempted, or typed
// in by hand via !update), this roster doesn't retroactively clear it;
// see newList()'s own doc comment for why.
function getPaymentExempt(groupId) {
  const all = readAll();
  return (all[groupId] || emptyGroupState()).paymentExempt || [];
}

// Replaces the ENTIRE payment-exempt roster with `names` (already
// trimmed/validated by the caller - see commands/admin.js's handleExempt,
// which is also where add/remove/clear semantics are implemented, on top
// of this single "set the whole list" primitive - same split as
// setRegularPlayers/handleRegulars above). Returns the new list.
function setPaymentExempt(groupId, names) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].paymentExempt = names;
  writeAll(all);
  return all[groupId].paymentExempt;
}

// The group's saved court-cancellation contact - see !courtcanceller
// (commands/admin.js) and lib/vacancyReminder.js. `|| null` defensively
// covers a group whose data predates this field, same convention as
// getRegularPlayers/getPaymentExempt above. Returns `{ jid }` or null.
function getCourtCanceller(groupId) {
  const all = readAll();
  return (all[groupId] || emptyGroupState()).courtCanceller || null;
}

// Sets (or clears, with `canceller: null`) the group's court-cancellation
// contact - see !courtcanceller (commands/admin.js), which is also where
// the @-mention is turned into `{ jid }` in the first place.
function setCourtCanceller(groupId, canceller) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].courtCanceller = canceller;
  writeAll(all);
  return all[groupId].courtCanceller;
}

// Marks the CURRENT list's 50-hours-before "plenty of spots, sign up or
// courts may be cancelled" group-wide warning as sent - see
// lib/vacancyReminder.js, which checks this (via getCurrentEvent's
// notifiedVacancy50h) before sending, so the warning fires AT MOST ONCE
// per list cycle regardless of how often the periodic check runs. Reset
// back to false by newList() below, same as
// markVacancyCancelWarningNotified.
function markVacancy50hNotified(groupId) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.notifiedVacancy50h = true;
  writeAll(all);
}

// Same as markVacancy50hNotified above, for the 26-hours-before
// court-cancellation warning sent to whoever !courtcanceller designates.
function markVacancyCancelWarningNotified(groupId) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.notifiedVacancyCancelWarning = true;
  writeAll(all);
}

// Marks the CURRENT list as having already had next week's list
// auto-started - see lib/autoNewlistScheduler.js, which checks this (via
// getCurrentEvent's autoNewlistCreated) before acting, so it fires AT MOST
// ONCE per list cycle regardless of how often the periodic check runs.
// Reset back to false by newList() below, same as markVacancy50hNotified.
function markAutoNewlistCreated(groupId) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.autoNewlistCreated = true;
  writeAll(all);
}

// --- Undo support (see commands/admin.js's !undo) ---
//
// The general approach: BEFORE any command that might mutate a group's
// data runs, commands/index.js's dispatch wrapper snapshots everything
// !undo could plausibly need to restore (getUndoableState below), lets
// the command run, then compares before-vs-after - if anything actually
// changed, that "before" snapshot is saved as the new undo target
// (saveUndoSnapshot). !undo itself just reads that snapshot back
// (getUndoSnapshot) and writes it back wholesale (restoreUndoableState).
//
// This is deliberately a single-level undo, not a full history stack -
// "undo the previous edit" (singular), not "undo the last N edits". A
// second consecutive !undo doesn't stack further back in time; because
// !undo is itself run through the exact same before/after wrapper as
// every other command, running it AGAIN naturally re-snapshots the
// state !undo just replaced and restores THAT instead - so !undo doubles
// as a toggle/redo (undo, undo again to redo, undo again to un-redo,
// ...) as an emergent property of the generic mechanism, not anything
// special-cased here.
//
// Whole-state snapshotting (rather than hand-writing a specific inverse
// for every single command - "undo !newlist by un-archiving history and
// restoring the old current", "undo !clear by restoring entries", ...)
// is deliberate: !newlist/!update/!clear all touch multiple
// interdependent fields at once (current, history, duePayments...) in
// ways that would be easy to get subtly wrong with per-command inverses.
// Snapshotting everything once and restoring it wholesale is correct by
// construction for any command, present or future, without needing to
// know what that command actually did.

// Returns a deep, independent snapshot of everything !undo can restore -
// the current list, history, saved regular-players roster, saved
// payment-exempt roster, and saved court-cancellation contact - as of
// right now. Every store.js accessor already returns a fresh object from a
// fresh JSON.parse of the data file on each call (see readAll() above -
// there's no long-lived in-memory cache to worry about aliasing with), so
// this is purely a convenience that reads all five in one go rather than
// five separate calls. Deliberately does NOT include `undo` itself - see
// the file-level comment above for why that's tracked outside of what
// gets snapshotted.
function getUndoableState(groupId) {
  const all = readAll();
  const state = all[groupId] || emptyGroupState();
  return {
    current: state.current,
    history: state.history,
    regularPlayers: state.regularPlayers || [],
    paymentExempt: state.paymentExempt || [],
    courtCanceller: state.courtCanceller || null,
  };
}

// Overwrites the group's current/history/regularPlayers/paymentExempt/
// courtCanceller wholesale from a snapshot previously returned by
// getUndoableState() - the actual "restore" half of !undo. Leaves `undo`
// itself untouched - the dispatch wrapper (commands/index.js) is what
// updates that, generically, exactly as it would for any other command
// that changes something (see the file-level comment above for why
// running !undo again then acts as a redo).
function restoreUndoableState(groupId, snapshot) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current = snapshot.current;
  all[groupId].history = snapshot.history;
  all[groupId].regularPlayers = snapshot.regularPlayers;
  all[groupId].paymentExempt = snapshot.paymentExempt !== undefined ? snapshot.paymentExempt : [];
  all[groupId].courtCanceller = snapshot.courtCanceller !== undefined ? snapshot.courtCanceller : null;
  writeAll(all);
}

// Records `snapshot` (see getUndoableState) as the new undo target, along
// with a short human-readable `description` of the command that's about
// to make it stale (e.g. "!clear" or "!in Peter, Chris") - shown back by
// !undo as confirmation of what it just reversed. Called by
// commands/index.js's dispatch wrapper, never directly by a command
// handler.
function saveUndoSnapshot(groupId, snapshot, description) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].undo = { snapshot, description };
  writeAll(all);
}

// The current undo target, or null if there's nothing to undo yet (a
// brand-new group, or one where no command has ever actually changed
// anything).
function getUndoSnapshot(groupId) {
  const all = readAll();
  const state = all[groupId] || emptyGroupState();
  return state.undo || null;
}

// Corrects the date on the group's CURRENT list - e.g. an admin typo'd
// "20/08" instead of "27/08" in !newlist, or the session got moved to a
// different day after the fact. Unlike !newlist, this does NOT archive
// anything or touch entries/waitlist/duePayments/location/courts/time/
// limit - it's purely a fix to the one field, same "change it any time"
// spirit as setLocation/setCourts/setTime below. `isoDate` is expected
// already-resolved/validated (see dates.js's parseTypedDate - the caller,
// commands/admin.js's handleDate, resolves the typed "DD/MM" text before
// calling this, same division of labor as newList()).
function setDate(groupId, isoDate) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.date = isoDate;
  writeAll(all);
  return all[groupId].current.date;
}

// Sets the location for the group's current list. Persists and carries
// forward to future !newlist calls until changed again (same "carries
// forward if you don't respecify it" pattern as duePaymentsLabel/limit) -
// can be changed any time, not just when starting a new list. An empty
// string clears it back to unset.
function setLocation(groupId, location) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const trimmed = location.trim();
  all[groupId].current.location = trimmed || null;
  writeAll(all);
  return all[groupId].current.location;
}

// Sets the courts for the group's current list from raw admin-typed text
// (e.g. "13-18" or "1, 2, 5-8"), computing courtCount via parseCourtCount().
// Same carry-forward/any-time-editable behavior as setLocation. Returns
// { ok: false } without writing anything if `raw` doesn't parse (an empty
// string is valid input, though - it clears the field back to unset).
//
// Setting a real (non-empty) court value also auto-scales `limit` to
// `courtCount * PLAYERS_PER_COURT`, same as newList() does when courts are
// specified there - see the `current.limit` doc comment at the top of this
// file. A higher limit can free up room (promotes off the waitlist, like
// setLimit()); a lower one can push current headcount over the new limit
// (demotes the excess onto the waitlist, like setLimit() - see
// demoteToWaitlist()) - the returned `promoted`/`demoted` arrays list
// anyone that happened to, either possibly empty. Clearing courts (empty
// string) leaves `limit` untouched.
function setCourts(groupId, raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    const all = readAll();
    if (!all[groupId]) all[groupId] = emptyGroupState();
    const current = all[groupId].current;
    current.courts = null;
    current.courtCount = null;
    writeAll(all);
    return { ok: true, courts: null, courtCount: null, limit: current.limit, promoted: [], demoted: [] };
  }

  const count = parseCourtCount(trimmed);
  if (count === null) return { ok: false };

  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.waitlist) current.waitlist = [];
  current.courts = trimmed;
  current.courtCount = count;
  current.limit = count * PLAYERS_PER_COURT;
  const promoted = promoteFromWaitlist(current);
  const demoted = demoteToWaitlist(current);
  writeAll(all);
  return { ok: true, courts: trimmed, courtCount: count, limit: current.limit, promoted, demoted };
}

// Adds MORE courts to whatever's already booked, instead of REPLACING them
// like setCourts() above does - e.g. courts are currently "13-18" and an
// admin says "add court 1" (or, via the natural-language AI command
// feature, something like "I got extra courts 12-14" - see
// lib/geminiCommand.js and commands/admin.js's handleCourts) and the
// result is "1, 13-18", not just "1". Implemented by expanding both the
// existing and the new court text into actual Sets of court numbers (see
// expandCourtNumbers()/formatCourtNumbers() above) and unioning them,
// rather than just concatenating the raw text - a number already present
// (e.g. "add court 15" when 15 is already part of "13-18") is a no-op for
// that number, not double-counted, since restating an already-booked court
// is a reasonable thing to say and shouldn't inflate the headcount. If
// nothing's booked yet, this is equivalent to setCourts() with the same
// text (the union of an empty set and the new numbers is just the new
// numbers).
//
// Same auto-scaled-`limit`/promote/demote behavior as setCourts() once the
// merged total is known - see its doc comment above for the reasoning.
// Returns { ok: false } if `additionalRaw` doesn't parse (or is empty - use
// setCourts('') to clear courts instead, this isn't the right call for
// that), or if the MERGED total would exceed MAX_COURT_COUNT even if
// `additionalRaw` alone was within it; otherwise { ok: true, courts,
// courtCount, limit, added, promoted, demoted } - `added` lists just the
// NEWLY added numbers (for the caller's reply), which can be empty if
// every number given was already booked.
function addCourts(groupId, additionalRaw) {
  const trimmed = (additionalRaw || '').trim();
  if (!trimmed) return { ok: false };

  const additional = expandCourtNumbers(trimmed);
  if (!additional) return { ok: false };

  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.waitlist) current.waitlist = [];

  const existing = current.courts ? (expandCourtNumbers(current.courts) || new Set()) : new Set();
  const merged = new Set([...existing, ...additional]);
  if (merged.size > MAX_COURT_COUNT) return { ok: false };

  const added = [...additional].filter((n) => !existing.has(n));

  current.courts = formatCourtNumbers(merged);
  current.courtCount = merged.size;
  current.limit = merged.size * PLAYERS_PER_COURT;
  const promoted = promoteFromWaitlist(current);
  const demoted = demoteToWaitlist(current);
  writeAll(all);
  return { ok: true, courts: current.courts, courtCount: current.courtCount, limit: current.limit, added, promoted, demoted };
}

// Sets the time text for the group's current list (freeform, e.g.
// "8PM start"). Same carry-forward/any-time-editable/empty-clears behavior
// as setLocation.
function setTime(groupId, time) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const trimmed = time.trim();
  all[groupId].current.time = trimmed || null;
  writeAll(all);
  return all[groupId].current.time;
}

function getLimit(groupId) {
  const limit = getCurrentEvent(groupId).limit;
  return limit === undefined ? DEFAULT_LIMIT : limit;
}

// Moves people off the front of the waitlist into `entries`, one at a time,
// until either the waitlist is empty or `entries` hits the limit again
// (no-op if there's no limit or no waitlist). Mutates `current` in place
// and returns the entries that got promoted, so callers can mention them.
// Called whenever a spot might have opened up: someone leaves the main
// list, or an admin raises/clears the limit.
function promoteFromWaitlist(current) {
  if (!current.waitlist) current.waitlist = [];
  const promoted = [];
  while (
    current.waitlist.length > 0 &&
    (current.limit === null || current.limit === undefined || current.entries.length < current.limit)
  ) {
    const next = current.waitlist.shift();
    current.entries.push(next);
    promoted.push(next);
  }
  return promoted;
}

// The opposite direction: if `entries` is now OVER the limit (an admin
// lowered !limit, or a freshly-specified !courts count computes a smaller
// limit, below the current headcount), moves the excess off the END of
// `entries` onto the FRONT of `waitlist` - i.e. the most recently joined
// lose their spot first. Order is preserved on both sides: the demoted
// entries keep their relative order among themselves, and go ahead of
// anyone already waitlisted, since they had a confirmed spot moments ago
// and so get first claim if the limit rises again. No-op if there's no
// limit or entries aren't over it. Mutates `current` in place and returns
// the entries that got demoted, so callers can mention them.
function demoteToWaitlist(current) {
  if (!current.waitlist) current.waitlist = [];
  if (current.limit === null || current.limit === undefined) return [];
  if (current.entries.length <= current.limit) return [];

  const excessCount = current.entries.length - current.limit;
  const demoted = current.entries.splice(current.entries.length - excessCount, excessCount);
  current.waitlist = [...demoted, ...current.waitlist];
  return demoted;
}

// Sets the max headcount for the group's current list (null removes the
// cap). Persists and carries forward to future !newlist calls, same as
// duePaymentsLabel/location/courts/time. Raising the limit (or clearing it)
// can free up room, so this also promotes off the waitlist to fill any
// newly available spots; lowering it below the current headcount instead
// demotes the excess onto the waitlist (see demoteToWaitlist()) - only one
// of the two can ever apply for a given change, so it's safe to always
// attempt both. Returns { limit, promoted, demoted }, either array possibly
// empty, so callers can mention whichever happened.
function setLimit(groupId, limit) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  current.limit = limit;
  const promoted = promoteFromWaitlist(current);
  const demoted = demoteToWaitlist(current);
  writeAll(all);
  return { limit: current.limit, promoted, demoted };
}

/**
 * Admin override: moves up to `count` people off the FRONT of the waitlist
 * straight onto the main list, bypassing the current limit entirely (unlike
 * promoteFromWaitlist, which stops at the limit) - as a one-off "let a
 * couple extra in this time" without touching what the real limit is.
 *
 * Deliberately does NOT raise `limit` to match - the limit stays exactly
 * what it was (e.g. still 30, even though attendance is now 32), so
 * attendance can end up temporarily over it. That's intentional: since
 * promoteFromWaitlist() (used by !out and by !limit/!courts raising the
 * cap) only promotes while entries.length < limit, being over the limit
 * means removals won't auto-promote anyone off the waitlist to "refill"
 * the spot an !allow'd-in person freed up - attendance just drains back
 * down toward the real limit first. Once it's genuinely back under the
 * limit, normal auto-promotion on removal resumes as regular. Compare
 * !limit <bigger number>, which DOES raise the real limit and so DOES
 * auto-promote both immediately (to fill the new spots) and on later
 * removals.
 *
 * If the waitlist has fewer than `count` people, moves everyone available
 * rather than erroring - callers can tell from `moved.length < count`.
 * Returns { moved, limit } - `moved` lists who came off the waitlist;
 * `limit` is just the current (unchanged) limit, returned for convenience.
 */
function allowFromWaitlist(groupId, count) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.waitlist) current.waitlist = [];

  const n = Math.min(count, current.waitlist.length);
  const moved = [];
  for (let i = 0; i < n; i++) {
    const next = current.waitlist.shift();
    current.entries.push(next);
    moved.push(next);
  }

  writeAll(all);
  return { moved, limit: current.limit };
}

/**
 * Adds an entry to a group's current list - or, if the list is already at
 * its !limit, onto the waitlist instead (see `waitlisted` on the return
 * value). A name can't appear on both at once, so the duplicate check spans
 * both lists.
 * `addedByIsAdmin` records whether the adder was a group admin at the
 * moment they added this entry - historical, kept for existing data/tests;
 * no longer affects who's allowed to remove it (see removeEntry).
 * `selfAdded` records whether this entry IS the sender themselves (true
 * only for the bare `!in`/`!in paid` self-add path in commands/list.js -
 * false for every explicitly-typed name, even if it happens to equal the
 * sender's own display name, and even if the sender IS the one typing it).
 * This is deliberately a SEPARATE concept from `addedBy`: `addedBy` always
 * records who ran the command (used for removal authorization), while
 * `self` records whether that person was signing THEMSELVES up, not
 * someone else - e.g. after `!in Peter, Chris, Linda`, all three entries
 * have `addedBy` set to the sender's ID (so the sender can remove them
 * later) but `self: false` (so the sender isn't mistaken for being "Peter,
 * Chris, and Linda" the next time they run a bare `!in`/`!out`/`!paid` to
 * look themselves up - see those bare-lookup call sites in
 * commands/list.js, which all check `self !== false` rather than just
 * `addedBy === senderId`). Left unset (undefined) on entries created
 * before this field existed - `!== false` treats that the same as `true`,
 * preserving old behavior for already-persisted data instead of silently
 * "losing" people's own entries across an upgrade.
 *
 * Returns { ok: true, list, waitlist, waitlisted } on success, or
 * { ok: false, reason } if it's a duplicate.
 */
function addEntry(groupId, name, addedBy, addedByIsAdmin, selfAdded) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.waitlist) current.waitlist = [];
  const normalized = normalizeName(name);

  const existsOnList = current.entries.some((entry) => normalizeName(entry.name) === normalized);
  const existsOnWaitlist = current.waitlist.some((entry) => normalizeName(entry.name) === normalized);
  if (existsOnList || existsOnWaitlist) {
    return { ok: false, reason: 'duplicate', list: current.entries, waitlist: current.waitlist };
  }

  const entry = {
    name: name.trim(),
    addedBy,
    addedByIsAdmin: !!addedByIsAdmin,
    addedAt: new Date().toISOString(),
    self: !!selfAdded,
  };

  const atCapacity = current.limit !== null && current.limit !== undefined && current.entries.length >= current.limit;
  if (atCapacity) {
    current.waitlist.push(entry);
  } else {
    current.entries.push(entry);
  }
  writeAll(all);
  return { ok: true, list: current.entries, waitlist: current.waitlist, waitlisted: atCapacity };
}

/**
 * Removes an entry by (case-insensitive) name match from the current list
 * OR the waitlist (checked in that order). Anyone can remove any entry -
 * there's no restriction based on who added it or who's trying to remove
 * it.
 *
 * Removing someone from the main list (not the waitlist) frees a spot, so
 * this also promotes off the front of the waitlist to fill it - the
 * returned `promoted` array lists anyone that happened to.
 */
function removeEntry(groupId, name) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.waitlist) current.waitlist = [];
  const normalized = normalizeName(name);

  let fromWaitlist = false;
  let list = current.entries;
  let idx = list.findIndex((entry) => normalizeName(entry.name) === normalized);
  if (idx === -1) {
    fromWaitlist = true;
    list = current.waitlist;
    idx = list.findIndex((entry) => normalizeName(entry.name) === normalized);
  }
  if (idx === -1) {
    return { ok: false, reason: 'not_found', list: current.entries, waitlist: current.waitlist };
  }

  list.splice(idx, 1);
  const promoted = fromWaitlist ? [] : promoteFromWaitlist(current);
  writeAll(all);
  return { ok: true, list: current.entries, waitlist: current.waitlist, promoted };
}

/**
 * Bulk-reconciles the current list against a parsed copy-pasted edit (see
 * lib/listParser.js's parseListSections()) - powers !update. `parsed` is
 * { attendance: string[], waitlist: string[], duePayments: string[] }, each
 * name array already in the editor's intended final order for that section.
 *
 * For each of the three sections, independently:
 *  - a name that already exists somewhere in the CURRENT attendance/
 *    waitlist (for the first two) or duePayments (for the third) keeps its
 *    original entry object - `addedBy`/`addedByIsAdmin`/`addedAt` all
 *    preserved - but adopts its new section/position. This is what lets
 *    moving a name from Waitlist to Attendance in the edited text actually
 *    promote them, with their original metadata intact rather than being
 *    reset.
 *  - a name that's brand new (wasn't anywhere in the relevant current
 *    list(s) before) gets a fresh entry attributed to the editor
 *    (`editorId`/`editorIsAdmin`) - same as if the editor had typed
 *    !in <name> themselves, since a hand-typed name in pasted text has no
 *    other WhatsApp identity to attribute it to.
 *  - a name that WAS in the current attendance/waitlist (or duePayments)
 *    but doesn't appear anywhere in the corresponding edited section(s) at
 *    all is dropped - equivalent to !out (or !paid for duePayments).
 *
 * A name appearing more than once across attendance+waitlist in the edited
 * text is kept only in the FIRST section it appears in (attendance takes
 * priority over waitlist) - same "can't be in two places at once"
 * invariant addEntry() already enforces elsewhere. Same idea for
 * duePayments, independently (it's a separate list, not exclusive with
 * attendance/waitlist - someone can be both attending and still owing from
 * a prior cycle).
 *
 * Deliberately does NOT re-run limit-based promotion/demotion - the
 * editor's explicit attendance/waitlist placement is treated as
 * authoritative (same spirit as !allow overriding the cap), even if the
 * resulting attendance headcount ends up over or under `limit`. Callers
 * should surface that mismatch to the editor if it happens (see
 * handleUpdate in commands/admin.js), not have store.js silently correct
 * it out from under them.
 *
 * Returns a summary: { added, removed, moved, paidAdded, paidRemoved } -
 * `added`/`removed` list plain names (attendance+waitlist combined),
 * `moved` lists { name, from, to } for names that changed section, and
 * `paidAdded`/`paidRemoved` cover the payment section the same way.
 */
function applyListUpdate(groupId, parsed, editorId, editorIsAdmin) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.waitlist) current.waitlist = [];
  if (!current.duePayments) current.duePayments = [];

  // Index every existing attendance/waitlist entry by normalized name,
  // remembering which section it was in, so a kept name can carry its
  // original metadata forward regardless of which section it ends up in.
  const existingByName = new Map();
  for (const entry of current.entries) {
    existingByName.set(normalizeName(entry.name), { entry, from: 'attendance' });
  }
  for (const entry of current.waitlist) {
    existingByName.set(normalizeName(entry.name), { entry, from: 'waitlist' });
  }

  const claimed = new Set(); // normalized names already placed somewhere in the new lists
  const added = [];
  const removed = [];
  const moved = [];

  function resolveSection(names, sectionLabel) {
    const result = [];
    for (const rawName of names) {
      const trimmed = (rawName || '').trim();
      if (!trimmed) continue;
      const normalized = normalizeName(trimmed);
      if (claimed.has(normalized)) continue; // duplicate within this update - first placement wins
      claimed.add(normalized);

      const existing = existingByName.get(normalized);
      if (existing) {
        result.push(existing.entry); // keep original name casing + metadata
        if (existing.from !== sectionLabel) {
          moved.push({ name: existing.entry.name, from: existing.from, to: sectionLabel });
        }
      } else {
        result.push({
          name: trimmed,
          addedBy: editorId,
          addedByIsAdmin: !!editorIsAdmin,
          addedAt: new Date().toISOString(),
          // Explicitly not-self: !update is the editor organizing the
          // whole roster, not signing themselves up - see addEntry's doc
          // comment on `self`. Otherwise the editor's own next bare !in
          // could wrongly think they're already on as everyone they just
          // typed into the pasted list.
          self: false,
        });
        added.push(trimmed);
      }
    }
    return result;
  }

  const newEntries = resolveSection(parsed.attendance || [], 'attendance');
  const newWaitlist = resolveSection(parsed.waitlist || [], 'waitlist');

  // Anyone who existed before (attendance or waitlist) but wasn't claimed
  // by either new list at all is a removal.
  for (const [normalized, { entry }] of existingByName) {
    if (!claimed.has(normalized)) removed.push(entry.name);
  }

  current.entries = newEntries;
  current.waitlist = newWaitlist;

  // Payment section: same keep-metadata-if-existing, attribute-to-editor-
  // if-new reconciliation, independent of attendance/waitlist above.
  //
  // A name can legitimately appear MORE THAN ONCE now - once per event it
  // owes for (see newList()'s doc comment) - so unlike attendance/waitlist
  // above, this can't just be a name->single-entry Map; it's a
  // name->QUEUE of that name's existing entries, each consumed (in
  // existing-array order) by the first pasted-back occurrence of that name
  // that claims it, so every individual entry's own addedBy/etc. metadata
  // survives the round-trip correctly rather than only the first occurrence
  // keeping it and the rest being treated as brand new. A pasted name with
  // MORE occurrences than existing entries for it (e.g. hand-adding a
  // second debt for someone who only had one) creates a fresh entry for the
  // extra occurrence(s) - same as any other brand-new payment name. A
  // pasted name with FEWER occurrences than it actually has entries for (or
  // the name missing entirely) leaves the leftover, unclaimed entries in
  // the queue - each one counted as paidRemoved below, same "not present in
  // the paste = removed" rule attendance/waitlist already follow.
  //
  // Each pasted item is either a plain string (a bare name, no date-group
  // signal at all - the shape every direct caller other than
  // lib/listParser.js's parseListSections() still uses) or an
  // { name, owedSince? } object (parseListSections' own shape - see that
  // function's doc comment). `hasOwedSince` below distinguishes "the paste
  // carried no date-group info for this entry at all" (a plain string, or
  // an object with the key altogether missing) - in which case a kept
  // entry's existing owedSince is left completely untouched, same as before
  // this feature existed - from "the paste explicitly placed this entry
  // under a date group" (object WITH the key, even if its value is
  // null/undefined for "*No date*") - in which case that's applied as an
  // edit, same "your edit is final" philosophy as the header-field block
  // above: a kept entry's owedSince gets overwritten (cleared, if the group
  // was "No date"), and a brand-new entry starts with that owedSince
  // instead of none.
  const existingDueByName = new Map();
  for (const entry of current.duePayments) {
    const normalized = normalizeName(entry.name);
    if (!existingDueByName.has(normalized)) existingDueByName.set(normalized, []);
    existingDueByName.get(normalized).push(entry);
  }
  const paidAdded = [];
  const paidRemoved = [];
  const newDue = [];
  for (const rawItem of parsed.duePayments || []) {
    const item = typeof rawItem === 'string' ? { name: rawItem } : (rawItem || {});
    const trimmed = (item.name || '').trim();
    if (!trimmed) continue;
    const normalized = normalizeName(trimmed);
    const hasOwedSince = Object.prototype.hasOwnProperty.call(item, 'owedSince');
    const queue = existingDueByName.get(normalized);
    if (queue && queue.length) {
      const existingEntry = queue.shift();
      newDue.push(hasOwedSince ? { ...existingEntry, owedSince: item.owedSince || undefined } : existingEntry);
    } else {
      const newEntry = {
        name: trimmed,
        addedBy: editorId,
        addedByIsAdmin: !!editorIsAdmin,
        addedAt: new Date().toISOString(),
        self: false,
      };
      if (hasOwedSince && item.owedSince) newEntry.owedSince = item.owedSince;
      newDue.push(newEntry);
      paidAdded.push(trimmed);
    }
  }
  for (const queue of existingDueByName.values()) {
    for (const entry of queue) paidRemoved.push(entry.name);
  }
  current.duePayments = newDue;

  writeAll(all);
  return { added, removed, moved, paidAdded, paidRemoved };
}

// Wipes the current list's entries AND waitlist in place - same date/
// location/courts/time, fresh names. Both together, since a leftover
// waitlist for an emptied-out list doesn't mean anything. Deliberately does
// NOT touch duePayments - clearing who's coming shouldn't erase a record of
// who still owes money from before.
function clearList(groupId) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.entries = [];
  all[groupId].current.waitlist = [];
  writeAll(all);
  return all[groupId].current.entries;
}

// Wipes the current duePayments list in place - forgives everyone still
// owing money, without touching entries/waitlist or any other list state.
// The inverse of clearList()'s guarantee: that one deliberately leaves
// duePayments alone, this one deliberately leaves everything else alone.
// Irreversible, same as clearList - no archive/undo.
function clearDuePayments(groupId) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.duePayments = [];
  writeAll(all);
  return all[groupId].current.duePayments;
}

/**
 * Marks someone as paid, removing them from the current duePayments list.
 * No ownership restriction - anyone in the group can mark anyone paid
 * (whoever collects the money isn't necessarily the person who signed them
 * up, or an admin).
 *
 * Since newList() can now leave the SAME name with more than one entry at
 * once (owing separately for two or more missed cycles - see newList()'s
 * doc comment), this clears EVERY entry matching `name`, not just the
 * first one found - "mark Alex as paid" means Alex is all settled up, not
 * "settle just one of however many things Alex happens to owe for". The
 * returned `count` is how many entries that actually removed, so a caller
 * can tell "cleared one payment" from "cleared three at once" if it wants
 * to.
 */
function markPaid(groupId, name) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.duePayments) current.duePayments = [];
  const normalized = normalizeName(name);

  const before = current.duePayments.length;
  current.duePayments = current.duePayments.filter((entry) => normalizeName(entry.name) !== normalized);
  const count = before - current.duePayments.length;
  if (count === 0) {
    return { ok: false, reason: 'not_found', duePayments: current.duePayments };
  }

  writeAll(all);
  return { ok: true, count, duePayments: current.duePayments };
}

// Starts a brand new dated list. The outgoing list itself is NOT archived
// anywhere - only the current list is ever kept, and `history` is reset to
// empty right along with it (wiping out any old archived lists too, so
// this also cleans up whatever an older build of the bot may have left
// behind - an admin never has to remember to clear that out by hand). This
// is a completely ordinary state mutation, not special-cased against
// !undo: like every other mutating command, !newlist runs through the
// generic before/after wrapper (commands/index.js's withUndoTracking, via
// getUndoableState/restoreUndoableState/saveUndoSnapshot below), which
// snapshots `history` right along with `current` - so an admin who runs
// !newlist by mistake can still !undo it, restoring the exact old current
// list (and whatever history existed before) right back.
//
// Everyone on the outgoing entries list now owes payment for it, so
// they're carried into the new list's duePayments - merged with anyone
// still unpaid from before, so nobody's debt gets silently dropped if they
// missed a cycle.
// The outgoing waitlist is NOT carried into duePayments (they never got a
// confirmed spot) and does not carry forward at all - the new list starts
// with an empty waitlist. `limit` is recomputed from whatever court count
// the new list ends up with (see the big comment above `current.limit` at
// the top of this file for the full reasoning) rather than simply carried
// forward like duePaymentsLabel and the header fields below.
//
// Each newly-carried-over entry is tagged `owedSince: outgoing.date` - the
// date of the OLD list they owe for (omitted/left unset if that list never
// had a date) - so formatList() (lib/helpers.js) can show which list a
// payment is actually for, grouped under a "9th Aug Sun"-style header.
// Someone who's STILL on `stillOwing` (carried forward from an even
// earlier cycle they also never paid for) AND is on the outgoing entries
// list again this cycle gets a SEPARATE second entry added alongside their
// existing one, tagged with THIS cycle's date - they now owe for both
// events independently (e.g. "9th Aug Sun" and "16th Aug Sun" as two
// distinct lines, not one line that just says "still behind"). Each
// individual entry's own owedSince, once set, never changes after that -
// see markPaid() below for how paying it off works once a name can have
// more than one entry at a time.
//
// A name on the group's payment-exempt roster (getPaymentExempt/
// setPaymentExempt, see !exempt in commands/admin.js) is simply skipped
// entirely here - they never get added to duePayments in the first place,
// no matter how many cycles they attend without a payment record. This is
// checked only for THIS newly-transitioning batch, not `stillOwing` - if
// they already owed something from before they were marked exempt, that
// existing entry is left exactly as-is (exemption is forward-looking, not
// a retroactive debt forgiveness - see getPaymentExempt's own doc comment).
//
// `details` (optional) controls the new list's location/courts/time -
// each key works independently:
//   - omitted/undefined -> carries forward the outgoing list's value
//   - null               -> explicitly cleared (unset)
//   - details.location / details.time: a string -> sets it
//   - details.courts: a { raw, count } object (see parseCourtCount) -> sets
//     both `courts` and `courtCount` together
// Callers (index.js) are expected to have already validated/parsed courts
// text into { raw, count } - newList() itself does no parsing.
function newList(groupId, date, details = {}) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const state = all[groupId];
  const outgoing = state.current;

  state.history = [];

  const stillOwing = outgoing.duePayments || [];
  const newlyOwing = outgoing.entries;
  const exempt = new Set((state.paymentExempt || []).map(normalizeName));
  const mergedDue = [...stillOwing];
  for (const entry of newlyOwing) {
    if (exempt.has(normalizeName(entry.name))) continue;
    // Spread rather than push the entry object itself - `entry` is still
    // the same object reference sitting in `outgoing.entries` (about to be
    // discarded wholesale once `state.current` is replaced below) -
    // mutating it in place would be harmless in practice now that nothing
    // else holds onto that reference, but spreading keeps this loop
    // correct independent of that. Always pushed as its OWN new entry,
    // even if this same person already has an entry in `stillOwing` from
    // an earlier unpaid cycle - see this function's doc comment above for
    // why that's now intentional (owing for two separate events is two
    // separate debts).
    mergedDue.push(outgoing.date ? { ...entry, owedSince: outgoing.date } : entry);
  }

  const location = details.location !== undefined ? details.location : outgoing.location;
  const outgoingLimit = outgoing.limit === undefined ? DEFAULT_LIMIT : outgoing.limit;
  let courts;
  let courtCount;
  let limit;
  if (details.courts === undefined) {
    // Courts not respecified this call - carry `courts`/`courtCount`
    // forward unchanged, same as location/time/duePaymentsLabel. `limit`
    // is a different story, though: if a real court count is known, it's
    // still recomputed to match (courtCount * PLAYERS_PER_COURT) rather
    // than blindly carried forward as whatever it happened to be - same
    // as setCourts() unconditionally does when you retype the very same
    // courts outside of !newlist (see setCourts() above). A fresh list
    // should reflect the venue's actual capacity, not silently inherit a
    // one-off manual !limit override (or a stale !limit off) left over
    // from a previous cycle. Only when no real court count is known at
    // all (courtCount null) does the limit have nothing to scale against,
    // so it carries forward as-is.
    courts = outgoing.courts;
    courtCount = outgoing.courtCount;
    limit = courtCount ? courtCount * PLAYERS_PER_COURT : outgoingLimit;
  } else if (details.courts === null) {
    // Explicitly cleared - no court count to scale a limit from, so the
    // limit itself is left alone rather than reset.
    courts = null;
    courtCount = null;
    limit = outgoingLimit;
  } else {
    // Newly specified - auto-scale the limit to match, same as
    // setCourts() does when called outside of !newlist.
    courts = details.courts.raw;
    courtCount = details.courts.count;
    limit = courtCount * PLAYERS_PER_COURT;
  }
  const time = details.time !== undefined ? details.time : outgoing.time;

  state.current = {
    date,
    location,
    courts,
    courtCount,
    time,
    entries: [],
    limit,
    waitlist: [],
    duePayments: mergedDue,
    duePaymentsLabel: outgoing.duePaymentsLabel || DEFAULT_PAYMENT_LABEL,
    // A fresh cycle, a fresh chance to fill up - see
    // markVacancy50hNotified/markVacancyCancelWarningNotified above.
    notifiedVacancy50h: false,
    notifiedVacancyCancelWarning: false,
    // A fresh cycle hasn't had its own auto-newlist fire yet - see
    // markAutoNewlistCreated above.
    autoNewlistCreated: false,
  };

  writeAll(all);
  return state.current;
}

module.exports = {
  getList,
  getCurrentEvent,
  getDuePayments,
  getDuePaymentsLabel,
  setDuePaymentsLabel,
  getRegularPlayers,
  setRegularPlayers,
  getPaymentExempt,
  setPaymentExempt,
  getCourtCanceller,
  setCourtCanceller,
  markVacancy50hNotified,
  markVacancyCancelWarningNotified,
  markAutoNewlistCreated,
  getUndoableState,
  restoreUndoableState,
  saveUndoSnapshot,
  getUndoSnapshot,
  setDate,
  setLocation,
  setCourts,
  addCourts,
  setTime,
  parseCourtCount,
  PLAYERS_PER_COURT,
  getLimit,
  setLimit,
  allowFromWaitlist,
  addEntry,
  removeEntry,
  applyListUpdate,
  clearList,
  clearDuePayments,
  markPaid,
  newList,
  normalizeName,
};