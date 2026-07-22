'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { assertTestDir, createPaths } = require('../src/paths');
const { readJson, writeJsonAtomic } = require('../src/state-store');

const ROOT = path.join(__dirname, '..');
const LIVE_SERVERS = new Set();
const LEGACY_PROMPT = [
  '# 🫡 Agent Commander',
  'You are the **Agent Commander** — old bundled wording.',
  '## 🗺️ How multicc works (your battlefield)',
  'historical content',
  '## 🚫 Anti-patterns',
].join('\n\n');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function initRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@multicc.local', '-c', 'user.name=MultiCC Test',
    'commit', '--allow-empty', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function writeState(dataRoot, directories, sessions) {
  const paths = createPaths({ dataDir: dataRoot });
  writeJsonAtomic(paths.directoriesFile, directories, { kind: 'directories', schemaVersion: 1, rotate: 0 });
  writeJsonAtomic(paths.sessionsFile, sessions, { kind: 'sessions', schemaVersion: 1, rotate: 0 });
  return paths;
}

async function startServer({ dataRoot, cliAvailable = true, extraEnv = {} }) {
  const port = await freePort();
  const fakeBin = path.join(dataRoot, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCodex = path.join(fakeBin, 'codex');
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const missing = path.join(fakeBin, 'missing-cli');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      MULTICC_DATA_DIR: dataRoot,
      CODEX_CMD: cliAvailable ? fakeCodex : missing,
      CLAUDE_CMD: missing,
      OPENCODE_CMD: missing,
      ZCODE_CMD: missing,
      QODER_CMD: missing,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  LIVE_SERVERS.add(child);
  child.once('exit', () => LIVE_SERVERS.delete(child));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`isolated server exited ${child.exitCode}: ${stderr}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200) return { child, base, stderr: () => stderr };
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`isolated server did not listen: ${stderr}`);
}

async function stopServer(instance) {
  if (!instance?.child || instance.child.exitCode !== null) return;
  instance.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => instance.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
}

async function json(base, route, options) {
  const response = await fetch(base + route, options);
  return { status: response.status, body: await response.json() };
}

(async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-commander-isolated-')));
  const dataRoot = path.join(root, 'data-success');
  const repos = {
    empty: initRepo(root, 'repo-empty'),
    typed: initRepo(root, 'repo-typed'),
    legacy: initRepo(root, 'repo-legacy'),
    fuzzy: initRepo(root, 'repo-fuzzy'),
  };
  const directories = Object.entries(repos).map(([id, repo], index) => ({
    id: `dir-${id}`, name: id, path: repo, createdAt: `2026-01-0${index + 1}T00:00:00Z`,
  }));
  const sessions = [
    { id: 'typed-existing', dirId: 'dir-typed', cli: 'codex', kind: 'chat', type: 'commander', label: 'Custom Commander', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'legacy-existing', dirId: 'dir-legacy', cli: 'codex', kind: 'chat', label: '🫡 Agent Commander', rolePrompt: LEGACY_PROMPT, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'fuzzy-ordinary', dirId: 'dir-fuzzy', cli: 'codex', kind: 'chat', label: '🫡 Agent Commander', rolePrompt: '普通会话', createdAt: '2026-01-01T00:00:00Z' },
  ];
  writeState(dataRoot, directories, sessions);

  let server = await startServer({ dataRoot });
  let response = await json(server.base, '/readyz');
  assert.equal(response.status, 200);
  assert.equal(response.body.checks.commanderMigration.ready, true);
  response = await json(server.base, '/api/sessions');
  assert.equal(response.status, 200);
  const all = response.body;
  const commanders = dirId => all.filter(session => session.dirId === dirId && session.type === 'commander');
  assert.equal(commanders('dir-empty').length, 1, 'empty Fleet receives a Commander');
  assert.deepEqual(commanders('dir-typed').map(session => session.id), ['typed-existing']);
  assert.deepEqual(commanders('dir-legacy').map(session => session.id), ['legacy-existing']);
  assert.equal(commanders('dir-fuzzy').length, 1, 'same-name ordinary chat does not get stamped');
  assert.notEqual(commanders('dir-fuzzy')[0].id, 'fuzzy-ordinary');
  assert.equal(all.find(session => session.id === 'fuzzy-ordinary').type, null);
  const persisted = readJson(createPaths({ dataDir: dataRoot }).sessionsFile, { legacyIsArray: true }).data;
  for (const dirId of ['dir-empty', 'dir-fuzzy']) {
    const commander = commanders(dirId)[0];
    const durable = persisted.find(session => session.id === commander.id);
    assert.equal(commander.kind, 'chat');
    assert.equal(commander.cli, 'codex');
    assert.equal(commander.provider, null);
    assert.equal(commander.model, null);
    assert.ok(commander.rolePrompt.length > 1000, 'new Commander carries complete role prompt');
    assert.equal(fs.existsSync(durable.worktreePath), true);
    assert.equal(execFileSync('git', ['branch', '--list', durable.branch], {
      cwd: directories.find(directory => directory.id === dirId).path, encoding: 'utf8',
    }).trim().length > 0, true);
  }
  const beforeRestartIds = all.filter(session => session.type === 'commander').map(session => session.id).sort();
  await stopServer(server);
  server = await startServer({ dataRoot });
  response = await json(server.base, '/api/sessions');
  assert.deepEqual(response.body.filter(session => session.type === 'commander').map(session => session.id).sort(), beforeRestartIds,
    'startup compatibility migration is idempotent');
  await stopServer(server);

  // Persistence failure occurs after the real session service creates its Git
  // resources.  The compensation path must remove both branch and worktree.
  const rollbackRoot = path.join(root, 'data-rollback');
  const rollbackRepo = initRepo(root, 'repo-rollback');
  const rollbackPaths = writeState(rollbackRoot, [
    { id: 'dir-rollback', name: 'rollback', path: rollbackRepo, createdAt: '2026-02-01T00:00:00Z' },
  ], []);
  const failMarker = path.join(rollbackRoot, 'inject-session-write-failure');
  fs.writeFileSync(failMarker, 'fail');
  server = await startServer({
    dataRoot: rollbackRoot,
    extraEnv: { MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE: failMarker },
  });
  response = await json(server.base, '/readyz');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body.checks.commanderMigration.failures.map(item => item.directoryId), ['dir-rollback']);
  response = await json(server.base, '/api/sessions');
  assert.equal(response.body.some(session => session.dirId === 'dir-rollback'), false);
  const rollbackWorktrees = path.join(rollbackRepo, '.multicc-worktrees');
  assert.equal(fs.existsSync(rollbackWorktrees)
    ? fs.readdirSync(rollbackWorktrees).filter(name => name !== '.gitkeep').length
    : 0, 0);
  assert.equal(execFileSync('git', ['branch', '--list', 'multicc/*'], { cwd: rollbackRepo, encoding: 'utf8' }).trim(), '');
  assert.equal(fs.existsSync(path.join(rollbackRepo, '.git', 'multicc-backups')), false,
    'creation compensation leaves no deletion backup artifact');
  const boardAttempt = await json(server.base, '/api/task-board/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirId: 'dir-rollback', text: '不得发给 AI' }),
  });
  assert.equal(boardAttempt.status, 503);
  assert.equal(boardAttempt.body.directoryId, 'dir-rollback');
  assert.equal(fs.existsSync(rollbackPaths.taskBoardFile), false, 'blocked automatic routing creates no task card');
  await stopServer(server);

  const unavailableRoot = path.join(root, 'data-unavailable');
  const unavailableRepo = initRepo(root, 'repo-unavailable');
  writeState(unavailableRoot, [
    { id: 'dir-unavailable', name: 'unavailable', path: unavailableRepo, createdAt: '2026-03-01T00:00:00Z' },
  ], []);
  server = await startServer({ dataRoot: unavailableRoot, cliAvailable: false });
  response = await json(server.base, '/readyz');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body.checks.commanderMigration.failures, [
    { directoryId: 'dir-unavailable', code: 'commander_cli_unavailable' },
  ]);
  response = await json(server.base, '/api/sessions');
  assert.equal(response.body.some(session => session.dirId === 'dir-unavailable'), false);
  await stopServer(server);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('Commander migration isolated integration tests passed');
})().catch(error => {
  for (const child of LIVE_SERVERS) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  console.error(error);
  process.exitCode = 1;
});
