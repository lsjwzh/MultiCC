'use strict';

const crypto = require('crypto');
const {
  admitOutboxItem,
  hashPayload,
  hashSecret,
  normalizeJson,
} = require('./outbox');

const TERMINAL_OPERATION_STATES = new Set([
  'completed', 'failed', 'interrupted', 'cancelled',
]);
const TERMINAL_TASK_STATES = new Set([
  'completed', 'failed', 'interrupted', 'cancelled',
]);

class OperationConflictError extends Error {
  constructor(message, operationId) {
    super(message);
    this.name = 'OperationConflictError';
    this.code = 'OPERATION_CONFLICT';
    this.statusCode = 409;
    this.operationId = operationId || null;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicOperation(operation) {
  if (!operation) return null;
  const copy = clone(operation);
  delete copy.idempotencyKeyHash;
  delete copy.requestHash;
  delete copy.resultHash;
  return copy;
}

function publicTask(task) {
  return task ? clone(task) : null;
}

function taskRecordId(sessionId, taskId, cryptoImpl = crypto) {
  const suffix = cryptoImpl.createHash('sha256')
    .update(`${sessionId}\0${taskId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `task_${suffix}`;
}

function createOperationService({
  store,
  now = Date.now,
  cryptoImpl = crypto,
  idFactory = () => `op_${cryptoImpl.randomUUID()}`,
} = {}) {
  if (!store || typeof store.mutate !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('[operation-service] orchestration store is required');
  }

  function findIdempotent(draft, { kind, ownerSessionId, idempotencyKeyHash }) {
    if (!idempotencyKeyHash) return null;
    return Object.values(draft.operations).find(operation => (
      operation.kind === kind
      && operation.ownerSessionId === ownerSessionId
      && operation.idempotencyKeyHash === idempotencyKeyHash
    )) || null;
  }

  function admitBase(draft, {
    id,
    kind,
    ownerSessionId,
    resultSessionId,
    idempotencyKey,
    spec,
    externalId = null,
  }) {
    const normalizedSpec = normalizeJson(spec);
    const requestHash = hashPayload(normalizedSpec, cryptoImpl);
    const idempotencyKeyHash = idempotencyKey
      ? hashSecret(idempotencyKey, cryptoImpl)
      : null;
    const existing = findIdempotent(draft, { kind, ownerSessionId, idempotencyKeyHash });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new OperationConflictError(
          `${kind} idempotency key was already used with different content`,
          existing.id,
        );
      }
      return { operation: existing, idempotent: true };
    }
    if (draft.operations[id]) {
      throw new OperationConflictError(`operation ${id} already exists`, id);
    }
    const at = Number(now());
    const operation = {
      id,
      kind,
      ownerSessionId,
      resultSessionId: resultSessionId || ownerSessionId,
      status: 'admitted',
      idempotencyKeyHash,
      requestHash,
      resultHash: null,
      spec: normalizedSpec,
      externalId,
      requestOutboxId: null,
      resultOutboxId: null,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      lastError: null,
    };
    draft.operations[id] = operation;
    return { operation, idempotent: false };
  }

  async function admitDetached({
    operationId = idFactory(),
    sessionId,
    idempotencyKey = null,
    spec,
  } = {}) {
    if (!sessionId) throw new TypeError('detached operation requires sessionId');
    return store.mutate(draft => {
      const externalId = `d_${operationId.replace(/^op_/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;
      const admitted = admitBase(draft, {
        id: operationId,
        kind: 'detached',
        ownerSessionId: sessionId,
        resultSessionId: sessionId,
        idempotencyKey,
        spec,
        externalId,
      });
      return { ...publicOperation(admitted.operation), idempotent: admitted.idempotent };
    });
  }

  async function admitDispatch({
    operationId = idFactory(),
    ownerSessionId,
    resultSessionId,
    idempotencyKey = null,
    spec,
  } = {}) {
    if (!ownerSessionId || !spec || !spec.chatId || !spec.targetId || !spec.message) {
      throw new TypeError('dispatch operation requires owner, target chat and message');
    }
    return store.mutate(draft => {
      const admitted = admitBase(draft, {
        id: operationId,
        kind: 'dispatch',
        ownerSessionId,
        resultSessionId: resultSessionId || ownerSessionId,
        idempotencyKey,
        spec,
      });
      const operation = admitted.operation;
      if (!operation.requestOutboxId) {
        const outboxId = `operation:${operation.id}:request`;
        const outbox = admitOutboxItem(draft, {
          id: outboxId,
          sessionId: operation.spec.chatId,
          payload: {
            type: 'dispatch.request',
            operationId: operation.id,
            targetId: operation.spec.targetId,
            message: operation.spec.message,
            taskId: operation.spec.taskId || null,
            taskStart: operation.spec.taskStart === true,
            taskSource: operation.spec.taskSource || null,
            taskText: operation.spec.taskText || null,
          },
          source: { type: 'operation', kind: 'dispatch', operationId: operation.id },
          now: Number(now()),
        });
        operation.requestOutboxId = outbox.item.id;
        operation.updatedAt = Number(now());
      }
      return { ...publicOperation(operation), idempotent: admitted.idempotent };
    });
  }

  async function markRunning(id, patch = {}) {
    return store.mutate(draft => {
      const operation = draft.operations[id];
      if (!operation) return { ok: false, code: 'not_found' };
      if (TERMINAL_OPERATION_STATES.has(operation.status)) {
        return { ok: true, idempotent: true, operation: publicOperation(operation) };
      }
      const nextPid = patch.pid != null && Number.isFinite(Number(patch.pid))
        ? Number(patch.pid)
        : operation.pid;
      if (operation.status === 'running'
          && (!patch.externalId || operation.externalId === String(patch.externalId))
          && operation.pid === nextPid) {
        return { ok: true, idempotent: true, operation: publicOperation(operation) };
      }
      const at = Number(now());
      operation.status = 'running';
      operation.startedAt = operation.startedAt || at;
      operation.updatedAt = at;
      if (patch.externalId) operation.externalId = String(patch.externalId);
      if (nextPid != null) operation.pid = nextPid;
      return { ok: true, idempotent: false, operation: publicOperation(operation) };
    });
  }

  function completeOperationDraft(draft, operation, result, {
    status,
    outboxPayload,
    resettle = false,
  }) {
    const normalizedResult = normalizeJson(result);
    const resultHash = hashPayload(normalizedResult, cryptoImpl);
    if (TERMINAL_OPERATION_STATES.has(operation.status)) {
      if (operation.resultHash === resultHash) {
        return { ok: true, idempotent: true, operation: publicOperation(operation) };
      }
      if (resettle !== true) {
        throw new OperationConflictError(
          `operation ${operation.id} already completed with different result`,
          operation.id,
        );
      }
      // Resettle: the prior terminal verdict was provisional (e.g. the host
      // auto-failed an async dispatch whose worker never receipted) and the
      // worker has now shown up with the operation id and a real result.
      // Overwrite the verdict and emit a fresh outbox item so the caller
      // receives the corrected receipt; the old delivery stays in history.
    }
    const settles = Number(operation.resultSettles) || 0;
    const at = Number(now());
    // First settle keeps the canonical outbox id (compat with everything that
    // reasons about `operation:<id>:result`); a resettle appends a sequence so
    // the corrected receipt is a NEW delivery, not an idempotent no-op.
    const outboxId = outboxPayload
      ? (settles === 0
        ? `operation:${operation.id}:result`
        : `operation:${operation.id}:result:${settles + 1}`)
      : null;
    if (outboxPayload) {
      admitOutboxItem(draft, {
        id: outboxId,
        sessionId: operation.resultSessionId,
        payload: outboxPayload,
        source: { type: 'operation', kind: operation.kind, operationId: operation.id },
        now: at,
      });
    }
    operation.status = status;
    operation.resultHash = resultHash;
    operation.result = normalizedResult;
    operation.resultOutboxId = outboxId;
    operation.resultSettles = settles + 1;
    operation.completedAt = at;
    operation.updatedAt = at;
    if (status === 'failed' || status === 'interrupted') {
      operation.lastError = String(result.error || result.message || status).slice(0, 2000);
    } else {
      operation.lastError = null;
    }
    return { ok: true, idempotent: false, operation: publicOperation(operation) };
  }

  async function completeDetached(id, result) {
    return store.mutate(draft => {
      const operation = draft.operations[id];
      if (!operation || operation.kind !== 'detached') return { ok: false, code: 'not_found' };
      const label = operation.spec.label || operation.spec.command.slice(0, 60);
      const status = result.status || (result.exitCode === 0 ? 'completed' : 'failed');
      if (!TERMINAL_OPERATION_STATES.has(status)) {
        throw new TypeError(`invalid detached completion status: ${status}`);
      }
      const marker = result.exitCode == null ? '' : `__MULTICC_DETACHED_DONE__ exit=${result.exitCode}\n`;
      const text = result.deliveryText || `${operation.spec.injectPrefix || `[后台任务完成] ${label}`}\n${marker}----- output tail -----\n${result.logTail || ''}`;
      return completeOperationDraft(draft, operation, result, {
        status,
        outboxPayload: {
          type: 'detached.result',
          operationId: operation.id,
          deliveryText: text,
          result,
        },
      });
    });
  }

  async function completeDispatch(id, result, opts = {}) {
    return store.mutate(draft => {
      const operation = draft.operations[id];
      if (!operation || operation.kind !== 'dispatch') return { ok: false, code: 'not_found' };
      const status = result.status || 'completed';
      if (!TERMINAL_OPERATION_STATES.has(status)) {
        throw new TypeError(`invalid dispatch completion status: ${status}`);
      }
      const targetId = operation.spec.targetId;
      const label = operation.spec.targetLabel
        ? `${targetId}（${operation.spec.targetLabel}）`
        : targetId;
      const resultBody = String(result.text || '').trim() || '（本次运行没有产生文本输出）';
      const corrected = opts.resettle === true;
      const text = operation.spec.resultMode === 'async' || operation.spec.resultMode === 'tool'
        ? (status === 'completed'
          ? `${corrected ? '📜 dispatch 迟到回执（已校正此前的自动判失败） [' + label + ']: ' : ''}📜 dispatch 结果回流 [${label}]: ${resultBody}`
          : `📜 dispatch 结果回流 [${label}]: ❌ ${result.error || resultBody}`)
        : (status === 'completed'
          ? `【${label} 回复】\n${resultBody}`
          : `🔇【分发任务已中断】发往 ${label} 的任务在 MultiCC 服务重启时未找到可恢复的完成结果。请检查目标会话后决定是否重试。`);
      return completeOperationDraft(draft, operation, result, {
        status,
        resettle: opts.resettle === true,
        // One-way routes and synchronous dispatches keep completion durable
        // without injecting another chat turn. Async dispatch alone wakes the
        // caller later with a normal queued result message. `tool` remains a
        // read-only compatibility value for operations admitted pre-upgrade.
        outboxPayload: operation.spec.oneWay === true || operation.spec.resultMode === 'sync'
          ? null : {
          type: 'dispatch.result',
          operationId: operation.id,
          targetId,
          gateway: operation.spec.gateway === true,
          deliveryText: text,
          result,
        },
      });
    });
  }

  async function observeTask({
    sessionId,
    taskId,
    status = 'running',
    detail = {},
  } = {}) {
    if (!sessionId || !taskId) throw new TypeError('task observation requires sessionId and taskId');
    const id = taskRecordId(sessionId, taskId, cryptoImpl);
    const normalized = normalizeJson(detail);
    return store.mutate(draft => {
      const at = Number(now());
      let task = draft.tasks[id];
      if (!task) {
        task = {
          id,
          taskId: String(taskId),
          parentSessionId: String(sessionId),
          status: 'running',
          kind: normalized.kind || 'task',
          description: normalized.description || '',
          toolUseId: normalized.toolUseId || null,
          outputFile: normalized.outputFile || null,
          lastOutput: '',
          error: null,
          createdAt: at,
          updatedAt: at,
          completedAt: null,
        };
        draft.tasks[id] = task;
      }
      if (TERMINAL_TASK_STATES.has(task.status) && task.status !== status) {
        return { ...publicTask(task), idempotent: true };
      }
      task.status = status;
      task.updatedAt = at;
      if (normalized.kind) task.kind = normalized.kind;
      if (normalized.description) task.description = String(normalized.description).slice(0, 1000);
      if (normalized.toolUseId) task.toolUseId = String(normalized.toolUseId);
      if (normalized.outputFile) task.outputFile = String(normalized.outputFile);
      if (normalized.lastOutput != null) task.lastOutput = String(normalized.lastOutput).slice(-4000);
      if (normalized.error != null) task.error = String(normalized.error).slice(0, 2000);
      if (TERMINAL_TASK_STATES.has(status)) task.completedAt = task.completedAt || at;
      return publicTask(task);
    });
  }

  async function interruptActiveTasks() {
    return store.mutate(draft => {
      const at = Number(now());
      const interrupted = [];
      for (const task of Object.values(draft.tasks)) {
        if (TERMINAL_TASK_STATES.has(task.status)) continue;
        task.status = 'interrupted';
        task.error = 'MultiCC restarted; the CLI-owned task cannot be proven alive or resumed';
        task.completedAt = at;
        task.updatedAt = at;
        const outboxId = `task:${task.id}:interrupted`;
        admitOutboxItem(draft, {
          id: outboxId,
          sessionId: task.parentSessionId,
          payload: {
            type: 'task.interrupted',
            taskId: task.taskId,
            deliveryText: `🔇【内置任务已中断】Task/Agent ${task.taskId} 在 MultiCC 服务重启时仍未结束；CLI 子进程无法被可靠恢复，系统没有假定它仍在运行。请检查已有输出后决定是否重跑。`,
          },
          source: { type: 'task', taskId: task.id },
          now: at,
        });
        interrupted.push(publicTask(task));
      }
      return interrupted;
    });
  }

  // Cancel a dispatch before (or while) the target runs it. Unlike
  // completeDispatch this writes NO result outbox: only the operation's owner
  // may cancel (enforced by the router tool), so injecting a "dispatch result"
  // wake-up would be the owner interrupting itself with its own decision. A
  // sync master blocked in waitForOperation still unblocks — it polls the
  // status, which is terminal either way.
  async function cancelDispatch(id, { reason = '', disposition = '' } = {}) {
    return store.mutate(draft => {
      const operation = draft.operations[id];
      if (!operation || operation.kind !== 'dispatch') return { ok: false, code: 'not_found' };
      if (TERMINAL_OPERATION_STATES.has(operation.status)) {
        // Losing the race to a genuine completion is not an error: report the
        // real terminal status so the caller surfaces the truth instead of a
        // cancellation that did not happen.
        return {
          ok: true, idempotent: true, raced: true,
          status: operation.status, operation: publicOperation(operation),
        };
      }
      const at = Number(now());
      const cleanReason = String(reason || 'cancelled by dispatcher').slice(0, 500);
      operation.status = 'cancelled';
      operation.cancelledAt = at;
      operation.completedAt = at;
      operation.updatedAt = at;
      operation.lastError = cleanReason;
      operation.result = normalizeJson({
        status: 'cancelled',
        reason: cleanReason,
        disposition: String(disposition || '').slice(0, 40),
      });
      operation.resultHash = hashPayload(operation.result, cryptoImpl);
      return {
        ok: true, idempotent: false, raced: false,
        status: 'cancelled', operation: publicOperation(operation),
      };
    });
  }

  async function get(id) {
    return store.read(draft => publicOperation(draft.operations[id]));
  }

  async function list({ kind, ownerSessionId, statuses } = {}) {
    const wanted = statuses == null ? null : new Set(Array.isArray(statuses) ? statuses : [statuses]);
    return store.read(draft => Object.values(draft.operations)
      .filter(operation => !kind || operation.kind === kind)
      .filter(operation => !ownerSessionId || operation.ownerSessionId === ownerSessionId)
      .filter(operation => !wanted || wanted.has(operation.status))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(publicOperation));
  }

  async function listTasks({ sessionId, statuses } = {}) {
    const wanted = statuses == null ? null : new Set(Array.isArray(statuses) ? statuses : [statuses]);
    return store.read(draft => Object.values(draft.tasks)
      .filter(task => !sessionId || task.parentSessionId === sessionId)
      .filter(task => !wanted || wanted.has(task.status))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(publicTask));
  }

  return Object.freeze({
    admitDetached,
    admitDispatch,
    markRunning,
    completeDetached,
    completeDispatch,
    cancelDispatch,
    observeTask,
    interruptActiveTasks,
    get,
    list,
    listTasks,
  });
}

module.exports = {
  OperationConflictError,
  TERMINAL_OPERATION_STATES,
  TERMINAL_TASK_STATES,
  createOperationService,
  taskRecordId,
};
