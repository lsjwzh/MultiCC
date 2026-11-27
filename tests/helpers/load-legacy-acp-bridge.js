'use strict';

// Load the unchanged frozen source at its former path so its relative imports
// resolve exactly as they did in production.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const virtualPath = path.resolve(__dirname, '../../src/cli-adapters/acp-bridge.cjs');
const legacy = new Module(virtualPath, module);
legacy.filename = virtualPath;
legacy.paths = Module._nodeModulePaths(path.dirname(virtualPath));
const load = legacy.require.bind(legacy);
legacy.require = id => id === '../provider-error' ? require('../../src/native/binding').providerError : load(id);
legacy._compile(fs.readFileSync(path.join(__dirname, 'legacy-acp-bridge.cjs'), 'utf8'), virtualPath);
module.exports = legacy.exports;
