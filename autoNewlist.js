// autoNewlist.js
// Per-group on/off state for automatically starting next week's list as
// soon as the current social has "ended" - turned on/off with
// !autonewlist on / !autonewlist off (admins only, see
// commands/autonewlist.js). See lib/autoNewlistScheduler.js for the
// periodic check that actually acts on this. OFF by default for every
// group, same reasoning as ai.js: this is a brand new automatic behavior
// nobody's used before, and it depends on !time being set to something
// parseable (see dates.js's parseTimeOfDay) - an explicit opt-in avoids
// surprising a group that's never touched it. Same on-disk shape/pattern
// as spam.js/ai.js (data/autonewlist.json):
// {
//   "<groupId>": { "enabled": true | false },
//   ...
// }
//
// Concurrency note: same as spam.js/ai.js/store.js - every exported
// function here is fully synchronous (readAll() -> mutate -> writeAll() in
// one uninterruptible block), so concurrent callers can't produce a lost
// update on Node's single-threaded event loop.

const fs = require('fs');
const path = require('path');
// Defensive: reads process.env.DATA_DIR at module-load time below, same
// reasoning as spam.js/ai.js - loads .env itself rather than
// depending on require order relative to lib/config.js.
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'autonewlist.json');

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
    console.error('[autoNewlist] Corrupt data file, resetting.', err);
    return {};
  }
}

function writeAll(data) {
  ensureFile();
  // Atomic-ish write: write to temp file then rename - same pattern as
  // spam.js/ai.js/store.js.
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

// Whether auto-creating next week's list is turned on for `groupId`. OFF
// by default - a group that's never touched !autonewlist at all (or has no
// data.json entry yet) keeps today's manual !newlist behavior unchanged.
// Only an explicit !autonewlist on (which persists `enabled: true`) turns
// it on; any other stored value, or no stored value at all, means off.
function isEnabled(groupId) {
  const all = readAll();
  if (!all[groupId] || all[groupId].enabled === undefined) return false;
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
