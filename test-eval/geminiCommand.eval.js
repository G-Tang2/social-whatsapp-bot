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
// (e.g. "argText must reference Alice, not some other name") rather than
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
//
// 90s timeout, not node:test's much shorter default - a SINGLE
// interpretMessage() call's own worst case (TIMEOUT_MS x its 2 attempts,
// plus backoff - see lib/geminiCommand.js's own comment) already
// approaches 45s on its own, and this wrapper can call fn() TWICE (the
// retry-once above) if the first attempt's assertions fail. A tighter
// ceiling here (this used to be a now-too-thin 20000ms, exactly equal to
// TIMEOUT_MS alone) risks the HARNESS timing a test out on nothing more
// than an ordinarily slow response, before interpretMessage() ever got a
// real chance to finish its own retry sequence - a false failure, not a
// real one.
async function evalTest(name, fn) {
  test(name, { skip: skipReason, timeout: 90000 }, async () => {
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
// right person - either as bare numbers (the NUMBERED LIST REFERENCES
// convention, deferred to the deterministic resolver) or as their real
// name, never anything invented. ---

evalTest('position-based removal ("remove 1 and 2") resolves to the right people, as numbers or names', async () => {
  const listText = '*Attendance* (2/10)\n\n1. Henry\n2. Caleb';
  const result = await interpretMessage('remove 1 and 2', { listText });
  const out = findAction(result, 'out');
  assert.ok(out, `expected an "out" action, got: ${JSON.stringify(result && result.actions)}`);
  const tokens = out.argText.split(',').map((t) => t.trim()).filter(Boolean);
  const realNames = ['henry', 'caleb'];
  for (const token of tokens) {
    const isNumber = /^\d+$/.test(token);
    const isRealName = realNames.includes(token.toLowerCase());
    assert.ok(isNumber || isRealName, `argText token "${token}" is neither a bare number nor a real name from the list`);
  }
  assert.equal(tokens.length, 2, `expected exactly 2 tokens (both people), got: "${out.argText}"`);
});

// Updated for the added NUMBERED LIST REFERENCES rule (SHARED_ARG_RULES):
// the model is now explicitly told to pass bare numbers straight through
// rather than resolve them to names itself, deferring range-validation to
// commands/list.js's deterministic resolver - so "high" confidence with
// the numbers passed through as-is (even the out-of-range 4/5) is now
// CORRECT, expected behavior, not a bug: the resolver safely discards 4
// and 5 downstream (see test/helpers.test.js's own coverage of that). The
// invariant that actually matters here is narrower - argText must never
// invent a 4th/5th NAME that was never on the list at all.
evalTest('an out-of-range position reference ("remove 1-5" on a 3-person list) never invents a name that was never on the list', async () => {
  const listText = '*Attendance* (3/10)\n\n1. Henry\n2. Bob\n3. Carla';
  const result = await interpretMessage('remove 1-5', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const out = findAction(result, 'out');
  if (!out) return; // "low" confidence with no "out" action at all is also fine
  const tokens = out.argText.split(',').map((t) => t.trim()).filter(Boolean);
  const realNames = ['henry', 'bob', 'carla'];
  for (const token of tokens) {
    const isNumber = /^\d+$/.test(token);
    const isRealName = realNames.includes(token.toLowerCase());
    assert.ok(isNumber || isRealName, `argText token "${token}" is neither a bare number nor a real name from the list - looks like an invented match`);
  }
});

// --- "regular players" is a TOKEN the bot substitutes itself - the model
// must never spell the saved names out even though it can see them. ---

evalTest('"add the regular players" uses the literal "regular players" token, not the spelled-out saved names', async () => {
  const result = await interpretMessage('add the regular players', {
    regularPlayersText: 'Oscar, Tessa, Victor',
  });
  const inAction = findAction(result, 'in');
  assert.ok(inAction, `expected an "in" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.match(inAction.argText, /regular players/i);
  assert.doesNotMatch(inAction.argText, /\bOscar\b/i, 'must not spell out the saved roster itself');
});

evalTest('"Oscar, Tessa and Victor are our regular players from now on" DEFINES the roster ("regulars"), not the "in" token', async () => {
  const result = await interpretMessage('Oscar, Tessa and Victor are our regular players from now on', {
    regularPlayersText: '(none set yet)',
  });
  const regularsAction = findAction(result, 'regulars');
  assert.ok(regularsAction, `expected a "regulars" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.match(regularsAction.argText, /\bOscar\b/i);
  assert.match(regularsAction.argText, /\bTessa\b/i);
  assert.match(regularsAction.argText, /\bVictor\b/i);
});

// --- "+N" guest shorthand must continue the sender's existing numbering,
// never restart it or double-count. ---

evalTest('"add 2 more friends" against a sender who already has Preston+1/+2 on the list asks for "+2", not "+4"', async () => {
  const listText = '*Attendance* (3/10)\n\n1. Preston\n2. Preston+1\n3. Preston+2';
  const result = await interpretMessage('add 2 more friends', { listText });
  const inAction = findAction(result, 'in');
  assert.ok(inAction, `expected an "in" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.equal(inAction.argText.trim(), '+2');
});

// --- Explicitly naming someone ELSE's guests using the same "+1"/"+2"
// convention the list itself displays must be read as literal names for
// THAT person's party, never confused with the sender's own "+N" unnamed-
// guest shorthand. Real bug report: Derek (not otherwise on the list)
// sent "add Alice, Alice+1, Alice+2" and the bot added Alice correctly,
// but ALSO separately added Derek himself plus 3 more guests (Derek,
// Derek+1, Derek+2, Derek+3) - as if "Alice, Alice+1, Alice+2" had been
// silently reinterpreted as the sender's own "+3" - see the added
// disambiguating sentence on "+N" UNNAMED GUESTS in SHARED_ARG_RULES. ---

evalTest('"add Alice, Alice+1, Alice+2" adds exactly those three literal names in ONE action, and never adds the sender (who was never mentioned)', async () => {
  const listText = '*Attendance* (0/10)\n\n(empty - use !in to add your name)';
  const result = await interpretMessage('add Alice, Alice+1, Alice+2', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const inActions = result.actions.filter((a) => a.command === 'in');
  assert.equal(inActions.length, 1, `expected exactly 1 "in" action, not a second one for the sender, got: ${JSON.stringify(result.actions)}`);
  const names = inActions[0].argText.split(',').map((n) => n.trim().toLowerCase());
  assert.deepEqual(names, ['alice', 'alice+1', 'alice+2'], `expected the three literal names verbatim, got argText: "${inActions[0].argText}"`);
});

// --- A collective name reference ("all the Xs") for "paid" must match
// every entry ACROSS THE WHOLE payment-due section, even ones separated
// from each other by unrelated names, not just a visually clustered run -
// but must NEVER cross into the Attendance section, even for an identical
// name, since being on this week's list doesn't mean they owe anything.
// Real bug report, two rounds: round 1 caught Oscar, Oscar Li, Oscar+1,
// Oscar+2, Oscar+3 (all consecutive) but missed Oscar+4, separated from
// its siblings by Hugo/Megan/Patrick; round 2's first fix caught Oscar+4 but
// then ALSO wrongly grabbed the bare "Oscar" from Attendance (rejected by
// the real markPaid() check, but shouldn't have been guessed at all) -
// see COLLECTIVE NAME REFERENCES and "paid"'s scope note in
// SHARED_ARG_RULES/COMMAND_ARG_GUIDE. ---

evalTest('"all the Oscars paid" catches every matching entry in the payment-due section, including one separated from the rest by unrelated names, but never the unrelated "Oscar" in Attendance', async () => {
  const listText =
    '*Attendance* (1/30)\n\n1. Oscar\n\n' +
    '──────────\n*Payment*\n\n*19th Aug Wed*\n' +
    '1. Tessa\n2. Victor\n3. Xavier\n4. Zoe\n5. Kyra\n6. Oscar Li\n7. leg\n8. Lincoln\n9. Ravi\n10. Bob\n' +
    '11. oscar+1\n12. oscar+2\n13. oscar+3\n14. Hugo\n15. Megan\n16. Patrick\n17. oscar+4\n18. Sean';
  const result = await interpretMessage('all the Oscars paid', { listText });
  const paidAction = findAction(result, 'paid');
  assert.ok(paidAction, `expected a "paid" action, got: ${JSON.stringify(result && result.actions)}`);
  assert.match(paidAction.argText, /oscar\s*\+\s*1/i);
  assert.match(paidAction.argText, /oscar\s*\+\s*2/i);
  assert.match(paidAction.argText, /oscar\s*\+\s*3/i);
  assert.match(paidAction.argText, /oscar\s*\+\s*4/i, 'must not stop after the consecutive Oscar+1..3 run and miss the scattered Oscar+4');
  assert.match(paidAction.argText, /oscar li/i);
  assert.doesNotMatch(
    paidAction.argText,
    /(^|,)\s*oscar\s*(,|$)/i,
    'the bare "Oscar" only appears in Attendance, not the payment-due section - must not be guessed as owing money'
  );
});

// --- A self+others split where the tournament flag applies to the WHOLE
// request must tournament-flag BOTH resulting actions, not just the one
// with the named other person. Real bug report: "add me and julia to the
// tournament" added the sender social-only and only Julia into the
// tournament - see SELF+OTHERS SPLIT's added compound-modifier sentence in
// SHARED_ARG_RULES. ---

evalTest('"add me and julia to the tournament" tournament-flags BOTH the sender and Julia, not just one of them', async () => {
  const result = await interpretMessage('add me and julia to the tournament', {
    listText: '*Attendance* (0/10)\n\n(empty - use !in to add your name)',
  });
  assert.ok(result, 'expected a parsed result, not null');
  const inActions = result.actions.filter((a) => a.command === 'in');
  assert.equal(inActions.length, 2, `expected 2 "in" actions (self + Julia), got: ${JSON.stringify(result.actions)}`);
  const selfAction = inActions.find((a) => a.argText.trim().toLowerCase() === 'tournament');
  const juliaAction = inActions.find((a) => /julia/i.test(a.argText));
  assert.ok(selfAction, `expected one action to be the sender alone, tournament-flagged (argText "tournament"), got: ${JSON.stringify(inActions)}`);
  assert.ok(juliaAction, `expected one action naming Julia, got: ${JSON.stringify(inActions)}`);
  assert.match(juliaAction.argText, /^tournament\s*,/i, 'the tournament flag must lead Julia\'s argText too, not just the sender\'s');
});

// --- Asking to join BOTH the tournament AND the social list in the same
// request must be ONE tournament-flagged action, never two - a tournament
// entry already IS a social/attendance entry, so there's nothing separate
// to add. Real bug report: "add me to competition and social" produced
// TWO actions (one tournament-flagged, one plain self-add) - the plain
// one ran second, found the sender already added by the first, and
// replied "you're already on the list" even though the tournament add
// itself had genuinely succeeded - see TOURNAMENT FLAG's added
// "competition and social" sentence in SHARED_ARG_RULES. ---

evalTest('"add me to competition and social" is a single tournament-flagged action, not two redundant ones', async () => {
  const listText =
    '*Attendance* (0/16)\n\n🏆 *Tournament* (0/16)\nAsk @Snoopy for details\n\n(empty)\n\nSocial only\n\n(none yet)';
  const result = await interpretMessage('add me to competition and social', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const inActions = result.actions.filter((a) => a.command === 'in');
  assert.equal(inActions.length, 1, `expected exactly 1 "in" action, not a separate redundant plain add, got: ${JSON.stringify(result.actions)}`);
  assert.equal(inActions[0].argText.trim().toLowerCase(), 'tournament', `expected the sole action to be tournament-flagged for the sender alone, got argText: "${inActions[0].argText}"`);
});

// --- "allow N extra to the limit" must raise the LIMIT itself (compute
// current + N from the list header), not be misread as the "allow"
// command just because it contains the word "allow" - "allow" specifically
// does NOT change the cap, which is the opposite of what this phrasing
// asks for. Real bug report: "allow 2 extra to the limit" against a
// current limit of 36 mapped to "allow" (pulled 1 person off the
// waitlist, limit stayed 36) instead of "limit" with argText "38" - see
// the added disambiguation on "limit"/"allow" in COMMAND_ARG_GUIDE. ---

evalTest('"allow 2 extra to the limit" raises the limit itself (36 -> 38), not the "allow" command', async () => {
  const listText = '*Attendance* (34/36)\n\n' + Array.from({ length: 34 }, (_, i) => `${i + 1}. Player${i + 1}`).join('\n')
    + '\n\n*Waitlist* (1)\n\n1. Waiter1';
  const result = await interpretMessage('allow 2 extra to the limit', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const limitAction = findAction(result, 'limit');
  const allowAction = findAction(result, 'allow');
  assert.ok(limitAction, `expected a "limit" action, got: ${JSON.stringify(result.actions)}`);
  assert.equal(limitAction.argText.trim(), '38', `expected the new limit to be computed as current (36) + 2, got argText: "${limitAction.argText}"`);
  assert.ok(!allowAction, `must NOT map to "allow" just because the word "allow" appears - that command never changes the cap, which is the opposite of what was asked, got: ${JSON.stringify(result.actions)}`);
});

// --- A bare, single-word message that's JUST the command's own verb (no
// name, no other words at all) must still be read as the sender alone,
// high confidence - not dropped to "low"/"none" for being too sparse.
// Real bug report: someone replying "paid" on its own wasn't recognized
// as them marking themselves paid - see SELF+OTHERS SPLIT's added
// bare-verb sentence in SHARED_ARG_RULES. ---

evalTest('a bare "paid" with nothing else maps to a high-confidence "paid" action for the sender alone (empty argText)', async () => {
  const listText =
    '*Attendance* (0/10)\n\n(empty - use !in to add your name)\n\n'
    + '──────────\n*Payment*\n\n*19th Aug Wed*\n1. Ian';
  const result = await interpretMessage('paid', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  assert.equal(result.actions.length, 1, `expected exactly 1 action, got: ${JSON.stringify(result.actions)}`);
  assert.equal(result.actions[0].command, 'paid');
  assert.equal(result.actions[0].confidence, 'high');
  assert.equal(result.actions[0].argText.trim(), '', 'expected an empty argText (the sender alone), not a guessed/invented name');
});

// --- "social only" phrased WITH an explicit verb ("add X to social only")
// must be recognized the same as the bare "<name> social only" form - never
// tournament-flagged. Real bug report: "add Kiara and Lauren to social
// only" tournament-flagged them instead of leaving them social-only - the
// SPECIAL CASE for "in" only covered the bare, no-verb phrasing before this
// fix - see its widened wording in COMMAND_ARG_GUIDE. ---

evalTest('"add Kiara and Lauren to social only" adds them WITHOUT the tournament flag, even with an explicit "add ... to" verb', async () => {
  const result = await interpretMessage('add Kiara and Lauren to social only', {
    listText: '*Attendance* (0/10)\n\n(empty - use !in to add your name)',
  });
  assert.ok(result, 'expected a parsed result, not null');
  const inAction = result.actions.find((a) => a.command === 'in');
  assert.ok(inAction, `expected an "in" action, got: ${JSON.stringify(result.actions)}`);
  assert.match(inAction.argText, /\bKiara\b/i);
  assert.match(inAction.argText, /\bLauren\b/i);
  assert.doesNotMatch(inAction.argText, /tournament/i, 'must NOT be tournament-flagged - "social only" explicitly says the opposite');
});

// --- Compound messages must split into ordered actions, and relative
// dates must resolve against the given "Today is ..." reference. ---

evalTest('a compound message ("new list for next Wednesday ... cap it at 12 ... add X, Y, Z") splits into 3 ordered actions with the date correctly resolved', async () => {
  // Saturday 15/08/2026. "next Wednesday" said on a Saturday means the very
  // next Wednesday (19/08), same as bare "Wednesday"/"this Wednesday" would -
  // NOT skip a whole extra week. Confirmed with the user directly: despite
  // an earlier version of this test/rule claiming "next" always skips to the
  // FOLLOWING week's occurrence, that's not what most people mean by it (and
  // the model itself consistently resisted that reading even with an
  // explicit worked example) - see SYSTEM_PROMPT's RELATIVE DATES rules.
  const result = await interpretMessage(
    'create a new list for next Wednesday at Noble Park courts 1,2. Cap it at 12. Add Derek, Ellen and Frank',
    { todayLabel: 'Saturday 15/08' }
  );
  assert.ok(result, 'expected a parsed result, not null');
  assert.equal(result.actions.length, 3, `expected 3 actions, got: ${JSON.stringify(result.actions)}`);
  assert.equal(result.actions[0].command, 'newlist');
  assert.match(result.actions[0].argText, /^19\/08/, 'expected "next Wednesday" from Sat 15/08 to resolve to 19/08, the very next Wednesday');
  assert.equal(result.actions[1].command, 'limit');
  assert.equal(result.actions[1].argText.trim(), '12');
  assert.equal(result.actions[2].command, 'in');
  assert.match(result.actions[2].argText, /\bDerek\b/i);
  assert.match(result.actions[2].argText, /\bEllen\b/i);
  assert.match(result.actions[2].argText, /\bFrank\b/i);
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
  const pasted = 'updated the list, here you go:\n*Attendance* (2/10)\n\n1. Grace\n2. Henry\n\n*Waitlist*\n\n(empty)';
  const result = await interpretMessage(pasted, {
    listText: '*Attendance* (2/10)\n\n1. Grace\n2. Renee',
  });
  assert.ok(result, 'expected a parsed result, not null');
  assert.equal(result.actions.length, 1, `expected exactly 1 action, got: ${JSON.stringify(result.actions)}`);
  assert.equal(result.actions[0].command, 'update');
});

// --- A genuinely ambiguous but clearly list-related message must come back
// low-confidence WITH a specific, non-generic "question" the sender can
// actually answer - not silence, not a guess, and not a vague "can you
// clarify?" - see the QUESTION paragraph in SYSTEM_PROMPT. Real bug report:
// "Megan paid Megan in" is genuinely unclear whether it means removing
// Megan from the payment-due list or adding her to attendance. ---

evalTest('a genuinely ambiguous request ("Megan paid Megan in") comes back low-confidence with a specific, non-generic question naming the real fork', async () => {
  const listText =
    '*Attendance* (0/10)\n\n(empty - use !in to add your name)\n\n' +
    '──────────\n*Payment*\n\n*19th Aug Wed*\n1. Megan';
  const result = await interpretMessage('Megan paid Megan in', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const uncertain = result.actions.find((a) => a.confidence === 'low' && a.command !== 'none');
  assert.ok(uncertain, `expected at least one low-confidence, non-"none" action, got: ${JSON.stringify(result.actions)}`);
  assert.ok(uncertain.question && uncertain.question.trim(), 'expected a non-empty "question" on the low-confidence action');
  assert.match(uncertain.question, /\bMegan\b/i, 'expected the question to actually reference Megan, not a generic "can you clarify?"');
  assert.doesNotMatch(uncertain.question, /^(can you clarify|i'?m not sure what you mean)\.?$/i, 'expected a specific question, not a generic clarify-request');
});

// --- A "courts" request giving only a COUNT ("we have 6 courts now") with
// no actual court numbers must ask specifically for the numbers, not a
// generic add-vs-replace choice - argText needs real numbers/ranges either
// way, so that's the actually-missing information, not which of the two
// modes it is. Real user report: the model's question offered "add 6
// extra courts" vs. "replace with court 6" - a false choice that doesn't
// resolve anything, since neither answer alone gives usable court numbers -
// see the added SPECIAL CASE sentence on "courts" in COMMAND_ARG_GUIDE. ---

evalTest('"we have 6 courts now" (a bare count, no court numbers) asks specifically for the court numbers, not add-vs-replace', async () => {
  const listText = '*Attendance* (0/10)\n\n(empty - use !in to add your name)';
  const result = await interpretMessage('we have 6 courts now', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const uncertain = result.actions.find((a) => a.command === 'courts' && a.confidence === 'low');
  assert.ok(uncertain, `expected a low-confidence "courts" action, got: ${JSON.stringify(result.actions)}`);
  assert.ok(uncertain.question && uncertain.question.trim(), 'expected a non-empty "question"');
  assert.match(uncertain.question, /which|what/i, 'expected the question to ask for the actual court numbers');
  assert.doesNotMatch(uncertain.question, /replace/i, 'must not offer a false add-vs-replace choice that still leaves the numbers unknown');
});

// --- A number reference for "paid" must resolve against the PAYMENT
// section's own printed numbering, never Attendance's - even though
// Attendance is shown first in the CURRENT LIST and its numbering is what
// catches the eye first. Real bug report: "no 9 to 11 paid", sent against
// a list where Attendance's #9 ("zeb") and the payment-due section's #9
// ("oscar+1") are different people, tried to manually resolve the range to
// NAMES itself and picked Attendance's numbering - "zeb, Lincoln, ravi"
// instead of "oscar+1, oscar+2, oscar+3" - silently marking the wrong two
// people paid (Lincoln/ravi happened to ALSO appear, by name, in the
// payment section) and rejecting "zeb" as not on the payment list at all.
// Fixed via the added NUMBERED LIST REFERENCES rule in SHARED_ARG_RULES:
// the model should pass bare numbers straight through as argText (a range
// expanded into its individual numbers) rather than resolving them to
// names itself - commands/list.js's resolvePaidToken/resolveDuePaymentNumber
// then do that lookup deterministically, correctly scoped to the
// payment-due section only, immune to this cross-section mix-up.

evalTest('"no 9 to 11 paid" resolves against the PAYMENT section\'s own numbering, not Attendance\'s (even though Attendance shows a different #9)', async () => {
  const listText =
    '*Attendance* (12/30)\n\n1. oscar\n2. tessa\n3. xavier\n4. Zoe\n5. kyra\n6. theo d\n7. marco lee\n8. oscar Li\n9. zeb\n10. Lincoln\n11. ravi\n12. Bob\n\n' +
    '──────────\n*Payment*\n\n*26th Aug Wed*\n1. tessa\n2. xavier\n3. Zoe\n4. Theo D\n5. marco lee\n6. Lincoln\n7. ravi\n8. Bob\n9. oscar+1\n10. oscar+2\n11. oscar+3\n12. hugo';
  const result = await interpretMessage('no 9 to 11 paid', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const action = result.actions.find((a) => a.command === 'paid' && a.confidence === 'high');
  assert.ok(action, `expected a high-confidence "paid" action, got: ${JSON.stringify(result.actions)}`);
  // Either the bare numbers (the fixed, preferred form) or the correct
  // literal PAYMENT-section names (9-11 = oscar+1/2/3) pass - what must
  // NEVER appear is "zeb" (Attendance's own #9), which would mean the
  // model resolved the range against the wrong section again.
  const argText = action.argText;
  const isBareNumbers = /^\s*9\s*,\s*10\s*,\s*11\s*$/.test(argText);
  const isCorrectNames = /oscar\+1/i.test(argText) && /oscar\+2/i.test(argText) && /oscar\+3/i.test(argText);
  assert.ok(
    isBareNumbers || isCorrectNames,
    `expected argText to be either "9, 10, 11" or the correct payment-section names (oscar+1/2/3), got: "${argText}"`
  );
  assert.doesNotMatch(argText, /\bzeb\b/i, 'must not resolve the range against Attendance\'s numbering (zeb is Attendance\'s #9, not the payment section\'s)');
});

// --- FLEXIBLE NAME MATCHING (SHARED_ARG_RULES): a nickname/short form
// should resolve to the one real entry it can only plausibly mean, using
// that entry's EXACT spelling (never the sender's own shorthand) - but
// fall back to a specific clarifying question, not a guess, the moment
// there's more than one plausible candidate on the list. ---

evalTest('an unambiguous nickname ("Nick") resolves to the one real entry it can only mean ("Nicholas"), spelled exactly as on the list', async () => {
  const listText = '*Attendance* (3/18)\n\n1. Nicholas\n2. Bob\n3. Milo T';
  const result = await interpretMessage('remove Nick', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const action = result.actions.find((a) => a.command === 'out' && a.confidence === 'high');
  assert.ok(action, `expected a high-confidence "out" action, got: ${JSON.stringify(result.actions)}`);
  assert.match(action.argText, /^Nicholas$/, `expected argText to be exactly "Nicholas", got: "${action.argText}"`);
});

evalTest('a nickname matching TWO different entries ("Nick" against both "Nicholas" and "Nicholas L") asks which one, rather than guessing', async () => {
  const listText = '*Attendance* (3/18)\n\n1. Nicholas\n2. Nicholas L\n3. Bob';
  const result = await interpretMessage('remove Nick', { listText });
  assert.ok(result, 'expected a parsed result, not null');
  const uncertain = result.actions.find((a) => a.confidence === 'low' && a.command !== 'none');
  assert.ok(uncertain, `expected a low-confidence, non-"none" action, got: ${JSON.stringify(result.actions)}`);
  assert.ok(uncertain.question && uncertain.question.trim(), 'expected a non-empty "question"');
  assert.match(uncertain.question, /nicholas/i, 'expected the question to name "Nicholas" as one of the real candidates');
  assert.match(uncertain.question, /nicholas l/i, 'expected the question to name "Nicholas L" as the other real candidate');
});
