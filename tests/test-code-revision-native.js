'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defaultRepoActor } = require('../src/repo-actor');
const current = require('../src/task-routing/code-revision');
const legacy = require('./helpers/legacy-code-revision');
const { getNative } = require('../src/native/runtime');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-revision-native-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'lsjwzh'); git('config', 'user.email', 'lsjwzh@gmail.com');
  fs.writeFileSync(path.join(root, 'base'), 'base');
  git('add', '.'); git('commit', '-m', 'test(fixture): initialize revision repository');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, git };
}
const stable = ({ observedAt, operationId, ...value }) => value;
async function compare(root, options) {
  const observe = implementation => defaultRepoActor.run(root, 'revision-differential',
    ({ execGit }) => implementation.observeCodeRevision(root, execGit, options));
  assert.deepEqual(stable(await observe(current)), stable(await observe(legacy)));
  // The stopped-writer capture is a single native job; prove it byte-identical
  // against the frozen multi-step Node orchestration.
  assert.deepEqual(stable(await current.captureCodeRevision(root)), stable(await legacy.captureCodeRevision(root)));
}

test('native observations match frozen Node across clean, staged, binary and Unicode inputs', async t => {
  const f = fixture(t);
  await compare(f.root);
  fs.mkdirSync(path.join(f.root, 'nested'));
  fs.writeFileSync(path.join(f.root, 'nested/内容.txt'), 'nested content');
  for (const name of [' leading\nname.bin', '中文😀', '\ue000', 'quote"\\name']) {
    fs.writeFileSync(path.join(f.root, name), Buffer.from([0, 255, 128, 42]));
  }
  fs.writeFileSync(path.join(f.root, 'base'), 'staged'); f.git('add', 'base');
  fs.writeFileSync(path.join(f.root, 'base'), 'unstaged');
  fs.symlinkSync('missing-target', path.join(f.root, 'link'));
  const index = fs.readFileSync(path.join(f.root, '.git/index'));
  await compare(f.root);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), index);
  f.git('add', '.'); f.git('commit', '-m', 'test(fixture): persist mixed file names');
  await compare(f.root);
  fs.unlinkSync(path.join(f.root, 'base'));
  await compare(f.root);
});

test('same-size external edits with restored mtime are freshly hashed on every capture', async t => {
  const f = fixture(t), file = path.join(f.root, 'base');
  const original = await current.captureCodeRevision(f.root), stat = fs.statSync(file);
  fs.writeFileSync(file, 'edit'); fs.utimesSync(file, stat.atime, stat.mtime);
  const changed = await current.captureCodeRevision(f.root);
  assert.notEqual(changed.revision, original.revision);
  await compare(f.root);
});

test('executable modes and core.filemode=false preserve the existing digest contract', async t => {
  const f = fixture(t);
  fs.chmodSync(path.join(f.root, 'base'), 0o755);
  await compare(f.root);
  f.git('config', 'core.filemode', 'false');
  await compare(f.root);
});

test('limits, unsupported index flags and parent symlinks fail closed in both implementations', async t => {
  const f = fixture(t);
  for (const implementation of [current, legacy]) {
    await assert.rejects(defaultRepoActor.run(f.root, 'limit-test', ({ execGit }) =>
      implementation.observeCodeRevision(f.root, execGit, { maxBytes: 1 })), /code_observation_limit/);
  }
  f.git('update-index', '--assume-unchanged', 'base');
  for (const implementation of [current, legacy]) await assert.rejects(implementation.captureCodeRevision(f.root), /code_index_unsupported/);
  f.git('update-index', '--no-assume-unchanged', 'base');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'code-revision-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'file'), 'outside');
  fs.mkdirSync(path.join(f.root, 'parent')); fs.writeFileSync(path.join(f.root, 'parent/file'), 'tracked');
  f.git('add', 'parent/file');
  fs.rmSync(path.join(f.root, 'parent'), { recursive: true }); fs.symlinkSync(outside, path.join(f.root, 'parent'));
  for (const implementation of [current, legacy]) await assert.rejects(implementation.captureCodeRevision(f.root), /code_parent_unsupported/);
});

test('native file reader refuses directories and paths outside its root', async t => {
  const f = fixture(t), native = getNative();
  await assert.rejects(native.observeCodeFiles(f.root, ['../base'], [''], true, 100), /code_path_unsupported/);
  fs.mkdirSync(path.join(f.root, 'directory'));
  await assert.rejects(native.observeCodeFiles(f.root, ['directory'], [''], true, 100), /code_file_unsupported/);
});

test('gitlink observations retain their exact hash ordering and reject HEAD changes during a scan', async t => {
  const f = fixture(t);
  const head = f.git('rev-parse', 'HEAD');
  f.git('update-index', '--add', '--cacheinfo', `160000,${head},nested`);
  await compare(f.root);
  fs.mkdirSync(path.join(f.root, 'nested')); await compare(f.root);
  const git = (...args) => execFileSync('git', args, { cwd: path.join(f.root, 'nested'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'lsjwzh'); git('config', 'user.email', 'lsjwzh@gmail.com');
  fs.writeFileSync(path.join(f.root, 'nested/file'), 'nested'); git('add', '.'); git('commit', '-m', 'test(fixture): initialize nested repository');
  await compare(f.root);
  for (const implementation of [current, legacy]) {
    let headReads = 0;
    await assert.rejects(defaultRepoActor.run(f.root, 'race-test', ({ execGit }) =>
      implementation.observeCodeRevision(f.root, (cwd, args, opts) => {
        if (cwd === f.root && args[0] === 'rev-parse' && args[1] === 'HEAD' && ++headReads === 2) return Promise.resolve('changed');
        return execGit(cwd, args, opts);
      })), /code_changed_during_observation/);
  }
});
