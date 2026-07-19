'use strict';

const LOADING_MERGE_STATE = Object.freeze({
  mergeReady: false,
  dirty: false,
  ahead: 0,
  behind: 0,
  reason: 'loading',
});

function assertMapLike(value, name, needsValues = false) {
  if (!value || typeof value.get !== 'function' || typeof value.has !== 'function'
      || (needsValues && typeof value.values !== 'function')) {
    throw new TypeError(`[session-git] ${name} must be map-like`);
  }
}

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`[session-git] ${name} must be a function`);
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[session-git] dependencies are required');
  assertMapLike(deps.records, 'records', true);
  assertMapLike(deps.directories, 'directories');
  assertMapLike(deps.terminalSessions, 'terminalSessions');
  assertMapLike(deps.chatSessions, 'chatSessions');
  for (const name of [
    'gitWorktreeMergeState', 'gitBaseBranch', 'gitRunQueued', 'gitMergeBack',
    'gitSyncFromBase', 'gitRebaseResolve', 'appendEvent', 'workspaceBroadcast',
    'existsSync', 'now', 'random',
  ]) assertFunction(deps[name], name);
  if (!deps.logger || typeof deps.logger.log !== 'function'
      || typeof deps.logger.warn !== 'function') {
    throw new TypeError('[session-git] logger must expose log() and warn()');
  }
  return deps;
}

function errorText(error) {
  if (error && error.stderr) return String(error.stderr).slice(0, 400);
  return error && error.message ? error.message : String(error || 'unknown error');
}

function blockedGitResult(error) {
  return {
    ok: false,
    blocked: true,
    reasons: [error && error.code === 'SESSION_ACTIVE' ? 'active' : 'leased'],
    operationId: error && error.operationId,
    queueDepth: error && error.queueDepth,
    error: errorText(error),
  };
}

function createSessionGitRuntime(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const maxDiffBytes = Number.isFinite(deps.maxDiffBytes) && deps.maxDiffBytes > 0
    ? deps.maxDiffBytes
    : 1024 * 1024;
  const cacheTtlMs = Number.isFinite(deps.cacheTtlMs) && deps.cacheTtlMs >= 0
    ? deps.cacheTtlMs
    : 4000;
  const cacheJitterMs = Number.isFinite(deps.cacheJitterMs) && deps.cacheJitterMs >= 0
    ? deps.cacheJitterMs
    : 3000;
  const mergeStateCache = new Map();
  const mergeStatePending = new Map();
  const mountedApps = new WeakSet();

  function mergeStateKey(session) {
    return session && session.id ? session.id : null;
  }

  function rememberMergeState(key, value, jitter = false) {
    if (!key) return value;
    const extra = jitter ? Math.floor(deps.random() * cacheJitterMs) : 0;
    mergeStateCache.set(key, { value, expiry: deps.now() + cacheTtlMs + extra });
    return value;
  }

  function mergeStateCached(dir, session) {
    const key = mergeStateKey(session);
    if (!key) return LOADING_MERGE_STATE;
    const cached = mergeStateCache.get(key);
    if ((!cached || cached.expiry <= deps.now()) && !mergeStatePending.has(key)) {
      const pending = Promise.resolve()
        .then(() => deps.gitWorktreeMergeState(dir, session))
        .then(value => rememberMergeState(key, value, true))
        .catch(() => cached ? cached.value : null)
        .finally(() => mergeStatePending.delete(key));
      mergeStatePending.set(key, pending);
    }
    return cached ? cached.value : LOADING_MERGE_STATE;
  }

  async function mergeStateFresh(dir, session) {
    const value = await deps.gitWorktreeMergeState(dir, session);
    return rememberMergeState(mergeStateKey(session), value);
  }

  function isWorktreeActive(sessionId) {
    if (deps.terminalSessions.has(sessionId)) return true;
    const chat = deps.chatSessions.get(sessionId);
    return !!(chat && (chat.claudeProc || chat.isStreaming));
  }

  function sessionSyncGate(sessionId) {
    if (isWorktreeActive(sessionId)) {
      return {
        state: 'running',
        message: '会话正在执行任务（进程运行中），请等待本轮结束后再同步',
      };
    }
    const persisted = deps.records.get(sessionId);
    const state = persisted && persisted.taskState
      ? persisted.taskState.classifyState || null
      : null;
    if (state === 'C' || state === 'P' || state === 'B') {
      const label = state === 'B' ? '等待后台任务' : (state === 'C' ? '任务待继续' : '处理中');
      return {
        state,
        message: `会话任务未结束（${label}，状态 ${state}），请等待任务完成/暂停后再同步`,
      };
    }
    return null;
  }

  async function autoSyncSiblingWorktrees(dir, exceptId) {
    const out = [];
    for (const session of deps.records.values()) {
      if (session.id === exceptId || session.dirId !== dir.id
          || !session.worktreePath || !session.branch) continue;
      try {
        if (isWorktreeActive(session.id)) {
          out.push({ id: session.id, skipped: true, reason: 'active' });
          deps.appendEvent(dir.id, 'sync_skipped', '自动同步已跳过：会话仍 active', session.id);
          continue;
        }
        const state = await deps.gitWorktreeMergeState(dir, session);
        if (state.dirty) {
          out.push({ id: session.id, skipped: true, reason: 'dirty' });
          deps.appendEvent(dir.id, 'sync_skipped', '自动同步已跳过：worktree 有未提交改动', session.id);
          deps.workspaceBroadcast(dir.id, {
            type: 'merge_status', sessionId: session.id, mergeState: state,
          });
          continue;
        }
        if (state.ahead > 0) {
          out.push({ id: session.id, skipped: true, reason: 'unmerged' });
          deps.appendEvent(dir.id, 'sync_skipped', '自动同步已跳过：worktree 有尚未合回主分支的提交', session.id);
          deps.workspaceBroadcast(dir.id, {
            type: 'merge_status', sessionId: session.id, mergeState: state,
          });
          continue;
        }
        const result = await deps.gitSyncFromBase(dir, session, {
          abortOnConflict: true,
          activeCheck: () => isWorktreeActive(session.id),
        });
        if (result.ok && result.merged) {
          out.push({ id: session.id, commits: result.commits });
          deps.appendEvent(dir.id, 'synced',
            `自动同步 ${result.commits} 个提交（${dir.baseBranch} 合并后）`, session.id);
          deps.workspaceBroadcast(dir.id, {
            type: 'merge_status', sessionId: session.id,
            mergeState: await mergeStateFresh(dir, session),
          });
        } else if (!result.ok && result.conflicts && result.conflicts.length) {
          out.push({ id: session.id, conflict: true, files: result.conflicts });
          deps.appendEvent(dir.id, 'sync_conflict',
            `自动同步遇冲突，需手动处理：${result.conflicts.slice(0, 5).join(', ')}`, session.id);
          deps.workspaceBroadcast(dir.id, {
            type: 'merge_status', sessionId: session.id,
            mergeState: await mergeStateFresh(dir, session),
          });
        }
      } catch (error) {
        deps.logger.warn(`[multicc] auto-sync sibling ${session.id} failed: ${errorText(error)}`);
      }
    }
    if (out.length) {
      deps.logger.log(`[multicc] auto-synced ${out.length} sibling worktree(s) after merge into ${dir.baseBranch}`);
    }
    return out;
  }

  function findSession(req, res) {
    const persisted = deps.records.get(req.params.id);
    if (!persisted) {
      res.status(404).json({ error: 'session not found' });
      return null;
    }
    const dir = deps.directories.get(persisted.dirId);
    if (!dir) {
      res.status(404).json({ error: 'directory not found' });
      return null;
    }
    return { persisted, dir };
  }

  function hasWorktree(record, res, message) {
    if (record.worktreePath && record.branch) return true;
    res.status(400).json({ error: message });
    return false;
  }

  function registerReadRoutes(app) {
    app.get('/api/sessions/:id/merge-status', (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      res.json(mergeStateCached(found.dir, found.persisted));
    });

    app.get('/api/sessions/:id/diff', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!persisted.worktreePath || !deps.existsSync(persisted.worktreePath)) {
        return res.status(400).json({ error: 'worktree missing' });
      }
      const baseBranch = dir.baseBranch || await deps.gitBaseBranch(dir.path);
      const worktree = persisted.worktreePath;
      let diff = '';
      let stat = '';
      let truncated = false;
      let error = null;
      try {
        diff = await deps.gitRunQueued(worktree, ['diff', '--no-color', baseBranch], {
          maxBuffer: maxDiffBytes + 16 * 1024,
        });
        if (diff.length > maxDiffBytes) {
          diff = diff.slice(0, maxDiffBytes);
          truncated = true;
        }
      } catch (cause) {
        if (cause && cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          truncated = true;
          diff = '(diff exceeds 1MB cap — too large to display in browser)';
        } else {
          error = errorText(cause);
        }
      }
      try {
        stat = await deps.gitRunQueued(worktree, ['diff', '--stat', '--no-color', baseBranch], {
          maxBuffer: 256 * 1024,
        });
      } catch (_) { /* stat remains best-effort */ }
      return res.json({
        baseBranch,
        branch: persisted.branch,
        stat,
        diff,
        truncated,
        mergeState: mergeStateCached(dir, persisted),
        error,
      });
    });

    app.get('/api/git/log', async (req, res) => {
      const dirId = req.query.dirId;
      const sessionId = req.query.sessionId;
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
      const allBranches = req.query.all === '1';
      let repoPath;
      if (sessionId) {
        const persisted = deps.records.get(sessionId);
        if (!persisted || !persisted.worktreePath) {
          return res.status(404).json({ error: 'session or worktree not found' });
        }
        repoPath = persisted.worktreePath;
      } else if (dirId) {
        const dir = deps.directories.get(dirId);
        if (!dir) return res.status(404).json({ error: 'directory not found' });
        repoPath = dir.path;
      } else {
        return res.status(400).json({ error: 'dirId or sessionId required' });
      }
      if (!deps.existsSync(repoPath)) return res.status(404).json({ error: 'repo path missing' });
      const args = ['log', `-${limit}`, '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D', '--no-color'];
      if (allBranches) args.push('--all');
      try {
        const raw = await deps.gitRunQueued(repoPath, args, { maxBuffer: 512 * 1024 });
        const commits = raw.trim().split('\n').filter(Boolean).map(line => {
          const [hash, short, author, date, subject, refs] = line.split('\x00');
          return {
            hash, short, author, date, subject,
            refs: refs ? refs.replace(/^,\s*/, '').trim() : '',
          };
        });
        return res.json({ commits, repoPath });
      } catch (error) {
        return res.status(500).json({ error: errorText(error) });
      }
    });
  }

  function registerWriteRoutes(app) {
    app.post('/api/sessions/:id/merge', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!hasWorktree(persisted, res, '该会话没有 worktree，无需合并')) return;
      const result = await deps.gitMergeBack(dir, persisted);
      if (!result.ok) {
        return res.status(result.conflicts && result.conflicts.length ? 409 : 400).json(result);
      }
      deps.logger.log(`[multicc] merge ${persisted.branch} → ${dir.baseBranch}: `
        + (result.merged ? `${result.commits} commit(s)` : 'nothing to merge'));
      deps.appendEvent(dir.id, 'merged',
        result.merged ? `${result.commits} 个提交 → ${dir.baseBranch}` : '无新提交', persisted.id);
      deps.workspaceBroadcast(dir.id, {
        type: 'merge_status', sessionId: persisted.id,
        mergeState: await mergeStateFresh(dir, persisted),
      });
      if (result.merged) {
        const synced = await autoSyncSiblingWorktrees(dir, persisted.id);
        if (synced.length) result.siblingsSynced = synced;
      }
      return res.json(result);
    });

    app.post('/api/sessions/:id/sync', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!hasWorktree(persisted, res, '该会话没有 worktree，无需同步')) return;
      const force = req.query.force === '1' || (req.body && req.body.force === true);
      if (!force) {
        const gate = sessionSyncGate(persisted.id);
        if (gate) {
          return res.status(409).json({
            ok: false,
            blocked: true,
            reasons: ['busy'],
            classifyState: gate.state,
            error: gate.message,
          });
        }
      }
      const result = await deps.gitSyncFromBase(dir, persisted, {
        force,
        activeCheck: force ? null : () => isWorktreeActive(persisted.id),
      }).catch(blockedGitResult);
      if (!result.ok) {
        if (result.conflicts && result.conflicts.length) {
          deps.appendEvent(dir.id, 'sync_conflict',
            `同步 rebase 冲突，需手动解决：${result.conflicts.slice(0, 5).join(', ')}`, persisted.id);
          deps.workspaceBroadcast(dir.id, {
            type: 'merge_status', sessionId: persisted.id,
            mergeState: await mergeStateFresh(dir, persisted),
          });
        }
        return res.status(result.conflicts && result.conflicts.length ? 409 : 400).json(result);
      }
      deps.logger.log(`[multicc] sync ${dir.baseBranch} → ${persisted.branch}: `
        + (result.merged ? `${result.commits} commit(s)` : 'already up to date'));
      deps.appendEvent(dir.id, 'synced',
        result.merged ? `从 ${result.baseBranch} 同步 ${result.commits} 个提交` : '已是最新', persisted.id);
      deps.workspaceBroadcast(dir.id, {
        type: 'merge_status', sessionId: persisted.id,
        mergeState: await mergeStateFresh(dir, persisted),
      });
      return res.json(result);
    });

    app.post('/api/sessions/:id/rebase', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!hasWorktree(persisted, res, '该会话没有 worktree')) return;
      const action = req.body && req.body.action === 'abort' ? 'abort' : 'continue';
      const force = req.query.force === '1' || (req.body && req.body.force === true);
      const result = await deps.gitRebaseResolve(dir, persisted, action, {
        activeCheck: force ? null : () => isWorktreeActive(persisted.id),
      }).catch(blockedGitResult);
      deps.workspaceBroadcast(dir.id, {
        type: 'merge_status', sessionId: persisted.id,
        mergeState: await mergeStateFresh(dir, persisted),
      });
      if (!result.ok) {
        return res.status(result.conflicts && result.conflicts.length ? 409 : 400).json(result);
      }
      deps.appendEvent(dir.id, 'synced',
        result.aborted ? 'rebase 已放弃，worktree 回到同步前状态'
          : (result.done ? 'rebase 冲突已解决并完成同步' : 'rebase 已继续'), persisted.id);
      return res.json(result);
    });
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('[session-git] app must expose get() and post()');
    }
    if (mountedApps.has(app)) return app;
    registerReadRoutes(app);
    registerWriteRoutes(app);
    mountedApps.add(app);
    return app;
  }

  return Object.freeze({
    mountRoutes,
    mergeStateCached,
    isWorktreeActive,
  });
}

module.exports = Object.freeze({ createSessionGitRuntime, LOADING_MERGE_STATE });
