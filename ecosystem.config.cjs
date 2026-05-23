module.exports = {
  apps: [{
    name: 'custom-integration-hub',
    script: 'dist/server.js',
    cwd: '/home/srv/custom-integration-hub',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    kill_timeout: 35000, // 35s — matches 30s graceful shutdown + 5s margin
    env: {
      NODE_ENV: 'production',
      PORT: 3100,
    },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};
