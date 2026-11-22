'use strict';

const path = require('path');
const { getNative } = require('../native/runtime');

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
    'existsSync', 'now', 'random', 'asyncHandler', 'readFile',
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

function parseCommitFiles(raw) {
  const parts = String(raw || '').replace(/^\0+/, '').split('\0');
  const files = [];
  for (let i = 0; i < parts.length - 1;) {
    const status = parts[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) break;
    const oldPath = parts[i++];
    if (!oldPath) break;
    const renamed = status[0] === 'R' || status[0] === 'C';
    const path = renamed ? parts[i++] : oldPath;
    if (!path) break;
    files.push({ status, path, ...(renamed ? { oldPath } : {}) });
  }
  return files;
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

function failedGitResult(error) {
  if (error && ['SESSION_ACTIVE', 'SESSION_LEASED'].includes(error.code)) {
    return blockedGitResult(error);
  }
  return {
    ok: false,
    code: 'git_operation_failed',
    operationId: error && error.operationId,
    queueDepth: error && error.queueDepth,
    error: 'Git operation failed',
  };
}

// Parse `git diff --numstat -z` and `git diff --name-status -z` output into a
// unified file list. numstat is the primary table (additions/deletions/path);
// name-status supplies the status code and oldPath for renames.
function parseDiffFiles(numstatZ, nameStatusZ) {
  const numstatTokens = String(numstatZ || '').split('\0');
  const files = [];
  let i = 0;
  while (i < numstatTokens.length) {
    const token = numstatTokens[i];
    if (token === '') { i += 1; continue; }
    const parts = token.split('\t');
    if (parts.length < 2) { i += 1; continue; }
    const addStr = parts[0];
    const delStr = parts[1];
    const pathField = parts.slice(2).join('\t');
    const numeric = value => (value === '-' ? 0 : (parseInt(value, 10) || 0));
    const binary = addStr === '-' || delStr === '-';
    if (pathField !== '') {
      files.push({
        path: pathField,
        additions: numeric(addStr),
        deletions: numeric(delStr),
        binary,
      });
      i += 1;
    } else {
      // Rename: path field is empty, next two NUL tokens are old and new.
      const oldPath = numstatTokens[i + 1] || '';
      const newPath = numstatTokens[i + 2] || '';
      files.push({
        path: newPath,
        additions: numeric(addStr),
        deletions: numeric(delStr),
        binary,
      });
      i += 3;
    }
  }

  const statusMap = new Map();
  const nsTokens = String(nameStatusZ || '').split('\0');
  let j = 0;
  while (j < nsTokens.length) {
    const token = nsTokens[j];
    if (token === '') { j += 1; continue; }
    const firstChar = token.charAt(0);
    if (firstChar === 'R' || firstChar === 'C') {
      const oldPath = nsTokens[j + 1] || '';
      const newPath = nsTokens[j + 2] || '';
      statusMap.set(newPath, { status: firstChar, oldPath });
      j += 3;
    } else {
      const filePath = nsTokens[j + 1] || '';
      statusMap.set(filePath, { status: firstChar, oldPath: null });
      j += 2;
    }
  }

  return files.map(file => {
    const statusInfo = statusMap.get(file.path);
    const status = statusInfo ? statusInfo.status : 'M';
    const oldPath = statusInfo && statusInfo.oldPath != null ? statusInfo.oldPath : null;
    return {
      path: file.path,
      oldPath,
      status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    };
  });
}

// Untracked files are invisible to `git diff <base>`: git only reports the
// working-tree diff for files already in the index. But merge runs `git add -A`
// before committing, so a brand-new file IS part of what merge will land —
// hiding it from the diff UI lets the user approve a merge that quietly adds
// files they never saw. Collect them from `git ls-files --others` instead.
async function listUntrackedFiles(execGit, worktree, maxBytes = 4 * 1024 * 1024) {
  try {
    const raw = await execGit(worktree,
      ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'],
      { maxBuffer: maxBytes });
    return String(raw || '').split('\0').filter(Boolean);
  } catch (_) {
    return [];
  }
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

// Line count of a text buffer, matching git's numstat convention (a file
// without a trailing newline still counts its final line).
function countTextLines(buffer) {
  const text = buffer.toString('utf8');
  if (text.length === 0) return 0;
  const newlines = (text.match(/\n/g) || []).length;
  return newlines + (text.endsWith('\n') ? 0 : 1);
}

async function untrackedFileFacts(readFile, worktree, relative) {
  try {
    const buffer = await readFile(path.join(worktree, relative));
    const binary = isProbablyBinary(buffer);
    return { additions: binary ? 0 : countTextLines(buffer), binary };
  } catch (_) {
    return { additions: 0, binary: false };
  }
}

function createSessionGitRuntime(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const maxDiffBytes = Number.isFinite(deps.maxDiffBytes) && deps.maxDiffBytes > 0
    ? deps.maxDiffBytes
    : 1024 * 1024;
  const cacheTtlMs = Number.isFinite(deps.cacheTtlMs) && deps.cacheTtlMs >= 0
    ? deps.cacheTtlMs
    : 30_000;
  const cacheJitterMs = Number.isFinite(deps.cacheJitterMs) && deps.cacheJitterMs >= 0
    ? deps.cacheJitterMs
    : 30_000;
  const maxRefreshConcurrency = Number.isSafeInteger(deps.maxRefreshConcurrency)
      && deps.maxRefreshConcurrency > 0
    ? deps.maxRefreshConcurrency
    : 2;
  const mergeStateCache = new Map();
  const mergeStatePending = new Map();
  const mergeStateQueue = [];
  const activeMergeStateDirectories = new Set();
  let activeMergeStateRefreshes = 0;
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

  function mergeStateDirectoryKey(dir) {
    return dir?.id || dir?.path || '__unknown_directory__';
  }

  function pumpMergeStateQueue() {
    while (activeMergeStateRefreshes < maxRefreshConcurrency && mergeStateQueue.length > 0) {
      // A repository actor serializes Git commands within one Fleet anyway.
      // Do not let two waiting jobs from it occupy both global refresh slots.
      const index = mergeStateQueue.findIndex(candidate => (
        !activeMergeStateDirectories.has(candidate.directoryKey)
      ));
      if (index < 0) return;
      const [job] = mergeStateQueue.splice(index, 1);
      activeMergeStateRefreshes += 1;
      activeMergeStateDirectories.add(job.directoryKey);
      Promise.resolve()
        .then(() => {
          const current = mergeStateCache.get(job.key);
          // An explicit refresh may have made this queued sweep redundant.
          if (current && current.expiry > deps.now()) return current.value;
          if (!deps.records.has(job.key)) return current ? current.value : null;
          return Promise.resolve(deps.gitWorktreeMergeState(job.dir, job.session))
            .then(value => rememberMergeState(job.key, value, true));
        })
        .catch(() => {
          const current = mergeStateCache.get(job.key);
          return current ? current.value : null;
        })
        .finally(() => {
          if (mergeStatePending.get(job.key) === job.pending) {
            mergeStatePending.delete(job.key);
          }
          activeMergeStateRefreshes -= 1;
          activeMergeStateDirectories.delete(job.directoryKey);
          job.resolve();
          pumpMergeStateQueue();
        });
    }
  }

  function scheduleMergeStateRefresh(dir, session, key) {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const job = {
      dir,
      session,
      key,
      pending,
      resolve,
      directoryKey: mergeStateDirectoryKey(dir),
    };
    mergeStatePending.set(key, pending);
    mergeStateQueue.push(job);
    pumpMergeStateQueue();
  }

  function prioritizeMergeStateRefresh(key) {
    const index = mergeStateQueue.findIndex(job => job.key === key);
    if (index <= 0) return;
    const [job] = mergeStateQueue.splice(index, 1);
    mergeStateQueue.unshift(job);
  }

  function mergeStateCached(dir, session, { priority = false } = {}) {
    const key = mergeStateKey(session);
    if (!key) return LOADING_MERGE_STATE;
    const cached = mergeStateCache.get(key);
    if ((!cached || cached.expiry <= deps.now()) && !mergeStatePending.has(key)) {
      scheduleMergeStateRefresh(dir, session, key);
    } else if (priority && mergeStatePending.has(key)) {
      prioritizeMergeStateRefresh(key);
    }
    return cached ? cached.value : LOADING_MERGE_STATE;
  }

  async function mergeStateFresh(dir, session) {
    const value = await deps.gitWorktreeMergeState(dir, session);
    return rememberMergeState(mergeStateKey(session), value);
  }

  // 「这个工作树上有活的东西吗」：判定只有一处（native/core/src/active_turns.rs）。
  // 这里曾经对同一个会话给出两种答案 —— 作为同组 member 看时读 `_activeRunner`，
  // 作为被请求的那个 id 看时只读 claudeProc/isStreaming。
  function isWorktreeActive(sessionId) {
    if (deps.terminalSessions.has(sessionId)) return true;
    const owner = deps.records.get(sessionId)?.workspaceOwnerSessionId || sessionId;
    for (const member of deps.records.values()) {
      if (member.id === sessionId || (member.workspaceOwnerSessionId || member.id) !== owner) continue;
      const state = deps.chatSessions.get(member.id);
      if (deps.terminalSessions.has(member.id) || getNative().sessionRuntimeIsChatStateBusy(state)) return true;
    }
    return getNative().sessionRuntimeIsChatStateBusy(deps.chatSessions.get(sessionId));
  }

  async function autoSyncSiblingWorktrees(dir, exceptId) {
    const out = [];
    for (const session of deps.records.values()) {
      if (session.id === exceptId || session.dirId !== dir.id
          || session.workspaceOwnerSessionId || !session.worktreePath || !session.branch
          || !deps.existsSync(session.worktreePath)) continue;
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

  // Shared commit → merge → broadcast flow behind the manual merge route and
  // the turn-end auto-commit. Returns the gitMergeBack result; when the merge
  // landed, siblingsSynced is attached after the sibling fast-forward sweep.
  async function executeMergeBack(dir, identity, { taskId = null, origin = 'manual' } = {}) {
    const result = await deps.gitMergeBack(dir, identity).catch(error => {
      deps.logger.warn(`[multicc] merge ${identity.id} failed: ${errorText(error)}`);
      return failedGitResult(error);
    });
    if (!result.ok) return result;
    deps.logger.log(`[multicc] ${origin === 'auto' ? 'auto-commit merge' : 'merge'} ${identity.branch} → ${dir.baseBranch}: `
      + (result.merged ? `${result.commits} commit(s)` : 'nothing to merge'));
    deps.appendEvent(dir.id, 'merged',
      result.merged ? `${result.commits} 个提交 → ${dir.baseBranch}` : '无新提交', identity.id);
    deps.workspaceBroadcast(dir.id, {
      type: 'merge_status', sessionId: identity.id, ...(taskId ? { taskId } : {}),
      mergeState: await mergeStateFresh(dir, identity),
    });
    if (result.merged) {
      const synced = await autoSyncSiblingWorktrees(dir, identity.id);
      if (synced.length) result.siblingsSynced = synced;
    }
    return result;
  }

  // Turn-end auto-commit. The per-turn checkbox under the last user message is
  // gone: the session-level switch (autoCommit !== false) is the only gate.
  // The chat turn engine calls this from its complete-session-turn effect, so
  // the merge runs even when no chat page is connected — the page used to be
  // the trigger, and turns that ended offline were never merged nor caught up.
  const autoCommitInflight = new Set();
  // A blocked merge used to be dropped silently, which looked exactly like
  // "the switch is on but nothing happened". Spell the reason out instead.
  function autoCommitBlockedMessage(result, baseBranch) {
    const reasons = result.reasons || [];
    const base = baseBranch || '基分支';
    if (reasons.includes('base-dirty')) {
      const files = result.dirtyFiles || [];
      const shown = files.slice(0, 8).join(', ');
      const more = files.length > 8 ? ` 等 ${files.length} 个` : '';
      return `⚠️ 自动提交未合并：主仓库（${base}）工作区有未提交改动，为免覆盖已暂停合并。`
        + `请先在主仓库提交或清理${files.length ? `：${shown}${more}` : ''}；处理后下一轮结束会自动重试。`;
    }
    if (reasons.includes('base-not-checked-out')) {
      return `⚠️ 自动提交未合并：主仓库当前没有切在 ${base} 分支上。请切回 ${base} 后，下一轮结束会自动重试。`;
    }
    if (reasons.includes('busy') || reasons.includes('leased') || reasons.includes('active')) {
      return '⚠️ 自动提交未合并：工作区正被其他 git 操作占用，下一轮结束会自动重试。';
    }
    return `⚠️ 自动提交未合并：${reasons.join(', ') || result.error || '未知原因'}`;
  }
  async function autoCommitTurn(sessionId) {
    const requested = deps.records.get(sessionId);
    const identity = requested?.workspaceOwnerSessionId
      ? deps.records.get(requested.workspaceOwnerSessionId) : requested;
    if (!identity) return { ok: false, skipped: true, reason: 'session_not_found' };
    if (identity.autoCommit === false) return { ok: false, skipped: true, reason: 'auto_commit_off' };
    if (!identity.worktreePath || !identity.branch || !deps.existsSync(identity.worktreePath)) {
      return { ok: false, skipped: true, reason: 'no_worktree' };
    }
    if (identity.workspaceState === 'hibernated') {
      return { ok: false, skipped: true, reason: 'hibernated' };
    }
    const dir = deps.directories.get(identity.dirId);
    if (!dir) return { ok: false, skipped: true, reason: 'directory_not_found' };
    if (autoCommitInflight.has(identity.id)) return { ok: false, skipped: true, reason: 'inflight' };
    autoCommitInflight.add(identity.id);
    try {
      // A turn just wrote the worktree; the cached poll value is stale. One
      // authoritative read decides both whether to act and whether to stay
      // silent (a clean worktree commits nothing and says nothing).
      const state = await mergeStateFresh(dir, identity);
      if (!state || state.mergeReady !== true) {
        return { ok: true, merged: false, skipped: true, reason: 'nothing_to_merge' };
      }
      const result = await executeMergeBack(dir, identity, { origin: 'auto' });
      if (result.blocked) {
        deps.logger.warn(`[multicc] auto-commit merge ${identity.id} blocked: ${(result.reasons || []).join(', ') || result.error || 'unknown'}`);
      }
      if (typeof deps.chatBroadcast === 'function') {
        if (result.blocked) {
          deps.chatBroadcast(identity.id, { type: 'system', subtype: 'auto_commit',
            message: autoCommitBlockedMessage(result, dir.baseBranch) });
        } else if (result.ok && result.merged) {
          deps.chatBroadcast(identity.id, { type: 'system', subtype: 'auto_commit',
            message: `✓ 自动提交完成：已合并 ${result.commits} 个提交回基分支${result.committed ? '（含本次自动提交）' : ''}` });
        } else if (result.ok) {
          deps.chatBroadcast(identity.id, { type: 'system', subtype: 'auto_commit',
            message: '✓ 自动提交：没有新提交需要合并' });
        } else if (result.conflicts && result.conflicts.length) {
          deps.chatBroadcast(identity.id, { type: 'system', subtype: 'auto_commit',
            message: `⚠️ 自动提交冲突：请先手动合并。冲突文件：${result.conflicts.join(', ')}` });
        } else if (!result.ok) {
          deps.chatBroadcast(identity.id, { type: 'system', subtype: 'auto_commit',
            message: `自动提交失败：${result.error || 'unknown'}` });
        }
      }
      return result;
    } catch (error) {
      deps.logger.warn(`[multicc] auto-commit merge ${identity.id} failed: ${errorText(error)}`);
      return failedGitResult(error);
    } finally {
      autoCommitInflight.delete(identity.id);
    }
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('[session-git] app must expose get() and post()');
    }
    if (mountedApps.has(app)) return app;
    // 16 条公开路由已由 Rust 前门独占（native/gateway/src/app/session_git.rs）。
    // 这里只剩前门回调的宿主端口：git 子进程（repo actor）、会话表、merge-state
    // 缓存与真正执行 merge/sync/rebase/cleanup 的 git 事务及广播。
    require('./session-git-host').mountSessionGitHostRoute(app, {
      records: deps.records,
      directories: deps.directories,
      existsSync: deps.existsSync,
      readFile: deps.readFile,
      gitRunQueued: deps.gitRunQueued,
      gitBaseBranch: deps.gitBaseBranch,
      mergeStateCached,
      mergeStateFresh,
      isWorktreeActive,
      executeMergeBack,
      autoSyncSiblingWorktrees,
      appendEvent: deps.appendEvent,
      workspaceBroadcast: deps.workspaceBroadcast,
      gitMergeBack: deps.gitMergeBack,
      gitSyncFromBase: deps.gitSyncFromBase,
      gitRebaseResolve: deps.gitRebaseResolve,
      resolveTaskWorktree: typeof deps.resolveTaskWorktree === 'function'
        ? deps.resolveTaskWorktree : () => null,
      cleanupTaskWorktree: typeof deps.cleanupTaskWorktree === 'function'
        ? deps.cleanupTaskWorktree : () => null,
      untrackedFileFacts,
      isProbablyBinary,
      errorText,
      logger: deps.logger,
      ...(typeof deps.isLocalRequest === 'function' ? { isLocal: deps.isLocalRequest } : {}),
    });
    mountedApps.add(app);
    return app;
  }

  return Object.freeze({
    mountRoutes,
    mergeStateCached,
    isWorktreeActive,
    autoCommitTurn,
  });
}

module.exports = Object.freeze({ createSessionGitRuntime, LOADING_MERGE_STATE, parseDiffFiles, parseCommitFiles });
