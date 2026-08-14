'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatHistoryService } = require('../src/session/chat-history-service');
const { projectHistoryUsage } = require('../src/codex-usage');
const { createLivenessRuntime } = require('../src/liveness/runtime');
const { createOrchestrationRuntime } = require('../src/orchestration-runtime');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createOutbox } = require('../src/outbox');
const { createProcessProbe } = require('../src/liveness/process-probe');
const { createRolloutPathResolver } = require('../src/liveness/rollout-path');
const { createSessionGitRuntime, LOADING_MERGE_STATE } = require('../src/routes/session-git');

function temporaryState(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'orchestration.json');
}

function immediate() {
  return new Promise(resolve => setImmediate(resolve));
}

function historyServiceHarness() {
  let stored = [];
  const writes = [];
  let ids = 0;
  const service = createChatHistoryService({
    history: {
      read: () => stored,
      write: (_sessionId, messages) => { writes.push(messages); stored = messages; },
      deleteSession: () => true,
      hasPersistedDelivery: () => false,
    },
    idFactory: () => `m${++ids}`,
    clock: () => 1000,
  });
  return { service, writes };
}

test('transcript writes reuse the stored messages instead of deep-cloning them', () => {
  // Every mutation used to deep-clone the whole transcript three times over —
  // once to read a working copy, once for the returned `messages`, once for the
  // cache — on top of the serialization the durable write already performs. The
  // streaming interim timer runs this per session for the length of every turn,
  // so on a large transcript it was seconds of event-loop time spent copying
  // messages that nobody mutates. Reference identity across writes is the proof
  // that no deep clone survives on the hot path.
  const { service, writes } = historyServiceHarness();
  service.append('s1', { role: 'user', content: 'first' });
  service.append('s1', { role: 'assistant', content: 'second' });
  const afterSecond = writes.at(-1);
  service.append('s1', { role: 'user', content: 'third' });
  const afterThird = writes.at(-1);

  assert.equal(afterThird.length, 3);
  assert.notEqual(afterThird, afterSecond, 'each write gets its own array');
  assert.equal(afterThird[0], afterSecond[0], 'existing messages are shared, not re-cloned');
  assert.equal(afterThird[1], afterSecond[1], 'existing messages are shared, not re-cloned');

  // The same has to hold for the interim path, which is the one that fires
  // repeatedly while a turn streams.
  service.upsertInterim('s1', { role: 'assistant', content: 'streaming…' });
  const afterInterim = writes.at(-1);
  assert.equal(afterInterim[0], afterThird[0], 'an interim save does not re-clone the transcript');
});

test('reading the transcript to page or measure it does not clone the whole thing', () => {
  // The WS replay on connect paged out five messages and totalled a codex
  // session's token usage; both went through read(), which deep-clones the
  // entire transcript. Reconnects arrive at a few per second across a fleet, so
  // two full clones per connect was enough to saturate a core on its own.
  // view() is the read-only path that makes those callers cheap — and its
  // contract is exactly that it does NOT copy.
  const { service } = historyServiceHarness();
  service.append('s1', { role: 'user', content: 'first' });
  service.append('s1', { role: 'assistant', content: 'second' });

  const view = service.view('s1');
  const copy = service.read('s1');
  assert.deepEqual(view, copy, 'the view sees the same transcript read() does');
  assert.equal(view[0], service.view('s1')[0], 'view returns the cached messages, uncopied');
  assert.notEqual(copy[0], view[0], 'read() still hands back an isolated clone');

  // The isolation callers rely on has to come from somewhere: a mutation must
  // not be visible through a view someone already took, or a paged response
  // could change under a client mid-request.
  service.append('s1', { role: 'user', content: 'third' });
  assert.equal(view.length, 2, 'an existing view is not extended by later writes');
});

test('a mutation result still exposes an isolated transcript, but only if read', () => {
  const { service } = historyServiceHarness();
  service.append('s1', { role: 'user', content: 'first' });
  const result = service.append('s1', { role: 'assistant', content: 'second' });

  // Lazy, but indistinguishable from the eager deep clone it replaced.
  assert.equal(Array.isArray(result.messages), true);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages, result.messages, 'repeated reads return the same array');
  assert.equal(Object.isFrozen(result), true, 'the result object is still frozen');

  result.messages[0].content = 'tampered';
  assert.equal(service.read('s1')[0].content, 'first', 'the caller cannot reach into the transcript');

  // A later mutation must not retroactively change an already-returned result.
  service.append('s1', { role: 'user', content: 'third' });
  assert.equal(result.messages.length, 2, 'the result is a snapshot of its own commit');
});

test('history usage projection copies on write instead of cloning the transcript', () => {
  // Reference identity is the load-bearing assertion: a message the projection
  // does not rewrite must come back as the very same object. Deep-cloning the
  // array to isolate the output (JSON.parse(JSON.stringify(messages))) would
  // serialize every message's content on every history read and block the event
  // loop for seconds on a large transcript.
  const bulky = { blob: 'x'.repeat(4096) };
  const history = [
    { id: 'u1', role: 'user', content: bulky },
    { id: 'a1', role: 'assistant', content: bulky, usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 } },
    { id: 'a2', role: 'assistant', content: bulky, usage: { input_tokens: 30, cached_input_tokens: 0, output_tokens: 12, total_tokens: 42 } },
    { id: 'a3', role: 'assistant', content: bulky, usage: { output_tokens: 3 }, usageCumulative: { input_tokens: 30, output_tokens: 12 }, usageEpoch: 'e1' },
    { id: 's1', role: 'system', content: bulky },
  ];
  const projected = projectHistoryUsage(history);

  assert.equal(projected.length, history.length);
  assert.equal(projected[0], history[0], 'a user message passes through by reference');
  assert.equal(projected[4], history[4], 'a system message passes through by reference');
  assert.notEqual(projected[1], history[1], 'a rewritten message is copied, never mutated in place');
  assert.equal(projected[1].content, history[1].content, 'the copy shares content instead of duplicating it');

  // The projection's actual job still has to work, and the source must survive.
  assert.equal(projected[2].usage.input_tokens, 20, 'cumulative snapshots still become per-turn deltas');
  assert.equal(history[2].usage.input_tokens, 30, 'projection never mutates persisted history');
  assert.equal(projected[3].usageCumulative, undefined, 'private baselines are stripped from the projection');
  assert.ok(history[3].usageCumulative, 'private baselines survive on the source message');
});

test('liveness only pays for the process probe when it can change the verdict', async () => {
  const probed = [];
  function runtimeFor(chat, { proxy } = {}) {
    const rt = createLivenessRuntime({
      now: () => 10_000_000,
      records: new Map([['s1', { id: 's1' }]]),
      chatSessions: new Map([['s1', chat]]),
      thresholds: { stallSilentMs: 180_000, proxyActiveMs: 90_000 },
      probeSession: async id => { probed.push(id); return { hasOutboundConnection: true }; },
    });
    if (proxy) rt.recordProxyActivity({ sessionId: 's1', phase: proxy, at: 10_000_000 });
    return rt;
  }

  // Fresh proxy traffic already proves work — verdict() returns before it ever
  // reads the probe, so forking lsof here is pure waste.
  const streaming = { isStreaming: true, heartbeatSilentMs: 1_000 };
  assert.equal((await runtimeFor(streaming, { proxy: 'first_byte' }).assess('s1')).state, 'working');
  assert.deepEqual(probed, [], 'a proxy-backed session that is streaming is not probed');

  // An in-flight turn with a live heartbeat phase is `working` either way.
  assert.equal((await runtimeFor({ ...streaming, currentTask: { phase: 'thinking' } }).assess('s1')).state, 'working');
  assert.deepEqual(probed, [], 'a phase-reporting in-flight turn is not probed');

  // Past the stall threshold the probe is the only thing separating working
  // from stalled, so it must still run.
  assert.equal((await runtimeFor({ isStreaming: true, heartbeatSilentMs: 999_999 }).assess('s1')).state, 'working');
  assert.deepEqual(probed, ['s1'], 'a silent in-flight turn is probed to rule out a stall');

  // No turn and no proxy traffic: only the probe can spot a direct-login
  // session that is quietly working.
  probed.length = 0;
  assert.equal((await runtimeFor({}).assess('s1')).state, 'working');
  assert.deepEqual(probed, ['s1'], 'a session with no host-visible turn is probed');

  // An unknown session cannot produce a verdict the probe would inform.
  probed.length = 0;
  assert.equal((await runtimeFor({}).assess('nope')).state, 'unknown');
  assert.deepEqual(probed, [], 'an unknown session is never probed');
});

test('concurrent and repeated outbound probes of one pid collapse onto a single lsof', async () => {
  let forks = 0;
  let t = 1_000_000;
  const probe = createProcessProbe({
    execFile: (_cmd, _args, _opts, cb) => { forks += 1; setImmediate(() => cb(null, '', '')); },
    statMtimeMs: () => null,
    now: () => t,
    outboundTtlMs: 4_000,
  });

  // Every visible session polls liveness on its own timer, so the same CLI pid
  // is asked for repeatedly and concurrently.
  await Promise.all([probe.outboundHttps(4242), probe.outboundHttps(4242), probe.outboundHttps(4242)]);
  assert.equal(forks, 1, 'concurrent probes of one pid share the in-flight lsof');
  await probe.outboundHttps(4242);
  assert.equal(forks, 1, 'a repeat inside the TTL is served from the memo');
  await probe.outboundHttps(99);
  assert.equal(forks, 2, 'a different pid is still probed');

  t += 5_000;
  await probe.outboundHttps(4242);
  assert.equal(forks, 3, 'the memo expires so liveness cannot go stale');
});

test('rollout path lookups do not re-walk the codex sessions tree on every poll', () => {
  let walks = 0;
  let t = 1_000_000;
  const existing = new Set(['/codex/sessions', '/codex/sessions/2026/roll-abc.jsonl']);
  const resolver = createRolloutPathResolver({
    fs: {
      existsSync: p => existing.has(p),
      readdirSync: dir => {
        walks += 1;
        if (dir === '/codex/sessions') return [{ name: '2026', isDirectory: () => true, isFile: () => false }];
        return [{ name: 'roll-abc.jsonl', isDirectory: () => false, isFile: () => true }];
      },
    },
    path,
    sessionsDirFor: () => '/codex/sessions',
    now: () => t,
    missTtlMs: 30_000,
  });
  const record = { id: 's1', cli: 'codex', cliSessionId: 'abc' };

  assert.equal(resolver.resolve(record), path.join('/codex/sessions/2026', 'roll-abc.jsonl'));
  const afterFirst = walks;
  assert.ok(afterFirst > 0, 'the first lookup has to scan');
  for (let i = 0; i < 5; i += 1) resolver.resolve(record);
  assert.equal(walks, afterFirst, 'a resolved path is revalidated, not rediscovered');

  // The file rotating away invalidates the memo rather than pinning a dead path.
  existing.delete('/codex/sessions/2026/roll-abc.jsonl');
  resolver.resolve(record);
  assert.ok(walks > afterFirst, 'a vanished rollout triggers a fresh scan');

  // A session whose rollout does not exist yet must not re-walk on every poll,
  // but must still pick the file up once it appears.
  const pending = { id: 's2', cli: 'codex', cliSessionId: 'zzz' };
  const beforeMiss = walks;
  assert.equal(resolver.resolve(pending), null);
  const afterMiss = walks;
  assert.ok(afterMiss > beforeMiss, 'the first miss scans');
  resolver.resolve(pending);
  resolver.resolve(pending);
  assert.equal(walks, afterMiss, 'a miss is not re-walked inside the retry window');
  t += 31_000;
  resolver.resolve(pending);
  assert.ok(walks > afterMiss, 'the retry window expires so a late rollout is still found');

  // Non-codex sessions never touch the filesystem at all.
  const quiet = walks;
  assert.equal(resolver.resolve({ id: 's3', cli: 'claude', cliSessionId: 'abc' }), null);
  assert.equal(resolver.resolve(null), null);
  assert.equal(walks, quiet, 'a non-codex session is not scanned');
});

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
