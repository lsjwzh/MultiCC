'use strict';
// Optimized Node comparison only: batch synchronous filesystem calls in a
// worker instead of bouncing each file operation through the libuv pool.
// The frozen oracle still owns every guard and hash rule.
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { parentPort } = require('node:worker_threads');
const file = require.resolve('./legacy-code-revision');
const localRequire = createRequire(file);
const promises = {};
for (const method of ['realpath', 'lstat', 'readlink', 'readdir']) {
  promises[method] = async (...args) => fs[method + 'Sync'](...args);
}
promises.open = async (...args) => {
  const fd = fs.openSync(...args);
  return { stat: async () => fs.fstatSync(fd), readFile: async () => fs.readFileSync(fd),
    close: async () => fs.closeSync(fd) };
};
const moduleObject = { exports: {} };
vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
  module: moduleObject, Buffer,
  require: name => name === 'node:fs/promises' ? promises : localRequire(name),
}, { filename: file });
parentPort.on('message', async cwd => {
  try { parentPort.postMessage({ result: await moduleObject.exports.captureCodeRevision(cwd) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
