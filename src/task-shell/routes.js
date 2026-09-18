'use strict';

const { cleanError } = require('./runtime');

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

function mountTaskShellRoutes(app, { getRuntime, open = id => getRuntime().open(id), history, artifacts, taskEntry, taskIndex,
  taskOperations, attributionDecisions }) {
  const route = handler => async (req, res) => {
    try {
      const runtime = getRuntime();
      res.json(await handler(runtime, req));
    } catch (error) {
      if (!res.headersSent) res.status(error.status || 500).json({ ok: false, ...cleanError(error),
        ...(error.receiptId ? { receiptId: error.receiptId, taskId: error.taskId, notDelivered: error.notDelivered === true } : {}) });
    }
  };
  app.get('/api/task-shell-tasks/:taskId', route((runtime, req) => (taskEntry || runtime.taskEntry)(req.params.taskId)));
  app.get('/api/task-shell-tasks/:taskId/history', route(async (runtime, req) => {
    const entry = await (taskEntry || runtime.taskEntry)(req.params.taskId);
    return { ...pageTaskHistory(entry.messages, req.query), task: entry.task, execution: entry.execution, readOnly: entry.readOnly };
  }));
  if (artifacts) {
    app.get('/api/task-shell-tasks/:taskId/artifacts', route((_runtime, req) => artifacts(req.params.taskId)));
    app.get('/api/task-shells/:shellId/artifacts', route((runtime, req) => {
      const scope = runtime.chatScope(req.params.shellId);
      return scope.taskId ? artifacts(scope.taskId) : { taskId: null, title: '', items: [] };
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
      scope: runtime.chatScope(req.params.shellId), turns: req.body?.turns, target: req.body?.target })));
    app.post('/api/task-shells/:shellId/task-operations', route((runtime, req) => taskOperations().apply({
      scope: runtime.chatScope(req.params.shellId), clientMsgId: req.body?.clientMsgId,
      previewToken: req.body?.previewToken, expectedRevision: req.body?.expectedRevision,
      turns: req.body?.turns, target: req.body?.target })));
    app.get('/api/task-operations/:operationId', route((_runtime, req) => taskOperations().get(req.params.operationId)));
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
    app.post('/api/task-shells/:shellId/attribution-decisions/:decisionId/undo', route((_runtime, req) =>
      attributionDecisions().undo(req.params.shellId, req.params.decisionId)));
  }
  app.delete('/api/task-shells/:shellId', route((runtime, req) => runtime.remove(req.params.shellId)));
  app.post('/api/task-shells/:shellId/links', route((runtime, req) => runtime.link(req.params.shellId, req.body?.taskId)));
  app.post('/api/task-shells/:shellId/tasks/resolve', route((runtime, req) => runtime.resolveTask(req.params.shellId, {
    taskId: req.body?.taskId,
    taskText: req.body?.taskText,
    title: req.body?.title,
  })));
  app.get('/api/task-shells/:shellId/tasks/:taskId', route((runtime, req) => runtime.detail(req.params.shellId, req.params.taskId)));
  app.post('/api/task-shells/:shellId/messages', route((runtime, req) => runtime.send(req.params.shellId, req.body)));
  app.post('/api/task-shells/:shellId/receipts/:receiptId/retry', route((runtime, req) => runtime.retry(req.params.shellId, req.params.receiptId)));
}

module.exports = { mountTaskShellRoutes, pageTaskHistory };
