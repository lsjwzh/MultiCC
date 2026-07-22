'use strict';

// Startup/upgrade migration for the Fleet Commander invariant.
//
// This module deliberately owns no filesystem, Git or persistence code.  The
// host supplies the existing session-creation service as a port, which keeps a
// migrated Commander identical to one created through the normal API: a real
// chat session with its own branch/worktree and the complete preset prompt.

const COMMANDER_TYPE = 'commander';
const COMMANDER_LABEL = '🫡 Agent Commander';

function cleanId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isCommanderRecord(record, directoryId) {
  return !!record
    && record.kind === 'chat'
    && record.type === COMMANDER_TYPE
    && !record.ephemeral
    && record.dirId === directoryId;
}

function availabilityFlag(value) {
  return value === true || !!(value && typeof value === 'object' && value.available === true);
}

function commanderDirectoryValidity(directory, directories, helpers = {}) {
  const { exists, isDirectory, isHomeOrAbove, realPathOf } = helpers;
  if (!directory || !directory.id || !directory.path
      || typeof exists !== 'function' || !exists(directory.path)
      || typeof isHomeOrAbove !== 'function' || isHomeOrAbove(directory.path)) {
    return { valid: false, code: 'commander_directory_invalid' };
  }
  try {
    if (typeof isDirectory !== 'function' || !isDirectory(directory.path)) {
      return { valid: false, code: 'commander_directory_invalid' };
    }
  } catch (_) {
    return { valid: false, code: 'commander_directory_invalid' };
  }
  const physical = realPathOf(directory.path);
  const canonical = [...directories.values()]
    .filter(candidate => candidate?.id && candidate.path && realPathOf(candidate.path) === physical)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || String(a.id).localeCompare(String(b.id)))[0];
  return canonical && canonical.id !== directory.id
    ? { valid: false, code: 'commander_directory_duplicate' }
    : { valid: true };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function chooseCommanderRuntime({
  directory,
  records,
  preset,
  supportedClis,
  availability,
  providerDefaults,
  listProviders,
} = {}) {
  const supported = Array.isArray(supportedClis) ? supportedClis.map(cleanId).filter(Boolean) : [];
  const fleetRecords = [...(records || new Map()).values()]
    .filter(record => record && record.dirId === directory?.id && record.kind === 'chat' && !record.ephemeral)
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const candidates = unique([
    cleanId(directory?.commanderCli),
    cleanId(directory?.defaultCli),
    cleanId(preset?.defaultCli),
    ...fleetRecords.map(record => cleanId(record.cli)),
    'codex',
    'claude',
    ...supported,
  ]).filter(cli => supported.includes(cli));
  const cli = candidates.find(candidate => availabilityFlag(availability?.[candidate]));
  if (!cli) {
    return { ok: false, code: 'commander_cli_unavailable', candidates };
  }

  const providers = typeof listProviders === 'function'
    ? (listProviders(cli) || []).filter(item => item && cleanId(item.id))
    : [];
  const providerIds = new Set(providers.map(item => cleanId(item.id)));
  const configuredDefault = cleanId(providerDefaults?.[cli]);
  const fleetProvider = fleetRecords
    .filter(record => record.cli === cli)
    .map(record => cleanId(record.provider))
    .find(id => providerIds.has(id));
  const provider = providerIds.has(configuredDefault)
    ? configuredDefault
    : (fleetProvider || cleanId(providers[0]?.id) || null);

  // Follow the selected CLI/provider's current default.  Persisting a preset
  // model here would make every migrated install retain a model that may have
  // disappeared since the release was built.
  return { ok: true, cli, provider, model: null };
}

function publicFailure(error, fallback = 'commander_migration_failed') {
  const code = cleanId(error?.code || error?.error || fallback);
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(code) ? code : fallback;
}

function createCommanderMigrationState() {
  let phase = 'pending';
  let startedAt = null;
  let completedAt = null;
  const directories = new Map();

  function setPhase(next) {
    phase = next;
    if (next === 'running') startedAt = new Date().toISOString();
    if (next === 'complete') completedAt = new Date().toISOString();
  }

  function setDirectory(directoryId, result) {
    const id = cleanId(directoryId);
    if (!id) return;
    directories.set(id, Object.freeze({ directoryId: id, ...result }));
  }

  function statusFor(directoryId) {
    const id = cleanId(directoryId);
    if (phase === 'pending' || phase === 'running') {
      return { ready: false, phase, directoryId: id || null, code: 'commander_migration_pending' };
    }
    const result = directories.get(id);
    if (!result) {
      return { ready: false, phase, directoryId: id || null, code: 'commander_migration_required' };
    }
    return {
      ready: result.status === 'ready',
      phase,
      directoryId: id,
      code: result.status === 'ready' ? null : result.code,
      sessionId: result.sessionId || null,
    };
  }

  function snapshot() {
    const values = [...directories.values()];
    const failures = values
      .filter(result => result.status === 'failed')
      .map(result => ({ directoryId: result.directoryId, code: result.code }));
    return {
      phase,
      ready: phase === 'complete' && failures.length === 0,
      startedAt,
      completedAt,
      directoryCount: values.length,
      readyCount: values.filter(result => result.status === 'ready').length,
      skippedCount: values.filter(result => result.status === 'skipped').length,
      failures,
    };
  }

  return Object.freeze({ setPhase, setDirectory, statusFor, snapshot });
}

function createCommanderMigration(options = {}) {
  const {
    state,
    directories,
    records,
    commanderPrompt,
    commanderPreset,
    selectRuntime,
    createSession,
    refreshSession,
    validateDirectory,
    validateSession,
  } = options;
  if (!state || typeof state.setDirectory !== 'function') throw new TypeError('commander migration state required');
  if (!(directories instanceof Map) || !(records instanceof Map)) throw new TypeError('commander migration Maps required');
  if (typeof selectRuntime !== 'function' || typeof createSession !== 'function') {
    throw new TypeError('commander migration session ports required');
  }
  const logger = options.logger || console;

  function report(directoryId, result) {
    state.setDirectory(directoryId, result);
    const log = result.status === 'failed' ? (logger.error || logger.log) : (logger.info || logger.log);
    if (typeof log === 'function') {
      log.call(logger, 'commander_migration_directory', {
        directoryId,
        status: result.status,
        action: result.action || null,
        code: result.code || null,
        sessionId: result.sessionId || null,
      });
    }
    return { directoryId, ...result };
  }

  async function migrateDirectory(directory) {
    const directoryId = cleanId(directory?.id);
    if (!directoryId) return report('unknown', { status: 'failed', code: 'commander_directory_invalid' });
    try {
      const validity = typeof validateDirectory === 'function'
        ? await validateDirectory(directory)
        : { valid: true };
      if (!validity || validity.valid === false) {
        return report(directoryId, {
          status: 'skipped',
          code: publicFailure(validity, 'commander_directory_invalid'),
        });
      }

      const typed = [...records.values()].filter(record => isCommanderRecord(record, directoryId));
      if (typed.length > 1) {
        return report(directoryId, { status: 'failed', code: 'commander_ambiguous' });
      }
      if (typed.length === 1) {
        const validity = typeof validateSession === 'function' ? await validateSession(typed[0]) : { valid: true };
        if (!validity || validity.valid === false) {
          return report(directoryId, {
            status: 'failed', code: publicFailure(validity, 'commander_session_invalid'),
          });
        }
        const prompt = typeof commanderPrompt === 'function' ? commanderPrompt() : null;
        const needsRefresh = typeof prompt === 'string' && prompt.trim()
          && typed[0].rolePrompt !== prompt;
        if (needsRefresh && typeof refreshSession === 'function') {
          await refreshSession(typed[0].id, directoryId, prompt);
        }
        return report(directoryId, {
          status: 'ready', action: needsRefresh && typeof refreshSession === 'function' ? 'refreshed' : 'existing', sessionId: typed[0].id,
        });
      }

      const prompt = typeof commanderPrompt === 'function' ? commanderPrompt() : null;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return report(directoryId, { status: 'failed', code: 'commander_preset_unavailable' });
      }
      const preset = typeof commanderPreset === 'function' ? commanderPreset() : null;
      const runtime = await selectRuntime(directory, preset);
      if (!runtime || !runtime.ok) {
        return report(directoryId, {
          status: 'failed', code: publicFailure(runtime, 'commander_runtime_unavailable'),
        });
      }
      const created = await createSession({
        dir: directory,
        cli: runtime.cli,
        kind: 'chat',
        label: COMMANDER_LABEL,
        type: COMMANDER_TYPE,
        provider: runtime.provider,
        model: runtime.model,
        rolePrompt: prompt,
        persistence: 'required',
        persistenceSource: 'startup.commander-migration',
      });
      if (!created || !created.ok || !isCommanderRecord(created.session, directoryId)) {
        return report(directoryId, {
          status: 'failed', code: publicFailure(created, 'commander_create_failed'),
        });
      }
      return report(directoryId, {
        status: 'ready', action: 'created', sessionId: created.session.id,
      });
    } catch (error) {
      return report(directoryId, {
        status: 'failed', code: publicFailure(error),
      });
    }
  }

  async function run() {
    state.setPhase('running');
    const results = [];
    const ordered = [...directories.values()]
      .sort((a, b) => cleanId(a.id).localeCompare(cleanId(b.id)));
    for (const directory of ordered) results.push(await migrateDirectory(directory));
    state.setPhase('complete');
    const summary = state.snapshot();
    const log = summary.ready ? (logger.info || logger.log) : (logger.error || logger.log);
    if (typeof log === 'function') log.call(logger, 'commander_migration_complete', summary);
    return { ...summary, results };
  }

  return Object.freeze({ run, migrateDirectory });
}

module.exports = {
  COMMANDER_LABEL,
  COMMANDER_TYPE,
  chooseCommanderRuntime,
  commanderDirectoryValidity,
  createCommanderMigration,
  createCommanderMigrationState,
  isCommanderRecord,
};
