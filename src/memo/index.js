'use strict';

const {
  createMemoController,
  MEMO_FILENAME,
  LEGACY_PROJECT_MEMO_FILENAME,
  MEMO_MAX_BYTES,
} = require('./controller');
const { createMemoFilePort } = require('./file-port');
const { createGitTrackPort, migrateProjectMemos } = require('./migrate');
const { createMemoRouter } = require('./router');

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
    router: createMemoRouter(controller),
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
  createMemoRouter,
  migrateProjectMemos,
};
