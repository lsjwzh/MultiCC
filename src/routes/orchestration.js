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

  const terminalDispatchStates = new Set([
    'completed', 'failed', 'interrupted', 'cancelled',
  ]);

  function projectDispatch(operation, sessionId, schedule) {
    const entryId = operation.requestOutboxId || `operation:${operation.id}:request`;
    const queued = (schedule?.queued || []).find(item => item.entryId === entryId);
    const started = !!schedule?.active
      && (schedule.active.entryId === entryId || schedule.active.deliveryId === entryId);
    const terminal = terminalDispatchStates.has(operation.status);
    const queueState = terminal ? 'terminal'
      : queued ? 'queued'
        : started ? 'started'
          : operation.status === 'running' ? 'running' : 'unknown';
    return {
      operationId: operation.id,
      status: operation.status,
      terminal,
      relation: operation.ownerSessionId === sessionId
        ? (operation.spec?.chatId === sessionId ? 'self' : 'owner') : 'target',
      ownerSessionId: operation.ownerSessionId,
      targetSessionId: operation.spec?.targetId || null,
      executionSessionId: operation.spec?.chatId || operation.spec?.targetId || null,
      taskId: operation.spec?.taskId || null,
      mode: operation.spec?.resultMode || (operation.spec?.oneWay ? 'one_way' : null),
      queueState,
      ...(queued && Number.isFinite(queued.position)
        ? { queuePosition: queued.position } : {}),
      // Queue depth when this operation is itself queued — the UI shows
      // 「第 N 位（共 M 条）」 so the user can tell a deep queue from position 1.
      // Only present while queued; absent otherwise keeps the DTO minimal.
      ...(queued ? { queueLength: (schedule?.queued || []).length } : {}),
      createdAt: operation.createdAt || null,
      startedAt: operation.startedAt || null,
      completedAt: operation.completedAt || null,
      updatedAt: operation.updatedAt || null,
    };
  }

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
          ...((body.delaySec ?? body.delaySeconds) == null
            ? {} : { delaySec: body.delaySec ?? body.delaySeconds }),
          ...(body.reason == null ? {} : { reason: body.reason }),
        });
        const callbackUrl = registration.token
          ? `${req.protocol}://${req.get('host')}/api/wait/${registration.id}/resolve?token=${registration.token}`
          : null;
        res.json({
          ok: true,
          ...registration,
          callbackUrl,
          status: registration.status || 'pending',
          dueAt: registration.dueAt || null,
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
          executionKind: 'detached_process',
          workerDispatched: false,
          dispatchEndpoint: `/api/sessions/${session.id}/dispatch`,
          note: `已启动后台 shell 进程；这不会向 worker 会话派活。如需派活，请调用 POST /api/sessions/${session.id}/dispatch。`,
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

    // Session process flags (active/streaming/clients) are not task truth. This
    // recovery view joins the durable dispatch operation with the target FIFO
    // so a human or Commander can distinguish queued, running and terminal work
    // after a transport error without reading chat output or repository state.
    app.get('/api/sessions/:id/dispatches', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      try {
        const relation = String(req.query.relation || 'both');
        if (!['both', 'owner', 'target'].includes(relation)) {
          return res.status(400).json({ error: 'invalid relation' });
        }
        const activeOnly = req.query.activeOnly !== 'false';
        let recentTerminalLimit = null;
        if (req.query.recentTerminalLimit != null) {
          const rawRecent = String(req.query.recentTerminalLimit);
          if (!/^\d+$/.test(rawRecent)) {
            return res.status(400).json({ error: 'recentTerminalLimit must be an integer between 0 and 20' });
          }
          recentTerminalLimit = Number(rawRecent);
          if (!Number.isInteger(recentTerminalLimit)
              || recentTerminalLimit < 0 || recentTerminalLimit > 20) {
            return res.status(400).json({ error: 'recentTerminalLimit must be an integer between 0 and 20' });
          }
        }
        const related = (await deps.runtime.operations.list({ kind: 'dispatch' }))
          .filter(operation => {
            const owner = operation.ownerSessionId === session.id;
            const target = operation.spec?.chatId === session.id
              || operation.spec?.targetId === session.id;
            if (relation === 'owner') return owner;
            if (relation === 'target') return target;
            return owner || target;
          })
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        const active = related.filter(operation => !terminalDispatchStates.has(operation.status));
        const terminal = related.filter(operation => terminalDispatchStates.has(operation.status));
        // `recentTerminalLimit=N` is an additive history view: return up to 100
        // live rows plus the explicitly bounded terminal tail, so a completion
        // burst cannot evict live work. Without the option, preserve the
        // historical 100-row endpoint shape.
        const activeLimit = 100;
        const returnedActive = active.slice(0, activeLimit);
        const returnedTerminal = recentTerminalLimit == null ? [] : [...terminal]
          .sort((a, b) => {
            const aAt = a.completedAt || a.updatedAt || a.createdAt || 0;
            const bAt = b.completedAt || b.updatedAt || b.createdAt || 0;
            return bAt - aAt || b.id.localeCompare(a.id);
          })
          .slice(0, recentTerminalLimit);
        const operations = activeOnly
          ? returnedActive
          : recentTerminalLimit == null
            ? related.slice(0, activeLimit)
            : [...returnedActive, ...returnedTerminal];
        const schedules = new Map();
        if (deps.runtime.sessionScheduler) {
          const targets = [...new Set(operations
            .map(operation => operation.spec?.chatId || operation.spec?.targetId)
            .filter(Boolean))];
          await Promise.all(targets.map(async targetId => {
            try {
              schedules.set(targetId, await deps.runtime.sessionScheduler.status(targetId));
            } catch (_) { schedules.set(targetId, null); }
          }));
        }
        const dispatches = operations.map(operation => {
          const targetId = operation.spec?.chatId || operation.spec?.targetId;
          return projectDispatch(operation, session.id, schedules.get(targetId));
        });
        return res.json({
          ok: true,
          sessionId: session.id,
          activeOnly,
          dispatches,
          count: dispatches.length,
          ...(recentTerminalLimit == null ? {} : {
            activeCount: active.length,
            activeTruncated: active.length > returnedActive.length,
            terminalCount: terminal.length,
            returnedTerminalCount: dispatches.filter(item => item.terminal).length,
            recentTerminalLimit,
          }),
          authoritative: 'durable_operation_plus_target_fifo',
          note: 'active/streaming/clients are process-presence signals, not dispatch completion.',
        });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    });

    if (deps.runtime.sessionScheduler) app.get('/api/sessions/:id/queue', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      try {
        const queue = await deps.runtime.sessionScheduler.status(session.id);
        res.json({ ok: true, queue });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    if (deps.runtime.sessionScheduler) app.post('/api/sessions/:id/queue/action', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const body = req.body || {};
      const action = String(body.action || '').trim();
      if (!['retry', 'resume', 'skip', 'cancel', 'cancel_queued', 'insert_queued', 'resolve'].includes(action)) {
        return res.status(400).json({ error: 'invalid_action' });
      }
      if (body.confirm !== true) {
        return res.status(409).json({
          error: 'confirmation_required',
          note: 'This action changes the active task and may advance the FIFO queue.',
        });
      }
      try {
        if (action === 'cancel_queued') {
          const result = await deps.runtime.sessionScheduler.cancelQueued(
            session.id,
            body.entryId,
            { actor: 'user', reason: body.reason },
          );
          if (result.ok) await deps.runtime.tick();
          const status = result.ok ? 200
            : result.code === 'queued_entry_not_found' ? 404 : 409;
          return res.status(status).json(result);
        }
        if (action === 'insert_queued') {
          const result = await deps.runtime.sessionScheduler.insertQueued(
            session.id,
            body.entryId,
            { actor: 'user' },
          );
          if (result.ok) {
            // "Insert now" is literal: stop/release the current turn (recording
            // E) and let the selected directRun entry claim the slot at once.
            if (typeof deps.cancelActiveTurn === 'function') {
              await deps.cancelActiveTurn(session.id, {
                source: 'insert_queued', reason: 'insert_queued',
              });
            }
            await deps.runtime.tick();
            // The schedule snapshot from the mutate above is definitionally
            // stale here: the tick just claimed the selected entry. Returning
            // it would re-advertise a started entry as still queued, and a
            // client that applies the HTTP schedule (the Flutter app) would
            // resurrect the FIFO card until refresh. Re-read the authoritative
            // post-tick schedule so the response matches what tick already
            // broadcast over WS. This read happens after those broadcasts, so
            // it can never be older than them.
            result.schedule = await deps.runtime.sessionScheduler.status(session.id);
          }
          const status = result.ok ? 200
            : result.code === 'queued_entry_not_found' ? 404 : 409;
          return res.status(status).json(result);
        }
        if (action === 'cancel') {
          // Manual cancel is an intent, not a state write: the host stops the
          // runner and submits a structured result to classify, which is the
          // only writer of session/task business state. The controller must NOT
          // also call resolve() afterwards — that used to overwrite the E
          // verdict with D, and (because cancelActiveTurn had already cleared
          // the active entry) answered a successful cancel with HTTP 404.
          if (typeof deps.cancelActiveTurn !== 'function') {
            return res.status(409).json({ ok: false, code: 'cancel_unsupported' });
          }
          const result = await deps.cancelActiveTurn(session.id, {
            source: 'manual_cancel',
            reason: body.reason || 'user_cancelled',
            operationId: req.get('Idempotency-Key') || body.idempotencyKey || body.operationId || null,
          });
          // No tick(): a cancel does not advance the FIFO. Only a D verdict
          // drains the queue, and that policy lives in the scheduler.
          const status = result.ok ? 200
            : result.code === 'session_not_found' ? 404 : 409;
          return res.status(status).json(result);
        }
        const result = await deps.runtime.sessionScheduler.resolve(session.id, {
          action,
          reason: body.reason,
          actor: 'user',
          text: body.text,
          idempotencyKey: req.get('Idempotency-Key') || body.idempotencyKey || null,
        });
        if (result.ok) await deps.runtime.tick();
        const status = result.ok ? 200
          : result.code === 'no_active_task' ? 404 : 409;
        res.status(status).json(result);
      } catch (error) {
        res.status(400).json({ error: error.message });
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
