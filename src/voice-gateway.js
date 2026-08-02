'use strict';

const crypto = require('crypto');
const { resolveDirectoryCommander } = require('./task-board');

const GATEWAY_RECORD_TYPE = 'gateway';
const GATEWAY_KIND = 'qwen-audio';
const GATEWAY_PROVIDER = 'qwen-audio-agent';

// Realtime voice is one machine-wide runtime, not one per Fleet. The per-Fleet
// records below predate that and are kept only so an upgrade loses no user
// intent: they are projected read-only as `legacy`, and the supervisor refuses
// to start them. Deleting them on upgrade would be a destructive migration for
// no gain, so they stay until the compatibility window closes.
const GLOBAL_VOICE_GATEWAY_ID = '__voice_gateway__';
const GATEWAY_SCOPE_GLOBAL = 'global';

function cleanId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function voiceGatewayId(directoryId) {
  const dirId = cleanId(directoryId);
  if (!dirId) throw new TypeError('voice gateway requires directoryId');
  const suffix = crypto.createHash('sha256').update(dirId, 'utf8').digest('hex').slice(0, 32);
  return `__voice_gateway__${suffix}`;
}

function isGlobalVoiceGatewayRecord(record) {
  return !!record
    && record.id === GLOBAL_VOICE_GATEWAY_ID
    && record.type === GATEWAY_RECORD_TYPE
    && record.gatewayKind === GATEWAY_KIND;
}

// Fleet-scoped predicate. The global record deliberately fails this test: every
// existing caller means "the gateway belonging to this Fleet", and answering yes
// for the global singleton would let legacy code start a second child.
function isVoiceGatewayRecord(record, directoryId = null) {
  if (!record || record.type !== GATEWAY_RECORD_TYPE || record.gatewayKind !== GATEWAY_KIND) {
    return false;
  }
  if (isGlobalVoiceGatewayRecord(record)) return false;
  const dirId = cleanId(directoryId);
  return !dirId || record.dirId === dirId;
}

function recordsForDirectory(records, directoryId) {
  const dirId = cleanId(directoryId);
  if (!dirId) return [];
  return [...(records || new Map()).values()]
    .filter(record => isVoiceGatewayRecord(record, dirId))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function resolveVoiceGateway(records, directoryId) {
  const dirId = cleanId(directoryId);
  if (!dirId) return { ok: false, code: 'directory_required' };
  const matches = recordsForDirectory(records, dirId);
  if (!matches.length) return { ok: false, code: 'voice_gateway_not_found' };
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'voice_gateway_ambiguous',
      gatewayIds: matches.map(record => record.id),
    };
  }
  return { ok: true, record: matches[0] };
}

function bindingState(records, gateway) {
  if (!gateway || !isVoiceGatewayRecord(gateway)) {
    return { ready: false, code: 'voice_gateway_not_found', commanderSessionId: null };
  }
  const uniqueGateway = resolveVoiceGateway(records, gateway.dirId);
  if (!uniqueGateway.ok) {
    return { ready: false, code: uniqueGateway.code, commanderSessionId: null };
  }
  const commander = resolveDirectoryCommander(records, gateway.dirId);
  if (!commander.ok) {
    return { ready: false, code: commander.code, commanderSessionId: null };
  }
  if (gateway.commanderSessionId !== commander.sessionId) {
    return {
      ready: false,
      code: 'commander_binding_stale',
      commanderSessionId: commander.sessionId,
    };
  }
  if (gateway.enabled !== true) {
    return { ready: false, code: 'voice_gateway_disabled', commanderSessionId: commander.sessionId };
  }
  return { ready: true, code: null, commanderSessionId: commander.sessionId };
}

function gatewayDto(records, gateway) {
  const binding = bindingState(records, gateway);
  const commander = binding.commanderSessionId
    ? records.get(binding.commanderSessionId)
    : null;
  return {
    id: gateway.id,
    directoryId: gateway.dirId,
    type: 'voice_gateway',
    provider: GATEWAY_PROVIDER,
    enabled: gateway.enabled === true,
    commanderSessionId: gateway.commanderSessionId || null,
    commanderLabel: commander?.label || null,
    binding: {
      ready: binding.ready,
      code: binding.code,
      canonicalCommanderSessionId: binding.commanderSessionId,
    },
    createdAt: timestamp(gateway.createdAt),
    updatedAt: timestamp(gateway.updatedAt),
  };
}

function globalGatewayDto(record) {
  if (!record) {
    return {
      id: GLOBAL_VOICE_GATEWAY_ID,
      scope: GATEWAY_SCOPE_GLOBAL,
      type: 'voice_gateway',
      provider: GATEWAY_PROVIDER,
      configured: false,
      enabled: false,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    id: GLOBAL_VOICE_GATEWAY_ID,
    scope: GATEWAY_SCOPE_GLOBAL,
    type: 'voice_gateway',
    provider: GATEWAY_PROVIDER,
    configured: true,
    enabled: record.enabled === true,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
  };
}

// Read-only view of the pre-global records, so the管理页 can explain where a
// Fleet's old toggle went instead of silently dropping it.
function legacyGatewayProjection(records) {
  return [...(records || new Map()).values()]
    .filter(record => isVoiceGatewayRecord(record))
    .sort((left, right) => String(left.dirId).localeCompare(String(right.dirId)))
    .map(record => ({
      id: record.id,
      directoryId: record.dirId,
      enabled: record.enabled === true,
      legacy: true,
      active: false,
      supersededBy: GLOBAL_VOICE_GATEWAY_ID,
    }));
}

function createVoiceGatewayService({
  records,
  directories,
  mutate,
  now = () => new Date().toISOString(),
} = {}) {
  if (!(records instanceof Map)) throw new TypeError('voice gateway records Map is required');
  if (!(directories instanceof Map)) throw new TypeError('voice gateway directories Map is required');
  if (typeof mutate !== 'function') throw new TypeError('voice gateway mutate port is required');

  function requireDirectory(directoryId) {
    const dirId = cleanId(directoryId);
    if (!dirId) return { ok: false, code: 'directory_required' };
    if (!directories.has(dirId)) return { ok: false, code: 'directory_not_found' };
    return { ok: true, dirId };
  }

  function inspect(directoryId) {
    const directory = requireDirectory(directoryId);
    if (!directory.ok) return directory;
    const gateway = resolveVoiceGateway(records, directory.dirId);
    if (!gateway.ok) return gateway;
    return {
      ok: true,
      record: gateway.record,
      gateway: gatewayDto(records, gateway.record),
    };
  }

  function list() {
    return [...records.values()]
      .filter(record => isVoiceGatewayRecord(record))
      .sort((left, right) => String(left.dirId).localeCompare(String(right.dirId)))
      .map(record => gatewayDto(records, record));
  }

  function ensure(directoryId, options = {}) {
    const directory = requireDirectory(directoryId);
    if (!directory.ok) return directory;
    const existing = recordsForDirectory(records, directory.dirId);
    if (existing.length > 1) {
      return {
        ok: false,
        code: 'voice_gateway_ambiguous',
        gatewayIds: existing.map(record => record.id),
      };
    }
    const commander = resolveDirectoryCommander(records, directory.dirId);
    if (!commander.ok) return commander;
    if (options.commanderSessionId !== undefined) {
      return { ok: false, code: 'commander_binding_is_host_owned' };
    }
    if (options.provider !== undefined && options.provider !== GATEWAY_PROVIDER) {
      return { ok: false, code: 'voice_gateway_provider_invalid' };
    }
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
      return { ok: false, code: 'voice_gateway_enabled_invalid' };
    }

    const timestamp = now();
    let created = false;
    let record;
    mutate('http.voice-gateway-put', draft => {
      record = existing[0] || null;
      if (!record) {
        const id = voiceGatewayId(directory.dirId);
        const collision = draft.get(id);
        if (collision && !isVoiceGatewayRecord(collision, directory.dirId)) {
          const error = new Error('voice gateway id collision');
          error.code = 'voice_gateway_id_conflict';
          throw error;
        }
        record = {
          id,
          dirId: directory.dirId,
          type: GATEWAY_RECORD_TYPE,
          kind: 'voice',
          gatewayKind: GATEWAY_KIND,
          label: 'Qwen Audio Voice Gateway',
          enabled: options.enabled !== false,
          commanderSessionId: commander.sessionId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        draft.set(id, record);
        created = true;
        return;
      }
      record.commanderSessionId = commander.sessionId;
      record.kind = 'voice';
      record.enabled = options.enabled === undefined ? record.enabled === true : options.enabled;
      record.updatedAt = timestamp;
    });
    return {
      ok: true,
      created,
      record,
      gateway: gatewayDto(records, record),
    };
  }

  function remove(directoryId) {
    const directory = requireDirectory(directoryId);
    if (!directory.ok) return directory;
    const gateway = resolveVoiceGateway(records, directory.dirId);
    if (!gateway.ok) return gateway;
    mutate('http.voice-gateway-delete', draft => draft.delete(gateway.record.id));
    return { ok: true, id: gateway.record.id, directoryId: directory.dirId };
  }

  function globalRecord() {
    const record = records.get(GLOBAL_VOICE_GATEWAY_ID);
    return isGlobalVoiceGatewayRecord(record) ? record : null;
  }

  function inspectGlobal() {
    return {
      ok: true,
      record: globalRecord(),
      gateway: globalGatewayDto(globalRecord()),
      legacy: legacyGatewayProjection(records),
    };
  }

  // First write also carries the migration: if any Fleet had realtime voice
  // switched on before this became global, the global gateway inherits that
  // intent instead of silently arriving disabled. The old records are left
  // untouched — read-only projection, never a second running child.
  function ensureGlobal(options = {}) {
    if (options.commanderSessionId !== undefined) {
      return { ok: false, code: 'commander_binding_is_host_owned' };
    }
    if (options.provider !== undefined && options.provider !== GATEWAY_PROVIDER) {
      return { ok: false, code: 'voice_gateway_provider_invalid' };
    }
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
      return { ok: false, code: 'voice_gateway_enabled_invalid' };
    }
    const stamp = now();
    let created = false;
    let record = null;
    mutate('http.voice-gateway-global-put', draft => {
      const existing = draft.get(GLOBAL_VOICE_GATEWAY_ID);
      if (existing && !isGlobalVoiceGatewayRecord(existing)) {
        const error = new Error('voice gateway id collision');
        error.code = 'voice_gateway_id_conflict';
        throw error;
      }
      if (!existing) {
        const inheritedEnabled = legacyGatewayProjection(records).some(entry => entry.enabled);
        record = {
          id: GLOBAL_VOICE_GATEWAY_ID,
          dirId: null,
          type: GATEWAY_RECORD_TYPE,
          kind: 'voice',
          gatewayKind: GATEWAY_KIND,
          scope: GATEWAY_SCOPE_GLOBAL,
          label: 'Qwen Realtime Voice Gateway',
          enabled: options.enabled === undefined ? inheritedEnabled : options.enabled,
          createdAt: stamp,
          updatedAt: stamp,
        };
        draft.set(GLOBAL_VOICE_GATEWAY_ID, record);
        created = true;
        return;
      }
      record = existing;
      record.scope = GATEWAY_SCOPE_GLOBAL;
      record.kind = 'voice';
      record.dirId = null;
      if (options.enabled !== undefined) record.enabled = options.enabled;
      record.updatedAt = stamp;
    });
    return { ok: true, created, record, gateway: globalGatewayDto(record) };
  }

  function removeGlobal() {
    if (!globalRecord()) return { ok: false, code: 'voice_gateway_not_found' };
    mutate('http.voice-gateway-global-delete', draft => draft.delete(GLOBAL_VOICE_GATEWAY_ID));
    return { ok: true, id: GLOBAL_VOICE_GATEWAY_ID };
  }

  return Object.freeze({
    ensure,
    ensureGlobal,
    inspect,
    inspectGlobal,
    list,
    remove,
    removeGlobal,
  });
}

module.exports = {
  GATEWAY_KIND,
  GATEWAY_PROVIDER,
  GATEWAY_RECORD_TYPE,
  GATEWAY_SCOPE_GLOBAL,
  GLOBAL_VOICE_GATEWAY_ID,
  bindingState,
  createVoiceGatewayService,
  gatewayDto,
  globalGatewayDto,
  isGlobalVoiceGatewayRecord,
  isVoiceGatewayRecord,
  legacyGatewayProjection,
  recordsForDirectory,
  resolveVoiceGateway,
  voiceGatewayId,
};
