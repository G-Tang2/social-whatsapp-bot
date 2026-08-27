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
// longer restricts who can remove an entry based on it. And, if
// the group's tournament sub-feature is on (see `current.tournamentEnabled`
// below), `tournament` (was this entry opted into the tournament, on top of
// the regular social list? - see addEntry()/joinTournament() below and
// commands/list.js's handleIn for how someone opts in) and
// `tournamentWaitlisted` (did they ask to, but the tournament was full? -
// shown as a "(🏆 WL)" tag next to their name, see lib/helpers.js's
// formatList() - mutually exclusive with `tournament` itself, never both
// true). Undefined/falsy on entries created before these fields existed -
// treated the same as `false` everywhere they're read, no migration needed.
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
//       "entries": [ { name, addedBy, addedByIsAdmin, addedAt, tournament, tournamentWaitlisted }, ... ],
//       "limit": 20 | null,
//       "waitlist": [ { name, addedBy, addedByIsAdmin, addedAt, tournament, tournamentWaitlisted }, ... ],
//       "duePayments": [ { name, addedBy, addedAt }, ... ],
//       "duePaymentsLabel": "$18 please",
//       "tournamentEnabled": false,
//       "tournamentLimit": 16 | null,
//       "tournamentWinners": ["Noah", "Ellen"] | null,
//       "tournamentRules": "Best of 3, single elimination..." | null
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
      // Tournament sub-feature - see !settournament/!tournament/
      // !tournamentlimit/!tournamentwinners in commands/admin.js. OFF by
      // default per group, same "each group opts in individually" pattern
      // as !spamfilter/!ai/!autonewlist - most groups running this bot
      // don't run a tournament alongside their social, so it shouldn't
      // change how a brand-new group's Attendance section looks (see
      // lib/helpers.js's formatList()) until an admin deliberately turns it
      // on with !settournament on. State lives here in `current` (not a
      // separate module like ai.js/spam.js) since it's fundamentally about
      // THIS list - who's opted in lives on each entry itself
      // (entry.tournament, see addEntry() below), not as a separate
      // roster. `tournamentEnabled`/`tournamentLimit`/`tournamentRules`
      // carry forward to the next !newlist the same way
      // duePaymentsLabel/location/courts/time do (see newList() below) - a
      // group's tournament is a running weekly thing, not something that
      // resets just because a new list started. `tournamentWinners` is the
      // one exception - see its own comment below. The actual entries (and
      // therefore who's opted in) DO reset with every !newlist, same as
      // the rest of `entries`.
      tournamentEnabled: false,
      // null = no cap (anyone who opts in gets in) until an admin sets one
      // with !tournamentlimit - unlike the main `limit`, there's no
      // court-count auto-scaling for this, so it doesn't default to
      // DEFAULT_LIMIT.
      tournamentLimit: null,
      // [winner1, winner2] as last set by !tournamentwinners, or null if
      // never set - powers the "*Congrats to X and Y for winning last
      // week's tournament*" banner formatList() shows above the list
      // while tournamentEnabled is true (see lib/helpers.js). Unlike
      // everything else here, this does NOT carry forward across !newlist
      // (see newList()'s own comment on this field) - it's an announcement
      // about the cycle that just ended, not a standing setting, so
      // starting a fresh cycle clears it rather than keep showing a
      // now-stale "Congrats" banner above the new list.
      tournamentWinners: null,
      // Free-text rules set by an admin (e.g. "Best of 3, single
      // elimination") via !settournament rules <text>, shown to anyone who
      // runs bare !tournament (see commands/admin.js's handleTournament -
      // the RENAMED command that used to be bare !tournament is now
      // !settournament, see handleSettournament). null if never set.
      // Persists across !newlist (unlike tournamentWinners above) - rules
      // don't change just because a new cycle started.
      tournamentRules: null,
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
      if (data[groupId].current.tournamentEnabled === undefined) {
        // Same default as emptyGroupState() above (OFF) - a stored group
        // missing this field entirely predates the field itself (either a
        // genuinely brand-new group, or an existing deployment's data from
        // before this feature existed for it at all), not a group that
        // ever explicitly ran !settournament on (that would have stored an
        // actual `true`, not left the key out), so it gets the same
        // off-by-default a brand-new group would.
        data[groupId].current.tournamentEnabled = false;
        migrated = true;
      }
      if (data[groupId].current.tournamentLimit === undefined) {
        data[groupId].current.tournamentLimit = null;
        migrated = true;
      }
      if (data[groupId].current.tournamentWinners === undefined) {
        data[groupId].current.tournamentWinners = null;
        migrated = true;
      }
      if (data[groupId].current.tournamentRules === undefined) {
        data[groupId].current.tournamentRules = null;
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

// Zero-width/invisible characters that show up in real WhatsApp text with
// no visible trace at all - most commonly U+2060 WORD JOINER, which
// WhatsApp itself silently inserts around a name typed right after a
// contact-autocomplete suggestion was dismissed. A real bug report: a
// payment list typed with entries like "Renee" that actually carried a
// leading U+2060 never matched someone typing a plain "renee" to pay -
// same visible text, different string. Stripped everywhere (not just
// leading/trailing) since these have no width and can't collide with a
// real letter, so removing one is always safe.
const INVISIBLE_CHARS_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

function normalizeName(name) {
  return name.replace(INVISIBLE_CHARS_RE, '').trim().replace(/\s+/g, ' ').toLowerCase();
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

// --- Tournament sub-feature (see commands/admin.js's !settournament/
// !tournament/!tournamentlimit/!tournamentwinners, and commands/list.js's handleIn/
// handleOut for how someone opts in/out via !in/!out) ---
//
// A group's tournament is a subset of its regular social Attendance list,
// not a separate roster: whoever opts in gets `entry.tournament = true` on
// their EXISTING attendance entry (see addEntry()/joinTournament() below),
// rather than being tracked in some second list that could drift out of
// sync with who's actually attending. Leaving the tournament WITHOUT
// leaving the social list is a leading "tournament" keyword on !out (e.g.
// "!out tournament Isaac") - see leaveTournament() below and
// commands/list.js's handleLeaveTournament; leaving the social list
// entirely is still just plain !out (see removeEntry()), which takes the
// tournament flag along with the rest of the entry as always.
//
// There's no SEPARATE tournament waitlist array - someone who opts in once
// the tournament is already full just gets `entry.tournamentWaitlisted =
// true` on their existing social entry instead, which lib/helpers.js's
// formatList() renders as a "(🏆 WL)" tag next to their name, sorted to the
// FRONT of "Social only" ahead of anyone who never asked (see
// commands/admin.js's !settournament for the same idea in its standalone info
// view). That ordering - front of the group = front of the line - IS the
// queue; `entries`'s own array order among tournamentWaitlisted:true
// entries doubles as FIFO order, same as it does for everything else here.
// A tournament spot opening up (someone with tournament:true leaves via
// !out tournament, plain !out, or an admin raises !tournamentlimit)
// automatically promotes off the front of that queue - see
// promoteFromTournamentWaitlist() below, called from leaveTournament(),
// removeEntry(), and setTournamentLimit(). Re-running !in tournament
// (or the bare-already-on-list upgrade path, see joinTournament() below)
// still works too, for the one case auto-promotion can't cover: someone
// who wasn't tagged yet because they haven't tried opting in at all.

function isTournamentEnabled(groupId) {
  return !!getCurrentEvent(groupId).tournamentEnabled;
}

// Turns the tournament sub-feature on/off. Deliberately does NOT touch any
// entry's `tournament` flag either way - turning it off just hides the
// tournament breakdown from formatList() (see lib/helpers.js) without
// forgetting who'd opted in, so turning it back on later doesn't require
// everyone to re-opt-in. `tournamentLimit`/`tournamentWinners` are
// similarly left untouched.
function setTournamentEnabled(groupId, enabled) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.tournamentEnabled = !!enabled;
  writeAll(all);
  return all[groupId].current.tournamentEnabled;
}

function getTournamentLimit(groupId) {
  const limit = getCurrentEvent(groupId).tournamentLimit;
  return limit === undefined ? null : limit;
}

// Sets the tournament headcount cap (null removes it). Same "raising it can
// free up room" logic as setLimit() for the main attendance list: raising
// (or clearing) it promotes off the front of the (🏆 WL) queue to fill any
// newly available spots (see promoteFromTournamentWaitlist() below).
// Unlike setLimit(), there's no demotion side - lowering it below the
// current tournament headcount simply leaves the group visibly over its
// own stated tournament cap (same "your edit is treated as final" spirit
// as !update) until people are manually un-opted or the limit is raised
// back up; nobody currently in gets silently bumped out to the queue.
// Returns { limit, promoted } - `promoted` possibly empty, so callers can
// mention (and tag) anyone it happened to.
function setTournamentLimit(groupId, limit) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  current.tournamentLimit = limit;
  const promoted = promoteFromTournamentWaitlist(current);
  writeAll(all);
  return { limit: current.tournamentLimit, promoted };
}

// Moves people off the front of the tournament (🏆 WL) queue into the
// tournament proper, one at a time, until either the queue is empty or the
// tournament headcount hits tournamentLimit again (no-op if there's no cap
// or nobody's waitlisted). "Front of the queue" is just `entries`' own
// array order among tournamentWaitlisted:true entries - see the file
// comment above for why that doubles as FIFO order, the same idea as
// promoteFromWaitlist() above but without a second array to shift() from,
// since tournament participation lives on the entry itself rather than in
// a separate list. Mutates `current` in place and returns the entries that
// got promoted, so callers can mention (and tag) them. Called whenever a
// tournament spot might have opened up: someone with tournament:true
// leaves the list entirely (removeEntry()), or an admin raises
// !tournamentlimit (setTournamentLimit() above).
function promoteFromTournamentWaitlist(current) {
  const promoted = [];
  while (true) {
    const tournamentCount = current.entries.filter((e) => e.tournament).length;
    const hasRoom = current.tournamentLimit === null || current.tournamentLimit === undefined
      || tournamentCount < current.tournamentLimit;
    if (!hasRoom) break;
    const next = current.entries.find((e) => e.tournamentWaitlisted);
    if (!next) break;
    next.tournament = true;
    next.tournamentWaitlisted = false;
    promoted.push(next);
  }
  return promoted;
}

function getTournamentWinners(groupId) {
  return getCurrentEvent(groupId).tournamentWinners || null;
}

// `names` is expected to already be a validated 2-element array (see
// commands/admin.js's handleTournamentWinners) - store.js itself doesn't
// enforce "exactly two", same division of labor as setRegularPlayers()
// leaving name validation to its caller.
function setTournamentWinners(groupId, names) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.tournamentWinners = names;
  writeAll(all);
  return all[groupId].current.tournamentWinners;
}

// Tournament winners don't have to pay for the social THAT week - called
// right alongside setTournamentWinners above (see commands/admin.js's
// handleTournamentWinners) when an admin announces a result via
// !tournamentwinners. Per the README's "Announcing last week's winners",
// that command names the winners of the week that just ended, by which
// point that week's attendees (winners included) have already been
// carried into `current.duePayments` with `owedSince` set to that week's
// date (see newList()'s own doc comment). "That week" is resolved here as
// the MOST RECENT `owedSince` among everything currently owed (ISO date
// strings sort chronologically as plain strings, so the max is simply the
// last one anyone was newly charged for) - and only the winners'
// duePayments entries matching THAT exact date are cleared. Any other debt
// a winner separately owes from an earlier missed cycle is left untouched,
// same "forward-looking, not retroactive forgiveness" spirit as
// getPaymentExempt. No-op (returns []) if nobody currently owes anything,
// or neither winner actually owes for the most recent week.
function waiveDuePaymentsForWinners(groupId, names) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  if (!current.duePayments || !current.duePayments.length) return [];

  const owedSinceDates = current.duePayments.map((e) => e.owedSince).filter(Boolean);
  if (!owedSinceDates.length) return [];
  const lastWeekDate = owedSinceDates.reduce((max, d) => (d > max ? d : max));

  const normalizedNames = new Set((names || []).map(normalizeName));
  const waived = [];
  current.duePayments = current.duePayments.filter((entry) => {
    const matches = entry.owedSince === lastWeekDate && normalizedNames.has(normalizeName(entry.name));
    if (matches) waived.push(entry.name);
    return !matches;
  });
  if (!waived.length) return [];

  writeAll(all);
  return waived;
}

// Free-text tournament rules set by an admin via !settournament rules <text>,
// shown to anyone who runs bare !tournament. Same shape/division-of-labor as
// getTournamentWinners/setTournamentWinners above.
function getTournamentRules(groupId) {
  return getCurrentEvent(groupId).tournamentRules || null;
}

function setTournamentRules(groupId, rules) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  all[groupId].current.tournamentRules = rules;
  writeAll(all);
  return all[groupId].current.tournamentRules;
}

/**
 * Opts an EXISTING attendance entry into the tournament by name (used by
 * handleIn for someone who's already on the list and adds the "tournament"
 * keyword on a later message, e.g. "!in tournament" after already having
 * joined plain "!in" earlier - see commands/list.js). Only looks at
 * `entries`, never `waitlist` - someone not yet confirmed for the social
 * list itself can't opt into its tournament sub-feature yet; they can
 * re-run this once promoted.
 *
 * When the tournament is enabled but full, this does NOT fail outright -
 * it sets `entry.tournamentWaitlisted = true` (see the file comment above)
 * so the "(🏆 WL)" tag shows up next to their name (at the front of Social
 * only, queued for the next opening), and still reports `reason: 'full'` so
 * callers know no seat was actually granted. Usually a later spot opening
 * up promotes them automatically (see promoteFromTournamentWaitlist()
 * below), but re-running this manually also clears the tag the moment it
 * succeeds - `entry.tournamentWaitlisted` and `entry.tournament` are
 * mutually exclusive, never both true at once.
 *
 * Returns one of:
 *   { ok: false, reason: 'not_found' }  - no matching entry in `entries`
 *   { ok: false, reason: 'disabled' }   - tournament isn't turned on
 *   { ok: false, reason: 'full' }       - at tournamentLimit; tagged (🏆 WL)
 *   { ok: true, alreadyIn: true }       - was already opted in, no-op
 *   { ok: true }                        - opted in just now
 */
function joinTournament(groupId, name) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  const normalized = normalizeName(name);
  const entry = current.entries.find((e) => normalizeName(e.name) === normalized);
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.tournament) return { ok: true, alreadyIn: true };
  if (!current.tournamentEnabled) return { ok: false, reason: 'disabled' };

  const tournamentCount = current.entries.filter((e) => e.tournament).length;
  const hasRoom = current.tournamentLimit === null || current.tournamentLimit === undefined
    || tournamentCount < current.tournamentLimit;
  if (!hasRoom) {
    entry.tournamentWaitlisted = true;
    writeAll(all);
    return { ok: false, reason: 'full' };
  }

  entry.tournament = true;
  entry.tournamentWaitlisted = false;
  writeAll(all);
  return { ok: true };
}

/**
 * The mirror of joinTournament() above - takes an EXISTING attendance entry
 * OUT of the tournament by name, WITHOUT removing them from the social list
 * (used by handleOut for a leading "tournament" keyword, e.g. "!out
 * tournament Isaac" - see commands/list.js's handleLeaveTournament).
 * Leaving the list entirely is still !out's plain job (see removeEntry()) -
 * this only clears the tournament-related flags on an entry that stays
 * right where it is.
 *
 * Also clears `entry.tournamentWaitlisted` if that (rather than
 * `tournament`) was set - someone queued for the tournament but not
 * actually in it yet can still ask to be taken out of the queue entirely,
 * same command either way, since from their perspective they're just
 * saying "I don't want the tournament," whichever of the two states that
 * currently means for them.
 *
 * No authorization check, deliberately - same as joinTournament() above,
 * this is a low-stakes toggle on an entry that already exists and stays on
 * the list either way, not the bigger deal actually losing your spot on
 * the list would be.
 *
 * Taking someone OUT of the tournament (not just off the queue) frees a
 * spot, so this also promotes off the front of the (🏆 WL) queue to fill
 * it - see promoteFromTournamentWaitlist() above. Someone merely leaving
 * the queue (was only `tournamentWaitlisted`, never actually `tournament`)
 * never occupied a real spot, so no promotion happens for that case - the
 * `promoted` array in that return would always be empty.
 *
 * Returns one of:
 *   { ok: false, reason: 'not_found' }     - no matching entry in `entries`
 *   { ok: true, alreadyOut: true, promoted: [] } - wasn't in the tournament
 *                                                   or queue to begin with
 *   { ok: true, promoted }                 - taken out just now; `promoted`
 *                                             lists anyone who filled the
 *                                             freed spot, possibly empty
 */
function leaveTournament(groupId, name) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = emptyGroupState();
  const current = all[groupId].current;
  const normalized = normalizeName(name);
  const entry = current.entries.find((e) => normalizeName(e.name) === normalized);
  if (!entry) return { ok: false, reason: 'not_found' };

  if (!entry.tournament && !entry.tournamentWaitlisted) {
    return { ok: true, alreadyOut: true, promoted: [] };
  }

  const wasInTournament = entry.tournament;
  entry.tournament = false;
  entry.tournamentWaitlisted = false;
  const promoted = wasInTournament ? promoteFromTournamentWaitlist(current) : [];
  writeAll(all);
  return { ok: true, promoted };
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
// the current list, history, saved regular-players roster, and saved
// payment-exempt roster - as of right now. Every store.js accessor already
// returns a fresh object from a fresh JSON.parse of the data file on each
// call (see readAll() above - there's no long-lived in-memory cache to
// worry about aliasing with), so this is purely a convenience that reads
// all four in one go rather than four separate calls. Deliberately does
// NOT include `undo` itself - see the file-level comment above for why
// that's tracked outside of what gets snapshotted.
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
// to make it stale (e.g. "!clear" or "!in Alice, Bob") - shown back by
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
 * someone else - e.g. after `!in Alice, Bob, Carla`, all three entries
 * have `addedBy` set to the sender's ID (so the sender can remove them
 * later) but `self: false` (so the sender isn't mistaken for being "Alice,
 * Bob, and Carla" the next time they run a bare `!in`/`!out`/`!paid` to
 * look themselves up - see those bare-lookup call sites in
 * commands/list.js, which all check `self !== false` rather than just
 * `addedBy === senderId`). Left unset (undefined) on entries created
 * before this field existed - `!== false` treats that the same as `true`,
 * preserving old behavior for already-persisted data instead of silently
 * "losing" people's own entries across an upgrade.
 * `wantsTournament` (optional) records whether the person asked to also
 * join the group's tournament sub-feature (e.g. via handleIn's leading
 * "tournament" keyword - see lib/helpers.js's stripLeadingInKeywords).
 * Only actually takes effect - `entry.tournament = true` - when ALL of the
 * following hold: tournament is enabled for the group, there's room under
 * `tournamentLimit`, AND the entry lands straight on `entries` rather than
 * the waitlist (someone not yet confirmed for the social list itself can't
 * be in its tournament either - see joinTournament()'s doc comment for how
 * they can opt in later once promoted). If it's enabled but just full,
 * `entry.tournamentWaitlisted` is set instead, which formatList() (see
 * lib/helpers.js) renders as a "(🏆 WL)" tag next to their name - no
 * separate reply needed, the tag in the reposted list says it (see
 * commands/list.js's handleIn for the one exception: if tournament isn't
 * enabled at all, THAT specific case does get an explicit reply, since
 * there'd be no tournament UI in the list at all to explain why).
 *
 * Returns { ok: true, list, waitlist, waitlisted } on success, or
 * { ok: false, reason } if it's a duplicate.
 */
function addEntry(groupId, name, addedBy, addedByIsAdmin, selfAdded, wantsTournament) {
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
    tournament: false,
    tournamentWaitlisted: false,
  };

  const atCapacity = current.limit !== null && current.limit !== undefined && current.entries.length >= current.limit;
  if (atCapacity) {
    current.waitlist.push(entry);
  } else {
    if (wantsTournament && current.tournamentEnabled) {
      const tournamentCount = current.entries.filter((e) => e.tournament).length;
      const hasRoom = current.tournamentLimit === null || current.tournamentLimit === undefined
        || tournamentCount < current.tournamentLimit;
      // Full, not disabled - tag them (🏆 WL) rather than silently leaving
      // them indistinguishable from someone who never asked for the
      // tournament at all. See the file-level tournament comment above and
      // joinTournament()'s doc comment for the same idea on the
      // already-on-the-list upgrade path.
      entry.tournament = hasRoom;
      entry.tournamentWaitlisted = !hasRoom;
    }
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
 * returned `promoted` array lists anyone that happened to. If the removed
 * entry itself had `tournament: true`, that also frees a tournament spot,
 * so this additionally promotes off the front of the (🏆 WL) queue (see
 * promoteFromTournamentWaitlist()) - the returned `tournamentPromoted`
 * array lists anyone that happened to (always empty when removing from the
 * waitlist, or when the removed entry wasn't in the tournament to begin
 * with).
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
  const tournamentPromoted = fromWaitlist ? [] : promoteFromTournamentWaitlist(current);
  writeAll(all);
  return { ok: true, list: current.entries, waitlist: current.waitlist, promoted, tournamentPromoted };
}

/**
 * Bulk-reconciles the current list against a parsed copy-pasted edit (see
 * lib/listParser.js's parseListSections()) - powers !update. `parsed` is
 * { attendance: string[], waitlist: string[], duePayments: string[],
 * tournamentPlayers: string[]|null, tournamentWaitlistedNames: string[] },
 * each name array already in the editor's intended final order for that
 * section (see parseListSections' own doc comment for what
 * tournamentPlayers null vs [] means).
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
 * Tournament/social-only placement (new entries included) is reconciled
 * separately, AFTER the above, and ONLY when `parsed.tournamentPlayers`
 * isn't null - i.e. only when the pasted text actually contained a "🏆
 * Tournament" sub-header at all. A plain, non-tournament-formatted
 * Attendance paste (or a group that's never turned tournament on) leaves
 * every kept entry's `tournament`/`tournamentWaitlisted` flags exactly as
 * they were - this is what keeps a non-tournament !update from silently
 * touching data it never even displayed. When it IS present, every name
 * listed under the header becomes a tournament player - capped at
 * `tournamentLimit` if one's set, in the given order (same "full" idea as
 * joinTournament(), just applied to the whole roster in one pass instead
 * of one join at a time): anyone past the cap, or tagged "(🏆 WL)" under
 * Social only in the text, ends up `tournamentWaitlisted` instead; every
 * other Social-only name ends up with neither flag. This is a full
 * recompute, not an incremental adjustment - like the attendance/waitlist
 * placement above, the editor's explicit tournament placement is taken as
 * final, with no auto-promotion to backfill unused capacity if the editor
 * simply didn't list enough tournament players to fill it.
 *
 * Returns a summary: { added, removed, moved, paidAdded, paidRemoved,
 * tournamentChanged } - `added`/`removed` list plain names
 * (attendance+waitlist combined), `moved` lists { name, from, to } for
 * names that changed section, `paidAdded`/`paidRemoved` cover the payment
 * section the same way, and `tournamentChanged` lists { name, from, to }
 * (from/to each one of 'tournament'/'queued'/'social only') for every name
 * whose tournament placement actually changed - always empty when
 * `parsed.tournamentPlayers` was null.
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

  // Tournament/social-only placement - see this function's doc comment for
  // the full reasoning. Only touched at all when the pasted text actually
  // contained the "🏆 Tournament" sub-header (tournamentPlayers
  // !== null) - runs over current.entries (which by now includes BOTH kept
  // and brand-new entries, since resolveSection() above already merged
  // them), so a newly-added name listed under the tournament header gets
  // opted in immediately, same as one that already existed.
  const tournamentChanged = [];
  function tournamentStateLabel(tournament, waitlisted) {
    if (tournament) return 'tournament';
    if (waitlisted) return 'queued';
    return 'social only';
  }
  if (Array.isArray(parsed.tournamentPlayers)) {
    // De-duped, in the editor's given order - a name repeated under the
    // tournament header (unlikely, but not impossible in hand-edited text)
    // only ever counts once, same "first placement wins" idea as
    // resolveSection() above.
    const seenTournament = new Set();
    const tournamentNamesInOrder = [];
    for (const name of parsed.tournamentPlayers) {
      const normalized = normalizeName(name);
      if (seenTournament.has(normalized)) continue;
      seenTournament.add(normalized);
      tournamentNamesInOrder.push(normalized);
    }
    const limit = current.tournamentLimit;
    const cappedTournamentNames = new Set(
      limit != null ? tournamentNamesInOrder.slice(0, limit) : tournamentNamesInOrder
    );
    const overflowTournamentNames = new Set(
      limit != null ? tournamentNamesInOrder.slice(limit) : []
    );
    const waitlistedNames = new Set((parsed.tournamentWaitlistedNames || []).map((n) => normalizeName(n)));

    for (const entry of current.entries) {
      const normalized = normalizeName(entry.name);
      const wasTournament = Boolean(entry.tournament);
      const wasWaitlisted = Boolean(entry.tournamentWaitlisted);
      const nowTournament = cappedTournamentNames.has(normalized);
      const nowWaitlisted = !nowTournament && (overflowTournamentNames.has(normalized) || waitlistedNames.has(normalized));
      if (wasTournament !== nowTournament || wasWaitlisted !== nowWaitlisted) {
        tournamentChanged.push({
          name: entry.name,
          from: tournamentStateLabel(wasTournament, wasWaitlisted),
          to: tournamentStateLabel(nowTournament, nowWaitlisted),
        });
      }
      entry.tournament = nowTournament;
      entry.tournamentWaitlisted = nowWaitlisted;
    }
  }

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
  return { added, removed, moved, paidAdded, paidRemoved, tournamentChanged };
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
 * first one found - "mark Grace as paid" means Grace is all settled up, not
 * "settle just one of however many things Grace happens to owe for". The
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
    // Carries forward as-is, same as duePaymentsLabel above - a group's
    // tournament is a running weekly thing, not something !newlist resets.
    // `entries` (and therefore who's opted in) DOES reset, same as the
    // rest of the list - see emptyGroupState()'s doc comment.
    tournamentEnabled: !!outgoing.tournamentEnabled,
    tournamentLimit: outgoing.tournamentLimit === undefined ? null : outgoing.tournamentLimit,
    // Unlike tournamentRules just below, winners are deliberately NOT
    // carried forward - "Congrats to X and Y" is an announcement about the
    // cycle that just ended, not a standing fact about the group, so it
    // would be actively wrong to keep showing it above the NEXT cycle's
    // list. Reset to null here; an admin (or the "@Snoopy ... and the
    // tournament winners are ..." natural-language path - see
    // lib/geminiCommand.js's MULTIPLE ACTIONS "newlist always first" rule)
    // re-announces it with !tournamentwinners for the new cycle if there's
    // a fresh result to show.
    tournamentWinners: null,
    tournamentRules: outgoing.tournamentRules || null,
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
  isTournamentEnabled,
  setTournamentEnabled,
  getTournamentLimit,
  setTournamentLimit,
  getTournamentWinners,
  setTournamentWinners,
  waiveDuePaymentsForWinners,
  getTournamentRules,
  setTournamentRules,
  joinTournament,
  leaveTournament,
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