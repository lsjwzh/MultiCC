'use strict';

// Isolated end-to-end reproduction of the codex "starting" stall: a codex
// runner that spawns but produces no output (fake CODEX_CMD sleeping forever)
// must be detected by stalled-turn recovery (starting phase + grace), killed,
// and wrapped back to E so the session becomes usable again. Spawns a real
// server on a free port against a temp data dir, exactly like
// tests/test-liveness-api.js.

const assert = require('node:assert/strict');
const { spawn, execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { assertTestDir } = require('../src/paths');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-startstall-'));
const dataDir = assertTestDir(path.join(testRoot, 'data'));
fs.mkdirSync(dataDir, { recursive: true });

// Unique marker so pgrep can find (and later confirm the kill of) the fake runner.
const MARKER = `fake-codex-${process.pid}-${Date.now()}`;
const fakeCodex = path.join(testRoot, MARKER + '.js');
fs.writeFileSync(fakeCodex,
  '#!/usr/bin/env node\n// Pretend to be codex: start up, then hang silently without child processes.\nsetInterval(() => {}, 60_000);\n',
  { mode: 0o755 });

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(base) {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${base}/readyz`)).status === 200) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('isolated starting-stall server did not become ready');
}

function fakeRunnerAlive() {
  try {
    // Avoid `sh -c`: on Linux its command line contains MARKER and pgrep can
    // mistake that probe shell for the runner it is trying to find.
    execFileSync('pgrep', ['-f', MARKER], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let serverOut = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
      CODEX_CMD: fakeCodex,
      // Compressed schedule: 5s stall standard + 3s starting grace, check every
      // second, single confirmation. Real-world defaults stay 180s/120s/30s/2.
      MULTICC_STALL_SILENT_MS: '5000',
      MULTICC_STALLED_STARTING_GRACE_MS: '3000',
      MULTICC_STALLED_CONFIRMATIONS: '1',
      MULTICC_STALLED_INTERVAL_MS: '1000',
      // Destructive recovery is intentionally off in production by default;
      // this isolated test explicitly exercises the operator opt-in path.
      MULTICC_STALLED_AUTO_CANCEL: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { serverOut += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOut += chunk.toString(); });

  let failed = 0;
  const check = (name, cond) => {
    if (cond) { console.log(`  ok - ${name}`); } else { failed += 1; console.log(`  NOT OK - ${name}`); }
  };

  let ws = null;
  try {
    await waitReady(base);

    const repoDir = path.join(testRoot, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init -q && git config user.email t@t.co && git config user.name t '
      + '&& echo x > README.md && git add -A && git commit -qm init', { cwd: repoDir });

    const dirRes = await fetch(`${base}/api/directories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'starting-stall-test', path: repoDir }),
    });
    const dir = await dirRes.json();
    const dirId = dir.id || (dir.directory && dir.directory.id);
    assert.ok(dirId, `directory create returned an id (got ${JSON.stringify(dir).slice(0, 200)})`);

    const sessRes = await fetch(`${base}/api/directories/${dirId}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli: 'codex', kind: 'chat', label: 'starting-stall-target' }),
    });
    const sess = await sessRes.json();
    const sid = sess.id || (sess.session && sess.session.id);
    assert.ok(sid, 'codex chat session create returned an id');

    ws = new WebSocket(`${base}/ws/chat?session=${encodeURIComponent(sid)}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 10_000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'user_message', text: 'hello, please hang in starting phase' }));

    // The fake runner must actually spawn and stay silent.
    await new Promise(r => setTimeout(r, 3_000));
    check('fake codex runner spawned', fakeRunnerAlive());

    // While inside the starting grace window, liveness must say working/starting,
    // and the verdict reason must NOT contradict the heartbeat phase.
    const during = await (await fetch(`${base}/api/sessions/${sid}/liveness`)).json();
    check('inside grace: verdict is working', during.state === 'working');
    check('inside grace: phase is starting (heartbeat, not stale classify phase)', during.phase === 'starting');
    check('inside grace: reason does not say turn_done', !String(during.reason || '').includes('turn_done'));

    // Past grace + confirmation the recovery fires: kill → E wrap → idle.
    let final = null;
    for (let i = 0; i < 60; i += 1) {
      final = await (await fetch(`${base}/api/sessions/${sid}/liveness`)).json();
      if (final.state === 'idle') break;
      await new Promise(r => setTimeout(r, 1_000));
    }
    check('session wrapped back to idle after recovery', final && final.state === 'idle');
    check('fake codex runner was killed', !fakeRunnerAlive());
    check('server logged stalled_turn_recovered', serverOut.includes('stalled_turn_recovered'));
    check('recovery log carries the starting phase', /"phase"\s*:\s*"starting"/.test(serverOut));
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    child.kill('SIGKILL');
    try { execFileSync('pkill', ['-f', MARKER], { stdio: 'ignore' }); } catch (_) {}
  }

  console.log(`\nstarting-stall recovery: ${failed === 0 ? 'all checks passed' : failed + ' FAILED'}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
