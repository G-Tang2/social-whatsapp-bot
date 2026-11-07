// lib/paymentReminder.js
// Reminds the group about outstanding payments whenever a fresh list is
// started - see commands/admin.js's handleNewlist and
// lib/scheduledListAdvance.js's advanceToFreshList (the auto-newlist/
// cancelled-resume schedulers), the only two places store.js's newList()
// is ever actually called from.
//
// Real request: `duePayments` already tracks exactly who owes money and
// since when (`owedSince`), but nothing ever proactively reminds anyone -
// an admin has to notice and chase people manually. This closes that gap
// the same way lib/vacancyReminder.js already closes the "nobody's signed
// up yet" gap: automatically, tagging the people it actually concerns.
//
// Anyone owed money for 7+ days gets @-mentioned, and the SAME debt gets
// reminded again every 7 days after that (not just once) for as long as
// it stays unpaid - tracked via each duePayments entry's own
// `remindedAt` (store.js's markDuePaymentsReminded() sets it the first
// time this fires for that entry; every later check compares against
// THAT instead of `owedSince`, so the 7-day clock restarts from the last
// reminder, not from the original debt date, every time).
//
// Deliberately hooked into "a fresh list was just created" rather than
// a separate always-running periodic timer (unlike vacancy reminders) -
// a group's list cycle is already roughly weekly on its own, so this
// piggybacks on that natural checkpoint instead of adding a second
// interval for what would really be the same cadence anyway.
//
// Entries with no `owedSince` at all (predates that field, or a debt
// added manually via !update with no date attached) are skipped
// entirely - there's no age to compute a 7-day threshold from, same
// "can't act without the data" skip every other date-dependent feature
// in this codebase already follows (e.g. lib/vacancyReminder.js's
// unparseable !time).

const { getCurrentEvent, markDuePaymentsReminded } = require('../store');
const { buildTaggedRosterMessage } = require('./helpers');

const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Exported (alongside the real entry point below) purely so test/
// paymentReminder.test.js can exercise the actual date-threshold logic
// directly, with a controlled `now`/entry, rather than needing a full
// store.js round-trip (and real wall-clock waiting) for every edge case.
function isDueForReminder(entry, now) {
  if (!entry.owedSince) return false;
  const since = entry.remindedAt || entry.owedSince;
  return now - new Date(since).getTime() >= REMINDER_INTERVAL_MS;
}

// Called right after newList() starts a fresh cycle (see the file-level
// comment above for both call sites) - checks the group's CARRIED-
// FORWARD duePayments (newList() has already merged the outgoing
// cycle's new debts into it by the time this runs) and sends one
// combined tagged reminder for everyone who currently qualifies, if
// anyone does. A brand new debt from the cycle that just ended is never
// old enough to qualify on this very check - only genuinely outstanding
// ones from before are.
async function checkPaymentReminders(sock, groupId) {
  if (!sock) return;
  const event = getCurrentEvent(groupId);
  const now = Date.now();
  const due = (event.duePayments || []).filter((entry) => isDueForReminder(entry, now));
  if (!due.length) return;

  const message = buildTaggedRosterMessage(due, "💸 Friendly reminder - still waiting on payment from a little while back!");
  if (!message) return;

  try {
    await sock.sendMessage(groupId, { text: message.text, mentions: message.mentions });
    markDuePaymentsReminded(groupId, due);
  } catch (err) {
    console.error(`[paymentReminder] Failed to send the payment reminder in ${groupId}:`, err.message);
  }
}

module.exports = { checkPaymentReminders, isDueForReminder, REMINDER_INTERVAL_MS };
