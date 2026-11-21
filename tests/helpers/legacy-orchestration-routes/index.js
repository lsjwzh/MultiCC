'use strict';

// Frozen copies (`git show HEAD:<file>`, byte for byte) of the four modules whose
// public routes were retired into the Rust front door
// (native/gateway/src/app/orchestration_routes.rs):
//
//   aux-goal.js           <- src/routes/aux-goal.js
//   aux-runs.js           <- src/routes/aux-runs.js
//   orchestration.js      <- src/routes/orchestration.js   (all 16 routes, as
//                            they were mounted together before the split)
//   unattended-routes.js  <- src/unattended/routes.js
//
// The differential mounts these, not the live files: a later edit to the host
// port must not move the oracle it is measured against. Each copy is loaded
// through a tiny rewriter: the only change is that its relative requires are
// pointed at the directory the original lived in, so the oracle still uses the
// real helpers (public-safety, provider-limit-cache, the unattended kernel,
// the aux run log).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FROZEN = __dirname;
const SRC = path.join(__dirname, '..', '..', '..', 'src');
const ORIGINAL_DIR = {
  'aux-goal': path.join(SRC, 'routes'),
  'aux-runs': path.join(SRC, 'routes'),
  orchestration: path.join(SRC, 'routes'),
  'unattended-routes': path.join(SRC, 'unattended'),
};

const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(FROZEN, `${name}.js`);
  const base = ORIGINAL_DIR[name];
  const source = fs.readFileSync(file, 'utf8');
  const rewritten = source.replace(
    /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_, __, rel) => {
      const target = path.resolve(base, rel);
      const dependency = target === path.join(SRC, 'quota', 'provider-limit-cache')
        ? path.join(FROZEN, '..', 'legacy-provider-limit-cache-entry') : target;
      return `require(${JSON.stringify(dependency)})`;
    },
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-orchestration-'));
  const out = path.join(dir, path.basename(file));
  fs.writeFileSync(out, rewritten);
  const module = require(out);
  cache.set(name, module);
  return module;
}

module.exports = {
  __load: load,
  auxGoal: () => load('aux-goal'),
  auxRuns: () => load('aux-runs'),
  orchestration: () => load('orchestration'),
  unattended: () => load('unattended-routes'),
};
