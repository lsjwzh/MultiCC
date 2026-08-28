'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskRunCleanup } = require('./task-run-cleanup');
const { createTaskRunHost } = require('./task-run-host');

const MAX_SCAN_ENTRIES = 100_000;

function realDirectories(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    try {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      unique.set(fs.realpathSync(candidate), candidate);
    } catch (_) { /* unavailable provider homes are simply absent */ }
  }
  return [...unique.values()];
}

function discoverTranscriptRoots({
  dataRoot,
  homeDir = os.homedir(),
  providerHomesDir = null,
  codexSessionHomesDir = null,
} = {}) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) throw new TypeError('absolute dataRoot required');
  const ownedRoot = path.join(dataRoot, 'task-run-transcripts');
  fs.mkdirSync(ownedRoot, { recursive: true, mode: 0o700 });
  const candidates = [
    ownedRoot,
    path.join(homeDir, '.claude', 'projects'),
    path.join(homeDir, '.codex', 'sessions'),
  ];
  if (providerHomesDir && fs.existsSync(providerHomesDir)) {
    for (const entry of fs.readdirSync(providerHomesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        candidates.push(path.join(providerHomesDir, entry.name, 'sessions'));
      }
    }
  }
  if (codexSessionHomesDir) {
    fs.mkdirSync(codexSessionHomesDir, { recursive: true, mode: 0o700 });
    candidates.push(codexSessionHomesDir);
  }
  return realDirectories(candidates);
}

function nativeIds(record) {
  const ids = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (text && text.length <= 256 && !/[\/\0]/.test(text)) ids.add(text);
  };
  add(record?.cliSessionId);
  add(record?._streamSessionId);
  for (const state of Object.values(record?.cliStates || {})) {
    add(state?.cliSessionId);
    add(state?.streamSessionId);
  }
  return ids;
}

function findNativeRefs({ record, roots, runId, fsImpl = fs } = {}) {
  const ids = nativeIds(record);
  const files = new Map();
  if (!ids.size) return { runId, files: [] };
  let inspected = 0;
  for (const root of roots || []) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      const entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        inspected += 1;
        if (inspected > MAX_SCAN_ENTRIES) {
          const error = new Error('native transcript scan limit exceeded');
          error.code = 'TASK_RUN_TRANSCRIPT_SCAN_LIMIT';
          throw error;
        }
        if (entry.isSymbolicLink()) continue;
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(candidate);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
        const relativeParts = path.relative(root, candidate).split(path.sep);
        const parentParts = relativeParts.slice(0, -1);
        const stem = entry.name.slice(0, -'.jsonl'.length);
        const owned = [...ids].some(id => parentParts.includes(id)
          || stem === id
          || (stem.startsWith('rollout-') && stem.endsWith(`-${id}`)));
        if (!owned) continue;
        files.set(candidate, {
          runId,
          path: candidate,
          kind: entry.name.toLowerCase().startsWith('rollout-') ? 'rollout' : 'jsonl',
        });
      }
    }
  }
  const ordered = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  return { runId, files: ordered };
}

function finalizationError(message, code, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function immutableManifest(manifest) {
  return Object.freeze({
    runId: manifest.runId,
    files: Object.freeze(manifest.files.map(ref => Object.freeze({ ...ref }))),
  });
}

function createNativeFinalizer({
  roots,
  taskRunStore,
  chatStream,
  drainProviderProducers,
  persistRecords,
  now = Date.now,
} = {}) {
  if (!Array.isArray(roots) || !roots.length) throw new TypeError('transcript roots required');
  if (!taskRunStore || typeof taskRunStore.saveCleanupManifest !== 'function'
      || typeof taskRunStore.getCleanupManifest !== 'function') {
    throw new TypeError('durable cleanup manifest store required');
  }
  if (!chatStream || typeof chatStream.status !== 'function'
      || typeof chatStream.closeAndWait !== 'function') {
    throw new TypeError('joinable chatStream port required');
  }
  if (typeof drainProviderProducers !== 'function') {
    throw new TypeError('provider producer drain port required');
  }
  if (typeof persistRecords !== 'function') throw new TypeError('persistRecords port required');

  return async function finalizeNativeRun({ runId, slotId, leaseEpoch, record, event } = {}) {
    if (event?.type !== 'completed') {
      throw finalizationError('terminal outcome is not durable', 'TASK_RUN_OUTCOME_NOT_DURABLE');
    }
    const streamState = chatStream.status(slotId);
    if (streamState && (streamState.busy || Number(streamState.queued || 0) > 0
        || streamState.recycling)) {
      throw finalizationError('native stream still owns live work', 'TASK_RUN_NATIVE_STREAM_BUSY');
    }
    await chatStream.closeAndWait(slotId);
    const drain = await drainProviderProducers(slotId, { runId, leaseEpoch });
    if (!drain || drain.drained !== true || drain.ambiguous === true
        || Number(drain.active || 0) !== 0) {
      throw finalizationError('provider producers are not drained',
        drain?.ambiguous ? 'TASK_RUN_PRODUCERS_DRAIN_AMBIGUOUS'
          : 'TASK_RUN_PRODUCERS_DRAIN_INCOMPLETE');
    }
    const existing = taskRunStore.getCleanupManifest(runId);
    if (existing && (existing.slotId !== slotId
        || Number(existing.leaseEpoch) !== Number(leaseEpoch))) {
      throw finalizationError('cleanup manifest belongs to another lease',
        'TASK_RUN_CLEANUP_MANIFEST_LEASE_MISMATCH');
    }
    const capturedAt = existing ? Number(existing.capturedAt) : Number(now());
    const nativeRefs = existing
      ? immutableManifest(existing.nativeRefs)
      : immutableManifest(findNativeRefs({ record, roots, runId }));
    if (!existing) {
      taskRunStore.saveCleanupManifest({
        runId, slotId, leaseEpoch, nativeRefs, capturedAt,
      });
    }
    record.taskRunFinalization = {
      runId,
      leaseEpoch,
      capturedAt,
      nativeRefs,
    };
    let persisted;
    try {
      persisted = await Promise.resolve(persistRecords('task-run-native-manifest'));
    } catch (cause) {
      throw finalizationError('native transcript manifest could not be persisted',
        'TASK_RUN_NATIVE_MANIFEST_PERSIST_FAILED', cause);
    }
    if (persisted !== true) {
      throw finalizationError('native transcript manifest was not durable',
        'TASK_RUN_NATIVE_MANIFEST_PERSIST_FAILED');
    }
    return Object.freeze({
      outcomeDurable: true,
      producersDrained: true,
      nativeTranscriptChecked: true,
      nativeRefs,
    });
  };
}

function execFileText(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || '').trim());
    });
  });
}

async function inspectWorktree(record, directories, execFile = childProcess.execFile) {
  if (!record?.worktreePath) return { dirty: false, ahead: 0, behind: 0, conflicted: false };
  const directory = directories.get(record.dirId);
  const baseBranch = directory?.baseBranch || 'main';
  const run = args => execFileText(execFile, 'git', args, {
    cwd: record.worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const [statusShort, aheadText, behindText, conflicts] = await Promise.all([
      run(['status', '--porcelain=v1']),
      run(['rev-list', '--count', `${baseBranch}..HEAD`]),
      run(['rev-list', '--count', `HEAD..${baseBranch}`]),
      run(['diff', '--name-only', '--diff-filter=U']),
    ]);
    const ahead = Number(aheadText || 0);
    const behind = Number(behindText || 0);
    return {
      statusShort,
      dirty: !!statusShort,
      ahead: Number.isSafeInteger(ahead) && ahead >= 0 ? ahead : Number.NaN,
      behind: Number.isSafeInteger(behind) && behind >= 0 ? behind : Number.NaN,
      conflicted: !!conflicts,
    };
  } catch (_) {
    return {};
  }
}

function createProductionTaskRunHost(options = {}) {
  const {
    taskRunStore,
    dataRoot,
    providerHomesDir,
    codexSessionHomesDir,
    records,
    directories,
    chatStream,
    clearNativeCliStates,
    deleteChatHistory,
    resetChatState,
    resetRoleUsage,
    persistRecords,
    drainProviderProducers,
    providerSnapshot,
    onRunUpdated,
    getTaskState,
    onRunFailed,
    prepareTaskWorktree = null,
    releaseTaskWorktree = null,
    logger = console,
  } = options;
  const transcriptRoots = discoverTranscriptRoots({
    dataRoot, providerHomesDir, codexSessionHomesDir,
  });
  const closeNative = sessionId => chatStream.closeAndWait(sessionId);
  const clearNativeState = record => clearNativeCliStates(record);
  const cleanup = createTaskRunCleanup({
    taskRunStore,
    transcriptRoots,
    inspectWorktree: ({ slotId }) => inspectWorktree(records.get(slotId), directories),
    closeNative: ({ slotId }) => closeNative(slotId),
    clearNativeState: ({ slotId }) => {
      const record = records.get(slotId);
      clearNativeState(record);
      resetChatState(slotId);
      resetRoleUsage(slotId);
    },
    clearChatHistory: ({ slotId }) => deleteChatHistory(slotId),
  });
  const finalizeRun = createNativeFinalizer({
    roots: transcriptRoots,
    taskRunStore,
    chatStream,
    drainProviderProducers,
    persistRecords,
  });
  const cleanupRun = ({ runId, slotId, permit, nativeRefs }) => cleanup.cleanup({
    runId,
    slotId,
    permit,
    nativeRefs,
  });
  const host = createTaskRunHost({
    store: taskRunStore,
    records,
    closeNative,
    clearNativeState,
    deleteChatHistory,
    resetChatState,
    resetRoleUsage,
    persistRecords,
    providerSnapshot,
    onRunUpdated,
    getTaskState: typeof getTaskState === 'function' ? getTaskState : undefined,
    onRunFailed: typeof onRunFailed === 'function' ? onRunFailed : null,
    // M3 run-boundary worktree stamp/restore (per-task worktree service).
    prepareTaskWorktree: typeof prepareTaskWorktree === 'function' ? prepareTaskWorktree : null,
    releaseTaskWorktree: typeof releaseTaskWorktree === 'function' ? releaseTaskWorktree : null,
    finalizeRun,
    cleanupRun,
    log: message => logger.warn?.(message),
  });
  async function resumeCleanup(item = {}) {
    const runId = String(item.runId || '').trim();
    const slotId = String(item.slotId || '').trim();
    const leaseEpoch = Number(item.leaseEpoch);
    const record = records.get(slotId);
    if (!record?.taskExecutionSlot) {
      throw finalizationError('task execution slot not found', 'TASK_RUN_SLOT_NOT_FOUND');
    }
    const manifest = taskRunStore.getCleanupManifest(runId);
    if (!manifest) {
      throw finalizationError('durable cleanup manifest is missing',
        'TASK_RUN_CLEANUP_MANIFEST_MISSING');
    }
    if (manifest.slotId !== slotId || Number(manifest.leaseEpoch) !== leaseEpoch) {
      throw finalizationError('cleanup manifest belongs to another lease',
        'TASK_RUN_CLEANUP_MANIFEST_LEASE_MISMATCH');
    }
    const permit = taskRunStore.getCleanupPermit(runId);
    if (!permit) {
      throw finalizationError('cleanup permit unavailable during recovery',
        'TASK_RUN_CLEANUP_PERMIT_STALE');
    }
    const result = await cleanupRun({
      runId, slotId, permit, nativeRefs: manifest.nativeRefs,
    });
    if (result?.status === 'done') delete record.taskRunFinalization;
    return result;
  }
  return Object.freeze({ ...host, resumeCleanup });
}

module.exports = {
  createNativeFinalizer,
  createProductionTaskRunHost,
  discoverTranscriptRoots,
  findNativeRefs,
  inspectWorktree,
};
