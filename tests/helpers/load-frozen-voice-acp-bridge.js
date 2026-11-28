'use strict';

// Freeze the original bridge bytes and dependency independently of production.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const virtualPath = path.resolve(__dirname, '../../src/voice/acp-bridge.js');
const frozen = new Module(virtualPath, module);
frozen.filename = virtualPath;
frozen.paths = Module._nodeModulePaths(path.dirname(virtualPath));
const originalRequire = frozen.require.bind(frozen);
frozen.require = id => id === '../native/binding'
  ? { voiceSpeech: require('./frozen-voice-speech') }
  : originalRequire(id);
frozen._compile(fs.readFileSync(path.join(__dirname, 'frozen-voice-acp-bridge.cjs'), 'utf8'), virtualPath);
module.exports = frozen.exports;
