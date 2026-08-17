// activity.js
// Tracks when each group participant last sent ANY message (not just bot
// commands - regular chat, images, stickers, voice notes, all count), so
// !stale can warn people who've gone quiet for a while and going-forward
// removal can be a human admin's call. Deliberately a separate concern
// (and a separate JSON file) from store.js's signup list - this is about
// general chat presence, not list membership, and applies to every group
// participant regardless of whether they've ever run !in.
//
// Off by default, per group: nothing is tracked or warned about for a
// group until an admin runs !inactivity on in it (see index.js). This
// mirrors ALLOWED_GROUPS being a global opt-in list - here the opt-in is
// per group and lives in chat, not in .env, so different groups the bot
// moderates can make their own call on whether this feature is wanted.
//
// Important limitation: this can only track activity from the moment a
// group turned the feature on (or, for anyone who joins later, from when
// they're first noticed after that) - there's no way to see a
// participant's message history from before that. So the first time a
// participant is seen - whether via an actual message, the periodic scan
// noticing a member with no record yet, or !inactivity on itself - they're
// seeded with a baseline of "right now" rather than being left looking
// infinitely inactive. See recordActivity()/seedParticipants()/
// resetBaseline().
//
// Shape on disk (data/activity.json):
// {
//   "<groupId>": {
//     "enabled": true | false,
//     "participants": {
//       "<participantJid>": {
//         "lastSeen": "2026-08-13T10:00:00.000Z",
//         "warnedAt": "2026-08-14T10:05:00.000Z" | null,
//         "missingSince": "2026-08-14T10:05:00.000Z"  // present only mid-debounce, see pruneParticipants()
//       },
//       ...
//     }
//   },
//   ...
// }
//
// `warnedAt` is null until the periodic check sends someone their "you've
// gone quiet" reminder, at which point it's set to that moment - this both
// starts their removal-grace clock (see index.js's
// INACTIVITY_REMOVE_AFTER_DAYS) and prevents them being warned again
// every check cycle. Any activity from them (recordActivity) clears it
// back to null - sending a message "resets the clock" exactly as the
// warning message promises.

// Concurrency note: every exported function below is fully synchronous (no
// async/await) and does a fresh readAll() -> mutate -> writeAll() in one
// uninterruptible block, so - same as store.js - concurrent callers can't
// produce a lost update on Node's single-threaded event loop. See the
// matching comment at the top of store.js for the full reasoning. Don't
// introduce `await` inside these functions without also adding explicit
// locking; that synchronous atomicity is what keeps this safe today.

const fs = require('fs');
const path = require('path');
// Defensive: reads process.env.DATA_DIR at module-load time below, so this
// file loads .env itself rather than depending on load order relative to
// lib/config.js or anything else. Safe/idempotent to call more than once.
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'activity.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  }
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('[activity] Corrupt data file, resetting.', err);
    return {};
  }
}

function writeAll(data) {
  ensureFile();
  // Atomic-ish write: write to temp file then rename, to avoid corruption
  // if the process is killed mid-write - same pattern as store.js.
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

// Normalizes all[groupId] to the current { enabled, participants } shape,
// mutating `all` in place and returning the normalized group object. Also
// transparently migrates a pre-per-group-toggle entry (where all[groupId]
// WAS the flat participant map itself, from before !inactivity existed) by
// nesting it under `participants` and defaulting `enabled` to false - so
// upgrading from that earlier version doesn't lose tracked data, but also
// doesn't silently turn the feature on for a group that never opted in
// under the old always-on-if-configured behavior.
function ensureGroup(all, groupId) {
  const existing = all[groupId];
  if (!existing) {
    all[groupId] = { enabled: false, participants: {} };
  } else if (!('participants' in existing)) {
    all[groupId] = { enabled: false, participants: existing };
  } else if (typeof existing.enabled !== 'boolean') {
    existing.enabled = false;
  }
  return all[groupId];
}

// Read-only counterpart to ensureGroup() for getters that don't need to
// persist a migration - handles both the current shape and the old flat
// pre-!inactivity shape without writing anything back.
function getParticipants(all, groupId) {
  const group = all[groupId];
  if (!group) return {};
  return 'participants' in group ? group.participants : group;
}

// Whether inactivity checking is turned on for `groupId`. Defaults to
// false for a group that's never run !inactivity on - including one
// migrated from the old flat schema, which had no such concept.
function isEnabled(groupId) {
  const all = readAll();
  return !!(all[groupId] && all[groupId].enabled);
}

// Flips the per-group on/off switch. Doesn't touch tracked participant
// data by itself - see resetBaseline() for the "give everyone a clean
// slate" step callers should pair with turning it on.
function setEnabled(groupId, enabled) {
  const all = readAll();
  const group = ensureGroup(all, groupId);
  group.enabled = enabled;
  writeAll(all);
}

// Records that `participantId` was just seen in `groupId` - sets lastSeen
// to now and clears any pending warning, since being active again means
// the inactivity clock resets. Call this for every message a participant
// sends, regardless of its content (text, caption, sticker, voice note,
// reaction, whatever) - presence is what's being tracked, not typing.
function recordActivity(groupId, participantId) {
  const all = readAll();
  const group = ensureGroup(all, groupId);
  group.participants[participantId] = { lastSeen: new Date().toISOString(), warnedAt: null };
  writeAll(all);
}

// Seeds a baseline "last seen: right now" for any of `participantIds` (the
// group's current membership) the bot doesn't already have a record for.
// Never overwrites an existing record. Called before every periodic
// inactivity check so brand-new joiners don't get flagged purely because
// the bot doesn't know their history yet.
function seedParticipants(groupId, participantIds) {
  const all = readAll();
  const group = ensureGroup(all, groupId);
  let changed = false;
  for (const id of participantIds) {
    if (!group.participants[id]) {
      group.participants[id] = { lastSeen: new Date().toISOString(), warnedAt: null };
      changed = true;
    }
  }
  if (changed) writeAll(all);
}

// Overwrites (not just fills in) a clean "just seen" baseline for every id
// in `participantIds`, discarding any stale lastSeen/warnedAt left over
// from a previous stint of being enabled (or from the old flat schema).
// Call this when an admin runs !inactivity on, so nobody gets an instant
// flood of warnings because of time that passed while the feature was off.
function resetBaseline(groupId, participantIds) {
  const all = readAll();
  const group = ensureGroup(all, groupId);
  const now = new Date().toISOString();
  group.participants = {};
  for (const id of participantIds) {
    group.participants[id] = { lastSeen: now, warnedAt: null };
  }
  writeAll(all);
}

// Drops tracking for anyone no longer in `participantIds` (the group's
// current membership) - keeps activity.json from accumulating records for
// people who've left the group. Called alongside seedParticipants() on
// every periodic check.
//
// Deliberately debounced across two sweeps rather than deleting the moment
// someone's missing from a single snapshot: a single sock.groupMetadata()
// call can transiently come back incomplete (this has been observed right
// after a reconnect, while Baileys' internal group-metadata cache is still
// catching up) without actually throwing - so trusting one snapshot could
// wipe a genuinely-still-present member's tracked lastSeen, and
// seedParticipants() would then reseed them with a fresh "now" baseline on
// the very next sweep. That silently resets their inactivity clock and is
// exactly the kind of bug that makes someone who's genuinely been quiet for
// hours never actually get flagged, with no error logged anywhere. So: the
// first time someone's absent from a snapshot, they're only marked
// `missingSince` (not deleted) - a real departure is still missing on the
// NEXT sweep too and gets removed then; a one-off flaky fetch sees them
// reappear on the next successful call and the mark is cleared instead.
function pruneParticipants(groupId, participantIds) {
  const all = readAll();
  if (!all[groupId]) return;
  const group = ensureGroup(all, groupId);
  const current = new Set(participantIds);
  let changed = false;
  const now = new Date().toISOString();
  for (const [id, rec] of Object.entries(group.participants)) {
    if (current.has(id)) {
      if (rec.missingSince) {
        delete rec.missingSince;
        changed = true;
      }
      continue;
    }
    if (!rec.missingSince) {
      rec.missingSince = now;
      changed = true;
    } else {
      delete group.participants[id];
      changed = true;
    }
  }
  if (changed) writeAll(all);
}

// Returns { id, lastSeen }[] for every tracked participant in `groupId`
// whose lastSeen is at least `inactiveMs` old and who hasn't already been
// warned (warnedAt === null) - i.e. people due a first reminder. Doesn't
// filter by admin status; callers do that themselves since it needs an
// async WhatsApp API call this module doesn't have access to. Callers are
// expected to only call this for a group where isEnabled() is true.
function getInactiveCandidates(groupId, inactiveMs) {
  const all = readAll();
  const participants = getParticipants(all, groupId);
  const cutoff = Date.now() - inactiveMs;
  return Object.entries(participants)
    .filter(([, rec]) => rec.warnedAt === null && new Date(rec.lastSeen).getTime() <= cutoff)
    .map(([id, rec]) => ({ id, lastSeen: rec.lastSeen }));
}

// Marks every id in `participantIds` as warned right now - starts their
// removal-grace clock. Called right after the periodic check sends them
// their reminder.
function markWarned(groupId, participantIds) {
  const all = readAll();
  const group = ensureGroup(all, groupId);
  const now = new Date().toISOString();
  for (const id of participantIds) {
    if (!group.participants[id]) group.participants[id] = { lastSeen: null };
    group.participants[id].warnedAt = now;
  }
  writeAll(all);
}

// Returns { id, lastSeen, warnedAt }[] for every participant in `groupId`
// currently warned (warnedAt !== null) - i.e. everyone !stale should
// report on, whether they're still within the grace period or already
// overdue. Sorted oldest-warned first, so the most overdue show up top.
function getWarned(groupId) {
  const all = readAll();
  const participants = getParticipants(all, groupId);
  return Object.entries(participants)
    .filter(([, rec]) => rec.warnedAt !== null && rec.warnedAt !== undefined)
    .map(([id, rec]) => ({ id, lastSeen: rec.lastSeen, warnedAt: rec.warnedAt }))
    .sort((a, b) => new Date(a.warnedAt).getTime() - new Date(b.warnedAt).getTime());
}

module.exports = {
  isEnabled,
  setEnabled,
  recordActivity,
  seedParticipants,
  resetBaseline,
  pruneParticipants,
  getInactiveCandidates,
  markWarned,
  getWarned,
};
