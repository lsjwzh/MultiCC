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
const state = require('./state');
const { gitIsRepo, gitRun, WORKTREE_SUBDIR } = require('./git');
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

// Turn an ensureDirGitReady reason code into a user-facing message.
function friendlyDirReason(reason) {
  if (!reason) return '目录初始化失败';
  if (reason.startsWith('unsuitable: ')) return reason.slice('unsuitable: '.length);
  if (reason === 'home-or-above') return '不允许选择 $HOME 或更高层目录';
  if (reason === 'path-missing') return '目录不存在';
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
};
