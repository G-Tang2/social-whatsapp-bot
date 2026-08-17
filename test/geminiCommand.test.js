// test/geminiCommand.test.js
// Coverage for lib/geminiCommand.js's interpretMessage() - the Gemini call
// that maps a natural-language message to one of MAPPABLE_COMMANDS - every
// command the bot has, no exceptions (see that file's comment for the
// full list and how !update in particular is recognized).
// Never calls the real Gemini API: every test injects a fake `client`
// (matching the tiny slice of the @google/genai surface interpretMessage
// actually uses - client.models.generateContent(...).text) via
// interpretMessage's second argument, exactly the seam that file's own
// doc comment describes as test-only.
//
// GEMINI_API_KEY must be set before lib/config.js (required transitively
// via lib/geminiCommand.js) is first loaded, since it's read once at
// module-load time - hence setting it here before any require() below.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'test-key-not-real';

const { interpretMessage, formatTodayForPrompt, formatRegularPlayersForPrompt, MAPPABLE_COMMANDS } = require('../lib/geminiCommand');

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

// Captures the `config` object interpretMessage() passed to
// generateContent, so a test can assert on what WE asked the SDK for
// (e.g. retryOptions) without needing to exercise the real SDK's actual
// retry mechanism - that's Google's code/tests to cover, not ours. See
// the retryOptions test below.
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

test('interpretMessage: returns the parsed { command, argText, confidence } on a valid response', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'in', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('put me down for Saturday', { client });
  assert.deepEqual(result, { actions: [{ command: 'in', argText: '', confidence: 'high' }] });
});

test('interpretMessage: parses explicit names for someone else as a comma-separated argText', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'out', argText: 'Peter, Chris', confidence: 'high' }] }));
  const result = await interpretMessage('take Peter and Chris off', { client });
  assert.equal(result.actions[0].argText, 'Peter, Chris');
  assert.equal(result.actions[0].command, 'out');
});

test('interpretMessage: an admin command (e.g. "clear") is a valid mapped command', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'clear', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('remove everyone from the list', { client });
  assert.deepEqual(result, { actions: [{ command: 'clear', argText: '', confidence: 'high' }] });
});

test('interpretMessage: an admin command with a real argument (e.g. "limit") passes argText through untouched', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'limit', argText: '20', confidence: 'high' }] }));
  const result = await interpretMessage('cap it at 20 people', { client });
  assert.deepEqual(result, { actions: [{ command: 'limit', argText: '20', confidence: 'high' }] });
});

test('interpretMessage: tolerates a markdown code fence around the JSON', async () => {
  const client = fakeClient('```json\n{"actions":[{"command":"list","argText":"","confidence":"high"}]}\n```');
  const result = await interpretMessage('what does the list look like', { client });
  assert.deepEqual(result, { actions: [{ command: 'list', argText: '', confidence: 'high' }] });
});

test('interpretMessage: returns null when the response is not valid JSON', async () => {
  const client = fakeClient('sorry, I cannot help with that');
  const result = await interpretMessage('some message', { client });
  assert.equal(result, null);
});

test('interpretMessage: returns null when the response JSON does not match the schema (bad command value)', async () => {
  // Not a real command at all, in or out of MAPPABLE_COMMANDS.
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'notacommand', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('bulk edit the list', { client });
  assert.equal(result, null);
});

test('interpretMessage: returns null when the response is missing a required field', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'in', argText: '' }] })); // no confidence
  const result = await interpretMessage('put me down', { client });
  assert.equal(result, null);
});

test('interpretMessage: returns null when the response has no "actions" array at all', async () => {
  const client = fakeClient(JSON.stringify({ command: 'in', argText: '', confidence: 'high' })); // old flat shape
  const result = await interpretMessage('put me down', { client });
  assert.equal(result, null);
});

test('interpretMessage: returns null when "actions" is an empty array', async () => {
  const client = fakeClient(JSON.stringify({ actions: [] }));
  const result = await interpretMessage('put me down', { client });
  assert.equal(result, null);
});

test('interpretMessage: returns null (not a throw) when the API call itself fails', async () => {
  const client = fakeClientThatThrows('network error');
  const result = await interpretMessage('put me down', { client });
  assert.equal(result, null);
});

test('interpretMessage: asks the SDK to retry transient failures (retryOptions.attempts > 1) rather than giving up on the first hiccup', async () => {
  const { client, getCapturedArgs } = fakeClientCapturingConfig(
    JSON.stringify({ actions: [{ command: 'in', argText: '', confidence: 'high' }] })
  );
  await interpretMessage('put me down', { client });
  const { config } = getCapturedArgs();
  // The actual retry behavior (which statuses, backoff, even retrying a
  // timed-out/aborted attempt) is the SDK's own responsibility - verified
  // directly against node_modules/@google/genai's source, see
  // lib/geminiCommand.js's RETRY_OPTIONS comment. This only checks that
  // OUR code asks for more than a single attempt.
  assert.ok(config.httpOptions.retryOptions, 'expected retryOptions to be set');
  assert.ok(config.httpOptions.retryOptions.attempts > 1, 'expected more than one attempt configured');
});

test('interpretMessage: includes the given listText in the prompt sent to the model, so position references (e.g. "remove 1-3") can be resolved', async () => {
  const { client, getCapturedArgs } = fakeClientCapturingConfig(
    JSON.stringify({ actions: [{ command: 'out', argText: 'Peter, Chris', confidence: 'high' }] })
  );
  const listText = '*Attendance* (3/10)\n\n1. Peter\n2. Chris\n3. Linda';
  await interpretMessage('remove 1-2', { client, listText });
  const { contents } = getCapturedArgs();
  assert.match(contents, /1\. Peter/, 'expected the numbered list to appear in the prompt sent to the model');
});

test('interpretMessage: omitting listText still works (no list context, same as before this option existed)', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'list', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('what does the list look like', { client });
  assert.deepEqual(result, { actions: [{ command: 'list', argText: '', confidence: 'high' }] });
});

test('interpretMessage: includes the given todayLabel in the prompt sent to the model, so relative dates (e.g. "next Wednesday") can be resolved for !newlist/!date', async () => {
  const { client, getCapturedArgs } = fakeClientCapturingConfig(
    JSON.stringify({ actions: [{ command: 'newlist', argText: '20/08', confidence: 'high' }] })
  );
  await interpretMessage('create a new list for next Wednesday', { client, todayLabel: 'Saturday 15/08' });
  const { contents } = getCapturedArgs();
  assert.match(contents, /Today is Saturday 15\/08/, 'expected the today reference to appear in the prompt sent to the model');
});

test('interpretMessage: omitting todayLabel still works (no date-reference context, same as before this option existed)', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'list', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('what does the list look like', { client });
  assert.deepEqual(result, { actions: [{ command: 'list', argText: '', confidence: 'high' }] });
});

test('formatTodayForPrompt: formats as "<weekday> DD/MM" in the given timezone', () => {
  // A fixed instant (not the real clock, not the host's timezone) so this
  // test is deterministic - see lib/lastSeenStatus.js's own
  // formatLastSeenStatus tests for the same pattern.
  const date = new Date('2026-08-15T12:00:00Z'); // a Saturday
  assert.equal(formatTodayForPrompt(date, 'UTC'), 'Saturday 15/08');
});

test('formatTodayForPrompt: a timezone offset that shifts the calendar day changes the result', () => {
  // Just before midnight UTC on the 15th is already the 16th in a
  // timezone comfortably ahead of UTC - confirms this actually resolves
  // against the given timeZone rather than always using UTC/server time.
  const date = new Date('2026-08-15T23:30:00Z');
  assert.equal(formatTodayForPrompt(date, 'UTC'), 'Saturday 15/08');
  assert.equal(formatTodayForPrompt(date, 'Australia/Sydney'), 'Sunday 16/08');
});

test('formatRegularPlayersForPrompt: joins names with commas, or a placeholder for an empty/missing roster', () => {
  assert.equal(formatRegularPlayersForPrompt(['Harry', 'Bonny', 'Ron']), 'Harry, Bonny, Ron');
  assert.equal(formatRegularPlayersForPrompt([]), '(none set yet)');
  assert.equal(formatRegularPlayersForPrompt(undefined), '(none set yet)');
});

test('interpretMessage: includes the given regularPlayersText in the prompt sent to the model, so "add the regular players" can be told apart from redefining the roster', async () => {
  const { client, getCapturedArgs } = fakeClientCapturingConfig(
    JSON.stringify({ actions: [{ command: 'in', argText: 'regular players', confidence: 'high' }] })
  );
  await interpretMessage('add the regular players', { client, regularPlayersText: 'Harry, Bonny, Ron' });
  const { contents } = getCapturedArgs();
  assert.match(contents, /REGULAR PLAYERS: Harry, Bonny, Ron/, 'expected the regular-players roster to appear in the prompt sent to the model');
});

test('interpretMessage: omitting regularPlayersText still works (no roster context, same as before this option existed)', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'list', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('what does the list look like', { client });
  assert.deepEqual(result, { actions: [{ command: 'list', argText: '', confidence: 'high' }] });
});

test('interpretMessage: returns null for blank text without even calling the client', async () => {
  let called = false;
  const client = { models: { generateContent: async () => { called = true; return { text: '{}' }; } } };
  const result = await interpretMessage('   ', { client });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('MAPPABLE_COMMANDS: includes every single command the bot has, no exceptions - plus "none"', () => {
  for (const cmd of ['in', 'out', 'paid', 'list', 'clear', 'clearpayments', 'newlist', 'date', 'location', 'courts', 'time', 'limit', 'allow', 'paymentlabel', 'regulars', 'undo', 'update', 'inactivity', 'stale', 'spamfilter', 'ai', 'help', 'admin', 'none']) {
    assert.ok(MAPPABLE_COMMANDS.includes(cmd), `expected MAPPABLE_COMMANDS to include "${cmd}"`);
  }
  // Exact-length check too, not just "includes every expected one" - so an
  // accidental extra/duplicate entry in MAPPABLE_COMMANDS (which wouldn't
  // be caught by the loop above) still fails this test.
  assert.equal(MAPPABLE_COMMANDS.length, 24);
});

test('interpretMessage: "regulars" (e.g. declaring the regulars) is a valid mapped command', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'regulars', argText: 'Harry, Bonny, Ron', confidence: 'high' }] }));
  const result = await interpretMessage('these people are regular players: Harry, Bonny, Ron', { client });
  assert.deepEqual(result, { actions: [{ command: 'regulars', argText: 'Harry, Bonny, Ron', confidence: 'high' }] });
});

test('interpretMessage: "undo" (e.g. reversing the last change) is a valid mapped command, with no argument', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'undo', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('undo that, that was a mistake', { client });
  assert.deepEqual(result, { actions: [{ command: 'undo', argText: '', confidence: 'high' }] });
});

test('interpretMessage: "update" (a pasted, hand-edited copy of the list) is a valid mapped command, with the whole message passed through as argText', async () => {
  const pasted = 'here you go:\n*Attendance* (2/10)\n\n1. Alex\n2. Sam';
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'update', argText: pasted, confidence: 'high' }] }));
  const result = await interpretMessage(pasted, { client });
  assert.deepEqual(result, { actions: [{ command: 'update', argText: pasted, confidence: 'high' }] });
});

test('interpretMessage: "help" (a general "what can you do" request) is a valid mapped command, with no argument', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'help', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('what can you do', { client });
  assert.deepEqual(result, { actions: [{ command: 'help', argText: '', confidence: 'high' }] });
});

test('interpretMessage: "admin" (a request specifically about admin commands) is a valid mapped command, with no argument', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'admin', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('what admin commands are there', { client });
  assert.deepEqual(result, { actions: [{ command: 'admin', argText: '', confidence: 'high' }] });
});

// --- Compound messages: a single @-mention that bundles multiple distinct
// requests together (e.g. "start a new list ... and cap it at 12 ... and
// add these people") maps to MULTIPLE actions, dispatched in order - see
// SYSTEM_PROMPT's "MULTIPLE ACTIONS" rules and index.js's handleAiMention
// for how each one gets dispatched to the exact same handler a typed
// command would hit. ---

test('interpretMessage: a compound message maps to multiple actions, returned in the order they should run', async () => {
  const client = fakeClient(JSON.stringify({
    actions: [
      { command: 'newlist', argText: '23/08 Noble Park | 1, 2 | 7pm-9pm', confidence: 'high' },
      { command: 'limit', argText: '12', confidence: 'high' },
      { command: 'in', argText: 'Keith, Tu, Bao', confidence: 'high' },
    ],
  }));
  const result = await interpretMessage(
    'create a new list for next Sunday at Noble Park courts 1,2 at 7pm-9pm. Cap it at 12. Add Keith, Tu and Bao',
    { client }
  );
  assert.equal(result.actions.length, 3);
  assert.equal(result.actions[0].command, 'newlist');
  assert.equal(result.actions[1].command, 'limit');
  assert.equal(result.actions[1].argText, '12');
  assert.equal(result.actions[2].command, 'in');
  assert.equal(result.actions[2].argText, 'Keith, Tu, Bao');
});

test('interpretMessage: returns null when an action inside a multi-action response fails validation (bad command value)', async () => {
  const client = fakeClient(JSON.stringify({
    actions: [
      { command: 'newlist', argText: '23/08', confidence: 'high' },
      { command: 'notacommand', argText: '', confidence: 'high' },
    ],
  }));
  const result = await interpretMessage('start a new list and do something weird', { client });
  assert.equal(result, null);
});

test('interpretMessage: a single ordinary request still comes back as a one-item actions array (not a bare object)', async () => {
  const client = fakeClient(JSON.stringify({ actions: [{ command: 'in', argText: '', confidence: 'high' }] }));
  const result = await interpretMessage('put me down', { client });
  assert.deepEqual(result, { actions: [{ command: 'in', argText: '', confidence: 'high' }] });
});