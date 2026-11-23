'use strict';

// Load the byte-for-byte snapshot with its original filename so its relative
// imports resolve to the same host dependencies as the production module.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const original = path.resolve(__dirname, '../../src/routes/task-board.js');
const snapshot = path.join(__dirname, 'legacy-task-board-runtime.js');
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(fs.readFileSync(snapshot, 'utf8'), original);
module.exports = loaded.exports;
