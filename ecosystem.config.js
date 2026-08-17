// pm2 process definition for running the bot locally as a background process.
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save
// See README.md "Run on your own computer" section for the full setup,
// including making pm2 auto-start on boot.

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
