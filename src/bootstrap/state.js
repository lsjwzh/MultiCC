'use strict';

const crypto = require('node:crypto');
const defaultFs = require('node:fs');

function isNewSchema(records) {
  return records.some(record => record.dirId !== undefined || record.kind !== undefined);
}

function hasMigratableOldSessions(records) {
  return records.some(record =>
    !(record.id === '__aux__' || record.type === 'aux')
    && record.dirId === undefined
    && record.kind === undefined);
}

function migrateOldSchema(oldRecords, { randomUUID = crypto.randomUUID } = {}) {
  const directories = new Map();
  const sessions = new Map();
  const chatHistoryRenames = [];

  for (const record of oldRecords) {
    if (record.id === '__aux__' || record.type === 'aux') {
      sessions.set(record.id, record);
      continue;
    }
    const dirId = randomUUID();
    directories.set(dirId, {
      id: dirId,
      name: record.id,
      path: record.cwd,
      createdAt: record.createdAt,
    });
    sessions.set(record.id, {
      id: record.id,
      dirId,
      cli: 'claude',
      kind: 'terminal',
      cliSessionId: record.claudeSessionId || null,
      createdAt: record.createdAt,
    });
    if (record.chatClaudeSessionId) {
      const chatId = `${record.id}-chat`;
      sessions.set(chatId, {
        id: chatId,
        dirId,
        cli: 'claude',
        kind: 'chat',
        cliSessionId: record.chatClaudeSessionId,
        createdAt: record.createdAt,
      });
      chatHistoryRenames.push({ from: record.id, to: chatId });
    }
  }
  return { directories, sessions, chatHistoryRenames };
}

function bootstrapState(options) {
  if (!options || typeof options !== 'object') throw new TypeError('[state-bootstrap] options are required');
  const { stateStore, stateTx, paths, chatHistoryRepository } = options;
  if (!stateStore || typeof stateStore.createStore !== 'function') {
    throw new TypeError('[state-bootstrap] stateStore.createStore is required');
  }
  if (!stateTx || typeof stateTx.replayJournals !== 'function') {
    throw new TypeError('[state-bootstrap] stateTx.replayJournals is required');
  }
  if (!paths || !paths.sessionsFile || !paths.directoriesFile || !paths.journalDir) {
    throw new TypeError('[state-bootstrap] paths are required');
  }
  if (!chatHistoryRepository || typeof chatHistoryRepository.renameSession !== 'function') {
    throw new TypeError('[state-bootstrap] chatHistoryRepository.renameSession is required');
  }
  const fs = options.fs || defaultFs;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const logger = options.logger || console;
  const sessionsStore = stateStore.createStore({
    file: paths.sessionsFile, kind: 'sessions', schemaVersion: 1, legacyIsArray: true,
  });
  const directoriesStore = stateStore.createStore({
    file: paths.directoriesFile, kind: 'directories', schemaVersion: 1, legacyIsArray: true,
  });

  const { replayed, skipped } = stateTx.replayJournals(paths.journalDir, {
    log: message => logger.log(message),
  });
  if (replayed || skipped) {
    logger.log(`[multicc] state-tx journal: ${replayed} replayed, ${skipped} skipped`);
  }

  function loadDirectories() {
    let result;
    try {
      result = directoriesStore.loadOrRecover();
    } catch (error) {
      logger.error(`[multicc] directories.json unreadable and no backup usable: ${error.message}`);
      throw error;
    }
    if (!result.present) return new Map();
    if (result.recovered) {
      logger.warn(`[multicc] directories.json recovered from backup ${result.recoveredFrom}`);
    }
    return new Map(result.data.map(directory => [directory.id, directory]));
  }

  let sessionResult;
  try {
    sessionResult = sessionsStore.loadOrRecover();
  } catch (error) {
    logger.error(`[multicc] sessions.json unreadable and no backup usable: ${error.message}`);
    throw error;
  }
  const rawSessions = sessionResult.present ? sessionResult.data : [];
  if (sessionResult.present && sessionResult.recovered) {
    logger.warn(`[multicc] sessions.json recovered from backup ${sessionResult.recoveredFrom}`);
  }
  const directories = loadDirectories();

  let state;
  if (rawSessions.length > 0
    && !isNewSchema(rawSessions)
    && hasMigratableOldSessions(rawSessions)) {
    logger.log('[multicc] Migrating sessions.json to directory-based schema...');
    const migrated = migrateOldSchema(rawSessions, { randomUUID });
    for (const { from, to } of migrated.chatHistoryRenames) {
      try {
        chatHistoryRepository.renameSession(from, to);
      } catch (error) {
        logger.warn(`[multicc] chat_history rename failed ${from} → ${to}: ${error.message}`);
      }
    }
    try {
      fs.copyFileSync(paths.sessionsFile, `${paths.sessionsFile}.pre-directory.bak`);
    } catch (_) {}
    state = {
      directories: migrated.directories,
      persistedSessions: migrated.sessions,
      needsSave: true,
    };
  } else {
    const persistedSessions = new Map(rawSessions.map(session => [session.id, session]));
    logger.log(`[multicc] Loaded ${directories.size} directories, ${persistedSessions.size} session(s)`);
    state = { directories, persistedSessions, needsSave: false };
  }

  return Object.freeze({ sessionsStore, directoriesStore, state });
}

module.exports = {
  isNewSchema,
  hasMigratableOldSessions,
  migrateOldSchema,
  bootstrapState,
};
