'use strict';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[orchestration-routes] dependencies are required');
  if (!deps.records || typeof deps.records.get !== 'function') {
    throw new TypeError('[orchestration-routes] records.get is required');
  }
  const runtimeMethods = [
    'register', 'resolveCallback', 'listForSession', 'stats', 'cancel', 'startDetached',
    'scheduleMessage', 'listScheduledMessages', 'cancelScheduledMessage',
  ];
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
  let mountedHost = false;

  const terminalDispatchStates = new Set([
    'completed', 'failed', 'interrupted', 'cancelled',
  ]);

  function listOperationReferences(query) {
    const operations = deps.runtime.operations;
    return typeof operations.listReferences === 'function'
      ? operations.listReferences(query) : operations.list(query);
  }

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
    const targetId = operation.spec?.targetId || null;
    // Task-bound workers are hidden from the /api/sessions list, so a client
    // cannot resolve their「任务 · …」label from there. Carrying the registry
    // label (and the bound-task marker) on the projection lets the dispatch UI
    // show a friendly name without a second lookup. Absent for ordinary
    // targets keeps the DTO minimal.
    const targetRecord = targetId ? deps.records.get(targetId) : null;
    const remoteMachineId = operation.spec?.remoteMachineId || '';
    const targetLabel = (targetRecord && typeof targetRecord.label === 'string' && targetRecord.label)
      || (remoteMachineId && typeof operation.spec?.targetLabel === 'string' ? operation.spec.targetLabel : '');
    return {
      operationId: operation.id,
      status: operation.status,
      terminal,
      relation: operation.ownerSessionId === sessionId
        ? (operation.spec?.chatId === sessionId ? 'self' : 'owner') : 'target',
      ownerSessionId: operation.ownerSessionId,
      targetSessionId: targetId,
      ...(targetLabel ? { targetLabel } : {}),
      ...(targetRecord && typeof targetRecord.taskBoundTaskId === 'string' && targetRecord.taskBoundTaskId
        ? { targetTaskBoundTaskId: targetRecord.taskBoundTaskId } : {}),
      ...(remoteMachineId ? {
        machineId: remoteMachineId,
        ...(operation.spec?.remoteMachineName ? { machineName: operation.spec.remoteMachineName } : {}),
        ...(operation.spec?.remoteOperationId ? { remoteOperationId: operation.spec.remoteOperationId } : {}),
      } : {}),
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

  function assertApp(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
        || typeof app.delete !== 'function') {
      throw new TypeError('[orchestration-routes] Express-compatible app is required');
    }
  }

  // All sixteen routes the Rust front door answers (native/gateway/src/app/
  // orchestration_routes.rs): scheduled messages, both waits listings, observed
  // tasks, dispatch recovery, user-input dismiss, the FIFO queue, the wait
  // injector (register / resolve / cancel) and the detached set. They are
  // mounted only on the host port's capture app (src/routes/
  // orchestration-host.js) -- this module no longer touches the public Express
  // app, so there is no second place a status code or key order could drift.
  function mountHostRoutes(app) {
    assertApp(app);
    if (mountedHost) throw new Error('[orchestration-routes] host routes already mounted');
    mountedHost = true;

    app.post('/api/sessions/:id/scheduled-messages', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      const body = req.body || {};
      try {
        const scheduledMessage = await deps.runtime.scheduleMessage({
          sessionId: session.id,
          message: body.message ?? body.text,
          delaySeconds: body.delaySeconds ?? body.delaySec,
          clientScheduleId: req.get('Idempotency-Key') || body.clientScheduleId,
        });
        res.status(scheduledMessage.duplicate ? 200 : 201).json({
          ok: true,
          duplicate: !!scheduledMessage.duplicate,
          scheduledMessage,
        });
      } catch (error) {
        res.status(error.statusCode || 400).json({
          ok: false,
          code: error.code || 'invalid_scheduled_message',
          error: error.message,
        });
      }
    });

    app.get('/api/sessions/:id/scheduled-messages', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      try {
        const scheduledMessages = await deps.runtime.listScheduledMessages(session.id);
        res.json({ ok: true, scheduledMessages, count: scheduledMessages.length });
      } catch (error) {
        res.status(500).json({ ok: false, code: 'scheduled_message_list_failed', error: error.message });
      }
    });

    app.delete('/api/sessions/:id/scheduled-messages/:messageId', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found', code: 'session_not_found' });
      try {
        const result = await deps.runtime.cancelScheduledMessage(session.id, req.params.messageId);
        const status = result.ok ? 200 : result.code === 'not_found' ? 404 : 409;
        res.status(status).json({
          ...result,
          ...(result.ok ? {} : { error: result.code || 'scheduled message cannot be cancelled' }),
        });
      } catch (error) {
        res.status(400).json({ ok: false, code: 'scheduled_message_cancel_failed', error: error.message });
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

    app.get('/api/sessions/:id/tasks', async (req, res) => {
      const session = deps.records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      try {
        const tasks = req.query.taskIds === undefined
          ? await deps.runtime.operations.listTasks({ sessionId: session.id })
          : await deps.runtime.operations.taskActivity({ sessionId: session.id, taskIds: req.query.taskIds });
        res.json({ tasks, count: tasks.length });
      } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
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
        const related = (await listOperationReferences({ kind: 'dispatch' }))
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

    if (deps.dismissUserInput) app.post('/api/sessions/:id/user-input/dismiss', async (req, res) => {
      if (!deps.records.get(req.params.id)) return res.status(404).json({ error: 'session_not_found' });
      const requestId = req.body?.requestId;
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 160) {
        return res.status(400).json({ error: 'request_id_required' });
      }
      try {
        const result = await deps.dismissUserInput(req.params.id, requestId.trim());
        return res.status(result.ok ? 200 : 409).json(result);
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
      if (!['retry', 'resume', 'skip', 'cancel', 'cancel_queued', 'insert_queued',
        'reorder_queued', 'edit_queued', 'resolve'].includes(action)) {
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
        if (action === 'reorder_queued') {
          // Ordering only. No cancel and no tick: the entry that is running
          // stays running, and nothing is promoted — the queue keeps draining
          // in whatever order the user settled on.
          const result = await deps.runtime.sessionScheduler.reorderQueued(
            session.id,
            body.entryId,
            {
              toIndex: body.toIndex ?? null,
              direction: body.direction ?? null,
              actor: 'user',
            },
          );
          const status = result.ok ? 200
            : result.code === 'queued_entry_not_found' ? 404 : 409;
          return res.status(status).json(result);
        }
        if (action === 'edit_queued') {
          // 改一条还没开始执行的暂存消息正文：客户端双击那条消息弹出输入框，
          // 改完交到这里。正文会随下一次 schedule 广播同步回所有端。
          const result = await deps.runtime.sessionScheduler.editQueued(
            session.id,
            body.entryId,
            {
              text: body.text,
              actor: 'user',
            },
          );
          const status = result.ok ? 200
            : result.code === 'queued_entry_not_found' ? 404
              : result.code === 'queued_entry_text_required' ? 400 : 409;
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
            let schedule = await deps.runtime.sessionScheduler.status(session.id);
            // "Insert now" must also be honest. A host veto (busy workspace,
            // delivery lock) silently skips the promoted entry on this tick;
            // without verification the API answered 200 while nothing ran.
            // Re-tick briefly to ride out sub-second handoffs, then report
            // the hold with reasons instead of pretending the insert worked.
            const entryHeld = s => s?.active?.entryId !== body.entryId
              && (s?.queued || []).some(q => q.entryId === body.entryId);
            for (let attempt = 0; entryHeld(schedule) && attempt < 5; attempt += 1) {
              await new Promise(resolve => setTimeout(resolve, 500));
              await deps.runtime.tick();
              schedule = await deps.runtime.sessionScheduler.status(session.id);
            }
            // A cancel that did not free the slot is not the end of the story:
            // the promoted entry is still held, and the usual cause is a
            // completed turn's workspace lease pinned by background work the host
            // can no longer stop. "Insert now" already asked for the current work
            // to be interrupted, so escalate — kill the writer — and re-tick.
            if (entryHeld(schedule) && typeof deps.unstickBlocked === 'function') {
              result.unstick = await deps.unstickBlocked(session.id, { source: 'insert_queued', trusted: true });
              for (let attempt = 0; entryHeld(schedule) && attempt < 5; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
                await deps.runtime.tick();
                schedule = await deps.runtime.sessionScheduler.status(session.id);
              }
            }
            result.schedule = schedule;
            const delivery = await deps.runtime.outbox?.get?.(body.entryId);
            result.started = delivery?.state === 'delivered'
              || (schedule?.active?.entryId === body.entryId && !!schedule.active.startedAt);
            if (delivery?.state === 'dead-letter' || delivery?.state === 'cancelled') {
              result.ok = false;
              result.code = 'queue_delivery_failed';
              result.error = delivery.lastError || delivery.state;
              result.retryable = false;
            }
            if (!result.started) {
              result.holdReasons = typeof deps.busyReasons === 'function'
                ? deps.busyReasons(session.id) : [];
            }
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
          // A cancel reports ok when there was no runner left to stop, which is
          // also what a session wedged on a workspace lease looks like. Report
          // the escalation when something really is waiting behind it (the
          // admission side owns that check and stays silent otherwise) instead of
          // answering "cancelled" while the user's next message never arrives.
          if (result.ok && typeof deps.unstickBlocked === 'function') {
            result.unstick = await deps.unstickBlocked(session.id, { source: 'manual_cancel' });
          }
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

    // The wait injector and detached set joined in the second batch. Their
    // handlers are unchanged from the day they were public: the front door
    // matches the path, decodes `:id` / `:wid` / `:taskId`, forwards the
    // `token` query key plus the `host` and `x-wait-token` headers, and
    // replays whatever `res.status/json` these produce.
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
          ...(body.dedupeKey === undefined ? {} : { dedupeKey: body.dedupeKey }),
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
          dispatchEndpoint: null,
          note: '已启动后台 shell 进程；这不会向 worker 会话派活。如需派活，请在发起会话内使用 MultiCC Router MCP 的 route_task 或 dispatch_master。',
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
      const operations = await listOperationReferences({
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

    app.get('/api/detached/:taskId', async (req, res) => {
      const state = deps.detached.status(req.params.taskId);
      if (!state) return res.status(404).json({ error: 'task not found' });
      const operations = await listOperationReferences({ kind: 'detached' });
      const operation = operations.find(entry => entry.externalId === req.params.taskId);
      res.json(operation ? { ...state, operationId: operation.id, status: operation.status } : state);
    });

    // ── Cross-machine dispatch host-port ops (served behind Rust gateway /api/cross-machine/*) ──
    const remoteSyncUnsubscribers = new Map();
    const buildRemoteReceiptPayload = (operation, resettle = false) => ({
      operationId: operation.id,
      status: operation.status,
      terminal: terminalDispatchStates.has(operation.status),
      result: operation.result && typeof operation.result === 'object' ? operation.result : {},
      lastError: operation.lastError || null,
      settle: Number(operation.resultSettles || 1),
      resettle: resettle === true,
      targetSessionId: operation.spec?.targetId || null,
      targetLabel: operation.spec?.targetLabel || '',
      executionSessionId: operation.spec?.chatId || operation.spec?.targetId || null,
      taskId: operation.spec?.taskId || null,
      completedAt: operation.completedAt || operation.updatedAt || Date.now(),
    });

    const formatRemoteDispatchText = (body, grant) => {
      const mode = String(body.mode || 'none');
      const opId = String(body.operationId || '');
      const masterName = String(grant.name || grant.ownerId || 'remote');
      const masterLabel = String(body.masterLabel || body.masterSessionId || 'remote-session');
      const verb = mode === 'none' ? 'Dispatched from machine' : 'Dispatched (two-way) from machine';
      let text = `[${verb} "${masterName}" by: ${masterLabel}${body.masterSessionId ? ` · ${body.masterSessionId}` : ''}]\n\n${String(body.message || '')}`;
      if (mode === 'async') {
        text += [
          '',
          '---',
          '[Receipt required] When this task is done, you must call the dispatch_slave tool to return the result:',
          `dispatch_slave({operation_id:"${opId}", result:"<summary of conclusion / changes / evidence / risks>", status:"completed"})`,
          'Use status:"failed" on failure. Without a receipt the master never receives the result: as soon as the dispatched turn ends, the system marks the operation failed automatically;',
          'you can still submit a late receipt any time with the operation_id above and the system corrects the record. The operation_id is stable across turns',
          'and remains valid no matter how many times the task is interrupted or continued.',
          'This is an async receipt: do not poll, read, or wait on the master session.',
        ].join('\n');
      } else if (mode === 'sync') {
        text += [
          '',
          '---',
          '[Sync relay] The host is streaming the reasoning/thinking this turn emits explicitly, plus safe dialogue progress, straight back to the dispatcher.',
          'Just complete the task normally and give your final answer; no receipt tool call is needed.',
        ].join('\n');
      }
      return text;
    };

    app.get('/api/cross-machine/targets', (req, res) => {
      if (!req.grant?.ownerId) return res.status(403).json({ ok: false, code: 'machine_grant_required', error: 'grant required' });
      const dirList = typeof deps.listDirectories === 'function' ? deps.listDirectories() : [];
      const dirNames = new Map(dirList.map(d => [d.id, d.name || d.path || d.id]));
      const sessions = [];
      for (const [id, rec] of deps.records.entries()) {
        if (!rec || ['aux', 'gateway', 'commander'].includes(rec.type)) continue;
        if (rec.taskExecutionSlot === true || rec.archived === true) continue;
        if (rec.kind === 'chat' && typeof id === 'string' && id.endsWith('-gw-chat')) continue;
        sessions.push({
          id,
          label: rec.label || rec.name || id,
          kind: rec.kind || 'chat',
          cli: rec.cli || null,
          dirId: rec.dirId || null,
          dirName: rec.dirId ? (dirNames.get(rec.dirId) || null) : null,
          busy: typeof deps.isTargetBusy === 'function' ? !!deps.isTargetBusy(id) : false,
          ...(rec.taskBoundTaskId ? { taskId: rec.taskBoundTaskId } : {}),
        });
        if (sessions.length >= 60) break;
      }
      return res.json({
        ok: true,
        directories: dirList.slice(0, 40).map(d => ({ id: d.id, name: d.name || d.path || d.id, path: d.path || null })),
        sessions,
      });
    });

    app.post('/api/cross-machine/dispatches', async (req, res) => {
      const grant = req.grant;
      if (!grant?.ownerId) return res.status(403).json({ ok: false, code: 'machine_grant_required', error: 'grant required' });
      if (typeof deps.dispatchToSession !== 'function') {
        return res.status(503).json({ ok: false, code: 'dispatch_unavailable', error: 'remote dispatch is not configured on this host' });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const mode = String(body.mode || '');
      const operationId = String(body.operationId || '').trim();
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      if (!operationId || !idempotencyKey || !['none', 'sync', 'async'].includes(mode)) {
        return res.status(400).json({ ok: false, code: 'invalid_payload', error: 'operationId, idempotencyKey and mode are required' });
      }
      let targetId = typeof body.targetSessionId === 'string' ? body.targetSessionId.trim() : '';
      let createdTaskId = null;
      try {
        if (!targetId && body.newTask && typeof body.newTask === 'object') {
          if (typeof deps.createTask !== 'function') {
            return res.status(503).json({ ok: false, code: 'task_create_unavailable', error: 'new_task is not supported on this host' });
          }
          const dirList = typeof deps.listDirectories === 'function' ? deps.listDirectories() : [];
          const dirId = String(body.newTask.dirId || body.newTask.dir_id || dirList[0]?.id || '').trim();
          if (!dirId) {
            return res.status(400).json({ ok: false, code: 'dir_id_required', error: '目标电脑上没有可用工作目录，请在 new_task.dir_id 指定目录' });
          }
          const created = await deps.createTask({
            dirId,
            title: String(body.newTask.title || '').trim(),
            cli: body.newTask.cli || undefined,
            model: body.newTask.model || undefined,
            provider: body.newTask.provider || undefined,
            effort: body.newTask.effort || undefined,
            clientMsgId: `cm_${grant.ownerId.slice(0, 12)}_${operationId}`,
          });
          if (!created?.sessionId) {
            return res.status(500).json({ ok: false, code: 'task_create_failed', error: 'failed to create remote task session' });
          }
          targetId = created.sessionId;
          createdTaskId = created.taskId || null;
        }
        const target = targetId ? deps.records.get(targetId) : null;
        if (!target) return res.status(404).json({ ok: false, code: 'target_not_found', error: `target session "${targetId}" was not found` });
        if (['aux', 'gateway', 'commander'].includes(target.type)) {
          return res.status(403).json({ ok: false, code: 'target_forbidden', error: `cannot dispatch to ${target.type} session "${targetId}"` });
        }
        if (target.kind === 'terminal' && body.allowTerminal !== true) {
          return res.status(403).json({ ok: false, code: 'terminal_requires_opt_in', error: `target "${targetId}" is a terminal session; pass allow_terminal=true` });
        }
        const delivered = formatRemoteDispatchText(body, grant);
        const ownerSessionId = `__remote_machine__:${grant.ownerId}`;
        const result = await deps.dispatchToSession(targetId, delivered, {
          ownerSessionId,
          replyTo: null,
          oneWay: mode === 'none',
          resultMode: mode,
          requireIdle: false,
          idempotencyKey: `cm:${grant.ownerId}:${idempotencyKey}`,
          operationId,
          remoteMaster: {
            machineId: grant.ownerId,
            grantId: grant.id,
            name: grant.name || grant.ownerId,
            ownerSessionId: String(body.masterSessionId || ''),
          },
        });
        if (!result || result.ok !== true) {
          return res.status(409).json({
            ok: false,
            code: result?.code || 'dispatch_rejected',
            error: result?.error || 'dispatch rejected on remote machine',
          });
        }
        if (mode === 'sync' && typeof deps.subscribeDispatchProgress === 'function' && typeof deps.notifyRemoteEvent === 'function') {
          const prev = remoteSyncUnsubscribers.get(result.operationId);
          if (typeof prev === 'function') { try { prev(); } catch (_) {} }
          const unsub = deps.subscribeDispatchProgress({
            operationId: result.operationId,
            targetSessionId: targetId,
            onProgress: progress => {
              deps.notifyRemoteEvent({
                masterMachineId: grant.ownerId,
                event: 'progress',
                payload: { operationId: result.operationId, progress },
              });
            },
          });
          if (typeof unsub === 'function') remoteSyncUnsubscribers.set(result.operationId, unsub);
        }
        return res.json({
          ok: true,
          operationId: result.operationId,
          status: result.status || 'admitted',
          targetSessionId: targetId,
          targetLabel: target.label || target.name || '',
          executionSessionId: result.chatId || targetId,
          taskId: result.taskId || createdTaskId || target.taskBoundTaskId || null,
          duplicate: result.duplicate === true,
          queue: result.queue || null,
        });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : (error?.code === 'OPERATION_CONFLICT' ? 409 : 500);
        return res.status(status).json({
          ok: false,
          code: error?.code || 'cross_machine_admit_failed',
          error: error?.message || String(error),
        });
      }
    });

    app.get('/api/cross-machine/dispatches/:opId', async (req, res) => {
      const grant = req.grant;
      if (!grant?.ownerId) return res.status(403).json({ ok: false, code: 'machine_grant_required', error: 'grant required' });
      const op = await deps.runtime.operations.get(req.params.opId);
      if (!op || op.kind !== 'dispatch' || op.spec?.remoteMasterMachineId !== grant.ownerId) {
        return res.status(404).json({ ok: false, code: 'dispatch_not_found', error: 'remote dispatch not found' });
      }
      const chatId = op.spec?.chatId || op.spec?.targetId || null;
      const schedule = chatId && deps.runtime.sessionScheduler
        ? await deps.runtime.sessionScheduler.status(chatId).catch(() => null) : null;
      const entryId = op.requestOutboxId || `operation:${op.id}:request`;
      const queued = (schedule?.queued || []).find(item => item.entryId === entryId);
      const started = !!schedule?.active && (schedule.active.entryId === entryId || schedule.active.deliveryId === entryId);
      const terminal = terminalDispatchStates.has(op.status);
      const queueState = terminal ? 'terminal' : queued ? 'queued' : started ? 'started' : (op.status === 'running' ? 'running' : 'unknown');
      return res.json({
        ok: true,
        dispatch: {
          ...buildRemoteReceiptPayload(op, false),
          queueState,
          ...(queued && Number.isFinite(queued.position) ? { queuePosition: queued.position } : {}),
          ...(queued ? { queueLength: (schedule?.queued || []).length } : {}),
          createdAt: op.createdAt || null,
          startedAt: op.startedAt || null,
          updatedAt: op.updatedAt || null,
        },
      });
    });

    app.post('/api/cross-machine/dispatches/:opId/cancel', async (req, res) => {
      const grant = req.grant;
      if (!grant?.ownerId) return res.status(403).json({ ok: false, code: 'machine_grant_required', error: 'grant required' });
      const opId = req.params.opId;
      const op = await deps.runtime.operations.get(opId);
      if (!op || op.kind !== 'dispatch' || op.spec?.remoteMasterMachineId !== grant.ownerId) {
        return res.status(404).json({ ok: false, code: 'dispatch_not_found', error: 'remote dispatch not found' });
      }
      if (terminalDispatchStates.has(op.status)) {
        return res.json({ ok: true, operationId: opId, status: op.status, alreadyTerminal: true });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const reason = String(body.reason || 'cancelled by remote dispatcher').slice(0, 500);
      const chatId = op.spec?.chatId || op.spec?.targetId;
      const entryId = op.requestOutboxId || `operation:${opId}:request`;
      const finishCancel = async (disposition) => {
        const unsub = remoteSyncUnsubscribers.get(opId);
        if (typeof unsub === 'function') { remoteSyncUnsubscribers.delete(opId); try { unsub(); } catch (_) {} }
        const settled = await deps.runtime.operations.cancelDispatch(opId, { reason, disposition });
        if (typeof deps.onDispatchCancelled === 'function') { try { deps.onDispatchCancelled(opId); } catch (_) {} }
        if (settled?.operation && typeof deps.notifyRemoteEvent === 'function') {
          deps.notifyRemoteEvent({
            masterMachineId: grant.ownerId,
            event: 'receipt',
            payload: buildRemoteReceiptPayload(settled.operation, false),
          });
        }
        return res.json({
          ok: true,
          operationId: opId,
          status: settled?.raced ? settled.status : 'cancelled',
          alreadyTerminal: settled?.raced === true,
          disposition,
        });
      };
      if (deps.runtime.sessionScheduler) {
        const removed = await deps.runtime.sessionScheduler.cancelQueued(chatId, entryId, { actor: `remote:${grant.ownerId}`, reason });
        if (removed?.ok) return finishCancel('queued');
        const schedule = await deps.runtime.sessionScheduler.status(chatId).catch(() => null);
        const active = schedule?.active || null;
        if (active && (active.entryId === entryId || active.deliveryId === entryId)) {
          if (body.cancelRunning !== true && body.cancel_running !== true) {
            return res.status(409).json({
              ok: false,
              code: 'already_running',
              error: 'the task already left the FIFO and is running on the remote target; pass cancel_running=true to interrupt that turn',
            });
          }
          if (typeof deps.cancelActiveTurn !== 'function') {
            return res.status(503).json({ ok: false, code: 'cancel_unavailable', error: 'running-turn cancellation unavailable' });
          }
          await deps.cancelActiveTurn(chatId, { source: 'dispatch_cancel', reason });
          return finishCancel('running');
        }
      }
      return finishCancel('untrackable');
    });

    app.post('/api/cross-machine/receipts/ack', async (req, res) => {
      const grant = req.grant;
      if (!grant?.ownerId) return res.status(403).json({ ok: false, code: 'machine_grant_required', error: 'grant required' });
      const opId = String(req.params.opId || req.body?.operationId || '').trim();
      const op = opId ? await deps.runtime.operations.get(opId) : null;
      if (!op || op.kind !== 'dispatch' || op.spec?.remoteMasterMachineId !== grant.ownerId) {
        return res.status(404).json({ ok: false, code: 'dispatch_not_found', error: 'remote dispatch not found' });
      }
      const settle = Math.max(1, Number(req.settle ?? req.body?.settle ?? 1) || 1);
      const unsub = remoteSyncUnsubscribers.get(opId);
      if (typeof unsub === 'function') { remoteSyncUnsubscribers.delete(opId); try { unsub(); } catch (_) {} }
      const acked = typeof deps.runtime.operations.ackRemoteReceipt === 'function'
        ? await deps.runtime.operations.ackRemoteReceipt(opId, settle)
        : { ok: true, ackedSettle: settle };
      return res.json({ ok: true, operationId: opId, ackedSettle: acked.ackedSettle || settle });
    });

    app.get('/api/cross-machine/receipts/pending', async (req, res) => {
      const grant = req.grant;
      if (!grant?.ownerId) return res.status(403).json({ ok: false, code: 'machine_grant_required', error: 'grant required' });
      const ownerSessionId = `__remote_machine__:${grant.ownerId}`;
      const refs = await listOperationReferences({ kind: 'dispatch', ownerSessionId });
      const receipts = [];
      for (const ref of refs) {
        if (!terminalDispatchStates.has(ref.status)) continue;
        const settles = Number(ref.resultSettles || 1);
        const acked = Number(ref.remoteReceiptAckedSettle || 0);
        if (acked >= settles) continue;
        const full = await deps.runtime.operations.get(ref.id);
        if (!full || full.spec?.remoteMasterMachineId !== grant.ownerId) continue;
        receipts.push(buildRemoteReceiptPayload(full, settles > 1));
        if (receipts.length >= 100) break;
      }
      return res.json({ ok: true, receipts });
    });
  }

  return Object.freeze({ mountHostRoutes });
}

module.exports = { createOrchestrationRoutes };
