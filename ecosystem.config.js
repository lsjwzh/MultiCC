module.exports = {
  apps: [{
    name: 'multicc',
    // The Rust front door must own the public port. A bare `server.js` binds it
    // itself and silently lacks every route that moved into the front door
    // (docs/gateway.md section 9), so pm2 starts the same launcher as
    // `npm start`: it spawns multicc-gateway, which supervises Node behind it
    // and forwards SIGINT/SIGTERM for the graceful drain below.
    script: 'scripts/start-gateway.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      // edge-tts ships to a Python user-bin dir that isn't on pm2's PATH;
      // point the TTS service at a portable candidate so it spawns cleanly.
      EDGE_TTS_CMD: process.env.EDGE_TTS_CMD || 'edge-tts',
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    time: true,
    autorestart: true,
    max_restarts: 20,
    min_uptime: '10s',
    // kill_timeout must exceed SHUTDOWN_GRACE_MS (60_000ms) in server.js —
    // otherwise PM2's SIGKILL fires while the ShutdownCoordinator is still
    // draining in-flight chat turns / running closers, and partial assistant
    // text never reaches the checkpoint step. 75s gives 15s of headroom over
    // the drain window for closers (HTTP graceful close, WS flush, etc.).
    kill_timeout: 75000,
  }],
};
