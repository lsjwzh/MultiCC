'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  TaskRunCleanupError,
  createTaskRunCleanup,
} = require('../src/task-run-cleanup');

function tempLayout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-cleanup-'));
  const transcripts = path.join(base, 'transcripts');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, transcripts, outside };
}

function createLedger({ runId = 'run-1', slotId = 'slot-1', revision = 3,
  cleanupState = 'allowed', calls = [] } = {}) {
  const state = {
    runId,
    slotId,
    usageRevision: revision,
    sealedRevision: revision,
    sealedAt: 1_750_000_000_000,
    cleanupState,
    errorCode: null,
  };
  const permit = () => ({ runId, revision: state.sealedRevision, issuedAt: state.sealedAt });
  function assertPermit(input) {
    if (!input || input.runId !== runId || input.revision !== state.usageRevision
        || input.revision !== state.sealedRevision) {
      const error = new Error('cleanup permit is stale');
      error.code = 'TASK_RUN_CLEANUP_PERMIT_STALE';
      throw error;
    }
  }
  const store = {
    getRun(requestedRunId) {
      assert.equal(requestedRunId, runId);
      return { ...state };
    },
    getCleanupPermit(requestedRunId) {
      assert.equal(requestedRunId, runId);
      if (state.cleanupState === 'done' || state.sealedRevision == null) return null;
      return permit();
    },
    markCleanup(input) {
      assert.equal(input.runId, runId);
      assertPermit(input.permit);
      state.cleanupState = input.state;
      state.errorCode = input.errorCode || null;
      calls.push(`mark:${input.state}`);
      return { ...state };
    },
  };
  return {
    store,
    state,
    permit: permit(),
    invalidateWithLateUsage() {
      state.usageRevision += 1;
      state.sealedRevision = null;
      state.cleanupState = 'blocked';
    },
  };
}

function safeWorktree(overrides = {}) {
  return { dirty: false, ahead: 0, behind: 0, conflicted: false, ...overrides };
}

function createHarness({ t, layout, ledger, inspectWorktree = async () => safeWorktree(),
  closeNative, clearNativeState, clearChatHistory } = {}) {
  const calls = [];
  const cleanupRuntime = createTaskRunCleanup({
    taskRunStore: ledger.store,
    transcriptRoots: [layout.transcripts],
    inspectWorktree,
    closeNative: closeNative || (async ({ runId, slotId }) => {
      assert.equal(runId, 'run-1');
      assert.equal(slotId, 'slot-1');
      calls.push('close-native');
    }),
    clearNativeState: clearNativeState || (async ({ runId, slotId }) => {
      assert.equal(runId, 'run-1');
      assert.equal(slotId, 'slot-1');
      calls.push('clear-native-state');
    }),
    clearChatHistory: clearChatHistory || (async ({ runId, slotId }) => {
      assert.equal(runId, 'run-1');
      assert.equal(slotId, 'slot-1');
      calls.push('clear-chat-history');
    }),
  });
  return { cleanupRuntime, calls };
}

test('cleanup follows the fenced order, deletes only run-owned manifest files, and is idempotent', async t => {
  const layout = tempLayout(t);
  const timeline = [];
  const ledger = createLedger({ calls: timeline });
  const ownedJsonl = path.join(layout.transcripts, 'claude', 'run-1.jsonl');
  const ownedRollout = path.join(layout.transcripts, 'codex', 'rollout-run-1.jsonl');
  const otherRun = path.join(layout.transcripts, 'codex', 'rollout-run-2.jsonl');
  for (const file of [ownedJsonl, ownedRollout, otherRun]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${path.basename(file)}\n`);
  }
  const cleanupRuntime = createTaskRunCleanup({
    taskRunStore: ledger.store,
    transcriptRoots: [layout.transcripts],
    inspectWorktree: async () => safeWorktree(),
    closeNative: async () => timeline.push('close-native'),
    clearNativeState: async () => timeline.push('clear-native-state'),
    clearChatHistory: async () => timeline.push('clear-chat-history'),
  });
  const input = {
    runId: 'run-1',
    slotId: 'slot-1',
    permit: ledger.permit,
    nativeRefs: {
      runId: 'run-1',
      files: [
        { kind: 'jsonl', path: ownedJsonl },
        { kind: 'rollout', path: ownedRollout },
      ],
    },
  };

  const result = await cleanupRuntime.cleanup(input);
  assert.deepEqual(timeline, [
    'mark:deleting', 'close-native', 'clear-native-state', 'clear-chat-history', 'mark:done',
  ]);
  assert.equal(result.status, 'done');
  assert.equal(result.alreadyDone, false);
  assert.deepEqual(
    new Set(result.deleted),
    new Set([fs.realpathSync(path.dirname(ownedJsonl)) + path.sep + path.basename(ownedJsonl),
      fs.realpathSync(path.dirname(ownedRollout)) + path.sep + path.basename(ownedRollout)]),
  );
  assert.equal(fs.existsSync(ownedJsonl), false);
  assert.equal(fs.existsSync(ownedRollout), false);
  assert.equal(fs.existsSync(otherRun), true, 'an unlisted sibling run transcript is preserved');

  const timelineBeforeReplay = timeline.slice();
  const replay = await cleanupRuntime.cleanup(input);
  assert.equal(replay.status, 'done');
  assert.equal(replay.alreadyDone, true);
  assert.deepEqual(timeline, timelineBeforeReplay);
});

test('concurrent cleanup calls join one destructive claimant', async t => {
  const layout = tempLayout(t);
  const ledgerCalls = [];
  const ledger = createLedger({ calls: ledgerCalls });
  const transcript = path.join(layout.transcripts, 'run-1.jsonl');
  fs.writeFileSync(transcript, 'owned');
  let releaseInspection;
  const inspectionGate = new Promise(resolve => { releaseInspection = resolve; });
  let inspections = 0;
  const { cleanupRuntime, calls } = createHarness({
    t,
    layout,
    ledger,
    inspectWorktree: async () => {
      inspections += 1;
      await inspectionGate;
      return safeWorktree();
    },
  });
  const input = {
    runId: 'run-1', slotId: 'slot-1', permit: ledger.permit,
    nativeRefs: { runId: 'run-1', files: [{ runId: 'run-1', kind: 'jsonl', path: transcript }] },
  };
  const first = cleanupRuntime.cleanup(input);
  const second = cleanupRuntime.cleanup(input);
  releaseInspection();
  const [left, right] = await Promise.all([first, second]);
  assert.strictEqual(left, right, 'joiners receive the same immutable cleanup result');
  assert.equal(inspections, 1);
  assert.deepEqual(ledgerCalls, ['mark:deleting', 'mark:done']);
  assert.deepEqual(calls, ['close-native', 'clear-native-state', 'clear-chat-history']);
});

test('path traversal is rejected before any destructive callback and marked as cleanup error', async t => {
  const layout = tempLayout(t);
  const ledgerCalls = [];
  const ledger = createLedger({ calls: ledgerCalls });
  const outsideFile = path.join(layout.outside, 'run-1.jsonl');
  fs.writeFileSync(outsideFile, 'must survive');
  const traversalPath = `${layout.transcripts}${path.sep}nested${path.sep}..${path.sep}..`
    + `${path.sep}outside${path.sep}run-1.jsonl`;
  const { cleanupRuntime, calls } = createHarness({ t, layout, ledger });

  await assert.rejects(
    cleanupRuntime.cleanup({
      runId: 'run-1', slotId: 'slot-1', permit: ledger.permit,
      nativeRefs: { runId: 'run-1', files: [{ kind: 'jsonl', path: traversalPath }] },
    }),
    error => error instanceof TaskRunCleanupError
      && error.code === 'TASK_RUN_CLEANUP_PATH_OUTSIDE_ROOT',
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(ledgerCalls, ['mark:error']);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'must survive');
});

test('symlink targets are rejected and never unlink the link or its destination', async t => {
  const layout = tempLayout(t);
  const ledgerCalls = [];
  const ledger = createLedger({ calls: ledgerCalls });
  const outsideFile = path.join(layout.outside, 'real-run-1.jsonl');
  const link = path.join(layout.transcripts, 'run-1.jsonl');
  fs.writeFileSync(outsideFile, 'must survive');
  fs.symlinkSync(outsideFile, link);
  const { cleanupRuntime, calls } = createHarness({ t, layout, ledger });

  await assert.rejects(
    cleanupRuntime.cleanup({
      runId: 'run-1', slotId: 'slot-1', permit: ledger.permit,
      nativeRefs: { runId: 'run-1', files: [{ kind: 'jsonl', path: link }] },
    }),
    error => error.code === 'TASK_RUN_CLEANUP_SYMLINK_REFUSED',
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(ledgerCalls, ['mark:error']);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'must survive');
});

test('dirty, ahead, behind, and conflicted worktrees are quarantined without cleanup effects', async t => {
  for (const [label, report] of [
    ['dirty', safeWorktree({ dirty: true })],
    ['ahead', safeWorktree({ ahead: 1 })],
    ['behind', safeWorktree({ behind: 1 })],
    ['conflicted', safeWorktree({ conflicted: true })],
  ]) {
    await t.test(label, async subtest => {
      const layout = tempLayout(subtest);
      const ledgerCalls = [];
      const ledger = createLedger({ calls: ledgerCalls });
      const transcript = path.join(layout.transcripts, `${label}.jsonl`);
      fs.writeFileSync(transcript, 'must survive');
      const { cleanupRuntime, calls } = createHarness({
        t: subtest, layout, ledger, inspectWorktree: async () => report,
      });

      await assert.rejects(
        cleanupRuntime.cleanup({
          runId: 'run-1', slotId: 'slot-1', permit: ledger.permit,
          nativeRefs: { runId: 'run-1', files: [{ kind: 'jsonl', path: transcript }] },
        }),
        error => error.code === 'TASK_RUN_CLEANUP_WORKTREE_QUARANTINED'
          && error.quarantined === true && error.reasons.includes(label),
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(ledgerCalls, ['mark:error']);
      assert.match(ledger.state.errorCode, /QUARANTINED/);
      assert.equal(fs.existsSync(transcript), true);
    });
  }
});

test('an incomplete worktree inspection fails closed into quarantine', async t => {
  const layout = tempLayout(t);
  const ledgerCalls = [];
  const ledger = createLedger({ calls: ledgerCalls });
  const { cleanupRuntime, calls } = createHarness({
    t, layout, ledger, inspectWorktree: async () => ({}),
  });
  await assert.rejects(
    cleanupRuntime.cleanup({
      runId: 'run-1', slotId: 'slot-1', permit: ledger.permit, nativeRefs: [],
    }),
    error => error.code === 'TASK_RUN_CLEANUP_WORKTREE_QUARANTINED'
      && error.reasons.includes('inspection-invalid'),
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(ledgerCalls, ['mark:error']);
});

test('late usage invalidates the permit after native close and fences every later deletion', async t => {
  const layout = tempLayout(t);
  const ledgerCalls = [];
  const ledger = createLedger({ calls: ledgerCalls });
  const transcript = path.join(layout.transcripts, 'run-1.jsonl');
  fs.writeFileSync(transcript, 'must survive');
  const effects = [];
  const cleanupRuntime = createTaskRunCleanup({
    taskRunStore: ledger.store,
    transcriptRoots: [layout.transcripts],
    inspectWorktree: async () => safeWorktree(),
    closeNative: async () => {
      effects.push('close-native');
      ledger.invalidateWithLateUsage();
    },
    clearNativeState: async () => effects.push('clear-native-state'),
    clearChatHistory: async () => effects.push('clear-chat-history'),
  });

  await assert.rejects(
    cleanupRuntime.cleanup({
      runId: 'run-1', slotId: 'slot-1', permit: ledger.permit,
      nativeRefs: { runId: 'run-1', files: [{ kind: 'jsonl', path: transcript }] },
    }),
    error => error.code === 'TASK_RUN_CLEANUP_PERMIT_STALE',
  );
  assert.deepEqual(ledgerCalls, ['mark:deleting']);
  assert.deepEqual(effects, ['close-native']);
  assert.equal(ledger.state.cleanupState, 'blocked');
  assert.equal(fs.existsSync(transcript), true);
});

test('wrong-run and stale permits fail closed before inspection or mutation', async t => {
  const layout = tempLayout(t);
  const ledgerCalls = [];
  const ledger = createLedger({ calls: ledgerCalls });
  let inspections = 0;
  const { cleanupRuntime, calls } = createHarness({
    t, layout, ledger,
    inspectWorktree: async () => { inspections += 1; return safeWorktree(); },
  });

  await assert.rejects(
    cleanupRuntime.cleanup({
      runId: 'run-1', slotId: 'slot-1',
      permit: { ...ledger.permit, runId: 'run-other' }, nativeRefs: [],
    }),
    error => error.code === 'TASK_RUN_CLEANUP_PERMIT_RUN_MISMATCH',
  );
  await assert.rejects(
    cleanupRuntime.cleanup({
      runId: 'run-1', slotId: 'slot-1',
      permit: { ...ledger.permit, revision: ledger.permit.revision - 1 }, nativeRefs: [],
    }),
    error => error.code === 'TASK_RUN_CLEANUP_PERMIT_STALE',
  );
  assert.equal(inspections, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(ledgerCalls, []);
});

test('callback failures stop the pipeline and persist cleanup error state', async t => {
  const layout = tempLayout(t);
  const ledgerCalls = [];
  const ledger = createLedger({ calls: ledgerCalls });
  const transcript = path.join(layout.transcripts, 'run-1.jsonl');
  fs.writeFileSync(transcript, 'must survive');
  const effects = [];
  const cleanupRuntime = createTaskRunCleanup({
    taskRunStore: ledger.store,
    transcriptRoots: [layout.transcripts],
    inspectWorktree: async () => safeWorktree(),
    closeNative: async () => effects.push('close-native'),
    clearNativeState: async () => { effects.push('clear-native-state'); throw new Error('state clear failed'); },
    clearChatHistory: async () => effects.push('clear-chat-history'),
  });

  await assert.rejects(
    cleanupRuntime.cleanup({
      runId: 'run-1', slotId: 'slot-1', permit: ledger.permit,
      nativeRefs: { runId: 'run-1', files: [{ kind: 'jsonl', path: transcript }] },
    }),
    error => error.code === 'TASK_RUN_CLEANUP_EFFECT_FAILED' && error.stage === 'clear-native-state',
  );
  assert.deepEqual(effects, ['close-native', 'clear-native-state']);
  assert.deepEqual(ledgerCalls, ['mark:deleting', 'mark:error']);
  assert.equal(ledger.state.cleanupState, 'error');
  assert.equal(fs.existsSync(transcript), true);
});

test('factory rejects root, home, temp, relative, and symlink transcript roots', t => {
  const layout = tempLayout(t);
  const ledger = createLedger();
  const deps = {
    taskRunStore: ledger.store,
    closeNative: async () => {},
    clearNativeState: async () => {},
    clearChatHistory: async () => {},
    inspectWorktree: async () => safeWorktree(),
  };
  for (const unsafeRoot of [path.parse(layout.transcripts).root, os.homedir(), os.tmpdir(), 'relative/path']) {
    assert.throws(
      () => createTaskRunCleanup({ ...deps, transcriptRoots: [unsafeRoot] }),
      error => error.code === 'TASK_RUN_CLEANUP_ROOT_UNSAFE',
    );
  }
  const realRoot = path.join(layout.base, 'real-transcripts');
  const rootLink = path.join(layout.base, 'linked-transcripts');
  fs.mkdirSync(realRoot);
  fs.symlinkSync(realRoot, rootLink);
  assert.throws(
    () => createTaskRunCleanup({ ...deps, transcriptRoots: [rootLink] }),
    error => error.code === 'TASK_RUN_CLEANUP_ROOT_UNSAFE',
  );
});
