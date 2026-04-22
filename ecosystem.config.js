module.exports = {
  apps: [
    {
      name: 'pr-reviewer-bot',
      script: 'dist/src/index.js',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
