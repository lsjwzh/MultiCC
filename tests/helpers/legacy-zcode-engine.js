'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ZCODE_ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

function zcodeEngineCandidates({ isWindows = process.platform === 'win32', homeDir } = {}) {
  if (isWindows) return [];
  return [
    DEFAULT_ZCODE_ENGINE,
    homeDir ? path.join(homeDir, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs') : null,
  ].filter(Boolean);
}

// Engine >=0.16.9 refuses prompt/tui/app-server/login unless it can find the
// bundled builtin provider config. Its own lookup only probes paths relative
// to the entrypoint (glm/provider/… and a dev-tree path); inside the desktop
// app the file lives at Resources/config/provider/zcode-builtin.json, which
// the Electron shell passes via env. Standalone spawns must do the same.
function zcodeBuiltinProviderConfig(engine) {
  if (!engine || !/\.c?js$/i.test(engine)) return null;
  const file = path.resolve(path.dirname(engine), '..', 'config', 'provider', 'zcode-builtin.json');
  try { return fs.statSync(file).isFile() ? file : null; } catch (_) { return null; }
}

function zcodeEngineEnv(engine, env = process.env) {
  if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) return env;
  const file = zcodeBuiltinProviderConfig(engine);
  return file ? { ...env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: file } : env;
}

module.exports = { DEFAULT_ZCODE_ENGINE, zcodeEngineCandidates, zcodeBuiltinProviderConfig, zcodeEngineEnv };
