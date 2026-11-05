'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const windowsEnv = require('../windows-env');
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

// Availability must use the same Windows extension rules as command resolution:
// an already resolved codex.exe must never be probed as codex.exe.EXE.
function isCommandAvailable(command, options = {}) {
  const candidate = String(command || '').trim();
  if (!candidate) return false;
  const { isWindows, env, fsImpl } = createContext(options);
  const pathApi = isWindows ? path.win32 : path;
  const explicitPath = pathApi.isAbsolute(candidate) || candidate.includes('/')
    || (isWindows && candidate.includes('\\'));
  if (explicitPath) {
    return executableNames(candidate, { isWindows, env })
      .some(file => isRunnableFile(file, { isWindows, fsImpl }));
  }
  if (findExecutableOnPath(candidate, { isWindows, env, fsImpl })) return true;
  // A boot-time fallback names the extension that was expected then
  // (`claude.exe`), while the npm installer writes the PATHEXT variant
  // (`claude.cmd`). The stem goes back through PATHEXT instead of pinning the
  // extension — this is what lets a CLI installed after startup be detected.
  if (!isWindows) return false;
  const stem = candidate.replace(/\.[^.\\/]+$/, '');
  return stem !== candidate && !!findExecutableOnPath(stem, { isWindows, env, fsImpl });
}

function createContext(options) {
  const isWindows = options.isWindows ?? process.platform === 'win32';
  // The real process env is the one Windows froze at startup: widen it with the
  // install directories an installer may have created since. An injected env is
  // left exactly as given, so tests and callers control PATH themselves.
  if (isWindows && !options.env) windowsEnv.augmentPath(process.env);
  return {
    isWindows,
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
  const { isWindows, env, fsImpl, homeDir, logger } = context;
  // 绝对路径的 CODEX_CMD 指向不存在/不可执行的文件时不要静默返回坏路径, 回退到自动探测;
  // 裸命令名(无路径分隔符)交给 PATH, 照旧原样返回。
  if (env.CODEX_CMD) {
    const pinned = env.CODEX_CMD;
    if (!path.isAbsolute(pinned) || isRunnableFile(pinned, { isWindows, fsImpl })) return pinned;
    logger.warn(`[multicc] WARNING: CODEX_CMD=${pinned} is not runnable, falling back to auto-detection`);
  }
  const discovered = isWindows && windowsEnv.command('codex', env);
  if (discovered && isRunnableFile(discovered, context)) return discovered;
  // 顺序即策略, 不是随手排的: ~/.local/bin 必须在 homebrew 之前。
  // 官方 curl 安装脚本(BIN_DIR 默认 $HOME/.local/bin)和 standalone 包推荐的
  // `npm install -g --prefix "$HOME/.local"` 都落在这里, 而安装脚本自己也是把
  // ~/.local/bin prepend 进用户 PATH —— 两边顺序一致, 才不会出现「multicc 跑新的、
  // 用户敲 codex 是旧的」。反过来, 若让 /opt/homebrew/bin 优先, 新装的 codex 会被
  // npm 旧副本永久遮蔽, 升级"成功"却不生效。
  // 只装了 homebrew 那份的机器完全无感: 前两个候选不存在, 照样命中第三条。
  const directHit = firstRunnable([
    path.join(homeDir, '.local', 'bin', 'codex'),
    path.join(homeDir, '.cargo', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
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

function resolveKimi(context) {
  const { isWindows, env, homeDir } = context;
  if (env.KIMI_CMD) return env.KIMI_CMD;
  const directHit = firstRunnable([
    '/opt/homebrew/bin/kimi',
    '/usr/local/bin/kimi',
    path.join(homeDir, '.local', 'bin', 'kimi'),
    path.join(homeDir, '.npm-global', 'bin', 'kimi'),
    path.join(homeDir, '.kimi-code', 'bin', 'kimi'),
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath('kimi', context) || (isWindows ? 'kimi.exe' : 'kimi');
}

// Qoder can be installed by several independent products: the official
// installer, the CN desktop app's companion service, and npm-style prefixes.
// No single location is the "real" one, so unlike codex we do not pin path
// order when more than one is runnable: we probe `--version` and take the
// newest. Explicit QODER_CMD/QODERCN_CMD overrides still win verbatim and are
// never version-compared — pinning an older CLI is a user decision.
//
// The probe must be synchronous because resolveCliCommands() is synchronous.
// Worst case is candidate count (at most 7: six install locations plus the
// PATH hit) x the 2s timeout, serially ~14s — but only on the first resolution
// in a process. The memo below (keyed by the runnable candidate list) makes
// every later call O(1); createCommandResolver()'s own freeze window is
// untouched, and a changed candidate set naturally gets a fresh probe.
//
// Backend-language exception (AGENTS.md): this is CLI discovery inside the
// Node adapter layer that resolveCliCommands() already owns and every lane
// calls synchronously at startup. Moving only qoder's probe to Rust would
// split the resolver for no behavior gain; the exception is limited to this
// startup-only probe.
const QODER_VERSION_PROBE_TIMEOUT_MS = 2000;
const qoderVersionMemo = new Map();

function parseQoderVersion(output) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(output || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareQoderVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// Candidates are the runnable files already filtered in path order. The first
// one is the fallback when every probe fails to report a parsable version
// (timeout, crash, non-semver output), preserving the old first-hit behavior.
function selectNewestQoder(candidates) {
  const memoKey = candidates.join('\n');
  if (qoderVersionMemo.has(memoKey)) return qoderVersionMemo.get(memoKey);
  let selected = candidates[0] || null;
  let selectedVersion = null;
  for (const candidate of candidates) {
    let output;
    try {
      output = execFileSync(candidate, ['--version'], {
        timeout: QODER_VERSION_PROBE_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (_) {
      continue;
    }
    const version = parseQoderVersion(output);
    if (!version) continue;
    // Strictly newer only: equal versions keep the earlier path.
    if (!selectedVersion || compareQoderVersions(version, selectedVersion) > 0) {
      selected = candidate;
      selectedVersion = version;
    }
  }
  qoderVersionMemo.set(memoKey, selected);
  return selected;
}

function resolveQoder(context) {
  const { isWindows, env, homeDir } = context;
  if (env.QODER_CMD) return env.QODER_CMD;
  if (env.QODERCN_CMD) return env.QODERCN_CMD;
  const candidates = [
    '/opt/homebrew/bin/qoderclicn',
    '/usr/local/bin/qoderclicn',
    path.join(homeDir, '.local', 'bin', 'qoderclicn'),
    path.join(homeDir, '.qoder', 'bin', 'qoderclicn'),
    // On machines that only use the desktop app this is typically an empty
    // directory, not a file: isRunnableFile() rejects directories, so it is
    // skipped without breaking resolution.
    path.join(homeDir, '.qoder-cn', 'bin', 'qoderclicn'),
    // Qoder CN desktop app companion service install location (macOS/Linux).
    // The Windows equivalent is unconfirmed, so no Windows-only path is added;
    // a normal Windows install is still found through PATH.
    path.join(homeDir, '.qodersec', 'bin', 'qoderclicn'),
  ];
  const pathHit = findExecutableOnPath('qoderclicn', context);
  if (pathHit && !candidates.includes(pathHit)) candidates.push(pathHit);
  const runnable = candidates.filter(candidate => isRunnableFile(candidate, context));
  if (!runnable.length) return isWindows ? 'qoderclicn.exe' : 'qoderclicn';
  return selectNewestQoder(runnable);
}

// WorkBuddy / CodeBuddy CLI (Tencent): binary `codebuddy`, alias `cbc`.
function resolveCodebuddy(context) {
  const { isWindows, env, homeDir } = context;
  if (env.CODEBUDDY_CMD) return env.CODEBUDDY_CMD;
  if (env.WORKBUDDY_CMD) return env.WORKBUDDY_CMD;
  const directHit = firstRunnable([
    '/opt/homebrew/bin/codebuddy',
    '/usr/local/bin/codebuddy',
    path.join(homeDir, '.local', 'bin', 'codebuddy'),
    path.join(homeDir, '.codebuddy', 'bin', 'codebuddy'),
    // macOS desktop app embeds the CLI instead of installing it onto PATH.
    '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath('codebuddy', context)
    || findExecutableOnPath('cbc', context)
    || (isWindows ? 'codebuddy.exe' : 'codebuddy');
}

// DeepSeek Harness: binary `dsh` (@deepseek-ai/dsh).
function resolveDsh(context) {
  const { isWindows, env, homeDir } = context;
  if (env.DSH_CMD) return env.DSH_CMD;
  const directHit = firstRunnable([
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
    path.join(homeDir, '.local', 'bin', 'dsh'),
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath('dsh', context) || (isWindows ? 'dsh.exe' : 'dsh');
}

// Gemini CLI (@google/gemini-cli) and Grok Build (@xai-official/grok): both
// are npm globals driven over ACP through acp-bridge.cjs.
function resolveNpmGlobal(context, binary, envName) {
  const { isWindows, env, homeDir } = context;
  if (env[envName]) return env[envName];
  const directHit = firstRunnable([
    `/opt/homebrew/bin/${binary}`,
    `/usr/local/bin/${binary}`,
    path.join(homeDir, '.local', 'bin', binary),
    path.join(homeDir, '.npm-global', 'bin', binary),
  ], context);
  if (directHit) return directHit;
  return findExecutableOnPath(binary, context) || (isWindows ? `${binary}.cmd` : binary);
}

function resolveCliCommands(options = {}) {
  const context = createContext(options);
  return {
    claude: resolveClaude(context),
    'claude-exp': process.execPath,
    codex: resolveCodex(context),
    'codex-exp': resolveCodex(context),
    opencode: resolveOpencode(context),
    zcode: resolveZcode(context),
    qoder: resolveQoder(context),
    kimi: resolveKimi(context),
    codebuddy: resolveCodebuddy(context),
    dsh: resolveDsh(context),
    gemini: resolveNpmGlobal(context, 'gemini', 'GEMINI_CMD'),
    commandcode: resolveNpmGlobal(context, 'command-code', 'COMMAND_CODE_CMD'),
    grok: resolveNpmGlobal(context, 'grok', 'GROK_CMD'),
    pi: resolveNpmGlobal(context, 'pi', 'PI_CMD'),
  };
}

const SILENT_LOGGER = { log() {}, warn() {} };

// Availability is recomputed when the environment moves instead of staying
// frozen at boot: a Windows process started before a CLI was installed must
// still detect it. The seed keeps the boot-time map until the first change.
function createCommandResolver({ isWindows = process.platform === 'win32', seed = {}, logger = SILENT_LOGGER,
  environment = windowsEnv, resolve = resolveCliCommands } = {}) {
  let revision = environment.version();
  return function commandsNow() {
    if (isWindows) {
      environment.augmentPath();
      environment.scheduleRefresh();
    }
    const latest = environment.version();
    if (revision === latest) return seed;
    try {
      Object.assign(seed, resolve({ isWindows, logger }));
      revision = latest;
    } catch (_) { /* retry on the next call, keeping the last usable map */ }
    return seed;
  };
}

module.exports = { createCommandResolver, findExecutableOnPath, isCommandAvailable, resolveCliCommands };
