'use strict';

// 宿主端口：目录 / onboarding / UI 布局簇的 13 条公开路由已由 Rust 前门独占
// （src/directory/controller.js 10 条、src/directory/ui-layout.js 3 条）。
// 路径匹配、参数解码、query/body 读取、OPTIONS Allow、输入归一化与校验、
// `isHomeOrAbove` 穿越判定、浏览过滤/排序/截断、DTO 键序、`{code,error,…}`
// 错误信封、reorder 合并规则与 ui-layout 的 normalize/prune 规则见
// native/gateway/src/app/directory_routes.rs 与 native/core/src/directory_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   repo        directories.json 的活表（native owner 是唯一写者）
//   git         子进程（pushState / push / status / add / commit / ensureReady）
//   fsPort      目录扫描、mkdirp、示例工作区文件（writeFileExclusive）
//   sessions    会话表读取、seedCommander、删除级联（tmux kill）
//   events      目录事件追加
//   tx          原生跨文件事务（directories.json + sessions.json 一次 journal）
//   uiLayout    ui-layout.json 的 state-store 读写与已知 id 快照
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const path = require('path');
const crypto = require('crypto');
const { isLocalRequest } = require('../request-locality');
const { ensureSampleWorkspace } = require('../directory/sample-workspace');

const HOST_PATH = '/api/__host/directory';

/** Marker meaning "this op is not part of the cluster" -> 400 unknown operation. */
const UNKNOWN = Symbol('unknown');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// `(raw || '').toString()` for a JSON query value.
function jsToString(value) {
  if (value == null || value === false || value === 0 || value === '') return '';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function createDirectoryHost(rawDeps = {}) {
  const deps = rawDeps;
  const logger = deps.logger || console;
  const repo = deps.repo;
  const git = deps.git;
  const sessions = deps.sessions;
  const events = deps.events;
  const fsPort = deps.fsPort;
  const helpers = deps.helpers;
  const tx = deps.tx;
  const uiLayout = deps.uiLayout;
  const newId = typeof deps.newId === 'function' ? deps.newId : () => crypto.randomUUID();

  const dirBaseBranch = async (d) => d.baseBranch || await git.baseBranch(d.path);

  // ── browse (fs/list) ─────────────────────────────────────────────────

  function browseFacts(input) {
    let raw = jsToString(input).trim();
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
      raw = path.join(fsPort.homedir(), raw.slice(1));
    }
    const home = fsPort.homedir();
    let base;
    let prefix = '';
    let baseIsDir = false;
    let parentIsDir = false;
    if (!raw) {
      base = home;
      baseIsDir = true;
    } else if (fsPort.isDirectory(raw)) {
      base = raw;
      baseIsDir = true;
    } else {
      base = path.dirname(raw);
      prefix = path.basename(raw).toLowerCase();
      parentIsDir = fsPort.isDirectory(base);
    }
    const show = baseIsDir || parentIsDir;
    const parent = show && base !== path.parse(base).root ? path.dirname(base) : null;
    return {
      base,
      prefix,
      baseIsDir,
      parentIsDir,
      parent,
      realBase: helpers.realPathOf(base),
      realHome: helpers.realPathOf(home),
    };
  }

  function browseRead(base) {
    let dirents;
    try { dirents = fsPort.readDirents(String(base)); }
    catch (e) { return { error: e.message, entries: [], order: [] }; }
    const entries = dirents.map(d => {
      const joined = path.join(String(base), d.name);
      return {
        name: d.name,
        path: joined,
        isDirectory: d.isDirectory === true,
        isSymbolicLink: d.isSymbolicLink === true,
        targetIsDirectory: !d.isDirectory && d.isSymbolicLink === true ? fsPort.isDirectory(joined) : false,
      };
    });
    // `localeCompare` stays in the JS engine (project convention); the Rust
    // kernel applies the filter and the 200-entry cap to this permutation.
    const order = entries.map((_, index) => index)
      .sort((a, b) => entries[a].name.localeCompare(entries[b].name));
    return { entries, order };
  }

  // ── directories ──────────────────────────────────────────────────────

  async function dirsAnnotated() {
    const dirs = repo.list();
    // Per directory: read its sessions, then ask for its push state, exactly
    // like the retired `Promise.all` map did. `pushState` is cached + serialized
    // upstream, so the map never forks more than one git at a time.
    const perDir = new Array(dirs.length);
    const pushStates = await Promise.all(dirs.map(async (d, index) => {
      perDir[index] = sessions.listByDir(d.id).map(s => ({ cli: s.cli, kind: s.kind }));
      try {
        return { ok: true, value: await git.pushState(d.path, await dirBaseBranch(d)) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }));
    return { dirs, sessions: perDir, pushStates };
  }

  function findDir(id) {
    return repo.get(String(id));
  }

  async function ensureReady(id) {
    const dir = findDir(id);
    if (!dir) return { ok: false, reason: 'path-missing' };
    const ready = await git.ensureReady(dir);
    if (ready && ready.ok) return { ok: true };
    return { ok: false, reason: ready ? ready.reason : undefined };
  }

  async function registerCommit(id) {
    const dir = findDir(id);
    if (!dir) return { error: 'directory not found' };
    try { repo.save(); }
    catch (e) { return { error: e.message }; }
    // Best-effort: failure is logged but never blocks creation.
    try { await sessions.seedCommander(dir); }
    catch (e) { logger.warn?.(`[multicc] seed commander session error for dir ${dir.id}: ${e.message}`); }
    // The readiness probe stamped baseBranch/gitInitialized on the record; the
    // front door answers with the record as it now lives.
    return { dir: findDir(id) || null };
  }

  async function dirsReorder(order) {
    try {
      for (const id of order) {
        const dir = findDir(id);
        if (!dir) continue;
        repo.remove(dir.id);
        repo.add(dir);
      }
      repo.save();
      return { ids: repo.list().map(d => d.id) };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function destroyCascade(body) {
    const dir = findDir(body.dirId);
    // The caller already listed this directory's sessions; take the record it
    // sent so the cascade does not re-list them (the retired handler passed the
    // session object straight through).
    const session = body.session && body.session.id
      ? body.session
      : sessions.listByDir(String(body.dirId)).find(item => item.id === body.sessionId);
    if (!session) return { result: null };
    const result = await sessions.destroyCascade(session, dir, { force: body.force === true });
    return { result: result === undefined ? null : result };
  }

  async function gitPush(id) {
    const dir = findDir(id);
    if (!dir) return { error: 'directory not found' };
    try {
      return { result: await git.push(dir.path, await dirBaseBranch(dir)) };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function commitFacts(id) {
    const dir = findDir(id);
    if (!dir) return { error: 'directory not found' };
    try {
      const branch = await dirBaseBranch(dir);
      return { pushState: await git.pushState(dir.path, branch, { force: true }) };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function commitDefaultMessage(id) {
    const dir = findDir(id);
    if (!dir) return { error: 'directory not found' };
    try {
      const { quickCommitMessage } = require('../native/runtime');
      return { message: await quickCommitMessage(await git.statusPorcelain(dir.path)) };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function commitRun(id, message) {
    const dir = findDir(id);
    if (!dir) return { error: 'directory not found' };
    try {
      const branch = await dirBaseBranch(dir);
      await git.stageAll(dir.path);
      await git.commit(dir.path, String(message));
      git.invalidatePushCache(dir.path, branch);
      return { pushState: await git.pushState(dir.path, branch, { force: true }) };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── op table ─────────────────────────────────────────────────────────

  async function invoke(body) {
    switch (body.op) {
      case 'browse-facts':
        return browseFacts(body.path);

      case 'browse-read':
        return browseRead(body.base);

      case 'dirs-annotated':
        return dirsAnnotated();

      case 'dir-ids':
        return { ids: repo.list().map(d => d.id) };

      case 'dir-get':
        return { dir: findDir(body.id) || null };

      case 'resolve-path':
        // `path.resolve`/`path.join` semantics stay in Node; the answer is a
        // path fact the Rust kernel applies its safety verdict to.
        return { resolved: helpers.resolveCwd(fsPort.homedir(), String(body.path)) };

      case 'real-paths':
        return {
          real: (Array.isArray(body.paths) ? body.paths : []).map(p => helpers.realPathOf(String(p))),
          home: helpers.realPathOf(fsPort.homedir()),
        };

      case 'path-facts': {
        const paths = Array.isArray(body.paths) ? body.paths : [];
        return {
          exists: paths.map(p => fsPort.exists(String(p))),
          isDirectory: paths.map(p => fsPort.isDirectory(String(p))),
        };
      }

      case 'find-by-path':
        return { found: repo.findByPath(String(body.path), body.excludeId || undefined) || null };

      case 'mkdirp':
        try { fsPort.mkdirp(String(body.path)); return {}; }
        catch (e) { return { error: e.message }; }

      case 'new-id':
        return { id: newId() };

      case 'register-add':
        repo.add(body.dir);
        return {};

      case 'register-rollback':
        repo.remove(String(body.id));
        return {};

      case 'register-commit':
        return registerCommit(body.id);

      case 'ensure-ready':
        return ensureReady(body.id);

      case 'dir-set-name': {
        const dir = findDir(body.id);
        if (dir) dir.name = String(body.name);
        return {};
      }

      case 'realpath-equal': {
        const dir = findDir(body.id);
        if (!dir) return { equal: true };
        return { equal: helpers.realPathOf(String(body.path)) === helpers.realPathOf(dir.path) };
      }

      case 'dir-set-path': {
        const dir = findDir(body.id);
        if (!dir) return { error: 'directory not found' };
        dir.path = String(body.path);
        git.unmarkReady(dir.id);
        return {};
      }

      case 'dir-set-role': {
        const dir = findDir(body.id);
        if (dir) dir.rolePrompt = body.value == null ? null : String(body.value);
        return {};
      }

      case 'dir-save':
        try { repo.save(); return {}; }
        catch (e) { return { error: e.message }; }

      case 'sessions-by-dir':
        return { sessions: sessions.listByDir(String(body.id)) };

      case 'destroy-cascade':
        return destroyCascade(body);

      case 'dir-remove':
        try { repo.remove(String(body.id)); return {}; }
        catch (e) { return { error: e.message }; }

      case 'tx-commit':
        try {
          tx.commitCrossFileWrite({
            kind: 'delete-directory',
            reason: `dir=${body.id} force=${body.force === true}`,
          });
          return {};
        } catch (e) {
          return { error: e.message };
        }

      case 'git-push':
        return gitPush(body.id);

      case 'events-append':
        events.append(String(body.dirId), String(body.kind), body.text);
        return {};

      case 'status-porcelain': {
        const dir = findDir(body.id);
        if (!dir) return { error: 'directory not found' };
        try { return { out: await git.statusPorcelain(dir.path) }; }
        catch (e) { return { error: e.message }; }
      }

      case 'commit-facts':
        return commitFacts(body.id);

      case 'commit-default-message':
        return commitDefaultMessage(body.id);

      case 'commit-validate':
        return { ok: true };

      case 'commit-run':
        return commitRun(body.id, body.message);

      case 'dirs-reorder':
        return dirsReorder(Array.isArray(body.order) ? body.order : []);

      case 'sample-ensure':
        try { return ensureSampleWorkspace(fsPort); }
        catch (e) { return { error: e.message }; }

      case 'sample-mark': {
        const dir = findDir(body.id);
        if (!dir) return { error: 'directory not found' };
        dir.sample = true;
        try { repo.save(); return { dir }; }
        catch (e) { return { error: e.message }; }
      }

      case 'dir-reason': {
        // The shared failure vocabulary stays in src/directories.js: workspace
        // admission also reads it, and two copies of the macOS guidance text
        // would drift. The HTTP envelope around it is the Rust kernel's.
        const reason = body.reason || null;
        return {
          detail: helpers.friendlyDirReason(reason),
          fix: helpers.dirReasonFix(reason),
        };
      }

      case 'layout-load':
        return uiLayout.load();

      case 'layout-save':
        uiLayout.save(body.doc);
        return {};

      case 'layout-known':
        return uiLayout.known();

      default:
        return UNKNOWN;
    }
  }

  function mount(app) {
    app.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      const isLocal = typeof deps.isLocal === 'function' ? deps.isLocal : isLocalRequest;
      if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
      const body = asObject(req.body);
      return Promise.resolve()
        .then(() => invoke(body))
        .then(
          (value) => {
            if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
            return res.json({ ok: true, value: value === undefined ? null : value });
          },
          (error) => {
            // 500 会被前门翻译成 rust_backend_unavailable（见 docs/gateway.md §9）。
            logger?.error?.('[directory-host] operation failed', body.op, error);
            return res.status(500).json({ error: 'host operation failed' });
          },
        );
    });
  }

  // First-run default workspace. There is no HTTP request to route through the
  // Rust decision tree here, so this is the one boot-time path that performs
  // the registry effects directly; it only ever sees the known-safe default
  // workspace path under the app data directory.
  async function registerDefaultDirectory({ name, path: rawPath }) {
    const resolved = helpers.resolveCwd(fsPort.homedir(), String(rawPath).trim());
    if (helpers.isHomeOrAbove(resolved)) return { ok: false, message: '不允许选择 $HOME 或更高层目录' };
    const existing = repo.findByPath(resolved);
    if (existing) return { ok: true, data: existing };
    try {
      if (!fsPort.exists(resolved)) fsPort.mkdirp(resolved);
    } catch (e) {
      return { ok: false, message: `无法创建目录: ${e.message}` };
    }
    const dir = {
      id: newId(),
      name: String(name).trim(),
      path: resolved,
      createdAt: new Date().toISOString(),
    };
    repo.add(dir);
    const ready = await git.ensureReady(dir);
    if (!ready || !ready.ok) {
      repo.remove(dir.id);
      return { ok: false, message: helpers.friendlyDirReason(ready && ready.reason) };
    }
    try { repo.save(); }
    catch (e) { return { ok: false, message: e.message }; }
    try { await sessions.seedCommander(dir); }
    catch (e) { logger.warn?.(`[multicc] seed commander session error for dir ${dir.id}: ${e.message}`); }
    return { ok: true, data: dir };
  }

  return { invoke, mount, registerDefaultDirectory };
}

function mountDirectoryHostRoute(app, options = {}) {
  createDirectoryHost(options).mount(app);
}

module.exports = { HOST_PATH, createDirectoryHost, mountDirectoryHostRoute };
