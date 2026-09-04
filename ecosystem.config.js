module.exports = {
  apps: [
    {
      name: 'pr-reviewer-bot',
      script: 'dist/src/index.js',
      autorestart: true,
      watch: false,
      // The app drains up to four sequential agent passes on SIGTERM. Keep
      // PM2's hard-kill deadline above the app-level graceful-shutdown grace.
      kill_timeout: 4 * 60 * 60 * 1000,
      max_memory_restart: '500M',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
