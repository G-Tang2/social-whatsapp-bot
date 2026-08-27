// list-groups.js
// One-off utility: connects using the bot's existing linked WhatsApp session
// and prints every group that account is a member of, with its JID - so you
// can find a group's JID without having to send a message in it first.
//
// Usually you don't need this: once the bot is actually RUNNING, just send
// any command in the target group and its JID shows up on its own - either
// in the console log, or via `node manage-groups.js list` (which also lets
// you approve it right then, with no restart - see that file's own doc
// comment and the README's "Adding the bot to a new group" section). This
// script is for the narrower case where you want a group's JID WITHOUT
// sending anything there first (e.g. picking one out of many the account is
// already in).
//
// Usage:
//   node list-groups.js
//
// Run this AFTER you've linked once via `npm start` (so auth_info already
// exists). Don't run it at the same time as the main bot (index.js) - only
// one process can use the linked session at a time. Stop the bot first
// (including `pm2 stop whatsapp-list-bot` if you've set that up), run this,
// then start the bot again.

const path = require('path');
require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr } = update;

    if (qr) {
      console.log('\n[list-groups] No linked session found yet - scan this QR code first:\n');
      qrcode.generate(qr, { small: true });
      return;
    }

    if (connection === 'open') {
      console.log('[list-groups] Connected. Fetching your groups...\n');
      try {
        const groups = await sock.groupFetchAllParticipating();
        const entries = Object.values(groups);

        if (!entries.length) {
          console.log('No groups found - make sure the linked account is a member of the group you want.');
        } else {
          entries
            .sort((a, b) => a.subject.localeCompare(b.subject))
            .forEach((g) => {
              console.log(`${g.subject}\n  JID: ${g.id}\n`);
            });
          console.log(`(${entries.length} group${entries.length === 1 ? '' : 's'} total)`);
          console.log('\nApprove the JID(s) you want with: node manage-groups.js approve <jid>');
        }
      } catch (err) {
        console.error('[list-groups] Failed to fetch groups:', err.message);
      }
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error('[list-groups] Fatal error:', err);
  process.exit(1);
});
