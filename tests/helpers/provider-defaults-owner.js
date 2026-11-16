'use strict';

// Adapter for legacy injected-filesystem fixtures. State still lives in the
// real native owner; the fixture writer only records or rejects disk effects.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-defaults-fixture-'));
process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
let next = 0;

function fixtureDefaultsOwner(deps) {
  const file = path.join(root, `${next++}.json`);
  try { fs.writeFileSync(file, deps.fs.readFileSync(deps.providerDefaultsFile, 'utf8')); } catch (_) { /* missing */ }
  const native = require('../../src/native/runtime').getNative();
  const owner = new native.RustProviderDefaultsStore(file);
  return {
    snapshot: () => owner.snapshot(),
    get: key => owner.get(key),
    set: (key, value) => owner.set(key, value),
    delete: key => owner.delete(key),
    patch: value => owner.patch(value),
    persist: () => deps.atomicWriteJson(deps.providerDefaultsFile, owner.snapshot()),
    commit(value) {
      deps.atomicWriteJson(deps.providerDefaultsFile, value);
      owner.replace(value);
    },
  };
}

module.exports = { fixtureDefaultsOwner };
