'use strict';

// 宿主端口：session/git 的 16 条公开路由已由 Rust 前门独占。
// 路径匹配、diff/log 输出解析、参数校验、DTO 字段顺序、错误码映射和
// merge/sync/rebase 的状态码决策树见 native/gateway/src/app/session_git.rs
// 与 native/core/src/session_git.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   session / lookup   进程内 sessions/directories Map（含 workspace owner 解析）
//   merge-state        merge-state 缓存与后台刷新队列
//   base-branch        repo actor 的 base branch 探测
//   git                经 repo actor 派生的 git 子进程（运行时补丁过的 PATH +
//                      非交互环境；Rust 前门绝不自己 spawn git）
//   read-facts/read-text 未跟踪文件的二进制探测与行数统计
//   task-worktree      任务板 worktree 解析
//   sync-gate-facts    isWorktreeActive + taskState.classifyState
//   *-merge/sync/rebase/cleanup  真正执行 git 事务并广播/追加事件
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const path = require('path');

const HOST_PATH = '/api/__host/session-git';

function projectSession(record) {
  if (!record) return null;
  const out = { id: record.id };
  if (record.worktreePath !== undefined) out.worktreePath = record.worktreePath;
  if (record.branch !== undefined) out.branch = record.branch;
  if (record.workspaceState !== undefined) out.workspaceState = record.workspaceState;
  return out;
}

function projectDir(dir) {
  if (!dir) return null;
  const out = { id: dir.id, path: dir.path };
  if (dir.baseBranch !== undefined) out.baseBranch = dir.baseBranch;
  return out;
}

/// Thrown git-flow error into the fact bag the Rust DTO builders consume
/// (`blockedGitResult` / `failedGitResult`).
function errorFacts(error) {
  const facts = { stderr: null, message: null };
  if (error && error.code !== undefined) facts.code = String(error.code);
  if (error && error.stderr) facts.stderr = String(error.stderr);
  if (error && error.message) facts.message = String(error.message);
  if (error && error.operationId !== undefined) facts.operationId = error.operationId;
  if (error && error.queueDepth !== undefined) facts.queueDepth = error.queueDepth;
  return facts;
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[session-git-host] dependencies are required');
  }
  for (const name of [
    'existsSync', 'readFile',
    'gitRunQueued', 'gitBaseBranch', 'mergeStateCached', 'mergeStateFresh',
    'isWorktreeActive', 'executeMergeBack', 'autoSyncSiblingWorktrees',
    'appendEvent', 'workspaceBroadcast', 'gitMergeBack', 'gitSyncFromBase',
    'gitRebaseResolve', 'resolveTaskWorktree', 'cleanupTaskWorktree',
    'untrackedFileFacts', 'isProbablyBinary',
  ]) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`[session-git-host] dependency missing: ${name}`);
    }
  }
  if (!deps.records || typeof deps.records.get !== 'function'
      || typeof deps.records.values !== 'function') {
    throw new TypeError('[session-git-host] records must be a Map');
  }
  if (!deps.directories || typeof deps.directories.get !== 'function') {
    throw new TypeError('[session-git-host] directories must be a Map');
  }
  return deps;
}

function mountSessionGitHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[session-git-host] Express-compatible app is required');
  }
  const deps = assertDependencies(options);
  const isLocal = options.isLocal || require('../native/binding').requestLocality.isLocalRequest;
  const log = options.logger || console;
  const errorText = options.errorText || (error => String((error && (error.stderr || error.message)) || error));

  function taskIdentity(info) {
    return { id: info.token || info.branch, worktreePath: info.worktreePath, branch: info.branch };
  }

  function sessionFacts(sessionId) {
    const requested = deps.records.get(sessionId);
    const persisted = requested?.workspaceOwnerSessionId
      ? deps.records.get(requested.workspaceOwnerSessionId)
      : requested;
    if (!persisted) return { error: 'session not found' };
    const dir = deps.directories.get(persisted.dirId);
    if (!dir) return { error: 'directory not found' };
    return {
      session: projectSession(persisted),
      dir: projectDir(dir),
      worktreeExists: !!(persisted.worktreePath && deps.existsSync(persisted.worktreePath)),
    };
  }

  async function mergeState(body) {
    if (body.taskId != null) {
      const info = deps.resolveTaskWorktree(body.taskId);
      if (!info || !info.dir || !info.worktreePath || !info.branch) return { error: 'task_not_found' };
      const identity = taskIdentity(info);
      const value = body.refresh
        ? await deps.mergeStateFresh(info.dir, identity)
        : deps.mergeStateCached(info.dir, identity, { priority: body.priority === true });
      return { value };
    }
    const persisted = deps.records.get(body.sessionId);
    if (!persisted) return { error: 'session not found' };
    const dir = deps.directories.get(persisted.dirId);
    if (!dir) return { error: 'directory not found' };
    const value = body.refresh
      ? await deps.mergeStateFresh(dir, persisted)
      : deps.mergeStateCached(dir, persisted, { priority: body.priority === true });
    return { value };
  }

  async function runGitOp(body) {
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    try {
      const stdout = await deps.gitRunQueued(body.repo, args, {
        maxBuffer: Number(body.maxBuffer) || undefined,
        raw: body.raw === true,
      });
      return { ok: true, stdout: String(stdout == null ? '' : stdout) };
    } catch (error) {
      return {
        ok: false,
        stderr: error && error.stderr ? String(error.stderr) : null,
        message: error && error.message ? String(error.message) : null,
        maxBuffer: !!error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      };
    }
  }

  async function readFacts(body) {
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    const facts = [];
    for (const relative of paths) {
      const fact = await deps.untrackedFileFacts(deps.readFile, body.worktree, relative);
      facts.push({ path: relative, additions: fact.additions, binary: fact.binary });
    }
    return { facts };
  }

  async function readText(body) {
    const buffer = await deps.readFile(path.join(body.worktree, body.path)).catch(() => null);
    if (!buffer) return { exists: false, binary: false, text: '' };
    const binary = deps.isProbablyBinary(buffer);
    return { exists: true, binary, text: binary ? '' : buffer.toString('utf8') };
  }

  function taskWorktree(body) {
    const info = deps.resolveTaskWorktree(body.taskId);
    if (!info || !info.dir || !info.worktreePath || !info.branch) return { info: null };
    return {
      info: {
        worktreePath: info.worktreePath,
        branch: info.branch,
        ...(info.token !== undefined ? { token: info.token } : {}),
        dir: {
          id: info.dir.id,
          path: info.dir.path,
          ...(info.dir.baseBranch !== undefined ? { baseBranch: info.dir.baseBranch } : {}),
        },
      },
      worktreeExists: !!deps.existsSync(info.worktreePath),
    };
  }

  function syncGateFacts(body) {
    const persisted = deps.records.get(body.sessionId);
    const state = persisted && persisted.taskState
      ? persisted.taskState.classifyState || null
      : null;
    return { active: deps.isWorktreeActive(body.sessionId), classifyState: state };
  }

  async function sessionMerge(body) {
    const persisted = deps.records.get(body.sessionId);
    const dir = persisted ? deps.directories.get(persisted.dirId) : null;
    if (!persisted || !dir) {
      return { error: { code: 'git_operation_failed', stderr: null, message: 'Git operation failed' } };
    }
    try {
      return { result: await deps.executeMergeBack(dir, persisted) };
    } catch (error) {
      return { error: errorFacts(error) };
    }
  }

  async function sessionSync(body) {
    const persisted = deps.records.get(body.sessionId);
    const dir = persisted ? deps.directories.get(persisted.dirId) : null;
    if (!persisted || !dir) {
      return { error: { code: 'git_operation_failed', stderr: null, message: 'Git operation failed' } };
    }
    const force = body.force === true;
    let result;
    try {
      result = await deps.gitSyncFromBase(dir, persisted, {
        force,
        activeCheck: force ? null : () => deps.isWorktreeActive(persisted.id),
      });
    } catch (error) {
      return { error: errorFacts(error) };
    }
    if (!result.ok) {
      if (result.conflicts && result.conflicts.length) {
        deps.appendEvent(dir.id, 'sync_conflict',
          `同步 rebase 冲突，需手动解决：${result.conflicts.slice(0, 5).join(', ')}`, persisted.id);
        deps.workspaceBroadcast(dir.id, {
          type: 'merge_status', sessionId: persisted.id,
          mergeState: await deps.mergeStateFresh(dir, persisted),
        });
      }
      return { result };
    }
    log.log(`[multicc] sync ${dir.baseBranch} → ${persisted.branch}: `
      + (result.merged ? `${result.commits} commit(s)` : 'already up to date'));
    deps.appendEvent(dir.id, 'synced',
      result.merged ? `从 ${result.baseBranch} 同步 ${result.commits} 个提交` : '已是最新', persisted.id);
    deps.workspaceBroadcast(dir.id, {
      type: 'merge_status', sessionId: persisted.id,
      mergeState: await deps.mergeStateFresh(dir, persisted),
    });
    return { result };
  }

  async function sessionRebase(body) {
    const persisted = deps.records.get(body.sessionId);
    const dir = persisted ? deps.directories.get(persisted.dirId) : null;
    if (!persisted || !dir) {
      return { error: { code: 'git_operation_failed', stderr: null, message: 'Git operation failed' } };
    }
    const force = body.force === true;
    let result;
    try {
      result = await deps.gitRebaseResolve(dir, persisted, body.action === 'abort' ? 'abort' : 'continue', {
        activeCheck: force ? null : () => deps.isWorktreeActive(persisted.id),
      });
    } catch (error) {
      // 退役的 Express handler 在 rebase 抛错（SESSION_ACTIVE/SESSION_LEASED）
      // 时照样广播一次 merge_status —— 前门只负责把 error 渲染成 blocked DTO，
      // 广播留在这里，否则前端在 rebase 被拒后就再也收不到状态刷新。
      deps.workspaceBroadcast(dir.id, {
        type: 'merge_status', sessionId: persisted.id,
        mergeState: await deps.mergeStateFresh(dir, persisted),
      });
      return { error: errorFacts(error) };
    }
    deps.workspaceBroadcast(dir.id, {
      type: 'merge_status', sessionId: persisted.id,
      mergeState: await deps.mergeStateFresh(dir, persisted),
    });
    if (!result.ok) return { result };
    deps.appendEvent(dir.id, 'synced',
      result.aborted ? 'rebase 已放弃，worktree 回到同步前状态'
        : (result.done ? 'rebase 冲突已解决并完成同步' : 'rebase 已继续'), persisted.id);
    return { result };
  }

  async function taskMerge(body) {
    const info = deps.resolveTaskWorktree(body.taskId);
    if (!info || !info.dir || !info.worktreePath || !info.branch) return { missing: true };
    const identity = taskIdentity(info);
    let result;
    try {
      result = await deps.gitMergeBack(info.dir, identity);
    } catch (error) {
      log.warn(`[multicc] task merge ${identity.id} failed: ${errorText(error)}`);
      return { error: errorFacts(error) };
    }
    if (!result.ok) return { result };
    log.log(`[multicc] task merge ${identity.branch} → ${info.dir.baseBranch}: `
      + (result.merged ? `${result.commits} commit(s)` : 'nothing to merge'));
    deps.appendEvent(info.dir.id, 'merged',
      result.merged ? `任务提交 ${result.commits} 个 → ${info.dir.baseBranch}` : '任务无新提交',
      identity.id);
    deps.workspaceBroadcast(info.dir.id, {
      type: 'merge_status', sessionId: identity.id, taskId: body.taskId,
      mergeState: await deps.mergeStateFresh(info.dir, identity),
    });
    if (result.merged) {
      const synced = await deps.autoSyncSiblingWorktrees(info.dir, identity.id);
      if (synced.length) result.siblingsSynced = synced;
    }
    return { result };
  }

  async function taskCleanup(body) {
    const info = deps.resolveTaskWorktree(body.taskId);
    if (!info || !info.dir || !info.worktreePath || !info.branch) return { missing: true };
    const opts = {};
    if (body.force === true) opts.force = true;
    const result = await deps.cleanupTaskWorktree(body.taskId, opts);
    if (result && result.ok !== false) {
      log.log(`[multicc] task worktree cleanup ${body.taskId}: ${info.branch} removed`);
      deps.appendEvent(info.dir.id, 'worktree_cleanup', '任务 worktree 已合并并清理', taskIdentity(info).id);
      deps.workspaceBroadcast(null, { type: 'task_board_update', taskIds: [body.taskId] });
    }
    return { result: result == null ? null : result };
  }

  async function handle(body) {
    switch (body.op) {
      case 'session': return sessionFacts(body.sessionId);
      case 'lookup': {
        const persisted = body.sessionId != null ? deps.records.get(body.sessionId) : null;
        const dir = body.dirId != null ? deps.directories.get(body.dirId) : null;
        return {
          session: projectSession(persisted),
          dir: projectDir(dir),
          sessionWorktreeExists: !!(persisted && persisted.worktreePath
            && deps.existsSync(persisted.worktreePath)),
          dirPathExists: !!(dir && dir.path && deps.existsSync(dir.path)),
        };
      }
      case 'merge-state': return mergeState(body);
      case 'base-branch': {
        try {
          return { ok: true, baseBranch: await deps.gitBaseBranch(body.dirPath) };
        } catch (error) {
          return {
            ok: false,
            stderr: error && error.stderr ? String(error.stderr) : null,
            message: error && error.message ? String(error.message) : null,
          };
        }
      }
      case 'git': return runGitOp(body);
      case 'read-facts': return readFacts(body);
      case 'read-text': return readText(body);
      case 'task-worktree': return taskWorktree(body);
      case 'sync-gate-facts': return syncGateFacts(body);
      case 'session-merge': return sessionMerge(body);
      case 'session-sync': return sessionSync(body);
      case 'session-rebase': return sessionRebase(body);
      case 'task-merge': return taskMerge(body);
      case 'task-cleanup': return taskCleanup(body);
      default: return null;
    }
  }

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    return Promise.resolve(handle(body)).then(
      (value) => {
        if (value === null) return res.status(400).json({ error: 'unknown host operation' });
        return res.json(value);
      },
      () => res.status(500).json({ error: 'host operation failed' }),
    );
  });
}

module.exports = { HOST_PATH, mountSessionGitHostRoute };
