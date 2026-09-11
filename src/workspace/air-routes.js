'use strict';

// Air reads canonical task records through the task-shell/board authority.
// The client cannot mint a workspace permit, writer proof or attribution fact.
function mountAirRoutes(app, deps) {
  const route = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(error.status || 500).json({ ok: false, code: error.code || 'air_request_failed', message: error.status ? error.message : 'Request failed' }); }
  };
  function resource(sessionId) {
    const snapshot = deps.admission.snapshot();
    const record = deps.records.get(sessionId);
    const workspace = snapshot.workspaces.find(w => w.ownerId === (record?.workspaceOwnerSessionId || sessionId));
    const lease = workspace && snapshot.leases.find(l => l.workspaceId === workspace.id);
    return { id: workspace?.id || null, residency: workspace?.residency || (record?.workspaceState === 'planned' ? 'planned' : record ? 'retained' : 'planned'),
      lease: lease?.state || 'idle', capacityReason: workspace && !lease ? deps.admission.capacityReason(workspace.id) : null, reason: lease?.reason || null, pins: workspace?.pins || [],
      path: workspace?.path || record?.worktreePath || null, branch: workspace?.branch || record?.branch || null };
  }
  app.get('/api/air', route(async () => {
    const migration = await deps.shell.migrateTaskSessions?.();
    const board = deps.getBoard();
    const tasks = Object.values(board.tasks || {}).filter(t => !t.mergedIntoTaskId && !board.deletedTaskIds?.includes(t.id)).map(t => {
      const sessionId = t.chatSessionId || t.sessionId || null;
      const access = deps.shell.taskAccess(t);
      return { id: t.id, dirId: require('../task-board/core').taskDirId(board, t) || deps.records.get(sessionId)?.dirId, title: t.title, status: t.status,
        recordType: t.recordType || null, workflowStage: t.workflowStage || null, updatedAt: t.updatedAt || t.createdAt,
        sessionId, ...access, resource: resource(sessionId) };
    });
    return { ok: true, directories: [...deps.directories.values()].map(d => ({ id: d.id, name: d.name, path: d.path })),
      tasks, budgets: deps.admission.snapshot().budgets, clis: deps.clis, migration,
      sessions: [...deps.records.values()].filter(s => s.kind === 'terminal' && !['aux', 'gateway'].includes(s.type))
        .map(s => ({ id: s.id, dirId: s.dirId, label: s.label || s.id, kind: s.kind, cli: s.cli })) };
  }));
  app.get('/api/air/resolve', route(async req => {
    await deps.shell.migrateTaskSessions();
    let taskId = req.query.task;
    if (!taskId && req.query.session) taskId = deps.shell.stateTarget(req.query.session).taskId || deps.shell.artifactTaskId(req.query.session);
    if (!taskId && req.query.shell) taskId = deps.shell.chatScope(req.query.shell).taskId;
    if (!taskId) return { ok: true, url: '/air' };
    const entry = await deps.shell.taskEntry(taskId);
    const dirId = deps.records.get(entry.sessionId)?.dirId;
    return { ok: true, taskId, url: '/air?' + new URLSearchParams({ task: taskId, ...(dirId ? { dir: dirId } : {}) }) };
  }));
  app.post('/api/air/tasks', route(async req => { const result = await deps.shell.createTask(req.body); deps.admission.identify(result.sessionId); return result; }));
  app.get('/api/air/tasks/:id', route(async req => {
    const entry = await deps.shell.taskEntry(req.params.id);
    const record = deps.records.get(entry.sessionId);
    const candidate = deps.shell.attributionCandidate(req.params.id);
    const attribution = await require('../task-routing/delivery-view').deliveryView({ sessionId: entry.sessionId,
      candidate, admission: deps.admission, cwd: deps.directories.get(record?.dirId)?.path });
    let roleBindings = null;
    try { roleBindings = deps.shell.roleBindings(req.params.id); } catch (_) {}
    return { ...entry, resource: resource(entry.sessionId), configuration: {
      pendingConfiguration: record?.pendingConfiguration || null,
      cli: record?.cli,
      model: record?.model,
      effectiveModel: deps.effectiveModel?.(record) || record?.model || null,
      effort: record?.effort,
      effectiveEffort: deps.effectiveEffort?.(record) || record?.effort || null,
      provider: record?.provider || null,
      providerName: deps.providerName?.(record) || record?.provider || null,
      providerSelection: record?.providerSelection || null,
      rolePresetId: record?.rolePresetId,
    }, roleBindings,
      // Auto attribution needs real integration and writer-barrier receipts.
      // Do not expose a switch that would turn client assertions into proofs.
      attribution };
  }));
  app.post('/api/air/tasks/:id/delivery/reconcile', route(async req => {
    const entry = await deps.shell.taskEntry(req.params.id);
    return { ok: true, publications: await deps.admission.recoverEvidence(entry.sessionId) };
  }));
  app.post('/api/air/tasks/:id/roles', route(req => ({ ok: true, roleBindings: deps.shell.updateRoleBindings(req.params.id, req.body) })));
}
module.exports = { mountAirRoutes };
