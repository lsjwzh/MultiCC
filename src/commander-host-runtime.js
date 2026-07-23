'use strict';

const {
  WORKER_TYPE,
  createCommanderRouter,
  isTrustedLegacyWorker,
} = require('./commander-router');
const {
  chooseCommanderRuntime,
  commanderDirectoryValidity,
  createCommanderMigration,
} = require('./commander-migration');

function createCommanderRoutingHost(options = {}) {
  if (!(options.records instanceof Map) || !(options.directories instanceof Map)) {
    throw new TypeError('[commander-host] records and directories Maps required');
  }
  const mutateSessions = options.mutateSessions
    || ((source, mutate) => options.sessionPersistence.mutate(source, mutate));
  const createSession = options.createSession || options.createSessionRecord;
  const dispatch = options.dispatch || options.dispatchToSession;
  for (const [name, value] of Object.entries({ isBusy: options.isBusy, mutateSessions, createSession, dispatch })) {
    if (typeof value !== 'function') throw new TypeError(`[commander-host] ${name} port required`);
  }
  const { records, directories } = options;
  return createCommanderRouter({
    records,
    isBusy: options.isBusy,
    maxElasticWorkers: Math.max(1, Number(options.maxElasticWorkers) || 4),
    stampWorker: (sessionId, directoryId) => mutateSessions(
      'runtime.commander-worker-stamp', sessionRecords => {
        const record = sessionRecords.get(sessionId);
        if (!isTrustedLegacyWorker(record, directoryId)) {
          const error = new Error('legacy worker evidence changed');
          error.code = 'worker_legacy_changed';
          throw error;
        }
        record.type = WORKER_TYPE;
        return record;
      }),
    createWorker: ({ commander, template, ordinal, rolePrompt }) => {
      const dir = directories.get(commander.dirId);
      if (!dir) return { ok: false, code: 'directory_not_found' };
      return createSession({
        dir,
        cli: template?.cli || commander.cli || 'claude', kind: 'chat',
        label: `弹性 Worker ${ordinal}`, ephemeral: true,
        model: template?.model || commander.model || null,
        provider: template?.provider || commander.provider || '',
        effort: template?.effort || (commander.cli === 'codex' ? 'high' : null),
        agent: template?.agent || null, rolePrompt,
        type: WORKER_TYPE, elasticWorker: true,
        persistence: 'required', persistenceSource: 'runtime.commander-elastic-worker-create',
      });
    },
    dispatchOneWay: (target, message, routeOptions) => dispatch(target, message, {
      ownerSessionId: routeOptions.commanderId,
      idempotencyKey: routeOptions.idempotencyKey,
      oneWay: true,
      requireIdle: false,
      taskId: routeOptions.taskId,
      taskStart: routeOptions.taskStart,
      taskSource: routeOptions.taskSource,
      taskText: routeOptions.taskText,
    }),
    logger: options.logger,
  });
}

function createCommanderMigrationHost(options = {}) {
  const mutateSessions = options.mutateSessions
    || ((source, mutate) => options.sessionPersistence.mutate(source, mutate));
  const createSession = options.createSession || options.createSessionRecord;
  const availability = options.availability || options.cliAvailabilitySummary;
  const listProviders = options.listProviders || (cli => options.providers.listProviders(cli));
  return createCommanderMigration({
    state: options.state,
    directories: options.directories,
    records: options.records,
    commanderPrompt: options.commanderPrompt,
    commanderPreset: options.commanderPreset,
    validateDirectory: dir => commanderDirectoryValidity(dir, options.directories, {
      exists: options.fs.existsSync,
      isDirectory: value => options.fs.statSync(value).isDirectory(),
      isHomeOrAbove: options.isHomeOrAbove,
      realPathOf: options.realPathOf,
    }),
    validateSession: session => ({
      valid: !!session.worktreePath && !!session.branch
        && options.fs.existsSync(session.worktreePath) && !options.invalidSessions.has(session.id),
      code: 'commander_session_invalid',
    }),
    selectRuntime: (dir, preset) => chooseCommanderRuntime({
      directory: dir, records: options.records, preset,
      supportedClis: options.supportedClis,
      availability: availability(),
      providerDefaults: options.providerDefaults,
      listProviders,
    }),
    refreshSession: (sessionId, directoryId, rolePrompt) => mutateSessions(
      'startup.commander-router-role-refresh', records => {
        const record = records.get(sessionId);
        if (!record || record.type !== 'commander' || record.dirId !== directoryId) {
          const error = new Error('typed commander evidence changed');
          error.code = 'commander_refresh_invalid';
          throw error;
        }
        record.rolePrompt = rolePrompt;
        return record;
      }),
    createSession,
    logger: options.logger,
  });
}

module.exports = { createCommanderMigrationHost, createCommanderRoutingHost };
