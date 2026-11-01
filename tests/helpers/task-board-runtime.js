'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskBoardRuntime } = require('../../src/routes/task-board');

function mkRuntime(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-'));
  const file = path.join(tmp, 'task_board.json');
  const auxCalls = [];
  const broadcasts = [];
  const dispatches = [];
  const sessionMessages = [];
  const creates = [];
  let auxResolve;
  let runtime;
  // The createSessionRecord spy below closes over THIS binding, so it must
  // already be the override map (when a test passes its own records) — else
  // bound-N lands in the discarded default map and onMessagePersisted never
  // sees the record.
  const records = overrides.records instanceof Map
    ? overrides.records
    : new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: '工程师1' }],
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
    ]);
  const deps = {
    file,
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue(task) {
        auxCalls.push(task);
        return new Promise(resolve => { auxResolve = resolve; });
      },
    },
    records,
    directories: new Map([
      ['dir-1', { id: 'dir-1', path: '/tmp/dir-1', baseBranch: 'main' }],
    ]),
    loadHistory: () => [
      { id: 'mu1', role: 'user', content: '实现任务板', ts: 10 },
      { id: 'ma1', role: 'assistant', content: '已实现，改了 src/task-board.js', ts: 20 },
    ],
    // #38 · board sends bind a task-bound chat session instead of pooling.
    createSessionRecord: async input => {
      creates.push(input);
      const session = {
        id: 'bound-' + creates.length, kind: 'chat', dirId: input.dir.id,
        taskBoundTaskId: input.taskBoundTaskId || null,
        cli: input.cli, label: input.label,
      };
      records.set(session.id, session);
      return { ok: true, id: session.id, session };
    },
    dispatchToSession: async (target, message, opts) => {
      dispatches.push({ target, message, opts, route: opts.allowCommander ? 'commander' : 'manual' });
      return { ok: true, chatId: target, operationId: 'op-1', status: 'delivering' };
    },
    // Retired path (#38): kept as a canary — production no longer wires this
    // port, and no test may observe it being called.
    routeCommanderTask: async ({ commanderId, message }) => {
      dispatches.push({ target: commanderId, message, route: 'commander-retired' });
      return { ok: false, code: 'pooled_path_retired' };
    },
    sendSessionMessage: async (sessionId, text, options) => {
      sessionMessages.push({ sessionId, text, options: { ...options } });
      // New design: Commander goes through runTurn; sendSessionMessage just confirms delivery.
      return { ok: true, handled: false, chatId: sessionId };
    },
    workspaceBroadcast: (dirId, payload) => broadcasts.push({ dirId, payload }),
    atomicWriteJson: (f, value) => fs.writeFileSync(f, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => 'idle',
    isSessionBusy: () => false,
    logger: { log: () => {} },
    ...overrides,
  };
  // 故障注入端口仅存在于测试；正常测试与产品都使用 Rust 文件仓储。
  if (overrides.atomicWriteJson) {
    const repository = require('../../src/task-board/repository').createTaskBoardRepository(file);
    const readRevision = f => {
      try { return Number(JSON.parse(fs.readFileSync(f, 'utf8')).revision) || 0; } catch (_) { return 0; }
    };
    deps.taskBoardRepository = { load: () => repository.load(), save(value, expectedRevision, options = {}) {
      // 与 Rust save 相同的乐观并发契约：expectedRevision 必须等于磁盘
      // primary/recovery 的最大 revision，否则拒绝写入，而不是静默覆盖。
      const recovery = file.replace(/\.json$/i, '') + '.planning-v2.json';
      const disk = Math.max(readRevision(file), readRevision(recovery));
      let next = value, conflict = null;
      if (expectedRevision !== undefined && Number(expectedRevision) !== disk) {
        if (options.onConflict !== 'preserve') {
          throw Object.assign(new Error('TASK_BOARD_REVISION_CONFLICT'), { code: 'TASK_BOARD_REVISION_CONFLICT' });
        }
        let backup = null;
        try {
          backup = file.replace(/\.json$/i, '') + `.conflict-r${disk}-${Date.now()}.json`;
          fs.copyFileSync(file, backup);
        } catch (_) { backup = null; }
        next = { ...value, revision: disk + 1 };
        conflict = { diskRevision: disk, backup };
      }
      let previous = null;
      try { previous = fs.readFileSync(file); } catch (_) {}
      deps.atomicWriteJson(file, next);
      try { deps.atomicWriteJson(recovery, next); }
      catch (error) { if (previous) fs.writeFileSync(file, previous); else fs.unlinkSync(file); throw error; }
      const reply = { ok: true, revision: Number(next.revision) };
      if (conflict) reply.conflict = conflict;
      return reply;
    } };
  }
  runtime = createTaskBoardRuntime(deps);
  return {
    runtime, deps, file, auxCalls, broadcasts, dispatches, sessionMessages, creates,
    resolveAux: v => auxResolve(v),
  };
}

module.exports = { mkRuntime };
