// ai.js
// Per-group on/off state for natural-language command interpretation (see
// lib/geminiCommand.js) - turned on/off with !ai on / !ai off (admins
// only, see commands/ai.js). ON by default for every group - same
// "safety/convenience default every group gets automatically" pattern as
// spam.js's spamfilter - PROVIDED GEMINI_API_KEY is actually configured
// (see isEnabled() below): a fresh install with no key set still defaults
// every group to off, same as before this changed, since the feature is
// entirely non-functional without one anyway (see commands/ai.js's own
// refusal on `!ai on` with no key configured) - defaulting "on" in that
// case would just mean every plain @-mention now gets a "not capable of
// doing that" reply (see lib/geminiCommand.js's interpretMessage(), which
// itself returns null with no key set) instead of staying silent, for a
// group that never actually turned anything on. Same on-disk shape/pattern
// as spam.js (data/ai.json):
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
// Read directly from process.env (not lib/config.js) to avoid this module
// depending on load order relative to it - same "read env directly"
// convention as DATA_DIR above. Only used to decide the DEFAULT below; an
// explicit per-group `!ai on`/`!ai off` always wins regardless of this.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

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
// `groupId`. A group that's never touched !ai at all (or has no data.json
// entry yet) gets the DEFAULT - on if GEMINI_API_KEY is configured, off
// otherwise (see the file-level comment above for why) - same "undefined
// falls back to the default" shape as spam.js. Once a group has run !ai on
// or !ai off at all, that explicit choice is what's read back here from
// then on, regardless of whether a key is configured.
function isEnabled(groupId) {
  const all = readAll();
  if (!all[groupId] || all[groupId].enabled === undefined) return !!GEMINI_API_KEY;
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
