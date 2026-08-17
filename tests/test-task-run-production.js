'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createNativeFinalizer,
  createProductionTaskRunHost,
  discoverTranscriptRoots,
  findNativeRefs,
  inspectWorktree,
} = require('../src/task-run-production');

test('production recovery resumes cleanup only from the SQLite-owned exact manifest', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-resume-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, 'data');
  const ownedRoot = path.join(dataRoot, 'task-run-transcripts');
  fs.mkdirSync(ownedRoot, { recursive: true });
  const transcript = path.join(ownedRoot, 'native-1.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const permit = { runId: 'run-1', revision: 1, issuedAt: 10 };
  const run = {
    runId: 'run-1', taskId: 'task-1', slotId: 'slot-1', leaseEpoch: 7,
    executionStatus: 'succeeded', usageStatus: 'sealed', usageRevision: 1,
    sealedRevision: 1, sealedAt: 10, cleanupState: 'allowed',
  };
  const calls = [];
  const store = {
    getRun: () => ({ ...run }),
    bindRunSlot: () => ({ ...run }),
    observeUsage: () => ({}),
    getCleanupPermit: () => run.cleanupState === 'done' ? null : permit,
    markCleanup({ state }) { calls.push(`mark:${state}`); run.cleanupState = state; return { ...run }; },
    getCleanupManifest: () => ({
      runId: 'run-1', slotId: 'slot-1', leaseEpoch: 7, capturedAt: 5,
      nativeRefs: { runId: 'run-1', files: [{
        runId: 'run-1', path: transcript, kind: 'jsonl',
      }] },
    }),
    saveCleanupManifest: () => {},
  };
  const records = new Map([['slot-1', {
    id: 'slot-1', taskExecutionSlot: true,
    taskRunLease: { runId: 'run-1', leaseEpoch: 7 },
  }]]);
  const host = createProductionTaskRunHost({
    taskRunStore: store,
    dataRoot,
    records,
    directories: new Map(),
    chatStream: {
      status: () => null,
      closeAndWait: async id => calls.push(`close:${id}`),
    },
    clearNativeCliStates: () => calls.push('clear-native'),
    deleteChatHistory: id => calls.push(`history:${id}`),
    resetChatState: id => calls.push(`chat:${id}`),
    resetRoleUsage: id => calls.push(`role:${id}`),
    persistRecords: () => true,
    drainProviderProducers: async () => ({ drained: true, active: 0, ambiguous: false }),
  });
  const result = await host.resumeCleanup({
    runId: 'run-1', slotId: 'slot-1', leaseEpoch: 7,
  });
  assert.equal(result.status, 'done');
  assert.equal(fs.existsSync(transcript), false);
  assert.deepEqual(calls, [
    'mark:deleting', 'close:slot-1', 'clear-native', 'chat:slot-1', 'role:slot-1',
    'history:slot-1', 'mark:done',
  ]);
});

test('native finalizer joins producers, captures an exact manifest, then persists it', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-finalizer-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'transcripts');
  fs.mkdirSync(root, { recursive: true });
  const owned = path.join(root, 'native-1.jsonl');
  const lookalike = path.join(root, 'native-10.jsonl');
  fs.writeFileSync(owned, '{}\n');
  fs.writeFileSync(lookalike, '{}\n');
  const timeline = [];
  const record = { id: 'slot-1', cliSessionId: 'native-1' };
  let savedManifest = null;
  const finalize = createNativeFinalizer({
    roots: [root],
    taskRunStore: {
      getCleanupManifest: () => savedManifest,
      saveCleanupManifest(input) {
        timeline.push(`ledger:${input.runId}:${input.leaseEpoch}`);
        savedManifest = { ...input };
        return savedManifest;
      },
    },
    chatStream: {
      status: () => ({ busy: false, queued: 0 }),
      closeAndWait: async id => timeline.push(`native:${id}`),
    },
    drainProviderProducers: async (id, lease) => {
      timeline.push(`provider:${id}:${lease.runId}:${lease.leaseEpoch}`);
      return { drained: true, active: 0, ambiguous: false };
    },
    persistRecords: source => {
      timeline.push(`persist:${source}`);
      assert.deepEqual(record.taskRunFinalization.nativeRefs.files.map(ref => ref.path), [owned]);
      return true;
    },
    now: () => 123,
  });
  const evidence = await finalize({
    runId: 'run-1', slotId: 'slot-1', leaseEpoch: 7, record,
    event: { type: 'completed' },
  });
  assert.deepEqual(timeline, [
    'native:slot-1', 'provider:slot-1:run-1:7', 'ledger:run-1:7',
    'persist:task-run-native-manifest',
  ]);
  assert.equal(evidence.outcomeDurable, true);
  assert.equal(evidence.producersDrained, true);
  assert.equal(evidence.nativeTranscriptChecked, true);
  assert.deepEqual(evidence.nativeRefs.files.map(ref => ref.path), [owned]);
  assert.deepEqual(record.taskRunFinalization, {
    runId: 'run-1', leaseEpoch: 7, capturedAt: 123, nativeRefs: evidence.nativeRefs,
  });
});

test('native finalizer fails closed on live main work or non-durable manifest persistence', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-finalizer-fail-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'transcripts');
  fs.mkdirSync(root, { recursive: true });
  const record = { cliSessionId: 'native-1' };
  const owned = path.join(root, 'native-1.jsonl');
  fs.writeFileSync(owned, '{}\n');
  const common = {
    roots: [root],
    taskRunStore: {
      getCleanupManifest: () => null,
      saveCleanupManifest: input => input,
    },
    drainProviderProducers: async () => ({ drained: true, active: 0, ambiguous: false }),
    persistRecords: () => true,
  };
  const busy = createNativeFinalizer({
    ...common,
    chatStream: { status: () => ({ busy: true, queued: 0 }), closeAndWait: async () => {} },
  });
  await assert.rejects(
    busy({ runId: 'run-1', slotId: 'slot-1', leaseEpoch: 1, record,
      event: { type: 'completed' } }),
    error => error?.code === 'TASK_RUN_NATIVE_STREAM_BUSY',
  );

  const notDurable = createNativeFinalizer({
    ...common,
    persistRecords: () => false,
    chatStream: { status: () => null, closeAndWait: async () => {} },
  });
  await assert.rejects(
    notDurable({ runId: 'run-1', slotId: 'slot-1', leaseEpoch: 1, record,
      event: { type: 'completed' } }),
    error => error?.code === 'TASK_RUN_NATIVE_MANIFEST_PERSIST_FAILED',
  );
  assert.equal(fs.existsSync(owned), true,
    'manifest projection persistence failure must not delete a native transcript');
});

test('production transcript discovery returns only exact native ids under safe roots', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-production-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, 'data', 'multicc');
  const home = path.join(base, 'home');
  const claudeRoot = path.join(home, '.claude', 'projects');
  const codexRoot = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(path.join(claudeRoot, 'project', 'native-1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(codexRoot, '2026', '08'), { recursive: true });
  const files = [
    path.join(claudeRoot, 'project', 'native-1.jsonl'),
    path.join(claudeRoot, 'project', 'native-1', 'subagents', 'agent-a.jsonl'),
    path.join(codexRoot, '2026', '08', 'rollout-native-2.jsonl'),
  ];
  const unrelated = path.join(codexRoot, '2026', '08', 'rollout-other.jsonl');
  const substringLookalikes = [
    path.join(claudeRoot, 'project', 'native-10.jsonl'),
    path.join(codexRoot, '2026', '08', 'rollout-prefix-native-2-suffix.jsonl'),
  ];
  for (const file of [...files, unrelated, ...substringLookalikes]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  }
  const roots = discoverTranscriptRoots({ dataRoot, homeDir: home, providerHomesDir: null });
  const refs = findNativeRefs({
    record: {
      cli: 'codex', cliSessionId: 'native-2', _streamSessionId: 'native-1',
      cliStates: { claude: { cliSessionId: 'native-1' } },
    },
    roots,
    runId: 'run-1',
  });
  assert.deepEqual(new Set(refs.files.map(ref => ref.path)), new Set(files));
  assert.equal(refs.files.every(ref => ref.runId === 'run-1'), true);
  assert.equal(refs.files.some(ref => ref.path === unrelated), false);
  assert.equal(refs.files.some(ref => substringLookalikes.includes(ref.path)), false,
    'substring lookalikes must never be attributed to a run');
});

test('worktree inspection uses asynchronous git probes and fails closed on probe errors', async () => {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, cwd: options.cwd });
    const key = args.join(' ');
    const output = key === 'status --porcelain=v1' ? ''
      : key.startsWith('rev-list') ? '0\n'
        : '';
    queueMicrotask(() => callback(null, output, ''));
  };
  const record = { worktreePath: '/tmp/safe-worktree', dirId: 'dir-1' };
  const directories = new Map([['dir-1', { baseBranch: 'main' }]]);
  assert.deepEqual(await inspectWorktree(record, directories, execFile), {
    statusShort: '', dirty: false, ahead: 0, behind: 0, conflicted: false,
  });
  assert.equal(calls.length, 4);
  assert.equal(calls.every(call => call.command === 'git' && call.cwd === record.worktreePath), true);

  const failing = (_command, _args, _options, callback) => {
    queueMicrotask(() => callback(new Error('git unavailable'), '', ''));
  };
  assert.deepEqual(await inspectWorktree(record, directories, failing), {});
});
