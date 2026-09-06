'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { exportSources } = require('../scripts/build-task-shell-image');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-docker-export-'));
  const root = path.join(dir, 'source'), out = path.join(dir, 'export');
  fs.mkdirSync(root); fs.mkdirSync(out);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  const write = (file, content) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  for (const f of ['package-lock.json', 'docker/task-shell/Dockerfile', 'docker/task-shell/run-tests.js']) write(f, '{}');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, out, git, write, dir };
}
test('Docker export contains tracked worktree edits; excludes untracked secrets, runtime state and Git metadata', t => {
  const f = fixture(t);
  f.write('server.js', 'original'); f.git('add', 'server.js'); f.write('server.js', 'current edit');
  f.write('local-secret.txt', 'private');
  for (const file of ['.env', '.codex/auth.json', 'providers.json', 'node_modules/private/index.js']) { f.write(file, 'private'); f.git('add', '-f', file); }
  const manifest = exportSources(f.root, f.out);
  assert.equal(fs.readFileSync(path.join(f.out, 'server.js'), 'utf8'), 'current edit');
  for (const file of ['.git', '.env', '.codex', 'providers.json', 'node_modules', 'local-secret.txt']) assert.equal(fs.existsSync(path.join(f.out, file)), false, file);
  assert.match(manifest.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files, 4);
});
test('Docker export rejects tracked symlinks to host files', t => {
  const f = fixture(t);
  const privateFile = path.join(f.dir, 'private'); fs.writeFileSync(privateFile, 'private');
  fs.symlinkSync(privateFile, path.join(f.root, 'leak')); f.git('add', 'leak');
  assert.throws(() => exportSources(f.root, f.out), /regular file inside/);
});
test('fake Codex emits usable independent native identities without a real model', () => {
  const binary = path.join(__dirname, '../docker/task-shell/fake-codex.js');
  const output = execFileSync(process.execPath, [binary, 'exec', '--json', 'hello'], {
    env: { PATH: process.env.PATH, MULTICC_SESSION_ID: 'isolated-test' }, encoding: 'utf8',
  }).trim().split('\n').map(JSON.parse);
  assert.equal(output[0].thread_id, 'lab-isolated-test');
  assert.equal(output.at(-1).type, 'turn.completed');
  assert.match(output[1].item.text, /未调用真实模型/);
});
