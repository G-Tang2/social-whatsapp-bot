// test/commands.test.js
// Direct handler tests for commands/*.js, using a fake ctx object (no need
// to go through index.js's full handleMessage pipeline for most of these -
// see test/e2e.test.js for the small set of tests that need the full
// pipeline, e.g. catch-up gating and spam-deletion-before-dispatch).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-commands-test-'));
process.env.DATA_DIR = tmpDir;
// Set before any require() below - lib/config.js reads this once at
// module-load time. A fake (never-called-for-real) key, just enough for
// handleAi's "!ai on" success path to get past its configured-key check;
// see test/geminiCommand.test.js for interpretMessage()'s own coverage,
// which always injects a fake client rather than relying on this key.
process.env.GEMINI_API_KEY = 'test-key-not-real';

const store = require('../store');
const spam = require('../spam');
const ai = require('../ai');
const adminCheck = require('../lib/adminCheck');
const { formatList } = require('../lib/helpers');
const listCommands = require('../commands/list');
const adminCommands = require('../commands/admin');
const { handleSpamfilter } = require('../commands/spamfilter');
const { handleAi } = require('../commands/ai');
const { handleHelp, handleTips, handleAdminHelp, handleAdminTips } = require('../commands/help');
const { commands } = require('../commands'); // the real, undo-tracking-wrapped dispatch table - see the "!undo" tests below
const { createFakeSock, makeTextMessage } = require('./helpers/mockBaileys');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `commands-test-${groupCounter}@g.us`;
}

// Builds a fake ctx matching the shape every command handler expects,
// backed by a real (temp-dir-isolated) store/spam and a fake sock.
function makeCtx({ sock, groupId, senderId = 'sender@s.whatsapp.net', senderName = 'Sender', argText = '' }) {
  const msg = makeTextMessage({ from: senderId, groupId, text: `!test ${argText}`.trim() });
  const replies = [];
  const reply = async (body) => {
    replies.push(body);
    return sock.sendMessage(groupId, { text: body }, { quoted: msg });
  };
  const postList = async () => sock.sendMessage(groupId, { text: formatList(groupId) });
  return {
    ctx: { sock, msg, groupId, senderId, senderName, argText, upsertType: 'notify', reply, postList },
    replies,
  };
}

test('handleIn: bare !in adds the sender by their own push name', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const { ctx } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: '' });
  await listCommands.handleIn(ctx);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 1);
  assert.equal(event.entries[0].name, 'Alex');
});

test('handleIn: already-on-the-list bare !in replies instead of duplicating', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const first = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: '' });
  await listCommands.handleIn(first.ctx);
  const second = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: '' });
  await listCommands.handleIn(second.ctx);
  assert.equal(second.replies.length, 1);
  assert.match(second.replies[0], /already on the list/);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);
});

test('handleIn: signing OTHER people up ("!in Peter, Chris, Linda") does not make a later bare !in from the same sender think they\'re already on as those names', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const addOthers = makeCtx({
    sock,
    groupId,
    senderId: 'gary@s.whatsapp.net',
    senderName: 'Gary',
    argText: 'peter, chris, linda',
  });
  await listCommands.handleIn(addOthers.ctx);
  // All three are attributed to Gary (so he can remove them later), but
  // none of them ARE Gary.
  const afterOthers = store.getCurrentEvent(groupId).entries;
  assert.deepEqual(afterOthers.map((e) => e.name), ['peter', 'chris', 'linda']);
  assert.ok(afterOthers.every((e) => e.addedBy === 'gary@s.whatsapp.net'));
  assert.ok(afterOthers.every((e) => e.self === false));

  const bareIn = makeCtx({ sock, groupId, senderId: 'gary@s.whatsapp.net', senderName: 'Gary', argText: '' });
  await listCommands.handleIn(bareIn.ctx);
  // Gary should actually get added as "Gary" - not told he's already on
  // as "peter", "chris", "linda".
  assert.equal(bareIn.replies.length, 0);
  const finalNames = store.getCurrentEvent(groupId).entries.map((e) => e.name);
  assert.deepEqual(finalNames, ['peter', 'chris', 'linda', 'Gary']);
});

test('handleIn: too many names rejected for non-admins, allowed for admins', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLimit(groupId, null); // remove the default cap so this test is purely about the name-count check
  const names = Array.from({ length: 10 }, (_, i) => `Name${i}`).join(', ');

  const nonAdmin = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: names });
  await listCommands.handleIn(nonAdmin.ctx);
  assert.match(nonAdmin.replies[0], /You can add up to/);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 0);

  const admin = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: names });
  await listCommands.handleIn(admin.ctx);
  assert.equal(admin.replies.length, 0);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 10);
});

test('handleIn: "!in +2" adds the sender plus 2 unnamed guest entries, with only the sender\'s own entry marked self', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const { ctx } = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '+2' });
  await listCommands.handleIn(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.deepEqual(entries.map((e) => e.name), ['Jordan', 'Jordan+1', 'Jordan+2']);
  assert.ok(entries.every((e) => e.addedBy === 'jordan@s.whatsapp.net'));
  // Only the bare "Jordan" entry is the sender themselves - the two guest
  // entries are separate people the sender vouched for, same as if they'd
  // typed "Sam, Sam+1" for someone else (see store.js's addEntry doc
  // comment for why this distinction matters for later bare-self lookups).
  assert.equal(entries[0].self, true);
  assert.equal(entries[1].self, false);
  assert.equal(entries[2].self, false);

  // A later bare !in should recognize the sender's own entry from this
  // expansion (not think they're already on as "Jordan+1"/"Jordan+2" too).
  const bareIn = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '' });
  await listCommands.handleIn(bareIn.ctx);
  assert.match(bareIn.replies[0], /already on the list as "Jordan"/);
});

test('handleIn: a repeat "!in +3" ADDS to an existing guest chain instead of colliding with it - "+3" then "+3" again ends up at +6, not restarting at +1', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setLimit(groupId, null); // remove the default limit of 6 - this test needs 7 entries total

  const first = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '+3' });
  await listCommands.handleIn(first.ctx);
  assert.deepEqual(
    store.getCurrentEvent(groupId).entries.map((e) => e.name),
    ['Jordan', 'Jordan+1', 'Jordan+2', 'Jordan+3']
  );

  const second = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '+3' });
  await listCommands.handleIn(second.ctx);
  // Continues from +3 -> adds +4, +5, +6 - does NOT re-attempt "Jordan"
  // (already there) or "Jordan+1..3" (already there, which would just be
  // rejected as duplicates and leave the sender with only +3 total).
  assert.equal(second.replies.length, 0, 'expected no "already on the list"/duplicate rejections');
  const finalNames = store.getCurrentEvent(groupId).entries.map((e) => e.name);
  assert.deepEqual(finalNames, ['Jordan', 'Jordan+1', 'Jordan+2', 'Jordan+3', 'Jordan+4', 'Jordan+5', 'Jordan+6']);
});

test('handleIn: "+N" continues the guest numbering from the sender\'s EXISTING self-entry name, even if their push name has since changed', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});

  const first = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '+2' });
  await listCommands.handleIn(first.ctx);
  assert.deepEqual(
    store.getCurrentEvent(groupId).entries.map((e) => e.name),
    ['Jordan', 'Jordan+1', 'Jordan+2']
  );

  // Same WhatsApp account, but a different current push name this time.
  const second = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan D.', argText: '+1' });
  await listCommands.handleIn(second.ctx);
  // Anchored to the EXISTING "Jordan" self entry, not a fresh "Jordan D."
  // chain - continues at +3, and does not add a second self entry.
  const finalNames = store.getCurrentEvent(groupId).entries.map((e) => e.name);
  assert.deepEqual(finalNames, ['Jordan', 'Jordan+1', 'Jordan+2', 'Jordan+3']);
});

test('handleIn: "!in Peter, +2" (mixed with an explicit name) does NOT mark the sender\'s own expanded entry as self', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const { ctx } = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: 'Peter, +2' });
  await listCommands.handleIn(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.deepEqual(entries.map((e) => e.name), ['Peter', 'Jordan', 'Jordan+1', 'Jordan+2']);
  // "+N" only gets self treatment when it's the ENTIRE argText on its own -
  // combined with another explicit name, this is treated like any other
  // multi-name list (nobody marked self), matching "!in Peter, Jordan"'s
  // existing behavior.
  assert.ok(entries.every((e) => e.self === false));
});

test('handleOut: "!out +2" removes the sender and both of their guest entries', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const addCtx = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '+2' });
  await listCommands.handleIn(addCtx.ctx);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 3);

  const outCtx = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '+2' });
  await listCommands.handleOut(outCtx.ctx);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 0);
});

test('handlePaid: "!paid +2" marks the sender and both of their guest entries paid', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Jordan', 'jordan@s.whatsapp.net', false, true);
  store.addEntry(groupId, 'Jordan+1', 'jordan@s.whatsapp.net', false, false);
  store.addEntry(groupId, 'Jordan+2', 'jordan@s.whatsapp.net', false, false);
  store.newList(groupId, '2026-08-20', {}); // archives all three into duePayments
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 3);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '+2' });
  await listCommands.handlePaid(ctx);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);
});

test('handleOut: promotion off the waitlist sends a tagged mention message', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', argText: 'Alex' });
  await listCommands.handleOut(ctx);

  const promoMsg = sock.sentMessages.find((m) => /Off the waitlist/.test(m.content.text || ''));
  assert.ok(promoMsg, 'expected a promotion message to have been sent');
  assert.deepEqual(promoMsg.content.mentions, ['sam@s.whatsapp.net']);
});

test('handleOut: someone with tournament:true leaving auto-promotes the front of the (🏆 WL) queue, tagged with its own mention message', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true); // takes the spot
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // WL'd - full

  const { ctx } = makeCtx({ sock, groupId, senderId: 'keith@s.whatsapp.net', argText: 'Keith' });
  await listCommands.handleOut(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  const bao = entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournament, true);
  assert.equal(bao.tournamentWaitlisted, false);

  const promoMsg = sock.sentMessages.find((m) => /tournament spot opened up/.test(m.content.text || ''));
  assert.ok(promoMsg, 'expected a tournament-promotion message to have been sent');
  assert.deepEqual(promoMsg.content.mentions, ['bao@s.whatsapp.net']);
});

test('handleOut: a leading "tournament" keyword moves someone OUT of the tournament without removing them from the list at all', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Garvin', 'garvin@s.whatsapp.net', false, true, true);

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Garvin' });
  const outcome = await listCommands.handleOut(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.length, 1); // still on the list
  const garvin = entries.find((e) => e.name === 'Garvin');
  assert.equal(garvin.tournament, false);
  assert.equal(Boolean(garvin.tournamentWaitlisted), false);
  assert.deepEqual(outcome.tournamentLeft, ['Garvin']);
  assert.equal(replies.length, 0); // quiet on success, same as everywhere else - reposted list is proof enough
});

test('handleOut: bare "!out tournament" resolves to the sender\'s own entry', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'keith@s.whatsapp.net', senderName: 'Keith', argText: 'tournament' });
  await listCommands.handleOut(ctx);

  const entry = store.getCurrentEvent(groupId).entries[0];
  assert.equal(entry.name, 'Keith');
  assert.equal(entry.tournament, false);
});

test('handleOut: "!out tournament Alex, Sam" moves MULTIPLE names to social only in one command', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false, true, true);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Alex, Sam' });
  const outcome = await listCommands.handleOut(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Alex').tournament, false);
  assert.equal(entries.find((e) => e.name === 'Sam').tournament, false);
  assert.deepEqual(outcome.tournamentLeft.sort(), ['Alex', 'Sam']);
  assert.equal(entries.length, 2); // neither removed from the list
});

test('handleOut: "tournament" combines with "paid", either order, same as !in - attempted independently of the tournament-leave outcome', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.setDuePaymentsLabel(groupId, 'Payment');
  store.addEntry(groupId, 'A', 'a@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'B', 'b@s.whatsapp.net', false, true, true);

  const a = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament paid A' });
  const aOutcome = await listCommands.handleOut(a.ctx);
  const b = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'paid tournament B' });
  const bOutcome = await listCommands.handleOut(b.ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'A').tournament, false);
  assert.equal(entries.find((e) => e.name === 'B').tournament, false);
  assert.deepEqual(aOutcome.tournamentLeft, ['A']);
  assert.deepEqual(bOutcome.tournamentLeft, ['B']);
  // Nobody's actually in duePayments yet in this scenario (that only gets
  // populated by !newlist archiving) - so both are reported as rejected,
  // same as standalone !paid would for a not-yet-due name. The point being
  // tested is that "paid" ran at all, alongside "tournament", not silently
  // dropped - not the payment-tracking mechanics themselves (covered
  // elsewhere).
  assert.deepEqual(aOutcome.paidRejected, [
    'A is not on the payment list, perhaps you signed up under a different name or someone already marked you as paid',
  ]);
  assert.deepEqual(bOutcome.paidRejected, [
    'B is not on the payment list, perhaps you signed up under a different name or someone already marked you as paid',
  ]);
});

test('handleOut: "tournament" on a name not on the list at all is rejected, not silently ignored', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Nobody' });
  const outcome = await listCommands.handleOut(ctx);

  assert.deepEqual(outcome.rejected, ['Nobody - not on the list']);
  assert.match(replies.join('\n'), /Couldn't move to social only/);
});

test('handleOut: "tournament" on someone already social-only (never opted in) is a quiet no-op', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Garvin', 'garvin@s.whatsapp.net', false, true); // never opted in

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Garvin' });
  const outcome = await listCommands.handleOut(ctx);

  assert.deepEqual(outcome.alreadyOut, ['Garvin']);
  assert.equal(outcome.tournamentLeft.length, 0);
  assert.equal(replies.length, 0);
});

test('handleOut: "tournament" freeing an actual spot auto-promotes the front of the (🏆 WL) queue, tagged with its own mention message', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true); // takes the spot
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // WL'd - full

  const { ctx } = makeCtx({ sock, groupId, senderId: 'keith@s.whatsapp.net', argText: 'tournament Keith' });
  await listCommands.handleOut(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Keith').tournament, false); // moved to social only, not removed
  assert.equal(entries.length, 2);
  const bao = entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournament, true);
  assert.equal(bao.tournamentWaitlisted, false);

  const promoMsg = sock.sentMessages.find((m) => /tournament spot opened up/.test(m.content.text || ''));
  assert.ok(promoMsg, 'expected a tournament-promotion message to have been sent');
  assert.deepEqual(promoMsg.content.mentions, ['bao@s.whatsapp.net']);
});

test('handleTournamentLimit: raising the limit auto-promotes the (🏆 WL) queue and mentions whoever got in', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // WL'd - full

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '2' });
  await adminCommands.handleTournamentLimit(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, true);

  const promoMsg = sock.sentMessages.find((m) => /tournament spot opened up/.test(m.content.text || ''));
  assert.ok(promoMsg, 'expected a tournament-promotion message to have been sent');
  assert.deepEqual(promoMsg.content.mentions, ['bao@s.whatsapp.net']);
});

test('handleClear: rejects non-admins, wipes the list for admins', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);

  const nonAdmin = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net' });
  await adminCommands.handleClear(nonAdmin.ctx);
  assert.match(nonAdmin.replies[0], /Only a group admin/);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);

  const admin = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net' });
  await adminCommands.handleClear(admin.ctx);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 0);
});

test('handleClearpayments: rejects non-admins, wipes duePayments (not entries) for admins, and no-ops with a reply when already empty', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // archives Alex into duePayments
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 1);

  const nonAdmin = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net' });
  await adminCommands.handleClearpayments(nonAdmin.ctx);
  assert.match(nonAdmin.replies[0], /Only a group admin/);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 1);

  const admin = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net' });
  await adminCommands.handleClearpayments(admin.ctx);
  assert.equal(admin.replies.length, 0);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1); // list untouched

  const alreadyEmpty = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net' });
  await adminCommands.handleClearpayments(alreadyEmpty.ctx);
  assert.match(alreadyEmpty.replies[0], /Nobody currently owes payment/);
});

test('handleLimit: raising the limit promotes people off the waitlist with a tagged mention', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false); // waitlisted, limit is 1

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '2' });
  await adminCommands.handleLimit(ctx);

  const promoMsg = sock.sentMessages.find((m) => /Off the waitlist/.test(m.content.text || ''));
  assert.ok(promoMsg, 'expected a promotion message to have been sent');
  assert.deepEqual(promoMsg.content.mentions, ['sam@s.whatsapp.net']);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 2);
});

test('handleCourts: plain "!courts 13-18" replaces the whole court list (rejects non-admins first)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setCourts(groupId, '1-4');

  const nonAdmin = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: '13-18' });
  await adminCommands.handleCourts(nonAdmin.ctx);
  assert.match(nonAdmin.replies[0], /Only a group admin/);
  assert.equal(store.getCurrentEvent(groupId).courts, '1-4');

  const admin = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '13-18' });
  await adminCommands.handleCourts(admin.ctx);
  assert.equal(store.getCurrentEvent(groupId).courts, '13-18'); // replaced, not merged
});

test('handleCourts: leading "add" merges into the existing courts instead of replacing them', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setCourts(groupId, '13-18');

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'add 1' });
  await adminCommands.handleCourts(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courts, '1, 13-18');
  assert.equal(event.courtCount, 7);
});

test('handleCourts: leading "extra" is a synonym for "add"', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setCourts(groupId, '13-18');

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'extra 12-14' });
  await adminCommands.handleCourts(ctx);

  assert.equal(store.getCurrentEvent(groupId).courts, '12-18');
});

test('handleCourts: "add" with nothing set yet just sets those courts (equivalent to a plain !courts)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'add 12-14' });
  await adminCommands.handleCourts(ctx);

  assert.equal(store.getCurrentEvent(groupId).courts, '12-14');
});

test('handleCourts: raising via "add" promotes off the waitlist with a tagged mention, same as a plain !courts change', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setCourts(groupId, '1'); // limit = PLAYERS_PER_COURT
  for (let i = 0; i < store.PLAYERS_PER_COURT; i += 1) {
    store.addEntry(groupId, `P${i}`, `p${i}@s.whatsapp.net`, false);
  }
  store.addEntry(groupId, 'Waity', 'waity@s.whatsapp.net', false); // waitlisted

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'add 2' });
  await adminCommands.handleCourts(ctx);

  const promoMsg = sock.sentMessages.find((m) => /Off the waitlist/.test(m.content.text || ''));
  assert.ok(promoMsg, 'expected a promotion message to have been sent');
  assert.deepEqual(promoMsg.content.mentions, ['waity@s.whatsapp.net']);
});

test('handleCourts: an invalid "add" value gets a distinct, add-specific error message', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setCourts(groupId, '13-18');

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'add not-a-court' });
  await adminCommands.handleCourts(ctx);

  assert.match(replies[0], /isn't a valid court list to add/);
  assert.equal(store.getCurrentEvent(groupId).courts, '13-18'); // unchanged
});

test('handleAllow: moves people off the waitlist with a tagged mention', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false); // waitlisted

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '1' });
  await adminCommands.handleAllow(ctx);

  const promoMsg = sock.sentMessages.find((m) => /Off the waitlist/.test(m.content.text || ''));
  assert.ok(promoMsg, 'expected a promotion message to have been sent');
  assert.deepEqual(promoMsg.content.mentions, ['sam@s.whatsapp.net']);
});

test('handleAllow does not raise the limit, so a later handleOut does not auto-promote while attendance is still at/over it', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLimit(groupId, 2);
  store.addEntry(groupId, 'A', 'a@s.whatsapp.net', false, true); // self: true, so bare !out below can find it
  store.addEntry(groupId, 'B', 'b@s.whatsapp.net', false);
  store.addEntry(groupId, 'C', 'c@s.whatsapp.net', false); // waitlisted

  const allow = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '1' });
  await adminCommands.handleAllow(allow.ctx);
  assert.equal(store.getLimit(groupId), 2, 'limit should be unchanged by !allow');
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['A', 'B', 'C']);

  // A leaves - attendance drops from 3 to 2, still AT the limit of 2, so
  // nobody should be auto-promoted (there's nobody left on the waitlist to
  // promote in this case anyway, but the key assertion is entries stays at
  // 2 without error and no NEW promotion message is sent as a result of
  // this !out - only compare messages sent from here on, since !allow's
  // own promotion tag for C is already in sock.sentMessages).
  const messagesBeforeOut = sock.sentMessages.length;
  const out = makeCtx({ sock, groupId, senderId: 'a@s.whatsapp.net', argText: '' });
  await listCommands.handleOut(out.ctx);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['B', 'C']);
  const newMessages = sock.sentMessages.slice(messagesBeforeOut);
  const promoMsgAfterOut = newMessages.find((m) => /Off the waitlist/.test(m.content.text || ''));
  assert.equal(promoMsgAfterOut, undefined, 'no promotion should happen while still at the limit');
});

test('handleNewlist: rejects an invalid date, accepts a valid one and applies details', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const bad = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'not-a-date' });
  await adminCommands.handleNewlist(bad.ctx);
  assert.match(bad.replies[0], /isn't a valid date/);

  const good = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 EBC | 13-18 | 8PM start' });
  await adminCommands.handleNewlist(good.ctx);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.location, 'EBC');
  assert.equal(event.courtCount, 6);
  assert.equal(event.time, '8PM start');
});

test('handleNewlist: "same" (in place of a date) reuses the current list\'s day of the week', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2026-08-20', {}); // a Thursday

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'same' });
  await adminCommands.handleNewlist(ctx.ctx);

  const newDate = store.getCurrentEvent(groupId).date;
  const [y, m, d] = newDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const originalWeekday = new Date(Date.UTC(2026, 7, 20)).getUTCDay();
  assert.equal(weekday, originalWeekday); // same day of the week
  assert.equal(ctx.replies.length, 0); // quiet on success, same as a typed date
});

test('handleNewlist: "same" is case-insensitive and combines with location/courts/time and a "with <names>" clause', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLimit(groupId, null); // isolate from the default per-group limit
  store.newList(groupId, '2026-08-20', {});

  const ctx = makeCtx({
    sock,
    groupId,
    senderId: 'admin@s.whatsapp.net',
    argText: 'SAME EBC | 13-18 | 8PM start with Peter, Chris',
  });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.location, 'EBC');
  assert.equal(event.courtCount, 6);
  assert.equal(event.time, '8PM start');
  assert.deepEqual(event.entries.map((e) => e.name), ['Peter', 'Chris']);
});

test('handleNewlist: "same" on a list that never had a date set replies with a clear error instead of guessing', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'same' });
  await adminCommands.handleNewlist(ctx.ctx);

  assert.match(ctx.replies[0], /doesn't have a date set yet/);
  assert.ok(!store.getCurrentEvent(groupId).date); // untouched, no list started
});

test('handleNewlist: a trailing "with <names>" clause pre-populates the brand new list, in order', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLimit(groupId, null); // isolate this test from the default per-group limit of 6

  const ctx = makeCtx({
    sock,
    groupId,
    senderId: 'admin@s.whatsapp.net',
    argText: '20/08 EBC | 13-18 | 8PM start with Peter, Chris, Linda',
  });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.location, 'EBC');
  assert.deepEqual(event.entries.map((e) => e.name), ['Peter', 'Chris', 'Linda']);
  // Attributed to the admin who ran !newlist, but not marked `self` -
  // none of these three ran the command themselves.
  assert.ok(event.entries.every((e) => e.addedBy === 'admin@s.whatsapp.net' && e.self === false));
});

test('handleNewlist: "with <names>" works with no location/courts/time mentioned at all', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 with Peter, Chris, Linda' });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.location, null);
  assert.deepEqual(event.entries.map((e) => e.name), ['Peter', 'Chris', 'Linda']);
});

test('handleNewlist: "with <names>" still respects the new list\'s own limit, waitlisting anyone over it', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const ctx = makeCtx({
    sock,
    groupId,
    senderId: 'admin@s.whatsapp.net',
    argText: '20/08 with Peter, Chris, Linda, Rj, Rron, Charlie, Will', // limit defaults to 6
  });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 6);
  assert.deepEqual(event.waitlist.map((e) => e.name), ['Will']);
});

test('handleNewlist: without a "with" clause and no saved regulars, nothing is added to the brand new list (unchanged behavior)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 EBC' });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 0);
});

test('handleNewlist: "with regular players" pre-populates from the saved roster, and can combine with an explicit extra name', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Peter', 'Chris', 'Linda']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 with regular players, Extra Guest' });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.deepEqual(event.entries.map((e) => e.name), ['Peter', 'Chris', 'Linda', 'Extra Guest']);
});

test('handleNewlist: "with regular players" on an empty saved roster adds nobody and mentions it', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 with regular players' });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 0);
  assert.ok(ctx.replies.some((r) => /none saved yet/i.test(r)));
});

test('handleNewlist: the saved regulars roster is always added and opted into the tournament, even with no "with" clause at all', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Peter', 'Chris', 'Linda']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 EBC' });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.deepEqual(event.entries.map((e) => e.name), ['Peter', 'Chris', 'Linda']);
  assert.ok(event.entries.every((e) => e.tournament === true));
});

test('handleNewlist: an explicit "with <names>" clause stays social-only, while the merged-in regulars are opted into the tournament', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Peter', 'Chris']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 with Extra Guest' });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.deepEqual(event.entries.map((e) => e.name), ['Extra Guest', 'Peter', 'Chris']);
  const byName = Object.fromEntries(event.entries.map((e) => [e.name, e]));
  assert.equal(byName['Extra Guest'].tournament, false);
  assert.equal(byName['Peter'].tournament, true);
  assert.equal(byName['Chris'].tournament, true);
});

test('handleNewlist: a regular also explicitly named in "with <names>" is added once, still opted into the tournament', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Peter', 'Chris']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 with Peter, Extra Guest' });
  await adminCommands.handleNewlist(ctx.ctx);

  const event = store.getCurrentEvent(groupId);
  assert.deepEqual(event.entries.map((e) => e.name), ['Peter', 'Extra Guest', 'Chris']);
  const byName = Object.fromEntries(event.entries.map((e) => [e.name, e]));
  assert.equal(byName['Peter'].tournament, true);
  assert.equal(byName['Chris'].tournament, true);
  assert.equal(byName['Extra Guest'].tournament, false);
  assert.ok(!ctx.replies.some((r) => /already on the list/i.test(r)));
});

test('handleIn: "regular players" adds the saved roster, and none of the added entries are marked self', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setRegularPlayers(groupId, ['Peter', 'Chris']);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: 'regular players' });
  await listCommands.handleIn(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.deepEqual(event.entries.map((e) => e.name), ['Peter', 'Chris']);
  assert.ok(event.entries.every((e) => e.self === false));
});

test('handleIn: "regular players" with an empty saved roster adds nobody and explains why', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: 'regular players' });
  await listCommands.handleIn(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 0);
  assert.ok(replies.some((r) => /none saved yet/i.test(r)));
});

test('handleRegulars: bare command shows "(none set)" for a brand new group, and the roster once set', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const empty = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleRegulars(empty.ctx);
  assert.match(empty.replies[0], /none set/i);

  store.setRegularPlayers(groupId, ['Peter', 'Chris']);
  const shown = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleRegulars(shown.ctx);
  assert.match(shown.replies[0], /1\. Peter/);
  assert.match(shown.replies[0], /2\. Chris/);
});

test('handleRegulars: only an admin can change it - a non-admin\'s attempt to set it is refused', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const ctx = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', argText: 'Peter, Chris' });
  await adminCommands.handleRegulars(ctx.ctx);
  assert.match(ctx.replies[0], /only a group admin/i);
  assert.deepEqual(store.getRegularPlayers(groupId), []);
});

test('handleRegulars: a plain name list REPLACES the whole roster', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Old Player']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'Peter, Chris, Linda' });
  await adminCommands.handleRegulars(ctx.ctx);

  assert.deepEqual(store.getRegularPlayers(groupId), ['Peter', 'Chris', 'Linda']);
});

test('handleRegulars: "add <names>" appends to the existing roster without duplicating an already-present name', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Peter', 'Chris']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'add Chris, Dean' });
  await adminCommands.handleRegulars(ctx.ctx);

  assert.deepEqual(store.getRegularPlayers(groupId), ['Peter', 'Chris', 'Dean']);
});

test('handleRegulars: "remove <names>" removes matching names, case/whitespace-insensitively, and leaves the rest', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Peter', 'Chris', 'Linda']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'remove  chris ' });
  await adminCommands.handleRegulars(ctx.ctx);

  assert.deepEqual(store.getRegularPlayers(groupId), ['Peter', 'Linda']);
});

test('handleRegulars: "clear" empties the roster', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setRegularPlayers(groupId, ['Peter', 'Chris']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'clear' });
  await adminCommands.handleRegulars(ctx.ctx);

  assert.deepEqual(store.getRegularPlayers(groupId), []);
});

// --- !exempt (who never needs to pay) - same add/remove/clear/replace shape
// as !regulars above, just backed by getPaymentExempt/setPaymentExempt.

test('handleExempt: bare command shows "(none set)" for a brand new group, and the roster once set', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const empty = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleExempt(empty.ctx);
  assert.match(empty.replies[0], /none set/i);

  store.setPaymentExempt(groupId, ['Peter', 'Chris']);
  const shown = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleExempt(shown.ctx);
  assert.match(shown.replies[0], /1\. Peter/);
  assert.match(shown.replies[0], /2\. Chris/);
});

test('handleExempt: only an admin can change it - a non-admin\'s attempt to set it is refused', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const ctx = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', argText: 'Peter, Chris' });
  await adminCommands.handleExempt(ctx.ctx);
  assert.match(ctx.replies[0], /only a group admin/i);
  assert.deepEqual(store.getPaymentExempt(groupId), []);
});

test('handleExempt: a plain name list REPLACES the whole roster', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setPaymentExempt(groupId, ['Old Name']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'Peter, Chris, Linda' });
  await adminCommands.handleExempt(ctx.ctx);

  assert.deepEqual(store.getPaymentExempt(groupId), ['Peter', 'Chris', 'Linda']);
});

test('handleExempt: "add <names>" appends to the existing roster without duplicating an already-present name', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setPaymentExempt(groupId, ['Peter', 'Chris']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'add Chris, Dean' });
  await adminCommands.handleExempt(ctx.ctx);

  assert.deepEqual(store.getPaymentExempt(groupId), ['Peter', 'Chris', 'Dean']);
});

test('handleExempt: "remove <names>" removes matching names, case/whitespace-insensitively, and leaves the rest', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setPaymentExempt(groupId, ['Peter', 'Chris', 'Linda']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'remove  chris ' });
  await adminCommands.handleExempt(ctx.ctx);

  assert.deepEqual(store.getPaymentExempt(groupId), ['Peter', 'Linda']);
});

test('handleExempt: "clear" empties the roster', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setPaymentExempt(groupId, ['Peter', 'Chris']);

  const ctx = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'clear' });
  await adminCommands.handleExempt(ctx.ctx);

  assert.deepEqual(store.getPaymentExempt(groupId), []);
});

test('handleExempt: an exempt name never ends up owing anything, even after attending and a !newlist transition', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setPaymentExempt(groupId, ['Peter']);
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Peter', 'h@s.whatsapp.net', false);
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);

  store.newList(groupId, '2026-08-20', {});

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.name), ['Alex']);
});

// --- !paid with multiple entries per name (owing for 2+ separate events) --

test('handlePaid: an explicit name with TWO entries (owes for two separate events) is cleared entirely by one !paid <name>', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Alex', 'a@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-27', {}); // Alex now owes twice

  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 2);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'someone@s.whatsapp.net', argText: 'Alex' });
  await listCommands.handlePaid(ctx);

  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);
});

test('handlePaid: a bare "!paid" (no name) with TWO entries under the SAME name is NOT ambiguous - it clears both at once', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // self: true
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true);
  store.newList(groupId, '2026-08-27', {}); // Alex owes twice, both self-added under the same name

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', argText: '' });
  await listCommands.handlePaid(ctx);

  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);
  assert.ok(!replies.some((r) => /more than one entry/i.test(r)));
});

test('handlePaid: a bare "!paid" (no name) with entries under TWO DIFFERENT names IS still ambiguous', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // self-added as "Alex"
  store.newList(groupId, '2026-08-20', {});
  store.addEntry(groupId, 'Alexander', 'alex@s.whatsapp.net', false, true); // same person, different name this cycle
  store.newList(groupId, '2026-08-27', {});

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', argText: '' });
  await listCommands.handlePaid(ctx);

  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 2); // nothing cleared
  assert.match(replies[0], /more than one entry/i);
});

// --- Tournament sub-feature: !settournament, !tournament, !tournamentlimit,
// !tournamentwinners (commands/admin.js), and !in's "tournament" opt-in
// keyword (commands/list.js) ---

test('handleSettournament: bare command explains how to turn it on when off, admin-gates on/off, and always replies', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setTournamentEnabled(groupId, false); // tournament is ON by default now - start from off to exercise the toggle

  const view = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleSettournament(view.ctx);
  assert.match(view.replies[0], /OFF/);

  const refused = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', argText: 'on' });
  await adminCommands.handleSettournament(refused.ctx);
  assert.match(refused.replies[0], /only a group admin/i);
  assert.equal(store.isTournamentEnabled(groupId), false);

  const on = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'on' });
  await adminCommands.handleSettournament(on.ctx);
  assert.match(on.replies[0], /turned \*on\*/);
  assert.equal(store.isTournamentEnabled(groupId), true);

  const off = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'off' });
  await adminCommands.handleSettournament(off.ctx);
  assert.match(off.replies[0], /turned \*off\*/);
  assert.equal(store.isTournamentEnabled(groupId), false);
});

test('handleSettournament: bare view once enabled shows the current tournament roster', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setTournamentEnabled(groupId, true);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);

  const view = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleSettournament(view.ctx);
  assert.match(view.replies[0], /1\. Keith/);
});

test('handleSettournament: "rules <text>" is admin-gated to set, and bare "rules" views without changing', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const view = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: 'rules' });
  await adminCommands.handleSettournament(view.ctx);
  assert.match(view.replies[0], /no tournament rules/i);
  assert.equal(store.getTournamentRules(groupId), null);

  const refused = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', argText: 'rules Best of 3' });
  await adminCommands.handleSettournament(refused.ctx);
  assert.match(refused.replies[0], /only a group admin/i);
  assert.equal(store.getTournamentRules(groupId), null);

  const set = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'rules Best of 3, single elimination' });
  await adminCommands.handleSettournament(set.ctx);
  assert.match(set.replies[0], /updated/i);
  assert.equal(store.getTournamentRules(groupId), 'Best of 3, single elimination');

  const viewAgain = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: 'rules' });
  await adminCommands.handleSettournament(viewAgain.ctx);
  assert.match(viewAgain.replies[0], /Best of 3, single elimination/);
  assert.equal(store.getTournamentRules(groupId), 'Best of 3, single elimination');
});

test('handleTournament: view-only, shows the rules set via !settournament rules, not gated on the on/off toggle', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  // Tournament feature is OFF (never enabled), but bare !tournament still
  // works - it's not gated on isTournamentEnabled, same precedent as
  // handleTournamentWinners's bare view.
  const notSet = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleTournament(notSet.ctx);
  assert.match(notSet.replies[0], /no tournament rules/i);
  assert.match(notSet.replies[0], /settournament rules/i);

  store.setTournamentRules(groupId, 'Best of 3, single elimination');
  const set = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleTournament(set.ctx);
  assert.match(set.replies[0], /Best of 3, single elimination/);
});

test('handleTournamentLimit: view with no argument, admin-gated to change, "off" removes the cap', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const view = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleTournamentLimit(view.ctx);
  assert.match(view.replies[0], /no tournament limit/i);

  const refused = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', argText: '16' });
  await adminCommands.handleTournamentLimit(refused.ctx);
  assert.match(refused.replies[0], /only a group admin/i);

  const set = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '16' });
  await adminCommands.handleTournamentLimit(set.ctx);
  assert.equal(store.getTournamentLimit(groupId), 16);

  const cleared = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'off' });
  await adminCommands.handleTournamentLimit(cleared.ctx);
  assert.equal(store.getTournamentLimit(groupId), null);
});

test('handleTournamentWinners: view, admin-gated to change, requires exactly two names', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const view = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleTournamentWinners(view.ctx);
  assert.match(view.replies[0], /no tournament winners/i);

  const refused = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', argText: 'Irfan, Tu' });
  await adminCommands.handleTournamentWinners(refused.ctx);
  assert.match(refused.replies[0], /only a group admin/i);

  const badCount = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'Irfan' });
  await adminCommands.handleTournamentWinners(badCount.ctx);
  assert.match(badCount.replies[0], /usage/i);
  assert.equal(store.getTournamentWinners(groupId), null);

  const set = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'Irfan, Tu' });
  await adminCommands.handleTournamentWinners(set.ctx);
  assert.deepEqual(store.getTournamentWinners(groupId), ['Irfan', 'Tu']);
});

test('handleTournamentWinners waives the winners\' payment debt for the week they won', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  store.setDate(groupId, '2026-08-13');
  store.addEntry(groupId, 'Irfan', 'i@s.whatsapp.net', false);
  store.addEntry(groupId, 'Tu', 't@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 's@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Irfan/Tu/Sam now owe for 8/13

  const set = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'Irfan, Tu' });
  await adminCommands.handleTournamentWinners(set.ctx);

  assert.match(set.replies[0], /payment waived for Irfan and Tu/i);
  const due = store.getCurrentEvent(groupId).duePayments;
  assert.deepEqual(due.map((e) => e.name), ['Sam']);
});

test('handleIn: a trailing "tournament" keyword opts a new joiner in, when there\'s room', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'keith@s.whatsapp.net', senderName: 'Keith', argText: 'tournament' });
  await listCommands.handleIn(ctx);

  const entry = store.getCurrentEvent(groupId).entries[0];
  assert.equal(entry.name, 'Keith');
  assert.equal(entry.tournament, true);
});

test('handleIn: tournament full - the person still joins socially, quietly, tagged (🏆 WL) instead of a tournament flag', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'bao@s.whatsapp.net', senderName: 'Bao', argText: 'tournament' });
  await listCommands.handleIn(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  const bao = entries.find((e) => e.name === 'Bao');
  assert.equal(bao.tournament, false);
  assert.equal(bao.tournamentWaitlisted, true);
  // Quiet - same "the reposted list is proof enough" pattern as ordinary
  // waitlisting, no separate "tournament is full" reply. The (🏆 WL) tag on
  // the posted list is what makes it visible instead.
  assert.equal(replies.length, 0);

  const posted = formatList(groupId);
  assert.match(posted, /Bao \(🏆 WL\)/);
});

test('handleIn: tournament not enabled at all - joins socially, WITH an explicit reply (unlike the quiet full case)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, false); // tournament is ON by default now

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'keith@s.whatsapp.net', senderName: 'Keith', argText: 'tournament' });
  await listCommands.handleIn(ctx);

  const entry = store.getCurrentEvent(groupId).entries[0];
  assert.equal(entry.name, 'Keith');
  assert.equal(entry.tournament, false);
  assert.match(replies.join('\n'), /tournament isn't enabled/i);
});

test('handleIn: "!in tournament Alex, Sam" opts BOTH names into the tournament', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);

  const { ctx } = makeCtx({ sock, groupId, senderId: 'sender@s.whatsapp.net', argText: 'tournament Alex, Sam' });
  await listCommands.handleIn(ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Alex').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Sam').tournament, true);
});

test('handleIn: "paid" and "tournament" both work as leading keywords, in either order', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.setDuePaymentsLabel(groupId, 'Payment');

  const a = makeCtx({ sock, groupId, senderId: 'a@s.whatsapp.net', senderName: 'A', argText: 'tournament paid' });
  await listCommands.handleIn(a.ctx);
  const b = makeCtx({ sock, groupId, senderId: 'b@s.whatsapp.net', senderName: 'B', argText: 'paid tournament' });
  await listCommands.handleIn(b.ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'A').tournament, true);
  assert.equal(entries.find((e) => e.name === 'B').tournament, true);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0); // both marked paid immediately
});

test('handleIn: already on the list, bare "!in tournament" upgrades the existing entry rather than re-adding', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);

  const first = makeCtx({ sock, groupId, senderId: 'keith@s.whatsapp.net', senderName: 'Keith', argText: '' });
  await listCommands.handleIn(first.ctx);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);

  const second = makeCtx({ sock, groupId, senderId: 'keith@s.whatsapp.net', senderName: 'Keith', argText: 'tournament' });
  await listCommands.handleIn(second.ctx);

  assert.equal(store.getCurrentEvent(groupId).entries.length, 1); // not duplicated
  assert.equal(store.getCurrentEvent(groupId).entries[0].tournament, true);
});

test('handleIn: "!in tournament Alex, Sam" upgrades MULTIPLE already-on-the-list names in one command, without re-adding or duplicating them', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);

  const joinSocial = makeCtx({ sock, groupId, senderId: 'gary@s.whatsapp.net', senderName: 'Gary', argText: 'Alex, Sam' });
  await listCommands.handleIn(joinSocial.ctx);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 2);

  const upgrade = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Alex, Sam' });
  const outcome = await listCommands.handleIn(upgrade.ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.length, 2); // still just the two, not duplicated
  assert.equal(entries.find((e) => e.name === 'Alex').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Sam').tournament, true);
  assert.deepEqual(outcome.tournamentJoined.sort(), ['Alex', 'Sam']);
  assert.equal(upgrade.replies.length, 0); // quiet on success, same as everything else here
});

test('handleIn: upgrading multiple already-on-the-list names respects tournament capacity - one gets in, the other is tagged (🏆 WL)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);

  const joinSocial = makeCtx({ sock, groupId, senderId: 'gary@s.whatsapp.net', senderName: 'Gary', argText: 'Alex, Sam' });
  await listCommands.handleIn(joinSocial.ctx);

  const upgrade = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Alex, Sam' });
  const outcome = await listCommands.handleIn(upgrade.ctx);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Alex').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Sam').tournament, false);
  assert.equal(entries.find((e) => e.name === 'Sam').tournamentWaitlisted, true);
  assert.deepEqual(outcome.tournamentJoined, ['Alex']);
  assert.equal(upgrade.replies.length, 0); // still quiet - the (🏆 WL) tag on the reposted list is proof enough
});

test('handleIn: upgrading a name that\'s only on the main WAITLIST (not confirmed attendance) is rejected with a clear reason', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, true);
  store.setLimit(groupId, 1);

  const joinSocial = makeCtx({ sock, groupId, senderId: 'gary@s.whatsapp.net', senderName: 'Gary', argText: 'Alex, Wendy' });
  await listCommands.handleIn(joinSocial.ctx); // Alex confirmed, Wendy waitlisted (limit 1)
  assert.deepEqual(store.getCurrentEvent(groupId).waitlist.map((e) => e.name), ['Wendy']);

  const upgrade = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Wendy' });
  const outcome = await listCommands.handleIn(upgrade.ctx);

  assert.equal(outcome.tournamentJoined.length, 0);
  assert.match(upgrade.replies[0], /already on the waitlist, not eligible for the tournament/);
});

test('handleIn: upgrading names already on the list when the tournament is disabled gets the explicit "not enabled" reply, not silent nothing', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.setTournamentEnabled(groupId, false); // tournament is ON by default now

  const joinSocial = makeCtx({ sock, groupId, senderId: 'gary@s.whatsapp.net', senderName: 'Gary', argText: 'Alex, Sam' });
  await listCommands.handleIn(joinSocial.ctx);

  const upgrade = makeCtx({ sock, groupId, senderId: 'other@s.whatsapp.net', argText: 'tournament Alex, Sam' });
  const outcome = await listCommands.handleIn(upgrade.ctx);

  assert.equal(outcome.tournamentJoined.length, 0);
  assert.match(upgrade.replies[0], /Tournament isn't enabled/);
  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Alex').tournament, false);
  assert.equal(entries.find((e) => e.name === 'Sam').tournament, false);
});

// --- !undo (dispatched through the real `commands` table, not the raw
// handler directly, since the undo-tracking wrapper that actually
// populates an undo point lives in commands/index.js, not in any
// individual handler - see its withUndoTracking() doc comment) ---

test('handleUndo (via the real dispatch table): reverses the last mutating command, e.g. a !clear', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const add = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '' });
  await commands['!in'](add.ctx);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['Jordan']);

  const clear = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!clear'](clear.ctx);
  assert.deepEqual(store.getCurrentEvent(groupId).entries, []);

  const undo = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!undo'](undo.ctx);
  assert.match(undo.replies[0], /Undid: !clear/);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['Jordan']);
});

test('handleUndo: running it twice in a row toggles back and forth (acts as a redo)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const add = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '' });
  await commands['!in'](add.ctx);

  const firstUndo = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!undo'](firstUndo.ctx);
  assert.deepEqual(store.getCurrentEvent(groupId).entries, []); // Jordan's add undone

  const secondUndo = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!undo'](secondUndo.ctx);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['Jordan']); // redone
});

test('handleUndo: a view-only command (e.g. bare !location) in between does not overwrite the real undo point', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const add = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '' });
  await commands['!in'](add.ctx);

  const view = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await commands['!location'](view.ctx); // bare - view only, no mutation

  const undo = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!undo'](undo.ctx);
  assert.match(undo.replies[0], /Undid: !in/);
  assert.deepEqual(store.getCurrentEvent(groupId).entries, []); // Jordan's add undone, not a no-op
});

test('handleUndo: with nothing to undo yet, replies accordingly and changes nothing', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const undo = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!undo'](undo.ctx);
  assert.match(undo.replies[0], /nothing to undo/i);
});

test('handleUndo: only an admin can run it', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const add = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '' });
  await commands['!in'](add.ctx);

  const undo = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', argText: '' });
  await commands['!undo'](undo.ctx);
  assert.match(undo.replies[0], /only a group admin/i);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['Jordan']); // unchanged
});

test('handleUndo: reverses a whole !newlist, restoring the discarded old current list', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const add = makeCtx({ sock, groupId, senderId: 'jordan@s.whatsapp.net', senderName: 'Jordan', argText: '' });
  await commands['!in'](add.ctx);

  const newlist = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '20/08 EBC' });
  await commands['!newlist'](newlist.ctx);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 0); // fresh, empty list - the old one isn't kept anywhere

  const undo = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!undo'](undo.ctx);
  assert.deepEqual(store.getCurrentEvent(groupId).entries.map((e) => e.name), ['Jordan']); // restored
});

test('handleDate: bare command shows the current date (or "No date set") without changing it', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const noneYet = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleDate(noneYet.ctx);
  assert.match(noneYet.replies[0], /No date set/);

  store.newList(groupId, '2026-08-20', {});
  const withDate = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await adminCommands.handleDate(withDate.ctx);
  assert.match(withDate.replies[0], /Current date:/);
  assert.match(withDate.replies[0], /20th Aug Thu/);
  assert.equal(store.getCurrentEvent(groupId).date, '2026-08-20'); // unchanged
});

test('handleDate: rejects non-admins and invalid dates, and does not touch anything else on success', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLocation(groupId, 'EBC');
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex now owes payment; date is 2026-08-20
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false);

  const nonAdmin = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: '27/08' });
  await adminCommands.handleDate(nonAdmin.ctx);
  assert.match(nonAdmin.replies[0], /Only a group admin/);
  assert.equal(store.getCurrentEvent(groupId).date, '2026-08-20');

  const badDate = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'not-a-date' });
  await adminCommands.handleDate(badDate.ctx);
  assert.match(badDate.replies[0], /isn't a valid date/);
  assert.equal(store.getCurrentEvent(groupId).date, '2026-08-20');

  const fixed = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '27/08' });
  await adminCommands.handleDate(fixed.ctx);
  assert.equal(fixed.replies.length, 0); // no confirmation reply on success - the reposted list is proof

  const event = store.getCurrentEvent(groupId);
  // Only asserting day/month, not the year - handleDate resolves "27/08"
  // via the real parseTypedDate() against the actual current date (same as
  // handleNewlist), so the resolved YEAR depends on when this test happens
  // to run; day/month is what actually changed and is what's deterministic.
  assert.match(event.date, /-08-27$/);
  assert.notEqual(event.date, '2026-08-20');
  // Nothing else about the list was touched by the correction.
  assert.equal(event.location, 'EBC');
  assert.deepEqual(event.entries.map((e) => e.name), ['Sam']);
  assert.equal(event.duePayments.length, 1);
  assert.equal(event.duePayments[0].name, 'Alex');
});

test('handleUpdate: rejects non-admins', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: '*Attendance*\n\n1. Alex' });
  await adminCommands.handleUpdate(ctx);
  assert.match(replies[0], /Only a group admin/);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 0);
});

test('handleUpdate: bare command (no pasted text) shows a usage reply', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await adminCommands.handleUpdate(ctx);
  assert.match(replies[0], /Usage:/);
});

test('handleUpdate: text with no recognizable section is rejected without changing anything', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'just some random text, not a list at all' });
  await adminCommands.handleUpdate(ctx);
  assert.match(replies[0], /Couldn't find/);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1); // unchanged
});

test('handleUpdate: applies additions/removals/moves, replies with a summary, and reposts the list', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Jo', 'jo@s.whatsapp.net', false); // waitlisted (limit 1)

  const pastedEdit = [
    "Here's the corrected list, sorry for the delay:",
    '',
    '*Attendance*',
    '',
    '1. Alex',
    '2. Jo', // moved up from the waitlist
    '3. NewPerson', // brand new
    '',
    '*Waitlist*',
    '',
    '(nobody)',
  ].join('\n');

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Added: NewPerson/);
  assert.match(replies[0], /Moved: Jo \(waitlist → attendance\)/);
  // Over the (still 1) limit now - should be flagged, not silently demoted.
  assert.match(replies[0], /Heads up: Attendance is now over the limit/);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 3);
  assert.equal(event.waitlist.length, 0);

  // Two messages: the summary reply, then the reposted list - both go
  // through sock.sendMessage, so check the LAST one specifically is the
  // freshly reposted list (containing the new roster), not just the
  // summary text repeated.
  assert.equal(sock.sentMessages.length, 2);
  const posted = sock.sentMessages[sock.sentMessages.length - 1];
  assert.match(posted.content.text, /NewPerson/);
  assert.match(posted.content.text, /\*Attendance\*/);
});

test('handleUpdate: a payment section pasted back with its BOLD date-group headers ("*13th Aug Thu*" etc.) tags every entry under one with that header\'s owedSince - including a brand-new name, which previously always landed under "No date" regardless of which header it was typed under', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-10', {}); // Alex now owes for the 10th Aug list

  const pastedEdit = [
    '*Attendance*',
    '',
    '(empty)',
    '',
    '*Payment*',
    '',
    '*10th Aug Mon*',
    '1. Alex',
    '',
    '*13th Aug Thu*',
    '1. Jordan', // brand new - typed straight under a dated header, not "No date"
  ].join('\n');

  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  const due = store.getCurrentEvent(groupId).duePayments;
  const alex = due.find((e) => e.name === 'Alex');
  const jordan = due.find((e) => e.name === 'Jordan');
  assert.equal(alex.owedSince, '2026-08-10');
  assert.equal(jordan.owedSince, '2026-08-13');
});

test('handleUpdate: a brand-new payment name typed under "*No date*" (or with no group header at all) still gets no owedSince, same as before this feature existed', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const pastedEdit = ['*Attendance*', '', '(empty)', '', '*Payment*', '', '*No date*', '1. Casey'].join('\n');
  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  const due = store.getCurrentEvent(groupId).duePayments;
  assert.equal(due.find((e) => e.name === 'Casey').owedSince, undefined);
});

test('handleUpdate: a new name that fails moderation (too long) is rejected and reported, without blocking other valid changes', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const tooLong = 'X'.repeat(61); // moderation.js's MAX_NAME_LENGTH is 60
  const pastedEdit = ['*Attendance*', '', '1. Alex', `2. ${tooLong}`].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Added: Alex/);
  assert.match(replies[0], /Couldn't add:/);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 1);
  assert.equal(event.entries[0].name, 'Alex');
});

test('checkEntry: no longer filters profanity - names are only checked for blank/too-long (language filter removed)', () => {
  const { checkEntry } = require('../moderation');
  // Previously blocked by the leo-profanity dictionary check that used to
  // live in moderation.js - now allowed through like any other name.
  assert.equal(checkEntry('fuck').ok, true);
  assert.equal(checkEntry('').ok, false); // blank is still rejected
  assert.equal(checkEntry('X'.repeat(61)).ok, false); // still length-capped
  assert.equal(checkEntry('X'.repeat(60)).ok, true); // exactly at the cap is fine
});

test('handleUpdate: replying with the list unchanged makes no changes and does not repost it', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);

  const before = sock.sentMessages.length;
  const pastedEdit = ['*Attendance*', '', '1. Alex'].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /No changes found/);
  assert.equal(sock.sentMessages.length, before + 1); // only the reply above, no list repost
});

test('handleUpdate: pasting back a tournament-formatted list UNCHANGED (🏆 Tournament / Social only, including a "(🏆 WL)" tag) is a true no-op - no corruption, no bogus reply', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 1);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true); // full - queued (🏆 WL)

  const before = sock.sentMessages.length;
  const pastedEdit = formatList(groupId); // exact copy, unedited
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /No changes found/);
  assert.equal(sock.sentMessages.length, before + 1); // no repost, nothing changed
  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.length, 2); // NOT corrupted into 3 (a dropped Bao + a bogus "Bao (🏆 WL)")
  const bao = entries.find((e) => e.name === 'Bao');
  assert.ok(bao, 'expected the real "Bao" entry to still exist, not a mangled "Bao (🏆 WL)"');
  assert.equal(bao.tournamentWaitlisted, true);
  assert.equal(bao.addedBy, 'bao@s.whatsapp.net'); // original metadata intact
});

test('handleUpdate: editing who\'s listed under "🏆 Tournament" vs "Social only" actually swaps tournament membership, with a summary reply and a repost', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setTournamentEnabled(groupId, true);
  store.setTournamentLimit(groupId, 2);
  store.addEntry(groupId, 'Keith', 'keith@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Bao', 'bao@s.whatsapp.net', false, true, true);
  store.addEntry(groupId, 'Garvin', 'garvin@s.whatsapp.net', false, true, false);

  // Swap Garvin in for Bao by editing the pasted text directly.
  const pastedEdit = [
    '*Attendance* (3/6)',
    '',
    '🏆 *Tournament players* (2/2)',
    '',
    '1. Keith',
    '2. Garvin',
    '',
    'Social only',
    '',
    '3. Bao',
  ].join('\n');

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Tournament:/);
  assert.match(replies[0], /Garvin \(social only → tournament\)/);
  assert.match(replies[0], /Bao \(tournament → social only\)/);

  const entries = store.getCurrentEvent(groupId).entries;
  assert.equal(entries.find((e) => e.name === 'Garvin').tournament, true);
  assert.equal(entries.find((e) => e.name === 'Bao').tournament, false);
  assert.equal(entries.length, 3); // still all three on the list - nobody removed

  // A repost happened too (tournament-only changes still count as "changed").
  const posted = sock.sentMessages[sock.sentMessages.length - 1];
  assert.match(posted.content.text, /🏆 \*Tournament\*/);
});

// --- handleUpdate: date/location/courts/time header-block editing --------
// See lib/listParser.js's parseHeaderFields() for the parsing rules this
// exercises at the command level.

test('handleUpdate: a pasted header block above *Attendance* applies date/location/courts/time changes too, summarized alongside the roster changes', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2026-08-09', { location: 'Old Park', time: '6pm-8pm' });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);

  const pastedEdit = [
    '16th Aug Sun',
    'Noble Park',
    'Courts 11-14 (4)',
    '7pm-9pm',
    '',
    '*Attendance*',
    '',
    '1. Alex',
    '2. NewPerson',
  ].join('\n');

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Date: 9th Aug Sun → 16th Aug/);
  assert.match(replies[0], /Location: Old Park → Noble Park/);
  assert.match(replies[0], /Courts: not set → 11-14/);
  assert.match(replies[0], /Time: 6pm-8pm → 7pm-9pm/);
  assert.match(replies[0], /Added: NewPerson/);

  const event = store.getCurrentEvent(groupId);
  assert.match(event.date, /-08-16$/);
  assert.equal(event.location, 'Noble Park');
  assert.equal(event.courts, '11-14');
  assert.equal(event.courtCount, 4);
  assert.equal(event.time, '7pm-9pm');

  // Header changes count as "changed" too - a repost happened.
  const posted = sock.sentMessages[sock.sentMessages.length - 1];
  assert.match(posted.content.text, /Noble Park/);
});

test('handleUpdate: a header field left OUT of the pasted block is cleared, not left alone - "your edit is treated as final"', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2026-08-09', { location: 'Old Park', time: '6pm-8pm' });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);

  // Only date + location pasted back - courts/time omitted entirely.
  const pastedEdit = ['16th Aug Sun', 'Noble Park', '', '*Attendance*', '', '1. Alex'].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Time: 6pm-8pm → not set/);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.time, null);
  assert.equal(event.location, 'Noble Park'); // this one WAS in the block, so it's kept
});

test('handleUpdate: no header block pasted at all leaves date/location/courts/time completely untouched (backward compatible)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2026-08-09', { location: 'Old Park', time: '6pm-8pm' });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);

  const pastedEdit = ['*Attendance*', '', '1. Alex', '2. NewPerson'].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Added: NewPerson/);
  assert.doesNotMatch(replies[0], /Date:|Location:|Courts:|Time:/);
  const event = store.getCurrentEvent(groupId);
  assert.match(event.date, /-08-09$/);
  assert.equal(event.location, 'Old Park');
  assert.equal(event.time, '6pm-8pm');
});

test('handleUpdate: a pasted payment section with a customized label line updates the payment-due header, same as !paymentlabel', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-09', {}); // Alex now owes

  const pastedEdit = ['*Attendance*', '', '(empty)', '', '*Payment*', '$16 payID: 0413455423', '', '*No date*', '1. Alex'].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Payment-due header: \*Payment\* → \*\$16 payID: 0413455423\*/);
  assert.equal(store.getDuePaymentsLabel(groupId), '$16 payID: 0413455423');
});

test('handleUpdate: a payment section pasted back with NO label line (formatList()\'s own un-customized output) CLEARS an existing custom label back to the default - "your edit is final," same as date/location/courts/time', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setDuePaymentsLabel(groupId, '$16 payID: 0413455423');
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-09', {});

  const pastedEdit = ['*Attendance*', '', '(empty)', '', '*Payment*', '', '*No date*', '1. Alex'].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Payment-due header: \*\$16 payID: 0413455423\* → \*Payment\*/);
  assert.equal(store.getDuePaymentsLabel(groupId), 'Payment');
});

test('handleUpdate: no payment section pasted at all leaves the payment-due header completely untouched', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.setDuePaymentsLabel(groupId, '$16 payID: 0413455423');
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);

  const pastedEdit = ['*Attendance*', '', '1. Alex', '2. NewPerson'].join('\n');
  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.equal(store.getDuePaymentsLabel(groupId), '$16 payID: 0413455423');
});

test('handleUpdate: an over-length payment label in the paste is rejected with a note, without blocking the other changes', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-09', {});

  const tooLong = 'X'.repeat(200);
  const pastedEdit = ['*Attendance*', '', '(empty)', '', '*Payment*', tooLong, '', '*No date*', '1. Alex'].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Couldn't update the payment-due header/);
  assert.equal(store.getDuePaymentsLabel(groupId), 'Payment'); // left untouched
});

test('handleUpdate: an invalid courts value in the header block is rejected with a note, without blocking the other header/roster changes', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2026-08-09', { location: 'Old Park' });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);

  const pastedEdit = ['16th Aug Sun', 'Noble Park', 'Courts not-a-real-spec', '', '*Attendance*', '', '1. Alex'].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Couldn't update courts/);
  assert.match(replies[0], /Location: Old Park → Noble Park/);
  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courts, null); // left untouched
  assert.equal(event.location, 'Noble Park'); // this change still went through
});

test('handleUpdate: a courts change that shrinks capacity below the current headcount demotes the overflow to the waitlist, reported in the summary', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2026-08-09', {}); // no courts set yet - no limit scaling
  store.setLimit(groupId, 10);
  for (let i = 1; i <= 8; i++) store.addEntry(groupId, `P${i}`, `p${i}@s.whatsapp.net`, false);

  // 1 court -> 6-person capacity (PLAYERS_PER_COURT) - well below the 8
  // currently on Attendance, so 2 must be demoted to the waitlist.
  const pastedEdit = ['16th Aug Sun', 'Courts 1', '', '*Attendance*', '', ...Array.from({ length: 8 }, (_, i) => `${i + 1}. P${i + 1}`)].join('\n');
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.courts, '1');
  assert.equal(event.courtCount, 1);
  assert.equal(event.limit, 6);
  assert.match(replies[0], /New court count moved these to the waitlist/);
  assert.equal(event.entries.length, 6);
  assert.equal(event.waitlist.length, 2);
});

test('handleUpdate: a courts change that raises capacity above the current headcount promotes waitlisted names, notified with a mention', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2026-08-09', {});
  store.setLimit(groupId, 1);
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Jo', 'jo@s.whatsapp.net', false); // waitlisted (limit 1)

  // Attendance/Waitlist are pasted back unchanged (Alex still in, Jo still
  // waitlisted) - the point of this test is the courts/limit change alone
  // promoting Jo off the waitlist afterward (store.js's setCourts()
  // handles that automatically, same as !courts). Both sections have to
  // be included explicitly - an *Attendance*-only paste would otherwise
  // be read as "clear the waitlist entirely" by applyListUpdate, removing
  // Jo before setCourts() ever gets a chance to promote her.
  const pastedEdit = ['16th Aug Sun', 'Courts 1-2', '', '*Attendance*', '', '1. Alex', '', '*Waitlist*', '', '1. Jo'].join('\n');
  const { ctx } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: pastedEdit });
  await adminCommands.handleUpdate(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.limit, 12); // 2 courts * PLAYERS_PER_COURT (6)
  assert.deepEqual(event.entries.map((e) => e.name).sort(), ['Alex', 'Jo']);
  assert.equal(event.waitlist.length, 0);

  // Promotion is sent as its own mention-carrying message, same as !courts.
  const promotedMsg = sock.sentMessages.find((m) => m.content.mentions && m.content.mentions.length);
  assert.ok(promotedMsg, 'expected a promoted-notification message with mentions');
  assert.match(promotedMsg.content.text, /Jo/);
});

// Regression test for a real, reproduced bug: !update - even a plain typed
// one, no AI involved - spuriously reported (and applied) a date change on
// EVERY use once the list's real date fell into the past relative to
// whenever the update happened to be sent, even when the admin only
// touched the roster (e.g. renaming one person) and never edited the date
// line at all. Root cause was lib/listParser.js's parseHeaderFields()
// re-deriving the header date's year from "next upcoming occurrence from
// right now" (dates.js's plain parseDisplayDate) instead of comparing
// against the list's own already-stored date first (now
// parseDisplayDateForUpdate) - see that function's doc comment. Uses a
// stored date safely in the past (2020) so this reproduces regardless of
// whatever the real "today" happens to be when the suite runs - no fixed
// referenceDate is passed here on purpose, since commands/admin.js's real
// call site doesn't pass one either (it uses the real clock).
test('handleUpdate: copying the bot\'s own posted list back unedited except for one renamed person does NOT spuriously report (or apply) a date change, even once the list\'s date is in the past', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  store.newList(groupId, '2020-01-01', { location: 'Old Park', courts: { raw: '1-2', count: 2 }, time: '7pm-9pm' });
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Michael b', 'michael@s.whatsapp.net', false);

  const posted = formatList(groupId);
  const edited = posted.replace('Michael b', 'Michael Brown'); // the ONLY intended change

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: edited });
  await adminCommands.handleUpdate(ctx);

  assert.match(replies[0], /Added: Michael Brown/);
  assert.match(replies[0], /Removed: Michael b/);
  assert.doesNotMatch(replies[0], /Date:/); // the actual bug: this used to always appear

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.date, '2020-01-01'); // exact original year preserved, NOT bumped forward
});

test('handlePaid: marks the sender\'s own due entry paid when no name given', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // self: true - it's Alex's own entry
  store.newList(groupId, '2026-08-20', {}); // archives Alex as owing payment

  const { ctx } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', argText: '' });
  await listCommands.handlePaid(ctx);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);
});

test('handleIn: leading "paid" adds the explicit name(s) AND marks them paid, in one message', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.addEntry(groupId, 'Sam', 'sam@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // archives Alex and Sam as owing payment

  const { ctx } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', argText: 'paid Alex, Sam' });
  await listCommands.handleIn(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.deepEqual(event.entries.map((e) => e.name), ['Alex', 'Sam']);
  assert.equal(event.duePayments.length, 0); // both marked paid
});

test('handleIn: bare "!in paid" adds the sender by push name AND marks their own due entry paid by identity', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alexander', 'alex@s.whatsapp.net', false, true); // signed up under a different name last cycle (self: true - it's still Alex's own entry)
  store.newList(groupId, '2026-08-20', {}); // archives "Alexander" (by alex@s.whatsapp.net) as owing payment

  const { ctx } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: 'paid' });
  await listCommands.handleIn(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries[0].name, 'Alex'); // added under the current push name
  // Paid resolved by WhatsApp identity, not by matching "Alex" against the
  // due entry recorded as "Alexander" - this is the whole point of using
  // resolveOwnDue() instead of reusing the literal add name.
  assert.equal(event.duePayments.length, 0);
});

test('handleIn: "paid" still applies even when the add itself is a no-op (already on the list)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // self: true
  store.newList(groupId, '2026-08-20', {}); // Alex owes for the new cycle
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // already back on the new list (self: true)

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: 'paid' });
  await listCommands.handleIn(ctx);

  assert.match(replies[0], /already on the list/);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);
});

test('handleIn: a name that merely starts with "paid" (not the standalone keyword) is treated as a plain name, not a payment flag', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const { ctx } = makeCtx({ sock, groupId, senderId: 'x@s.whatsapp.net', argText: 'Paidence' });
  await listCommands.handleIn(ctx);
  assert.equal(store.getCurrentEvent(groupId).entries[0].name, 'Paidence');
});

test('handleOut: leading "paid" removes the explicit name(s) AND marks them paid, independent of the removal outcome', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex owes for the new cycle, and is NOT on the new list

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'someone@s.whatsapp.net', argText: 'paid Alex' });
  await listCommands.handleOut(ctx);

  // Removal fails (Alex isn't on the current list), but paying still goes through.
  assert.match(replies[0], /Couldn't remove/);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 0);
});

test('handleOut: bare "!out paid" removes the sender\'s own entry and marks their own due entry paid by identity', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // self: true
  store.newList(groupId, '2026-08-20', {}); // Alex owes for the new cycle
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // back on the new list too (self: true)

  const { ctx } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: 'paid' });
  await listCommands.handleOut(ctx);

  const event = store.getCurrentEvent(groupId);
  assert.equal(event.entries.length, 0);
  assert.equal(event.duePayments.length, 0);
});

test('handleOut: "!out paid" with nothing owed silently skips the paid part (no error, no reply about it)', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false, true); // self: true, so bare !out below finds it

  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: 'paid' });
  await listCommands.handleOut(ctx);

  assert.equal(store.getCurrentEvent(groupId).entries.length, 0); // removal still worked
  assert.ok(!replies.some((r) => /mark paid/i.test(r)), 'no reply should mention paying when nothing was owed');
});

test('handleIn: plain !in (no "paid") never touches duePayments', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  store.addEntry(groupId, 'Alex', 'alex@s.whatsapp.net', false);
  store.newList(groupId, '2026-08-20', {}); // Alex owes for the new cycle

  const { ctx } = makeCtx({ sock, groupId, senderId: 'alex@s.whatsapp.net', senderName: 'Alex', argText: '' });
  await listCommands.handleIn(ctx);
  assert.equal(store.getCurrentEvent(groupId).duePayments.length, 1); // untouched
});

test('handleSpamfilter: on by default, off/on toggle requires admin and always replies', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  // A fresh group - never touched !spamfilter - is already protected.
  const status = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await handleSpamfilter(status.ctx);
  assert.match(status.replies[0], /ON/);
  assert.equal(spam.isEnabled(groupId), true);

  const nonAdminTry = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: 'off' });
  await handleSpamfilter(nonAdminTry.ctx);
  assert.match(nonAdminTry.replies[0], /Only a group admin/);
  assert.equal(spam.isEnabled(groupId), true);

  const adminTurnOff = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'off' });
  await handleSpamfilter(adminTurnOff.ctx);
  assert.equal(spam.isEnabled(groupId), false);
  assert.match(adminTurnOff.replies[0], /turned \*off\*/);

  const adminTurnOn = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'on' });
  await handleSpamfilter(adminTurnOn.ctx);
  assert.equal(spam.isEnabled(groupId), true);
  assert.match(adminTurnOn.replies[0], /turned \*on\*/);
});

test('handleAi: off by default (unlike !spamfilter), off/on toggle requires admin and always replies', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  // A fresh group - never touched !ai - is off, unlike !spamfilter.
  const status = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await handleAi(status.ctx);
  assert.match(status.replies[0], /OFF/);
  assert.equal(ai.isEnabled(groupId), false);

  const nonAdminTry = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: 'on' });
  await handleAi(nonAdminTry.ctx);
  assert.match(nonAdminTry.replies[0], /Only a group admin/);
  assert.equal(ai.isEnabled(groupId), false);

  const adminTurnOn = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'on' });
  await handleAi(adminTurnOn.ctx);
  assert.equal(ai.isEnabled(groupId), true);
  assert.match(adminTurnOn.replies[0], /turned \*on\*/);

  const adminTurnOff = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: 'off' });
  await handleAi(adminTurnOff.ctx);
  assert.equal(ai.isEnabled(groupId), false);
  assert.match(adminTurnOff.replies[0], /turned \*off\*/);
});

test('adminCheck cache does not leak admin status across different groups', async () => {
  const groupA = freshGroupId();
  const groupB = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });
  // Prime the cache for groupA.
  assert.equal(await adminCheck.isGroupAdmin(sock, groupA, 'admin@s.whatsapp.net'), true);
  // A different group must be looked up independently, not assumed admin.
  assert.equal(await adminCheck.isGroupAdmin(sock, groupB, 'admin@s.whatsapp.net'), true);
  assert.equal(await adminCheck.isGroupAdmin(sock, groupB, 'stranger@s.whatsapp.net'), false);
});

// --- !help / !tips / !admin / !admintips -----------------------------------
// !tips/!admintips are the further split-out "caveats" companions to
// !help/!admin - see commands/help.js's file-level doc comment. Anyone can
// view !help/!tips; !admin/!admintips are admin-gated, same reasoning
// (their content is only useful to an admin anyway).

test('handleHelp: anyone can view it, points to !tips for the caveats, and does not include the tips content itself', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await handleHelp(ctx);
  assert.match(replies[0], /!tips/);
  assert.doesNotMatch(replies[0], /Prefer plain English/); // that's TIPS_TEXT content now, not HELP_TEXT's
});

test('handleTips: anyone can view it, and it contains the everyday caveats formerly inline in !help', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({});
  const { ctx, replies } = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await handleTips(ctx);
  assert.match(replies[0], /Prefer plain English/);
  assert.match(replies[0], /bringing unnamed friends/i);
});

test('handleAdminHelp: only an admin can view it, and it points to !admintips for the caveats', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const nonAdmin = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: '' });
  await handleAdminHelp(nonAdmin.ctx);
  assert.match(nonAdmin.replies[0], /Only a group admin/);

  const admin = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await handleAdminHelp(admin.ctx);
  assert.match(admin.replies[0], /!admintips/);
  assert.doesNotMatch(admin.replies[0], /reads back a copy-pasted/); // that's ADMIN_TIPS_TEXT content now
});

test('handleAdminTips: only an admin can view it, and it contains the admin caveats formerly inline in !admin', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const nonAdmin = makeCtx({ sock, groupId, senderId: 'nobody@s.whatsapp.net', argText: '' });
  await handleAdminTips(nonAdmin.ctx);
  assert.match(nonAdmin.replies[0], /Only a group admin/);

  const admin = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await handleAdminTips(admin.ctx);
  assert.match(admin.replies[0], /reads back a copy-pasted/);
  assert.match(admin.replies[0], /undo reverses/i);
});

test('the real dispatch table routes !tips and !admintips to their handlers', async () => {
  const groupId = freshGroupId();
  const sock = createFakeSock({ admins: ['admin@s.whatsapp.net'] });

  const tips = makeCtx({ sock, groupId, senderId: 'anyone@s.whatsapp.net', argText: '' });
  await commands['!tips'](tips.ctx);
  assert.match(tips.replies[0], /Prefer plain English/);

  const adminTips = makeCtx({ sock, groupId, senderId: 'admin@s.whatsapp.net', argText: '' });
  await commands['!admintips'](adminTips.ctx);
  assert.match(adminTips.replies[0], /reads back a copy-pasted/);
});