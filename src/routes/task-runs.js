'use strict';

const { runErrorOf } = require('../task-run-errors');

const PUBLIC_TASK_RUN_ERROR = 'Task run data is temporarily unavailable';
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUIRED_STORE_METHODS = Object.freeze([
  'getRun',
  'getRunMessages',
  'getRunUsage',
  'listTaskRuns',
  'getTaskUsage',
]);

class TaskRunRouteError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'TaskRunRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function labelFor(value) {
  return value === 'task' ? 'task' : value === 'run' ? 'run' : 'route';
}

function invalidId(label) {
  const safeLabel = labelFor(label);
  return new TaskRunRouteError(`invalid ${safeLabel} id`, 'INVALID_ROUTE_ID', 400);
}

function decodeRouteId(value, label = 'route') {
  const raw = typeof value === 'string' ? value : '';
  // Three bytes are sufficient for every encoded ASCII character accepted by
  // ROUTE_ID. Refuse an oversized encoded value before allocating its decoded
  // representation; the decoded length check below remains authoritative.
  if (!raw || raw.length > 384) throw invalidId(label);
  let decoded;
  try { decoded = decodeURIComponent(raw); }
  catch (_) { throw invalidId(label); }
  if (!ROUTE_ID.test(decoded)) throw invalidId(label);
  return decoded;
}

function safeErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN';
}

function publicRunDto(run = {}) {
  return {
    runId: String(run.runId || ''),
    taskId: String(run.taskId || ''),
    executionStatus: String(run.executionStatus || 'unknown'),
    usageStatus: String(run.usageStatus || 'collecting'),
    cleanupState: String(run.cleanupState || 'blocked'),
    startedAt: Number(run.startedAt || 0),
    terminalAt: run.terminalAt == null ? null : Number(run.terminalAt),
    // M3 observability: where this run actually executed. Present only after
    // the worktree stamp at the run boundary; absent for pre-M3 runs.
    ...(typeof run.metadata?.worktreePath === 'string'
      ? { worktreePath: run.metadata.worktreePath, branch: run.metadata.branch || null }
      : {}),
  };
}

function publicMessageDto(message = {}) {
  return {
    runId: String(message.runId || ''),
    messageId: String(message.messageId || ''),
    role: String(message.role || 'unknown'),
    kind: String(message.kind || 'message'),
    content: message.content ?? '',
    createdAt: Number(message.createdAt || 0),
    // The only metadata flag safe and useful to publish: a partial checkpoint
    // is interrupted draft output, never a complete answer. Everything else
    // (lease epochs, native session ids) stays sealed inside the store.
    ...(message.metadata?.partial === true ? { partial: true } : {}),
  };
}

// Failed runs carry their ledger error entry as a DTO summary so cards and
// detail views can render *why* without re-reading the message list.
function withRunError(store, run, dto) {
  if (dto.executionStatus !== 'failed') return dto;
  const error = runErrorOf(store, run.runId || dto.runId);
  return error ? { ...dto, error } : dto;
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object' || !deps.store || typeof deps.store !== 'object') {
    throw new TypeError('task-run routes store is required');
  }
  for (const method of REQUIRED_STORE_METHODS) {
    if (typeof deps.store[method] !== 'function') {
      throw new TypeError(`task-run routes store.${method} is required`);
    }
  }
  if (deps.logger != null && typeof deps.logger.error !== 'function') {
    throw new TypeError('task-run routes logger.error must be a function');
  }
  return deps;
}

function createTaskRunRoutes(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const { store } = deps;
  const logger = deps.logger || console;

  function report(route, error) {
    try {
      logger.error('task_run_route_failed', { route, code: safeErrorCode(error) });
    } catch (_) { /* diagnostics must never replace the public response */ }
  }

  function handleError(route, entity, error, res) {
    if (error && error.code === 'INVALID_ROUTE_ID') {
      return res.status(400).json({ error: `invalid ${entity} id` });
    }
    if (error && error.code === 'TASK_RUN_NOT_FOUND') {
      return res.status(404).json({ error: 'task run not found' });
    }
    report(route, error);
    return res.status(500).json({ error: PUBLIC_TASK_RUN_ERROR });
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function') {
      throw new TypeError('task-run routes require Express app.get');
    }

    app.get('/api/task-runs/:runId', (req, res) => {
      try {
        const runId = decodeRouteId(req && req.params && req.params.runId, 'run');
        const run = store.getRun(runId);
        if (!run) return res.status(404).json({ error: 'task run not found' });
        const messages = store.getRunMessages(runId).map(publicMessageDto);
        const usage = store.getRunUsage(runId);
        return res.json({ run: withRunError(store, run, publicRunDto(run)), messages, usage });
      } catch (error) {
        return handleError('run-detail', 'run', error, res);
      }
    });

    app.get('/api/tasks/:taskId/runs', (req, res) => {
      try {
        const taskId = decodeRouteId(req && req.params && req.params.taskId, 'task');
        const storedRuns = store.listTaskRuns(taskId);
        const runs = Array.isArray(storedRuns)
          ? storedRuns.map(run => withRunError(store, run, publicRunDto(run)))
          : storedRuns;
        if (!Array.isArray(runs)) {
          const error = new Error('task-run store returned an invalid run list');
          error.code = 'TASK_RUN_STORE_INVALID_RESULT';
          throw error;
        }
        if (runs.length === 0) return res.status(404).json({ error: 'task not found' });
        const usage = store.getTaskUsage(taskId);
        return res.json({ runs, usage });
      } catch (error) {
        return handleError('task-runs', 'task', error, res);
      }
    });
  }

  return Object.freeze({ mountRoutes });
}

module.exports = {
  PUBLIC_TASK_RUN_ERROR,
  TaskRunRouteError,
  createTaskRunRoutes,
  decodeRouteId,
  publicMessageDto,
  publicRunDto,
};
