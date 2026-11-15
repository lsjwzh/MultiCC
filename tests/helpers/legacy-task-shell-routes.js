'use strict';

// FROZEN ORACLE — the exact route cluster retired from src/task-shell/routes.js
// (branch multicc/task-88a9…, parent of the migration commit). The migration
// differential mounts these handlers over the same scripted world as the Rust
// front door and compares status, body, ETag and headers byte for byte, plus
// the side-effect call sequence. Only the single relative require is pointed at
// the current tree; the handler logic is unchanged.
const { cleanError } = require('../../src/task-shell/runtime');

function pageTaskHistory(rawMessages, options = {}) {
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 50));
  const target = options.around || options.before;
  const cursor = target ? messages.findIndex(message => message.id === target || message.sourceMessageId === target) : -1;
  if (target && cursor < 0) return { messages: [], hasMore: false, found: false };
  const end = options.around ? Math.min(messages.length, cursor + Math.ceil(limit / 2))
    : options.before ? cursor : messages.length;
  const start = Math.max(0, end - limit);
  return { messages: JSON.parse(JSON.stringify(messages.slice(start, end))), hasMore: start > 0,
    ...(options.around ? { found: true, hasNewer: end < messages.length } : {}) };
}

// 产物采集要整份解析任务转录（百毫秒级同步 CPU），而两个消费端是 5s/15s 的轮询，且
// web/App/聊天帧常常同时盯着同一个任务。同一任务：进行中的采集合并成一个；完成后的
// 短窗口内直接复用同一份结果。窗口必须盖过最短轮询周期（5s 抖动后约 4.25s 起），否则
// 每一轮都过期重算 —— 多页同开时全局 ~1s 一次请求流，每次都整份重扫转录会把事件循环
// 轮番钉住。取 8s：相邻两轮共享一份，新产物最多迟一轮轮询可见。失败不落缓存。
function createArtifactsMemo(artifacts, { memoMs = 8000, maxEntries = 64 } = {}) {
  const memo = new Map();
  return taskId => {
    const hit = memo.get(taskId);
    if (hit && Date.now() - hit.at < memoMs) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = Promise.resolve(artifacts(taskId)).then(result => {
      entry.at = Date.now(); // TTL 从采集完成时刻起算
      return result;
    }, error => {
      memo.delete(taskId);
      throw error;
    });
    memo.set(taskId, entry);
    if (memo.size > maxEntries) for (const key of memo.keys()) { memo.delete(key); if (memo.size <= maxEntries) break; }
    return entry.promise;
  };
}

function mountTaskShellRoutes(app, { getRuntime, open = id => getRuntime().open(id), history, artifacts, artifactsMemoMs,
  taskEntry, taskIndex, taskOperations, attributionDecisions, independent, relations }) {
  const route = handler => async (req, res) => {
    try {
      const runtime = getRuntime();
      res.json(await handler(runtime, req));
    } catch (error) {
      if (!res.headersSent) res.status(error.status || 500).json({ ok: false, ...cleanError(error),
        // Conflict/detail payloads are the actionable part of these refusals
        // (which turns moved, how long the range was); cleanError only carries
        // code+message, so they are projected here explicitly.
        ...(Array.isArray(error.conflicts) ? { conflicts: error.conflicts } : {}),
        ...(error.detail && typeof error.detail === 'object' ? { detail: error.detail } : {}),
        ...(error.receiptId ? { receiptId: error.receiptId, taskId: error.taskId, notDelivered: error.notDelivered === true } : {}) });
    }
  };
  app.get('/api/task-shell-tasks/:taskId', route((runtime, req) => (taskEntry || runtime.taskEntry)(req.params.taskId)));
  app.get('/api/task-shell-tasks/:taskId/history', route(async (runtime, req) => {
    const entry = await (taskEntry || runtime.taskEntry)(req.params.taskId);
    return { ...pageTaskHistory(entry.messages, req.query), task: entry.task, execution: entry.execution, readOnly: entry.readOnly };
  }));
  if (artifacts) {
    const collectArtifacts = createArtifactsMemo(artifacts, { memoMs: artifactsMemoMs });
    app.get('/api/task-shell-tasks/:taskId/artifacts', route((_runtime, req) => collectArtifacts(req.params.taskId)));
    app.get('/api/task-shells/:shellId/artifacts', route((runtime, req) => {
      const scope = runtime.chatScope(req.params.shellId);
      return scope.taskId ? collectArtifacts(scope.taskId) : { taskId: null, title: '', items: [] };
    }));
  }
  app.post('/api/task-shell-tasks/:taskId/fork', route((runtime, req) => runtime.forkTask(req.params.taskId, req.body)));
  app.post('/api/task-shell-tasks/:taskId/messages', route(async (runtime, req) => {
    if (taskEntry) await taskEntry(req.params.taskId);
    runtime.assertBoardWritable(req.params.taskId);
    const entry = await runtime.taskEntry(req.params.taskId);
    return runtime.sendExplicit(entry.ownerShellId, req.body, { taskId: req.params.taskId, taskStart: true });
  }));
  // Discovery remains stable for cached clients; there is no switch or fallback.
  app.get('/api/task-shells/config', (_req, res) => res.json({ enabled: true }));
  app.get('/api/sessions/:sessionId/context', route((runtime, req) => runtime.contextTrace(
    req.params.sessionId,
    req.query.traceId,
    { includeMessages: req.query.include === 'messages' },
  )));
  app.get('/api/sessions/:sessionId/task-separation', route((runtime, req) => ({ ok: true, suggestion: runtime.separation.latest(req.params.sessionId) })));
  app.post('/api/sessions/:sessionId/task-separation/:suggestionId', route((runtime, req) => runtime.separation.decide(req.params.sessionId, req.params.suggestionId, req.body?.decision)));
  app.post('/api/task-shells', route((_runtime, req) => open(req.body?.sessionId)));
  app.get('/api/task-shells/:shellId', route((runtime, req) => runtime.view(req.params.shellId)));
  app.get('/api/task-shells/:shellId/chat', route((runtime, req) => runtime.chatScope(req.params.shellId)));
  if (history) app.get('/api/task-shells/:shellId/history', route((_runtime, req) => history(req.params.shellId, {
    before: req.query.before, around: req.query.around, limit: req.query.limit,
    includeHidden: req.query.historyScope === 'archive',
  })));
  if (taskIndex) app.get('/api/task-shells/:shellId/task-index', route((_runtime, req) =>
    taskIndex(req.params.shellId, { includeEmpty: req.query?.includeEmpty === '1' })));
  if (taskOperations) {
    app.get('/api/task-shells/:shellId/task-operations', route((_runtime, req) => ({
      ok: true, operations: taskOperations().list(req.params.shellId) })));
    app.post('/api/task-shells/:shellId/task-operations/preview', route((runtime, req) => taskOperations().preview({
      scope: runtime.chatScope(req.params.shellId), turns: req.body?.turns, range: req.body?.range, target: req.body?.target })));
    // `queue: true` 是「这一轮还在跑就先排队」：请求落成 pending 行，由服务端在
    // 轮次结束后重验并应用，不再用 409 把用户挡回去。
    app.post('/api/task-shells/:shellId/task-operations', route((runtime, req) => taskOperations().apply({
      scope: runtime.chatScope(req.params.shellId), clientMsgId: req.body?.clientMsgId,
      previewToken: req.body?.previewToken, expectedRevision: req.body?.expectedRevision,
      turns: req.body?.turns, range: req.body?.range, target: req.body?.target,
      queue: req.body?.queue === true })));
    app.get('/api/task-operations/:operationId', route((_runtime, req) => taskOperations().get(req.params.operationId)));
    app.post('/api/task-operations/:operationId/cancel', route((_runtime, req) =>
      taskOperations().cancel({ operationId: req.params.operationId, clientMsgId: req.body?.clientMsgId })));
    app.post('/api/task-operations/:operationId/undo', route((_runtime, req) => taskOperations().undo({
      operationId: req.params.operationId, clientMsgId: req.body?.clientMsgId })));
  }
  if (attributionDecisions) {
    // `?includeHidden=1` is the shadow-parity view: the rows `suggest` would
    // show, plus the ones it deliberately does not.
    app.get('/api/task-shells/:shellId/attribution-decisions', route((_runtime, req) => ({
      ok: true, decisions: attributionDecisions().list(req.params.shellId,
        { includeHidden: req.query?.includeHidden === '1' }) })));
    app.post('/api/task-shells/:shellId/attribution-decisions/:decisionId/accept', route((_runtime, req) =>
      attributionDecisions().accept(req.params.shellId, req.params.decisionId, { clientMsgId: req.body?.clientMsgId })));
    app.post('/api/task-shells/:shellId/attribution-decisions/:decisionId/dismiss', route((_runtime, req) =>
      attributionDecisions().dismiss(req.params.shellId, req.params.decisionId)));
    app.post('/api/task-shells/:shellId/attribution-decisions/:decisionId/defer', route((_runtime, req) =>
      attributionDecisions().defer(req.params.shellId, req.params.decisionId)));
    app.post('/api/task-shells/:shellId/attribution-decisions/:decisionId/undo', route((_runtime, req) =>
      attributionDecisions().undo(req.params.shellId, req.params.decisionId)));
  }
  if (independent) {
    // 独立继续（P3）：申请立即返回操作 ID，等待条件由服务端持有，
    // 页面关掉、断网或服务重启都不会让申请丢失。
    app.post('/api/task-shells/:shellId/tasks/:taskId/independent-continue', route((_runtime, req) =>
      independent().request(req.params.shellId, req.params.taskId, { clientMsgId: req.body?.clientMsgId })));
    app.get('/api/task-shells/:shellId/task-continuations', route((_runtime, req) => ({
      ok: true, continuations: independent().list({ shellId: req.params.shellId }).map(item => independent().publicOp(item)) })));
    app.get('/api/task-continuations/:continuationId', route((_runtime, req) =>
      independent().publicOp(independent().get(req.params.continuationId))));
    app.post('/api/task-continuations/:continuationId/apply', route((_runtime, req) =>
      independent().apply(req.params.continuationId)));
    app.post('/api/task-continuations/:continuationId/cancel', route((_runtime, req) =>
      independent().cancel(req.params.continuationId)));
    app.post('/api/task-continuations/:continuationId/retry', route((_runtime, req) =>
      independent().retry(req.params.continuationId)));
  }
  if (relations) {
    // 关联编辑（P4）：图上可见的关系边，纯展示与检索；新边默认不授予任何
    // 上下文读取权。批量整理走的仍是 task-operations 的整段区间。
    app.get('/api/task-shells/:shellId/relations', route((_runtime, req) => ({
      ok: true, relations: relations().list(req.params.shellId) })));
    app.post('/api/task-shells/:shellId/relations', route((_runtime, req) => relations().create(req.params.shellId, {
      kind: req.body?.kind, fromTaskId: req.body?.fromTaskId, toTaskId: req.body?.toTaskId,
      clientMsgId: req.body?.clientMsgId })));
    app.post('/api/task-shells/:shellId/relations/remove', route((_runtime, req) => relations().remove(req.params.shellId, {
      relationId: req.body?.relationId, clientMsgId: req.body?.clientMsgId })));
  }
  app.delete('/api/task-shells/:shellId', route((runtime, req) => runtime.remove(req.params.shellId)));
  app.post('/api/task-shells/:shellId/links', route((runtime, req) => runtime.link(req.params.shellId, req.body?.taskId)));
  // 「选为下一条输入目标」：移动输入游标，不划分轮次、不改身份。
  app.post('/api/task-shells/:shellId/select-target', route((runtime, req) => runtime.selectTarget(req.params.shellId, {
    taskId: req.body?.taskId, expectedCursorVersion: req.body?.expectedCursorVersion })));
  app.post('/api/task-shells/:shellId/tasks/resolve', route((runtime, req) => runtime.resolveTask(req.params.shellId, {
    taskId: req.body?.taskId,
    taskText: req.body?.taskText,
    title: req.body?.title,
  })));
  app.get('/api/task-shells/:shellId/tasks/:taskId', route((runtime, req) => runtime.detail(req.params.shellId, req.params.taskId)));
  app.post('/api/task-shells/:shellId/messages', route((runtime, req) => runtime.send(req.params.shellId, req.body)));
  app.post('/api/task-shells/:shellId/receipts/:receiptId/retry', route((runtime, req) => runtime.retry(req.params.shellId, req.params.receiptId)));
}

module.exports = { mountTaskShellRoutes, createArtifactsMemo, pageTaskHistory };
