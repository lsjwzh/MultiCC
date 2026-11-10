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
  const { stateStore, stateOwner, paths, chatHistoryRepository } = options;
  if (!stateStore || typeof stateStore.createStore !== 'function') {
    throw new TypeError('[state-bootstrap] stateStore.createStore is required');
  }
  if (!stateOwner
    || typeof stateOwner.replayJournals !== 'function'
    || typeof stateOwner.loadDirectories !== 'function'
    || typeof stateOwner.initDirectories !== 'function') {
    throw new TypeError('[state-bootstrap] stateOwner is required');
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

  const replay = stateOwner.replayJournals();
  for (const message of (replay && replay.messages) || []) logger.log(message);
  if (replay.replayed || replay.skipped) {
    logger.log(`[multicc] state-tx journal: ${replay.replayed} replayed, ${replay.skipped} skipped`);
  }

  let directoryResult;
  let sessionResult;
  try {
    sessionResult = sessionsStore.loadOrRecover();
  } catch (error) {
    logger.error(`[multicc] sessions.json unreadable and no backup usable: ${error.message}`);
    throw error;
  }
  try {
    directoryResult = stateOwner.loadDirectories();
  } catch (error) {
    logger.error(`[multicc] directories.json unreadable and no backup usable: ${error.message}`);
    throw error;
  }
  if (directoryResult.recovered) {
    logger.warn(`[multicc] directories.json recovered from backup ${directoryResult.recoveredFrom}`);
  }
  const rawSessions = sessionResult.present ? sessionResult.data : [];
  if (sessionResult.present && sessionResult.recovered) {
    logger.warn(`[multicc] sessions.json recovered from backup ${sessionResult.recoveredFrom}`);
  }

  let state;
  if (rawSessions.length > 0
    && !isNewSchema(rawSessions)
    && hasMigratableOldSessions(rawSessions)) {
    logger.log('[multicc] Migrating sessions.json to directory-based schema...');
    const migrated = migrateOldSchema(rawSessions, { randomUUID });
    for (const { from, to } of migrated.chatHistoryRenames) {
      // Startup-only, and strictly before `createChatHistoryRuntime` is called
      // (server.js composes state first). No history mutation can be queued or
      // in flight yet, so this rename cannot race a write; it stays synchronous
      // so a missing session record fails the migration visibly.
      try {
        chatHistoryRepository.renameSession(from, to);
      } catch (error) {
        logger.warn(`[multicc] chat_history rename failed ${from} → ${to}: ${error.message}`);
      }
    }
    try {
      fs.copyFileSync(paths.sessionsFile, `${paths.sessionsFile}.pre-directory.bak`);
    } catch (_) {}
    // The migration replaces the stale directory registry in the same native
    // table the repository and every legacy caller read.
    stateOwner.initDirectories(migrated.directories.entries());
    state = {
      persistedSessions: migrated.sessions,
      needsSave: true,
      needsDefaultDirectory: false,
    };
  } else {
    const persistedSessions = new Map(rawSessions.map(session => [session.id, session]));
    logger.log(`[multicc] Loaded ${directoryResult.size} directories, ${persistedSessions.size} session(s)`);
    // A missing directories.json means this installation has never completed
    // directory setup. An existing empty array means the user deliberately
    // removed the last directory, so it must stay empty across restarts.
    const hasOnlyAuxSessions = rawSessions.every(session =>
      session.id === '__aux__' || session.type === 'aux');
    state = {
      persistedSessions,
      needsSave: false,
      needsDefaultDirectory: !directoryResult.present && hasOnlyAuxSessions,
    };
  }

  return Object.freeze({ sessionsStore, state });
}

module.exports = {
  isNewSchema,
  hasMigratableOldSessions,
  migrateOldSchema,
  bootstrapState,
};
