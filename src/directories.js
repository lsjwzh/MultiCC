// Directory suitability + path helpers: decide whether a chosen path can be a
// session workspace (not $HOME-or-above, not too large to `git add -A`), and
// resolve/match registered directories. Persistence (loadDirectories/save) and
// the stateful ensureDirGitReady() stay in server.js for now.
//
// Reads the registered directories from the shared state registry (call-time,
// never destructured). git helpers come from src/git.js. Imported into server.js
// by destructuring, so existing call sites are unchanged.
const fs = require('fs');
const path = require('path');
const state = require('./state/container');
const { gitIsRepo, gitRun, WORKTREE_SUBDIR, isDeveloperToolsMissingGitError }
  = require('./git/service');
// Shared with src/paths.js — the robust, symlink-ancestor-aware implementations.
// (Previously duplicated here with a bare fs.realpathSync that threw for
// not-yet-existing paths and did not collapse ancestor symlinks.)
const { isHomeOrAbove, realPathOf } = require('./path-safety');

// Reject directories that are far too large/heavy to be a session workspace.
// The initial `git add -A` is run synchronously and would otherwise hash the
// whole tree, freezing the event loop for minutes (e.g. picking ~/Downloads).
const DIR_MAX_FILES = 50000;                       // > this many files → unsuitable
const DIR_MAX_BYTES = 2 * 1024 * 1024 * 1024;      // > 2 GB of content → unsuitable
const DIR_SCAN_TIME_MS = 3000;                     // hard ceiling on the scan itself

// Find an already-registered directory whose physical path matches `resolvedPath`.
function findDirByPath(resolvedPath, excludeId) {
  const target = realPathOf(resolvedPath);
  for (const d of state.directories.values()) {
    if (excludeId && d.id === excludeId) continue;
    if (realPathOf(d.path) === target) return d;
  }
  return null;
}

function dirUnsuitableReason(exceeded) {
  if (exceeded === 'too-many-files')
    return { ok: false, reason: `该目录文件过多（超过 ${DIR_MAX_FILES} 个），不适合作为 session 目录，请选择具体的项目目录` };
  if (exceeded === 'too-large')
    return { ok: false, reason: `该目录体积过大（超过 ${Math.round(DIR_MAX_BYTES / (1024 ** 3))}GB），不适合作为 session 目录，请选择具体的项目目录` };
  if (exceeded === 'scan-timeout')
    return { ok: false, reason: '该目录过大（扫描超时），不适合作为 session 目录，请选择具体的项目目录' };
  return { ok: true };
}

// Measure only what `git add -A` will actually hash: files git would stage, i.e.
// untracked + modified, with .gitignore applied. This is the right weight for an
// existing repo — huge gitignored logs/build output (and nested git repos, which
// `ls-files` reports as a single dir entry, not their contents) must not count.
// Returns null if the dir isn't a usable repo, so callers fall back to a raw walk.
async function dirSuitabilityViaGit(dirPath) {
  // A denied path throws out of gitIsRepo (GIT_PERMISSION_DENIED) on purpose:
  // "git cannot read this" must reach the caller as a permission problem, not
  // as "no repository here, so it must be an ordinary folder".
  if (!await gitIsRepo(dirPath)) return null;
  let out;
  try { out = await gitRun(dirPath, ['ls-files', '-o', '-m', '-z', '--exclude-standard']); }
  catch { return null; }
  let files = 0, bytes = 0;
  const deadline = Date.now() + DIR_SCAN_TIME_MS;
  for (const rel of out.split('\0')) {
    if (!rel) continue;
    if (Date.now() > deadline) return dirUnsuitableReason('scan-timeout');
    let st;
    try { st = fs.statSync(path.join(dirPath, rel)); } catch { continue; }
    if (!st.isFile()) continue;            // nested-repo dir entries land here → skipped
    files++;
    bytes += st.size;
    if (files > DIR_MAX_FILES) return dirUnsuitableReason('too-many-files');
    if (bytes > DIR_MAX_BYTES) return dirUnsuitableReason('too-large');
  }
  return { ok: true };
}

async function dirSuitability(dirPath) {
  // Prefer git's own view when the dir is already a repo (respects .gitignore).
  const viaGit = await dirSuitabilityViaGit(dirPath);
  if (viaGit) return viaGit;
  // Fallback: raw filesystem walk for not-yet-initialised dirs (e.g. ~/Downloads).
  let files = 0, bytes = 0, exceeded = null;
  const deadline = Date.now() + DIR_SCAN_TIME_MS;
  const walk = (dir) => {
    if (exceeded) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (exceeded) return;
      if (Date.now() > deadline) { exceeded = 'scan-timeout'; return; }
      if (e.name === '.git' || e.name === WORKTREE_SUBDIR) continue;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Skip nested git repos: `git add -A` records them as a single gitlink
        // (their contents are never hashed), so they shouldn't count toward the
        // working-tree weight we're estimating here.
        if (fs.existsSync(path.join(full, '.git'))) continue;
        walk(full); continue;
      }
      if (e.isFile()) {
        files++;
        try { bytes += fs.statSync(full).size; } catch {}
        if (files > DIR_MAX_FILES) { exceeded = 'too-many-files'; return; }
        if (bytes > DIR_MAX_BYTES) { exceeded = 'too-large'; return; }
      }
    }
  };
  walk(dirPath);
  return dirUnsuitableReason(exceeded);
}

// macOS TCC denies the *directory itself*: the first syscall that touches it
// fails with EPERM, before a single file is read. Probing with a real write
// names that in milliseconds, and without spawning git — whose own failure
// ("fatal: unable to get current working directory: Operation not permitted")
// tells the user nothing. Other errno values are not denials and stay git's
// business. fs is injectable so the denial path is testable without a real
// protected folder.
function directoryWriteDenied(dirPath, { mkdirSync = fs.mkdirSync, rmdirSync = fs.rmdirSync } = {}) {
  const probe = path.join(dirPath, `.multicc-probe-${process.pid}`);
  try { mkdirSync(probe); }
  catch (error) {
    return Boolean(error) && (error.code === 'EPERM' || error.code === 'EACCES');
  }
  try { rmdirSync(probe); } catch (_) {}
  return false;
}

// macOS grants disk access to the *process that asked* (the "responsible
// process"), and which process that is depends on how MultiCC was started — so
// "grant Full Disk Access to MultiCC" is not an instruction a user can follow.
// Name the exact object instead, derived from how we are actually running.
// Kept in sync with desktop/lib/desktop-env.js (the server package cannot
// require the launcher's copy of it).
const APP_TRANSLOCATION_RE = /\/AppTranslocation\//;

function macPermissionTargets({ execPath = process.execPath, env = process.env } = {}) {
  const app = /^(.*\.app)\/Contents\//.exec(execPath);
  return {
    execPath,
    appBundle: app ? app[1] : null,
    desktop: env.MULTICC_DESKTOP === '1',
    service: env.MULTICC_SERVICE === '1',
    translocated: APP_TRANSLOCATION_RE.test(execPath),
  };
}

function macPermissionGuidance(targets = macPermissionTargets()) {
  const lines = [
    'git 无权访问该目录：macOS 的隐私保护会拦截「桌面 / 文档 / 下载 / iCloud 云盘 / 外接磁盘」这些受保护位置。',
  ];
  if (targets.translocated) {
    lines.push(
      '另外：MultiCC 现在运行在 macOS 的随机只读副本里（AppTranslocation，通常是从「下载」里直接双击运行的后果），'
      + '这种状态下任何授权都记不住。先把整个目录移出下载目录，并执行：'
      + 'xattr -dr com.apple.quarantine "<安装目录>"，然后重新启动。');
  }
  lines.push('要授权的对象取决于你现在的启动方式：');
  if (targets.service) {
    lines.push(`· 开机自启（launchd）不会弹窗，只能手动添加这一个二进制：${targets.execPath}`);
  } else if (targets.appBundle) {
    lines.push(`· 双击 MultiCC.app 启动：给这个 App 授权 —— ${targets.appBundle}`);
  } else if (targets.desktop) {
    lines.push(`· 桌面版：给 MultiCC.app 授权（当前进程 ${targets.execPath}）`);
  } else {
    lines.push(`· 从终端启动：给你的终端 App（Terminal / iTerm）授权，或直接添加这个二进制：${targets.execPath}`);
  }
  lines.push(
    '打开「系统设置 → 隐私与安全性 → 完全磁盘访问权限」，点 + 后按 Cmd+Shift+G 粘贴上面的路径；'
    + '也可以在终端执行：open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"');
  lines.push('授权后必须完全退出并重新启动 MultiCC（TCC 授权只在进程启动时生效）。'
    + '最省事的替代方案：把工作目录放在不受保护的位置，例如 ~/working。');
  return lines.join('\n');
}

// macOS installs /usr/bin/git as a Command Line Tools shim rather than as git.
// Without the tools every git call pops an install dialog and exits non-zero,
// so the raw fatal a user sees ('xcode-select: note: No developer tools were
// found...') reads like a MultiCC bug. It is not, and it is not fixable by
// rewriting this in another language either — the shim is in front of every
// process. Name the one command that fixes it.
function developerToolsGuidance() {
  return [
    'macOS 缺少命令行开发者工具（Command Line Tools），系统里的 git 只是个占位程序，所以任何 git 操作都会失败。',
    '在终端执行这一句即可（会弹窗，点“安装”等它装完，约几百 MB）：',
    '    xcode-select --install',
    '装完后用 git --version 验证：能打印版本号就好了，然后回 MultiCC 重新添加这个目录（不用重启服务）。',
    '如果你已经装了 Xcode，那只是没选中它：sudo xcode-select --switch /Applications/Xcode.app',
    '不想装命令行工具也行：MultiCC 要的只是一个能用的 git，用 Homebrew（brew install git）或 git-scm.com 装一个同样可以，'
      + '命令行工具只是 macOS 上最省事的那条路。',
  ].join('\n');
}

// Machine-readable counterpart to friendlyDirReason: names a fix the UI can
// offer as a button instead of asking the user to retype a command into a
// terminal they may not have open. Only failures with a one-command remedy get
// a code; everything else stays null and the prose alone is shown.
function dirReasonFix(reason) {
  if (!reason) return null;
  // Order mirrors friendlyDirReason: when a message carries both shapes, the
  // missing toolchain is the cause and the denial is downstream noise.
  if (isDeveloperToolsMissingGitError(reason)) return 'install-developer-tools';
  if (reason.startsWith('permission-denied: ')
    || /Operation not permitted|EPERM|unable to get current working directory/i.test(reason)) {
    // Not a fix that can be applied for the user — only macOS can grant this —
    // but the pane is two clicks deep and the binary to add is not obvious, so
    // the button opens the former and the UI names the latter.
    return 'open-disk-access';
  }
  return null;
}

// Turn an ensureDirGitReady reason code into a user-facing message.
function friendlyDirReason(reason) {
  if (!reason) return '目录初始化失败';
  if (reason.startsWith('unsuitable: ')) return reason.slice('unsuitable: '.length);
  if (reason === 'home-or-above') return '不允许选择 $HOME 或更高层目录';
  if (reason === 'path-missing') return '目录不存在';
  // Checked before the denial branch: when both shapes appear in one message,
  // a missing toolchain is the cause and the denial is downstream noise.
  if (isDeveloperToolsMissingGitError(reason)) {
    return developerToolsGuidance() + '\n原始错误: ' + reason;
  }
  // macOS TCC denies git (getcwd → EPERM) inside Desktop/Documents/Downloads
  // for processes without Full Disk Access; the bare git fatal is unreadable.
  // The text is written for macOS and is also what a Linux EPERM gets — that
  // predates this branch (the old message had the same shape), and a plain
  // "Permission denied" is at least still named correctly in 原始错误.
  if (reason.startsWith('permission-denied: ')
    || /Operation not permitted|EPERM|unable to get current working directory/i.test(reason)) {
    return macPermissionGuidance() + '\n原始错误: ' + reason;
  }
  return '无法将目录初始化为 git 仓库: ' + reason;
}

module.exports = {
  isHomeOrAbove,
  realPathOf,
  findDirByPath,
  dirUnsuitableReason,
  dirSuitabilityViaGit,
  dirSuitability,
  friendlyDirReason,
  developerToolsGuidance,
  dirReasonFix,
  macPermissionTargets,
  macPermissionGuidance,
  directoryWriteDenied,
};
