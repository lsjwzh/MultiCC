'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function firstExisting(paths) {
  return paths.find(p => p && fs.existsSync(p)) || null;
}

function whichFromLoginShell(name, isWindows) {
  if (isWindows) return null;
  for (const sh of ['/bin/zsh', '/bin/bash']) {
    if (!fs.existsSync(sh)) continue;
    try {
      const found = execSync(`${sh} -l -c 'which ${name} 2>/dev/null'`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim().split(/\r?\n/)[0].trim();
      if (found && fs.existsSync(found)) return found;
    } catch (_) {}
  }
  return null;
}

function whichFromPath(name, isWindows, env = process.env) {
  try {
    const found = execSync(isWindows ? `where ${name}` : `which ${name}`, {
      encoding: 'utf8',
      env,
      timeout: 5000,
    }).trim().split(/\r?\n/)[0].trim();
    return found || null;
  } catch (_) {
    return null;
  }
}

function resolveClaude(isWindows) {
  if (process.env.CLAUDE_CMD) {
    console.log(`[multicc] CLAUDE_CMD override: ${process.env.CLAUDE_CMD}`);
    return process.env.CLAUDE_CMD;
  }

  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.local', 'share', 'claude', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.npm', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ];
  const sep = isWindows ? ';' : ':';
  const augmentedPath = [...new Set([...extraPaths, ...(process.env.PATH || '').split(sep)])].join(sep);
  process.env.PATH = augmentedPath;

  const shellHit = whichFromLoginShell('claude', isWindows);
  if (shellHit) {
    console.log(`[multicc] Found claude via login shell: ${shellHit}`);
    return shellHit;
  }

  const pathHit = whichFromPath('claude', isWindows, { ...process.env, PATH: augmentedPath });
  if (pathHit) {
    console.log(`[multicc] Found claude via PATH: ${pathHit}`);
    return pathHit;
  }

  const directHit = firstExisting(extraPaths.map(dir => path.join(dir, isWindows ? 'claude.exe' : 'claude')));
  if (directHit) {
    console.log(`[multicc] Found claude via direct check: ${directHit}`);
    return directHit;
  }

  console.warn('[multicc] WARNING: Could not locate claude binary, falling back to "claude"');
  return isWindows ? 'claude.exe' : 'claude';
}

function resolveCodex(isWindows) {
  if (process.env.CODEX_CMD) return process.env.CODEX_CMD;
  if (isWindows && process.env.LOCALAPPDATA) {
    const local = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const localCandidates = fs.readdirSync(local, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const exe = path.join(local, d.name, 'codex.exe');
          try { return fs.existsSync(exe) ? { exe, mtimeMs: fs.statSync(exe).mtimeMs } : null; }
          catch (_) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (localCandidates.length) return localCandidates[0].exe;
    } catch (_) {}
  }
  const directHit = firstExisting([
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    path.join(os.homedir(), '.cargo', 'bin', 'codex'),
  ]);
  if (directHit) return directHit;
  return whichFromLoginShell('codex', isWindows) ||
    whichFromPath('codex', isWindows) ||
    (isWindows ? 'codex.exe' : 'codex');
}

function resolveOpencode(isWindows) {
  if (process.env.OPENCODE_CMD) return process.env.OPENCODE_CMD;
  const directHit = firstExisting([
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
  ]);
  if (directHit) return directHit;
  return whichFromLoginShell('opencode', isWindows) ||
    whichFromPath('opencode', isWindows) ||
    (isWindows ? 'opencode.exe' : 'opencode');
}

function resolveZcode(isWindows) {
  if (process.env.ZCODE_CMD) return process.env.ZCODE_CMD;
  const directHit = firstExisting([
    '/opt/homebrew/bin/zcode',
    '/usr/local/bin/zcode',
    path.join(os.homedir(), '.local', 'bin', 'zcode'),
    path.join(os.homedir(), '.zcode', 'bin', 'zcode'),
  ]);
  if (directHit) return directHit;
  return whichFromLoginShell('zcode', isWindows) ||
    whichFromPath('zcode', isWindows) ||
    (isWindows ? 'zcode.exe' : 'zcode');
}

function resolveCliCommands({ isWindows = process.platform === 'win32' } = {}) {
  return {
    claude: resolveClaude(isWindows),
    codex: resolveCodex(isWindows),
    opencode: resolveOpencode(isWindows),
    zcode: resolveZcode(isWindows),
  };
}

module.exports = { resolveCliCommands };
