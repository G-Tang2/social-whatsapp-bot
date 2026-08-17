// test/lastSeenStatus.test.js
// Direct unit coverage for lib/lastSeenStatus.js. formatLastSeenStatus() is
// pure (fixed Date + fixed timezone + fixed interval in, string out), so
// it's tested without any fake socket - see test/e2e.test.js for coverage
// of the real setInterval/connection wiring in index.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatLastSeenStatus, updateLastSeenStatus } = require('../lib/lastSeenStatus');

test('formatLastSeenStatus renders "D Mon YYYY, H:MM AM/PM [updates every N minutes]" in the given timezone', () => {
  const date = new Date('2026-08-14T07:45:00Z');
  assert.equal(formatLastSeenStatus(date, 'Australia/Sydney', 5), 'Last seen: 14 Aug 2026, 5:45 PM [updates every 5 minutes]');
  assert.equal(formatLastSeenStatus(date, 'UTC', 5), 'Last seen: 14 Aug 2026, 7:45 AM [updates every 5 minutes]');
});

test('formatLastSeenStatus does not zero-pad the day or the hour', () => {
  const date = new Date('2026-01-05T23:05:00Z'); // 5th of the month, single-digit hour in UTC (11:05 PM -> but check a single-digit hour case below)
  assert.equal(formatLastSeenStatus(date, 'UTC', 5), 'Last seen: 5 Jan 2026, 11:05 PM [updates every 5 minutes]');

  const singleDigitHour = new Date('2026-01-05T09:05:00Z');
  assert.equal(formatLastSeenStatus(singleDigitHour, 'UTC', 5), 'Last seen: 5 Jan 2026, 9:05 AM [updates every 5 minutes]');
});

test('formatLastSeenStatus still zero-pads minutes', () => {
  const date = new Date('2026-08-14T07:05:00Z');
  assert.equal(formatLastSeenStatus(date, 'UTC', 5), 'Last seen: 14 Aug 2026, 7:05 AM [updates every 5 minutes]');
});

test('formatLastSeenStatus uses singular "minute" for an interval of exactly 1, and reflects whatever interval is passed rather than hardcoding 5', () => {
  const date = new Date('2026-08-14T07:05:00Z');
  assert.match(formatLastSeenStatus(date, 'UTC', 1), /\[updates every 1 minute\]$/);
  assert.match(formatLastSeenStatus(date, 'UTC', 15), /\[updates every 15 minutes\]$/);
});

test('updateLastSeenStatus calls sock.updateProfileStatus with the formatted text, including the interval suffix', async () => {
  const calls = [];
  const fakeSock = { updateProfileStatus: async (status) => calls.push(status) };
  await updateLastSeenStatus(fakeSock);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^Last seen: \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} (AM|PM) \[updates every \d+(\.\d+)? minutes?\]$/);
});

test('updateLastSeenStatus is a safe no-op when sock is null (briefly true between a disconnect and reconnect)', async () => {
  await assert.doesNotReject(() => updateLastSeenStatus(null));
});

test('updateLastSeenStatus logs and swallows the error instead of throwing/rejecting if updateProfileStatus fails', async () => {
  const fakeSock = { updateProfileStatus: async () => { throw new Error('network blip'); } };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await assert.doesNotReject(() => updateLastSeenStatus(fakeSock));
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some((line) => /Failed to update WhatsApp About\/status text/.test(line)));
});
