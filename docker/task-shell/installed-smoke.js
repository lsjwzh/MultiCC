'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
assert.ok(fs.existsSync('/.dockerenv'), 'container-only smoke');
assert.equal(process.cwd(), '/home/node/installed');
assert.equal(process.env.MULTICC_DATA_DIR, '/home/node/clean-install-data');
assert.equal(process.env.ACCESS_TOKEN, undefined, 'Use the installer-written .env');
assert.equal(fs.existsSync(process.env.MULTICC_DATA_DIR), false, 'First boot must start without state');
const base = 'http://127.0.0.1:3000';
let server, logs = '';
async function api(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer clean-install-test' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
async function start() {
  let readiness = 'no response';
  server = spawn(process.execPath, ['server.js'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOST: '127.0.0.1' } });
  const capture = chunk => { logs = (logs + String(chunk).split('\n').filter(line => !line.includes('"path":"/readyz"')).join('\n') + '\n').slice(-40000); };
  server.stdout.on('data', capture); server.stderr.on('data', capture);
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error('Installed server exited');
    try {
      const response = await fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      readiness = await response.text();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Installed server readiness timeout: ${readiness}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
  await exited; clearTimeout(timer);
}
(async () => {
  try {
    await start();
    for (const page of ['/chat.html', '/task-shell.html', '/task-board-entry.js']) {
      assert.equal((await fetch(base + page, { headers: { authorization: 'Bearer clean-install-test' } })).status, 200);
    }
    const directory = await api('/api/directories', { name: 'Fresh install project', path: '/home/node/clean-install-project', create: true });
    const session = await api(`/api/directories/${directory.id}/sessions`, { cli: 'codex', kind: 'chat', label: 'Installed shell' });
    const shell = await api('/api/task-shells', { sessionId: session.id });
    await stop(); await start();
    assert.equal((await api('/api/task-shells', { sessionId: session.id })).id, shell.id);
    assert.ok((await api('/api/directories')).some(d => d.id === directory.id));
    console.log('PASS real installer .env, first startup, Web assets, directory/session creation, persisted shell after restart');
  } catch (error) { console.error(logs); throw error; }
  finally { await stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
