'use strict';
// FROZEN ORACLE — do not edit for behaviour. This is the Node implementation of
// the directory / onboarding / ui-layout cluster as it was at HEAD 86bdeb1c,
// concatenated with only its `require` lines moved to the top of the module
// (src/directory/{controller,service,ports,ui-layout}.js and src/ui-layout.js,
// the files the migration deleted) so the differential can keep running the
// old code against the same scripted world as the Rust front door.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const stateStore = require('../../src/state/store');
const { ensureSampleWorkspace } = require('../../src/directory/sample-workspace');
const { quickCommitMessage } = require('../../src/git/default-commit-message');


// UI layout — the manual, drag-and-drop order the user chose for the directory
// grid and for the session list inside each fleet.
//
// Why this lives on the server at all: the order used to sit in the browser's
// localStorage (`multicc_dir_order`) and in the app's SharedPreferences
// (`directory_order`). That made it a property of the *device*, so a second
// browser, a phone, or a cleared cache each got their own arrangement and the
// user had to drag everything into place again. The arrangement is a property
// of the user's workspace, so it belongs next to the workspace.
//
// This module is the pure core: normalize what a client sends, prune what no
// longer exists, and hand back a plain document. Persistence and HTTP live in
// src/routes/ui-layout.js; the *application* of the order (manual first, then
// creation order for anything never dragged) lives in the two clients —
// public/ui-layout-store.js and app/lib/utils/session_status_helpers.dart —
// which must agree with each other, and have tests that say so.
//
// The document is deliberately a hint, never an authority: a list of ids in the
// order the user put them. Ids that mean nothing are dropped, ids that are
// missing fall back to creation order. Losing this file costs the user their
// arrangement and nothing else, which is why it is not journalled alongside
// sessions.json/directories.json.

const SCHEMA_VERSION = 1;

// Bounds. A fleet with 2000 sessions is already pathological; the cap exists so
// a malformed or hostile PUT cannot grow the file without limit. Ids are the
// same shape as everywhere else (uuid / `multicc-claude-chat-06`).
const MAX_IDS = 2000;
const MAX_ID_LENGTH = 200;
const MAX_DIRS = 500;

function emptyLayout() {
  return { dirOrder: [], sessionOrder: {}, updatedAt: null };
}

// One id list → deduplicated array of plausible ids, capped.
// `known` (a Set, optional) drops ids that no longer exist: a deleted session
// must not keep a slot in the order forever, or the file grows monotonically
// for the lifetime of the install.
function normalizeOrder(value, known) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || id.length > MAX_ID_LENGTH) continue;
    if (seen.has(id)) continue;
    if (known && !known.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

// Whole-document normalization, used both when loading from disk and when
// serving. Unknown top-level keys are dropped rather than preserved — this
// document has no extension points, and echoing back arbitrary client JSON is
// how a store like this turns into an accidental key/value service.
function normalizeLayout(raw, { knownDirIds, sessionIdsByDir } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const layout = emptyLayout();
  layout.dirOrder = normalizeOrder(src.dirOrder, knownDirIds);

  const bySrcDir = src.sessionOrder && typeof src.sessionOrder === 'object' && !Array.isArray(src.sessionOrder)
    ? src.sessionOrder
    : {};
  let dirs = 0;
  for (const [dirId, order] of Object.entries(bySrcDir)) {
    if (dirs >= MAX_DIRS) break;
    if (typeof dirId !== 'string' || !dirId || dirId.length > MAX_ID_LENGTH) continue;
    if (knownDirIds && !knownDirIds.has(dirId)) continue;
    const known = sessionIdsByDir ? sessionIdsByDir.get(dirId) : null;
    // A directory whose sessions are all gone leaves no entry rather than an
    // empty array, so an untouched fleet and a fleet dragged back to default
    // are the same document.
    const list = normalizeOrder(order, known);
    if (!list.length) continue;
    layout.sessionOrder[dirId] = list;
    dirs += 1;
  }

  const stamp = typeof src.updatedAt === 'string' && src.updatedAt.trim() ? src.updatedAt.trim() : null;
  layout.updatedAt = stamp && stamp.length <= 40 ? stamp : null;
  return layout;
}


const core = { SCHEMA_VERSION, MAX_IDS, MAX_ID_LENGTH, MAX_DIRS, emptyLayout, normalizeOrder, normalizeLayout };

// Directory-domain port contracts (interfaces). JavaScript has no `interface`
// keyword, so each port is declared as a method-name list and enforced at
// composition time: assertPort() throws if an implementation misses a method.
// The service layer programs against these contracts only — every fs / git /
// session / event effect crosses one of them, which is what lets unit tests
// substitute in-memory fakes for the real adapters composed in server.js.

function assertPort(portName, impl, methods) {
  if (!impl || typeof impl !== 'object') {
    throw new TypeError(`[directory] ${portName} implementation missing`);
  }
  for (const m of methods) {
    if (typeof impl[m] !== 'function') {
      throw new TypeError(`[directory] ${portName}.${m}() not implemented`);
    }
  }
  return impl;
}

// Registry of directory records, persisted to directories.json.
// `map()` returns the native-backed directory table shared with the rest of the
// server; the write and the cross-file journal are native operations.
const REPOSITORY_PORT = ['get', 'list', 'add', 'remove', 'findByPath', 'save', 'map'];

// Git effects on a directory's main working tree (push state, quick-commit,
// repo-readiness). Backed by plugins/utils/git-push + src/git-queue + the
// stateful ensureDirGitReady() in server.js.
const GIT_PORT = ['baseBranch', 'pushState', 'push', 'invalidatePushCache',
  'statusPorcelain', 'stageAll', 'commit', 'ensureReady', 'unmarkReady'];

// Session lifecycle owned by the session domain: enumerate a directory's
// sessions, seed the default Agent Commander chat, tear a session down
// (tmux/chat proc/worktree/triggers/notes/records) when its directory dies.
const SESSION_PORT = ['listByDir', 'seedCommander', 'destroyCascade'];

// Cross-file state transaction. The native owner snapshots both tables and
// writes the journal + both files itself, so the service only names the
// operation.
const TX_PORT = ['commitCrossFileWrite'];

// Append to the per-directory event feed.
const EVENT_PORT = ['append'];

// Filesystem access used by path validation and the fs/list browser.
const FS_PORT = ['homedir', 'sampleRoot', 'exists', 'isDirectory', 'mkdirp', 'readDirents', 'writeFileExclusive'];

// Pure(ish) path helpers shared with the wider codebase (src/directories.js).
const HELPER_PORT = ['resolveCwd', 'isHomeOrAbove', 'realPathOf', 'friendlyDirReason',
  'dirReasonFix'];


// Directory-domain service — all business rules for registering, listing,
// updating and removing project directories, plus git convenience actions on a
// directory's main working tree. No HTTP and no direct fs/git/session access:
// every effect crosses a port (see ports.js), so tests drive this layer with
// in-memory fakes. Behavior (status codes via error codes, and error message
// strings — several are user-facing Chinese) is kept exactly equivalent to the
// pre-extraction inline routes in server.js.

const ok = (data) => ({ ok: true, data });
const err = (code, message, extra) => ({ ok: false, code, message, ...(extra ? { extra } : {}) });

function createDirectoryService({ repo, git, sessions, events, fsPort, helpers, tx, newId = () => crypto.randomUUID() }) {
  assertPort('repository', repo, REPOSITORY_PORT);
  assertPort('git', git, GIT_PORT);
  assertPort('sessions', sessions, SESSION_PORT);
  assertPort('events', events, EVENT_PORT);
  assertPort('fsPort', fsPort, FS_PORT);
  assertPort('helpers', helpers, HELPER_PORT);
  assertPort('tx', tx, TX_PORT);

  // The controller spreads `extra` into the HTTP body, so a failure with no
  // one-command remedy must yield undefined rather than a null field every
  // client would have to special-case.
  // Any other git failure while adding a directory still gets the ops terminal
  // (public/air-ops-terminal.js) as a way in: the add-directory dialog is the
  // one place it is reachable from a host with no directories. Added here, not
  // in dirReasonFix, because that shared vocabulary also travels on queued
  // deliveries, where a generic "open a terminal" is not a remedy.
  const fixExtra = (reason) => {
    const fix = helpers.dirReasonFix(reason)
      || (String(reason || '').startsWith('git-error: ') ? 'open-ops-terminal' : null);
    return fix ? { fix } : undefined;
  };

  const dirBaseBranch = async (d) => d.baseBranch || await git.baseBranch(d.path);

  // Browse / autocomplete filesystem directories for the "new directory" picker.
  // Given a partial path (parent exists but the full path doesn't), returns the
  // parent's subdirectories whose name prefix-matches the trailing segment —
  // shell-style tab completion.
  function browseFs(rawInput) {
    let raw = (rawInput || '').toString().trim();
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
      raw = path.join(fsPort.homedir(), raw.slice(1));
    }
    let baseDir, prefix = '';
    if (!raw) {
      baseDir = fsPort.homedir();
    } else if (fsPort.isDirectory(raw)) {
      baseDir = raw;
    } else {
      baseDir = path.dirname(raw);
      prefix = path.basename(raw).toLowerCase();
      if (!fsPort.isDirectory(baseDir)) {
        return ok({ base: baseDir, parent: null, selectable: false, entries: [] });
      }
    }
    let dirents;
    try { dirents = fsPort.readDirents(baseDir); }
    catch (e) { return err('invalid', `无法读取目录：${e.message}`); }
    const entries = dirents
      .filter(d => {
        let dir = d.isDirectory;
        if (!dir && d.isSymbolicLink) dir = fsPort.isDirectory(path.join(baseDir, d.name));
        if (!dir) return false;
        if (d.name.startsWith('.') && !prefix.startsWith('.')) return false;
        if (prefix && !d.name.toLowerCase().startsWith(prefix)) return false;
        return true;
      })
      .map(d => ({ name: d.name, path: path.join(baseDir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);
    const root = path.parse(baseDir).root;
    return ok({
      base: baseDir,
      parent: baseDir === root ? null : path.dirname(baseDir),
      selectable: !helpers.isHomeOrAbove(baseDir),
      entries,
    });
  }

  // Every directory annotated with per-(cli,kind) session counts + git push
  // state. pushState is cached + serialized upstream, so the Promise.all never
  // forks more than one git at a time.
  async function listAnnotated() {
    const list = await Promise.all(repo.list().map(async d => {
      const counts = {
        claude_terminal: 0, claude_chat: 0,
        codex_terminal: 0, codex_chat: 0,
        opencode_terminal: 0, opencode_chat: 0,
        zcode_terminal: 0, zcode_chat: 0,
        qoder_terminal: 0, qoder_chat: 0,
        kimi_terminal: 0, kimi_chat: 0,
        codebuddy_terminal: 0, codebuddy_chat: 0,
        dsh_terminal: 0, dsh_chat: 0,
        gemini_terminal: 0, gemini_chat: 0,
        grok_terminal: 0, grok_chat: 0,
        commandcode_terminal: 0, commandcode_chat: 0,
        pi_terminal: 0, pi_chat: 0,
      };
      for (const s of sessions.listByDir(d.id)) {
        const k = `${s.cli || 'claude'}_${s.kind || 'terminal'}`;
        if (counts[k] !== undefined) counts[k]++;
      }
      let pushState;
      try {
        pushState = await git.pushState(d.path, await dirBaseBranch(d));
      } catch (error) {
        pushState = { available: false, hasRemote: false, ahead: 0, behind: 0, reason: error.message };
      }
      return { ...d, counts, pushState };
    }));
    return ok(list);
  }

  async function register({ name, path: rawPath, create, sample = false }) {
    const dirName = (name || '').trim();
    const raw = (rawPath || '').trim();
    const wantCreate = create === true || create === 'true';
    if (!dirName || !raw) return err('invalid', 'name and path required');
    const resolvedPath = helpers.resolveCwd(fsPort.homedir(), raw);
    if (helpers.isHomeOrAbove(resolvedPath)) {
      return err('invalid', '不允许选择 $HOME 或更高层目录');
    }
    if (!fsPort.exists(resolvedPath)) {
      if (!wantCreate) {
        return err('invalid', `path does not exist: ${resolvedPath}`);
      }
      try { fsPort.mkdirp(resolvedPath); }
      catch (e) { return err('invalid', `无法创建目录: ${e.message}`); }
    } else if (!fsPort.isDirectory(resolvedPath)) {
      return err('invalid', `路径不是目录: ${resolvedPath}`);
    }
    const dup = repo.findByPath(resolvedPath);
    if (dup) {
      return err('invalid', `该路径已被目录 "${dup.name}" 登记，不允许重复`);
    }
    const dir = { id: newId(), name: dirName, path: resolvedPath, createdAt: new Date().toISOString(), ...(sample ? { sample: true } : {}) };
    repo.add(dir);
    // Force the directory to be a usable git repo (worktree isolation depends on it).
    const ready = await git.ensureReady(dir);
    if (!ready.ok) {
      repo.remove(dir.id);
      // Carry the fix code alongside the prose so the client can offer the one
      // command that repairs this (e.g. installing macOS developer tools) as a
      // button rather than as text to retype.
      return err('invalid', helpers.friendlyDirReason(ready.reason), fixExtra(ready.reason));
    }
    repo.save();
    // Seed a default Agent Commander chat session so a workspace coordinator is ready
    // out of the box. Best-effort: failure is logged but never blocks creation.
    try { await sessions.seedCommander(dir); }
    catch (e) { console.warn(`[multicc] seed commander session error for dir ${dir.id}: ${e.message}`); }
    return ok(dir);
  }

  async function createSample() {
    const sample = ensureSampleWorkspace(fsPort);
    const existing = repo.findByPath(sample.path);
    if (existing) {
      if (existing.sample !== true) { existing.sample = true; repo.save(); }
      return ok({ ...existing, reused: true, createdFiles: sample.createdFiles });
    }
    const result = await register({ name: sample.name, path: sample.path, create: true, sample: true });
    return result.ok ? ok({ ...result.data, reused: false, createdFiles: sample.createdFiles }) : result;
  }

  async function update(id, body) {
    const d = repo.get(id);
    if (!d) return err('not_found', 'directory not found');
    if (body.name) d.name = String(body.name).trim();
    if (body.path) {
      const resolved = helpers.resolveCwd(fsPort.homedir(), String(body.path).trim());
      if (!fsPort.exists(resolved)) return err('invalid', `path does not exist: ${resolved}`);
      if (helpers.isHomeOrAbove(resolved)) {
        return err('invalid', '不允许选择 $HOME 或更高层目录');
      }
      const dup = repo.findByPath(resolved, d.id);
      if (dup) return err('invalid', `该路径已被目录 "${dup.name}" 登记，不允许重复`);
      if (helpers.realPathOf(resolved) !== helpers.realPathOf(d.path)) {
        d.path = resolved;
        // Path changed → re-verify git readiness for the new location.
        git.unmarkReady(d.id);
        const ready = await git.ensureReady(d);
        if (!ready.ok) return err('invalid', helpers.friendlyDirReason(ready.reason), fixExtra(ready.reason));
      }
    }
    if (body.rolePrompt !== undefined) {
      const rp = (body.rolePrompt == null ? '' : String(body.rolePrompt));
      if (rp.length > 40000) return err('invalid', 'rolePrompt too long (max 40000)');
      // Directory-level default role; sessions without their own role inherit it.
      d.rolePrompt = rp.trim() || null;
    }
    repo.save();
    return ok(d);
  }

  async function remove(id, { force } = {}) {
    const d = repo.get(id);
    if (!d) return err('not_found', 'directory not found');
    // Refuse to delete a non-empty directory unless force is passed.
    const owned = sessions.listByDir(d.id);
    if (owned.length > 0 && !force) {
      return err('invalid', `directory has ${owned.length} session(s); pass ?force=1 to delete them too`,
        { sessions: owned.map(s => s.id) });
    }
    // Mutate both live tables first — that is what makes the pair consistent.
    // Only THEN write both to disk in one native journalled transaction: on a
    // crash mid-write, boot replay re-issues both writes from the journal, so
    // users never observe "directory gone but its sessions still linger" (or
    // vice versa). The native owner snapshots both tables at commit time; there
    // is no second payload copy in Node and no unjournalled fallback.
    for (const s of owned) {
      const destroyed = await sessions.destroyCascade(s, d, { force });
      if (destroyed && destroyed.ok === false) return err('invalid', destroyed.error, destroyed);
    }
    repo.remove(d.id);
    try {
      tx.commitCrossFileWrite({
        kind: 'delete-directory',
        reason: `dir=${id} force=${!!force}`,
      });
    } catch (e) {
      // The in-memory state is already updated; we can't un-cascade a tmux
      // kill. Surface as an internal error — the boot journal will retry the
      // writes on next start. This is the "HTTP only 200 on real success"
      // guarantee.
      return err('internal', `persist failed: ${e.message}`);
    }
    return ok({ ok: true, removedSessions: owned.length });
  }

  async function push(id) {
    const d = repo.get(id);
    if (!d) return err('not_found', 'directory not found');
    try {
      const result = await git.push(d.path, await dirBaseBranch(d));
      events.append(d.id, 'pushed', result.pushed
        ? `${result.before.ahead} 个提交 → ${result.before.remote}/${result.before.remoteBranch}`
        : '无待推送提交');
      return ok({ ok: true, ...result });
    } catch (error) {
      return err('invalid', error.message);
    }
  }

  // List uncommitted files in the directory's main working tree, so the UI can
  // warn before a session worktree merge would tangle with dirty main.
  async function uncommitted(id) {
    const d = repo.get(id);
    if (!d) return err('not_found', 'directory not found');
    try {
      // trimEnd only: a leading " M" space is part of the XY column.
      const out = (await git.statusPorcelain(d.path)).trimEnd();
      const files = out ? out.split('\n').filter(Boolean).map(line => ({
        // xy status (e.g. " M", "??", "A ") + path. --porcelain never quotes
        // paths unless they contain special chars, so split once from index 2.
        status: line.slice(0, 2),
        path: line.slice(3),
      })) : [];
      return ok({ files });
    } catch (error) {
      return err('invalid', error.message);
    }
  }

  // Quick-commit-all on the directory's main working tree. Used by the "未提交"
  // warning affordance to clear a dirty main before merging session branches.
  async function commitAll(id, message) {
    const d = repo.get(id);
    if (!d) return err('not_found', 'directory not found');
    try {
      const branch = await dirBaseBranch(d);
      const ps = await git.pushState(d.path, branch, { force: true });
      if (ps.dirty === 0) return ok({ ok: true, committed: false, pushState: ps });
      const msg = (message ? String(message) : '').trim()
        || await quickCommitMessage(await git.statusPorcelain(d.path));
      await git.stageAll(d.path);
      await git.commit(d.path, msg);
      git.invalidatePushCache(d.path, branch);
      const after = await git.pushState(d.path, branch, { force: true });
      events.append(d.id, 'committed', `提交 ${after.ahead > ps.ahead ? after.ahead - ps.ahead : ps.dirty} 个未提交改动`);
      return ok({ ok: true, committed: true, pushState: after });
    } catch (error) {
      return err('invalid', error.message);
    }
  }

  // User-chosen display order (drag-sort in the console). The order IS the
  // registry's insertion order: directories.json is an array and every list()
  // walks the Map, so re-inserting in the requested order persists it without a
  // separate sort field. Ids the client didn't mention (registered from another
  // tab meanwhile) keep their relative order at the tail; unknown ids are ignored.
  function reorder(ids) {
    if (!Array.isArray(ids)) return err('invalid', 'ids array required');
    const wanted = [];
    const seen = new Set();
    for (const raw of ids) {
      const id = String(raw || '');
      if (!id || seen.has(id) || !repo.get(id)) continue;
      seen.add(id);
      wanted.push(repo.get(id));
    }
    const rest = repo.list().filter(d => !seen.has(d.id));
    for (const d of [...wanted, ...rest]) { repo.remove(d.id); repo.add(d); }
    repo.save();
    return ok({ ok: true, ids: repo.list().map(d => d.id) });
  }

  return { browseFs, listAnnotated, register, createSample, update, reorder, remove, push, uncommitted, commitAll };
}


// Directory-domain controller — express Router mapping HTTP ↔ service results.
// Zero business logic here: parse request inputs, call the service, translate
// its {ok, code, message, extra} results to status codes + JSON bodies. Mounted
// by server.js at the same middleware position the inline routes occupied.

const STATUS = { not_found: 404, invalid: 400, internal: 500 };

function send(res, r) {
  if (r.ok) return res.json(r.data);
  const status = STATUS[r.code] || 500;
  const body = { code: r.code || 'internal', error: r.message, ...(r.extra || {}) };
  if (status >= 500 && res.locals && res.locals.requestId) body.requestId = res.locals.requestId;
  return res.status(status).json(body);
}

// Wrap async handlers so a rejected promise becomes a JSON 500 instead of a
// hanging request (express 4 does not catch async throws).
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res))
  .catch(() => {
    if (!res.headersSent) {
      res.status(500).json({
        code: 'internal',
        error: 'internal_error',
        ...(res.locals && res.locals.requestId ? { requestId: res.locals.requestId } : {}),
      });
    }
  });

function createDirectoryRouter(service) {
  const router = express.Router();

  router.get('/api/fs/list', wrap((req, res) => send(res, service.browseFs(req.query.path))));

  router.get('/api/directories', wrap(async (req, res) => send(res, await service.listAnnotated())));

  router.post('/api/directories', wrap(async (req, res) => send(res, await service.register({
    name: req.body.name, path: req.body.path, create: req.body.create,
  }))));

  router.post('/api/onboarding/sample-workspace', wrap(async (_req, res) => send(res, await service.createSample())));

  router.put('/api/directories/order', wrap(async (req, res) =>
    send(res, service.reorder(req.body && req.body.ids))));

  router.patch('/api/directories/:id', wrap(async (req, res) => send(res, await service.update(req.params.id, req.body || {}))));

  router.delete('/api/directories/:id', wrap(async (req, res) =>
    send(res, await service.remove(req.params.id, { force: req.query.force === '1' }))));

  router.post('/api/directories/:id/push', wrap(async (req, res) => send(res, await service.push(req.params.id))));

  router.get('/api/directories/:id/uncommitted', wrap(async (req, res) =>
    send(res, await service.uncommitted(req.params.id))));

  router.post('/api/directories/:id/commit', wrap(async (req, res) =>
    send(res, await service.commitAll(req.params.id, req.body && req.body.message))));

  return router;
}



// UI layout routes — durable storage for the user's drag-and-drop arrangement
// of the directory grid and of the session list inside each fleet.
//
//   GET  /api/ui-layout                        → the whole document
//   PUT  /api/ui-layout/dir-order              { order: [dirId, …] }
//   PUT  /api/ui-layout/session-order/:dirId   { order: [sessionId, …] }
//
// This lives in the directory domain because that is what the document is about:
// the grid is directories, and a "fleet" is one directory's sessions. It mounts
// onto the directory router (src/directory/index.js), so the composition root
// keeps a single directory-domain mount point.
//
// The two PUTs are deliberately separate rather than one PUT of the whole
// document: dragging a card in one fleet must not overwrite the arrangement a
// second browser just made in another. Whole-document writes would make the
// last tab to touch anything win everything.
//
// Pruning happens on both read and write (see src/ui-layout.js). Read-side
// pruning is what keeps a deleted fleet from lingering in the response without
// forcing a disk write on every GET.


function createUiLayoutRuntime(rawDeps) {
  const deps = rawDeps || {};
  const { file } = deps;
  if (!file) throw new TypeError('[ui-layout] file path is required');
  if (typeof deps.listDirIds !== 'function') throw new TypeError('[ui-layout] listDirIds() is required');
  if (typeof deps.listSessionIds !== 'function') throw new TypeError('[ui-layout] listSessionIds() is required');
  const logger = deps.logger || console;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const store = stateStore.createStore({
    file, kind: 'ui-layout', schemaVersion: core.SCHEMA_VERSION, legacyIsArray: false,
  });

  // In-memory authority for the process. Loaded once, lazily: a fresh install
  // has no file and must not pay a stat on every request.
  let layout = null;

  // Snapshot of what currently exists, rebuilt per request. Cheap (a few
  // hundred entries) and always right, which matters more here than caching —
  // a stale known-set would silently delete a just-created session's slot.
  function knownIds() {
    const knownDirIds = new Set(deps.listDirIds());
    const sessionIdsByDir = new Map();
    for (const dirId of knownDirIds) sessionIdsByDir.set(dirId, new Set(deps.listSessionIds(dirId)));
    return { knownDirIds, sessionIdsByDir };
  }

  function load() {
    if (layout) return layout;
    try {
      const r = store.loadOrRecover();
      layout = core.normalizeLayout(r.present ? r.data : null);
    } catch (e) {
      // A corrupt layout file costs the user their arrangement, nothing else.
      // Starting from empty is the right blast radius here — unlike
      // sessions.json, where state-store deliberately fails closed.
      logger.warn(`[multicc/ui-layout] unreadable layout file, starting empty: ${e.message}`);
      layout = core.emptyLayout();
    }
    return layout;
  }

  function persist() {
    layout.updatedAt = now();
    try { store.save(layout); }
    catch (e) { logger.warn(`[multicc/ui-layout] save failed: ${e.message}`); }
  }

  // What a client should see: stored order minus anything that no longer exists.
  function readLayout() {
    return core.normalizeLayout(load(), knownIds());
  }

  function setDirOrder(order) {
    const { knownDirIds } = knownIds();
    load().dirOrder = core.normalizeOrder(order, knownDirIds);
    persist();
    return readLayout();
  }

  function setSessionOrder(dirId, order) {
    const { knownDirIds, sessionIdsByDir } = knownIds();
    if (!knownDirIds.has(dirId)) return null;
    const next = core.normalizeOrder(order, sessionIdsByDir.get(dirId));
    const doc = load();
    if (next.length) doc.sessionOrder[dirId] = next;
    else delete doc.sessionOrder[dirId];
    persist();
    return readLayout();
  }

  // `target` is an express Router (production) or the app (tests) — both expose
  // the same get/put surface.
  function mountRoutes(target) {
    target.get('/api/ui-layout', (req, res) => {
      res.json({ ok: true, layout: readLayout() });
    });

    target.put('/api/ui-layout/dir-order', (req, res) => {
      const body = req.body || {};
      if (!Array.isArray(body.order)) {
        return res.status(400).json({ error: 'order must be an array of directory ids' });
      }
      res.json({ ok: true, layout: setDirOrder(body.order) });
    });

    target.put('/api/ui-layout/session-order/:dirId', (req, res) => {
      const body = req.body || {};
      if (!Array.isArray(body.order)) {
        return res.status(400).json({ error: 'order must be an array of session ids' });
      }
      const next = setSessionOrder(req.params.dirId, body.order);
      if (!next) return res.status(404).json({ error: 'directory not found' });
      res.json({ ok: true, layout: next });
    });
  }

  return { mountRoutes, readLayout, setDirOrder, setSessionOrder };
}


// ── composition (server.js: directory router, then the ui-layout routes) ────
function mountLegacyDirectory(app, world) {
  const quiet = { warn() {}, info() {}, error() {} };
  const service = createDirectoryService(world.deps);
  app.use(createDirectoryRouter(service));
  const file = path.join(world.dataRoot, 'ui-layout.json');
  const runtime = createUiLayoutRuntime({
    file,
    listDirIds: () => world.repo.list().map(d => d.id),
    listSessionIds: dirId => world.readSessions().filter(s => s.dirId === dirId).map(s => s.id),
    logger: quiet,
  });
  runtime.mountRoutes(app);
  return runtime;
}

module.exports = { mountLegacyDirectory };
