// lib/catchUpSummary.js
// Formats the batch of outcomes from !in/!out/!paid commands caught up
// after a reconnect (see lib/catchUpQueue.js) into ONE combined "here's
// what happened while I was offline" message, instead of the group seeing
// each individual command's own reply/list-repost as it's processed.
//
// Each outcome object comes straight from the `return` value of
// commands/list.js's handleIn/handleOut/handlePaid - see that file for the
// exact shape of each. This module only reads/formats them; it doesn't
// mutate any state.

// Each describe* function returns one line's worth of text, WITHOUT the
// leading bullet - buildCatchUpSummary() adds that uniformly below, once,
// rather than each function repeating it. The command name itself is
// wrapped in WhatsApp's `*bold*` markdown so it stands out from the
// surrounding sentence at a glance when scanning a multi-entry summary.
// Describes a leading "paid" keyword's outcome (see commands/list.js's
// runPaidIfFlagged) as extra `parts` entries, shared by describeIn() and
// describeOut() below - !in/!out gained the ability to also mark someone
// paid in the same message, so their catch-up summary line needs to
// reflect that too, not just !paid's own dedicated summary line.
// Deliberately returns [] (not a "nothing to do" placeholder) when there's
// no paid data at all, so callers can tell "no paid keyword was used" (the
// original, still-common case) apart from "paid was used but resolved to
// nothing" - the two are worded differently by each caller below.
function paidSummaryParts(entry) {
  const parts = [];
  if (entry.paid && entry.paid.length) parts.push(`marked paid: ${entry.paid.join(', ')}`);
  if (entry.paidRejected && entry.paidRejected.length) parts.push(`couldn't mark paid: ${entry.paidRejected.join('; ')}`);
  if (entry.paidAmbiguous && entry.paidAmbiguous.length) parts.push(`payment-due entry ambiguous: ${entry.paidAmbiguous.join(', ')}`);
  return parts;
}

function describeIn(entry) {
  if (entry.tooMany) {
    return `*!in* (${entry.senderName}): too many names in one command - skipped`;
  }
  const paidParts = paidSummaryParts(entry);
  if (entry.alreadyOn) {
    const base = `already on the list as "${entry.alreadyOn.join('", "')}"`;
    const parts = paidParts.length ? [base, ...paidParts] : [`${base} - nothing to do`];
    return `*!in* (${entry.senderName}): ${parts.join('; ')}`;
  }
  const parts = [];
  if (entry.added && entry.added.length) parts.push(`added ${entry.added.join(', ')}`);
  if (entry.waitlisted && entry.waitlisted.length) parts.push(`waitlisted ${entry.waitlisted.join(', ')}`);
  if (entry.rejected && entry.rejected.length) parts.push(`couldn't add: ${entry.rejected.join('; ')}`);
  parts.push(...paidParts);
  if (!parts.length) parts.push('nothing to do');
  return `*!in* (${entry.senderName}): ${parts.join('; ')}`;
}

function describeOut(entry) {
  if (entry.tooMany) {
    return `*!out* (${entry.senderName}): too many names in one command - skipped`;
  }
  const paidParts = paidSummaryParts(entry);
  if (entry.noEntry) {
    const parts = paidParts.length ? ['no entry found for them', ...paidParts] : ['no entry found for them - skipped'];
    return `*!out* (${entry.senderName}): ${parts.join('; ')}`;
  }
  if (entry.ambiguous) {
    const parts = paidParts.length ? ['had more than one entry, ambiguous', ...paidParts] : ['had more than one entry, ambiguous - skipped'];
    return `*!out* (${entry.senderName}): ${parts.join('; ')}`;
  }
  const parts = [];
  if (entry.removed && entry.removed.length) parts.push(`removed ${entry.removed.join(', ')}`);
  if (entry.rejected && entry.rejected.length) parts.push(`not on the list: ${entry.rejected.join('; ')}`);
  if (entry.flagged && entry.flagged.length) parts.push(`pending admin review, flagged (TBC): ${entry.flagged.join('; ')}`);
  if (entry.promoted && entry.promoted.length) {
    // Same "@number — name" shape as the live promotion message (see
    // lib/helpers.js's formatPromotedMessage) - the summary's `mentions`
    // array alone gets someone a notification ping, but WhatsApp only
    // renders/highlights an actual visible @tag where the message text
    // itself contains "@<number>". Without this, a promotion caught up in
    // a reconnect summary silently wasn't tagged the way a live one is.
    const tagged = entry.promoted.map((e) => `@${e.addedBy.split('@')[0]} (${e.name})`).join(', ');
    parts.push(`promoted off the waitlist: ${tagged}`);
  }
  parts.push(...paidParts);
  if (!parts.length) parts.push('nothing to do');
  return `*!out* (${entry.senderName}): ${parts.join('; ')}`;
}

function describePaid(entry) {
  if (entry.noEntry) {
    return `*!paid* (${entry.senderName}): not on the payment-due list - skipped`;
  }
  if (entry.ambiguous) {
    return `*!paid* (${entry.senderName}): had more than one entry on the payment-due list, ambiguous - skipped`;
  }
  if (entry.tooMany) {
    return `*!paid* (${entry.senderName}): too many names in one command - skipped`;
  }
  const parts = [];
  if (entry.paid && entry.paid.length) parts.push(`marked paid: ${entry.paid.join(', ')}`);
  if (entry.rejected && entry.rejected.length) parts.push(`not on the payment-due list: ${entry.rejected.join('; ')}`);
  if (!parts.length) parts.push('nothing to do');
  return `*!paid* (${entry.senderName}): ${parts.join('; ')}`;
}

function describeEntry(entry) {
  if (entry.command === 'in') return describeIn(entry);
  if (entry.command === 'out') return describeOut(entry);
  if (entry.command === 'paid') return describePaid(entry);
  return null; // unrecognized shape - shouldn't happen, but don't blow up the whole summary over it
}

// Builds { text, mentions } for the whole batch of catch-up outcomes, in
// the order they were processed. `mentions` collects everyone who needs an
// actual WhatsApp @mention to be notified (people promoted off the
// waitlist during the batch) - folded into this one message rather than
// each getting their own separate tagged message, same "one message, not
// a burst" goal as the rest of this feature. Returns null if there's
// nothing to say (empty batch, or every entry somehow produced no
// description) - callers should treat that as "don't send anything".
function buildCatchUpSummary(entries) {
  if (!entries || !entries.length) return null;

  const lines = entries.map(describeEntry).filter(Boolean);
  if (!lines.length) return null;

  const mentions = [];
  for (const entry of entries) {
    if (entry.promoted && entry.promoted.length) {
      for (const p of entry.promoted) {
        if (!mentions.includes(p.addedBy)) mentions.push(p.addedBy);
      }
    }
  }

  const header = entries.length === 1
    ? 'Caught up on 1 message sent while I was offline:'
    : `Caught up on ${entries.length} messages sent while I was offline:`;

  // Leading bullet on every line, added here (once) rather than inside each
  // describe* function above, so the bullet formatting stays in exactly one
  // place regardless of how many command types exist.
  const bulletedLines = lines.map((line) => `• ${line}`);

  return {
    text: `${header}\n\n${bulletedLines.join('\n')}`,
    mentions,
  };
}

module.exports = { buildCatchUpSummary };