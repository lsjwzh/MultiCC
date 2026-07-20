'use strict';

// Isolated end-to-end check for the /api/sessions/:id/liveness endpoint. Spawns
// a real server against a temp data dir, creates a directory + session, and
// drives the endpoint to prove the wiring (runtime + process probe + route)
// actually answers over HTTP — not just in unit tests.

const assert = require('node:assert/strict');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-liveness-'));
const dataDir = assertTestDir(path.join(testRoot, 'data'));
fs.mkdirSync(dataDir, { recursive: true });

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
  throw new Error('isolated liveness server did not become ready');
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let failed = 0;
  const check = (name, cond) => {
    if (cond) { console.log(`  ok - ${name}`); } else { failed += 1; console.log(`  NOT OK - ${name}`); }
  };

  try {
    await waitReady(base);

    // Unknown session → 404.
    const missing = await fetch(`${base}/api/sessions/does-not-exist/liveness`);
    check('unknown session returns 404', missing.status === 404);

    // A registered directory must be a git repo. Provision one under the temp root.
    const repoDir = path.join(testRoot, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init -q && git config user.email t@t.co && git config user.name t '
      + '&& echo x > README.md && git add -A && git commit -qm init', { cwd: repoDir });

    const dirRes = await fetch(`${base}/api/directories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'liveness-test', path: repoDir }),
    });
    const dir = await dirRes.json();
    const dirId = dir.id || (dir.directory && dir.directory.id);
    assert.ok(dirId, `directory create returned an id (got ${JSON.stringify(dir).slice(0, 200)})`);

    const sessRes = await fetch(`${base}/api/directories/${dirId}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli: 'claude', kind: 'chat', label: 'liveness-probe-target' }),
    });
    const sess = await sessRes.json();
    const sid = sess.id || (sess.session && sess.session.id);
    assert.ok(sid, 'session create returned an id');

    // Event-only assessment (?probe=0) — must return a well-formed verdict.
    const cheap = await fetch(`${base}/api/sessions/${sid}/liveness?probe=0`);
    check('liveness endpoint returns 200', cheap.status === 200);
    const v = await cheap.json();
    check('verdict has a valid state', ['working', 'idle', 'stalled', 'unknown'].includes(v.state));
    check('a brand-new idle session is idle', v.state === 'idle');
    check('verdict carries a reason string', typeof v.reason === 'string' && v.reason.length > 0);

    // Full assessment (with process probe) must also answer without hanging.
    const full = await fetch(`${base}/api/sessions/${sid}/liveness`);
    check('probed liveness returns 200', full.status === 200);
    const vf = await full.json();
    check('probed verdict still well-formed', ['working', 'idle', 'stalled'].includes(vf.state));
  } finally {
    child.kill('SIGKILL');
  }

  console.log(`\nliveness API: ${failed === 0 ? 'all checks passed' : failed + ' FAILED'}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
