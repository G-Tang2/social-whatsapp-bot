// test-eval/geminiCommand.eval.js
// Live-model regression suite for lib/geminiCommand.js's interpretMessage().
//
// Unlike test/geminiCommand.test.js (which fakes the Gemini client and only
// covers OUR OWN plumbing - JSON parsing, schema validation, prompt-content
// assembly), every test in here calls interpretMessage() with NO `client`
// override, so it hits the REAL Gemini API using GEMINI_MODEL/GEMINI_API_KEY
// from .env. That's the only way to catch a bug that lives in the PROMPT
// WORDING rather than in our code - a mocked-client test can never catch
// this class of bug: the mock only ever returns exactly what the test
// hands it, so it proves nothing about how the real model reads
// SYSTEM_PROMPT.
//
// Deliberately kept OUT of test/ (and out of any *.test.js naming) so
// `npm test` / plain `node --test` - which must stay fast, free, and fully
// offline for normal dev/CI use - never picks this file up. Run explicitly
// instead:
//
//   npm run test:eval
//
// Requires a real GEMINI_API_KEY in .env (the checked-in .env only ships a
// blank placeholder - see its GEMINI_API_KEY comment). Every test is
// skipped (not failed) when that's not configured, so a machine without a
// key still gets a clean, green (if empty) run rather than a wall of
// errors.
//
// These assertions are necessarily looser than test/geminiCommand.test.js's
// exact-equality checks: a live LLM can phrase things slightly differently
// between runs, so each test asserts the INVARIANT that actually matters
// (e.g. "argText must reference Peter, not some other name") rather than
// byte-for-byte equality, and evalTest() below retries once before failing
// to absorb one-off flakiness rather than a genuine regression. A test that
// still fails after a retry is a real signal, not noise - investigate the
// SYSTEM_PROMPT wording, not just re-run it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { GEMINI_API_KEY } = require('../lib/config');
const { interpretMessage } = require('../lib/geminiCommand');

const skipReason = GEMINI_API_KEY
  ? undefined
  : 'GEMINI_API_KEY is not configured in .env - set a real key to run these live-model evals (see README\'s "Natural-language commands" section). Skipping rather than failing.';

// Retries the whole test body once on assertion failure before giving up -
// absorbs the occasional one-off LLM inconsistency without masking a real,
// repeatable prompt regression (which will fail both attempts). Each
// attempt is a genuine extra API call, so this only wraps tests that
// actually call interpretMessage(), and the suite stays small on purpose.
async function evalTest(name, fn) {
  test(name, { skip: skipReason, timeout: 20000 }, async () => {
    try {
      await fn();
    } catch (firstErr) {
      try {
        await fn();
      } catch {
        throw firstErr; // report the original failure, not the retry's
      }
    }
  });
}

function findAction(result, command) {
  return result.actions.find((a) => a.command === command);
}

// --- Position-based resolution must resolve a referenced position to the
// right name. ---

evalTest('position-based removal ("remove 1 and 2") resolves to the right names', async () => {
  const listText = '*Attendance* (2/10)\n\n1. Sam\n2. Andy';
  const result = await interpretMessage('remove 1 and 2', { listText });
  const out = findAction(result, 'out');
  assert.ok(out, `expected an "out" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.match(out.argText, /\bSam\b/i);
  assert.match(out.argText, /\bAndy\b/i);
});

evalTest('an out-of-range position reference ("remove 1-5" on a 3-person list) never comes back as a confident (high) guess', async () => {
  const listText = '*Attendance* (3/10)\n\n1. Sam\n2. Chris\n3. Linda';
  const result = await interpretMessage('remove 1-5', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const out = findAction(result, 'out');
  if (out) {
    assert.notEqual(out.confidence, 'high', 'an unresolvable position range must not be confidently guessed at');
  }
});

// --- "regular players" is a TOKEN the bot substitutes itself - the model
// must never spell the saved names out even though it can see them. ---

evalTest('"add the regular players" uses the literal "regular players" token, not the spelled-out saved names', async () => {
  const result = await interpretMessage('add the regular players', {
    regularPlayersText: 'Harry, Bonny, Ron',
  });
  const inAction = findAction(result, 'in');
  assert.ok(inAction, `expected an "in" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.match(inAction.argText, /regular players/i);
  assert.doesNotMatch(inAction.argText, /\bHarry\b/i, 'must not spell out the saved roster itself');
});

evalTest('"Harry, Bonny and Ron are our regular players from now on" DEFINES the roster ("regulars"), not the "in" token', async () => {
  const result = await interpretMessage('Harry, Bonny and Ron are our regular players from now on', {
    regularPlayersText: '(none set yet)',
  });
  const regularsAction = findAction(result, 'regulars');
  assert.ok(regularsAction, `expected a "regulars" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.match(regularsAction.argText, /\bHarry\b/i);
  assert.match(regularsAction.argText, /\bBonny\b/i);
  assert.match(regularsAction.argText, /\bRon\b/i);
});

// --- "+N" guest shorthand must continue the sender's existing numbering,
// never restart it or double-count. ---

evalTest('"add 2 more friends" against a sender who already has Jordan+1/+2 on the list asks for "+2", not "+4"', async () => {
  const listText = '*Attendance* (3/10)\n\n1. Jordan\n2. Jordan+1\n3. Jordan+2';
  const result = await interpretMessage('add 2 more friends', { listText });
  const inAction = findAction(result, 'in');
  assert.ok(inAction, `expected an "in" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.equal(inAction.argText.trim(), '+2');
});

// --- A collective name reference ("all the Xs") for "paid" must match
// every entry ACROSS THE WHOLE payment-due section, even ones separated
// from each other by unrelated names, not just a visually clustered run -
// but must NEVER cross into the Attendance section, even for an identical
// name, since being on this week's list doesn't mean they owe anything.
// Real bug report, two rounds: round 1 caught Harry, Harry Li, Harry+1,
// Harry+2, Harry+3 (all consecutive) but missed Harry+4, separated from
// its siblings by Ben/Janelle/Dean; round 2's first fix caught Harry+4 but
// then ALSO wrongly grabbed the bare "Harry" from Attendance (rejected by
// the real markPaid() check, but shouldn't have been guessed at all) -
// see COLLECTIVE NAME REFERENCES and "paid"'s scope note in
// SHARED_ARG_RULES/COMMAND_ARG_GUIDE. ---

evalTest('"all the Harrys paid" catches every matching entry in the payment-due section, including one separated from the rest by unrelated names, but never the unrelated "Harry" in Attendance', async () => {
  const listText =
    '*Attendance* (1/30)\n\n1. Harry\n\n' +
    '──────────\n*Payment*\n\n*19th Aug Wed*\n' +
    '1. Bonny\n2. Ron\n3. Rj\n4. Charlie\n5. Xinny\n6. Harry Li\n7. leg\n8. Kelvin\n9. Tinh\n10. Chris\n' +
    '11. harry+1\n12. harry+2\n13. harry+3\n14. Ben\n15. Janelle\n16. Dean\n17. harry+4\n18. Van';
  const result = await interpretMessage('all the Harrys paid', { listText });
  const paidAction = findAction(result, 'paid');
  assert.ok(paidAction, `expected a "paid" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.match(paidAction.argText, /harry\s*\+\s*1/i);
  assert.match(paidAction.argText, /harry\s*\+\s*2/i);
  assert.match(paidAction.argText, /harry\s*\+\s*3/i);
  assert.match(paidAction.argText, /harry\s*\+\s*4/i, 'must not stop after the consecutive Harry+1..3 run and miss the scattered Harry+4');
  assert.match(paidAction.argText, /harry li/i);
  assert.doesNotMatch(
    paidAction.argText,
    /(^|,)\s*harry\s*(,|$)/i,
    'the bare "Harry" only appears in Attendance, not the payment-due section - must not be guessed as owing money'
  );
});

// --- A self+others split where the tournament flag applies to the WHOLE
// request must tournament-flag BOTH resulting actions, not just the one
// with the named other person. Real bug report: "add me and stella to the
// tournament" added the sender social-only and only Stella into the
// tournament - see SELF+OTHERS SPLIT's added compound-modifier sentence in
// SHARED_ARG_RULES. ---

evalTest('"add me and stella to the tournament" tournament-flags BOTH the sender and Stella, not just one of them', async () => {
  const result = await interpretMessage('add me and stella to the tournament', {
    listText: '*Attendance* (0/10)\n\n(empty - use !in to add your name)',
  });
  assert.ok(result, 'expected a parsed result, not null');
  const inActions = result.actions.filter((a) => a.command === 'in');
  assert.equal(inActions.length, 2, `expected 2 "in" actions (self + Stella), got: ${JSON.stringify(result.actions)}`);
  const selfAction = inActions.find((a) => a.argText.trim().toLowerCase() === 'tournament');
  const stellaAction = inActions.find((a) => /stella/i.test(a.argText));
  assert.ok(selfAction, `expected one action to be the sender alone, tournament-flagged (argText "tournament"), got: ${JSON.stringify(inActions)}`);
  assert.ok(stellaAction, `expected one action naming Stella, got: ${JSON.stringify(inActions)}`);
  assert.match(stellaAction.argText, /^tournament\s*,/i, 'the tournament flag must lead Stella\'s argText too, not just the sender\'s');
});

// --- Compound messages must split into ordered actions, and relative
// dates must resolve against the given "Today is ..." reference. ---

evalTest('a compound message ("new list for next Wednesday ... cap it at 12 ... add X, Y, Z") splits into 3 ordered actions with the date correctly resolved', async () => {
  // Saturday 15/08/2026. "next Wednesday" said on a Saturday must skip the
  // Wednesday later THIS week (19/08) and land on the FOLLOWING week's
  // Wednesday (26/08) - see SYSTEM_PROMPT's RELATIVE DATES rules.
  const result = await interpretMessage(
    'create a new list for next Wednesday at Noble Park courts 1,2. Cap it at 12. Add Keith, Tu and Bao',
    { todayLabel: 'Saturday 15/08' }
  );
  assert.ok(result, 'expected a parsed result, not null');
  assert.equal(result.actions.length, 3, `expected 3 actions, got: ${JSON.stringify(result.actions)}`);
  assert.equal(result.actions[0].command, 'newlist');
  assert.match(result.actions[0].argText, /^26\/08/, 'expected "next Wednesday" from Sat 15/08 to resolve to 26/08');
  assert.equal(result.actions[1].command, 'limit');
  assert.equal(result.actions[1].argText.trim(), '12');
  assert.equal(result.actions[2].command, 'in');
  assert.match(result.actions[2].argText, /\bKeith\b/i);
  assert.match(result.actions[2].argText, /\bTu\b/i);
  assert.match(result.actions[2].argText, /\bBao\b/i);
});

// --- Off-topic chat must map to "none", never a guessed command. ---

evalTest('off-topic small talk maps to "none", not a guessed list command', async () => {
  const result = await interpretMessage('good morning everyone, hope you all had a great weekend!', {
    listText: '*Attendance* (0/10)\n\n(empty - use !in to add your name)',
  });
  assert.ok(result, 'expected a parsed result, not null');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].command, 'none');
});

// --- An off-topic but genuinely answerable question must still map to
// "none" (never a guessed list command), but come back with a short,
// real "offTopicReply" rather than an empty one - see index.js's
// handleAiMention, which sends that reply back with a fixed reminder
// that Snoopy's currently running the signup list. ---

evalTest('"how do I make a sandwich" maps to "none" with a short, real, ON-TOPIC-TO-THE-QUESTION offTopicReply, not an empty one or a guessed list command', async () => {
  const result = await interpretMessage('how do I make a sandwich', {
    listText: '*Attendance* (0/10)\n\n(empty - use !in to add your name)',
  });
  assert.ok(result, 'expected a parsed result, not null');
  assert.equal(result.actions.length, 1, `expected exactly 1 action, got: ${JSON.stringify(result.actions)}`);
  assert.equal(result.actions[0].command, 'none');
  const { offTopicReply } = result.actions[0];
  assert.ok(offTopicReply && offTopicReply.trim(), 'expected a non-empty offTopicReply');
  assert.match(offTopicReply, /bread/i, 'expected the reply to actually be about making a sandwich');
  assert.ok(offTopicReply.length < 300, `expected a brief reply (1-2 sentences), got ${offTopicReply.length} chars: "${offTopicReply}"`);
});

// --- A pasted copy of the list must be recognized as "update", never
// split into a mix of in/out/date/etc. actions. ---

evalTest('a pasted, hand-edited copy of the list maps to a single "update" action', async () => {
  const pasted = 'updated the list, here you go:\n*Attendance* (2/10)\n\n1. Alex\n2. Sam\n\n*Waitlist*\n\n(empty)';
  const result = await interpretMessage(pasted, {
    listText: '*Attendance* (2/10)\n\n1. Alex\n2. Priya',
  });
  assert.ok(result, 'expected a parsed result, not null');
  assert.equal(result.actions.length, 1, `expected exactly 1 action, got: ${JSON.stringify(result.actions)}`);
  assert.equal(result.actions[0].command, 'update');
});

// --- A genuinely ambiguous but clearly list-related message must come back
// low-confidence WITH a specific, non-generic "question" the sender can
// actually answer - not silence, not a guess, and not a vague "can you
// clarify?" - see the QUESTION paragraph in SYSTEM_PROMPT. Real bug report:
// "Janelle paid Janelle in" is genuinely unclear whether it means removing
// Janelle from the payment-due list or adding her to attendance. ---

evalTest('a genuinely ambiguous request ("Janelle paid Janelle in") comes back low-confidence with a specific, non-generic question naming the real fork', async () => {
  const listText =
    '*Attendance* (0/10)\n\n(empty - use !in to add your name)\n\n' +
    '──────────\n*Payment*\n\n*19th Aug Wed*\n1. Janelle';
  const result = await interpretMessage('Janelle paid Janelle in', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const uncertain = result.actions.find((a) => a.confidence === 'low' && a.command !== 'none');
  assert.ok(uncertain, `expected at least one low-confidence, non-"none" action, got: ${JSON.stringify(result.actions)}`);
  assert.ok(uncertain.question && uncertain.question.trim(), 'expected a non-empty "question" on the low-confidence action');
  assert.match(uncertain.question, /\bJanelle\b/i, 'expected the question to actually reference Janelle, not a generic "can you clarify?"');
  assert.doesNotMatch(uncertain.question, /^(can you clarify|i'?m not sure what you mean)\.?$/i, 'expected a specific question, not a generic clarify-request');
});
