// pm2 process definition for running the bot locally as a background process.
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save
// See README.md "Run on your own computer" section for the full setup,
// including making pm2 auto-start on boot.
//
// If you run a SECOND copy of this bot from another folder on the same
// machine (a different WhatsApp session/group), give that copy's own
// ecosystem.config.js a DIFFERENT `name` below before starting it under
// pm2 - pm2's process list/names are global to the whole machine, not
// scoped per folder, so two copies both named 'whatsapp-list-bot' collide:
// starting the second one doesn't create an independent process, it makes
// pm2 treat it as (re)starting the SAME app, now pointed at the second
// folder's `cwd` - which can silently break the first instance rather than
// running both side by side.

module.exports = {
  apps: [
    {
      name: 'whatsapp-list-bot',
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
  ],
};
