'use strict';

// ── MultiCC's own git, for Macs without the Command Line Tools ────────────────
// install-git.sh (repo root, shipped in every package) unpacks GitHub Desktop's
// portable git into ~/.multicc/git and writes a wrapper at bin/git. Nothing else
// is needed for it to work except being found: every git call in the server is
// a bare `git` resolved through PATH (src/repo-actor.js and friends), and every
// launcher — the launchd plist, the standalone CLI, the desktop app — builds
// its own PATH. So instead of teaching each launcher, the server adds the
// directory to its own PATH once at startup and again right after the one-click
// install, which also makes a fresh install usable without a restart.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PKG_ROOT = path.resolve(__dirname, '..');

function portableGitDir(env = process.env) {
  return env.MULTICC_PORTABLE_GIT_DIR || path.join(os.homedir(), '.multicc', 'git');
}

function portableGitBin(env = process.env) {
  return path.join(portableGitDir(env), 'bin');
}

function installScriptPath() {
  return path.join(PKG_ROOT, 'install-git.sh');
}

function isInstalled(env = process.env) {
  try {
    fs.accessSync(path.join(portableGitBin(env), 'git'), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Inserted right before /usr/bin rather than at the front: a git the user put
// in Homebrew or /usr/local stays the one used, and the portable git only
// shadows the Command Line Tools shim it exists to replace. Idempotent.
function addToPath(env = process.env) {
  if (process.platform === 'win32' || !isInstalled(env)) return false;
  const bin = portableGitBin(env);
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (dirs.includes(bin)) return false;
  const at = dirs.indexOf('/usr/bin');
  dirs.splice(at < 0 ? 0 : at, 0, bin);
  env.PATH = dirs.join(path.delimiter);
  return true;
}

module.exports = { portableGitDir, portableGitBin, installScriptPath, isInstalled, addToPath };
