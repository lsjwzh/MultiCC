'use strict';

const fs = require('fs');
const path = require('path');
const stateStore = require('./state-store');

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function secureFile(file) {
  try { fs.chmodSync(file, 0o600); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function secureRuntimeData(paths) {
  const dirs = [paths.chatHistoryDir, paths.eventsDir, paths.journalDir].filter(Boolean);
  if (paths.root && paths.root !== paths.pkgRoot) dirs.unshift(paths.root);
  for (const dir of dirs) {
    ensurePrivateDir(dir);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) {}
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isFile()) secureFile(target);
      else if (entry.isDirectory() && dir !== paths.root) ensurePrivateDir(target);
    }
  }
  for (const [key, file] of Object.entries(paths)) {
    if (!/File$/.test(key)) continue;
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
    secureFile(file);
  }
}

function atomicWriteJson(file, value, options = {}) {
  stateStore.writeTextAtomic(file, JSON.stringify(value, null, 2), { mode: 0o600, dirMode: 0o700, ...options });
}

function atomicWriteText(file, value, options = {}) {
  stateStore.writeTextAtomic(file, String(value), { mode: 0o600, dirMode: 0o700, ...options });
}

module.exports = { ensurePrivateDir, secureFile, secureRuntimeData, atomicWriteJson, atomicWriteText };
