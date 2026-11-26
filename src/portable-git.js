'use strict';

// ── MultiCC's own git, for Macs without the Command Line Tools ────────────────
// install-git.sh (repo root, shipped in every package) unpacks GitHub Desktop's
// portable git into ~/.multicc/git and writes a wrapper at bin/git. Nothing else
// is needed for it to work except being found: every git call in the server is
// a bare `git` resolved through PATH (src/repo-actor/ and friends), and every
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

const ports = {
  get platform() { return process.platform; }, bin: portableGitBin,
  access: env => fs.accessSync(path.join(portableGitBin(env), 'git'), fs.constants.X_OK),
  parts: env => String(env.PATH || '').split(path.delimiter).filter(Boolean),
  set(env, dirs) { env.PATH = dirs.join(path.delimiter); },
};

function isInstalled(env = process.env) {
  return require('./native/binding').getNative().portableGitInstalled(ports, env);
}

function addToPath(env = process.env) {
  return require('./native/binding').getNative().portableGitAddToPath(ports, env);
}

module.exports = { portableGitDir, portableGitBin, installScriptPath, isInstalled, addToPath };
