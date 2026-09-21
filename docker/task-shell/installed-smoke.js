'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Boots the *installed standalone package* the way a user does: through the
// `multicc` command that ships inside it, with the runtime that ships inside
// it. Nothing here may touch the host Node or the source checkout — that is the
// whole claim the standalone package makes.
assert.ok(fs.existsSync('/.dockerenv'), 'container-only smoke');
assert.equal(process.cwd(), '/home/node/installed');
assert.equal(process.env.MULTICC_STANDALONE_HOME, '/home/node/.multicc-standalone',
  'the bundle must be told where its writable state lives');
assert.equal(process.env.ACCESS_TOKEN, undefined, 'Use the config install.sh wrote, not the environment');
assert.equal(fs.existsSync(process.env.MULTICC_DATA_DIR), false, 'First boot must start without state');

const installed = process.cwd();
const cli = path.join(installed, 'multicc');
const runtime = path.join(installed, 'Resources', 'runtime', 'bin', 'node');
const base = 'http://127.0.0.1:3000';

// The bundle's own runtime, never the one that happens to be on PATH.
function multicc(args, options = {}) {
  return spawnSync(runtime, [path.join(installed, 'Resources', 'launcher', 'standalone-cli.js'), ...args], {
    encoding: 'utf8', env: process.env, ...options,
  });
}

async function api(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer clean-install-test' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
async function start() {
  const started = multicc(['start', '--no-open'], { timeout: 180_000 });
  assert.equal(started.status, 0, `multicc start failed:\n${started.stdout}\n${started.stderr}`);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Installed server readiness timeout:\n${multicc(['status']).stdout}`);
}
async function stop() {
  const stopped = multicc(['stop'], { timeout: 60_000 });
  assert.equal(stopped.status, 0, `multicc stop failed:\n${stopped.stdout}\n${stopped.stderr}`);
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) });
    } catch (_) { return; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('the port is still answering after multicc stop');
}
(async () => {
  try {
    // The command itself must work before anything is started.
    assert.equal(fs.accessSync(cli, fs.constants.X_OK) === undefined, true, 'multicc must be executable');
    const version = multicc(['version']);
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/, 'multicc version must print the bundle version');

    await start();
    const status = JSON.parse(multicc(['status', '--json']).stdout);
    assert.equal(status.running, true, 'multicc status must see the running server');
    assert.equal(status.url, base);
    assert.equal(status.dataDir, process.env.MULTICC_STANDALONE_HOME);

    for (const page of ['/chat.html', '/task-shell.html', '/task-board-entry.js']) {
      assert.equal((await fetch(base + page, { headers: { authorization: 'Bearer clean-install-test' } })).status, 200);
    }
    const directory = await api('/api/directories', { name: 'Fresh install project', path: '/home/node/clean-install-project', create: true });
    const session = await api(`/api/directories/${directory.id}/sessions`, { cli: 'codex', kind: 'chat', label: 'Installed shell' });
    const shell = await api('/api/task-shells', { sessionId: session.id });
    await stop(); await start();
    assert.equal((await api('/api/task-shells', { sessionId: session.id })).id, shell.id);
    assert.ok((await api('/api/directories')).some(d => d.id === directory.id));
    console.log('PASS standalone package: installer config, first startup, Web assets, directory/session creation, persisted shell after a real stop/start');
  } catch (error) {
    // The bundle writes every log into its data directory, not to this process.
    const logs = path.join(process.env.MULTICC_STANDALONE_HOME, 'logs');
    for (const name of fs.existsSync(logs) ? fs.readdirSync(logs) : []) {
      console.error(spawnSync('tail', ['-n', '120', path.join(logs, name)], { encoding: 'utf8' }).stdout || '');
    }
    throw error;
  }
  finally { try { await stop(); } catch (_) {} }
})().catch(error => { console.error(error); process.exitCode = 1; });
