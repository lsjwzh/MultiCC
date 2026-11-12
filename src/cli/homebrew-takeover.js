'use strict';

// Rust owns ownership safety and takeover policy. The host retains platform
// path resolution and the injectable realpath port used by install callers.
const fs = require('node:fs');
const path = require('node:path');
const { getNative } = require('../native/runtime');
const request = (op, input) => getNative().homebrewTakeoverRequest(op, input);

function resolveOnPath(cmd, envPath) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return cmd;
  if (cmd.includes('/')) return null;
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// 派生二进制是否归 Homebrew 管。按真实路径判断: Cellar/<formula>/ 或 Caskroom/<cask>/。
// 读不到(不存在、断链、权限)一律 null —— 宁可照旧跑 npm, 不可误卸载。
function homebrewOwnerOf(cmd, { envPath = process.env.PATH, realpath = fs.realpathSync } = {}) {
  const resolved = resolveOnPath(cmd, envPath);
  if (!resolved) return null;
  let real;
  try { real = realpath(resolved); } catch (_) { return null; }
  return request('owner', { real: String(real), resolved, basename: path.basename(resolved) });
}

function isNpmGlobalInstall(command) {
  return request('npmGlobal', { command: String(command || '') });
}

function takeoverCommand(owner, command) {
  if (!owner || !isNpmGlobalInstall(command)) return command;
  const result = request('takeover', { owner: { kind: owner.kind, name: owner.name }, command: String(command) });
  return result === null ? command : result;
}

module.exports = { homebrewOwnerOf, takeoverCommand, isNpmGlobalInstall };
