// test/catchUp.test.js
// Direct unit coverage for lib/catchUpSummary.js (pure formatting) and
// lib/catchUpQueue.js (buffering/debounce/flush), separate from the
// higher-level e2e batching test in test/e2e.test.js which exercises the
// whole pipeline through index.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-catchup-test-'));
process.env.DATA_DIR = tmpDir;
// Short flush delay so the buffering tests below don't wait several real
// seconds - see lib/config.js for the real (5s) default.
process.env.CATCH_UP_FLUSH_DELAY_SECONDS = '0.15';

const { buildCatchUpSummary } = require('../lib/catchUpSummary');
const { bufferCatchUpResult, setBacklogSynced, resumePendingFlushes } = require('../lib/catchUpQueue');
const store = require('../store');

let groupCounter = 0;
function freshGroupId() {
  groupCounter += 1;
  return `catchup-test-${groupCounter}@g.us`;
}

test('buildCatchUpSummary returns null for an empty batch', () => {
  assert.equal(buildCatchUpSummary([]), null);
  assert.equal(buildCatchUpSummary(null), null);
});

test('buildCatchUpSummary describes a successful !in, !out, and !paid', () => {
  const summary = buildCatchUpSummary([
    { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] },
    { command: 'out', senderName: 'sam', removed: ['Sam'], rejected: [], flagged: [], promoted: [] },
    { command: 'paid', senderName: 'jo', paid: ['Jo'], rejected: [] },
  ]);
  assert.match(summary.text, /Caught up on 3 messages sent while I was offline/);
  // Each line: leading bullet, bolded (WhatsApp `*...*` markdown) command name.
  assert.match(summary.text, /• \*!in\* \(alex\): added Alex/);
  assert.match(summary.text, /• \*!out\* \(sam\): removed Sam/);
  assert.match(summary.text, /• \*!paid\* \(jo\): marked paid: Jo/);
  assert.deepEqual(summary.mentions, []);
});

// Locks in the exact shape of the formatted message (not just substring
// matches): header, blank line, then one bulleted+bolded-command line per
// entry with no bullet/bold on the header itself.
test('buildCatchUpSummary produces the exact bulleted, bold-command text layout', () => {
  const summary = buildCatchUpSummary([
    { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] },
    { command: 'out', senderName: 'sam', removed: ['Sam'], rejected: [], flagged: [], promoted: [] },
  ]);
  assert.equal(
    summary.text,
    'Caught up on 2 messages sent while I was offline:\n\n'
      + '• *!in* (alex): added Alex\n'
      + '• *!out* (sam): removed Sam'
  );
});

test('buildCatchUpSummary uses singular wording for exactly one entry', () => {
  const summary = buildCatchUpSummary([{ command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] }]);
  assert.match(summary.text, /Caught up on 1 message sent while I was offline/);
});

test('buildCatchUpSummary covers the no-op branches (already on list, no entry, ambiguous, too many names)', () => {
  const summary = buildCatchUpSummary([
    { command: 'in', senderName: 'a', alreadyOn: ['A'] },
    { command: 'out', senderName: 'b', noEntry: true },
    { command: 'paid', senderName: 'c', ambiguous: ['C1', 'C2'] },
    { command: 'in', senderName: 'd', tooMany: true },
  ]);
  assert.match(summary.text, /• \*!in\* \(a\): already on the list as "A" - nothing to do/);
  assert.match(summary.text, /• \*!out\* \(b\): no entry found for them - skipped/);
  assert.match(summary.text, /• \*!paid\* \(c\): had more than one entry on the payment-due list, ambiguous - skipped/);
  assert.match(summary.text, /• \*!in\* \(d\): too many names in one command - skipped/);
});

test('buildCatchUpSummary reflects a trailing "paid" keyword caught up on !in/!out (see commands/list.js runPaidIfFlagged)', () => {
  const summary = buildCatchUpSummary([
    { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [], paid: ['Alex'], paidRejected: [], paidAmbiguous: null },
    { command: 'out', senderName: 'sam', removed: ['Sam'], rejected: [], flagged: [], promoted: [], paid: [], paidRejected: ['Sam - not on the payment-due list'], paidAmbiguous: null },
  ]);
  assert.match(summary.text, /• \*!in\* \(alex\): added Alex; marked paid: Alex/);
  assert.match(summary.text, /• \*!out\* \(sam\): removed Sam; couldn't mark paid: Sam - not on the payment-due list/);
});

test('buildCatchUpSummary reflects a caught-up "paid" combo even when the !in/!out half was a no-op (already on / no entry)', () => {
  const summary = buildCatchUpSummary([
    { command: 'in', senderName: 'alex', alreadyOn: ['Alex'], paid: ['Alex'], paidRejected: [], paidAmbiguous: null },
    { command: 'out', senderName: 'sam', noEntry: true, paid: [], paidRejected: [], paidAmbiguous: ['Sam1', 'Sam2'] },
  ]);
  assert.match(summary.text, /• \*!in\* \(alex\): already on the list as "Alex"; marked paid: Alex/);
  assert.match(summary.text, /• \*!out\* \(sam\): no entry found for them; payment-due entry ambiguous: Sam1, Sam2/);
});

// Locks in that the pre-existing (no "paid" keyword) no-op text is
// unchanged - the new paid-aware branches above must not alter this when
// there's no paid data on the entry at all (see the "buildCatchUpSummary
// covers the no-op branches" test above, which already asserts this
// exact text without any paid fields present).

test('buildCatchUpSummary collects mentions from promoted entries, deduped, without duplicate lines', () => {
  const summary = buildCatchUpSummary([
    {
      command: 'out',
      senderName: 'admin',
      removed: ['Alex'],
      rejected: [],
      flagged: [],
      promoted: [
        { name: 'Sam', addedBy: 'sam@s.whatsapp.net' },
        { name: 'Jo', addedBy: 'sam@s.whatsapp.net' }, // same adder as above - addedBy should only appear once in mentions
      ],
    },
  ]);
  assert.deepEqual(summary.mentions, ['sam@s.whatsapp.net']);
  assert.match(summary.text, /promoted off the waitlist: @sam \(Sam\), @sam \(Jo\)/);
});

test('bufferCatchUpResult debounces: rapid entries for the same group flush together, once', async () => {
  const groupId = freshGroupId();
  const sent = [];
  const fakeSock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: {} }; } };
  const getSock = () => fakeSock;

  bufferCatchUpResult(groupId, getSock, { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] });
  bufferCatchUpResult(groupId, getSock, { command: 'in', senderName: 'sam', added: ['Sam'], waitlisted: [], rejected: [] });

  // Immediately after buffering, nothing should have been sent yet.
  assert.equal(sent.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 300));

  // One combined summary + one list post - not one pair per buffered entry.
  assert.equal(sent.length, 2);
  assert.match(sent[0].content.text, /Caught up on 2 messages sent while I was offline/);
  assert.match(sent[0].content.text, /added Alex/);
  assert.match(sent[0].content.text, /added Sam/);
});

test('bufferCatchUpResult keeps different groups\' batches independent', async () => {
  const groupA = freshGroupId();
  const groupB = freshGroupId();
  const sentA = [];
  const sentB = [];
  const fakeSockA = { sendMessage: async (jid, content) => { sentA.push({ jid, content }); return { key: {} }; } };
  const fakeSockB = { sendMessage: async (jid, content) => { sentB.push({ jid, content }); return { key: {} }; } };

  bufferCatchUpResult(groupA, () => fakeSockA, { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] });
  bufferCatchUpResult(groupB, () => fakeSockB, { command: 'paid', senderName: 'jo', paid: ['Jo'], rejected: [] });

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(sentA.length, 2);
  assert.match(sentA[0].content.text, /added Alex/);
  assert.equal(sentB.length, 2);
  assert.match(sentB[0].content.text, /marked paid: Jo/);
});

test('bufferCatchUpResult logs (without throwing) and keeps the batch buffered for a retry if no live socket is available at flush time', async () => {
  const groupId = freshGroupId();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  const sent = [];
  try {
    bufferCatchUpResult(groupId, () => null, { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(logged.some((line) => /will retry once reconnected/.test(line)));

    // Not dropped - a later resumePendingFlushes() with a real socket
    // should still deliver it.
    const fakeSock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: {} }; } };
    resumePendingFlushes(() => fakeSock);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    console.error = originalError;
  }
  assert.equal(sent.length, 2);
  assert.match(sent[0].content.text, /added Alex/);
});

// Regression coverage for a real incident: WhatsApp redelivered an offline
// backlog across two separate bursts with a gap longer than the (5s
// default, 0.15s in this file) quiet-period delay - so the OLD
// timer-only logic flushed on the first burst alone, splitting one
// reconnect's catch-up commands into two separate summary messages
// instead of one. setBacklogSynced(false)/(true) (driven by Baileys'
// receivedPendingNotifications in index.js) now gates the actual send: a
// quiet period elapsing while the backlog is still mid-sync just holds the
// batch open instead of flushing a partial one.
test('bufferCatchUpResult holds the flush open past the quiet-period timer while backlogSynced is false, even across two separate bursts', async () => {
  const groupId = freshGroupId();
  const sent = [];
  const fakeSock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: {} }; } };
  const getSock = () => fakeSock;

  try {
    setBacklogSynced(false); // a reconnect just started - WhatsApp is about to redeliver the backlog

    bufferCatchUpResult(groupId, getSock, { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] });
    await new Promise((resolve) => setTimeout(resolve, 300)); // well past the 0.15s quiet-period delay
    assert.equal(sent.length, 0, 'must not flush a partial batch while the backlog is still mid-sync');

    // Second burst arrives late (simulating WhatsApp's redelivery landing
    // in two separate waves) - still before sync completes.
    bufferCatchUpResult(groupId, getSock, { command: 'paid', senderName: 'sam', paid: ['Sam'], rejected: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sent.length, 0, 'still must not flush - backlogSynced has not been signaled true yet');

    setBacklogSynced(true); // WhatsApp confirms the backlog is now fully redelivered
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(sent.length, 2, 'expected exactly one combined summary + one list post, covering BOTH bursts');
    assert.match(sent[0].content.text, /Caught up on 2 messages sent while I was offline/);
    assert.match(sent[0].content.text, /added Alex/);
    assert.match(sent[0].content.text, /marked paid: Sam/);
  } finally {
    setBacklogSynced(true); // reset shared module state so later tests in this file see the normal (timer-only) behavior
  }
});

test('bufferCatchUpResult still flushes on the quiet-period timer alone when backlogSynced is (the default) true', async () => {
  const groupId = freshGroupId();
  const sent = [];
  const fakeSock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: {} }; } };

  bufferCatchUpResult(groupId, () => fakeSock, { command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sent.length, 2, 'with backlogSynced left at its default (true), the plain quiet-period timer alone is enough to flush');
});

// The actual bug report this persistence exists to fix: a batch buffered
// right before the whole bot PROCESS restarts (not just a socket reconnect
// within the same process - a crash, `pm2 restart`, a host reboot) used to
// vanish along with the in-memory-only `buffers` Map, so nobody ever saw
// the "here's what you missed" summary even though the underlying !in/!out
// commands had already gone through. Simulates a restart by evicting
// lib/catchUpQueue.js from Node's module cache and re-requiring it (which
// re-runs its module-load-time loadPersisted() against the same on-disk
// DATA_DIR, same as a fresh process would) and confirms the batch is still
// there and still gets sent once the new "process" has a live socket.
test('a pending batch survives a simulated process restart (persisted to disk, then flushed after resumePendingFlushes)', async () => {
  const groupId = freshGroupId();
  const catchUpQueuePath = require.resolve('../lib/catchUpQueue');

  // getSock deliberately returns null here - the realistic case this
  // guards against is the process dying before it ever gets a chance to
  // flush through a live socket at all.
  bufferCatchUpResult(groupId, () => null, {
    command: 'in', senderName: 'alex', added: ['Alex'], waitlisted: [], rejected: [],
  });

  // Persisted synchronously as part of bufferCatchUpResult() itself - no
  // need to wait for the flush timer to confirm it landed on disk.
  const persistedRaw = fs.readFileSync(path.join(tmpDir, 'catchup_queue.json'), 'utf8');
  const persisted = JSON.parse(persistedRaw);
  assert.ok(Array.isArray(persisted[groupId]) && persisted[groupId].length === 1);

  // Simulate the process restarting: throw away this module's in-memory
  // state entirely and re-require it fresh.
  delete require.cache[catchUpQueuePath];
  const fresh = require('../lib/catchUpQueue');

  const sent = [];
  const fakeSock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: {} }; } };
  fresh.resumePendingFlushes(() => fakeSock);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(sent.length, 2, 'the batch buffered before the "restart" should still reach the group afterward');
  assert.match(sent[0].content.text, /Caught up on 1 message sent while I was offline/);
  assert.match(sent[0].content.text, /added Alex/);

  const persistedAfter = JSON.parse(fs.readFileSync(path.join(tmpDir, 'catchup_queue.json'), 'utf8'));
  assert.equal(persistedAfter[groupId], undefined, 'cleared from disk once successfully sent');
});

// Sanity check that store.js itself is untouched by this batching layer -
// catch-up commands' actual list mutations happen synchronously inside the
// command handler (see commands/list.js), independent of when/whether the
// summary message gets sent.
test('store mutations from a catch-up command are immediate, independent of the summary flush timing', () => {
  const groupId = freshGroupId();
  const result = store.addEntry(groupId, 'Immediate', 'x@s.whatsapp.net', false);
  assert.equal(result.ok, true);
  assert.equal(store.getCurrentEvent(groupId).entries.length, 1);
});
