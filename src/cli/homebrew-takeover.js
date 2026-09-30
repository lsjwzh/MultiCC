'use strict';

// ── Homebrew 装的 CLI 一律改走 npm ──
//
// 升级/安装统一走 `npm install -g <pkg>`。但如果 multicc 派生的那个二进制是
// Homebrew 装的(/opt/homebrew/bin/gemini -> ../Cellar/gemini-cli/0.29.5/bin/gemini),
// npm 要写的正是同一个 bin 路径, 发现不是自己的文件就报 EEXIST 退出 —— 用户看到的是
// 「有新版, 升级却永远失败」。Homebrew 的 gemini-cli 还已被官方弃用(最高 0.46.0,
// 2026-12-18 停用), 跟着 brew 走也追不上 npm 的最新版。
//
// 决定(2026-09-25): 不去兼容 Homebrew 渠道。发现派生二进制归 Homebrew 管, 就在同一条
// 安装命令里先 `brew uninstall`, 再 npm 安装; 之后 bin 路径归 npm, 以后的升级自然
// 全部走 npm。卸载失败(例如被别的 formula 依赖)时 `&&` 让整条命令停下, 不会装一半。

const fs = require('node:fs');
const path = require('node:path');

// formula / cask 名只允许这些字符 —— 名字要拼进 bash -c, 不合规的一律不接管。
const SAFE_NAME = /^[A-Za-z0-9@._+-]+$/;
// 运行时本身永不接管: claude-exp 派生的是 node, 卸掉它 npm 也跟着没了。
const RUNTIME_NAME = /^(node|nodejs|npm)(@[\d.]+)?$/;

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
  const match = String(real).match(/\/(Cellar|Caskroom)\/([^/]+)\//);
  if (!match || !SAFE_NAME.test(match[2])) return null;
  if (RUNTIME_NAME.test(match[2]) || RUNTIME_NAME.test(path.basename(resolved))) return null;
  return { kind: match[1] === 'Caskroom' ? 'cask' : 'formula', name: match[2], path: resolved };
}

function isNpmGlobalInstall(command) {
  return /^\s*npm\s+install\s+-g\s/.test(String(command || ''));
}

function takeoverCommand(owner, command) {
  if (!owner || !isNpmGlobalInstall(command)) return command;
  return `brew uninstall --${owner.kind} ${owner.name} && ${command}`;
}

module.exports = { homebrewOwnerOf, takeoverCommand, isNpmGlobalInstall };
