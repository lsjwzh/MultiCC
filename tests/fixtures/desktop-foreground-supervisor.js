'use strict';

// Runs the backend supervisor the way the standalone launcher's *foreground*
// mode does — which is what MultiCC.app runs (Contents/MacOS/MultiCC execs
// `standalone-launcher.js --start`, no --detach).
//
// The point of this fixture is the event loop. After the first /readyz, this
// process deliberately holds NOTHING of its own: the server child is the only
// live handle, and the launcher's own `await new Promise(() => {})` is not a
// handle at all. So the moment that child exits, a supervisor whose restart
// timer is unref'd loses the process: node drains the loop, exits 0, and the
// server never comes back.
//
// That failure is invisible inside node:test, because the test runner's own
// handles keep the loop alive — which is exactly how it shipped. Hence a child
// process, and hence the assertion that the process is still around to print
// RESPAWNED.
//
// env: PORT (required), LOGS_DIR, RUNTIME_INFO_FILE, READY_TARGET (default 2),
//      BACKOFF_MS (default 200), plus whatever the fixture server reads
//      (READY_DELAY_MS, EXIT_AFTER_READY_MS, EXIT_CODE).
// stdout: `phase <name> <json>` per supervisor phase, then `RESPAWNED <n>` or
//      `FAILED <json>` / `START-ERROR <message>`.

const path = require('path');
const { spawn } = require('child_process');
const { createBackendSupervisor } = require(path.join(__dirname, '..', '..', 'desktop', 'lib', 'backend-supervisor.js'));

const PORT = Number.parseInt(process.env.PORT || '0', 10);
const TARGET = Number.parseInt(process.env.READY_TARGET || '2', 10);
const BACKOFF_MS = Number.parseInt(process.env.BACKOFF_MS || '200', 10);
const FIXTURE = path.join(__dirname, 'desktop-fixture-server.js');

if (!PORT) { console.error('foreground-supervisor: PORT required'); process.exit(2); }

let ready = 0;
let finished = false;

function finish(code, note) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${note}\n`);
  process.exit(code);
}

const supervisor = createBackendSupervisor({
  spawn,
  execPath: process.execPath,
  serverEntry: FIXTURE,
  buildEnv: ({ port }) => ({ ...process.env, PORT: String(port) }),
  logsDir: process.env.LOGS_DIR,
  runtimeInfoFile: process.env.RUNTIME_INFO_FILE,
  logger: { log: () => {}, warn: () => {}, error: () => {} },
  // Generous: the guard is not what is under test here, and the fixture would
  // otherwise trip it while the parent is still reading output.
  crashLoopThreshold: 20,
  restartBackoffMs: BACKOFF_MS,
  maxRestartBackoffMs: BACKOFF_MS,
  onPhase: (phase, info) => {
    process.stdout.write(`phase ${phase} ${JSON.stringify(info || {})}\n`);
    if (phase === 'ready' && ++ready >= TARGET) {
      // Off the probe's stack, then tear the child down properly so no fixture
      // is left holding the port.
      setImmediate(() => { supervisor.stop().then(() => finish(0, `RESPAWNED ${ready}`)); });
    }
    if (phase === 'failed') finish(1, `FAILED ${JSON.stringify(info || {})}`);
  },
});

supervisor.start({ port: PORT })
  .then(() => {
    process.stdout.write('started\n');
    // Exactly what standalone-launcher.js's foreground mode ends with. It holds
    // nothing on purpose: whatever keeps this process alive has to be the
    // supervisor's own bookkeeping.
    return new Promise(() => {});
  })
  .catch(error => finish(1, `START-ERROR ${error && error.message}`));
