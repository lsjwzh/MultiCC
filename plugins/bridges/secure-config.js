'use strict';

const fs = require('fs');
const path = require('path');
const { createPaths } = require('../../src/paths');
const { atomicWriteJson, atomicWriteText, ensurePrivateDir, secureFile } = require('../../src/runtime-security');

const RUNTIME_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const CONFIG_DIR = RUNTIME_PATHS.bridgesDir;

function bridgeConfigFile(name, legacyFile) {
  ensurePrivateDir(CONFIG_DIR);
  const file = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(file) && legacyFile && fs.existsSync(legacyFile)) {
    atomicWriteText(file, fs.readFileSync(legacyFile, 'utf8'));
    secureFile(legacyFile);
  }
  secureFile(file);
  return file;
}

function saveBridgeConfig(file, config) {
  atomicWriteJson(file, config);
}

function bridgeHistoryFile(sessionId) {
  const safeId = String(sessionId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safeId) throw new Error('bridge history requires a session id');
  ensurePrivateDir(RUNTIME_PATHS.chatHistoryDir);
  return path.join(RUNTIME_PATHS.chatHistoryDir, `${safeId}.json`);
}

module.exports = { bridgeConfigFile, bridgeHistoryFile, saveBridgeConfig, CONFIG_DIR };
