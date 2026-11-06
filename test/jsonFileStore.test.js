// test/jsonFileStore.test.js
// Coverage for lib/jsonFileStore.js - the shared JSON-file-backed
// readAll()/writeAll()/ensureFile() trio factored out of store.js/
// spam.js/activity.js/welcome.js/ai.js. Previously this had no dedicated
// test of its own - coverage rested entirely on one incidental caller
// (test/welcome.test.js's corrupt-file-reset test), so the directory-
// creation and atomic-rename paths were never actually exercised
// directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createJsonFileStore } = require('../lib/jsonFileStore');

let dirCounter = 0;
// Each test gets its own fresh, not-yet-created subdirectory - so
// ensureFile()'s directory-creation path is genuinely exercised every
// time, not just once for the whole file.
function freshDataFile(fileName) {
  dirCounter += 1;
  const dir = path.join(os.tmpdir(), `wlb-jsonfilestore-test-${process.pid}-${dirCounter}`);
  return path.join(dir, fileName);
}

test('readAll creates the data directory and file on first use, starting empty', () => {
  const dataFile = freshDataFile('data.json');
  assert.equal(fs.existsSync(path.dirname(dataFile)), false, 'expected the directory not to exist yet');

  const { readAll } = createJsonFileStore(dataFile, '[test]');
  const data = readAll();

  assert.deepEqual(data, {});
  assert.equal(fs.existsSync(dataFile), true, 'expected the file to have been created');
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), {});
});

test('writeAll then readAll round-trips data', () => {
  const dataFile = freshDataFile('data.json');
  const { readAll, writeAll } = createJsonFileStore(dataFile, '[test]');

  writeAll({ groupA: { enabled: true }, groupB: { enabled: false } });

  assert.deepEqual(readAll(), { groupA: { enabled: true }, groupB: { enabled: false } });
});

test('writeAll is atomic-ish: no leftover .tmp file survives a successful write', () => {
  const dataFile = freshDataFile('data.json');
  const { writeAll } = createJsonFileStore(dataFile, '[test]');

  writeAll({ foo: 'bar' });

  assert.equal(fs.existsSync(`${dataFile}.tmp`), false, 'expected the tmp file to have been renamed away, not left behind');
  assert.equal(fs.existsSync(dataFile), true);
});

test('readAll resets to {} (not a throw) and logs with the caller\'s own prefix when the file is corrupt JSON', () => {
  const dataFile = freshDataFile('data.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, 'not valid json{{{');
  const { readAll } = createJsonFileStore(dataFile, '[mytestmodule]');

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  let data;
  try {
    data = readAll();
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(data, {});
  assert.ok(logged.some((line) => line.includes('[mytestmodule]') && line.includes('Corrupt data file')), `expected a corrupt-file log line prefixed with the caller's own tag, got: ${JSON.stringify(logged)}`);
});

test('readAll treats a missing/empty file the same as {} without throwing', () => {
  const dataFile = freshDataFile('data.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, ''); // exists, but empty
  const { readAll } = createJsonFileStore(dataFile, '[test]');

  assert.deepEqual(readAll(), {});
});

test('two independent stores pointed at different files never see each other\'s data', () => {
  const dataFileA = freshDataFile('a.json');
  const dataFileB = freshDataFile('b.json');
  const storeA = createJsonFileStore(dataFileA, '[a]');
  const storeB = createJsonFileStore(dataFileB, '[b]');

  storeA.writeAll({ onlyIn: 'A' });
  storeB.writeAll({ onlyIn: 'B' });

  assert.deepEqual(storeA.readAll(), { onlyIn: 'A' });
  assert.deepEqual(storeB.readAll(), { onlyIn: 'B' });
});
