module.exports = {
  apps: [{
    name: 'brokeragent',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env_file: '.env',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: 'logs/error.log',
    out_file:   'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
