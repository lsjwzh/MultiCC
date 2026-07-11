'use strict';
// Directory-domain service — all business rules for registering, listing,
// updating and removing project directories, plus git convenience actions on a
// directory's main working tree. No HTTP and no direct fs/git/session access:
// every effect crosses a port (see ports.js), so tests drive this layer with
// in-memory fakes. Behavior (status codes via error codes, and error message
// strings — several are user-facing Chinese) is kept exactly equivalent to the
// pre-extraction inline routes in server.js.
const path = require('path');
const crypto = require('crypto');
const { assertPort, REPOSITORY_PORT, GIT_PORT, SESSION_PORT, EVENT_PORT, FS_PORT, HELPER_PORT } = require('./ports');

const ok = (data) => ({ ok: true, data });
const err = (code, message, extra) => ({ ok: false, code, message, ...(extra ? { extra } : {}) });

function createDirectoryService({ repo, git, sessions, events, fsPort, helpers, newId = () => crypto.randomUUID() }) {
  assertPort('repository', repo, REPOSITORY_PORT);
  assertPort('git', git, GIT_PORT);
  assertPort('sessions', sessions, SESSION_PORT);
  assertPort('events', events, EVENT_PORT);
  assertPort('fsPort', fsPort, FS_PORT);
  assertPort('helpers', helpers, HELPER_PORT);

  const dirBaseBranch = (d) => d.baseBranch || git.baseBranch(d.path);

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
        return ok({ base: baseDir, parent: null, entries: [] });
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
    return ok({ base: baseDir, parent: baseDir === root ? null : path.dirname(baseDir), entries });
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
      };
      for (const s of sessions.listByDir(d.id)) {
        const k = `${s.cli || 'claude'}_${s.kind || 'terminal'}`;
        if (counts[k] !== undefined) counts[k]++;
      }
      let pushState;
      try {
        pushState = await git.pushState(d.path, dirBaseBranch(d));
      } catch (error) {
        pushState = { available: false, hasRemote: false, ahead: 0, behind: 0, reason: error.message };
      }
      return { ...d, counts, pushState };
    }));
    return ok(list);
  }

  function register({ name, path: rawPath, create }) {
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
    const dir = { id: newId(), name: dirName, path: resolvedPath, createdAt: new Date().toISOString() };
    repo.add(dir);
    // Force the directory to be a usable git repo (worktree isolation depends on it).
    const ready = git.ensureReady(dir);
    if (!ready.ok) {
      repo.remove(dir.id);
      return err('invalid', helpers.friendlyDirReason(ready.reason));
    }
    repo.save();
    // Seed a default Agent Commander chat session so a fleet conductor is ready
    // out of the box. Best-effort: failure is logged but never blocks creation.
    try { sessions.seedCommander(dir); }
    catch (e) { console.warn(`[multicc] seed commander session error for dir ${dir.id}: ${e.message}`); }
    return ok(dir);
  }

  function update(id, body) {
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
        const ready = git.ensureReady(d);
        if (!ready.ok) return err('invalid', `无法将目录初始化为 git 仓库: ${ready.reason}`);
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

  function remove(id, { force } = {}) {
    const d = repo.get(id);
    if (!d) return err('not_found', 'directory not found');
    // Refuse to delete a non-empty directory unless force is passed.
    const owned = sessions.listByDir(d.id);
    if (owned.length > 0 && !force) {
      return err('invalid', `directory has ${owned.length} session(s); pass ?force=1 to delete them too`,
        { sessions: owned.map(s => s.id) });
    }
    for (const s of owned) sessions.destroyCascade(s, d);
    repo.remove(d.id);
    repo.save();
    sessions.persistRecords();
    return ok({ ok: true, removedSessions: owned.length });
  }

  async function push(id) {
    const d = repo.get(id);
    if (!d) return err('not_found', 'directory not found');
    try {
      const result = await git.push(d.path, dirBaseBranch(d));
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
      const out = (await git.statusPorcelain(d.path)).trim();
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
      const ps = await git.pushState(d.path, dirBaseBranch(d), { force: true });
      if (ps.dirty === 0) return ok({ ok: true, committed: false, pushState: ps });
      const msg = (message ? String(message) : '').trim()
        || `multicc: 提交未跟踪改动（${new Date().toISOString().slice(0, 19).replace('T', ' ')}）`;
      await git.stageAll(d.path);
      await git.commit(d.path, msg);
      git.invalidatePushCache(d.path, dirBaseBranch(d));
      const after = await git.pushState(d.path, dirBaseBranch(d), { force: true });
      events.append(d.id, 'committed', `提交 ${after.ahead > ps.ahead ? after.ahead - ps.ahead : ps.dirty} 个未提交改动`);
      return ok({ ok: true, committed: true, pushState: after });
    } catch (error) {
      return err('invalid', error.message);
    }
  }

  return { browseFs, listAnnotated, register, update, remove, push, uncommitted, commitAll };
}

module.exports = { createDirectoryService };
