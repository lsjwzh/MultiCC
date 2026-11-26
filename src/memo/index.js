'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getNative } = require('../native/binding');
const { DomainError, InfrastructureError } = require('../http-errors');
const { createGitTrackPort, migrateProjectMemos } = require('./migrate');
const { MEMO_FILENAME, LEGACY_PROJECT_MEMO_FILENAME, MEMO_MAX_BYTES } = getNative();

const temporaryCounter = { next: 0 };
function createMemoFilePort({ fsImpl = fs } = {}) {
  return getNative().memoFilePort(fsImpl, temporaryCounter, process.pid);
}

function createMemoController({ directories, sessions, runtime, files, memoRoot, pathPort = path } = {}) {
  const controller = getNative().memoController({
    directories, sessions, runtime, files, memoRoot, pathPort, DomainError, InfrastructureError,
  });
  return Object.freeze({
    read({ directoryId } = {}) { return controller.read(directoryId); },
    write({ directoryId, text } = {}) { return controller.write(directoryId, text); },
    async send({ directoryId, text: rawText, sessionId: rawSessionId } = {}) {
      const { sessionId, text } = controller.prepareSend(directoryId, rawText, rawSessionId);
      let started;
      try { started = await runtime.runTurn(sessionId, text, {}); }
      catch (cause) { return controller.finishSend(sessionId, false, cause); }
      return controller.finishSend(sessionId, started);
    },
  });
}

function createMemoModule({
  directories, sessions, runtime, files, memoRoot, pathPort, git, log,
} = {}) {
  const filePort = files || createMemoFilePort();
  const controller = createMemoController({
    directories,
    sessions,
    runtime,
    files: filePort,
    memoRoot,
    pathPort,
  });
  return Object.freeze({
    controller,
    // Idempotent: once a legacy file is gone the scan is a no-op, so calling
    // this on every boot costs one existsSync per registered directory.
    // Returns { report, done }: the copies are already applied when it returns,
    // `done` settles once the git-tracked checks and deletes finish.
    migrateLegacy: () => migrateProjectMemos({
      directories: directories && typeof directories.list === 'function' ? directories.list() : [],
      files: filePort,
      memoRoot,
      pathPort,
      git,
      log,
    }),
  });
}

module.exports = {
  MEMO_FILENAME,
  LEGACY_PROJECT_MEMO_FILENAME,
  MEMO_MAX_BYTES,
  createGitTrackPort,
  createMemoController,
  createMemoFilePort,
  createMemoModule,
  migrateProjectMemos,
};
