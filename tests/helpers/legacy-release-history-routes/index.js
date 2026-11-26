'use strict';

// FROZEN ORACLE — do not edit to match new behaviour.
//
// Frozen copies (`git show HEAD:<file>`, byte for byte) of the four modules whose
// public routes were retired into the Rust front door
// (native/gateway/src/app/release_history_routes.rs):
//
//   system.js         <- src/routes/system.js        (all four, as they were
//                        mounted together before /multicc.apk was split out)
//   ios-udid.js       <- src/ios-udid.js             (with its own express.raw)
//   chat-history.js   <- src/routes/chat-history.js  (the three public routes)
//   static-assets.js  <- src/routes/static-assets.js (with its `GET /` redirect)
//
// The differential mounts these, not the live files: a later edit to the host
// port must not move the oracle it is measured against. Each copy is loaded
// through a tiny rewriter: the only change is that its relative requires are
// pointed at the directory the original lived in, so the oracle still uses the
// real helpers (ios-ota, the chat-history store, the native history runtime).
//
// One exception to that rewrite: the frozen `system.js` mounts the UDID routes
// via `require('../ios-udid')`. That is redirected to the frozen copy in this
// directory, not to `src/ios-udid.js` — the live module has since grown a
// `mountHostRoutes` sibling, and an oracle that loaded it would measure the new
// code against itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FROZEN = __dirname;
const REPO = path.join(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'src');
const ORIGINAL_DIR = {
  system: path.join(SRC, 'routes'),
  'ios-udid': SRC,
  'chat-history': path.join(SRC, 'routes'),
  'static-assets': path.join(SRC, 'routes'),
};

const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(FROZEN, `${name}.js`);
  const base = ORIGINAL_DIR[name];
  const source = fs.readFileSync(file, 'utf8');
  const rewritten = source
    .replace(
      /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
      (_, __, rel) => {
        // Keep the oracle self-contained: the retired system.js reached for
        // ios-udid, and the frozen copy must reach for the frozen ios-udid.
        if (path.basename(rel) === 'ios-udid') {
          return `require(${JSON.stringify(path.join(FROZEN, 'ios-udid.js'))})`;
        }
        if (rel === '../frozen-file-batch8/transcript-prune') {
          return `require(${JSON.stringify(require.resolve('../frozen-file-batch8/transcript-prune'))})`;
        }
        return `require(${JSON.stringify(path.resolve(base, rel))})`;
      },
    )
    // The copies run from a temp directory, so a bare dependency (`express`)
    // would not resolve through it. Point those at the checkout's own
    // node_modules instead of relying on the caller's NODE_PATH.
    .replace(
      /require\((['"])([a-z@][^'".][^'"]*)\1\)/g,
      (whole, _quote, name) => {
        if (name.startsWith('node:')) return whole;
        try {
          return `require(${JSON.stringify(require.resolve(name, { paths: [REPO] }))})`;
        } catch (_error) {
          return whole;
        }
      },
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-release-history-'));
  const out = path.join(dir, path.basename(file));
  fs.writeFileSync(out, rewritten);
  const module = require(out);
  cache.set(name, module);
  return module;
}

module.exports = {
  __load: load,
  system: () => load('system'),
  iosUdid: () => load('ios-udid'),
  chatHistory: () => load('chat-history'),
  staticAssets: () => load('static-assets'),
};
