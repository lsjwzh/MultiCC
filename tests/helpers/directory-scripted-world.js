'use strict';
// Scripted world shared by the directory differential
// (docs/rust-migration/differential/directory-routes.js) and its frozen Node
// oracle (tests/helpers/legacy-directory-routes.js).
//
// Both sides get one identical world per data root: a registered git workspace
// with a real bare remote, an uncommitted file, a plain (non-git) directory, a
// fragile directory whose session cascade fails, three session records and a
// seeded ui-layout document. Git effects are real subprocesses against those
// throwaway repos only — never the checkout — and every effect is appended to
// `<dataRoot>/effects.log` so the differential can prove both sides asked their
// host for the same things, in the same order. Lines never carry an absolute
// path (the two data roots differ); ids and basenames do the identifying.
//
// The world owns the ports the retired service programmed against
// (src/directory/ports.js): repository, git, sessions, events, fsPort, helpers,
// tx. `ensureReady` is scripted: a directory named `no-git-tools` fails like a
// missing toolchain and one named `broken-repo` fails like an unwritable repo,
// which is what exercises the two `fix` codes the host vocabulary returns.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { realPathOf, isHomeOrAbove } = require('../../src/path-safety');
const { friendlyDirReason, dirReasonFix } = require('../../src/directories');
const { directoryPushState, pushDirectory, invalidate } = require('../../plugins/utils/git-push');

const CREATED = '2026-01-01T00:00:00.000Z';
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'MultiCC Test',
  GIT_AUTHOR_EMAIL: 'test@multicc.invalid',
  GIT_COMMITTER_NAME: 'MultiCC Test',
  GIT_COMMITTER_EMAIL: 'test@multicc.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00 +0000',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00 +0000',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

function gitEnv(dataRoot) {
  const globalConfig = path.join(dataRoot, '.gitconfig-empty');
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, '');
  return { ...process.env, ...COMMIT_ENV, GIT_CONFIG_GLOBAL: globalConfig };
}

// The harness seeds before the pipeline is built and does not await, so the
// fixture construction is synchronous on purpose.
function gitSync(dataRoot, cwd, args) {
  return String(execFileSync('git', args, { cwd, env: gitEnv(dataRoot) }) || '').trim();
}

async function git(dataRoot, cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnv(dataRoot) });
  return String(stdout || '').trim();
}

async function gitTry(dataRoot, cwd, args) {
  try { return await git(dataRoot, cwd, args); } catch (_) { return ''; }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function seed(dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const ws = path.join(dataRoot, 'ws');
  for (const dir of ['alpha', 'Beta', '.hidden']) fs.mkdirSync(path.join(ws, dir), { recursive: true });
  fs.symlinkSync(path.join(ws, 'alpha'), path.join(ws, 'alink'));
  write(path.join(ws, 'README.md'), '# workspace\n');
  write(path.join(ws, 'notes.txt'), 'note\n');

  const bare = path.join(dataRoot, 'ws.git');
  fs.mkdirSync(bare, { recursive: true });
  gitSync(dataRoot, bare, ['init', '--bare', '-b', 'main']);
  gitSync(dataRoot, ws, ['init', '-b', 'main']);
  gitSync(dataRoot, ws, ['add', '-A']);
  gitSync(dataRoot, ws, ['commit', '-m', 'chore: seed']);
  gitSync(dataRoot, ws, ['remote', 'add', 'origin', bare]);
  gitSync(dataRoot, ws, ['push', '-u', 'origin', 'main']);
  // One commit ahead of the remote, plus one uncommitted file.
  write(path.join(ws, 'src.txt'), 'alpha\n');
  gitSync(dataRoot, ws, ['add', 'src.txt']);
  gitSync(dataRoot, ws, ['commit', '-m', 'work: two']);
  write(path.join(ws, 'dirty.txt'), 'draft\n');

  for (const dir of ['ws2', 'ws3', 'fragile', 'broken-repo', 'no-git-tools']) {
    fs.mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }

  const dirs = [
    // A directory the host has already probed carries its base branch (the
    // real probe stamps it); ws2/ws3/fragile deliberately keep the fallback so
    // `git.baseBranch` stays on the exercised path.
    { id: 'dir-1', name: 'Workspace One', path: ws, createdAt: CREATED, baseBranch: 'main' },
    { id: 'dir-2', name: 'Workspace Two', path: path.join(dataRoot, 'ws2'), createdAt: CREATED },
    { id: 'dir-3', name: 'Workspace Three', path: path.join(dataRoot, 'ws3'), createdAt: CREATED },
    { id: 'dir-4', name: 'Fragile', path: path.join(dataRoot, 'fragile'), createdAt: CREATED },
  ];
  write(path.join(dataRoot, 'directories.json'), JSON.stringify(dirs, null, 2));
  const sessions = [
    { id: 'sess-1', dirId: 'dir-1', cli: 'claude', kind: 'chat' },
    { id: 'sess-2', dirId: 'dir-1', cli: 'codex', kind: 'terminal' },
    { id: 'sess-3', dirId: 'dir-2' },
    { id: 'sess-fail', dirId: 'dir-4', cli: 'claude', kind: 'terminal' },
  ];
  write(path.join(dataRoot, 'sessions.json'), JSON.stringify(sessions, null, 2));

  // The layout document is written through the same state store the runtime
  // uses, so the seed is a real envelope (with stale ids and an unknown key the
  // normalizer must drop).
  const stateStore = require('../../src/state/store');
  stateStore.createStore({
    file: path.join(dataRoot, 'ui-layout.json'), kind: 'ui-layout', schemaVersion: 1, legacyIsArray: false,
  }).save({
    dirOrder: ['dir-2', 'dir-1', 'gone-dir'],
    sessionOrder: {
      'dir-1': ['sess-2', 'sess-1', 'gone'],
      'dir-3': ['ghost'],
      'gone-dir': ['x'],
      'dir-2': [],
    },
    updatedAt: '2026-01-05T00:00:00.000Z',
    junk: true,
  });
}

// Mirrors src/directory/repository.js over a plain array (the native-owned Map
// is a host detail; the port shape is what the service programs against).
function createRepo(file, log) {
  let dirs = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(dirs)) dirs = [];
  function get(id) { return dirs.find(d => d.id === id); }
  function list() { return dirs.slice(); }
  function add(dir) {
    const at = dirs.findIndex(d => d.id === dir.id);
    if (at >= 0) dirs.splice(at, 1);
    dirs.push(dir);
    log('repo-add', dir.id);
    return dir;
  }
  function remove(id) {
    const at = dirs.findIndex(d => d.id === id);
    if (at < 0) return false;
    dirs.splice(at, 1);
    log('repo-remove', id);
    return true;
  }
  function findByPath(resolvedPath, excludeId) {
    const target = realPathOf(resolvedPath);
    for (const d of dirs) {
      if (excludeId && d.id === excludeId) continue;
      if (realPathOf(d.path) === target) return d;
    }
    return null;
  }
  function save() { fs.writeFileSync(file, JSON.stringify(dirs, null, 2)); }
  function map() { return dirs; }
  function raw() { return dirs; }
  return { get, list, add, remove, findByPath, save, map, raw };
}

function resolveCwd(current, arg) {
  if (!arg || arg === '~') return os.homedir();
  if (arg.startsWith('~/') || arg.startsWith('~\\')) return path.join(os.homedir(), arg.slice(2));
  return path.resolve(current, arg);
}

function state(dataRoot) {
  const effectsFile = path.join(dataRoot, 'effects.log');
  if (!fs.existsSync(effectsFile)) fs.writeFileSync(effectsFile, '');
  let ids = 0;
  const log = (...parts) => fs.appendFileSync(effectsFile, `${parts.join(':')}\n`);
  const repo = createRepo(path.join(dataRoot, 'directories.json'), log);
  let sessions = JSON.parse(fs.readFileSync(path.join(dataRoot, 'sessions.json'), 'utf8'));
  if (!Array.isArray(sessions)) sessions = [];
  const saveSessions = () => fs.writeFileSync(path.join(dataRoot, 'sessions.json'), JSON.stringify(sessions, null, 2));
  const base = name => path.basename(name);

  async function baseBranch(dirPath) {
    log('git-base-branch', base(dirPath));
    const symbolic = await gitTry(dataRoot, dirPath, ['symbolic-ref', '--short', 'HEAD']);
    if (symbolic) return symbolic;
    const abbrev = await gitTry(dataRoot, dirPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return abbrev && abbrev !== 'HEAD' ? abbrev : 'main';
  }

  async function ensureReady(dir) {
    log('ensure-ready', dir.id, base(dir.path));
    const name = base(dir.path);
    if (name === 'no-git-tools') return { ok: false, reason: 'spawn git ENOENT' };
    if (name === 'broken-repo') return { ok: false, reason: 'git-error: fatal: not writable' };
    if (!fs.existsSync(dir.path)) return { ok: false, reason: 'path-missing' };
    if (isHomeOrAbove(dir.path)) return { ok: false, reason: 'home-or-above' };
    if (await gitTry(dataRoot, dir.path, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      await git(dataRoot, dir.path, ['init', '-b', 'main']);
    }
    if (!(await gitTry(dataRoot, dir.path, ['rev-parse', 'HEAD']))) {
      try { await git(dataRoot, dir.path, ['add', '-A']); } catch (_) {}
      await git(dataRoot, dir.path, ['commit', '--allow-empty', '-m', 'chore: initialize repository']);
    }
    dir.baseBranch = await baseBranch(dir.path);
    dir.gitInitialized = true;
    return { ok: true };
  }

  // Call order is deterministic (a map over the directory list); completion
  // order of real git subprocesses is not. A FIFO here makes the side-effect
  // sequence reproducible on both sides without changing any answer.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  const gitPort = {
    baseBranch: dirPath => serial(() => baseBranch(dirPath)),
    async pushState(dirPath, branch, opts = {}) {
      log('git-push-state', base(dirPath), opts.force ? 'force' : 'cached');
      return serial(() => directoryPushState(dirPath, branch, opts));
    },
    async push(dirPath, branch) {
      log('git-push', base(dirPath));
      return serial(() => pushDirectory(dirPath, branch));
    },
    invalidatePushCache(dirPath, branch) {
      log('git-invalidate', base(dirPath));
      invalidate(dirPath, branch);
    },
    async statusPorcelain(dirPath) {
      log('git-status', base(dirPath));
      return git(dataRoot, dirPath, ['status', '--porcelain']);
    },
    async stageAll(dirPath) { log('git-stage-all', base(dirPath)); await git(dataRoot, dirPath, ['add', '-A']); },
    async commit(dirPath, message) { log('git-commit', base(dirPath), message); await git(dataRoot, dirPath, ['commit', '-m', String(message)]); },
    ensureReady,
    unmarkReady(id) { log('git-unmark-ready', id); },
  };

  const sessionsPort = {
    listByDir(dirId) { log('sessions-by-dir', dirId); return sessions.filter(s => s.dirId === dirId); },
    async seedCommander(dir) {
      log('seed-commander', dir.id);
      fs.mkdirSync(path.join(dataRoot, 'memory-shared', dir.id), { recursive: true });
      const commander = { id: `cmdr-${dir.id}`, dirId: dir.id, cli: 'claude', kind: 'chat' };
      sessions.push(commander);
      saveSessions();
      return commander;
    },
    async destroyCascade(session, dir, opts = {}) {
      log('destroy-cascade', session.id, `force=${!!opts.force}`);
      if (session.id === 'sess-fail') return { ok: false, error: 'cascade refused' };
      sessions = sessions.filter(s => s.id !== session.id);
      saveSessions();
      return { ok: true };
    },
  };

  const fsPort = {
    homedir: () => os.homedir(),
    sampleRoot: () => path.join(dataRoot, 'samples'),
    exists: p => fs.existsSync(p),
    isDirectory: p => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } },
    mkdirp: p => { log('mkdirp', String(p).startsWith(dataRoot) ? base(p) : p); fs.mkdirSync(p, { recursive: true }); },
    readDirents: p => fs.readdirSync(p, { withFileTypes: true })
      .map(e => ({ name: e.name, isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() })),
    writeFileExclusive(p, content) {
      try { fs.writeFileSync(p, content, { flag: 'wx' }); log('sample-file', base(p)); return true; }
      catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    },
  };

  const deps = {
    repo,
    git: gitPort,
    sessions: sessionsPort,
    events: { append(dirId, kind, text) { log('event', dirId, kind, text); } },
    fsPort,
    helpers: { resolveCwd, isHomeOrAbove, realPathOf, friendlyDirReason, dirReasonFix },
    tx: { commitCrossFileWrite(spec) { log('tx', spec.kind, spec.reason); repo.save(); saveSessions(); } },
    newId: () => { ids += 1; return `dir-new-${ids}`; },
    logger: { warn() {}, info() {}, error() {} },
  };
  return { dataRoot, effectsFile, readEffects: () => fs.readFileSync(effectsFile, 'utf8').split('\n').filter(Boolean), deps, repo, saveSessions, readSessions: () => sessions, touch(rel, text) { write(path.join(dataRoot, rel), text); } };
}

// The ui-layout store the current host composes (src/directory/ui-layout.js).
function layoutStore(raw) {
  const { createUiLayoutStore } = require('../../src/directory/ui-layout');
  const dirIds = () => raw.repo.list().map(d => d.id);
  const sessionIds = dirId => raw.readSessions().filter(s => s.dirId === dirId).map(s => s.id);
  return createUiLayoutStore({
    file: path.join(raw.dataRoot, 'ui-layout.json'),
    listDirIds: dirIds,
    listSessionIds: sessionIds,
    logger: { warn() {}, info() {}, error() {} },
  });
}

module.exports = { seed, state, layoutStore, resolveCwd };
