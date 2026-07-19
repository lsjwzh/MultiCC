'use strict';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[orchestration-routes] dependencies are required');
  if (!deps.records || typeof deps.records.get !== 'function') {
    throw new TypeError('[orchestration-routes] records.get is required');
  }
  const runtimeMethods = ['register', 'resolveCallback', 'listForSession', 'stats', 'cancel', 'startDetached'];
  if (!deps.runtime || runtimeMethods.some(name => typeof deps.runtime[name] !== 'function')
      || !deps.runtime.operations || typeof deps.runtime.operations.list !== 'function'
      || typeof deps.runtime.operations.listTasks !== 'function') {
    throw new TypeError('[orchestration-routes] durable runtime is required');
  }
  if (!deps.waitInjector || typeof deps.waitInjector.listForSession !== 'function'
      || typeof deps.waitInjector.stats !== 'function' || typeof deps.waitInjector.cancel !== 'function') {
    throw new TypeError('[orchestration-routes] waitInjector is required');
  }
  if (!deps.detached || typeof deps.detached.status !== 'function') {
    throw new TypeError('[orchestration-routes] detached status port is required');
  }
  for (const name of [
    'cwdForSession', 'resolveCwd', 'toWaitDto', 'withApiMeta', 'requestContext', 'v1Error',
  ]) {
    if (typeof deps[name] !== 'function') throw new TypeError(`[orchestration-routes] ${name} is required`);
  }
  return deps;
}

function createOrchestrationRoutes(rawDeps) {
  const deps = assertDependencies(rawDeps);
  let mounted = false;

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
        || typeof app.delete !== 'function') {
      throw new TypeError('[orchestration-routes] Express-compatible app is required');
    }
    if (mounted) throw new Error('[orchestration-routes] routes already mounted');
    mounted = true;

    app.post('/api/sessions/:id/wait', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const body = req.body || {};
      try {
        const registration = await deps.runtime.register({
          session: session.id,
          mode: body.mode,
          cwd: deps.cwdForSession(session),
          pollCmd: body.pollCmd,
          pollUrl: body.pollUrl,
          untilContains: body.untilContains,
          untilRegex: body.untilRegex,
          intervalSec: body.intervalSec,
          maxChecks: body.maxChecks,
          injectPrefix: body.injectPrefix,
          timeoutSec: body.timeoutSec,
        });
        const callbackUrl = registration.token
          ? `${req.protocol}://${req.get('host')}/api/wait/${registration.id}/resolve?token=${registration.token}`
          : null;
        res.json({
          ok: true,
          ...registration,
          callbackUrl,
          status: registration.status || 'pending',
        });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.post('/api/wait/:wid/resolve', async (req, res) => {
      const body = req.body;
      const token = req.query.token || req.headers['x-wait-token'] || (body && body.token);
      let data;
      if (body && body.data !== undefined) {
        data = body.data;
      } else if (body && typeof body === 'object' && !Array.isArray(body)) {
        data = { ...body };
        delete data.token;
      } else {
        data = body ?? '';
      }
      try {
        const result = await deps.runtime.resolveCallback(req.params.wid, token, data);
        const statusCode = result.ok ? 200
          : result.code === 'invalid_token' ? 403
            : result.code === 'not_found' ? 404
              : result.code === 'payload_conflict' ? 409
                : 400;
        const legacyError = result.code === 'invalid_token' ? 'bad token'
          : result.code === 'not_found' ? 'wait not found'
            : result.code === 'payload_conflict' ? 'callback payload conflicts with resolved wait'
              : result.code;
        res.status(statusCode).json({
          ...result,
          ...(result.ok ? {} : { error: legacyError }),
          duplicate: !!(result.ok && result.idempotent),
          status: result.status || (result.ok ? 'resolved' : undefined),
        });
      } catch (error) {
        res.status(error.statusCode || 400).json({ ok: false, error: error.message });
      }
    });

    app.get('/api/sessions/:id/waits', async (req, res) => {
      try {
        const durableWaits = await deps.runtime.listForSession(req.params.id);
        const legacyWaits = deps.waitInjector.listForSession(req.params.id)
          .map(wait => ({ ...wait, status: 'pending' }));
        const durableStats = await deps.runtime.stats();
        const legacyStats = deps.waitInjector.stats();
        res.json({
          waits: [...durableWaits, ...legacyWaits],
          stats: {
            ...legacyStats,
            ...durableStats,
            waits: durableStats.waits + legacyStats.waits,
            legacyWaits: legacyStats.waits,
          },
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/v1/sessions/:id/waits', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return deps.v1Error(req, res, 404, 'session not found', 'session_not_found');
      try {
        const durableWaits = await deps.runtime.listForSession(session.id);
        const legacyWaits = deps.waitInjector.listForSession(session.id)
          .map(wait => ({ ...wait, status: 'pending' }));
        const waits = [...durableWaits, ...legacyWaits].map(deps.toWaitDto);
        res.json(deps.withApiMeta({ waits, count: waits.length }, deps.requestContext(req, res)));
      } catch (error) {
        deps.v1Error(req, res, 500, 'failed to list waits', 'wait_list_failed', { cause: error });
      }
    });

    app.delete('/api/wait/:wid', async (req, res) => {
      try {
        let result = await deps.runtime.cancel(req.params.wid);
        if (!result.ok && result.code === 'not_found') {
          const legacy = deps.waitInjector.cancel(req.params.wid);
          result = legacy.ok ? { ...legacy, status: 'cancelled' } : result;
        }
        res.status(result.ok ? 200 : result.code === 'not_found' ? 404 : 409).json(result);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.post('/api/sessions/:id/run-detached', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const body = req.body || {};
      const command = (body.command || body.cmd || '').toString();
      if (!command.trim()) return res.status(400).json({ error: 'command required' });
      try {
        const baseCwd = deps.cwdForSession(session);
        const cwd = body.cwd ? deps.resolveCwd(baseCwd, String(body.cwd)) : baseCwd;
        const label = (body.label || command.replace(/\s+/g, ' ').slice(0, 60)).trim();
        const daemon = body.daemon === true || body.daemon === 'true';
        const intervalSec = Math.max(3, Number(body.intervalSec) || 10);
        const maxChecks = Math.max(1, Number(body.maxChecks) || 360);
        const started = await deps.runtime.startDetached({
          sessionId: session.id,
          idempotencyKey: req.get('Idempotency-Key') || body.idempotencyKey || null,
          spec: {
            command,
            cwd,
            label,
            daemon,
            intervalSec,
            maxChecks,
            injectPrefix: body.injectPrefix || `[后台任务完成] ${label}`,
          },
        });
        const operation = started.operation;
        const job = started.state || deps.detached.status(operation.externalId) || {};
        res.json({
          ok: true,
          taskId: operation.externalId,
          waitId: null,
          pid: job.pid || operation.pid || null,
          logPath: job.logPath || null,
          intervalSec,
          maxChecks,
          daemon,
          operationId: operation.id,
          status: operation.status,
          duplicate: !!started.idempotent,
        });
      } catch (error) {
        res.status(error.statusCode || 400).json({
          error: error.message,
          operationId: error.operationId || null,
        });
      }
    });

    app.get('/api/sessions/:id/detached', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const operations = await deps.runtime.operations.list({
        kind: 'detached',
        ownerSessionId: session.id,
      });
      res.json({
        tasks: operations.map(operation => {
          const task = deps.detached.status(operation.externalId);
          return task ? { ...task, operationId: operation.id, status: operation.status } : null;
        }).filter(Boolean),
      });
    });

    app.get('/api/sessions/:id/tasks', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      try {
        const tasks = await deps.runtime.operations.listTasks({ sessionId: session.id });
        res.json({ tasks, count: tasks.length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/detached/:taskId', async (req, res) => {
      const state = deps.detached.status(req.params.taskId);
      if (!state) return res.status(404).json({ error: 'task not found' });
      const operations = await deps.runtime.operations.list({ kind: 'detached' });
      const operation = operations.find(entry => entry.externalId === req.params.taskId);
      res.json(operation ? { ...state, operationId: operation.id, status: operation.status } : state);
    });
  }

  return Object.freeze({ mountRoutes });
}

module.exports = { createOrchestrationRoutes };
