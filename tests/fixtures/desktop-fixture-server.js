'use strict';

// Fixture backend for desktop-shell supervisor tests. A miniature stand-in for
// the real MultiCC server, driven entirely by environment variables so the
// supervisor can be exercised end-to-end (readiness gating, respawns, crash
// classification, graceful drain, tree cleanup) without booting the real thing:
//
//   PORT                    port to bind on 127.0.0.1 (required)
//   READY_DELAY_MS          serve 503 on /readyz until this long after listen
//   EXIT_AFTER_READY_MS     exit with EXIT_CODE once ready and delayed
//   EXIT_CODE               exit code for the exits above (default 1)
//   PRINT_ADDRINUSE         print a fake EADDRINUSE stack to stderr, exit 3
//   SPAWN_CHILD_PIDFILE     spawn a sleep grandchild (simulates CLI children)
//                           and write its pid to this path
//
// Behavior parity with the real server (what the supervisor depends on):
//   GET  /readyz            503 until ready, then 200
//   POST /api/desktop-shutdown  reply 202, kill grandchild, exit 0
//   SIGINT/SIGTERM          kill grandchild, exit 0

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = Number.parseInt(process.env.PORT || '0', 10);
const READY_DELAY_MS = Number.parseInt(process.env.READY_DELAY_MS || '0', 10);
const EXIT_AFTER_READY_MS = Number.parseInt(process.env.EXIT_AFTER_READY_MS || '0', 10);
const EXIT_CODE = Number.parseInt(process.env.EXIT_CODE || '1', 10);
const PRINT_ADDRINUSE = /^(1|true|yes)$/i.test(process.env.PRINT_ADDRINUSE || '');
const PIDFILE = process.env.SPAWN_CHILD_PIDFILE || '';

if (!PORT) { console.error('fixture: PORT required'); process.exit(2); }

let child = null;
let readyAt = 0;
let shuttingDown = false;

function killChild() {
  if (child && child.exitCode === null) child.kill('SIGKILL');
}

function exitSoon(code, delayMs = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => { killChild(); process.exit(code); }, delayMs).unref();
}

if (PIDFILE) {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], {
    stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
}

if (PRINT_ADDRINUSE) {
  process.stderr.write('Error: listen EADDRINUSE: address already in use 127.0.0.1:' + PORT + '\n');
  process.exit(3);
}

const server = http.createServer((req, res) => {
  if (req.url === '/readyz') {
    if (!readyAt || Date.now() - readyAt < READY_DELAY_MS) {
      res.writeHead(503).end(JSON.stringify({ status: 'not_ready' }));
    } else {
      res.writeHead(200).end(JSON.stringify({ status: 'ready' }));
    }
    return;
  }
  if (req.url === '/api/desktop-shutdown' && req.method === 'POST') {
    res.writeHead(202).end(JSON.stringify({ ok: true, status: 'shutting-down' }));
    exitSoon(0, 50);
    return;
  }
  res.writeHead(404).end('{}');
});

server.on('error', error => {
  process.stderr.write(`fixture: ${error.code}: ${error.message}\n`);
  process.exit(3);
});

server.listen(PORT, '127.0.0.1', () => {
  readyAt = Date.now();
  process.stdout.write(`fixture: listening on ${PORT}\n`);
  if (EXIT_AFTER_READY_MS) exitSoon(EXIT_CODE, EXIT_AFTER_READY_MS);
});

process.on('SIGINT', () => exitSoon(0));
process.on('SIGTERM', () => exitSoon(0));
