'use strict';

const path = require('path');
const {
  classifyDisplay, isProcessingLetter, isBackgroundLetter,
} = require('../classify/vocab');
const { isChatStateBusy } = require('../session/runtime-busy');

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

// A git invocation whose captured output exceeded the Node maxBuffer cap. Such
// failures must surface as a truncated placeholder, not a hard error, so the
// caller (commit-diff / diff routes) mirrors the sibling route's behaviour.
function isMaxBuffer(cause) {
  return !!(cause && cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
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

  // 「这个工作树上有活的东西吗」：判定只有一处（src/session/runtime-busy.js）。
  // 这里曾经对同一个会话给出两种答案 —— 作为同组 member 看时读 `_activeRunner`，
  // 作为被请求的那个 id 看时只读 claudeProc/isStreaming。
  function isWorktreeActive(sessionId) {
    if (deps.terminalSessions.has(sessionId)) return true;
    const owner = deps.records.get(sessionId)?.workspaceOwnerSessionId || sessionId;
    for (const member of deps.records.values()) {
      if (member.id === sessionId || (member.workspaceOwnerSessionId || member.id) !== owner) continue;
      const state = deps.chatSessions.get(member.id);
      if (deps.terminalSessions.has(member.id) || isChatStateBusy(state)) return true;
    }
    return isChatStateBusy(deps.chatSessions.get(sessionId));
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
    // "Unfinished" = a turn that is still writing into this worktree, or may
    // still write: P (and the retired C, which only an older snapshot still
    // carries) is a turn in flight, and B is a turn that ended parked on a
    // background job. W is deliberately NOT unfinished — the turn is over, no
    // process is running (isWorktreeActive above already checked), and the user
    // is the one asking for the sync, so refusing them would be a dead end.
    // D/E ended too.
    //
    // Reconcile with src/workspace/inventory.js, whose `execution_dependency`
    // reason DOES include W: that surface is a read-only adoption/reclaim
    // preview where a session holding an unanswered question is conservative
    // evidence against touching the workspace. This gate refuses a user command,
    // so it only refuses while something can still write.
    if (isProcessingLetter(state) || isBackgroundLetter(state)) {
      // One word per letter, from the classify vocabulary: a re-lettered B must
      // not leave a hand-written label behind here.
      const label = classifyDisplay(state).label;
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

  function findSession(req, res) {
    const requested = deps.records.get(req.params.id);
    const persisted = requested?.workspaceOwnerSessionId ? deps.records.get(requested.workspaceOwnerSessionId) : requested;
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
    if (record.worktreePath && record.branch && deps.existsSync(record.worktreePath)) return true;
    if (record.workspaceState === 'hibernated') {
      res.status(409).json({
        ok: false,
        blocked: true,
        code: 'workspace_hibernated',
        reasons: ['hibernated'],
        workspaceState: 'hibernated',
        error: '工作区已休眠；发送消息后会自动恢复',
      });
      return false;
    }
    res.status(400).json({ error: message });
    return false;
  }

  function registerReadRoutes(app) {
    app.get('/api/sessions/:id/merge-status', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      if (req.query?.refresh === '1' || req.query?.fresh === '1') {
        res.json(await mergeStateFresh(found.dir, found.persisted));
        return;
      }
      res.json(mergeStateCached(found.dir, found.persisted, { priority: true }));
    });

    app.get('/api/sessions/:id/diff', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!persisted.worktreePath || !deps.existsSync(persisted.worktreePath)) {
        return res.status(400).json({ error: 'worktree missing' });
      }
      let baseBranch = dir.baseBranch;
      if (!baseBranch) {
        try {
          baseBranch = await deps.gitBaseBranch(dir.path);
        } catch (cause) {
          return res.status(500).json({ error: errorText(cause) });
        }
      }
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
        if (isMaxBuffer(cause)) {
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

    app.get('/api/sessions/:id/diff/files', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!persisted.worktreePath || !deps.existsSync(persisted.worktreePath)) {
        return res.status(400).json({ error: 'worktree missing' });
      }
      let baseBranch = dir.baseBranch;
      if (!baseBranch) {
        try {
          baseBranch = await deps.gitBaseBranch(dir.path);
        } catch (cause) {
          return res.status(500).json({ error: errorText(cause) });
        }
      }
      const worktree = persisted.worktreePath;
      let numstat = '';
      let nameStatus = '';
      let error = null;
      try {
        numstat = await deps.gitRunQueued(worktree,
          ['-c', 'core.quotepath=false', 'diff', '--numstat', '--no-color', '-z', baseBranch],
          { maxBuffer: 4 * 1024 * 1024 });
      } catch (cause) {
        error = errorText(cause);
      }
      try {
        nameStatus = await deps.gitRunQueued(worktree,
          ['-c', 'core.quotepath=false', 'diff', '--name-status', '--no-color', '-z', baseBranch],
          { maxBuffer: 1024 * 1024 });
      } catch (cause) {
        if (!error) error = errorText(cause);
      }
      const trackedFiles = error ? [] : parseDiffFiles(numstat, nameStatus);
      // New (untracked) files never appear in `git diff <base>`, yet merge's
      // `git add -A` would land them. Surface them as status 'U' so the merge
      // preview is honest about what will be committed.
      const fileCap = 500;
      let untrackedFiles = [];
      try {
        const untrackedPaths = await listUntrackedFiles(deps.gitRunQueued, worktree);
        for (const relative of untrackedPaths.slice(0, fileCap)) {
          const facts = await untrackedFileFacts(deps.readFile, worktree, relative);
          untrackedFiles.push({
            path: relative,
            oldPath: null,
            status: 'U',
            additions: facts.additions,
            deletions: 0,
            binary: facts.binary,
          });
        }
      } catch (_) { /* untracked list stays empty on failure */ }
      const allFiles = [...trackedFiles, ...untrackedFiles];
      const untrackedCount = untrackedFiles.length;
      const totalFiles = allFiles.length;
      const totalAdditions = allFiles.reduce((sum, f) => sum + f.additions, 0);
      const totalDeletions = allFiles.reduce((sum, f) => sum + f.deletions, 0);
      const truncated = totalFiles > fileCap;
      const files = truncated ? allFiles.slice(0, fileCap) : allFiles;
      return res.json({
        baseBranch,
        branch: persisted.branch,
        files,
        totalFiles,
        totalAdditions,
        totalDeletions,
        untrackedCount,
        truncated,
        mergeState: mergeStateCached(dir, persisted),
        error,
      });
    });

    app.get('/api/sessions/:id/diff/file', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!persisted.worktreePath || !deps.existsSync(persisted.worktreePath)) {
        return res.status(400).json({ error: 'worktree missing' });
      }
      const filePath = req.query.path;
      if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 500) {
        return res.status(400).json({ error: 'path required (1..500 chars)' });
      }
      if (filePath.startsWith('-')) {
        return res.status(400).json({ error: 'path must not start with "-"' });
      }
      let baseBranch = dir.baseBranch;
      if (!baseBranch) {
        try {
          baseBranch = await deps.gitBaseBranch(dir.path);
        } catch (cause) {
          return res.status(500).json({ error: errorText(cause) });
        }
      }
      const worktree = persisted.worktreePath;
      const patchCap = 256 * 1024;
      let patch = '';
      let truncated = false;
      let error = null;
      let untracked = false;
      try {
        patch = await deps.gitRunQueued(worktree,
          ['diff', '--no-color', baseBranch, '--', filePath],
          { maxBuffer: 512 * 1024 + 16 * 1024 });
        if (patch.length > patchCap) {
          patch = patch.slice(0, patchCap);
          truncated = true;
        }
      } catch (cause) {
        error = errorText(cause);
        patch = '';
      }
      if (!patch && !error) {
        // An empty patch here means either "no change" or "untracked file" —
        // git diff cannot see files that are not in the index. Check the
        // untracked list so a brand-new file still renders in the viewer.
        const untrackedPaths = await listUntrackedFiles(deps.gitRunQueued, worktree);
        if (untrackedPaths.includes(filePath)) {
          untracked = true;
          const buffer = await deps.readFile(path.join(worktree, filePath)).catch(() => null);
          if (buffer) {
            const binary = isProbablyBinary(buffer);
            if (binary) {
              patch = `Binary files /dev/null and b/${filePath} differ`;
            } else {
              const lines = buffer.toString('utf8').split(/\r?\n/);
              if (lines.length && lines[lines.length - 1] === '') lines.pop();
              patch = [
                `diff --git a/${filePath} b/${filePath}`,
                'new file mode 100644',
                'index 0000000..0000000',
                '--- /dev/null',
                `+++ b/${filePath}`,
                `@@ -0,0 +1,${lines.length} @@`,
                ...lines.map(line => `+${line}`),
              ].join('\n');
              if (patch.length > patchCap) {
                patch = patch.slice(0, patchCap);
                truncated = true;
              }
            }
          }
        }
      }
      return res.json({
        path: filePath,
        patch,
        truncated,
        error,
        untracked,
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

    app.get('/api/git/commit-files', async (req, res) => {
      const { dirId, sessionId, hash } = req.query;
      const persisted = sessionId ? deps.records.get(sessionId) : null;
      const dir = dirId ? deps.directories.get(dirId) : null;
      const repoPath = sessionId ? persisted?.worktreePath : dir?.path;
      if (!repoPath || !deps.existsSync(repoPath)) return res.status(404).json({ error: 'repo not found' });
      if (typeof hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(hash)) {
        return res.status(400).json({ error: 'invalid hash' });
      }
      try {
        const raw = await deps.gitRunQueued(repoPath,
          ['show', '--format=', '--name-status', '-z', '--root', '--first-parent', '--no-color', hash],
          { maxBuffer: 1024 * 1024 });
        return res.json({ hash, files: parseCommitFiles(raw) });
      } catch (error) {
        return res.status(500).json({ error: errorText(error) });
      }
    });

    app.get('/api/git/commit-diff', async (req, res) => {
      // Same repo resolution as /api/git/log: a directory repo by dirId, or a
      // session's own worktree by sessionId (the mobile git-history view reads
      // commits from the session worktree, so its diffs must resolve there
      // too - not to the directory's checked-out base branch).
      const dirId = req.query.dirId;
      const sessionId = req.query.sessionId;
      let repoPath;
      if (dirId) {
        const dir = deps.directories.get(dirId);
        if (!dir) return res.status(404).json({ error: 'directory not found' });
        repoPath = dir.path;
      } else if (sessionId) {
        const persisted = deps.records.get(sessionId);
        if (!persisted || !persisted.worktreePath) {
          return res.status(404).json({ error: 'session or worktree not found' });
        }
        repoPath = persisted.worktreePath;
      } else {
        return res.status(404).json({ error: 'directory not found' });
      }
      if (!deps.existsSync(repoPath)) return res.status(404).json({ error: 'repo path missing' });
      const hash = req.query.hash;
      if (typeof hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(hash)) {
        return res.status(400).json({ error: 'invalid hash' });
      }
      const filePath = req.query.file;
      if (filePath !== undefined) {
        if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) {
          return res.status(400).json({ error: 'invalid file' });
        }
        try {
          const raw = await deps.gitRunQueued(repoPath,
            ['show', '--format=', '--name-status', '-z', '--root', '--first-parent', '--no-color', hash],
            { maxBuffer: 1024 * 1024 });
          const changed = parseCommitFiles(raw).find(file => file.path === filePath);
          if (!changed) return res.status(404).json({ error: 'file not found in commit' });
          const paths = changed.oldPath ? [changed.oldPath, changed.path] : [changed.path];
          const diff = await deps.gitRunQueued(repoPath,
            ['show', '--format=', '--patch', '--root', '--first-parent', '--no-color',
              '--no-ext-diff', '--no-textconv', hash, '--', ...paths.map(path => `:(literal)${path}`)],
            { maxBuffer: maxDiffBytes + 16384 });
          return res.json({ hash, path: filePath, stat: '',
            diff: diff.slice(0, maxDiffBytes), truncated: diff.length > maxDiffBytes, error: null });
        } catch (error) {
          if (isMaxBuffer(error)) return res.json({ hash, path: filePath, stat: '', diff: '', truncated: true, error: null });
          return res.status(500).json({ error: errorText(error) });
        }
      }
      let diff = '';
      let truncated = false;
      let error = null;
      try {
        diff = await deps.gitRunQueued(repoPath, ['show', '--format=', '--patch', hash], {
          maxBuffer: maxDiffBytes + 16384,
        });
      } catch (cause) {
        if (isMaxBuffer(cause)) {
          truncated = true;
          diff = '(diff exceeds 1MB cap — too large to display in browser)';
        } else {
          error = errorText(cause);
        }
      }
      if (!diff) {
        // Empty show patch (common for merge commits) or a thrown error: fall
        // back to an explicit parent->commit range diff. Root commits have no
        // parent, so verify hash~1 resolves first and return a clean empty
        // diff instead of a fatal "bad revision" error.
        let hasParent = true;
        try {
          await deps.gitRunQueued(repoPath, ['rev-parse', '--verify', '--quiet', hash + '~1'], {
            maxBuffer: 4096,
          });
        } catch (_) {
          hasParent = false;
        }
        if (hasParent) {
          try {
            diff = await deps.gitRunQueued(repoPath, ['diff', '--patch', hash + '~1', hash], {
              maxBuffer: maxDiffBytes + 16384,
            });
          } catch (cause) {
            if (isMaxBuffer(cause)) {
              truncated = true;
              diff = '(diff exceeds 1MB cap — too large to display in browser)';
            } else {
              error = errorText(cause);
            }
          }
          if (diff) error = null;
        }
      }
      if (diff.length > maxDiffBytes) {
        diff = diff.slice(0, maxDiffBytes);
        truncated = true;
      }
      let stat = '';
      try {
        stat = await deps.gitRunQueued(repoPath, ['show', '--format=', '--stat', hash], {
          maxBuffer: 256 * 1024,
        });
      } catch (_) { stat = ''; }
      return res.json({ hash, stat, diff, truncated, error: error || null });
    });

    // Directory-level git health for the Air directory home: what the main
    // checkout itself looks like — commits not pushed, and files changed
    // outside any session worktree. Session worktrees each have merge-status;
    // the checkout they all merge into had nothing watching it.
    app.get('/api/git/directory-status', async (req, res) => {
      const dirId = req.query.dirId;
      if (!dirId || typeof dirId !== 'string') return res.status(400).json({ error: 'dirId required' });
      const dir = deps.directories.get(dirId);
      if (!dir) return res.status(404).json({ error: 'directory not found' });
      if (!deps.existsSync(dir.path)) return res.status(404).json({ error: 'repo path missing' });
      try {
        const branch = (await deps.gitRunQueued(dir.path,
          ['rev-parse', '--abbrev-ref', 'HEAD'], { maxBuffer: 4096 })).trim();
        // @{upstream} fails outright in repos without a tracking remote — that
        // is a normal state, not an error; ahead/behind then fall back to the
        // base branch ("local-only commits" rather than "unpushed").
        let upstream = '';
        try {
          upstream = (await deps.gitRunQueued(dir.path,
            ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { maxBuffer: 4096 })).trim();
        } catch (_) { upstream = ''; }
        let baseBranch = dir.baseBranch || '';
        if (!baseBranch) {
          try { baseBranch = await deps.gitBaseBranch(dir.path); } catch (_) { baseBranch = ''; }
        }
        const aheadRef = upstream || baseBranch;
        let ahead = 0;
        let behind = 0;
        if (aheadRef) {
          try {
            ahead = parseInt((await deps.gitRunQueued(dir.path,
              ['rev-list', '--count', `${aheadRef}..HEAD`], { maxBuffer: 4096 })).trim() || '0', 10) || 0;
            behind = parseInt((await deps.gitRunQueued(dir.path,
              ['rev-list', '--count', `HEAD..${aheadRef}`], { maxBuffer: 4096 })).trim() || '0', 10) || 0;
          } catch (_) { ahead = 0; behind = 0; }
        }
        const dirtyFiles = [];
        try {
          const status = await deps.gitRunQueued(dir.path, ['status', '--porcelain'], { maxBuffer: 256 * 1024 });
          for (const line of String(status).split('\n')) {
            if (line.length < 4) continue;
            const filePath = line.slice(3).replace(/ -> /, ' → ');
            // Session worktrees live inside the checkout but are their own git
            // dirs; they must not read as pending changes of this one.
            if (filePath.startsWith('.multicc-worktrees/') || filePath.startsWith('.multicc-worktrees → ')) continue;
            dirtyFiles.push({ status: line.slice(0, 2).trim(), path: filePath });
          }
        } catch (_) { /* dirty list stays empty on error */ }
        return res.json({
          branch, upstream: upstream || null, baseBranch: baseBranch || null,
          ahead, behind, dirtyFiles,
        });
      } catch (error) {
        return res.status(500).json({ error: errorText(error) });
      }
    });
  }

  // M3 · per-task worktree surface: the same git core parameterized by a task
  // identity instead of a session record. Mounted only when the host injects
  // the board-runtime resolvers, so pure session compositions (tests, reduced
  // hosts) keep exactly the nine routes above.
  function registerTaskRoutes(app) {
    const resolveTaskInfo = (req, res) => {
      const info = deps.resolveTaskWorktree(req.params.taskId);
      if (!info || !info.dir || !info.worktreePath || !info.branch) {
        res.status(404).json({ error: 'task_not_found' });
        return null;
      }
      return info;
    };
    const taskIdentity = info => ({
      id: info.token || info.branch,
      worktreePath: info.worktreePath,
      branch: info.branch,
    });
    const taskBaseBranch = async (info, res) => {
      if (info.dir.baseBranch) return info.dir.baseBranch;
      try {
        return await deps.gitBaseBranch(info.dir.path);
      } catch (cause) {
        res.status(500).json({ error: errorText(cause) });
        return null;
      }
    };

    app.get('/api/task-board/tasks/:taskId/diff/files', async (req, res) => {
      const info = resolveTaskInfo(req, res);
      if (!info) return;
      if (!deps.existsSync(info.worktreePath)) {
        return res.status(400).json({ error: 'worktree missing' });
      }
      const baseBranch = await taskBaseBranch(info, res);
      if (!baseBranch) return;
      const worktree = info.worktreePath;
      let numstat = '';
      let nameStatus = '';
      let error = null;
      try {
        numstat = await deps.gitRunQueued(worktree,
          ['-c', 'core.quotepath=false', 'diff', '--numstat', '--no-color', '-z', baseBranch],
          { maxBuffer: 4 * 1024 * 1024 });
      } catch (cause) {
        error = errorText(cause);
      }
      try {
        nameStatus = await deps.gitRunQueued(worktree,
          ['-c', 'core.quotepath=false', 'diff', '--name-status', '--no-color', '-z', baseBranch],
          { maxBuffer: 1024 * 1024 });
      } catch (cause) {
        if (!error) error = errorText(cause);
      }
      const identity = taskIdentity(info);
      const fileCap = 500;
      const trackedFiles = error ? [] : parseDiffFiles(numstat, nameStatus);
      // Untracked files are invisible to `git diff <base>` but merge would add
      // them; surface them with status 'U' (mirrors the session route).
      let untrackedFiles = [];
      try {
        const untrackedPaths = await listUntrackedFiles(deps.gitRunQueued, worktree);
        for (const relative of untrackedPaths.slice(0, fileCap)) {
          const facts = await untrackedFileFacts(deps.readFile, worktree, relative);
          untrackedFiles.push({
            path: relative,
            oldPath: null,
            status: 'U',
            additions: facts.additions,
            deletions: 0,
            binary: facts.binary,
          });
        }
      } catch (_) { /* untracked list stays empty on failure */ }
      const allFiles = [...trackedFiles, ...untrackedFiles];
      const untrackedCount = untrackedFiles.length;
      const totalFiles = allFiles.length;
      const totalAdditions = allFiles.reduce((sum, f) => sum + f.additions, 0);
      const totalDeletions = allFiles.reduce((sum, f) => sum + f.deletions, 0);
      const truncated = totalFiles > fileCap;
      const files = truncated ? allFiles.slice(0, fileCap) : allFiles;
      return res.json({
        baseBranch,
        branch: info.branch,
        files,
        totalFiles,
        totalAdditions,
        totalDeletions,
        untrackedCount,
        truncated,
        mergeState: mergeStateCached(info.dir, identity),
        error,
      });
    });

    app.get('/api/task-board/tasks/:taskId/diff/file', async (req, res) => {
      const info = resolveTaskInfo(req, res);
      if (!info) return;
      if (!deps.existsSync(info.worktreePath)) {
        return res.status(400).json({ error: 'worktree missing' });
      }
      const filePath = req.query.path;
      if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 500) {
        return res.status(400).json({ error: 'path required (1..500 chars)' });
      }
      if (filePath.startsWith('-')) {
        return res.status(400).json({ error: 'path must not start with "-"' });
      }
      const baseBranch = await taskBaseBranch(info, res);
      if (!baseBranch) return;
      const patchCap = 256 * 1024;
      let patch = '';
      let truncated = false;
      let error = null;
      let untracked = false;
      try {
        patch = await deps.gitRunQueued(info.worktreePath,
          ['diff', '--no-color', baseBranch, '--', filePath],
          { maxBuffer: 512 * 1024 + 16 * 1024 });
        if (patch.length > patchCap) {
          patch = patch.slice(0, patchCap);
          truncated = true;
        }
      } catch (cause) {
        error = errorText(cause);
        patch = '';
      }
      if (!patch && !error) {
        const untrackedPaths = await listUntrackedFiles(deps.gitRunQueued, info.worktreePath);
        if (untrackedPaths.includes(filePath)) {
          untracked = true;
          const buffer = await deps.readFile(path.join(info.worktreePath, filePath)).catch(() => null);
          if (buffer) {
            const binary = isProbablyBinary(buffer);
            if (binary) {
              patch = `Binary files /dev/null and b/${filePath} differ`;
            } else {
              const lines = buffer.toString('utf8').split(/\r?\n/);
              if (lines.length && lines[lines.length - 1] === '') lines.pop();
              patch = [
                `diff --git a/${filePath} b/${filePath}`,
                'new file mode 100644',
                'index 0000000..0000000',
                '--- /dev/null',
                `+++ b/${filePath}`,
                `@@ -0,0 +1,${lines.length} @@`,
                ...lines.map(line => `+${line}`),
              ].join('\n');
              if (patch.length > patchCap) {
                patch = patch.slice(0, patchCap);
                truncated = true;
              }
            }
          }
        }
      }
      return res.json({ path: filePath, patch, truncated, error, untracked });
    });

    app.post('/api/task-board/tasks/:taskId/merge', async (req, res) => {
      const info = resolveTaskInfo(req, res);
      if (!info) return;
      const identity = taskIdentity(info);
      if (!hasWorktree(identity, res, '任务 worktree 不存在')) return;
      const result = await deps.gitMergeBack(info.dir, identity).catch(error => {
        deps.logger.warn(`[multicc] task merge ${identity.id} failed: ${errorText(error)}`);
        return failedGitResult(error);
      });
      if (!result.ok) {
        const status = result.conflicts && result.conflicts.length ? 409
          : (result.code === 'git_operation_failed' ? 500 : 400);
        return res.status(status).json(result);
      }
      deps.logger.log(`[multicc] task merge ${identity.branch} → ${info.dir.baseBranch}: `
        + (result.merged ? `${result.commits} commit(s)` : 'nothing to merge'));
      deps.appendEvent(info.dir.id, 'merged',
        result.merged ? `任务提交 ${result.commits} 个 → ${info.dir.baseBranch}` : '任务无新提交',
        identity.id);
      deps.workspaceBroadcast(info.dir.id, {
        type: 'merge_status', sessionId: identity.id, taskId: req.params.taskId,
        mergeState: await mergeStateFresh(info.dir, identity),
      });
      if (result.merged) {
        const synced = await autoSyncSiblingWorktrees(info.dir, identity.id);
        if (synced.length) result.siblingsSynced = synced;
      }
      return res.json(result);
    });

    app.post('/api/task-board/tasks/:taskId/cleanup-worktree', async (req, res) => {
      const info = resolveTaskInfo(req, res);
      if (!info) return;
      const opts = {};
      if (req.body && req.body.force === true) opts.force = true;
      const result = await deps.cleanupTaskWorktree(req.params.taskId, opts);
      if (!result || result.ok === false) {
        if (result && result.code === 'task_not_found') {
          return res.status(404).json({ error: 'task_not_found' });
        }
        if (result && result.blocked) return res.status(409).json(result);
        return res.status(400).json(result || { error: 'cleanup_failed' });
      }
      deps.logger.log(`[multicc] task worktree cleanup ${req.params.taskId}: `
        + `${info.branch} removed`);
      deps.appendEvent(info.dir.id, 'worktree_cleanup',
        '任务 worktree 已合并并清理', taskIdentity(info).id);
      deps.workspaceBroadcast(null, {
        type: 'task_board_update', taskIds: [req.params.taskId],
      });
      return res.json(result);
    });
  }

  function registerWriteRoutes(app) {
    app.post('/api/sessions/:id/merge', async (req, res) => {
      const found = findSession(req, res);
      if (!found) return;
      const { persisted, dir } = found;
      if (!hasWorktree(persisted, res, '该会话没有 worktree，无需合并')) return;
      const result = await executeMergeBack(dir, persisted);
      if (!result.ok) {
        const status = result.conflicts && result.conflicts.length ? 409
          : (result.code === 'git_operation_failed' ? 500 : 400);
        return res.status(status).json(result);
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
    const guardedApp = {
      get: (route, handler) => app.get(route, deps.asyncHandler(handler)),
      post: (route, handler) => app.post(route, deps.asyncHandler(handler)),
    };
    registerReadRoutes(guardedApp);
    if (typeof deps.resolveTaskWorktree === 'function'
        && typeof deps.cleanupTaskWorktree === 'function') {
      registerTaskRoutes(guardedApp);
    }
    registerWriteRoutes(guardedApp);
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
