'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createOrchestrationRuntime } = require('../src/orchestration-runtime');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createOutbox } = require('../src/outbox');
const { createSessionGitRuntime, LOADING_MERGE_STATE } = require('../src/routes/session-git');

function temporaryState(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'orchestration.json');
}

function immediate() {
  return new Promise(resolve => setImmediate(resolve));
}

test('orchestration selectors clone only their result and idle mutations bypass serialization', async t => {
  const file = temporaryState(t, 'multicc-cpu-store-');
  const store = createOrchestrationStore({ file, now: () => 1000 });
  await store.mutate(draft => {
    draft.waits.example = { id: 'example', nested: { value: 1 } };
  });
  const before = fs.readFileSync(file, 'utf8');
  let mutationRan = false;
  const skipped = await store.mutateIf(
    () => false,
    () => { mutationRan = true; },
    () => ({ skipped: true }),
  );
  assert.deepEqual(skipped, { skipped: true });
  assert.equal(mutationRan, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'idle preflight must not rewrite durable state');

  const projection = await store.read(state => ({
    rootFrozen: Object.isFrozen(state),
    collectionFrozen: Object.isFrozen(state.waits),
    wait: state.waits.example,
  }));
  assert.equal(projection.rootFrozen, true);
  assert.equal(projection.collectionFrozen, true);
  projection.wait.nested.value = 99;
  assert.equal((await store.read(state => state.waits.example)).nested.value, 1,
    'selected values remain isolated from callers');
  assert.equal(await store.read(state => state.waits.missing), undefined,
    'selector compatibility includes an absent result');
  assert.equal(await store.read(async state => state.waits.example.id), 'example',
    'async selectors retain the original queued read contract');
  assert.equal(await store.mutateIf(() => false, () => {}), undefined,
    'an omitted idle result remains a valid no-op');
});

test('claim preflight still recovers a legacy lease without leasedUntil', async t => {
  const file = temporaryState(t, 'multicc-cpu-legacy-lease-');
  const store = createOrchestrationStore({ file, now: () => 1000 });
  const outbox = createOutbox({
    store,
    now: () => 1000,
    backoff: () => 0,
    leaseTokenFactory: () => 'stable-test-token',
  });
  await outbox.enqueue({ id: 'legacy-lease', sessionId: 'worker', payload: { text: 'work' } });
  assert.equal((await outbox.claim({ workerId: 'first' })).length, 1);
  await store.mutate(draft => { delete draft.outbox['legacy-lease'].leasedUntil; });

  const reclaimed = await outbox.claim({ workerId: 'second' });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, 'legacy-lease');
  assert.equal(reclaimed[0].attempts, 2);
});

test('busy outbox work remains pending without a lease/defer rewrite loop', async t => {
  const file = temporaryState(t, 'multicc-cpu-busy-');
  const history = new Set();
  const injections = [];
  let busy = true;
  const runtime = createOrchestrationRuntime({
    file,
    now: () => 2000,
    isBusy: () => busy,
    runChatTurn: async (_sessionId, text, options) => {
      injections.push(text);
      history.add(options.deliveryId);
      return true;
    },
    hasPersistedDelivery: async (_sessionId, deliveryId) => history.has(deliveryId),
  });
  const wait = await runtime.register({ session: 'busy-session', mode: 'callback' });
  await runtime.resolveCallback(wait.id, wait.token, 'ready');
  const before = fs.readFileSync(file, 'utf8');
  const revision = JSON.parse(before).revision;

  await runtime.tick();
  await runtime.tick();
  await runtime.tick();
  assert.equal(fs.readFileSync(file, 'utf8'), before,
    'repeated busy ticks must not rewrite the orchestration snapshot');
  const pending = await runtime.outbox.get(`wait:${wait.id}`);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.attempts, 0);
  assert.equal((await runtime.store.snapshot()).revision, revision);

  busy = false;
  await runtime.tick();
  assert.equal(injections.length, 1);
  assert.equal((await runtime.outbox.get(`wait:${wait.id}`)).state, 'delivered');
});

test('bulk merge-state refreshes are bounded, Fleet-fair, and prioritize interactive status', async () => {
  const records = new Map();
  const directories = new Map([
    ['fleet-a', { id: 'fleet-a', path: '/repo-a', baseBranch: 'main' }],
    ['fleet-b', { id: 'fleet-b', path: '/repo-b', baseBranch: 'main' }],
  ]);
  for (let index = 0; index < 8; index += 1) {
    const id = `session-${index}`;
    const dirId = index % 2 === 0 ? 'fleet-a' : 'fleet-b';
    records.set(id, {
      id,
      dirId,
      branch: `multicc/${id}`,
      worktreePath: `/${dirId}/${id}`,
    });
  }
  let calls = 0;
  let active = 0;
  let peak = 0;
  const started = [];
  const activeByDirectory = new Map();
  let peakPerDirectory = 0;
  const releases = [];
  const runtime = createSessionGitRuntime({
    records,
    directories,
    terminalSessions: new Map(),
    chatSessions: new Map(),
    gitWorktreeMergeState: async (dir, session) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      started.push(session.id);
      const directoryActive = (activeByDirectory.get(dir.id) || 0) + 1;
      activeByDirectory.set(dir.id, directoryActive);
      peakPerDirectory = Math.max(peakPerDirectory, directoryActive);
      await new Promise(resolve => releases.push(resolve));
      active -= 1;
      activeByDirectory.set(dir.id, directoryActive - 1);
      return { mergeReady: true, dirty: false, ahead: 0, behind: 0, id: session.id };
    },
    gitBaseBranch: async () => 'main',
    gitRunQueued: async () => '',
    gitMergeBack: async () => ({ ok: true }),
    gitSyncFromBase: async () => ({ ok: true }),
    gitRebaseResolve: async () => ({ ok: true }),
    appendEvent() {},
    workspaceBroadcast() {},
    existsSync: () => true,
    now: () => 1000,
    random: () => 0,
    logger: { log() {}, warn() {} },
    cacheTtlMs: 1000,
    cacheJitterMs: 0,
    maxRefreshConcurrency: 2,
  });

  for (const session of records.values()) {
    assert.deepEqual(runtime.mergeStateCached(directories.get(session.dirId), session), LOADING_MERGE_STATE);
  }
  await immediate();
  assert.equal(calls, 2, 'only the configured number of Git probes may start at once');
  runtime.mergeStateCached(
    directories.get('fleet-b'),
    records.get('session-7'),
    { priority: true },
  );

  while (calls < records.size || active > 0) {
    const batch = releases.splice(0);
    for (const release of batch) release();
    await immediate();
    await immediate();
  }
  assert.equal(calls, records.size);
  assert.equal(peak, 2);
  assert.equal(peakPerDirectory, 1, 'one Fleet cannot occupy both global slots');
  assert.ok(started.slice(2, 4).includes('session-7'),
    'interactive merge status moves queued work ahead of the background sweep');
});
