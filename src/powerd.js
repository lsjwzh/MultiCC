'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getNative } = require('./native/binding');
const LABEL = 'com.multicc.powerd';
const DATA_DIR = '/Library/Application Support/multicc';
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;

function createPowerd({ platform = process.platform, dataDir = DATA_DIR, plistPath = PLIST_PATH, fsImpl } = {}) {
  const intentPath = path.join(dataDir, 'power-intent');
  const statusPath = path.join(dataDir, 'powerd-status.json');
  if (fsImpl === undefined && typeof plistPath === 'string') {
    return getNative().systemPowerDaemon(platform, fs, intentPath, statusPath, plistPath);
  }
  if (fsImpl === undefined) fsImpl = fs;
  return getNative().powerDaemon({
    platform, intentPath, statusPath,
    checkAccess() {
      fsImpl.accessSync(plistPath, fs.constants.R_OK);
      fsImpl.accessSync(intentPath, fs.constants.W_OK);
    },
    readWord: () => fsImpl.readFileSync(intentPath, 'utf8').trim(),
    readJson: () => JSON.parse(fsImpl.readFileSync(statusPath, 'utf8')),
    write: word => fsImpl.writeFileSync(intentPath, word),
  });
}
module.exports = { createPowerd, LABEL, DATA_DIR, PLIST_PATH };
