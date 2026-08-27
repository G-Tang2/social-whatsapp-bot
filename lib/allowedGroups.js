// lib/allowedGroups.js
// Runtime-mutable version of the group allowlist that used to live ONLY in
// .env's ALLOWED_GROUPS (a static array, read once at process start - see
// lib/config.js). That meant approving a newly-added group always needed a
// manual .env edit AND a full bot restart before it took effect - real
// friction for adding the bot to more than one group over time, and it
// meant a group that was simply never listed (as opposed to NO group being
// configured at all) produced no discoverable trace anywhere; an operator
// had to already know its JID (e.g. via list-groups.js, which itself needs
// the bot stopped to run).
//
// Persisted (like store.js/spam.js/ai.js/activity.js/catchUpQueue.js) to
// data/allowedGroups.json, and - critically - always read FRESH from disk
// (no caching), same "always read fresh" convention those files use. That's
// what makes this actually solve the restart problem: the running bot
// re-reads this file on every single incoming message (see
// getApprovedGroups() below), so approving/removing a group via
// manage-groups.js (repo root) takes effect on the very next message, no
// restart needed.
//
// Two lists are tracked:
// - `approved`: JIDs the bot actually moderates - the direct replacement
//   for .env's ALLOWED_GROUPS.
// - `pending`: JIDs the bot has SEEN a command in (see recordPendingGroup
//   below) but isn't yet approved for - lets an operator discover a new
//   group (subject + when first/last seen) via `node manage-groups.js
//   list` without digging through console logs, and approve it with
//   `node manage-groups.js approve <jid>` while the bot keeps running.
//
// Backward compatibility: on first-ever read (this file doesn't exist yet),
// `approved` is seeded from .env's ALLOWED_GROUPS (see lib/config.js) - an
// existing deployment upgrading to this keeps moderating exactly the same
// groups it already did, with zero action required. After that first
// write, this file is the sole source of truth; further edits to .env's
// ALLOWED_GROUPS are ignored (same "the data file wins once it exists" rule
// store.js's own migration follows).

const fs = require('fs');
const path = require('path');
// Defensive: reads process.env.ALLOWED_GROUPS/DATA_DIR at module-load time
// below, so this file loads .env itself rather than depending on load
// order relative to lib/config.js or anything else - same reasoning as
// store.js/spam.js/lib/catchUpQueue.js.
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'allowedGroups.json');

// Read directly from process.env here (not lib/config.js's own ALLOWED_GROUPS)
// to avoid a circular require - lib/config.js doesn't (and shouldn't) know
// about this file, so the one-time seed value is computed independently,
// the same raw parsing lib/config.js itself does.
function seedFromEnv() {
  return (process.env.ALLOWED_GROUPS || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ approved: seedFromEnv(), pending: [] }, null, 2));
  }
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const data = JSON.parse(raw || '{}');
    if (!Array.isArray(data.approved)) data.approved = [];
    if (!Array.isArray(data.pending)) data.pending = [];
    return data;
  } catch (err) {
    console.error('[allowedGroups] Corrupt data file, resetting.', err);
    return { approved: [], pending: [] };
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

// The list every group-membership gate in the codebase actually checks
// against (index.js, lib/vacancyReminder.js, lib/inactivityCheck.js,
// lib/autoNewlistScheduler.js) - always a fresh read, see this file's own
// doc comment for why that matters.
function getApprovedGroups() {
  return readAll().approved;
}

function isGroupApproved(groupId) {
  return getApprovedGroups().includes(groupId);
}

// Every group the bot has seen a command in but hasn't been approved for
// yet, most-recently-seen first - what `node manage-groups.js list`
// (repo root) actually shows.
function getPendingGroups() {
  const { pending } = readAll();
  return [...pending].sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
}

// Records (or refreshes) a sighting of `groupId` in the pending list - see
// index.js's call site for exactly when this fires (an actual command,
// not every message, same restraint the old console-only logging used).
// A no-op if the group's already approved - nothing to surface for
// something already being moderated.
function recordPendingGroup(groupId, subject) {
  const data = readAll();
  if (data.approved.includes(groupId)) return;
  const now = new Date().toISOString();
  const existing = data.pending.find((g) => g.jid === groupId);
  if (existing) {
    existing.subject = subject || existing.subject;
    existing.lastSeenAt = now;
  } else {
    data.pending.push({ jid: groupId, subject: subject || null, firstSeenAt: now, lastSeenAt: now });
  }
  writeAll(data);
}

// Approves `groupId` - adds it to `approved` (a no-op if already there) and
// clears it out of `pending` either way, since it's no longer "awaiting a
// decision." Returns { ok: false, reason: 'already_approved' } instead of
// silently no-op-ing so manage-groups.js can say so rather than implying
// something just happened.
function approveGroup(groupId) {
  const data = readAll();
  const alreadyApproved = data.approved.includes(groupId);
  if (!alreadyApproved) data.approved.push(groupId);
  const hadPending = data.pending.some((g) => g.jid === groupId);
  data.pending = data.pending.filter((g) => g.jid !== groupId);
  if (alreadyApproved && !hadPending) {
    return { ok: false, reason: 'already_approved' };
  }
  writeAll(data);
  return { ok: true };
}

// De-authorizes `groupId` - the reverse of approveGroup(), for an operator
// who wants to stop the bot moderating a group WITHOUT a restart either
// (e.g. it left the intended use case, or was approved by mistake).
// Doesn't touch `pending` - removing an approval doesn't mean the group
// was never seen.
function removeGroup(groupId) {
  const data = readAll();
  if (!data.approved.includes(groupId)) {
    return { ok: false, reason: 'not_approved' };
  }
  data.approved = data.approved.filter((jid) => jid !== groupId);
  writeAll(data);
  return { ok: true };
}

module.exports = {
  getApprovedGroups,
  isGroupApproved,
  getPendingGroups,
  recordPendingGroup,
  approveGroup,
  removeGroup,
};
