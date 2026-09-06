'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const base = 'http://127.0.0.1:3000';
const seedFile = path.join(process.env.MULTICC_DATA_DIR, 'lab-seed.json');
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
const server = spawn(process.execPath, ['server.js'], { stdio: 'inherit' });
let stopping = false;
let failed = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 15000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.once('error', error => { console.error(error); process.exitCode = 1; });
server.once('exit', code => { process.exitCode = failed ? 1 : stopping ? 0 : code || 1; });
async function api(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ACCESS_TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
async function seed() {
  let ready = false;
  for (let i = 0; i < 120 && !stopping; i++) {
    if (server.exitCode !== null || server.signalCode) throw new Error('Lab server exited');
    try { ready = (await fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) })).ok; } catch (_) {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (stopping) return;
  if (!ready) throw new Error('Lab server readiness timeout');
  const directories = await api('/api/directories');
  const project = '/var/lib/multicc/project';
  let directory = directories.find(d => d.path === project);
  if (!directory) directory = await api('/api/directories', { name: 'Docker task-shell lab', path: project, create: true });
  // Recover a partial seed using the existing sessions rather than duplicate them.
  const all = await api('/api/sessions');
  const shells = [];
  for (const label of ['Docker shell A', 'Docker shell B']) {
    let session = all.find(s => s.dirId === directory.id && s.label === label);
    if (!session) session = await api(`/api/directories/${directory.id}/sessions`, { cli: 'codex', kind: 'chat', label });
    const shell = await api('/api/task-shells', { sessionId: session.id });
    shells.push({ label, sessionId: session.id, shellId: shell.id });
  }
  const result = { directoryId: directory.id, shells };
  fs.writeFileSync(seedFile + '.tmp', JSON.stringify(result, null, 2));
  fs.renameSync(seedFile + '.tmp', seedFile);
  console.log('\n[Docker lab] Ready. Password: multicc-docker-lab');
  for (const shell of shells) console.log(`${shell.label}: http://127.0.0.1:${process.env.MULTICC_LAB_PORT || 3300}/task-shell.html?shell=${shell.shellId}`);
  console.log('Send LAB_WAIT 30 on its own line to exercise current-task queueing or cancellation.');
}
seed().catch(error => { failed = true; console.error('[Docker lab]', error); stop(); });
