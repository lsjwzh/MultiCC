'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamRouter } = require('../src/chat/stream-router');

function fixture() {
  const live = new Map(), closes = [];
  const lane = {
    ensure: (id, cfg) => live.set(id, { alive: true, busy: false, queued: 0, cwd: cfg.cwd }),
    status: id => live.get(id) || null,
    isAlive: id => !!live.get(id)?.alive,
    send: async () => {},
    closeAndWait: async id => { closes.push(id); live.delete(id); return { closed: true }; },
    recycle: () => ({ ok: true, applied: 'now' }),
  };
  const router = createStreamRouter(lane, lane, lane);
  const workspace = { id: 'workspace-a', path: '/tmp/workspace-a' };
  router.ensure('a', { cwd: workspace.path });
  return { router, workspace, live, closes, lane };
}

test('busy and queued children cannot be parked or handed to another writer', async () => {
  for (const state of [{ busy: true }, { queued: 1 }, { recycling: true }]) {
    const { router, workspace, live, closes } = fixture();
    Object.assign(live.get('a'), state);
    assert.equal(router.parkWorkspace('a', workspace).parked, false);
    await assert.rejects(router.claimWorkspace('b', workspace), { code: 'workspace_busy' });
    assert.deepEqual(closes, []);
  }
});

test('parking blocks ensure and send, and only a matching claim resumes the child', async () => {
  const { router, workspace, closes } = fixture();
  assert.equal(router.parkWorkspace('a', workspace).parked, true);
  await assert.rejects(router.send('a', 'unclaimed'), { code: 'workspace_busy' });
  assert.throws(() => router.ensure('a', { cwd: workspace.path }), { code: 'workspace_busy' });
  await router.claimWorkspace('a', workspace);
  await router.send('a', 'claimed');
  assert.deepEqual(closes, []);
});

test('relocation and exclusive filesystem operations join the previous child', async () => {
  const { router, workspace, closes } = fixture();
  router.parkWorkspace('a', workspace);
  await router.claimWorkspace('a', { id: 'workspace-b', path: '/tmp/workspace-b' });
  assert.deepEqual(closes, ['a']);
  router.ensure('a', { cwd: '/tmp/workspace-b' });
  router.parkWorkspace('a', { id: 'workspace-b', path: '/tmp/workspace-b' });
  await router.claimWorkspace('filesystem-owner', { id: 'workspace-b', path: '/tmp/workspace-b' }, { exclusive: true });
  assert.deepEqual(closes, ['a', 'a']);
  await assert.rejects(router.send('filesystem-owner', 'no turn lease'), { code: 'workspace_busy' });
});

test('handoff cannot proceed when process exit has not been confirmed', async () => {
  const { router, workspace, lane } = fixture();
  router.parkWorkspace('a', workspace);
  lane.closeAndWait = async () => { throw Object.assign(new Error('not stopped'), { code: 'JOIN_FAILED' }); };
  await assert.rejects(router.claimWorkspace('b', workspace), { code: 'JOIN_FAILED' });
  await assert.rejects(router.send('a', 'still fenced'), { code: 'workspace_busy' });
});

test('a send awaiting a backend barrier cannot be parked', async () => {
  const { router, workspace, lane } = fixture();
  let finish;
  lane.send = () => new Promise(resolve => { finish = resolve; });
  const sent = router.send('a', 'hello');
  assert.equal(router.parkWorkspace('a', workspace).parked, false);
  finish(); await sent;
  assert.equal(router.parkWorkspace('a', workspace).parked, true);
});

test('dead backend entries do not spend the resident process budget', () => {
  const { router, live } = fixture();
  live.get('a').alive = false;
  assert.deepEqual(router.residents(), []);
});

test('a failed close is retried after the old process exits, rather than poisoning admission', async () => {
  const { router, workspace, lane, live } = fixture();
  let closing = true, joins = 0;
  lane.isClosing = () => closing;
  lane.closeAndWait = async () => {
    joins += 1;
    live.delete('a');
    if (closing) throw Object.assign(new Error('deadline'), { code: 'CLOSE_TIMEOUT' });
    return { closed: true };
  };
  await assert.rejects(router.close('a'), { code: 'CLOSE_TIMEOUT' });
  router.residents(); // Pool observation must not lose the backend owning the exit barrier.
  await assert.rejects(router.claimWorkspace('b', workspace), { code: 'workspace_busy' });
  closing = false;
  await router.claimWorkspace('b', workspace);
  assert.equal(joins, 2);
});

test('a same-session claim retries a failed lifecycle close before sending again', async () => {
  const { router, workspace, lane, live } = fixture();
  let fail = true;
  lane.closeAndWait = async () => {
    live.delete('a');
    if (fail) throw new Error('deadline');
    return { closed: true };
  };
  await assert.rejects(router.close('a'), /deadline/);
  fail = false;
  await router.claimWorkspace('a', workspace);
  router.ensure('a', { cwd: workspace.path });
  await router.send('a', 'next');
});
