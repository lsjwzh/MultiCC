'use strict';

const { createMemoController, MEMO_FILENAME, MEMO_MAX_BYTES } = require('./controller');
const { createMemoFilePort } = require('./file-port');
const { createMemoRouter } = require('./router');

function createMemoModule({ directories, sessions, runtime, files, pathPort } = {}) {
  const controller = createMemoController({
    directories,
    sessions,
    runtime,
    files: files || createMemoFilePort(),
    pathPort,
  });
  return Object.freeze({ controller, router: createMemoRouter(controller) });
}

module.exports = {
  MEMO_FILENAME,
  MEMO_MAX_BYTES,
  createMemoController,
  createMemoFilePort,
  createMemoModule,
  createMemoRouter,
};
