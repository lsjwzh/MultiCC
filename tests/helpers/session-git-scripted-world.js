'use strict';

// Scripted dependency world for the session-git retirement differential
// (docs/rust-migration/differential/session-git.js).
//
// The retired routes (tests/helpers/legacy-session-git-routes.js) and the
// surviving host port (src/routes/session-git-host.js) both bottom out in the
// same handful of runtime facts: the session/directory Maps, the repo actor's
// git invocations, merge-state reads and the merge/sync/rebase/cleanup git
// transactions. This module turns one plain JSON world into that dependency
// bag, so the frozen oracle and the front door's Node child read one world.
//
// Everything here is deterministic: no clock, no randomness, no real git, no
// filesystem. `apply(world)` swaps the world between corpus cases while the
// runtime keeps holding the same Maps (both runtimes capture `deps` once).

const path = require('path');

function buildDeps(initialWorld = {}) {
  const records = new Map();
  const directories = new Map();
  const terminalSessions = new Map();
  const chatSessions = new Map();
  const state = { world: initialWorld };
  const effects = { events: [], broadcasts: [], chats: [] };

  function world() {
    return state.world || {};
  }

  function apply(next) {
    state.world = next || {};
    const w = world();
    records.clear();
    for (const record of w.records || []) records.set(record.id, record);
    directories.clear();
    for (const dir of w.directories || []) directories.set(dir.id, dir);
    terminalSessions.clear();
    for (const id of w.terminalSessions || []) terminalSessions.set(id, { terminal: true });
    chatSessions.clear();
    for (const [id, chatState] of Object.entries(w.chatSessions || {})) {
      chatSessions.set(id, chatState);
    }
  }

  function thrown(spec) {
    const error = new Error(
      spec.message != null ? spec.message : (spec.stderr != null ? String(spec.stderr) : 'scripted failure'),
    );
    if (spec.code != null) error.code = spec.code;
    if (spec.maxBuffer === true) error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    if (spec.stderr != null) error.stderr = String(spec.stderr);
    if (spec.operationId !== undefined) error.operationId = spec.operationId;
    if (spec.queueDepth !== undefined) error.queueDepth = spec.queueDepth;
    return error;
  }

  function answerFor(table, args) {
    if (!table) return undefined;
    const tabs = args.join('\t');
    if (Object.prototype.hasOwnProperty.call(table, tabs)) return table[tabs];
    const spaces = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(table, spaces)) return table[spaces];
    if (Object.prototype.hasOwnProperty.call(table, args[0])) return table[args[0]];
    return undefined;
  }

  function gitRunQueued(repo, args, options = {}) {
    const w = world();
    const answer = answerFor(w.git, args);
    if (answer && answer.error) return Promise.reject(thrown(answer.error));
    if (answer && answer.stdout !== undefined) return Promise.resolve(answer.stdout);
    if (w.gitMissing) {
      return Promise.reject(thrown({ stderr: `git ${args[0]} failed`, code: 'E_GIT' }));
    }
    return Promise.resolve(w.gitDefault && w.gitDefault.stdout !== undefined ? w.gitDefault.stdout : '');
  }

  function gitBaseBranch(dirPath) {
    const spec = world().baseBranch;
    if (!spec) return Promise.resolve('main');
    if (spec.throw) return Promise.reject(thrown(spec.throw));
    return Promise.resolve(spec.value);
  }

  function mergeState(dir, identity) {
    const spec = (world().mergeStates || {})[identity.id];
    if (!spec) {
      return Promise.resolve({ mergeReady: false, dirty: false, ahead: 0, behind: 0, reason: 'scripted' });
    }
    if (spec.throw) return Promise.reject(thrown(spec.throw));
    return Promise.resolve(spec);
  }

  function flow(op, identity, fallback) {
    const flows = world().flows || {};
    const spec = flows[`${op}:${identity.id}`] !== undefined
      ? flows[`${op}:${identity.id}`]
      : flows[op];
    if (spec === undefined) return Promise.resolve(fallback());
    if (spec && spec.throw) return Promise.reject(thrown(spec.throw));
    return Promise.resolve(spec);
  }

  function resolveTaskWorktree(taskId) {
    const info = (world().tasks || {})[taskId];
    return info || null;
  }

  function cleanupTaskWorktree(taskId) {
    const flows = world().flows || {};
    const spec = flows[`cleanup:${taskId}`] !== undefined ? flows[`cleanup:${taskId}`] : flows.cleanup;
    if (spec === undefined) return Promise.resolve(null);
    if (spec && spec.throw) return Promise.reject(thrown(spec.throw));
    return Promise.resolve(spec.value !== undefined ? spec.value : spec);
  }

  function existsSync(target) {
    const w = world();
    if ((w.absentPaths || []).includes(target)) return false;
    return true;
  }

  function readFile(target) {
    const entry = (world().readFiles || {})[path.normalize(target)]
      || (world().readFiles || {})[target];
    if (!entry || entry.missing) {
      const error = new Error(`ENOENT: no such file or directory, open '${target}'`);
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    if (entry.binary) return Promise.resolve(Buffer.from([0x00, 0x01, 0x02, 0xff]));
    return Promise.resolve(Buffer.from(entry.text != null ? entry.text : '', 'utf8'));
  }

  const deps = {
    records,
    directories,
    terminalSessions,
    chatSessions,
    resolveTaskWorktree,
    cleanupTaskWorktree,
    gitWorktreeMergeState: mergeState,
    gitBaseBranch,
    gitRunQueued,
    gitMergeBack: (dir, identity) => flow('merge', identity, () => ({ ok: true, merged: false, commits: 0 })),
    gitSyncFromBase: (dir, identity) => flow('sync', identity, () => ({
      ok: true, merged: false, commits: 0, baseBranch: dir.baseBranch,
    })),
    gitRebaseResolve: (dir, identity) => flow('rebase', identity, () => ({ ok: true, done: true })),
    appendEvent: (...args) => { effects.events.push(args); },
    workspaceBroadcast: (...args) => { effects.broadcasts.push(args); },
    chatBroadcast: (...args) => { effects.chats.push(args); },
    existsSync,
    readFile,
    now: () => (world().now !== undefined ? world().now : 1_000_000),
    random: () => (world().random !== undefined ? world().random : 0),
    asyncHandler: handler => handler,
    logger: { log() {}, warn() {} },
    isLocalRequest: () => true,
  };

  apply(initialWorld);

  return {
    deps,
    apply,
    effects,
    get world() { return state.world; },
  };
}

// The deps the two runtimes need are identical (the current runtime's host
// port is a superset of the legacy route surface). Express-based callers wrap
// handlers in src/http-errors.asyncHandler instead of the identity shim above.
function asyncHandlerFrom(repo) {
  return require(path.join(repo, 'src/http-errors')).asyncHandler;
}

module.exports = { buildDeps, asyncHandlerFrom };
