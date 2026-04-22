module.exports = {
  apps: [
    {
      name: 'pr-reviewer-bot',
      script: 'dist/src/index.js',
      autorestart: true,
      watch: false,
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
