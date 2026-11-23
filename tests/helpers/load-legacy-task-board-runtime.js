'use strict';

// Load the byte-for-byte snapshot with its original filename so its relative
// imports resolve to the same host dependencies as the production module.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

function snapshot(filename, source, dependencies = {}) {
  const original = path.resolve(__dirname, '../../src', filename);
  const loaded = new Module(original, module);
  loaded.filename = original;
  loaded.paths = Module._nodeModulePaths(path.dirname(original));
  loaded.require = id => Object.hasOwn(dependencies, id) ? dependencies[id] : Module.prototype.require.call(loaded, id);
  loaded._compile(fs.readFileSync(path.join(__dirname, source), 'utf8'), original);
  return loaded.exports;
}

const context = snapshot('task-board/turn-context.js', 'legacy-task-run-context.js');
const seed = require('./legacy-task-cold-start-seed');
const runtime = snapshot('routes/task-board.js', 'legacy-task-board-runtime.js', {
  '../task-board/turn-context': context, '../task-board/cold-start-seed': seed,
});
module.exports = { ...runtime, ...context, ...seed };
