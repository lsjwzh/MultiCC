'use strict';

const { cleanError } = require('./runtime');

function mountTaskShellRoutes(app, { getRuntime, open = id => getRuntime().open(id), history }) {
  const route = handler => async (req, res) => {
    try {
      const runtime = getRuntime();
      res.json(await handler(runtime, req));
    } catch (error) {
      if (!res.headersSent) res.status(error.status || 500).json({ ok: false, ...cleanError(error),
        ...(error.receiptId ? { receiptId: error.receiptId, taskId: error.taskId, notDelivered: error.notDelivered === true } : {}) });
    }
  };
  app.get('/api/task-shell-tasks/:taskId', route((runtime, req) => runtime.taskEntry(req.params.taskId)));
  app.post('/api/task-shell-tasks/:taskId/fork', route((runtime, req) => runtime.forkTask(req.params.taskId, req.body)));
  app.post('/api/task-shell-tasks/:taskId/messages', route(async (runtime, req) => {
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
  app.post('/api/task-shells', route((_runtime, req) => open(req.body?.sessionId)));
  app.get('/api/task-shells/:shellId', route((runtime, req) => runtime.view(req.params.shellId)));
  app.get('/api/task-shells/:shellId/chat', route((runtime, req) => runtime.chatScope(req.params.shellId)));
  if (history) app.get('/api/task-shells/:shellId/history', route((_runtime, req) => history(req.params.shellId, {
    before: req.query.before, around: req.query.around, limit: req.query.limit,
    includeHidden: req.query.historyScope === 'archive',
  })));
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

module.exports = { mountTaskShellRoutes };
