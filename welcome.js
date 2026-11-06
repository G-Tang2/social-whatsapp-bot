// welcome.js
// Per-group on/off toggle for the "someone joined the group" welcome
// message - see index.js's handleGroupParticipantsUpdate for what actually
// gets sent (a greeting, how to join the social, and the current list).
//
// ON by default, per group - every group gets this automatically, same
// "ON by default, opt out per group" pattern as spam.js. An admin can turn
// it off per group with !welcome off (see commands/welcome.js) if a group
// would rather not have the bot speak up every time someone joins.
//
// Shape on disk (data/welcome.json):
// {
//   "<groupId>": { "enabled": true | false },
//   ...
// }

// Concurrency note: every exported function below is fully synchronous (no
// async/await) and does a fresh readAll() -> mutate -> writeAll() in one
// uninterruptible block, so - same as store.js/spam.js - concurrent
// callers can't produce a lost update on Node's single-threaded event loop.

const path = require('path');
// Defensive: reads process.env.DATA_DIR at module-load time below, so this
// file loads .env itself rather than depending on load order relative to
// lib/config.js or anything else. Safe/idempotent to call more than once.
require('dotenv').config();
const { createJsonFileStore } = require('./lib/jsonFileStore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'welcome.json');

const { readAll, writeAll } = createJsonFileStore(DATA_FILE, '[welcome]');

// Whether the welcome message is turned on for `groupId`. On by default -
// a group that's never touched !welcome gets it automatically, same as a
// freshly-added group with no data.json entry yet. Only an explicit
// !welcome off (which persists `enabled: false`) turns it off; any other
// stored value, or no stored value at all, means on.
function isEnabled(groupId) {
  const all = readAll();
  if (!all[groupId] || all[groupId].enabled === undefined) return true;
  return !!all[groupId].enabled;
}

// Flips the per-group on/off switch.
function setEnabled(groupId, enabled) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = {};
  all[groupId].enabled = enabled;
  writeAll(all);
}

module.exports = {
  isEnabled,
  setEnabled,
};
