module.exports = {
  apps: [{
    name: 'multicc',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      // edge-tts ships to a Python user-bin dir that isn't on pm2's PATH;
      // point the TTS service at the absolute path so it spawns cleanly.
      EDGE_TTS_CMD: '/Users/Zhuanz/Library/Python/3.9/bin/edge-tts',
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    time: true,
    autorestart: true,
    max_restarts: 20,
    min_uptime: '10s',
    kill_timeout: 10000,
  }],
};
