'use strict';

// Commander is a control-plane router, not a worker. This module owns the
// stable worker-pool boundary and the elastic scale-out decision. It never
// invokes an AI CLI and never touches a project worktree itself; those effects
// are supplied by the host as explicit ports.

const taskBoard = require('./task-board');

const WORKER_TYPE = 'worker';
const TASK_RUN_CLIS = Object.freeze(['claude', 'codex']);
const TASK_RUN_CLI_SET = new Set(TASK_RUN_CLIS);
const DEFAULT_MAX_ELASTIC_WORKERS = 4;
const DEFAULT_WORKER_PROMPT = [
  '# Role: Fleet Worker',
  '',
  'You are an implementation worker in a MultiCC fleet.',
  'Execute only the self-contained task delivered to this session.',
  'Inspect the repository, implement the requested change, verify it, commit it, and merge when instructed.',
  'Report the outcome in the language used by the task. Do not dispatch the task onward.',
].join('\n');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasLegacyWorkerPromptSignature(value) {
  const prompt = clean(value).replace(/\r\n/g, '\n');
  return /^#\s*角色[：:]\s*全栈工程师(?:\s*\d+)?(?:\s|$)/u.test(prompt);
}

function isExactLegacyWorkerLabel(value) {
  const label = clean(value);
  return /^(?:全栈工程师\s*\d+|[A-Za-z0-9._-]+-全栈工程师(?:\s*\d+)?)$/u.test(label);
}

function isTrustedLegacyWorker(record, directoryId) {
  return !!record
    && record.dirId === directoryId
    && record.kind === 'chat'
    && !record.ephemeral
    && !record.type
    && isExactLegacyWorkerLabel(record.label)
    && hasLegacyWorkerPromptSignature(record.rolePrompt);
}

function isWorkerRecord(record, directoryId) {
  return !!record
    && record.dirId === directoryId
    && record.kind === 'chat'
    && record.type === WORKER_TYPE;
}

function isTaskExecutionSlot(record, directoryId) {
  return isWorkerRecord(record, directoryId) && record.taskExecutionSlot === true;
}

function isOrdinaryWorker(record, directoryId) {
  return isWorkerRecord(record, directoryId) && record.taskExecutionSlot !== true;
}

function supportsTaskRunCleanup(record) {
  return TASK_RUN_CLI_SET.has(clean(record?.cli).toLowerCase());
}

function activityMs(record) {
  const raw = record && (record.lastActivity || record.updatedAt || record.createdAt);
  const value = typeof raw === 'number' ? raw : Date.parse(raw || '');
  return Number.isFinite(value) ? value : 0;
}

function chooseWorker(records, message) {
  const context = taskBoard.buildRoutingContext({ queryText: message });
  return [...records].sort((a, b) => {
    const relevance = taskBoard.routingRelevanceScore(context, b)
      - taskBoard.routingRelevanceScore(context, a);
    if (relevance) return relevance;
    const activity = activityMs(a) - activityMs(b);
    if (activity) return activity;
    return clean(a.id).localeCompare(clean(b.id));
  })[0] || null;
}

function createCommanderRouter(options = {}) {
  const {
    records,
    isBusy,
    stampWorker,
    createWorker,
    dispatchOneWay,
  } = options;
  if (!(records instanceof Map)) throw new TypeError('[commander-router] records Map required');
  for (const [name, value] of Object.entries({ isBusy, stampWorker, createWorker, dispatchOneWay })) {
    if (typeof value !== 'function') throw new TypeError(`[commander-router] ${name} port required`);
  }
  const maxElasticWorkers = Math.max(1, Number.isSafeInteger(options.maxElasticWorkers)
    ? options.maxElasticWorkers : DEFAULT_MAX_ELASTIC_WORKERS);
  const logger = options.logger || console;
  const directoryLocks = new Map();

  function withDirectoryLock(directoryId, work) {
    const previous = directoryLocks.get(directoryId) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    directoryLocks.set(directoryId, current);
    return current.finally(() => {
      if (directoryLocks.get(directoryId) === current) directoryLocks.delete(directoryId);
    });
  }

  async function adoptLegacyWorkers(directoryId) {
    const legacy = [...records.values()]
      .filter(record => isTrustedLegacyWorker(record, directoryId))
      .sort((a, b) => clean(a.id).localeCompare(clean(b.id)));
    for (const record of legacy) await Promise.resolve(stampWorker(record.id, directoryId));
  }

  function workersFor(directoryId, { taskExecutionSlotsOnly = false } = {}) {
    return [...records.values()].filter(record => (
      taskExecutionSlotsOnly
        ? isTaskExecutionSlot(record, directoryId)
        : isOrdinaryWorker(record, directoryId)
    ));
  }

  async function ensureTarget(commander, message, { taskRunId = '' } = {}) {
    const taskRun = !!clean(taskRunId);
    if (!taskRun) await adoptLegacyWorkers(commander.dirId);
    let allWorkers = workersFor(commander.dirId, { taskExecutionSlotsOnly: taskRun });
    let workers = taskRun
      ? allWorkers.filter(record => (
        record.taskRunQuarantined !== true && supportsTaskRunCleanup(record)
      ))
      : allWorkers;
    const idle = workers.filter(record => {
      try { return !isBusy(record.id); } catch (_) { return false; }
    });
    if (idle.length) return { record: chooseWorker(idle, message), created: false, queued: false };

    const elasticCount = taskRun
      ? allWorkers.length
      : workers.filter(record => record.elasticWorker === true).length;
    if (!allWorkers.length || elasticCount < maxElasticWorkers) {
      const templates = taskRun
        ? workersFor(commander.dirId).filter(supportsTaskRunCleanup)
        : workers;
      const template = chooseWorker(templates.filter(record => (
        record.taskExecutionSlot !== true && record.elasticWorker !== true
      )), message) || chooseWorker(templates, message);
      if (taskRun && !template && !supportsTaskRunCleanup(commander)) {
        return { code: 'task_run_cli_unsupported' };
      }
      try {
        const created = await createWorker({
          commander,
          template,
          ordinal: allWorkers.length + 1,
          rolePrompt: clean(template?.rolePrompt) || DEFAULT_WORKER_PROMPT,
          taskExecutionSlot: taskRun,
        });
        const record = created && (created.session || (created.id && records.get(created.id)));
        if (created?.ok && (taskRun
          ? isTaskExecutionSlot(record, commander.dirId) && supportsTaskRunCleanup(record)
          : isOrdinaryWorker(record, commander.dirId))) {
          return { record, created: true, queued: false };
        }
      } catch (error) {
        try { logger.warn('commander_elastic_worker_create_failed', { directoryId: commander.dirId, error: error.message }); } catch (_) {}
      }
    }

    allWorkers = workersFor(commander.dirId, { taskExecutionSlotsOnly: taskRun });
    workers = taskRun
      ? allWorkers.filter(record => (
        record.taskRunQuarantined !== true && supportsTaskRunCleanup(record)
      ))
      : allWorkers;
    const fallback = chooseWorker(workers, message);
    if (fallback) return { record: fallback, created: false, queued: true };
    if (taskRun && allWorkers.some(record => !supportsTaskRunCleanup(record))) {
      return { code: 'task_run_cli_unsupported' };
    }
    return null;
  }

  async function route(input = {}) {
    const commanderId = clean(input.commanderId);
    const message = clean(input.message);
    const commander = records.get(commanderId);
    if (!commander || commander.kind !== 'chat' || commander.type !== 'commander' || !commander.dirId) {
      return { ok: false, code: 'commander_not_found' };
    }
    if (!message) return { ok: false, code: 'empty_message' };

    return withDirectoryLock(commander.dirId, async () => {
      const taskRunId = clean(input.taskRunId);
      const leaseEpoch = Number.isSafeInteger(Number(input.leaseEpoch))
        && Number(input.leaseEpoch) > 0 ? Number(input.leaseEpoch) : null;
      const target = await ensureTarget(commander, message, { taskRunId });
      if (!target?.record) return { ok: false, code: target?.code || 'worker_unavailable' };
      const dispatched = await dispatchOneWay(target.record.id, message, {
        commanderId,
        idempotencyKey: clean(input.idempotencyKey) || null,
        queued: target.queued,
        taskId: clean(input.taskId) || null,
        taskStart: input.taskStart === true,
        taskSource: clean(input.taskSource) || null,
        taskText: typeof input.taskText === 'string' ? input.taskText : '',
        taskRunId: taskRunId || null,
        leaseEpoch,
      });
      if (!dispatched?.ok) {
        return { ok: false, code: dispatched?.code || dispatched?.error || 'dispatch_failed' };
      }
      return {
        ok: true,
        commanderSessionId: commanderId,
        targetSessionId: target.record.id,
        targetLabel: target.record.label || target.record.id,
        operationId: dispatched.operationId || null,
        status: target.queued ? 'queued' : (dispatched.status || 'admitted'),
        queued: target.queued,
        elasticWorkerCreated: target.created,
        taskRunId: taskRunId || null,
      };
    });
  }

  return Object.freeze({ route, workersFor });
}

module.exports = {
  WORKER_TYPE,
  TASK_RUN_CLIS,
  DEFAULT_MAX_ELASTIC_WORKERS,
  DEFAULT_WORKER_PROMPT,
  createCommanderRouter,
  hasLegacyWorkerPromptSignature,
  isExactLegacyWorkerLabel,
  isTrustedLegacyWorker,
  isWorkerRecord,
  isTaskExecutionSlot,
  supportsTaskRunCleanup,
  chooseWorker,
};
