'use strict';

const { toSessionDto } = require('../session-dto');
const { assertSessionRecordsPort, assertSessionRuntimePort } = require('./ports');

const HIDDEN_SESSION_TYPES = new Set(['aux', 'gateway']);

function safeRuntime(runtime, record) {
  const value = runtime.read(record.id, record);
  return value && typeof value === 'object' ? value : {};
}

function createSessionQueryService({ records, runtime } = {}) {
  assertSessionRecordsPort(records);
  assertSessionRuntimePort(runtime);

  function project(record) {
    if (!record || typeof record !== 'object' || HIDDEN_SESSION_TYPES.has(record.type)) return null;
    const live = safeRuntime(runtime, record);
    return toSessionDto({
      id: record.id,
      dirId: record.dirId,
      cli: record.cli,
      kind: record.kind,
      label: record.label,
      model: record.model,
      effectiveModel: live.effectiveModel,
      effort: record.effort,
      effectiveEffort: live.effectiveEffort,
      agent: record.agent,
      provider: record.provider,
      subagent: live.subagent === undefined ? record.subagent : live.subagent,
      autoCommit: record.autoCommit,
      autoDispatch: record.autoDispatch,
      createdAt: record.createdAt,
      lastActivity: live.lastActivity,
      clients: live.clients,
      active: live.active,
      mergeState: live.mergeState,
    });
  }

  function list({ dirId } = {}) {
    const source = records.list();
    if (!source || typeof source[Symbol.iterator] !== 'function') {
      throw new TypeError('[session] records.list() must return an iterable');
    }
    const result = [];
    for (const record of source) {
      if (dirId !== undefined && record && record.dirId !== dirId) continue;
      const dto = project(record);
      if (dto) result.push(dto);
    }
    return result;
  }

  function get(id) {
    const key = String(id || '');
    if (!key) return null;
    return project(records.get(key));
  }

  return Object.freeze({ get, list, project });
}

module.exports = { HIDDEN_SESSION_TYPES, createSessionQueryService };
