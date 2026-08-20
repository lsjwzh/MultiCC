'use strict';

const {
  chooseCommanderRuntime,
  commanderDirectoryValidity,
  createCommanderMigration,
} = require('./commander-migration');

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

module.exports = { createCommanderMigrationHost };
