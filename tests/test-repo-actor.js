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

test('core git/tmux modules contain no synchronous child-process calls', () => {
  for (const file of ['src/git.js', 'src/git-queue.js', 'src/tmux.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(/\bexec(?:File)?Sync\b/.test(source), false, `${file} still has a sync child process`);
    if (file === 'src/git.js') {
      assert.equal(/['"]reset['"][\s\S]{0,40}['"]--hard['"]/.test(source), false,
        'merge safety must never reset --hard a user worktree');
    }
  }
});
