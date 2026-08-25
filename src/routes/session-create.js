'use strict';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[session-create] dependencies are required');
  if (!deps.directories || typeof deps.directories.get !== 'function') {
    throw new TypeError('[session-create] directories map is required');
  }
  for (const name of ['createSessionRecord', 'ensureRoleWorker', 'getAgentPreset', 'asyncHandler']) {
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
    const dir = deps.directories.get(req.params.id);
    if (!dir) return res.status(404).json({ error: 'directory not found' });
    const preset = deps.getAgentPreset(req.params.presetId);
    if (!preset) return res.status(404).json({ error: 'agent preset not found' });
    const overrides = {
      label: req.body.label,
      cli: req.body.cli,
      model: req.body.model,
      effort: req.body.effort,
      agent: req.body.agent,
    };
    if (req.body.provider !== undefined) overrides.provider = req.body.provider;
    const result = await deps.ensureRoleWorker({ dir, preset, overrides });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(result.reused ? 200 : 201).json({ ...result.session, reused: result.reused });
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
