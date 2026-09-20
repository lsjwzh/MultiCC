'use strict';

const { vendorLoginForCli } = require('../cli-adapters/vendor-login');

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[session-create] dependencies are required');
  if (!deps.directories || typeof deps.directories.get !== 'function') {
    throw new TypeError('[session-create] directories map is required');
  }
  for (const name of ['createSessionRecord', 'asyncHandler']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`[session-create] ${name} is required`);
  }
  if (!deps.sessions || typeof deps.sessions.get !== 'function' || typeof deps.sessions.values !== 'function') {
    throw new TypeError('[session-create] sessions map is required');
  }
  return deps;
}

// Terminal sessions are embedded on the manage page (same mapping as
// public/manage-fleet-sharing.js sessionPageUrl for kind !== 'chat').
function terminalPageUrl(sessionId) {
  return `/?id=${encodeURIComponent(sessionId)}`;
}

function mountSessionCreateRoutes(app, rawDeps) {
  if (!app || typeof app.post !== 'function' || typeof app.put !== 'function') {
    throw new TypeError('[session-create] Express-compatible app is required');
  }
  const deps = assertDependencies(rawDeps);

  // One-click remedy surfaced by the chat UI when a vendor-auth CLI
  // (WorkBuddy/Qoder) fails with "authentication required": open a whitelisted
  // interactive login terminal in the same directory so the user can run the
  // vendor TUI's /login. Reuses an existing login terminal when one exists.
  app.post('/api/sessions/:id/vendor-login-terminal', deps.asyncHandler(async (req, res) => {
    const source = deps.sessions.get(req.params.id);
    if (!source) return res.status(404).json({ error: 'session not found' });
    const spec = vendorLoginForCli(source.cli);
    if (!spec) {
      return res.status(400).json({ error: `cli ${source.cli || 'unknown'} does not use vendor terminal login` });
    }
    const dir = deps.directories.get(source.dirId);
    if (!dir) return res.status(404).json({ error: 'directory not found' });
    for (const record of deps.sessions.values()) {
      if (record && record.kind === 'terminal' && record.dirId === dir.id
          && record.loginFlow === spec.loginFlow) {
        return res.json({ ...record, reused: true, url: terminalPageUrl(record.id) });
      }
    }
    const result = await deps.createSessionRecord({
      dir, cli: source.cli, kind: 'terminal',
      label: `${spec.label} 登录`,
      loginFlow: spec.loginFlow,
      persistence: 'required', persistenceSource: 'http.vendor-login-terminal',
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ ...result.session, url: terminalPageUrl(result.session.id) });
  }));

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
