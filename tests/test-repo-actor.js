'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const test = require('node:test');
const { RepoActor } = require('../src/repo-actor');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fakeRepo(root, name) {
  const dir = path.join(root, name);
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  return dir;
}

test('same repository is serialized and reports queue depth/progress', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-actor-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repo = await fakeRepo(root, 'one');
  const actor = new RepoActor();
  const events = [];
  let running = 0;

  const first = actor.run(repo, 'first', async ({ progress }) => {
    running++;
    assert.equal(running, 1);
    events.push('first:start');
    progress('halfway');
    await delay(50);
    events.push('first:end');
    running--;
    return { ok: true };
  });
  const second = actor.run(repo, 'second', async () => {
    running++;
    assert.equal(running, 1);
    events.push('second:start');
    running--;
    return { ok: true };
  });

  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  assert.equal(a.queueDepth, 1);
  assert.equal(b.queueDepth, 2);
  assert.equal(actor.status(a.operationId).status, 'completed');
  assert(actor.status(a.operationId).progress.some(p => p.phase === 'halfway'));
  await Promise.resolve();
  assert.equal(actor.queueDepth(repo), 0);
  assert.equal(actor.queues.size, 0);
});

test('different repositories run concurrently', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-actor-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repoA = await fakeRepo(root, 'a');
  const repoB = await fakeRepo(root, 'b');
  const actor = new RepoActor();
  let running = 0;
  let maxRunning = 0;
  const task = () => actor.run(repoA, 'a', async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await delay(60);
    running--;
    return { ok: true };
  });
  const one = task();
  const two = actor.run(repoB, 'b', async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await delay(60);
    running--;
    return { ok: true };
  });
  await Promise.all([one, two]);
  assert.equal(maxRunning, 2);
});

test('async git execution leaves the event loop responsive', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-actor-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repo = await fakeRepo(root, 'repo');
  let timerFired = false;
  const actor = new RepoActor({
    execFile: async () => {
      await delay(80);
      return { stdout: 'ok\n', stderr: '' };
    },
  });
  const pending = actor.runGit(repo, ['status']);
  setTimeout(() => { timerFired = true; }, 10);
  await delay(25);
  assert.equal(timerFired, true);
  assert.equal(await pending, 'ok');
});

test('failure injection releases queue and records failed operation', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-actor-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repo = await fakeRepo(root, 'repo');
  const actor = new RepoActor();
  const failed = actor.run(repo, 'explode', async () => { throw new Error('injected failure'); }, { sessionId: 's1' });
  const next = actor.run(repo, 'recover', async () => ({ ok: true }), { sessionId: 's1' });
  const error = await failed.then(() => null, value => value);
  assert(error);
  assert.equal(error.message, 'injected failure');
  assert.equal(actor.status(error.operationId).status, 'failed');
  assert.equal((await next).ok, true);
  assert.equal(actor.isLeased('s1'), null);
});

test('active check fails closed with operation metadata', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-actor-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repo = await fakeRepo(root, 'repo');
  const actor = new RepoActor();
  const error = await actor.run(repo, 'remove', async () => ({ ok: true }), {
    sessionId: 'active-session',
    activeCheck: async () => true,
  }).then(() => null, value => value);
  assert(error);
  assert.equal(error.code, 'SESSION_ACTIVE');
  assert(error.operationId);
  assert.equal(actor.status(error.operationId).status, 'failed');
  assert.equal(actor.status(error.operationId).finishedAt > 0, true);
});

test('core git/tmux adapters contain no synchronous child-process calls', () => {
  for (const file of ['src/git/service/index.js', 'src/repo-actor/index.js', 'src/git/queue.js', 'src/tmux.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(/\bexec(?:File)?Sync\b/.test(source), false, `${file} still has a sync child process`);
  }
});

test('Rust git worktree operations never hard-reset a user worktree', () => {
  const root = path.join(__dirname, '..', 'native', 'addon', 'src');
  const directory = path.join(root, 'git_service');
  const files = ['git_service.rs', ...fs.readdirSync(directory, { recursive: true })
    .filter(name => name.endsWith('.rs')).map(name => path.join('git_service', name))];
  assert.ok(files.includes(path.join('git_service', 'service_safety.rs')));
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /"reset"[\s\S]{0,40}"--hard"/, `unsafe hard reset in ${file}`);
  }
});

test('overlapping async active checks recheck the lease before starting in another repository', async () => {
  const actor = new RepoActor();
  const sessionId = 'shared-session';
  const checked = Promise.withResolvers();
  const continueCheck = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const releaseOwner = Promise.withResolvers();
  let firstRan = false;
  const first = actor.run(null, 'delayed', () => { firstRan = true; }, {
    sessionId, repoKey: 'repo-a',
    activeCheck() { checked.resolve(); return continueCheck.promise; },
  });
  await checked.promise;
  const owner = actor.run(null, 'owner', async ({ operationId }) => {
    entered.resolve(operationId);
    await releaseOwner.promise;
  }, { sessionId, repoKey: 'repo-b' });
  const ownerId = await entered.promise;
  try {
    continueCheck.resolve(false);
    await assert.rejects(first, error => error.code === 'SESSION_LEASED' &&
      error.operationId !== ownerId && actor.status(error.operationId).status === 'failed');
    assert.equal(firstRan, false);
    assert.equal(actor.isLeased(sessionId).operationId, ownerId);
  } finally {
    releaseOwner.resolve();
    await owner;
  }
  assert.equal(actor.isLeased(sessionId), null);
});

test('runGit honors an overridden run and its supplied command executor', async () => {
  const actor = new RepoActor();
  actor.run = async (cwd, kind, task) => {
    assert.equal(kind, 'override');
    return task({ execGit: async (dir, args) => {
      assert.equal(dir, cwd);
      return args.join('|');
    } });
  };
  assert.equal(await actor.runGit('unused', ['status', '--short'], {kind: 'override'}), 'status|--short');
});
