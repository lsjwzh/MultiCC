'use strict';
// Unit tests for src/directory/service.js — drives the service layer through
// in-memory fakes of every port (no fs, no git, no server process). This is
// the interface/implementation-separation payoff: the same contracts server.js
// binds to real adapters are satisfied here by fakes.
const path = require('path');
const { createDirectoryService } = require('../src/directory/service');
const { createFsDirectoryRepository } = require('../src/directory/repository');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// ── fakes ──────────────────────────────────────────────────────────────
function makeFakes({ dirs = [], sessions = [], fsDirs = new Set(), fsFiles = new Set() } = {}) {
  const repoMap = new Map(dirs.map(d => [d.id, d]));
  const calls = { saved: 0, seeded: [], destroyed: [], persisted: 0, events: [], gitReady: [], unmarked: [] };
  const realPathOf = (p) => p;   // identity: no symlinks in fake fs
  const repo = createFsDirectoryRepository({ file: '/nonexistent/never-written.json', map: repoMap, realPathOf });
  const _save = repo.save; void _save;
  repo.save = () => { calls.saved++; };   // don't touch the real fs in unit tests

  const git = {
    baseBranch: () => 'main',
    pushState: async () => ({ available: true, hasRemote: false, ahead: 0, behind: 0, dirty: 0 }),
    push: async () => { throw new Error('no remote'); },
    invalidatePushCache: () => {},
    statusPorcelain: async () => '',
    stageAll: async () => {},
    commit: async () => {},
    ensureReady: (dir) => { calls.gitReady.push(dir.id); return { ok: true }; },
    unmarkReady: (id) => { calls.unmarked.push(id); },
  };
  const sessionPort = {
    listByDir: (dirId) => sessions.filter(s => s.dirId === dirId),
    seedCommander: (dir) => { calls.seeded.push(dir.id); },
    destroyCascade: (s) => { calls.destroyed.push(s.id); },
    persistRecords: () => { calls.persisted++; },
    snapshotRecords: () => sessions.slice(),
  };
  const events = { append: (dirId, type, detail) => { calls.events.push({ dirId, type, detail }); } };
  const fsPort = {
    homedir: () => '/home/u',
    exists: (p) => fsDirs.has(p) || fsFiles.has(p),
    isDirectory: (p) => fsDirs.has(p),
    mkdirp: (p) => { fsDirs.add(p); },
    readDirents: (p) => {
      if (!fsDirs.has(p)) { const e = new Error(`ENOENT: ${p}`); throw e; }
      const kids = [...fsDirs].filter(d => path.dirname(d) === p && d !== p);
      return kids.map(d => ({ name: path.basename(d), isDirectory: true, isSymbolicLink: false }));
    },
  };
  const helpers = {
    resolveCwd: (cur, arg) => (arg.startsWith('/') ? arg : path.join(cur, arg)),
    isHomeOrAbove: (p) => p === '/home/u' || p === '/home' || p === '/',
    realPathOf,
    friendlyDirReason: (r) => `friendly:${r}`,
  };
  const svc = createDirectoryService({ repo, git, sessions: sessionPort, events, fsPort, helpers, newId: () => 'id-1' });
  return { svc, repo, calls, git, fsDirs };
}

(async () => {
  // ── port contract enforcement ──
  try {
    createDirectoryService({ repo: {}, git: {}, sessions: {}, events: {}, fsPort: {}, helpers: {} });
    ok(false, 'assertPort rejects incomplete implementations');
  } catch (e) {
    ok(/not implemented|implementation missing/.test(e.message), 'assertPort rejects incomplete implementations');
  }

  // ── register ──
  {
    const { svc, repo, calls } = makeFakes({ fsDirs: new Set(['/p', '/p/a']) });
    let r = svc.register({ name: '', path: '/p/a' });
    ok(!r.ok && r.message === 'name and path required', 'register: empty name rejected');
    r = svc.register({ name: 'x', path: '/home/u' });
    ok(!r.ok && r.message === '不允许选择 $HOME 或更高层目录', 'register: home dir rejected');
    r = svc.register({ name: 'x', path: '/p/missing' });
    ok(!r.ok && r.message === 'path does not exist: /p/missing', 'register: missing path without create rejected');
    r = svc.register({ name: 'x', path: '/p/missing', create: true });
    ok(r.ok && r.data.id === 'id-1' && r.data.path === '/p/missing', 'register: create:true mkdirps and registers');
    ok(calls.gitReady.includes('id-1') && calls.saved === 1 && calls.seeded.includes('id-1'),
      'register: git-ready checked, saved once, commander seeded');
    r = svc.register({ name: 'y', path: '/p/missing' });
    ok(!r.ok && r.message === '该路径已被目录 "x" 登记，不允许重复', 'register: duplicate path rejected');
    ok(repo.get('id-1'), 'register: record present in repository');
  }

  // ── register rollback when git init fails ──
  {
    const { svc, repo, calls } = makeFakes({ fsDirs: new Set(['/p', '/p/a']) });
    calls.gitReady.push = () => 0;  // noop
    const g = makeFakes({ fsDirs: new Set(['/p', '/p/a']) });
    g.svc; // (separate instance below)
    const fakes = makeFakes({ fsDirs: new Set(['/p', '/p/a']) });
    fakes.git.ensureReady = () => ({ ok: false, reason: 'boom' });
    const r = fakes.svc.register({ name: 'x', path: '/p/a' });
    ok(!r.ok && r.message === 'friendly:boom', 'register: git-init failure → friendly error');
    ok(!fakes.repo.get('id-1') && fakes.calls.saved === 0, 'register: failed record rolled back, never saved');
    void svc; void repo;
  }

  // ── update ──
  {
    const d = { id: 'd1', name: 'old', path: '/p/a' };
    const { svc, calls } = makeFakes({ dirs: [d], fsDirs: new Set(['/p', '/p/a', '/p/b']) });
    let r = svc.update('nope', { name: 'x' });
    ok(!r.ok && r.code === 'not_found', 'update: unknown id → not_found');
    r = svc.update('d1', { name: ' renamed ' });
    ok(r.ok && r.data.name === 'renamed' && calls.saved === 1, 'update: rename trims and saves');
    r = svc.update('d1', { path: '/p/missing' });
    ok(!r.ok && r.message === 'path does not exist: /p/missing', 'update: missing path rejected');
    r = svc.update('d1', { path: '/p/b' });
    ok(r.ok && r.data.path === '/p/b' && calls.unmarked.includes('d1') && calls.gitReady.includes('d1'),
      'update: path change re-verifies git readiness');
    r = svc.update('d1', { rolePrompt: 'R'.repeat(40001) });
    ok(!r.ok && r.message === 'rolePrompt too long (max 40000)', 'update: oversized rolePrompt rejected');
    r = svc.update('d1', { rolePrompt: '  ' });
    ok(r.ok && r.data.rolePrompt === null, 'update: blank rolePrompt → null');
  }

  // ── remove ──
  {
    const d = { id: 'd1', name: 'x', path: '/p/a' };
    const sess = [{ id: 's1', dirId: 'd1' }, { id: 's2', dirId: 'd1' }, { id: 's3', dirId: 'other' }];
    const { svc, repo, calls } = makeFakes({ dirs: [d], sessions: sess, fsDirs: new Set(['/p/a']) });
    let r = svc.remove('nope', {});
    ok(!r.ok && r.code === 'not_found', 'remove: unknown id → not_found');
    r = svc.remove('d1', { force: false });
    ok(!r.ok && r.message === 'directory has 2 session(s); pass ?force=1 to delete them too'
      && r.extra.sessions.join() === 's1,s2', 'remove: refuses without force, lists sessions');
    r = svc.remove('d1', { force: true });
    ok(r.ok && r.data.removedSessions === 2, 'remove: force destroys owned sessions');
    ok(calls.destroyed.join() === 's1,s2' && !repo.get('d1') && calls.saved === 1 && calls.persisted === 1,
      'remove: cascade order — destroy, delete record, save, persist sessions');
  }

  // ── browseFs ──
  {
    const { svc } = makeFakes({ fsDirs: new Set(['/home/u', '/home/u/proj', '/home/u/prox', '/home/u/.hidden']) });
    let r = svc.browseFs('');
    ok(r.ok && r.data.base === '/home/u' && r.data.entries.length === 2, 'browseFs: empty → home, hidden dirs filtered');
    r = svc.browseFs('~');
    ok(r.ok && r.data.base === '/home/u', 'browseFs: tilde → home');
    r = svc.browseFs('/home/u/pro');
    ok(r.ok && r.data.entries.map(e => e.name).join() === 'proj,prox', 'browseFs: prefix completion');
    r = svc.browseFs('/home/u/.hi');
    ok(r.ok && r.data.entries.map(e => e.name).join() === '.hidden', 'browseFs: dot-prefix reveals hidden');
    r = svc.browseFs('/nope/deeper/x');
    ok(r.ok && r.data.entries.length === 0 && r.data.parent === null, 'browseFs: missing parent → empty result');
  }

  // ── listAnnotated ──
  {
    const d = { id: 'd1', name: 'x', path: '/p/a' };
    const sess = [
      { id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat' },
      { id: 's2', dirId: 'd1' },                              // defaults → claude_terminal
      { id: 's3', dirId: 'd1', cli: 'codex', kind: 'chat' },
    ];
    const fakes = makeFakes({ dirs: [d], sessions: sess });
    const r = await fakes.svc.listAnnotated();
    const e = r.data[0];
    ok(r.ok && e.counts.claude_chat === 1 && e.counts.claude_terminal === 1 && e.counts.codex_chat === 1,
      'listAnnotated: per-(cli,kind) counts with defaults');
    ok(e.pushState && e.pushState.available === true, 'listAnnotated: pushState attached');
    fakes.git.pushState = async () => { throw new Error('kaput'); };
    const r2 = await fakes.svc.listAnnotated();
    ok(r2.data[0].pushState.available === false && r2.data[0].pushState.reason === 'kaput',
      'listAnnotated: pushState failure degrades gracefully');
  }

  // ── uncommitted parsing ──
  {
    const d = { id: 'd1', name: 'x', path: '/p/a' };
    const fakes = makeFakes({ dirs: [d] });
    fakes.git.statusPorcelain = async () => '?? added.txt\n M src/app.js\n?? new file.txt\n';
    const r = await fakes.svc.uncommitted('d1');
    ok(r.ok && r.data.files.length === 3
      && r.data.files[0].status === '??' && r.data.files[0].path === 'added.txt'
      && r.data.files[1].status === ' M' && r.data.files[1].path === 'src/app.js'
      && r.data.files[2].status === '??' && r.data.files[2].path === 'new file.txt',
      'uncommitted: porcelain parsed (status + path with spaces)');
    // Legacy-equivalence quirk (pre-existing upstream bug, deliberately kept):
    // the whole porcelain output is .trim()ed, so a FIRST line starting with a
    // space (' M …') loses its leading status char and its path is mis-sliced.
    fakes.git.statusPorcelain = async () => ' M src/app.js\n';
    const r2 = await fakes.svc.uncommitted('d1');
    ok(r2.ok && r2.data.files[0].status === 'M ' && r2.data.files[0].path === 'rc/app.js',
      'uncommitted: first-line leading-space mangling preserved (legacy equivalence)');
  }

  // ── commitAll ──
  {
    const d = { id: 'd1', name: 'x', path: '/p/a' };
    const fakes = makeFakes({ dirs: [d] });
    let staged = 0, committed = [];
    fakes.git.pushState = async () => ({ dirty: 0, ahead: 0 });
    let r = await fakes.svc.commitAll('d1');
    ok(r.ok && r.data.committed === false, 'commitAll: clean tree → committed:false');
    let phase = 0;
    fakes.git.pushState = async () => (phase++ === 0 ? { dirty: 3, ahead: 1 } : { dirty: 0, ahead: 2 });
    fakes.git.stageAll = async () => { staged++; };
    fakes.git.commit = async (_, m) => { committed.push(m); };
    r = await fakes.svc.commitAll('d1', '  custom msg  ');
    ok(r.ok && r.data.committed === true && staged === 1 && committed[0] === 'custom msg',
      'commitAll: dirty tree stages + commits with trimmed message');
    ok(fakes.calls.events.some(e => e.type === 'committed' && e.detail === '提交 1 个未提交改动'),
      'commitAll: event detail uses ahead-delta when it grew');
  }

  // ── push ──
  {
    const d = { id: 'd1', name: 'x', path: '/p/a' };
    const fakes = makeFakes({ dirs: [d] });
    let r = await fakes.svc.push('d1');
    ok(!r.ok && r.message === 'no remote', 'push: git failure → error message surfaced');
    fakes.git.push = async () => ({ pushed: true, before: { ahead: 2, remote: 'origin', remoteBranch: 'main' } });
    r = await fakes.svc.push('d1');
    ok(r.ok && r.data.ok === true && r.data.pushed === true, 'push: success shape { ok, ...result }');
    ok(fakes.calls.events.some(e => e.type === 'pushed' && e.detail === '2 个提交 → origin/main'),
      'push: event appended with push summary');
  }

  console.log(`\n== directory service unit: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
