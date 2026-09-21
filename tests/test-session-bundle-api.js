'use strict';

// Isolated HTTP integration for encrypted session handoff. The test creates
// only Git commits; it never starts an AI CLI or touches the real data root.

const assert = require('assert');
const crypto = require('crypto');
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
// Two distinct fake credentials: one sits on the source machine's disk (must
// not be carried), one only ever exists inside a hand-built legacy bundle (must
// not be re-planted by the import).
const RESIDUE_SECRET = 'sk-legacy-source-provider-token';
const LEGACY_SECRET = 'sk-legacy-bundle-payload-token';
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

// The bundle cipher, reimplemented here so the test can read the payload the
// server produced and hand-build legacy payloads for the compatibility cases.
function bundleKey(passphrase, saltB64) {
  return crypto.pbkdf2Sync(passphrase, Buffer.from(saltB64, 'base64'), 200000, 32, 'sha256');
}

function decryptBundle(enc, passphrase) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', bundleKey(passphrase, enc.salt),
    Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function encryptBundle(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', bundleKey(passphrase, salt.toString('base64')), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return { salt: salt.toString('base64'), iv: iv.toString('base64'),
           ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

// Any file under `root` whose text contains `needle` — the blunt end-to-end
// check that a secret never reached the imported session's disk footprint.
function treeContaining(root, needle) {
  const hits = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
      if (text.includes(needle)) hits.push(abs);
    }
  };
  walk(root);
  return hits;
}

// Booting a real server in this fixture is slow on a loaded machine (local ASR
// warm-up alone is ~5s), and the fixture restarts it several times, so both the
// readiness window and the shutdown grace are deliberately generous.
async function waitForServer() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { stderr += chunk.toString(); });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 20000))]);
  // A surviving process would keep the port and silently starve the next boot.
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
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
  // The source transcript carries the full machine-local attribution family (a
  // real one does: taskName/taskShortCode/auxRunId ride next to taskId), plus an
  // assistant prefix pair the source kept only because both entries were
  // task-referenced. Import must drop every stamp without losing the pair.
  const firstReply = '第一段回复：这是一段足够长的前缀内容，用于命中重试去重的前缀包含判定。';
  const secondReply = `${firstReply}第二段补充说明。`;
  const sourceStamps = { taskId: 'tsk-source-machine-only', taskName: '源机器任务',
                         taskShortCode: 'Z9X8', taskStart: true, taskSource: 'aux',
                         taskText: '源机器的任务文本', auxRunId: 'aux-run-source' };
  const sourceHistory = [
    { id: 'm-asset-1', role: 'user', ts: Date.now(), ...sourceStamps, content: `看这张截图 ${uploadPath}` },
    { id: 'm-reply-1', role: 'assistant', ts: Date.now(), ...sourceStamps, content: firstReply },
    { id: 'm-reply-2', role: 'assistant', ts: Date.now(), ...sourceStamps, content: secondReply },
  ];
  await fs.promises.writeFile(path.join(dataRoot, 'chat_history', `${sourceId}.json`),
    `${sourceHistory.map(message => JSON.stringify(message)).join('\n')}\n`);
  // The source session's own memory folder: one ordinary note (must travel) and
  // a `.handoff-provider.json` left there by an older release (must NOT travel —
  // it holds the sender's credential values and no code ever reads it back).
  const sourceMemDir = path.join(memoryRoot, dirId, 'sessions', sourceId);
  await fs.promises.mkdir(sourceMemDir, { recursive: true });
  await fs.promises.writeFile(path.join(sourceMemDir, 'source-notes.md'), 'source memory content\n');
  await fs.promises.writeFile(path.join(sourceMemDir, '.handoff-provider.json'), JSON.stringify({
    sourceProviderId: null, sourceProviderName: 'Legacy Zhipu GLM',
    env: { ANTHROPIC_AUTH_TOKEN: RESIDUE_SECRET, ANTHROPIC_BASE_URL: 'https://legacy.invalid' },
    codexFiles: { 'auth.json': '{"OPENAI_API_KEY":"' + RESIDUE_SECRET + '"}' },
  }, null, 2));
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
  // Source-machine task attribution must not ride along: on the target it names
  // nonexistent tasks (or, on a same-instance re-import, pins live ones).
  for (const field of ['taskId', 'taskName', 'taskShortCode', 'taskStart', 'taskSource', 'taskText', 'auxRunId']) {
    assert.ok(!importedHistory.includes(`"${field}"`), `imported messages must not carry source ${field} stamps`);
  }
  // ...and the strip must not cost a message: the source archive keeps three
  // entries, including the prefix pair that only survived locally because both
  // carried a taskId.
  const importedMessages = importedHistory.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(importedMessages.length, 3, 'import must keep the whole source archive');
  assert.ok(importedMessages.some(m => m.content === firstReply), 'the prefix reply survives import');
  assert.ok(importedMessages.some(m => m.content === secondReply), 'the superset reply survives import');
  assert.ok(!importedHistory.includes(uploadPath), 'old temp path must be rewritten');
  const rewritten = importedHistory.match(/(\/[^"'\n]*multicc_handoff_[^"'\n]*\.png)/);
  assert.ok(rewritten, 'imported history references the restored asset');
  assert.deepEqual(fs.readFileSync(rewritten[1]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  assert.match(handoffDoc, /multicc_handoff_/);
  assert.match(handoffDoc, new RegExp(uploadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  fs.rmSync(rewritten[1], { force: true });

  // ── Provider state must not travel, in either direction ──
  // Export: the payload carries no providerState and no provider env key names,
  // and the legacy dotfile in the source memory folder is not carried as a
  // memory file (ordinary memory still is).
  const exportedPayload = decryptBundle({ salt, iv, ct, tag }, PASSPHRASE);
  assert.ok(!('providerState' in exportedPayload), 'payload must not carry providerState');
  assert.ok(!('envKeys' in (exportedPayload.contextDeps || {})), 'contextDeps must not carry provider env key names');
  assert.equal(exportedPayload.memoryFiles['source-notes.md'], 'source memory content\n',
    'ordinary source memory still travels');
  assert.ok(!Object.keys(exportedPayload.memoryFiles).some(name => name.startsWith('.')),
    'dotfiles in a memory folder must not ride along: ' + Object.keys(exportedPayload.memoryFiles).join(','));
  assert.ok(!JSON.stringify(exportedPayload).includes(RESIDUE_SECRET),
    'the credential value sitting in the source memory folder must not reach the payload at all');
  // Import: nothing provider-shaped lands in the imported session's memory, and
  // the source credential never exists anywhere under the memory root on this machine.
  const importedMemDir = path.join(memoryRoot, dirId, 'sessions', importedId);
  assert.ok(fs.existsSync(path.join(importedMemDir, 'source-notes.md')), 'imported memory keeps ordinary files');
  assert.ok(!fs.existsSync(path.join(importedMemDir, '.handoff-provider.json')),
    'import must not write .handoff-provider.json');
  assert.deepEqual(treeContaining(memoryRoot, RESIDUE_SECRET), [
    path.join(sourceMemDir, '.handoff-provider.json'),
  ], 'the source credential exists only in the fixture that planted it');
  assert.ok(!handoffDoc.includes('.handoff-provider.json'), 'HANDOFF.md must not point at a provider file');
  assert.match(handoffDoc, /Provider 不随包传播/, 'HANDOFF.md must state that provider state does not travel');

  // Legacy bundle (exported by a release that still carried provider state, and
  // whose memory folder held the plaintext file): it must still import, must be
  // accepted, and must leave none of it behind.
  const legacyPayload = {
    ...exportedPayload,
    providerState: { providerId: 'legacy-provider', providerName: 'Legacy Zhipu GLM',
                     env: { ANTHROPIC_AUTH_TOKEN: LEGACY_SECRET }, codexFiles: { 'auth.json': '{}' } },
    contextDeps: { ...exportedPayload.contextDeps, envKeys: ['ANTHROPIC_AUTH_TOKEN'] },
    memoryFiles: { ...exportedPayload.memoryFiles,
                   '.handoff-provider.json': JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: LEGACY_SECRET } }) },
    gitBundleB64: null,
    gitBundleNote: 'no git payload in legacy fixture',
  };
  response = await api('POST', '/api/sessions/import',
    { ...encryptBundle(legacyPayload, PASSPHRASE), passphrase: PASSPHRASE, dirId, label: 'Legacy bundle' });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const legacyId = response.data.sessionId;
  const legacyMemDir = path.join(memoryRoot, dirId, 'sessions', legacyId);
  assert.equal(await fs.promises.readFile(path.join(legacyMemDir, 'source-notes.md'), 'utf8'),
    'source memory content\n');
  assert.ok(!fs.existsSync(path.join(legacyMemDir, '.handoff-provider.json')),
    'a legacy bundle must not re-plant the provider file');
  assert.deepEqual(treeContaining(memoryRoot, LEGACY_SECRET), [],
    'a legacy bundle must not re-plant the source provider credential');

  // The archive marker must survive a boot: every start re-runs normalize over
  // the on-disk transcript, and an unprotected pair would collapse on that read
  // even though the import itself got it right.
  await stopServer();
  await startServer();
  const afterRestart = (await api('GET', `/api/sessions/${importedId}/history`)).data;
  assert.equal((afterRestart.messages || []).length, 3, 'the source archive survives a restart read');

  // ── v3 zip transport: export real zip bytes → import-zip end-to-end ──
  const { readZip } = require('../src/session/handoff-zip');
  const zipResponse = await fetch(
    `${BASE}/api/sessions/${sourceId}/bundle.zip?passphrase=${encodeURIComponent(PASSPHRASE)}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(zipResponse.status, 200);
  assert.match(zipResponse.headers.get('content-type') || '', /zip/);
  // The download filename rides in the clear — browser download history, proxy
  // logs, a mail attachment — so it must not name the source session; the
  // container's plaintext-summary promise covers the header too.
  const disposition = zipResponse.headers.get('content-disposition') || '';
  assert.ok(!disposition.includes(sourceId),
    `zip download name must not leak the source session id: ${disposition}`);
  assert.match(disposition, /filename="multicc-handoff-\d{8}-\d{6}\.zip"/, disposition);
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
  // The v3 manifest is the same payload: no provider state, no env key names.
  const zipManifest = decryptBundle(
    JSON.parse(zipEntries.find(e => e.name === 'manifest.json').data.toString('utf8')), PASSPHRASE);
  assert.ok(!('providerState' in zipManifest), 'zip manifest must not carry providerState');
  assert.ok(!('envKeys' in (zipManifest.contextDeps || {})), 'zip manifest must not carry provider env key names');
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
  assert.ok(!fs.existsSync(path.join(memoryRoot, dirId, 'sessions', zipId, '.handoff-provider.json')),
    'zip import must not write .handoff-provider.json either');
  // The replayed commit landed in the zip-imported worktree too.
  assert.equal(await fs.promises.readFile(
    path.join(project, '.multicc-worktrees', zipId, 'session-feature.txt'), 'utf8'), 'session feature\n');
  const zipHistory = await fs.promises.readFile(
    path.join(dataRoot, 'chat_history', `${zipId}.json`), 'utf8');
  for (const field of ['taskId', 'taskName', 'taskShortCode', 'auxRunId']) {
    assert.ok(!zipHistory.includes(`"${field}"`), `zip-imported messages must not carry source ${field} stamps`);
  }
  assert.equal(zipHistory.trim().split('\n').length, 3, 'zip import keeps the whole source archive');
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
  // dispose every task this fixture produced (the room and both imports, which
  // attribution adopts once they have content), then the directory.
  await git(sourceWorktree, ['reset', '--hard', await git(project, ['rev-parse', 'HEAD'])]);
  const fixtureSessionIds = new Set([sourceId, importedId, legacyId, zipId]);
  const board = await api('GET', '/api/task-board');
  const ownedTasks = Object.values(board.data.tasks || {})
    .filter(task => fixtureSessionIds.has(task.chatSessionId));
  assert.ok(ownedTasks.some(task => task.chatSessionId === sourceId), 'the seeded room was adopted into a board task');
  for (const task of ownedTasks) {
    // force also releases each imported chat's own unmerged fixture branch.
    response = await api('DELETE', `/api/task-board/tasks/${task.id}`, { force: true });
    assert.equal(response.status, 200, JSON.stringify(response.data));
  }
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
