// test/snoopyVoice.test.js
// Coverage for lib/snoopyVoice.js's speakAsSnoopy() - restyles an
// already-correct reply into Snoopy's voice via a live Gemini call. Never
// calls the real Gemini API: every test injects a fake `client` (same
// tiny @google/genai surface as test/geminiCommand.test.js's own fake
// clients) via speakAsSnoopy's second argument.
//
// GEMINI_API_KEY must be set before lib/config.js (required transitively)
// is first loaded, since it's read once at module-load time - see
// test/snoopyVoiceNoKey.test.js for the "no key configured" case, which
// needs its own separate process for the same reason.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'test-key-not-real';

const { speakAsSnoopy, isSafeRestyle } = require('../lib/snoopyVoice');

function fakeClient(responseText) {
  return {
    models: {
      generateContent: async () => ({ text: responseText }),
    },
  };
}

function fakeClientThatThrows(message) {
  return {
    models: {
      generateContent: async () => {
        throw new Error(message);
      },
    },
  };
}

function fakeClientCapturingConfig(responseText) {
  let capturedArgs = null;
  return {
    client: {
      models: {
        generateContent: async (args) => {
          capturedArgs = args;
          return { text: responseText };
        },
      },
    },
    getCapturedArgs: () => capturedArgs,
  };
}

test('speakAsSnoopy: returns text unchanged (no client call at all) for empty/blank input', async () => {
  const client = fakeClientThatThrows('should never be called');
  assert.equal(await speakAsSnoopy('', { client }), '');
  assert.equal(await speakAsSnoopy('   ', { client }), '   ');
  assert.equal(await speakAsSnoopy(null, { client }), null);
});

test('speakAsSnoopy: returns the restyled text when it passes the safety check', async () => {
  const client = fakeClient('Only a group admin can clear the list - a flying ace has SOME rules.');
  const result = await speakAsSnoopy('Only a group admin can clear the list.', { client });
  assert.match(result, /flying ace/i);
});

test('speakAsSnoopy: sends the original text as part of the prompt', async () => {
  const { client, getCapturedArgs } = fakeClientCapturingConfig('Restyled reply here.');
  await speakAsSnoopy('Current limit: 20', { client });
  const { contents } = getCapturedArgs();
  assert.match(contents, /Current limit: 20/);
});

test('speakAsSnoopy: falls back to the original text when the restyle drops a "!command" token', async () => {
  const client = fakeClient('Try using the limit command instead!'); // dropped the literal "!limit"
  const original = `Usage: !limit <number>, or !limit off to remove it`;
  const result = await speakAsSnoopy(original, { client });
  assert.equal(result, original);
});

test('speakAsSnoopy: falls back to the original text when the restyle is empty/blank', async () => {
  const client = fakeClient('   ');
  const original = 'Only a group admin can clear the list.';
  const result = await speakAsSnoopy(original, { client });
  assert.equal(result, original);
});

test('speakAsSnoopy: falls back to the original text when the restyle is wildly longer than the original', async () => {
  const original = 'Added: Peter';
  const client = fakeClient('x'.repeat(original.length * 3)); // way over the 2.5x cap
  const result = await speakAsSnoopy(original, { client });
  assert.equal(result, original);
});

test('speakAsSnoopy: falls back to the original text when the restyle is wildly shorter than the original', async () => {
  const original = 'This is a reasonably long reply that should not collapse down to almost nothing.';
  const client = fakeClient('Ok.'); // way under the 0.4x floor
  const result = await speakAsSnoopy(original, { client });
  assert.equal(result, original);
});

test('speakAsSnoopy: falls back to the original text (never throws) when the client errors', async () => {
  const client = fakeClientThatThrows('network blip');
  const original = 'Only a group admin can clear the list.';
  const result = await speakAsSnoopy(original, { client });
  assert.equal(result, original);
});

// isSafeRestyle() directly - the cheap local sanity check speakAsSnoopy
// relies on, exported for its own focused coverage.

test('isSafeRestyle: accepts a same-length-ish restyle that preserves every "!command" token', () => {
  assert.equal(isSafeRestyle('Usage: !limit <number>', "Here's the deal: !limit <number>, if you please."), true);
});

test('isSafeRestyle: rejects when a "!command" token is missing from the restyle', () => {
  assert.equal(isSafeRestyle('Usage: !limit <number>', 'Try the limit command.'), false);
});

test('isSafeRestyle: rejects an empty/blank restyle', () => {
  assert.equal(isSafeRestyle('Only a group admin can clear the list.', ''), false);
  assert.equal(isSafeRestyle('Only a group admin can clear the list.', '   '), false);
});

test('isSafeRestyle: rejects a restyle over 2.5x the original length', () => {
  const original = 'Added: Peter';
  assert.equal(isSafeRestyle(original, 'x'.repeat(original.length * 3)), false);
});

test('isSafeRestyle: rejects a restyle under 0.4x the original length', () => {
  const original = 'This is a reasonably long reply that should not collapse down to almost nothing.';
  assert.equal(isSafeRestyle(original, 'Ok.'), false);
});

test('isSafeRestyle: has no "!command" tokens to check when the original has none - only the length/emptiness checks apply', () => {
  assert.equal(isSafeRestyle('Nobody currently owes payment.', 'Well, would you look at that - nobody currently owes a thing!'), true);
});
