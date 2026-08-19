'use strict';

// M0 · task transcript read-side projection (docs/chat-view-unification-design.md §3-M0).
// The task-run ledger is the only durable source for a task virtual session;
// these tests pin the projection of ledger rows into the chat-history message
// DTO shape plus the pagination contract shared with /api/sessions/:id/history.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const core = require('../src/task-board');
const { isTaskRunWrapperText } = require('../src/task-run-context');
const { createTaskRunStore } = require('../src/task-run-store');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const {
  taskTranscriptMessages,
  paginateTranscript,
} = require('../src/task-transcript-repository');

function projectDeps(taskRuns) {
  return {
    taskRuns,
    messageText: core.messageText,
    isWrapperText: isTaskRunWrapperText,
  };
}

// Minimal in-memory ledger for pure-function tests.
function fakeTaskRuns(runs) {
  return {
    listTaskRuns: () => runs.map(run => ({ runId: run.runId })),
    getRunMessages: runId => (runs.find(run => run.runId === runId) || { messages: [] }).messages,
  };
}

test('taskTranscriptMessages projects ledger rows into chat DTOs', () => {
  const taskRuns = fakeTaskRuns([
    {
      runId: 'run-1',
      messages: [
        {
          messageId: 'adm-1', role: 'user', kind: 'admission',
          content: '对比两个库', metadata: {}, createdAt: 10,
        },
        {
          messageId: 'a-1', role: 'assistant', kind: 'message',
          content: '已完成对比', metadata: {
            tools: [{ id: 't1', name: 'Read', input: { file: 'x.js' }, result: 'ok' }],
            usage: { input: 100, output: 50 },
            cost: 0.02,
            durationMs: 83000,
          }, createdAt: 20,
        },
      ],
    },
    {
      runId: 'run-2',
      messages: [
        {
          messageId: 'adm-2', role: 'user', kind: 'admission',
          content: '再补充一下', metadata: { clientMsgId: 'client-7' }, createdAt: 30,
        },
        {
          messageId: 'err-1', role: 'system', kind: 'error',
          content: '上游分类器错误，结果未持久化', metadata: {
            code: 'classifier_api_error', retryable: true,
          }, createdAt: 40,
        },
        {
          messageId: 'a-2', role: 'assistant', kind: 'message',
          content: '中断草稿', metadata: { partial: true }, createdAt: 50,
        },
      ],
    },
  ]);
  const messages = taskTranscriptMessages(projectDeps(taskRuns), 'tsk-1');
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[0], { id: 'adm-1', role: 'user', content: '对比两个库', ts: 10, kind: 'admission', taskRunId: 'run-1' });
  assert.equal(messages[1].id, 'a-1');
  assert.equal(messages[1].taskRunId, 'run-1');
  assert.deepEqual(messages[1].tools, [{ id: 't1', name: 'Read', input: { file: 'x.js' }, result: 'ok' }]);
  assert.deepEqual(messages[1].usage, { input: 100, output: 50 });
  assert.equal(messages[1].cost, 0.02);
  assert.equal(messages[1].durationMs, 83000);
  assert.equal(messages[3].kind, 'error');
  assert.equal(messages[3].content, '上游分类器错误，结果未持久化');
  // Metadata whitelist: internal ledger fields never leak into the chat DTO.
  assert.equal('code' in messages[3], false);
  assert.equal('retryable' in messages[3], false);
  assert.equal(messages[4].partial, true);
  // The sender's idempotency key rides along so a task-mode chat view can
  // commit its locally staged user bubble (same loop as chat_msg_meta).
  assert.equal(messages[2].clientMsgId, 'client-7');
  // Plain messages stay lean: no phantom metadata keys on admission rows of run-2.
  assert.deepEqual(Object.keys(messages[0]).sort(), ['content', 'id', 'kind', 'role', 'taskRunId', 'ts']);
});

test('taskTranscriptMessages drops transport wrappers (flag + legacy prefix, user rows only)', () => {
  const taskRuns = fakeTaskRuns([{
    runId: 'run-1',
    messages: [
      {
        messageId: 'w-1', role: 'user', kind: 'message',
        content: '[MultiCC 任务运行上下文 v1] 任务历史……', metadata: { wrapper: true }, createdAt: 5,
      },
      {
        messageId: 'w-2', role: 'user', kind: 'message',
        content: '【Commander 单向路由任务】执行以下任务', metadata: {}, createdAt: 6,
      },
      {
        // Assistant rows never count as wrappers even when flagged: the flag
        // marks transport user messages, not model output.
        messageId: 'w-3', role: 'assistant', kind: 'message',
        content: '模型回复（引用了上下文标题）', metadata: { wrapper: true }, createdAt: 7,
      },
      {
        messageId: 'adm-1', role: 'user', kind: 'admission',
        content: '用户原文', metadata: {}, createdAt: 10,
      },
    ],
  }]);
  const messages = taskTranscriptMessages(projectDeps(taskRuns), 'tsk-1');
  assert.deepEqual(messages.map(message => message.id), ['w-3', 'adm-1']);
});

test('paginateTranscript mirrors the session history pagination contract', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i + 1}`, role: 'user', content: `t${i + 1}`, ts: i + 1,
  }));
  // Tail page (default size 5): newest five, hasMore, cursor = oldest of page.
  // Non-around pages carry no found/hasNewer keys at all (session contract).
  assert.deepEqual(paginateTranscript(messages, {}), {
    messages: messages.slice(7), hasMore: true, before: 'm8',
  });
  // before cursor pages strictly older; the oldest page reports hasMore=false.
  const second = paginateTranscript(messages, { before: 'm8' });
  assert.deepEqual(second.messages.map(message => message.id), ['m3', 'm4', 'm5', 'm6', 'm7']);
  assert.equal(second.hasMore, true);
  const last = paginateTranscript(messages, { before: 'm3' });
  assert.deepEqual(last.messages.map(message => message.id), ['m1', 'm2']);
  assert.equal(last.hasMore, false);
  assert.equal(last.before, null);
  // around: centred window with found/hasNewer.
  const aroundMid = paginateTranscript(messages, { around: 'm6', limit: '5' });
  assert.deepEqual(aroundMid.messages.map(message => message.id), ['m4', 'm5', 'm6', 'm7', 'm8']);
  assert.equal(aroundMid.found, true);
  assert.equal(aroundMid.hasNewer, true);
  assert.equal(aroundMid.hasMore, true);
  const aroundHead = paginateTranscript(messages, { around: 'm2', limit: '5' });
  assert.deepEqual(aroundHead.messages.map(message => message.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(aroundHead.found, true);
  assert.equal(aroundHead.hasMore, false);
  assert.equal(aroundHead.hasNewer, true);
  // Unknown cursors: empty page, never a throw.
  assert.deepEqual(paginateTranscript(messages, { before: 'zz' }), {
    messages: [], hasMore: false, before: null,
  });
  assert.equal(paginateTranscript(messages, { around: 'zz' }).found, false);
  // limit is honoured and clamped to 100.
  assert.deepEqual(paginateTranscript(messages, { limit: '3' }).messages.map(m => m.id), ['m10', 'm11', 'm12']);
  assert.equal(paginateTranscript(messages, { limit: '1000' }).messages.length, 12);
});

function mkRuntime(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tasktranscript-'));
  const file = path.join(tmp, 'task_board.json');
  const dispatches = [];
  const deps = {
    file,
    auxQueue: { isUnhealthy: () => false, cancel: () => {}, enqueue: () => Promise.resolve({}) },
    records: new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: '工程师1' }],
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
    ]),
    loadHistory: () => [
      { id: 'mu1', role: 'user', content: '实现任务板', ts: 10 },
      { id: 'ma1', role: 'assistant', content: '已实现', ts: 20 },
    ],
    dispatchToSession: async (target, message, opts) => {
      dispatches.push({ target, message, opts });
      return { ok: true, chatId: target, operationId: 'op-1', status: 'delivering' };
    },
    routeCommanderTask: async () => ({
      ok: true, targetSessionId: 'sess-1', targetLabel: '工程师1',
      operationId: 'op-1', status: 'delivering', queued: false,
    }),
    sendSessionMessage: async () => ({ ok: true, handled: false }),
    workspaceBroadcast: () => {},
    atomicWriteJson: (f, value) => fs.writeFileSync(f, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => 'idle',
    isSessionBusy: () => false,
    logger: { log: () => {} },
    ...overrides,
  };
  const runtime = createTaskBoardRuntime(deps);
  return { runtime, deps, dispatches };
}

function mountRoutes(runtime) {
  const routes = new Map();
  runtime.mountRoutes({
    get: (p, handler) => routes.set(`GET ${p}`, handler),
    post: (p, handler) => routes.set(`POST ${p}`, handler),
  });
  return routes;
}

function fakeRes() {
  return {
    code: 200, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('GET task messages returns chat-history-style pagination on top of legacy fields', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tasktranscript-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskRuns = createTaskRunStore({ file: path.join(dir, 'task-runs.sqlite'), Database });
  t.after(() => { try { taskRuns.close(); } catch (_) {} });
  const { runtime } = mkRuntime({ taskRuns });
  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 20, excerpt: 'x' }, 20);
  const taskId = Object.keys(runtime.getBoard().tasks)[0];
  const runId = 'tr_' + 'a'.repeat(31);
  taskRuns.admitRun({
    run: { runId, taskId, attemptId: runId, slotId: null, startedAt: 1, metadata: { source: 'task-board' } },
    messages: [
      { messageId: 'adm-http', role: 'user', kind: 'admission', content: '隔离执行这个任务', metadata: {}, createdAt: 1 },
      {
        messageId: 'wrap-http', role: 'user', kind: 'message',
        content: '[MultiCC 任务运行上下文 v1] 历史编译文本', metadata: { wrapper: true }, createdAt: 2,
      },
    ],
  });
  taskRuns.appendMessage({
    runId, messageId: 'asst-http', role: 'assistant',
    content: '第一轮完成', createdAt: 3,
    metadata: {
      tools: [{ id: 't1', name: 'Bash', input: { command: 'npm test' }, result: 'pass' }],
      usage: { input: 10, output: 5 },
    },
  });
  const routes = mountRoutes(runtime);

  const page = fakeRes();
  routes.get('GET /api/task-board/tasks/:taskId/messages')(
    { params: { taskId }, query: { limit: '1' } }, page);
  assert.equal(page.code, 200);
  // Legacy projection intact: wrapper excluded, admission text once.
  assert.deepEqual(page.body.items.map(item => item.text), ['隔离执行这个任务', '第一轮完成']);
  assert.equal(page.body.runs.length, 1);
  // New pagination payload: chat DTO page + hasMore cursor semantics.
  assert.deepEqual(page.body.messages, [{
    id: 'asst-http', role: 'assistant', content: '第一轮完成', ts: 3, taskRunId: runId,
    tools: [{ id: 't1', name: 'Bash', input: { command: 'npm test' }, result: 'pass' }],
    usage: { input: 10, output: 5 },
  }]);
  assert.equal(page.body.hasMore, true);

  const older = fakeRes();
  routes.get('GET /api/task-board/tasks/:taskId/messages')(
    { params: { taskId }, query: { before: 'asst-http' } }, older);
  assert.deepEqual(older.body.messages.map(message => message.id), ['adm-http']);
  assert.equal(older.body.hasMore, false);

  const around = fakeRes();
  routes.get('GET /api/task-board/tasks/:taskId/messages')(
    { params: { taskId }, query: { around: 'asst-http', limit: '1' } }, around);
  assert.equal(around.body.found, true);
  assert.equal(around.body.hasNewer, false);
  assert.deepEqual(around.body.messages.map(message => message.id), ['asst-http']);

  const missing = fakeRes();
  routes.get('GET /api/task-board/tasks/:taskId/messages')(
    { params: { taskId: 'nope' } }, missing);
  assert.equal(missing.code, 404);
});

test('GET task messages paginates legacy ref-backed tasks without a ledger', () => {
  const { runtime } = mkRuntime();
  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 20, excerpt: 'x' }, 20);
  const taskId = Object.keys(runtime.getBoard().tasks)[0];
  const routes = mountRoutes(runtime);
  const response = fakeRes();
  routes.get('GET /api/task-board/tasks/:taskId/messages')({ params: { taskId } }, response);
  assert.equal(response.code, 200);
  // Legacy tasks degrade to the same pagination contract over their refs,
  // so a task-mode chat view can open any historical task.
  assert.deepEqual(response.body.messages, [
    { id: 'mu1', role: 'user', content: '实现任务板', ts: 10 },
    { id: 'ma1', role: 'assistant', content: '已实现', ts: 20 },
  ]);
  assert.equal(response.body.hasMore, false);
});
