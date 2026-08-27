// test/welcome.test.js
// Coverage for welcome.js (per-group on/off toggle for the "someone joined"
// welcome message - see index.js's handleGroupParticipantsUpdate for what
// actually gets sent).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-welcome-test-'));
process.env.DATA_DIR = tmpDir;

const welcome = require('../welcome');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `welcome-test-${groupCounter}@g.us`;
}

test('welcome: isEnabled defaults to true (on by default) and setEnabled persists both ways', () => {
  const groupId = freshGroupId();
  // A group that's never touched !welcome gets the message automatically.
  assert.equal(welcome.isEnabled(groupId), true);
  welcome.setEnabled(groupId, false);
  assert.equal(welcome.isEnabled(groupId), false);
  welcome.setEnabled(groupId, true);
  assert.equal(welcome.isEnabled(groupId), true);
});

test('welcome: isEnabled is per-group - turning it off for one group leaves another untouched', () => {
  const groupA = freshGroupId();
  const groupB = freshGroupId();
  welcome.setEnabled(groupA, false);
  assert.equal(welcome.isEnabled(groupA), false);
  assert.equal(welcome.isEnabled(groupB), true);
});

test('welcome: corrupt data file resets to on-by-default rather than throwing', () => {
  const groupId = freshGroupId();
  welcome.setEnabled(groupId, false); // ensure the file exists first
  const dataFile = path.join(tmpDir, 'welcome.json');
  fs.writeFileSync(dataFile, 'not valid json{{{');
  assert.equal(welcome.isEnabled(groupId), true);
});
