'use strict';

const crypto = require('crypto');
const { resolveDirectoryCommander } = require('./task-board');

const GATEWAY_RECORD_TYPE = 'gateway';
const GATEWAY_KIND = 'qwen-audio';
const GATEWAY_PROVIDER = 'qwen-audio-agent';

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

function isVoiceGatewayRecord(record, directoryId = null) {
  if (!record || record.type !== GATEWAY_RECORD_TYPE || record.gatewayKind !== GATEWAY_KIND) {
    return false;
  }
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

  return Object.freeze({
    ensure,
    inspect,
    list,
    remove,
  });
}

module.exports = {
  GATEWAY_KIND,
  GATEWAY_PROVIDER,
  GATEWAY_RECORD_TYPE,
  bindingState,
  createVoiceGatewayService,
  gatewayDto,
  isVoiceGatewayRecord,
  recordsForDirectory,
  resolveVoiceGateway,
  voiceGatewayId,
};
