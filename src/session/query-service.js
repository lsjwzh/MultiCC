'use strict';

const { toSessionDto } = require('../session-dto');
const { assertSessionRecordsPort, assertSessionRuntimePort } = require('./ports');

const HIDDEN_SESSION_TYPES = new Set(['aux', 'gateway']);

function safeRuntime(runtime, record) {
  const value = runtime.read(record.id, record);
  return value && typeof value === 'object' ? value : {};
}

function sessionDtoPresenter({ record, runtime }) {
  return toSessionDto({
    id: record.id,
    dirId: record.dirId,
    cli: record.cli,
    kind: record.kind,
    label: record.label,
    model: record.model,
    effectiveModel: runtime.effectiveModel,
    effort: record.effort,
    effectiveEffort: runtime.effectiveEffort,
    agent: record.agent,
    provider: record.provider,
    experimentalMode: record.experimentalMode,
    subagent: runtime.subagent === undefined ? record.subagent : runtime.subagent,
    autoCommit: record.autoCommit,
    createdAt: record.createdAt,
    lastActivity: runtime.lastActivity,
    clients: runtime.clients,
    active: runtime.active,
    mergeState: runtime.mergeState,
  });
}

function createSessionQueryService({ records, runtime, presenter = sessionDtoPresenter } = {}) {
  assertSessionRecordsPort(records);
  assertSessionRuntimePort(runtime);
  if (typeof presenter !== 'function') throw new TypeError('[session] presenter must be a function');

  function context(record, {
    includeHidden = false,
    includeTaskExecutionSlots = false,
  } = {}) {
    if (!record || typeof record !== 'object') return null;
    // `includeHidden` predates TaskRun pools and is used by legacy admin
    // projections for aux/gateway records. It must not accidentally grant
    // access to the separate internal execution-slot namespace.
    if (record.taskExecutionSlot === true && !includeTaskExecutionSlots) return null;
    if (!includeHidden && HIDDEN_SESSION_TYPES.has(record.type)) return null;
    return Object.freeze({ record, runtime: safeRuntime(runtime, record) });
  }

  function presentContext(value, selectedPresenter = presenter) {
    if (!value) return null;
    if (typeof selectedPresenter !== 'function') {
      throw new TypeError('[session] selected presenter must be a function');
    }
    return selectedPresenter(value);
  }

  function project(record, options = {}) {
    const value = context(record, options);
    return presentContext(value, options.presenter || presenter);
  }

  function listContexts({
    dirId,
    includeHidden = false,
    includeTaskExecutionSlots = false,
    filter,
  } = {}) {
    const source = records.list();
    if (!source || typeof source[Symbol.iterator] !== 'function') {
      throw new TypeError('[session] records.list() must return an iterable');
    }
    const result = [];
    for (const record of source) {
      if (dirId !== undefined && record && record.dirId !== dirId) continue;
      if (typeof filter === 'function' && !filter(record)) continue;
      const value = context(record, { includeHidden, includeTaskExecutionSlots });
      if (value) result.push(value);
    }
    return result;
  }

  function list(options = {}) {
    const selectedPresenter = options.presenter || presenter;
    return listContexts(options).map(value => presentContext(value, selectedPresenter));
  }

  function getContext(id, {
    includeHidden = false,
    includeTaskExecutionSlots = false,
  } = {}) {
    const key = String(id || '');
    if (!key) return null;
    return context(records.get(key), { includeHidden, includeTaskExecutionSlots });
  }

  function get(id, options = {}) {
    return presentContext(getContext(id, options), options.presenter || presenter);
  }

  return Object.freeze({
    context,
    get,
    getContext,
    list,
    listContexts,
    presentContext,
    project,
  });
}

module.exports = {
  HIDDEN_SESSION_TYPES,
  createSessionQueryService,
  sessionDtoPresenter,
};
