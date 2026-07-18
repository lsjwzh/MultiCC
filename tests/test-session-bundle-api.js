'use strict';

// Isolated HTTP integration for encrypted session handoff. The test creates
// only Git commits; it never starts an AI CLI or touches the real data root.

const assert = require('assert');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { assertTestDir } = require('../src/paths');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const PORT = 41000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'session-bundle-api-test';
const PASSPHRASE = 'bundle-test-passphrase';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-session-bundle-'));
const dataRoot = assertTestDir(path.join(tmpRoot, 'data'));
const project = path.join(tmpRoot, 'project');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });

let server = null;
let stderr = '';

async function git(cwd, args) {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

async function api(method, route, body) {
  const response = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await api('GET', '/api/directories')).status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated server did not start');
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
}

(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ACCESS_TOKEN: TOKEN, MULTICC_DATA_DIR: dataRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();

  let response = await api('POST', '/api/directories', { name: 'Bundle API', path: project });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const dirId = response.data.id;

  response = await api('POST', `/api/directories/${dirId}/sessions`, { cli: 'claude', kind: 'chat' });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const sourceId = response.data.id;
  const sourceWorktree = path.join(project, '.multicc-worktrees', sourceId);
  await fs.promises.writeFile(path.join(sourceWorktree, 'session-feature.txt'), 'session feature\n');
  await git(sourceWorktree, ['add', '-A']);
  await git(sourceWorktree, ['-c', 'user.email=test@multicc.local', '-c', 'user.name=MultiCC Test',
    'commit', '-m', 'session feature']);

  // Advance main after the source fork. Safe import must preserve this newer
  // target base while replaying the source-only commit.
  await fs.promises.writeFile(path.join(project, 'new-main.txt'), 'new main\n');
  await git(project, ['add', '-A']);
  await git(project, ['-c', 'user.email=test@multicc.local', '-c', 'user.name=MultiCC Test',
    'commit', '-m', 'new main']);

  response = await api('GET', `/api/sessions/${sourceId}/bundle?passphrase=${encodeURIComponent(PASSPHRASE)}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.ok, true);
  assert.equal(response.data.meta.hasGitBundle, true);

  const { salt, iv, ct, tag } = response.data;
  response = await api('POST', '/api/sessions/import', {
    salt, iv, ct, tag, passphrase: PASSPHRASE, dirId, label: 'Imported safely',
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.restored.gitRestored, true, JSON.stringify(response.data.restored));
  const importedId = response.data.sessionId;
  const importedWorktree = path.join(project, '.multicc-worktrees', importedId);
  assert.equal(await fs.promises.readFile(path.join(importedWorktree, 'session-feature.txt'), 'utf8'), 'session feature\n');
  assert.equal(await fs.promises.readFile(path.join(importedWorktree, 'new-main.txt'), 'utf8'), 'new main\n');
  assert.equal(await git(importedWorktree, ['status', '--porcelain']), '');

  response = await api('DELETE', `/api/directories/${dirId}?force=1`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  await stopServer();
  assertTestDir(tmpRoot);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('session bundle HTTP integration: passed');
})().catch(async error => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-4000));
  await stopServer();
  try { assertTestDir(tmpRoot); fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});
