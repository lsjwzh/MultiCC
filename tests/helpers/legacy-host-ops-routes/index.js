'use strict';

// Frozen copies of the ten modules whose public routes were retired into the
// Rust front door (native/gateway/src/app/host_ops_routes.rs). The differential
// mounts these, not the live files: a later edit to the host port must not move
// the oracle it is measured against.
//
// Each copy is loaded through a tiny rewriter rather than required in place,
// because the originals live in src/routes and resolve their siblings and
// helpers relative to that directory. A relative require that names a sibling
// in this directory resolves to the frozen copy; every other relative require
// resolves to the file the original path would have named, so the oracle still
// uses the real helpers (update-runner, host-power-services, ...).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FROZEN = __dirname;
const ORIGINAL = path.join(__dirname, '..', '..', '..', 'src', 'routes');

const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(FROZEN, `${name}.js`);
  const source = fs.readFileSync(file, 'utf8');
  const rewritten = source.replace(
    /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_, __, rel) => {
      if (rel === '../macos-agent-provision') {
        return `require(${JSON.stringify(require.resolve('../frozen-1f3d27cc/macos-agent-provision'))})`;
      }
      if (rel === '../cli-adapters/commands' || rel === '../windows-env') {
        return `require(${JSON.stringify(require.resolve('../frozen-bc29761b/' + rel.slice(3)))})`;
      }
      if (rel.endsWith('/http/public-safety')) return `require(${JSON.stringify(require.resolve('../frozen-file-batch19/public-safety'))})`;
      if (rel === '../frozen-b10-network/outbound') return `require(${JSON.stringify(require.resolve('../frozen-b10-network/outbound'))})`;
      if (rel === '../host-power-services') return `require(${JSON.stringify(require.resolve('../frozen-file-batch18/host-power-services'))})`;
      if (rel === './system') return `require(${JSON.stringify(require.resolve('../frozen-file-batch17/system'))})`;
      if (rel === '../http/error-map') return `require(${JSON.stringify(require.resolve('../frozen-file-batch13/error-map'))})`;
      if (rel === '../notify-settings') return `require(${JSON.stringify(path.join(FROZEN, '../legacy-host-read-routes.js'))})`;
      const frozen = path.resolve(FROZEN, rel);
      if (fs.existsSync(`${frozen}.js`)) {
        // A retirered module may require a sibling that also has a frozen copy
        // (host-write -> host-power). Go through this loader so that copy is
        // itself rewritten, and both sides share one instance.
        return `require(${JSON.stringify(path.join(FROZEN, 'index.js'))}).__load(${JSON.stringify(path.basename(rel))})`;
      }
      return `require(${JSON.stringify(path.resolve(ORIGINAL, rel))})`;
    },
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-host-ops-'));
  const out = path.join(dir, path.basename(file));
  fs.writeFileSync(out, rewritten);
  const module = require(out);
  cache.set(name, module);
  return module;
}

module.exports = {
  __load: load,
  serverRestart: () => load('server-restart-route'),
  update: () => load('update-route'),
  developerTools: () => load('developer-tools'),
  macosPrivacy: () => load('macos-privacy'),
  opsTerminal: () => load('ops-terminal'),
  hostWrite: () => load('host-write'),
  hostPower: () => load('host-power'),
  skillSync: () => load('skill-sync'),
  doctor: () => load('doctor'),
  envDoctor: () => load('env-doctor'),
};
