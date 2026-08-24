// test/snoopyVoiceNoKey.test.js
// Coverage for lib/snoopyVoice.js's speakAsSnoopy() when GEMINI_API_KEY
// isn't configured at all - own file/process, same reasoning as
// test/vacancyReminderImageMissing.test.js and friends: the config value
// is read once at require time, so it can't be toggled per-test within
// test/snoopyVoice.test.js (which deliberately sets a fake key to cover
// the "Gemini is configured" behavior).

const test = require('node:test');
const assert = require('node:assert/strict');

// Deliberately FORCED empty (not just omitted) - dotenv only fills in a
// var that's genuinely ABSENT from process.env, so merely deleting it
// here would let a real GEMINI_API_KEY from this machine's own .env leak
// back in and silently break this test - same "force empty, don't just
// delete" reasoning as test/ai.test.js's own equivalent.
process.env.GEMINI_API_KEY = '';

const { speakAsSnoopy } = require('../lib/snoopyVoice');

test('speakAsSnoopy: returns the original text unchanged, with no client call at all, when GEMINI_API_KEY is not configured', async () => {
  let called = false;
  const client = {
    models: {
      generateContent: async () => {
        called = true;
        return { text: 'should never get here' };
      },
    },
  };

  const original = 'Only a group admin can clear the list - even a doghouse-dwelling flying ace has rules to follow.';
  const result = await speakAsSnoopy(original, { client });

  assert.equal(result, original);
  assert.equal(called, false, 'expected no Gemini call at all when no key is configured - the hand-written text is already the "generic Snoopy response"');
});
