// ai.js
// Per-group on/off state for natural-language command interpretation (see
// lib/geminiCommand.js) - turned on/off with !ai on / !ai off (admins
// only, see commands/ai.js). OFF by default for every group, unlike
// spam.js's spamfilter (on by default): this feature calls an external
// paid API (Gemini) and can misinterpret ordinary chat, so it's an
// explicit opt-in rather than a safety default every group gets
// automatically. Same on-disk shape/pattern as spam.js (data/ai.json):
// {
//   "<groupId>": { "enabled": true | false },
//   ...
// }
//
// Concurrency note: same as spam.js/activity.js/store.js - every exported
// function here is fully synchronous (readAll() -> mutate -> writeAll() in
// one uninterruptible block), so concurrent callers can't produce a lost
// update on Node's single-threaded event loop.

const fs = require('fs');
const path = require('path');
// Defensive: reads process.env.DATA_DIR at module-load time below, same
// reasoning as spam.js/activity.js - loads .env itself rather than
// depending on require order relative to lib/config.js.
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ai.json');

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
    console.error('[ai] Corrupt data file, resetting.', err);
    return {};
  }
}

function writeAll(data) {
  ensureFile();
  // Atomic-ish write: write to temp file then rename - same pattern as
  // spam.js/activity.js/store.js.
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

// Whether natural-language command interpretation is turned on for
// `groupId`. OFF by default - a group that's never touched !ai at all (or
// has no data.json entry yet) gets no AI calls at all. Only an explicit
// !ai on (which persists `enabled: true`) turns it on; any other stored
// value, or no stored value at all, means off.
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
