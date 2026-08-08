'use strict';

// Isolated end-to-end check for the codex pre-resume rollout size guard. A
// fake codex (CODEX_CMD) establishes a native thread on turn 1; we then plant
// an over-budget rollout file for that thread id and send turn 2. The guard
// must archive the rollout, clear cliSessionId, and spawn turn 2 as a FRESH
// thread (no `resume <id>`), instead of handing the oversized file to codex —
// which would hang internally before its first upstream request.
//
// HOME is redirected to a temp dir so the guard's ~/.codex walk never touches
// the real codex sessions tree.

const assert = require('node:assert/strict');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { assertTestDir } = require('../src/paths');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rolloutguard-e2e-'));
const dataDir = assertTestDir(path.join(testRoot, 'data'));
const homeDir = path.join(testRoot, 'home');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

const THREAD_ID = 'fake-thread-guard-e2e';
const fakeCodex = path.join(testRoot, 'fake-codex-guard.sh');
fs.writeFileSync(fakeCodex, [
  '#!/bin/sh',
  `echo '{"type":"thread.started","thread_id":"${THREAD_ID}"}'`,
  'echo \'{"type":"turn.completed","usage":{"input_tokens":1}}\'',
  '',
].join('\n'), { mode: 0o755 });

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
  throw new Error('isolated rollout-guard server did not become ready');
}

async function persistedCliSessionId(base, sid) {
  const res = await fetch(`${base}/api/sessions`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body.sessions || []);
  const hit = list.find(s => s.id === sid);
  return hit ? (hit.cliSessionId || null) : null;
}

async function waitIdle(base, sid, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    const v = await (await fetch(`${base}/api/sessions/${sid}/liveness?probe=0`)).json();
    if (v.state === 'idle') return v;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('turn never settled to idle');
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
      HOME: homeDir, // guard walks $HOME/.codex — never the real one
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
      CODEX_CMD: fakeCodex,
      MULTICC_CODEX_ROLLOUT_MAX_BYTES: '1024',
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
      body: JSON.stringify({ name: 'rollout-guard-test', path: repoDir }),
    });
    const dir = await dirRes.json();
    const dirId = dir.id || (dir.directory && dir.directory.id);
    assert.ok(dirId, `directory create returned an id (got ${JSON.stringify(dir).slice(0, 200)})`);

    const sessRes = await fetch(`${base}/api/directories/${dirId}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli: 'codex', kind: 'chat', label: 'rollout-guard-target' }),
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

    // Turn 1: fake codex establishes the native thread; server persists it.
    ws.send(JSON.stringify({ type: 'user_message', text: 'first turn' }));
    await waitIdle(base, sid);
    check('turn 1 captured the fake native session id',
      (await persistedCliSessionId(base, sid)) === THREAD_ID);

    // Plant an over-budget rollout for that thread (budget is 1KB in this run).
    const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '01', '01');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rollout = path.join(sessionsDir, `rollout-2026-01-01T00-00-00-${THREAD_ID}.jsonl`);
    fs.writeFileSync(rollout, 'x'.repeat(4096));

    // Turn 2: the guard must fire before the spawn decision.
    ws.send(JSON.stringify({ type: 'user_message', text: 'second turn must not resume' }));
    await waitIdle(base, sid);

    check('server logged codex_rollout_archived', serverOut.includes('codex_rollout_archived'));
    check('oversized rollout removed from sessions tree', !fs.existsSync(rollout));
    const archived = path.join(homeDir, '.codex', 'multicc-archived-rollouts', path.basename(rollout));
    check('rollout preserved in archive dir', fs.existsSync(archived));
    const afterArchive = serverOut.slice(serverOut.indexOf('codex_rollout_archived'));
    check('no spawn after the archive resumes the old thread',
      !afterArchive.includes(`resume ${THREAD_ID}`));
    check('the post-archive turn spawned as a fresh first turn',
      /Spawning codex \(turn \d+, first=true/.test(afterArchive));
    // The fake codex reports the SAME thread id again, so the server captures
    // it anew — exactly what a real fresh codex thread would produce.
    check('the fresh thread id was captured back',
      (await persistedCliSessionId(base, sid)) === THREAD_ID);
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    child.kill('SIGKILL');
  }

  console.log(`\nrollout guard e2e: ${failed === 0 ? 'all checks passed' : failed + ' FAILED'}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
