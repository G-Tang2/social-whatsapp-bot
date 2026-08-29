// test/helpers.test.js
// Coverage for lib/helpers.js's pure formatting/parsing functions and
// lib/adminCheck.js's caching behavior (fresh fetch, cached hit within TTL,
// invalidate forces a re-fetch).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-helpers-test-'));
process.env.DATA_DIR = tmpDir;

const {
  parseNames,
  maxNamesReply,
  stripLeadingPaidKeyword,
  stripLeadingInKeywords,
  stripLeadingCourtsAddKeyword,
  stripTrailingWithNames,
  REGULAR_PLAYERS_TOKEN,
  expandRegularPlayersToken,
  parseNewListDetails,
  getMessageText,
  getQuotedMessageText,
  stripMentionTokens,
  formatEventHeader,
  formatCount,
  formatElapsed,
  formatPromotedMessage,
  formatList,
  resolveDuePaymentNumber,
  resolveAttendanceOrWaitlistNumber,
} = require('../lib/helpers');
const store = require('../store');
const adminCheck = require('../lib/adminCheck');
const botIdentity = require('../lib/botIdentity');
const { createFakeSock } = require('./helpers/mockBaileys');

let regularPlayersGroupCounter = 0;
function freshRegularPlayersGroupId() {
  regularPlayersGroupCounter += 1;
  return `helpers-test-regulars-${regularPlayersGroupCounter}@g.us`;
}

test('parseNames splits comma-separated names and trims whitespace', () => {
  assert.deepEqual(parseNames('Grace, Henry, Henry+1', 'fallback'), ['Grace', 'Henry', 'Henry+1']);
  assert.deepEqual(parseNames('', 'fallback'), ['fallback']);
  assert.deepEqual(parseNames(null, 'fallback'), ['fallback']);
  assert.deepEqual(parseNames('  Grace  ,, Henry ', 'fallback'), ['Grace', 'Henry']); // drops empty segments
});

test('parseNames expands a bare "+N" token into N guest entries WITHOUT the sender', () => {
  assert.deepEqual(parseNames('+2', 'Preston'), ['Preston+1', 'Preston+2']);
  assert.deepEqual(parseNames('+1', 'Preston'), ['Preston+1']);
  assert.deepEqual(parseNames('+0', 'Preston'), []); // 0 guests, no sender - nothing at all
  assert.deepEqual(parseNames('+ 3', 'Preston'), ['Preston+1', 'Preston+2', 'Preston+3']); // tolerates a space after "+"
});

test('parseNames resolves a bare "me" token to fallbackName', () => {
  assert.deepEqual(parseNames('me', 'Preston'), ['Preston']);
  assert.deepEqual(parseNames('Me', 'Preston'), ['Preston']); // case-insensitive
  assert.deepEqual(parseNames(' me ', 'Preston'), ['Preston']); // tolerates whitespace
});

test('parseNames combines "me" with "+N" to include the sender alongside N guest entries', () => {
  assert.deepEqual(parseNames('me, +2', 'Preston'), ['Preston', 'Preston+1', 'Preston+2']);
  assert.deepEqual(parseNames('+2, me', 'Preston'), ['Preston+1', 'Preston+2', 'Preston']); // order preserved, token-by-token
});

test('parseNames only expands a token that is ENTIRELY "+N"/"me" - an explicit "Henry+1"/"Amelia" name is left untouched', () => {
  assert.deepEqual(parseNames('Henry+1', 'fallback'), ['Henry+1']);
  assert.deepEqual(parseNames('Amelia', 'fallback'), ['Amelia']); // contains "me" as a substring, not the whole token
  assert.deepEqual(parseNames('Alice, +2', 'Preston'), ['Alice', 'Preston+1', 'Preston+2']); // "+2" still excludes the sender when mixed with a named other
});

test('stripLeadingPaidKeyword detects a bare leading "paid" and strips it', () => {
  assert.deepEqual(stripLeadingPaidKeyword('paid'), { rest: '', paid: true });
  assert.deepEqual(stripLeadingPaidKeyword('Paid'), { rest: '', paid: true }); // case-insensitive
  assert.deepEqual(stripLeadingPaidKeyword('  paid  '), { rest: '', paid: true });
});

test('stripLeadingPaidKeyword strips a leading "paid" off a name list, comma or space separated', () => {
  assert.deepEqual(stripLeadingPaidKeyword('paid Grace'), { rest: 'Grace', paid: true });
  assert.deepEqual(stripLeadingPaidKeyword('paid Grace, Henry'), { rest: 'Grace, Henry', paid: true });
  assert.deepEqual(stripLeadingPaidKeyword('PAID, Grace, Henry'), { rest: 'Grace, Henry', paid: true });
});

test('stripLeadingPaidKeyword leaves text alone when there is no leading "paid" keyword', () => {
  assert.deepEqual(stripLeadingPaidKeyword('Grace'), { rest: 'Grace', paid: false });
  assert.deepEqual(stripLeadingPaidKeyword('Grace, Henry'), { rest: 'Grace, Henry', paid: false });
  assert.deepEqual(stripLeadingPaidKeyword(''), { rest: '', paid: false });
  assert.deepEqual(stripLeadingPaidKeyword(null), { rest: '', paid: false });
});

test('stripLeadingPaidKeyword does not strip "paid" as part of a longer word', () => {
  // A real name that happens to start with "paid" as a substring (not a
  // standalone word) must be left alone - only a whole leading word
  // "paid" counts, same as the module comment explains.
  assert.deepEqual(stripLeadingPaidKeyword('Paidence'), { rest: 'Paidence', paid: false });
  assert.deepEqual(stripLeadingPaidKeyword('Paidence, Grace'), { rest: 'Paidence, Grace', paid: false });
});

test('stripLeadingInKeywords strips a bare leading "paid", "tournament", or both, in either order', () => {
  assert.deepEqual(stripLeadingInKeywords('Grace'), { rest: 'Grace', paid: false, tournament: false });
  assert.deepEqual(stripLeadingInKeywords('paid Grace'), { rest: 'Grace', paid: true, tournament: false });
  assert.deepEqual(stripLeadingInKeywords('tournament Grace'), { rest: 'Grace', paid: false, tournament: true });
  assert.deepEqual(stripLeadingInKeywords('tournament paid Grace'), { rest: 'Grace', paid: true, tournament: true });
  assert.deepEqual(stripLeadingInKeywords('paid tournament Grace'), { rest: 'Grace', paid: true, tournament: true });
  assert.deepEqual(stripLeadingInKeywords('tournament'), { rest: '', paid: false, tournament: true });
  assert.deepEqual(stripLeadingInKeywords(''), { rest: '', paid: false, tournament: false });
  assert.deepEqual(stripLeadingInKeywords(null), { rest: '', paid: false, tournament: false });
});

test('stripLeadingInKeywords does not strip "tournament" as part of a longer word', () => {
  assert.deepEqual(stripLeadingInKeywords('Tournamentina'), { rest: 'Tournamentina', paid: false, tournament: false });
});

test('stripLeadingCourtsAddKeyword recognizes a leading "add" or "extra" as the same additive flag', () => {
  assert.deepEqual(stripLeadingCourtsAddKeyword('add 1'), { rest: '1', additive: true });
  assert.deepEqual(stripLeadingCourtsAddKeyword('extra 12-14'), { rest: '12-14', additive: true });
  assert.deepEqual(stripLeadingCourtsAddKeyword('ADD, 1, 2'), { rest: '1, 2', additive: true }); // case-insensitive, comma separator
  assert.deepEqual(stripLeadingCourtsAddKeyword('add'), { rest: '', additive: true }); // keyword alone
});

test('stripLeadingCourtsAddKeyword leaves text alone (additive: false) with no leading "add"/"extra"', () => {
  assert.deepEqual(stripLeadingCourtsAddKeyword('13-18'), { rest: '13-18', additive: false });
  assert.deepEqual(stripLeadingCourtsAddKeyword(''), { rest: '', additive: false });
  assert.deepEqual(stripLeadingCourtsAddKeyword(null), { rest: '', additive: false });
});

test('stripLeadingCourtsAddKeyword does not strip "add"/"extra" as part of a longer word', () => {
  assert.deepEqual(stripLeadingCourtsAddKeyword('Addison'), { rest: 'Addison', additive: false });
  assert.deepEqual(stripLeadingCourtsAddKeyword('Extradition'), { rest: 'Extradition', additive: false });
});

test('stripTrailingWithNames splits off a trailing "with <names>" clause', () => {
  assert.deepEqual(
    stripTrailingWithNames('EBC | 13-18 | 8PM start with Alice, Bob, Carla'),
    { rest: 'EBC | 13-18 | 8PM start', namesText: 'Alice, Bob, Carla' }
  );
  assert.deepEqual(stripTrailingWithNames('with Alice, Bob, Carla'), { rest: '', namesText: 'Alice, Bob, Carla' });
  assert.deepEqual(stripTrailingWithNames('WITH Alice'), { rest: '', namesText: 'Alice' }); // case-insensitive
});

test('stripTrailingWithNames leaves text alone when there is no "with" clause', () => {
  assert.deepEqual(stripTrailingWithNames('EBC | 13-18 | 8PM start'), { rest: 'EBC | 13-18 | 8PM start', namesText: null });
  assert.deepEqual(stripTrailingWithNames(''), { rest: '', namesText: null });
  assert.deepEqual(stripTrailingWithNames(null), { rest: '', namesText: null });
});

test('stripTrailingWithNames does not match "with" as part of a longer word', () => {
  // A location that happens to contain "with" as a substring (not a
  // standalone word) must be left alone - same \b-boundary reasoning as
  // stripLeadingPaidKeyword's "Paidence" case.
  assert.deepEqual(stripTrailingWithNames('Southwith Park'), { rest: 'Southwith Park', namesText: null });
});

test('stripMentionTokens removes an "@<number>" mention token and collapses the double-space it leaves behind', () => {
  assert.equal(stripMentionTokens('@61412345678 put me down for Saturday', ['61412345678@s.whatsapp.net']), 'put me down for Saturday');
  assert.equal(stripMentionTokens('put me down @61412345678 please', ['61412345678@s.whatsapp.net']), 'put me down please');
});

test('stripMentionTokens preserves internal line breaks - regression for a real bug where a pasted multi-line list got collapsed into one line, silently breaking !update', () => {
  // The exact shape that broke: a mention-prefixed message wrapping a
  // pasted, multi-line list. A previous version of this function
  // collapsed ALL whitespace (including newlines) into single spaces,
  // which destroyed the line structure lib/listParser.js's
  // parseListSections() depends on to recognize *Attendance*/numbered
  // entries - see index.js's handleAiMention, which uses this function's
  // output as the real argText for an "update" AI action.
  const pasted = '@61412345678 update the list to be\n\n*Attendance* (2/10)\n\n1. Derek\n2. Frank';
  const result = stripMentionTokens(pasted, ['61412345678@s.whatsapp.net']);
  assert.equal(result, 'update the list to be\n\n*Attendance* (2/10)\n\n1. Derek\n2. Frank');
  // Confirms the line-based structure a real parse would need is intact,
  // not just that newlines survived textually.
  const lines = result.split('\n');
  assert.equal(lines[2], '*Attendance* (2/10)');
  assert.equal(lines[4], '1. Derek');
  assert.equal(lines[5], '2. Frank');
});

test('stripMentionTokens collapses horizontal whitespace hugging a line break, without merging the lines themselves', () => {
  const text = 'line one   \n   line two';
  assert.equal(stripMentionTokens(text, []), 'line one\nline two');
});

test('stripMentionTokens trims leading/trailing whitespace but leaves internal blank lines alone', () => {
  assert.equal(stripMentionTokens('  \n hello \n\n world \n ', []), 'hello\n\nworld');
});

test('stripMentionTokens handles no mentions / empty text without throwing', () => {
  assert.equal(stripMentionTokens('plain text', []), 'plain text');
  assert.equal(stripMentionTokens('', []), '');
  assert.equal(stripMentionTokens(null, []), '');
  assert.equal(stripMentionTokens('hi', undefined), 'hi');
});

test('stripMentionTokens also strips a literal "@Snoopy" TYPED as plain text, not just a real JID-based mention token', () => {
  // No mentionedJids at all here - a real mention's raw text is always
  // "@<number>", never "@Snoopy" itself (see LITERAL_BOT_MENTION_REGEX's
  // own doc comment in lib/helpers.js), so this exercises the literal-text
  // fallback path in isolation.
  assert.equal(stripMentionTokens('@Snoopy put me down for Saturday', []), 'put me down for Saturday');
  assert.equal(stripMentionTokens('put me down @Snoopy please', []), 'put me down please');
  assert.equal(stripMentionTokens('@SNOOPY put me down', []), 'put me down');
});

test('stripMentionTokens does not strip "Snoopy" mid-word or without the leading "@" - only a literal "@Snoopy" mention-shaped token', () => {
  assert.equal(stripMentionTokens('is Snoopy around?', []), 'is Snoopy around?');
  assert.equal(stripMentionTokens('@Snoopydog put me down', []), '@Snoopydog put me down');
});

test('REGULAR_PLAYERS_TOKEN matches "regular players" and reasonable variants, case-insensitively', () => {
  for (const token of ['regular players', 'Regular Players', 'REGULARS', 'regulars', 'the regular players', 'regular player']) {
    assert.ok(REGULAR_PLAYERS_TOKEN.test(token), `expected "${token}" to match`);
  }
});

test('REGULAR_PLAYERS_TOKEN does not match a real name that merely contains the word, or an unrelated word', () => {
  for (const token of ['Regulator Players', 'regularly', 'usuals', 'Alice']) {
    assert.ok(!REGULAR_PLAYERS_TOKEN.test(token), `expected "${token}" NOT to match`);
  }
});

test('expandRegularPlayersToken: returns names completely unchanged (same reference) when the token is absent', () => {
  const groupId = freshRegularPlayersGroupId();
  const names = ['Alice', 'Bob'];
  const result = expandRegularPlayersToken(names, groupId);
  assert.equal(result.names, names); // same array reference, not just deepEqual
  assert.equal(result.usedEmptyRegularPlayers, false);
});

test('expandRegularPlayersToken: splices the saved roster in at the token\'s position, preserving other names', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setRegularPlayers(groupId, ['Alice', 'Bob', 'Carla']);

  const result = expandRegularPlayersToken(['Extra Guest', 'regular players'], groupId);
  assert.deepEqual(result.names, ['Extra Guest', 'Alice', 'Bob', 'Carla']);
  assert.equal(result.usedEmptyRegularPlayers, false);
});

test('expandRegularPlayersToken: an empty saved roster drops the token instead of leaving it as a literal name', () => {
  const groupId = freshRegularPlayersGroupId();
  const result = expandRegularPlayersToken(['regular players'], groupId);
  assert.deepEqual(result.names, []);
  assert.equal(result.usedEmptyRegularPlayers, true);
});

test('maxNamesReply mentions the configured cap', () => {
  const msg = maxNamesReply('add');
  assert.match(msg, /add up to \d+ names/);
  assert.match(msg, /no limit for group admins/);
});

test('parseNewListDetails: no text carries everything forward', () => {
  assert.deepEqual(parseNewListDetails(''), { details: {} });
  assert.deepEqual(parseNewListDetails(null), { details: {} });
});

test('parseNewListDetails: no "|" is treated as location only', () => {
  const { details } = parseNewListDetails('EBC');
  assert.deepEqual(details, { location: 'EBC' });
});

test('parseNewListDetails: full three-segment form parses location/courts/time', () => {
  const { details } = parseNewListDetails('EBC | 13-18 | 8PM start');
  assert.equal(details.location, 'EBC');
  assert.deepEqual(details.courts, { raw: '13-18', count: 6 });
  assert.equal(details.time, '8PM start');
});

test('parseNewListDetails: empty segments explicitly clear that field', () => {
  const { details } = parseNewListDetails(' | | ');
  assert.equal(details.location, null);
  assert.equal(details.courts, null);
  assert.equal(details.time, null);
});

test('parseNewListDetails: invalid courts segment returns an error', () => {
  const { error, details } = parseNewListDetails('EBC | not courts | 8PM');
  assert.equal(details, undefined);
  assert.match(error, /isn't a valid court list/);
});

test('getMessageText extracts from conversation, extendedTextMessage, or captions', () => {
  assert.equal(getMessageText({ message: { conversation: 'hi' } }), 'hi');
  assert.equal(getMessageText({ message: { extendedTextMessage: { text: 'hi2' } } }), 'hi2');
  assert.equal(getMessageText({ message: { imageMessage: { caption: 'pic caption' } } }), 'pic caption');
  assert.equal(getMessageText({ message: null }), '');
  assert.equal(getMessageText({}), '');
});

test('getQuotedMessageText extracts the quoted message\'s own text, same field priority as getMessageText', () => {
  const withQuotedConversation = {
    message: { extendedTextMessage: { text: 'my reply', contextInfo: { quotedMessage: { conversation: 'the bot\'s question' } } } },
  };
  assert.equal(getQuotedMessageText(withQuotedConversation), 'the bot\'s question');

  const withQuotedExtendedText = {
    message: { extendedTextMessage: { text: 'my reply', contextInfo: { quotedMessage: { extendedTextMessage: { text: 'nested extended text' } } } } },
  };
  assert.equal(getQuotedMessageText(withQuotedExtendedText), 'nested extended text');
});

test('getQuotedMessageText returns \'\' for a plain (non-reply) message, or a reply whose quoted message has no text', () => {
  assert.equal(getQuotedMessageText({ message: { conversation: 'not a reply at all' } }), '');
  assert.equal(getQuotedMessageText({ message: { extendedTextMessage: { text: 'reply', contextInfo: {} } } }), '');
  assert.equal(getQuotedMessageText({ message: null }), '');
  assert.equal(getQuotedMessageText({}), '');
});

test('formatEventHeader includes only the fields that are set', () => {
  assert.equal(formatEventHeader({ date: null }), 'No date set');
  const full = formatEventHeader({ date: '2026-08-20', location: 'EBC', courts: '13-18', courtCount: 6, time: '8PM start' });
  assert.equal(full, '20th Aug Thu\nEBC\nCourts 13-18 (6)\n8PM start');
});

test('formatCount shows just the count, or count/limit when a limit is set', () => {
  assert.equal(formatCount(5, null), '(5)');
  assert.equal(formatCount(5, 20), '(5/20)');
});

test('formatList: while tournament is enabled, splits Attendance into a "🏆 Tournament" block (numbered first, with an "Ask @Snoopy for details" pointer) and a "Social only" block (numbering continues)', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 2);
  store.addEntry(groupId, 'Derek', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Frank', 'bao@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Sienna', 'wendy@s.whatsapp.net', false, true, false);

  const text = formatList(groupId);
  assert.match(text, /🏆 \*Tournament\* \(2\/2\)\nAsk @Snoopy for details\n\n1\. Derek\n2\. Frank/);
  assert.match(text, /Social only\n\n3\. Sienna/);
});

test('formatList: someone who wanted the tournament but it was full is tagged (🏆 WL) in the Social only block', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Derek', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Frank', 'bao@s.whatsapp.net', false, true, true); // wanted in, but full

  const text = formatList(groupId);
  assert.match(text, /Social only\n\n2\. Frank \(🏆 WL\)/);

  // Someone who never asked for the tournament at all gets no tag.
  store.addEntry(groupId, 'Sienna', 'wendy@s.whatsapp.net', false, true, false);
  const text2 = formatList(groupId);
  assert.match(text2, /3\. Sienna$/);
  assert.doesNotMatch(text2, /Sienna \(🏆 WL\)/);
});

test('formatList: (🏆 WL)-tagged entries are sorted to the FRONT of Social only, ahead of earlier joiners who never asked - that ordering IS the tournament queue', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Derek', 'keith@s.whatsapp.net', false, true, true); // takes the only spot
  store.addEntry(groupId, 'Sienna', 'wendy@s.whatsapp.net', false, true, false); // plain social, joined first
  store.addEntry(groupId, 'Frank', 'bao@s.whatsapp.net', false, true, true); // asked later, but full - WL'd

  const text = formatList(groupId);
  // Frank (WL'd) is listed BEFORE Sienna (never asked) despite joining after her.
  assert.match(text, /Social only\n\n2\. Frank \(🏆 WL\)\n3\. Sienna/);
});

test('formatList: while tournament is enabled, both headers show even with ZERO entries at all - each gets a "(none yet)" placeholder instead of falling back to the generic empty-Attendance message', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, true);

  const text = formatList(groupId);
  assert.match(text, /\*Attendance\* \(0\/\d+\)/);
  assert.match(text, /🏆 \*Tournament\* \(0\)\nAsk @Snoopy for details\n\n\(none yet\)/);
  assert.match(text, /Social only\n\n\(none yet\)/);
  assert.doesNotMatch(text, /@Snoopy to add your name/);
});

test('formatList: while tournament is enabled, the Social only header still shows (with a placeholder) even when everyone who\'s joined so far is in the tournament', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Derek', 'keith@s.whatsapp.net', false, true, true); // tournament only, nobody social-only yet

  const text = formatList(groupId);
  assert.match(text, /🏆 \*Tournament\* \(1\)\nAsk @Snoopy for details\n\n1\. Derek/);
  assert.match(text, /Social only\n\n\(none yet\)/);
});

test('formatList: with tournament OFF, a totally empty list still renders the plain "empty" message, unaffected by the tournament-headers change', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, false); // tournament is ON by default now

  const text = formatList(groupId);
  assert.doesNotMatch(text, /🏆 \*Tournament\*/);
  assert.doesNotMatch(text, /Social only/);
  assert.match(text, /\*Attendance\*\n\n\(empty, limit \d+ - @Snoopy to add your name\)/);
});

test('formatList: the winners banner only shows while tournament is enabled, and disappears (without forgetting the winners) once turned off', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentWinners(groupId, ['Noah', 'Ellen']);

  assert.match(formatList(groupId), /🎉 \*Congrats to Noah and Ellen for winning last week's tournament\*/);

  store.setTournamentEnabled(groupId, false);
  assert.doesNotMatch(formatList(groupId), /Congrats to/);
  assert.deepEqual(store.getTournamentWinners(groupId), ['Noah', 'Ellen']); // still remembered
});

test('formatList: with tournament off, Attendance renders as one flat numbered list, same as before this feature existed', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, false); // tournament is ON by default now
  store.addEntry(groupId, 'Derek', 'keith@s.whatsapp.net', false, true);
  store.addEntry(groupId, 'Frank', 'bao@s.whatsapp.net', false, true);

  const text = formatList(groupId);
  assert.doesNotMatch(text, /🏆 \*Tournament\*/);
  assert.doesNotMatch(text, /Social only/);
  assert.match(text, /\*Attendance\* \(2\/\d+\)\n\n1\. Derek\n2\. Frank/);
});

// --- formatList: payment-due entries grouped by owed-since date ----------
// See store.js's newList() (which sets entry.owedSince) and this function's
// own doc comment above the payment-section rendering.

test('formatList: a payment-due entry with owedSince is grouped under a bold date header, renumbered from 1', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Grace now owes, tagged with the OLD (8/13) date

  const text = formatList(groupId);
  assert.match(text, /\*Payment\*\n\n\*13th Aug Thu\*\n1\. Grace$/m);
});

test('formatList: a payment-due entry with no owedSince (predates the feature, or added manually via !update) goes under a "No date" group instead of a real date', () => {
  const groupId = freshRegularPlayersGroupId();
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // no date was ever set - no owedSince to show

  const text = formatList(groupId);
  assert.match(text, /\*Payment\*\n\n\*No date\*\n1\. Grace$/m);
});

test('formatList: the payment section header is always the fixed bold "*Payment*" word, with no separate label line underneath when !paymentlabel was never customized', () => {
  const groupId = freshRegularPlayersGroupId();
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});

  const text = formatList(groupId);
  // Straight from the divider into "*Payment*" and then directly the first
  // group header - no extra label line, no blank line before the group.
  assert.match(text, /──────────\n\*Payment\*\n\n\*No date\*\n1\. Grace/);
});

test('formatList: a customized !paymentlabel prints as a plain (unbolded) line directly under the bold "*Payment*" header, no blank line between them', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setDuePaymentsLabel(groupId, '$16 payID: 0413455423');
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});

  const text = formatList(groupId);
  assert.match(text, /──────────\n\*Payment\*\n\$16 payID: 0413455423\n\n\*No date\*\n1\. Grace/);
});

test('formatList: dated payment groups are sorted MOST RECENT first, and a "No date" group (if any) always comes before every dated group regardless', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Grace -> owes since 8/13

  store.addEntry(groupId, 'Preston', 'jordan@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Preston -> owes since 8/20; Grace still 8/13

  // Uma is typed straight into the payment section via !update rather than
  // carried over from a completed list, so it has no owedSince at all.
  store.applyListUpdate(groupId, { attendance: [], waitlist: [], duePayments: ['Grace', 'Preston', 'Uma'] }, 'a@s.whatsapp.net', true);

  const text = formatList(groupId);
  const paymentSection = text.split('*Payment*\n\n')[1];
  // "No date" (Uma, brand new via !update) first no matter what, then the
  // NEWER date (Preston, 8/20) before the older one (Grace, 8/13) - never
  // oldest-first and never interleaved.
  assert.match(paymentSection, /^\*No date\*\n1\. Uma\n\n\*20th Aug Thu\*\n1\. Preston\n\n\*13th Aug Thu\*\n1\. Grace/);
});

// --- resolveDuePaymentNumber: "!paid 7" resolves against the printed list -
// real bug report: "!paid 7,8" on a payment list numbered 1-14 should mark
// whoever is printed as "7." and "8." paid, the same numbers a reader
// actually sees (see resolvePaidToken in commands/list.js).

test('resolveDuePaymentNumber matches an entry by its printed position within a single payment group', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setDate(groupId, '2026-08-13');
  ['Oscar', 'Patrick', 'Miles'].forEach((name) => store.addEntry(groupId, name, `${name}@s.whatsapp.net`, false));
  store.newList(groupId, '2026-08-20', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(resolveDuePaymentNumber(due, 1).name, 'Oscar');
  assert.equal(resolveDuePaymentNumber(due, 3).name, 'Miles');
});

test('resolveDuePaymentNumber returns null for a number outside the printed range', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Oscar', 'h@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(resolveDuePaymentNumber(due, 99), null);
  assert.equal(resolveDuePaymentNumber(due, 0), null);
});

test('resolveDuePaymentNumber returns null when the SAME number appears in more than one payment-date group - the printed list itself has two different lines both starting "N.", so guessing would be wrong', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Grace -> owes since 8/13, printed as "1. Grace"

  store.addEntry(groupId, 'Preston', 'jordan@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Preston -> owes since 8/20, ALSO printed as "1. Preston"

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(resolveDuePaymentNumber(due, 1), null);
});

// --- resolveAttendanceOrWaitlistNumber: "!out 7" resolves against the
// printed list - real request: "!out 7,8" should remove whoever the
// posted Attendance list currently prints as "7." and "8.".

test('resolveAttendanceOrWaitlistNumber matches a plain (non-tournament) Attendance entry by its printed position', () => {
  const groupId = freshRegularPlayersGroupId();
  ['Oscar', 'Patrick', 'Miles'].forEach((name) => store.addEntry(groupId, name, `${name}@s.whatsapp.net`, false));

  const event = store.getCurrentEvent(groupId);
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 1).name, 'Oscar');
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 3).name, 'Miles');
});

test('resolveAttendanceOrWaitlistNumber matches against the SAME reordered numbering formatList() prints once tournament is on (tournament opt-ins first, Social only continuing the count)', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 2);
  store.addEntry(groupId, 'Sienna', 'wendy@s.whatsapp.net', false, true, false); // social-only, joined FIRST
  store.addEntry(groupId, 'Derek', 'keith@s.whatsapp.net', false, true, true); // tournament, joined second
  store.addEntry(groupId, 'Frank', 'bao@s.whatsapp.net', false, true, true); // tournament, joined third

  // Displayed as "1. Derek, 2. Frank" (tournament block) then "3. Sienna"
  // (Social only) - NOT join order, which would put Sienna first.
  const event = store.getCurrentEvent(groupId);
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 1).name, 'Derek');
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 2).name, 'Frank');
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 3).name, 'Sienna');
});

test('resolveAttendanceOrWaitlistNumber matches a Waitlist entry by its OWN printed position (numbered independently from Attendance)', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false); // Attendance "1."
  store.addEntry(groupId, 'Henry', 'sam@s.whatsapp.net', false); // over the limit - Waitlist "1."
  store.addEntry(groupId, 'Brooke', 'jamie@s.whatsapp.net', false); // also waitlisted - Waitlist "2.", no Attendance "2." to collide with

  const event = store.getCurrentEvent(groupId);
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 2).name, 'Brooke');
});

test('resolveAttendanceOrWaitlistNumber returns null when the SAME number is printed in BOTH Attendance and Waitlist - independently numbered sections, so guessing which one was meant would be wrong', () => {
  const groupId = freshRegularPlayersGroupId();
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false); // Attendance "1."
  store.addEntry(groupId, 'Henry', 'sam@s.whatsapp.net', false); // over the limit - Waitlist "1."

  const event = store.getCurrentEvent(groupId);
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 1), null);
});

test('resolveAttendanceOrWaitlistNumber returns null for a number outside both lists\' ranges', () => {
  const groupId = freshRegularPlayersGroupId();
  store.addEntry(groupId, 'Grace', 'alex@s.whatsapp.net', false);

  const event = store.getCurrentEvent(groupId);
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 99), null);
  assert.equal(resolveAttendanceOrWaitlistNumber(event, 0), null);
});

test('formatElapsed renders compact day/hour/minute durations', () => {
  assert.equal(formatElapsed(0), '0m');
  assert.equal(formatElapsed(5 * 60000), '5m');
  assert.equal(formatElapsed(90 * 60000), '1h 30m');
  assert.equal(formatElapsed((25 * 60 + 30) * 60000), '1d 1h');
});

test('formatPromotedMessage builds a tagged notice and returns null for an empty list', () => {
  assert.equal(formatPromotedMessage([]), null);
  assert.equal(formatPromotedMessage(null), null);
  const result = formatPromotedMessage([{ name: 'Henry', addedBy: 'sam@s.whatsapp.net' }]);
  assert.match(result.text, /Off the waitlist/);
  assert.match(result.text, /@sam — Henry/);
  assert.deepEqual(result.mentions, ['sam@s.whatsapp.net']);
});

test('adminCheck: isGroupAdmin reflects groupMetadata and caches the result', async () => {
  const groupId = 'admincheck-test-1@g.us';
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'], participantIds: ['member@s.whatsapp.net'] });
  let fetchCount = 0;
  const originalGroupMetadata = sock.groupMetadata;
  sock.groupMetadata = async (...args) => {
    fetchCount += 1;
    return originalGroupMetadata(...args);
  };

  assert.equal(await adminCheck.isGroupAdmin(sock, groupId, 'admin@s.whatsapp.net'), true);
  assert.equal(await adminCheck.isGroupAdmin(sock, groupId, 'member@s.whatsapp.net'), false);
  // Both checks above should have hit the cache after the first fetch.
  assert.equal(fetchCount, 1);

  adminCheck.invalidate(groupId);
  assert.equal(await adminCheck.isGroupAdmin(sock, groupId, 'admin@s.whatsapp.net'), true);
  assert.equal(fetchCount, 2); // invalidate forced a re-fetch
});

test('adminCheck: isGroupAdmin fails closed (returns false) if groupMetadata throws', async () => {
  const groupId = 'admincheck-test-2@g.us';
  const sock = { groupMetadata: async () => { throw new Error('network down'); } };
  assert.equal(await adminCheck.isGroupAdmin(sock, groupId, 'anyone@s.whatsapp.net'), false);
});

test('botIdentity: resolveBotLid finds the bot\'s own lid from groupMetadata and caches it', async () => {
  const groupId = 'botidentity-test-1@g.us';
  let fetchCount = 0;
  const sock = {
    user: { id: 'bot:7@s.whatsapp.net' },
    groupMetadata: async () => {
      fetchCount += 1;
      return {
        participants: [
          { id: 'bot:7@s.whatsapp.net', lid: '999888777@lid' },
          { id: 'alex@s.whatsapp.net' },
        ],
      };
    },
  };

  assert.equal(await botIdentity.resolveBotLid(sock, groupId), '999888777@lid');
  assert.equal(await botIdentity.resolveBotLid(sock, groupId), '999888777@lid');
  assert.equal(fetchCount, 1, 'the second call should have hit the cache, not fetched again');

  botIdentity.invalidate(groupId);
  assert.equal(await botIdentity.resolveBotLid(sock, groupId), '999888777@lid');
  assert.equal(fetchCount, 2, 'invalidate should have forced a re-fetch');
});

test('botIdentity: resolveBotLid returns null when the bot has no lid entry, or groupMetadata throws', async () => {
  const noLidSock = {
    user: { id: 'bot:7@s.whatsapp.net' },
    groupMetadata: async () => ({ participants: [{ id: 'bot:7@s.whatsapp.net' }] }),
  };
  assert.equal(await botIdentity.resolveBotLid(noLidSock, 'botidentity-test-2@g.us'), null);

  const throwingSock = { user: { id: 'bot:7@s.whatsapp.net' }, groupMetadata: async () => { throw new Error('network down'); } };
  assert.equal(await botIdentity.resolveBotLid(throwingSock, 'botidentity-test-3@g.us'), null);
});

test('botIdentity: resolveBotLid matches the bot\'s own participant id even across a device-id suffix mismatch (normalizeJid stripping)', async () => {
  const sock = {
    user: { id: 'bot:7@s.whatsapp.net' }, // has a device suffix
    groupMetadata: async () => ({
      participants: [{ id: 'bot@s.whatsapp.net', lid: '111222333@lid' }], // no device suffix here
    }),
  };
  assert.equal(await botIdentity.resolveBotLid(sock, 'botidentity-test-4@g.us'), '111222333@lid');
});