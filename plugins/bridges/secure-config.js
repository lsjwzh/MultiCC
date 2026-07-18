'use strict';

const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../../src/paths');
const { atomicWriteJson, atomicWriteText, ensurePrivateDir, secureFile } = require('../../src/runtime-security');

const CONFIG_DIR = path.join(resolveDataDir(process.env.MULTICC_DATA_DIR), 'bridges');

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

module.exports = { bridgeConfigFile, saveBridgeConfig, CONFIG_DIR };
