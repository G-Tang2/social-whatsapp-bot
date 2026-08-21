// pm2 process definition for running the bot locally as a background process.
// Usage:
//   cp ecosystem.config.example.js ecosystem.config.js
//   pm2 start ecosystem.config.js
//   pm2 save
// See README.md "Run on your own computer" section for the full setup,
// including making pm2 auto-start on boot.
//
// ecosystem.config.js itself is gitignored (like .env) rather than
// committed, same reasoning as this repo's other per-deployment files -
// this project now runs as more than one independent deployment (different
// people, different WhatsApp groups) off the same shared codebase, each
// pulling the same `main` branch. If this file were committed instead, a
// second deployment's `git pull` would silently overwrite the FIRST
// deployment's own customized copy with whatever's checked in - or, worse,
// two deployments running on the SAME machine would end up sharing the
// same pm2 process `name` below, which doesn't run them side by side:
// pm2's process list/names are global to the whole machine, not scoped per
// folder, so starting the second one under an identical name makes pm2
// treat it as (re)starting the SAME app, now pointed at the second
// deployment's `cwd` - silently breaking the first instance rather than
// running both independently. Copying this file and giving your own copy
// a UNIQUE `name` avoids both problems, exactly like copying .env.example
// to your own .env.
module.exports = {
  apps: [
    {
      name: 'whatsapp-list-bot', // give this a unique name if another deployment might run on the same machine
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
