'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { zcodeEngineCandidates } = require('./zcode-engine');

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function envValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function normalizePathEntry(entry) {
  const value = String(entry || '').trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function isRunnableFile(file, { isWindows, fsImpl = fs }) {
  if (!file) return false;
  try {
    const stat = fsImpl.statSync(file);
    if (!stat.isFile()) return false;
    fsImpl.accessSync(file, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function executableNames(name, { isWindows, env }) {
  if (!isWindows) return [name];
  const extensions = String(envValue(env, 'PATHEXT') || WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`);
  const lowerName = name.toLowerCase();
  if (extensions.some(extension => lowerName.endsWith(extension.toLowerCase()))) return [name];
  return [...new Set(extensions.map(extension => `${name}${extension}`))];
}

/**
 * Resolve an executable without invoking a shell. On Windows, PATHEXT order is
 * respected; on POSIX, candidates must have the executable bit set.
 */
function findExecutableOnPath(name, {
  isWindows = process.platform === 'win32',
  env = process.env,
  fsImpl = fs,
} = {}) {
  if (!name) return null;
  const separator = isWindows ? ';' : ':';
  const searchPath = String(envValue(env, 'PATH') || '');
  const directories = searchPath.split(separator).map(normalizePathEntry).filter(Boolean);
  const names = executableNames(name, { isWindows, env });

  for (const directory of directories) {
    for (const candidateName of names) {
      const candidate = path.join(directory, candidateName);
      if (isRunnableFile(candidate, { isWindows, fsImpl })) return candidate;
    }
  }
  return null;
}

function firstRunnable(paths, context) {
  return paths.find(candidate => isRunnableFile(candidate, context)) || null;
}

function createContext(options) {
  return {
    isWindows: options.isWindows ?? process.platform === 'win32',
    env: options.env || process.env,
    fsImpl: options.fsImpl || fs,
    homeDir: options.homeDir || os.homedir(),
    logger: options.logger || console,
  };
}

function resolveClaude(context) {
  const { isWindows, env, fsImpl, homeDir, logger } = context;
  if (env.CLAUDE_CMD) {
    logger.log(`[multicc] CLAUDE_CMD override: ${env.CLAUDE_CMD}`);
    return env.CLAUDE_CMD;
  }

  const extraPaths = [
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.local', 'share', 'claude', 'bin'),
    path.join(homeDir, '.npm-global', 'bin'),
    path.join(homeDir, '.npm', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ];
  const separator = isWindows ? ';' : ':';
  const currentPath = String(envValue(env, 'PATH') || '').split(separator).filter(Boolean);
  const augmentedPath = [...new Set([...extraPaths, ...currentPath])].join(separator);
  env.PATH = augmentedPath;

  const pathHit = findExecutableOnPath('claude', {
    isWindows,
    env: { ...env, PATH: augmentedPath },
    fsImpl,
  });
  if (pathHit) {
    logger.log(`[multicc] Found claude via PATH: ${pathHit}`);
    return pathHit;
  }

  logger.warn('[multicc] WARNING: Could not locate claude binary, falling back to "claude"');
  return isWindows ? 'claude.exe' : 'claude';
}

function resolveCodex(context) {
  const { isWindows, env, fsImpl, homeDir } = context;
  if (env.CODEX_CMD) return env.CODEX_CMD;
  if (isWindows && env.LOCALAPPDATA) {
    const local = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const localCandidates = fsImpl.readdirSync(local, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const exe = path.join(local, entry.name, 'codex.exe');
          try {
            if (!isRunnableFile(exe, { isWindows, fsImpl })) return null;
            return { exe, mtimeMs: fsImpl.statSync(exe).mtimeMs };
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (localCandidates.length) return localCandidates[0].exe;
    } catch (_) {}
  }
  const directHit = firstRunnable([
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(homeDir, '.local', 'bin', 'codex'),
    path.join(homeDir, '.cargo', 'bin', 'codex'),
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath('codex', context) || (isWindows ? 'codex.exe' : 'codex');
}

function resolveOpencode(context) {
  const { isWindows, env, homeDir } = context;
  if (env.OPENCODE_CMD) return env.OPENCODE_CMD;
  const directHit = firstRunnable([
    path.join(homeDir, '.opencode', 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    path.join(homeDir, '.local', 'bin', 'opencode'),
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath('opencode', context) || (isWindows ? 'opencode.exe' : 'opencode');
}

function resolveZcode(context) {
  const { isWindows, env, homeDir } = context;
  if (env.ZCODE_ENGINE) return env.ZCODE_ENGINE;
  if (env.ZCODE_CMD) return env.ZCODE_CMD;
  const directHit = firstRunnable([
    ...zcodeEngineCandidates({ isWindows, homeDir }),
    '/opt/homebrew/bin/zcode',
    '/usr/local/bin/zcode',
    path.join(homeDir, '.local', 'bin', 'zcode'),
    path.join(homeDir, '.zcode', 'bin', 'zcode'),
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath('zcode', context) || (isWindows ? 'zcode.exe' : 'zcode');
}

function resolveQoder(context) {
  const { isWindows, env, homeDir } = context;
  if (env.QODER_CMD) return env.QODER_CMD;
  if (env.QODERCN_CMD) return env.QODERCN_CMD;
  const directHit = firstRunnable([
    '/opt/homebrew/bin/qoderclicn',
    '/usr/local/bin/qoderclicn',
    path.join(homeDir, '.local', 'bin', 'qoderclicn'),
    path.join(homeDir, '.qoder', 'bin', 'qoderclicn'),
    path.join(homeDir, '.qoder-cn', 'bin', 'qoderclicn'),
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath('qoderclicn', context) || (isWindows ? 'qoderclicn.exe' : 'qoderclicn');
}

function resolveCliCommands(options = {}) {
  const context = createContext(options);
  return {
    claude: resolveClaude(context),
    codex: resolveCodex(context),
    opencode: resolveOpencode(context),
    zcode: resolveZcode(context),
    qoder: resolveQoder(context),
  };
}

module.exports = { findExecutableOnPath, resolveCliCommands };
