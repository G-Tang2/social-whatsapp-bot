// manage-groups.js
// Approve, remove, or list the groups the bot moderates - reads/writes
// data/allowedGroups.json directly (see lib/allowedGroups.js), the SAME
// file the running bot itself reads fresh on every message. No WhatsApp
// connection here at all, so unlike list-groups.js this needs no QR scan
// and does NOT need the bot stopped first - run it alongside a live bot
// and the change takes effect on the very next message, no restart.
//
// Usage:
//   node manage-groups.js list
//     Shows currently approved groups, and any "pending" ones - groups the
//     bot has seen an actual command in but isn't approved for yet (see
//     index.js's recordPendingGroup call site). That's how you find a new
//     group's JID without digging through console logs or running
//     list-groups.js (which needs the bot stopped).
//
//   node manage-groups.js approve <jid>
//     Starts moderating <jid> - e.g. a JID copied from the pending list
//     above. Takes effect immediately, no restart.
//
//   node manage-groups.js remove <jid>
//     Stops moderating <jid> - also immediate, no restart. Doesn't touch
//     the group's actual list data (see store.js) - only whether the bot
//     acts on messages there; re-approving later picks up right where it
//     left off.

const { getApprovedGroups, getPendingGroups, approveGroup, removeGroup } = require('./lib/allowedGroups');

function printList() {
  const approved = getApprovedGroups();
  const pending = getPendingGroups();

  console.log(`Approved groups (${approved.length}):`);
  if (!approved.length) {
    console.log('  (none yet)');
  } else {
    approved.forEach((jid) => console.log(`  ${jid}`));
  }

  console.log(`\nPending groups (${pending.length}) - seen a command, not yet approved:`);
  if (!pending.length) {
    console.log('  (none)');
  } else {
    pending.forEach((g) => {
      const subject = g.subject || '(unknown name)';
      console.log(`  ${subject}\n    JID: ${g.jid}\n    First seen: ${g.firstSeenAt}\n    Last seen:  ${g.lastSeenAt}`);
    });
    console.log('\nApprove one with: node manage-groups.js approve <jid>');
  }
}

function printUsage() {
  console.log('Usage:');
  console.log('  node manage-groups.js list');
  console.log('  node manage-groups.js approve <jid>');
  console.log('  node manage-groups.js remove <jid>');
}

function main() {
  const [, , cmd, jid] = process.argv;

  if (!cmd || cmd === 'list') {
    printList();
    return;
  }

  if (cmd === 'approve') {
    if (!jid) {
      console.error('Missing <jid>. Usage: node manage-groups.js approve <jid>');
      process.exitCode = 1;
      return;
    }
    const result = approveGroup(jid);
    if (result.ok) {
      console.log(`Approved ${jid} - the bot will start moderating it on its next message, no restart needed.`);
    } else {
      console.log(`${jid} is already approved - nothing to do.`);
    }
    return;
  }

  if (cmd === 'remove') {
    if (!jid) {
      console.error('Missing <jid>. Usage: node manage-groups.js remove <jid>');
      process.exitCode = 1;
      return;
    }
    const result = removeGroup(jid);
    if (result.ok) {
      console.log(`Removed ${jid} - the bot will stop moderating it immediately. Its list data is untouched; re-approving picks up where it left off.`);
    } else {
      console.log(`${jid} isn't currently approved - nothing to do.`);
    }
    return;
  }

  console.error(`Unknown command "${cmd}".\n`);
  printUsage();
  process.exitCode = 1;
}

main();
