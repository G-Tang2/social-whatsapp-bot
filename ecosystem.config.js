// pm2 process definition for running the bot locally as a background process.
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save
// See README.md "Run on your own computer" section for the full setup,
// including making pm2 auto-start on boot.
//
// Two apps, matching the stable/unstable split (see this directory's own
// .env comment header, and ..\social-whatsapp-bot-stable's): 'unstable'
// runs THIS checkout (the `main` branch, wherever it currently is) against
// its own test group; 'stable' runs the sibling worktree checked out on the
// `stable` branch (pinned to whatever commit was last promoted) against the
// real group. Each has its own cwd, so each picks up its own .env/
// auth_info/data - see lib/config.js/store.js for why those default to
// paths relative to `cwd` rather than anything shared between the two.
// Run `pm2 start ecosystem.config.js` from THIS directory to bring up both
// at once; the stable worktree's own (older, frozen-at-f6b5a2a) copy of
// this file still works too if you ever want to start just that one
// standalone from inside it - its app name ('whatsapp-list-bot') doesn't
// collide with either name below.

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'whatsapp-list-bot-unstable',
      script: 'index.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000, // wait 5s before restarting after a crash
      max_restarts: 20,
      min_uptime: '30s', // don't count a restart against max_restarts unless it crashed within 30s
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'whatsapp-list-bot-stable',
      script: 'index.js',
      cwd: path.join(__dirname, '..', 'social-whatsapp-bot-stable'),
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: '30s',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
