'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class TaskRunCleanupError extends Error {
  constructor(message, code = 'TASK_RUN_CLEANUP_FAILED', meta = {}) {
    super(message, meta.cause ? { cause: meta.cause } : undefined);
    this.name = 'TaskRunCleanupError';
    this.code = code;
    for (const [key, value] of Object.entries(meta)) {
      if (key !== 'cause') this[key] = value;
    }
  }
}

function cleanupError(message, code, meta) {
  return new TaskRunCleanupError(message, code, meta);
}

function requiredId(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw cleanupError(`${label} is required or invalid`, 'TASK_RUN_CLEANUP_INPUT_INVALID', { field: label });
  }
  return text;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function broadRoot(realRoot, declaredRoot = realRoot, fsImpl = fs) {
  const parsedRoot = path.parse(realRoot).root;
  if (samePath(realRoot, parsedRoot)) return true;
  const broad = [os.homedir(), os.tmpdir(), process.cwd()].filter(Boolean).flatMap((value) => {
    const resolved = path.resolve(value);
    try {
      return [resolved, path.resolve(fsImpl.realpathSync(resolved))];
    } catch (_) {
      return [resolved];
    }
  });
  if (broad.some(candidate => samePath(realRoot, candidate) || samePath(declaredRoot, candidate))) return true;
  const depth = path.relative(parsedRoot, realRoot).split(path.sep).filter(Boolean).length;
  return depth < 2;
}

function normalizeRoots(transcriptRoots, fsImpl) {
  if (!Array.isArray(transcriptRoots) || !transcriptRoots.length) {
    throw cleanupError('at least one transcript root is required', 'TASK_RUN_CLEANUP_ROOT_UNSAFE');
  }
  const roots = transcriptRoots.map((value) => {
    const raw = String(value == null ? '' : value);
    if (!raw || !path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
      throw cleanupError('transcript root must be an absolute non-traversing path',
        'TASK_RUN_CLEANUP_ROOT_UNSAFE', { root: raw });
    }
    const declared = path.resolve(raw);
    let rootStat;
    let real;
    try {
      rootStat = fsImpl.lstatSync(declared);
      if (rootStat.isSymbolicLink()) {
        throw cleanupError('symlink transcript roots are forbidden',
          'TASK_RUN_CLEANUP_ROOT_UNSAFE', { root: declared });
      }
      real = path.resolve(fsImpl.realpathSync(declared));
      const realStat = fsImpl.lstatSync(real);
      if (!rootStat.isDirectory() || !realStat.isDirectory()) {
        throw cleanupError('transcript root must be a directory',
          'TASK_RUN_CLEANUP_ROOT_UNSAFE', { root: declared });
      }
    } catch (cause) {
      if (cause instanceof TaskRunCleanupError) throw cause;
      throw cleanupError('transcript root cannot be verified',
        'TASK_RUN_CLEANUP_ROOT_UNSAFE', { root: declared, cause });
    }
    if (broadRoot(real, declared, fsImpl)) {
      throw cleanupError('root, home, temp, workspace, and other broad transcript roots are forbidden',
        'TASK_RUN_CLEANUP_ROOT_UNSAFE', { root: declared });
    }
    return Object.freeze({ declared, real });
  });
  roots.sort((left, right) => right.real.length - left.real.length);
  return Object.freeze(roots);
}

function normalizePermit(permit, expectedRunId) {
  if (!permit || typeof permit !== 'object' || Array.isArray(permit)) {
    throw cleanupError('cleanup permit is required', 'TASK_RUN_CLEANUP_PERMIT_STALE');
  }
  const permitRunId = requiredId(permit.runId, 'permit.runId');
  if (permitRunId !== expectedRunId) {
    throw cleanupError('cleanup permit belongs to another run',
      'TASK_RUN_CLEANUP_PERMIT_RUN_MISMATCH', { runId: expectedRunId, permitRunId });
  }
  const revision = Number(permit.revision);
  const issuedAt = Number(permit.issuedAt);
  if (!Number.isSafeInteger(revision) || revision < 0
      || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw cleanupError('cleanup permit is malformed', 'TASK_RUN_CLEANUP_PERMIT_STALE', { runId: expectedRunId });
  }
  return Object.freeze({ runId: permitRunId, revision, issuedAt });
}

function permitsEqual(left, right) {
  return !!left && !!right && left.runId === right.runId
    && Number(left.revision) === Number(right.revision)
    && Number(left.issuedAt) === Number(right.issuedAt);
}

function assertStoredRun(run, runId, slotId) {
  if (!run || typeof run !== 'object' || run.runId !== runId) {
    throw cleanupError('task run ledger entry is missing or mismatched',
      'TASK_RUN_CLEANUP_RUN_MISMATCH', { runId });
  }
  if (run.slotId !== slotId) {
    throw cleanupError('slot does not own this task run',
      'TASK_RUN_CLEANUP_SLOT_MISMATCH', { runId, slotId, ownerSlotId: run.slotId || null });
  }
}

function assertDonePermit(run, permit) {
  if (Number(run.usageRevision) !== permit.revision
      || Number(run.sealedRevision) !== permit.revision
      || Number(run.sealedAt) !== permit.issuedAt) {
    throw cleanupError('cleanup permit is stale', 'TASK_RUN_CLEANUP_PERMIT_STALE', { runId: permit.runId });
  }
}

function assertCurrentPermit(taskRunStore, runId, permit) {
  let current;
  try {
    current = taskRunStore.getCleanupPermit(runId);
  } catch (cause) {
    throw cleanupError('cleanup permit could not be verified',
      cause && cause.code === 'TASK_RUN_CLEANUP_PERMIT_STALE'
        ? 'TASK_RUN_CLEANUP_PERMIT_STALE' : 'TASK_RUN_CLEANUP_LEDGER_FAILED',
      { runId, cause });
  }
  if (!permitsEqual(current, permit)) {
    throw cleanupError('cleanup permit is stale', 'TASK_RUN_CLEANUP_PERMIT_STALE', { runId });
  }
  return current;
}

function normalizeNativeRefs(nativeRefs, runId) {
  if (nativeRefs == null) return [];
  let ownerRunId = '';
  let files;
  if (Array.isArray(nativeRefs)) {
    files = nativeRefs;
  } else if (typeof nativeRefs === 'object') {
    ownerRunId = requiredId(nativeRefs.runId, 'nativeRefs.runId');
    files = nativeRefs.files;
  }
  if (!Array.isArray(files)) {
    throw cleanupError('nativeRefs must be an array or a run-owned file manifest',
      'TASK_RUN_CLEANUP_MANIFEST_INVALID', { runId });
  }
  if (ownerRunId && ownerRunId !== runId) {
    throw cleanupError('native transcript manifest belongs to another run',
      'TASK_RUN_CLEANUP_MANIFEST_RUN_MISMATCH', { runId, ownerRunId });
  }
  const normalized = files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw cleanupError('each native transcript reference must carry explicit ownership',
        'TASK_RUN_CLEANUP_MANIFEST_INVALID', { runId, index });
    }
    const entryRunId = entry.runId == null ? ownerRunId : requiredId(entry.runId, `nativeRefs.files[${index}].runId`);
    if (!entryRunId || entryRunId !== runId) {
      throw cleanupError('native transcript reference belongs to another run',
        'TASK_RUN_CLEANUP_MANIFEST_RUN_MISMATCH', { runId, ownerRunId: entryRunId || null, index });
    }
    const file = String(entry.path == null ? '' : entry.path);
    const kind = String(entry.kind || entry.type || '').trim().toLowerCase();
    if (!file || !kind) {
      throw cleanupError('native transcript path and kind are required',
        'TASK_RUN_CLEANUP_MANIFEST_INVALID', { runId, index });
    }
    return Object.freeze({ runId, path: file, kind, index });
  });
  return Object.freeze(normalized);
}

function classifyRefKind(ref) {
  const basename = path.basename(ref.path).toLowerCase();
  const extension = path.extname(basename);
  const jsonlKind = ref.kind === 'jsonl' || ref.kind.endsWith('-jsonl');
  const rolloutKind = ref.kind === 'rollout' || ref.kind.endsWith('-rollout');
  if (extension !== '.jsonl' || (!jsonlKind && !rolloutKind)) {
    throw cleanupError('only explicitly typed JSONL or rollout JSONL files may be deleted',
      'TASK_RUN_CLEANUP_FILE_TYPE_REFUSED', { path: ref.path, kind: ref.kind });
  }
  if (rolloutKind && !basename.includes('rollout')) {
    throw cleanupError('rollout references must name a rollout file',
      'TASK_RUN_CLEANUP_FILE_TYPE_REFUSED', { path: ref.path, kind: ref.kind });
  }
}

function rootForTarget(roots, target) {
  return roots.find(root => isContained(root.declared, target) || isContained(root.real, target)) || null;
}

function inspectPathComponents(fsImpl, base, target) {
  const relative = path.relative(base, target);
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = base;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fsImpl.lstatSync(cursor);
    } catch (cause) {
      if (cause && cause.code === 'ENOENT') return { missing: true };
      throw cleanupError('transcript path cannot be inspected',
        'TASK_RUN_CLEANUP_PATH_INSPECTION_FAILED', { path: cursor, cause });
    }
    if (stat.isSymbolicLink()) {
      throw cleanupError('symlink transcript references are forbidden',
        'TASK_RUN_CLEANUP_SYMLINK_REFUSED', { path: cursor });
    }
  }
  return { missing: false };
}

function validateRefPath(ref, roots, fsImpl) {
  classifyRefKind(ref);
  if (!path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) {
    throw cleanupError('transcript path must be absolute and may not traverse',
      'TASK_RUN_CLEANUP_PATH_OUTSIDE_ROOT', { path: ref.path });
  }
  const target = path.resolve(ref.path);
  const root = rootForTarget(roots, target);
  if (!root) {
    throw cleanupError('transcript path is outside every configured root',
      'TASK_RUN_CLEANUP_PATH_OUTSIDE_ROOT', { path: target });
  }
  const base = isContained(root.declared, target) ? root.declared : root.real;
  const componentStatus = inspectPathComponents(fsImpl, base, target);
  if (componentStatus.missing) return Object.freeze({ ...ref, target, missing: true });

  let realTarget;
  let stat;
  try {
    realTarget = path.resolve(fsImpl.realpathSync(target));
    stat = fsImpl.lstatSync(target);
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return Object.freeze({ ...ref, target, missing: true });
    throw cleanupError('transcript path cannot be verified',
      'TASK_RUN_CLEANUP_PATH_INSPECTION_FAILED', { path: target, cause });
  }
  if (stat.isSymbolicLink()) {
    throw cleanupError('symlink transcript references are forbidden',
      'TASK_RUN_CLEANUP_SYMLINK_REFUSED', { path: target });
  }
  if (!stat.isFile()) {
    throw cleanupError('transcript reference is not a regular file',
      'TASK_RUN_CLEANUP_FILE_TYPE_REFUSED', { path: target });
  }
  if (!isContained(root.real, realTarget)) {
    throw cleanupError('resolved transcript path escapes its configured root',
      'TASK_RUN_CLEANUP_PATH_OUTSIDE_ROOT', { path: target, realPath: realTarget });
  }
  return Object.freeze({ ...ref, target, realTarget, missing: false });
}

function preflightRefs(refs, roots, fsImpl) {
  const unique = new Map();
  for (const ref of refs) {
    const checked = validateRefPath(ref, roots, fsImpl);
    const key = checked.realTarget || checked.target;
    if (!unique.has(key)) unique.set(key, checked);
  }
  return [...unique.values()];
}

function worktreeReasons(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['inspection-invalid'];
  const reasons = [];
  const statusText = typeof report.statusShort === 'string' ? report.statusShort.trim() : '';
  const hasCleanEvidence = report.safe === true || report.dirty === false || report.clean === true
    || typeof report.statusShort === 'string';
  const hasAheadEvidence = report.safe === true || report.ahead !== undefined
    || report.aheadCount !== undefined;
  const hasBehindEvidence = report.safe === true || report.behind !== undefined
    || report.behindCount !== undefined;
  const hasConflictEvidence = report.safe === true || report.conflicted !== undefined
    || report.hasConflicts !== undefined || report.conflicts !== undefined;
  if (!hasCleanEvidence || !hasAheadEvidence || !hasBehindEvidence || !hasConflictEvidence) {
    reasons.push('inspection-invalid');
  }
  if (report.dirty === true || report.clean === false || statusText) reasons.push('dirty');
  const ahead = Number(report.ahead ?? report.aheadCount ?? 0);
  if (!Number.isFinite(ahead) || ahead < 0) reasons.push('inspection-invalid');
  if (report.ahead === true || (Number.isFinite(ahead) && ahead > 0)) reasons.push('ahead');
  const behind = Number(report.behind ?? report.behindCount ?? 0);
  if (!Number.isFinite(behind) || behind < 0) reasons.push('inspection-invalid');
  if (report.behind === true || (Number.isFinite(behind) && behind > 0)) reasons.push('behind');
  const conflicts = Array.isArray(report.conflicts) ? report.conflicts.length
    : typeof report.conflicts === 'string' ? report.conflicts.trim().length : 0;
  if (report.conflicted === true || report.hasConflicts === true || conflicts > 0) reasons.push('conflicted');
  return [...new Set(reasons)];
}

function effectError(stage, cause) {
  if (cause instanceof TaskRunCleanupError) return cause;
  return cleanupError(`task run cleanup failed during ${stage}`,
    'TASK_RUN_CLEANUP_EFFECT_FAILED', { stage, cause });
}

function createTaskRunCleanup({
  taskRunStore,
  closeNative,
  clearNativeState,
  clearChatHistory,
  inspectWorktree,
  transcriptRoots,
  fsImpl = fs,
} = {}) {
  if (!taskRunStore || typeof taskRunStore !== 'object') {
    throw new TypeError('taskRunStore is required');
  }
  for (const method of ['getRun', 'getCleanupPermit', 'markCleanup']) {
    requireFunction(taskRunStore[method], `taskRunStore.${method}`);
  }
  const effects = {
    closeNative: requireFunction(closeNative, 'closeNative'),
    clearNativeState: requireFunction(clearNativeState, 'clearNativeState'),
    clearChatHistory: requireFunction(clearChatHistory, 'clearChatHistory'),
    inspectWorktree: requireFunction(inspectWorktree, 'inspectWorktree'),
  };
  for (const method of ['lstatSync', 'realpathSync', 'unlinkSync']) {
    requireFunction(fsImpl && fsImpl[method], `fsImpl.${method}`);
  }
  const roots = normalizeRoots(transcriptRoots, fsImpl);
  const inFlight = new Map();

  function markErrorIfStillPermitted(runId, permit, error) {
    try {
      const current = taskRunStore.getCleanupPermit(runId);
      if (!permitsEqual(current, permit)) return false;
      const errorCode = error.quarantined === true
        ? 'TASK_RUN_CLEANUP_QUARANTINED'
        : String(error.code || 'TASK_RUN_CLEANUP_FAILED').slice(0, 128);
      taskRunStore.markCleanup({ runId, permit, state: 'error', errorCode });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function performCleanup(input = {}) {
    const runId = requiredId(input.runId, 'runId');
    const slotId = requiredId(input.slotId, 'slotId');
    const permit = normalizePermit(input.permit, runId);
    let run;
    try {
      run = taskRunStore.getRun(runId);
    } catch (cause) {
      throw cleanupError('task run ledger could not be read',
        'TASK_RUN_CLEANUP_LEDGER_FAILED', { runId, cause });
    }
    assertStoredRun(run, runId, slotId);
    if (run.cleanupState === 'done') {
      assertDonePermit(run, permit);
      return Object.freeze({
        runId, slotId, status: 'done', alreadyDone: true, deleted: [], missing: [],
      });
    }
    assertCurrentPermit(taskRunStore, runId, permit);

    let refs;
    let preflight;
    try {
      refs = normalizeNativeRefs(input.nativeRefs, runId);
      let worktree;
      try {
        worktree = await effects.inspectWorktree({ runId, slotId });
      } catch (cause) {
        throw cleanupError('worktree inspection failed; slot is quarantined',
          'TASK_RUN_CLEANUP_WORKTREE_QUARANTINED', {
            runId, slotId, quarantined: true, reasons: ['inspection-failed'], cause,
          });
      }
      assertCurrentPermit(taskRunStore, runId, permit);
      const reasons = worktreeReasons(worktree);
      if (reasons.length) {
        throw cleanupError('worktree is not safe to reuse; slot is quarantined',
          'TASK_RUN_CLEANUP_WORKTREE_QUARANTINED', {
            runId, slotId, quarantined: true, reasons,
          });
      }
      preflight = preflightRefs(refs, roots, fsImpl);
      assertCurrentPermit(taskRunStore, runId, permit);
      taskRunStore.markCleanup({ runId, permit, state: 'deleting' });

      try {
        await effects.closeNative({ runId, slotId, nativeRefs: refs });
      } catch (cause) {
        throw effectError('close-native', cause);
      }
      assertCurrentPermit(taskRunStore, runId, permit);
      try {
        await effects.clearNativeState({ runId, slotId });
      } catch (cause) {
        throw effectError('clear-native-state', cause);
      }
      assertCurrentPermit(taskRunStore, runId, permit);
      try {
        await effects.clearChatHistory({ runId, slotId });
      } catch (cause) {
        throw effectError('clear-chat-history', cause);
      }
      assertCurrentPermit(taskRunStore, runId, permit);

      const deleted = [];
      const missing = [];
      for (const candidate of preflight) {
        assertCurrentPermit(taskRunStore, runId, permit);
        const checked = validateRefPath(candidate, roots, fsImpl);
        if (checked.missing) {
          missing.push(checked.target);
          continue;
        }
        try {
          fsImpl.unlinkSync(checked.realTarget);
          deleted.push(checked.realTarget);
        } catch (cause) {
          if (cause && cause.code === 'ENOENT') {
            missing.push(checked.realTarget);
            continue;
          }
          throw effectError('delete-native-transcript', cause);
        }
      }
      assertCurrentPermit(taskRunStore, runId, permit);
      taskRunStore.markCleanup({ runId, permit, state: 'done' });
      return Object.freeze({
        runId,
        slotId,
        status: 'done',
        alreadyDone: false,
        deleted: Object.freeze(deleted),
        missing: Object.freeze(missing),
      });
    } catch (cause) {
      const error = effectError('cleanup', cause);
      markErrorIfStillPermitted(runId, permit, error);
      throw error;
    }
  }

  function cleanup(input = {}) {
    let runId;
    let slotId;
    let permit;
    try {
      runId = requiredId(input.runId, 'runId');
      slotId = requiredId(input.slotId, 'slotId');
      permit = normalizePermit(input.permit, runId);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = inFlight.get(runId);
    if (existing) {
      if (existing.slotId !== slotId || !permitsEqual(existing.permit, permit)) {
        return Promise.reject(cleanupError('another cleanup claimant owns this run',
          'TASK_RUN_CLEANUP_CLAIM_CONFLICT', { runId, slotId }));
      }
      return existing.promise;
    }
    let tracked;
    const operation = performCleanup({ ...input, runId, slotId, permit });
    tracked = operation.finally(() => {
      if (inFlight.get(runId)?.promise === tracked) inFlight.delete(runId);
    });
    inFlight.set(runId, Object.freeze({ slotId, permit, promise: tracked }));
    return tracked;
  }

  return Object.freeze({ cleanup });
}

module.exports = {
  TaskRunCleanupError,
  createTaskRunCleanup,
};
