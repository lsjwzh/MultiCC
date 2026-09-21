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
const createLegacySession = require('./helpers/legacy-task-session');

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

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ACCESS_TOKEN: TOKEN, MULTICC_DATA_DIR: dataRoot,
           MULTICC_MEMORY_ROOT: path.join(dataRoot, 'memories') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  server = null;
}

(async () => {
  await startServer();

  let response = await api('POST', '/api/directories', { name: 'Bundle API', path: project });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const dirId = response.data.id;

  // Production chat creation mints a board task whose workspace only
  // materializes on the first delivery, and this fixture needs a real Git
  // worktree before any turn runs. Seed the ordinary conversation the way an
  // upgraded install holds one: written while the server is stopped, so boot
  // builds its worktree and adopts it into a board task.
  const sourceId = 'bundle-source';
  await createLegacySession({ dataDir: dataRoot, dirId, id: sourceId, cli: 'claude', stop: stopServer, start: startServer });
  const sourceWorktree = path.join(project, '.multicc-worktrees', sourceId);
  // Shared-scope memory + project instructions ride along in bundle v2: the
  // memory waterfall scope map and the context dependency manifest.
  const memoryRoot = path.join(dataRoot, 'memories');
  await fs.promises.mkdir(path.join(memoryRoot, dirId, '_shared'), { recursive: true });
  await fs.promises.writeFile(path.join(memoryRoot, dirId, '_shared', 'handoff-shared.md'), 'shared knowledge\n');
  await fs.promises.writeFile(path.join(sourceWorktree, 'CLAUDE.md'), '# project rules\n');
  await fs.promises.writeFile(path.join(sourceWorktree, 'session-feature.txt'), 'session feature\n');
  // A conversation-referenced upload (temp-dir multicc_* file) must travel
  // with the bundle and come back on a rewritten path. Seed it while the
  // server is stopped so the history cache cannot overwrite the fixture.
  const uploadPath = path.join(os.tmpdir(), `multicc_${process.pid}_handofftest.png`);
  await fs.promises.writeFile(uploadPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  await stopServer();
  await fs.promises.mkdir(path.join(dataRoot, 'chat_history'), { recursive: true });
  await fs.promises.writeFile(path.join(dataRoot, 'chat_history', `${sourceId}.json`),
    `${JSON.stringify({ id: 'm-asset-1', role: 'user', ts: Date.now(), taskId: 'tsk-source-machine-only', content: `看这张截图 ${uploadPath}` })}\n`);
  await startServer();
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
  assert.equal(response.data.meta.v, 2);
  assert.equal(response.data.meta.hasGitBundle, true);
  assert.ok(response.data.meta.scopes.shared >= 1, JSON.stringify(response.data.meta.scopes));

  const { salt, iv, ct, tag } = response.data;
  const exportMeta = response.data.meta;
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

  // v2 environment payload. The import targets the SAME project directory, so
  // the shared scope restore is the collision path: the file already exists
  // and the local copy wins (idempotent re-import never overwrites team
  // memory). The handoff manifest still lands in the imported session's
  // private memory folder.
  assert.equal(await fs.promises.readFile(
    path.join(memoryRoot, dirId, '_shared', 'handoff-shared.md'), 'utf8'), 'shared knowledge\n');
  assert.ok(response.data.restored.memoryScopes.shared.skipped.some(
    s => s.name === 'handoff-shared.md' && s.reason === 'already exists locally'),
    JSON.stringify(response.data.restored.memoryScopes));
  const handoffDoc = await fs.promises.readFile(
    path.join(memoryRoot, dirId, 'sessions', importedId, 'HANDOFF.md'), 'utf8');
  assert.match(handoffDoc, /HANDOFF/);
  assert.match(handoffDoc, /来源仓库/);
  // The upload rode along: meta counted it, the imported history points at
  // the restored copy (multicc_handoff_*), the bytes match, and the manifest
  // documents the from→to mapping.
  assert.ok(exportMeta.assets.files >= 1, JSON.stringify(exportMeta.assets));
  assert.ok(response.data.restored.assets.restored >= 1, JSON.stringify(response.data.restored));
  const importedHistory = await fs.promises.readFile(
    path.join(dataRoot, 'chat_history', `${importedId}.json`), 'utf8');
  // Source-machine task stamps must not ride along: on the target they name
  // nonexistent tasks (or, on a same-instance re-import, pin live ones).
  assert.ok(!importedHistory.includes('"taskId"'), 'imported messages must not carry source taskId stamps');
  assert.ok(!importedHistory.includes(uploadPath), 'old temp path must be rewritten');
  const rewritten = importedHistory.match(/(\/[^"'\n]*multicc_handoff_[^"'\n]*\.png)/);
  assert.ok(rewritten, 'imported history references the restored asset');
  assert.deepEqual(fs.readFileSync(rewritten[1]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  assert.match(handoffDoc, /multicc_handoff_/);
  assert.match(handoffDoc, new RegExp(uploadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  fs.rmSync(rewritten[1], { force: true });

  // ── v3 zip transport: export real zip bytes → import-zip end-to-end ──
  const { readZip } = require('../src/session/handoff-zip');
  const zipResponse = await fetch(
    `${BASE}/api/sessions/${sourceId}/bundle.zip?passphrase=${encodeURIComponent(PASSPHRASE)}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(zipResponse.status, 200);
  assert.match(zipResponse.headers.get('content-type') || '', /zip/);
  const zipBuf = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, 'response body is a zip archive');
  // Standard-tool interop is covered by unit tests; here verify structure via
  // our own reader: manifest present, assets ride as real files with the
  // original bytes, and the chat text stays encrypted (never in the clear).
  const zipEntries = readZip(zipBuf);
  const zipNames = zipEntries.map(e => e.name);
  assert.ok(zipNames.includes('manifest.json'));
  const plaintextJoin = zipEntries.map(e => e.data.toString('latin1')).join('');
  assert.ok(!plaintextJoin.includes('看这张截图'), 'chat history must stay encrypted inside manifest.json');
  const metaEntry = JSON.parse(zipEntries.find(e => e.name === 'meta.json').data.toString('utf8'));
  assert.equal(metaEntry.format, 'multicc-session-handoff');
  assert.equal(metaEntry.v, 3);
  assert.ok(metaEntry.counts.messages >= 1);
  const assetEntries = zipEntries.filter(e => e.name.startsWith('assets/'));
  assert.ok(assetEntries.length >= 1, JSON.stringify(zipNames));
  assert.deepEqual(assetEntries[0].data, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  assert.ok(zipEntries.some(e => e.name === 'git.bundle'));

  let zipImport = null;
  let zipResp = await fetch(
    `${BASE}/api/sessions/import-zip?passphrase=${encodeURIComponent(PASSPHRASE)}&dirId=${dirId}&label=Zip%20Imported`,
    { method: 'POST', headers: { 'Content-Type': 'application/zip', Authorization: `Bearer ${TOKEN}` },
      body: zipBuf });
  zipImport = await zipResp.json();
  assert.equal(zipResp.status, 200, JSON.stringify(zipImport));
  assert.equal(zipImport.ok, true);
  assert.equal(zipImport.restored.gitRestored, true, JSON.stringify(zipImport.restored));
  assert.ok(zipImport.restored.assets.restored >= 1, JSON.stringify(zipImport.restored));
  const zipId = zipImport.sessionId;
  // The replayed commit landed in the zip-imported worktree too.
  assert.equal(await fs.promises.readFile(
    path.join(project, '.multicc-worktrees', zipId, 'session-feature.txt'), 'utf8'), 'session feature\n');
  const zipHistory = await fs.promises.readFile(
    path.join(dataRoot, 'chat_history', `${zipId}.json`), 'utf8');
  assert.ok(!zipHistory.includes('"taskId"'), 'zip-imported messages must not carry source taskId stamps');
  assert.ok(!zipHistory.includes(uploadPath), 'old temp path must be rewritten (zip import)');
  const zipRewritten = zipHistory.match(/(\/[^"'\n]*multicc_handoff_[^"'\n]*\.png)/);
  assert.ok(zipRewritten, 'zip-imported history references the restored asset');
  assert.deepEqual(fs.readFileSync(zipRewritten[1]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  fs.rmSync(zipRewritten[1], { force: true });
  // Wrong passphrase must fail closed before any session is created.
  zipResp = await fetch(`${BASE}/api/sessions/import-zip?passphrase=wrong-pass&dirId=${dirId}`,
    { method: 'POST', headers: { 'Content-Type': 'application/zip', Authorization: `Bearer ${TOKEN}` },
      body: zipBuf });
  assert.equal(zipResp.status, 400);
  assert.match(await zipResp.text(), /passphrase|corrupt/);


  // The seeded room was adopted into a board task at boot, and task teardown
  // refuses an unmerged workspace — so release the fixture's branch first, then
  // dispose the task that owns the room, then the directory.
  await git(sourceWorktree, ['reset', '--hard', await git(project, ['rev-parse', 'HEAD'])]);
  const board = await api('GET', '/api/task-board');
  const ownerTask = Object.values(board.data.tasks || {}).find(task => task.chatSessionId === sourceId);
  assert.ok(ownerTask, 'the seeded room was adopted into a board task');
  response = await api('DELETE', `/api/task-board/tasks/${ownerTask.id}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  response = await api('DELETE', `/api/directories/${dirId}?force=1`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  await stopServer();
  assertTestDir(tmpRoot);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(uploadPath, { force: true });
  console.log('session bundle HTTP integration: passed');
})().catch(async error => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-4000));
  await stopServer();
  try { assertTestDir(tmpRoot); fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});
