// lib/jsonFileStore.js
// Shared JSON-file-backed storage helper. store.js, spam.js, activity.js,
// welcome.js, and ai.js each used to hand-roll their own copy of this
// exact same trio of functions - ensureFile() (create the data dir/file
// on first use), readAll() (read + parse, resetting to {} rather than
// throwing if the file ever comes back corrupt), and writeAll() (an
// atomic-ish write via a tmp file + rename, so a process killed mid-write
// never leaves a half-written file behind) - differing only in which file
// they pointed at and the log prefix on the corrupt-file line. Factored
// out here so there's one place to fix/extend that pattern instead of
// five near-identical copies; behavior is unchanged from what each caller
// had before.
//
// Concurrency note (same as every caller already documented on its own):
// every function below is fully synchronous, so a readAll() -> mutate ->
// writeAll() sequence in a caller is one uninterruptible block on Node's
// single-threaded event loop - concurrent callers can't produce a lost
// update. Don't introduce `await` into that sequence without also adding
// explicit locking; that synchronous atomicity is what keeps it safe.

const fs = require('fs');
const path = require('path');

// `dataFile` is the absolute path to the JSON file this store reads/
// writes (callers build it from their own DATA_DIR + filename, same as
// before). `logPrefix` (e.g. "[spam]") is only used on the corrupt-file
// log line, so each caller's existing log wording is preserved exactly.
function createJsonFileStore(dataFile, logPrefix) {
  const dataDir = path.dirname(dataFile);

  function ensureFile() {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(dataFile)) {
      fs.writeFileSync(dataFile, JSON.stringify({}, null, 2));
    }
  }

  function readAll() {
    ensureFile();
    const raw = fs.readFileSync(dataFile, 'utf8');
    try {
      return JSON.parse(raw || '{}');
    } catch (err) {
      console.error(`${logPrefix} Corrupt data file, resetting.`, err);
      return {};
    }
  }

  function writeAll(data) {
    ensureFile();
    const tmpFile = `${dataFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, dataFile);
  }

  return { readAll, writeAll };
}

module.exports = { createJsonFileStore };
