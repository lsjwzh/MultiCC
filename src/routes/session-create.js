'use strict';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[session-create] dependencies are required');
  if (!deps.directories || typeof deps.directories.get !== 'function') {
    throw new TypeError('[session-create] directories map is required');
  }
  for (const name of ['createSessionRecord', 'asyncHandler']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`[session-create] ${name} is required`);
  }
  return deps;
}

function mountSessionCreateRoutes(app, rawDeps) {
  if (!app || typeof app.post !== 'function' || typeof app.put !== 'function') {
    throw new TypeError('[session-create] Express-compatible app is required');
  }
  const deps = assertDependencies(rawDeps);

  app.put('/api/directories/:id/role-workers/:presetId', deps.asyncHandler(async (req, res) => {
    return res.status(410).json({ ok: false, code: 'role_sessions_retired',
      error: 'Roles are task attachments. Create a task, then attach its roles.', url: '/air' });
  }));

  app.post('/api/directories/:id/sessions', deps.asyncHandler(async (req, res) => {
    const dir = deps.directories.get(req.params.id);
    if (!dir) return res.status(404).json({ error: 'directory not found' });
    const cli = (req.body.cli || '').trim();
    const kind = (req.body.kind || '').trim();
    const label = (req.body.label || '').trim() || null;
    const model = (req.body.model || '').trim() || null;
    const effort = req.body.effort === undefined ? null : req.body.effort;
    const agent = req.body.agent === undefined ? null : req.body.agent;
    const provider = req.body.provider === undefined ? undefined : ((req.body.provider || '').trim() || '');
    const providerSelection = req.body.providerSelection;
    const rolePrompt = (req.body.rolePrompt || '').trim() || null;
    const experimentalMode = (req.body.experimentalMode || '').trim() || null;
    if (kind === 'chat' && !experimentalMode && deps.createTask) {
      const result = await deps.createTask({ dirId: dir.id, title: label || '新任务', cli: cli || 'claude',
        ...(model ? { model } : {}), ...(provider === undefined ? {} : { provider }),
        ...(providerSelection === undefined ? {} : { providerSelection }),
        effort, agent, ...(rolePrompt ? { rolePrompt } : {}),
        clientMsgId: req.body.clientMsgId || require('node:crypto').randomUUID() });
      return res.json({ ...deps.getRecord(result.sessionId), taskId: result.taskId, url: result.url });
    }
    const result = await deps.createSessionRecord({
      dir, cli, kind, label, model, provider,
      ...(providerSelection === undefined ? {} : { providerSelection }),
      effort, agent, rolePrompt, experimentalMode,
      persistence: 'required', persistenceSource: 'http.create-session',
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result.session);
  }));
}

module.exports = { mountSessionCreateRoutes };
