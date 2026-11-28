'use strict';
// Test-only oracle. Read exact baseline bytes and resolve the retired peer from
// the same snapshot; production binding never imports this module.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const frozen = path.join(__dirname, 'frozen-cron-git-4dd9f2c7');
const manifest = require('./frozen-cron-git-4dd9f2c7/manifest.json');
function loadFrozen(name, options = {}) {
  const loaded = new Map();
  function load(name) {
    if (loaded.has(name)) return loaded.get(name).exports;
    const relative = name === 'git-push' ? 'plugins/utils/git-push.js' : `plugins/cron/${name}.js`;
    const record = manifest[relative];
    assert.ok(record, `missing frozen source: ${relative}`);
    const source = fs.readFileSync(path.join(frozen, record.file), 'utf8');
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), record.sha256);
    const filename = path.join(options.packageRoot || root, relative);
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const nativeRequire = Module.createRequire(filename);
    mod.require = id => {
      if (Object.hasOwn(options.modules || {}, id)) return options.modules[id];
      if (id.endsWith('/native/binding')) return options.binding || require('../../src/native/binding');
      if (id === './fanout-migration') return load('fanout-migration');
      return nativeRequire(id);
    };
    loaded.set(name, mod);
    mod._compile(source, filename);
    return mod.exports;
  }
  return load(name);
}
module.exports = { loadFrozen };
