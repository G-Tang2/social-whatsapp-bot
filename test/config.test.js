// test/config.test.js
// Focused coverage for lib/config.js's DM_REPLIES_ENABLED parsing - the one
// setting a test needs to flip per-case (rather than once at file load,
// like everything else this codebase reads from process.env), since it's
// meant to be toggled per-deployment via .env (see index.js's DM redirect
// branch and lib/config.js's own doc comment on DM_REPLIES_ENABLED for why:
// running more than one deployment of this bot as separate companion
// devices on the SAME WhatsApp number means every deployment receives
// every DM, so all but one need this turned off).

const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = require.resolve('../lib/config');

function freshConfig(envValue) {
  delete require.cache[configPath];
  if (envValue === undefined) delete process.env.DM_REPLIES_ENABLED;
  else process.env.DM_REPLIES_ENABLED = envValue;
  return require('../lib/config');
}

test('DM_REPLIES_ENABLED defaults to true when unset', () => {
  assert.equal(freshConfig(undefined).DM_REPLIES_ENABLED, true);
});

test('DM_REPLIES_ENABLED is false when explicitly set to "false", case-insensitively', () => {
  assert.equal(freshConfig('false').DM_REPLIES_ENABLED, false);
  assert.equal(freshConfig('FALSE').DM_REPLIES_ENABLED, false);
});

test('DM_REPLIES_ENABLED stays true for any other value, including a typo', () => {
  assert.equal(freshConfig('true').DM_REPLIES_ENABLED, true);
  assert.equal(freshConfig('nope').DM_REPLIES_ENABLED, true);
});

test.after(() => {
  delete process.env.DM_REPLIES_ENABLED;
  delete require.cache[configPath];
});
