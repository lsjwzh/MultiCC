'use strict';

// End-to-end cross-machine dispatch_master / route_task / dispatch_slave test:
// Master (Machine A, behind NAT with NO listening server) <-> Slave (Machine B,
// fronted by an HTTP+SSE server implementing the exact Rust gateway contract
// + real orchestrationHost + real orchestrationRoutes + real Rust SQLite
// orchestrationRuntime + real routerToolRuntime on both sides).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { getNative, orchestrationHost } = require('../src/native/binding');
const { createProductionQuestionHost } = require('../src/session-work');
const { createRouterToolRuntime } = require('../src/router-tool-runtime');
const { createOrchestrationRoutes } = require('../src/routes/orchestration');
const { createOrchestrationHost } = require('../src/routes/orchestration-host');

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, timeoutMs = 6000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Spins up a real Slave (Machine B) server with:
 *   - real machines.json grant verification via Rust `authorizeMachineGrant`
 *   - real `orchestrationRuntime` (Rust SQLite + `ackRemoteReceipt` + 3-arg `completeDispatch`)
 *   - real `createOrchestrationHost` + `createOrchestrationRoutes`
 *   - real `createRouterToolRuntime` (so Slave workers call genuine `dispatch_slave`!)
 *   - real SSE `/api/cross-machine/receipts/stream` with catch-up replay + live push
 */
async function startSlavePeer(rootDir) {
  const native = getNative();
  const selfRes = JSON.parse(await native.machineOperation(rootDir, 'self', '{}'));
  const selfMachine = selfRes.data;

  const records = new Map([
    ['slave-chat-1', { id: 'slave-chat-1', label: 'MacPro Worker #1', kind: 'chat', cli: 'codex', dirId: 'dir_remote' }],
    ['slave-chat-2', { id: 'slave-chat-2', label: 'MacPro Worker #2', kind: 'chat', cli: 'claude', dirId: 'dir_remote' }],
  ]);
  const directories = [{ id: 'dir_remote', name: 'multicc-macpro', path: '/remote/multicc' }];
  const deliveredToSlave = [];
  const slavePersistedIds = new Set();
  const sseClients = new Set();
  const progressListeners = new Map();
  let busySession = null;
  let cancelledActive = [];

  function publishEvent(event) {
    const frame = `event: ${event.event}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of sseClients) {
      if (client.ownerId === event.masterMachineId) {
        try { client.res.write(frame); } catch (_) {}
      }
    }
  }

  let slaveOrch;
  let slaveQuestionHost;
  slaveOrch = orchestrationHost.createOrchestrationRuntime({
    file: path.join(rootDir, 'orchestration.json'),
    databaseFile: path.join(rootDir, 'orchestration.sqlite'),
    ensureSessionWorkState: id => slaveQuestionHost?.pendingAsync(id),
    runChatTurn: async (sessionId, text, opts) => {
      deliveredToSlave.push({ sessionId, text, opts });
      return { ok: true, accepted: true };
    },
    isBusy: id => busySession === id,
    busyReasons: () => [],
    hasPersistedDelivery: (_id, identity) => {
      const key = typeof identity === 'string' ? identity : (identity?.deliveryId || identity?.clientMsgId || '');
      return !!key && slavePersistedIds.has(key);
    },
    deliverOutbox: async descriptor => {
      const key = descriptor?.opts?.deliveryId || descriptor?.opts?.clientMsgId || '';
      if (key) slavePersistedIds.add(key);
      deliveredToSlave.push({ sessionId: descriptor.sessionId, text: descriptor.text, opts: descriptor.opts });
      setTimeout(async () => {
        if (busySession !== descriptor.sessionId) {
          await slaveOrch.sessionScheduler.turnEnded(descriptor.sessionId).catch(() => {});
          await slaveOrch.sessionScheduler.complete(descriptor.sessionId, { classifyState: 'D' }).catch(() => {});
          await slaveOrch.tick().catch(() => {});
        }
      }, 15);
      return { ok: true, accepted: true };
    },
    onRemoteDispatchSettled: (op, opts) => {
      const masterMachineId = op?.spec?.remoteMasterMachineId;
      if (!masterMachineId) return;
      publishEvent({
        masterMachineId,
        event: 'receipt',
        payload: {
          operationId: op.id,
          status: op.status,
          terminal: true,
          result: op.result && typeof op.result === 'object' ? op.result : {},
          lastError: op.lastError || null,
          settle: Number(op.resultSettles || 1),
          resettle: opts?.resettle === true,
          targetSessionId: op.spec?.targetId || null,
          targetLabel: op.spec?.targetLabel || '',
          executionSessionId: op.spec?.chatId || op.spec?.targetId || null,
          taskId: op.spec?.taskId || null,
          completedAt: op.completedAt || op.updatedAt || Date.now(),
        },
      });
    },
    workerIntervalMs: 50,
    log: () => {},
  });
  slaveQuestionHost = createProductionQuestionHost({
    getStore: () => slaveOrch.store,
    getSession: () => ({ _currentTaskId: null }),
    getState: () => ({ pendingUserInput: null }),
    getRecord: () => ({ unattended: null }),
    setState: () => {},
  }).host;
  await slaveOrch.start();

  const dispatchToSession = async (targetId, message, opts = {}) => {
    const rec = records.get(targetId);
    if (!rec) return { ok: false, code: 'target_not_found', error: 'target not found' };
    const admitted = await slaveOrch.admitDispatch({
      ownerSessionId: opts.ownerSessionId,
      resultSessionId: opts.ownerSessionId,
      idempotencyKey: opts.idempotencyKey || null,
      operationId: opts.operationId || undefined,
      spec: {
        targetId,
        targetLabel: rec.label || '',
        chatId: targetId,
        message,
        replyTo: opts.replyTo || null,
        gateway: false,
        oneWay: !!opts.oneWay,
        resultMode: opts.resultMode || 'none',
        ...(opts.remoteMaster ? {
          remoteMasterMachineId: opts.remoteMaster.machineId,
          remoteMasterGrantId: opts.remoteMaster.grantId,
          remoteMasterName: opts.remoteMaster.name || '',
          remoteMasterSessionId: opts.remoteMaster.ownerSessionId || '',
        } : {}),
      },
    });
    await slaveOrch.tick();
    const schedule = await slaveOrch.sessionScheduler.status(targetId);
    const entryId = `operation:${admitted.id}:request`;
    const queued = (schedule?.queued || []).find(item => item.entryId === entryId);
    return {
      ok: true,
      operationId: admitted.id,
      status: admitted.status,
      chatId: targetId,
      taskId: rec.taskBoundTaskId || null,
      duplicate: admitted.idempotent === true,
      queue: queued ? { state: 'queued', position: queued.position, length: schedule.queued.length } : { state: 'started' },
    };
  };

  let createdSeq = 0;
  const createTask = async input => {
    createdSeq += 1;
    const taskId = `tsk_remote_${createdSeq}`;
    const sessionId = `task-remote-${createdSeq}`;
    records.set(sessionId, {
      id: sessionId,
      label: input.title,
      kind: 'chat',
      cli: input.cli || 'codex',
      dirId: input.dirId,
      taskBoundTaskId: taskId,
    });
    return { taskId, sessionId };
  };

  const subscribeDispatchProgress = ({ operationId, onProgress }) => {
    progressListeners.set(operationId, onProgress);
    return () => progressListeners.delete(operationId);
  };

  const noopPorts = {
    recordUserInput: () => {},
    registerExternalWait: () => ({ ok: false }),
    getExternalWait: () => null,
    listExternalWaits: () => [],
    cancelExternalWait: () => ({ ok: false }),
    subscribeDispatchProgress,
  };

  const slaveRouter = createRouterToolRuntime({
    records,
    dispatchToSession,
    createTask,
    operations: slaveOrch.operations,
    completeDispatch: (id, result, opts) => slaveOrch.completeDispatch(id, result, opts),
    schedulerStatus: id => slaveOrch.sessionScheduler.status(id),
    cancelQueuedEntry: (id, entryId, opts) => slaveOrch.sessionScheduler.cancelQueued(id, entryId, opts),
    ...noopPorts,
    pollIntervalMs: 25,
  });

  const orchHost = createOrchestrationHost({ express });
  const orchRoutes = createOrchestrationRoutes({
    records,
    runtime: slaveOrch,
    waitInjector: { listForSession: () => [], stats: () => ({ waits: 0 }), cancel: () => ({ ok: false }) },
    detached: { status: () => null },
    cwdForSession: () => rootDir,
    resolveCwd: () => rootDir,
    toWaitDto: w => w,
    withApiMeta: (req, body) => body,
    requestContext: () => ({}),
    v1Error: (res, status, code, message) => res.status(status).json({ ok: false, code, error: message }),
    cancelActiveTurn: async (chatId, opts) => { cancelledActive.push({ chatId, opts }); },
    listDirectories: () => directories,
    isTargetBusy: id => busySession === id,
    dispatchToSession,
    createTask,
    subscribeDispatchProgress,
    notifyRemoteEvent: publishEvent,
  });
  orchRoutes.mountHostRoutes(orchHost.app);

  // Express app mirroring the Rust gateway /api/cross-machine/* contract
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function authGrant(req, res) {
    const cred = String(req.headers['x-multicc-machine-grant'] || '');
    const raw = native.authorizeMachineGrant(rootDir, cred, req.method, req.originalUrl);
    if (!raw) {
      res.status(403).json({ ok: false, code: 'machine_grant_required', error: 'grant required' });
      return null;
    }
    return JSON.parse(raw);
  }

  async function runHostOp(op, req, res, extra = {}) {
    const grant = authGrant(req, res);
    if (!grant) return;
    const handlerMap = orchHost.handlers;
    const opMap = {
      'cross-machine-targets': 'GET /api/cross-machine/targets',
      'cross-machine-admit': 'POST /api/cross-machine/dispatches',
      'cross-machine-status': 'GET /api/cross-machine/dispatches/:opId',
      'cross-machine-cancel': 'POST /api/cross-machine/dispatches/:opId/cancel',
      'cross-machine-ack': 'POST /api/cross-machine/receipts/ack',
      'cross-machine-pending-receipts': 'GET /api/cross-machine/receipts/pending',
    };
    const handler = handlerMap.get(opMap[op]);
    let statusCode = 200;
    let payload = null;
    const fakeRes = {
      status(code) { statusCode = code; return this; },
      json(body) { payload = body; return this; },
    };
    await handler({
      method: req.method,
      path: req.path,
      params: { ...req.params, ...(extra.params || {}) },
      query: req.query || {},
      body: req.body || {},
      grant,
      settle: extra.settle,
      headers: req.headers,
    }, fakeRes);
    res.status(statusCode).json(payload);
  }

  app.get('/api/cross-machine/targets', (req, res) => runHostOp('cross-machine-targets', req, res));
  app.post('/api/cross-machine/dispatches', (req, res) => runHostOp('cross-machine-admit', req, res));
  app.get('/api/cross-machine/dispatches/:opId', (req, res) => runHostOp('cross-machine-status', req, res, { params: { opId: req.params.opId } }));
  app.post('/api/cross-machine/dispatches/:opId/cancel', (req, res) => runHostOp('cross-machine-cancel', req, res, { params: { opId: req.params.opId } }));
  app.post('/api/cross-machine/receipts/ack', (req, res) => runHostOp('cross-machine-ack', req, res, {
    params: { opId: req.body?.operationId },
    settle: req.body?.settle,
  }));
  app.get('/api/cross-machine/receipts/stream', async (req, res) => {
    const grant = authGrant(req, res);
    if (!grant) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const client = { ownerId: grant.ownerId, grantId: grant.id, res };
    sseClients.add(client);
    // Catch-up replay
    const handler = orchHost.handlers.get('GET /api/cross-machine/receipts/pending');
    let pendingPayload = null;
    await handler({ grant, params: {}, query: {}, body: {}, headers: req.headers }, {
      status() { return this; },
      json(b) { pendingPayload = b; return this; },
    });
    for (const receipt of pendingPayload?.receipts || []) {
      res.write(`event: receipt\ndata: ${JSON.stringify(receipt)}\n\n`);
    }
    req.on('close', () => sseClients.delete(client));
  });

  // Expose pairing endpoint so Master can pair via real Rust `machines::operate('add')`
  app.post('/api/machines/pair', async (req, res) => {
    const paired = JSON.parse(await native.machineOperation(rootDir, 'pair', JSON.stringify(req.body || {})));
    res.status(paired.status || 200).json(paired.data);
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    rootDir,
    port,
    origin: `http://127.0.0.1:${port}`,
    selfMachine,
    records,
    slaveOrch,
    slaveRouter,
    deliveredToSlave,
    sseClients,
    cancelledActive,
    setBusy: id => { busySession = id; },
    emitProgress: (opId, progress) => {
      const fn = progressListeners.get(opId);
      if (fn) fn(progress);
    },
    disconnectAllSse: () => {
      for (const c of [...sseClients]) {
        try { c.res.end(); } catch (_) {}
      }
      sseClients.clear();
    },
    async close() {
      for (const c of [...sseClients]) { try { c.res.end(); } catch (_) {} }
      sseClients.clear();
      slaveRouter.clear();
      await slaveOrch.stop();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('cross-machine dispatch_master/route_task/dispatch_slave full E2E loop (NAT master -> slave SSE push, late resettle, sync progress, cancel, catch-up)', async t => {
  const masterRoot = tempRoot('multicc-cm-master-');
  const slaveRoot = tempRoot('multicc-cm-slave-');
  const native = getNative();

  const slave = await startSlavePeer(slaveRoot);
  const masterWakeups = [];
  const masterPersistedIds = new Set();
  const masterRecords = new Map([
    ['master-1', { id: 'master-1', label: 'MacBook Commander', kind: 'chat', type: 'commander', dirId: 'dir_local' }],
    ['local-worker', { id: 'local-worker', label: 'Local Worker', kind: 'chat', dirId: 'dir_local' }],
  ]);

  let masterQuestionHost;
  const masterOrch = orchestrationHost.createOrchestrationRuntime({
    file: path.join(masterRoot, 'orchestration.json'),
    databaseFile: path.join(masterRoot, 'orchestration.sqlite'),
    ensureSessionWorkState: id => masterQuestionHost?.pendingAsync(id),
    runChatTurn: async (sessionId, text, opts) => {
      masterWakeups.push({ sessionId, text, opts });
      return { ok: true, accepted: true };
    },
    isBusy: () => false,
    busyReasons: () => [],
    hasPersistedDelivery: (_id, identity) => {
      const key = typeof identity === 'string' ? identity : (identity?.deliveryId || identity?.clientMsgId || '');
      return !!key && masterPersistedIds.has(key);
    },
    deliverOutbox: async descriptor => {
      const key = descriptor?.opts?.deliveryId || descriptor?.opts?.clientMsgId || '';
      if (key) masterPersistedIds.add(key);
      masterWakeups.push({ sessionId: descriptor.sessionId, text: descriptor.text, opts: descriptor.opts });
      setTimeout(async () => {
        await masterOrch.sessionScheduler.turnEnded(descriptor.sessionId).catch(() => {});
        await masterOrch.sessionScheduler.complete(descriptor.sessionId, { classifyState: 'D' }).catch(() => {});
        await masterOrch.tick().catch(() => {});
      }, 15);
      return { ok: true, accepted: true };
    },
    workerIntervalMs: 50,
    log: () => {},
  });
  masterQuestionHost = createProductionQuestionHost({
    getStore: () => masterOrch.store,
    getSession: () => ({ _currentTaskId: null }),
    getState: () => ({ pendingUserInput: null }),
    getRecord: () => ({ unattended: null }),
    setState: () => {},
  }).host;
  await masterOrch.start();

  const masterRouter = createRouterToolRuntime({
    records: masterRecords,
    dispatchToSession: async () => { throw new Error('local dispatch should not be called for remote machine_id'); },
    operations: masterOrch.operations,
    completeDispatch: (id, result, opts) => masterOrch.completeDispatch(id, result, opts),
    schedulerStatus: id => masterOrch.sessionScheduler.status(id),
    cancelQueuedEntry: (id, entryId, opts) => masterOrch.sessionScheduler.cancelQueued(id, entryId, opts),
    recordUserInput: () => {},
    registerExternalWait: () => ({ ok: false }),
    getExternalWait: () => null,
    listExternalWaits: () => [],
    cancelExternalWait: () => ({ ok: false }),
    subscribeDispatchProgress: () => () => {},
    dataRoot: masterRoot,
    pollIntervalMs: 25,
  });

  t.after(async () => {
    masterRouter.clear();
    await masterOrch.stop();
    await slave.close();
    fs.rmSync(masterRoot, { recursive: true, force: true });
    fs.rmSync(slaveRoot, { recursive: true, force: true });
  });

  // Pair Master A -> Slave B via real Rust machine registry (unidirectional: Slave has NO URL for Master!)
  const paired = JSON.parse(await native.machineOperation(masterRoot, 'add', JSON.stringify({
    origin: slave.origin,
    name: 'MacPro',
    password: 'test',
  })));
  assert.equal(paired.status, 200, `pair failed: ${JSON.stringify(paired)}`);
  const macproId = paired.data.id;

  const masterCap = masterRouter.issueContext({ sessionId: 'master-1', turnId: 'turn-1' });

  // 1. list_machines() & list_machines({ machine_id })
  const listed = await masterRouter.execute(masterCap, 'list_machines', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.machines.length, 1);
  assert.equal(listed.machines[0].id, macproId);
  assert.equal(listed.machines[0].name, 'MacPro');

  const targets = await masterRouter.execute(masterCap, 'list_machines', { machine_id: macproId });
  assert.equal(targets.ok, true);
  assert.equal(targets.machine_id, macproId);
  assert.equal(targets.directories[0].id, 'dir_remote');
  assert.ok(targets.sessions.some(s => s.id === 'slave-chat-1'));

  // 2. route_task one-way to remote machine
  const oneWay = await masterRouter.execute(masterCap, 'route_task', {
    machine_id: macproId,
    target_session_id: 'slave-chat-1',
    message: 'Run background cleanup on MacPro',
    idempotency_key: 'oneway-1',
  });
  assert.equal(oneWay.ok, true);
  assert.equal(oneWay.machine_id, macproId);
  assert.equal(oneWay.machine_name, 'MacPro');
  await waitFor(() => slave.deliveredToSlave.some(d => d.text.includes('Run background cleanup on MacPro')));

  // 3. dispatch_master(mode="async") -> Slave worker calls dispatch_slave -> instant SSE wakeup on Master!
  const asyncAdmitted = await masterRouter.execute(masterCap, 'dispatch_master', {
    machine_id: macproId,
    target_session_id: 'slave-chat-1',
    mode: 'async',
    message: 'Verify batch 18 on MacPro',
    idempotency_key: 'async-1',
  });
  assert.equal(asyncAdmitted.ok, true);
  assert.equal(asyncAdmitted.mode, 'async');
  assert.equal(asyncAdmitted.machine_id, macproId);
  const opId1 = asyncAdmitted.operation_id;

  const slaveDelivery1 = await waitFor(() => slave.deliveredToSlave.find(d => d.text.includes(opId1)));
  assert.match(slaveDelivery1.text, /\[Receipt required\]/);
  assert.match(slaveDelivery1.text, new RegExp(`dispatch_slave\\(\\{operation_id:"${opId1}"`));

  // Wait briefly for Master SSE watch to connect, then Slave worker submits dispatch_slave!
  await waitFor(() => slave.sseClients.size >= 1);
  const slaveCap1 = slave.slaveRouter.issueContext({ sessionId: 'slave-chat-1', turnId: 'slave-t1' });
  const slaveAck = await slave.slaveRouter.execute(slaveCap1, 'dispatch_slave', {
    operation_id: opId1,
    result: 'Batch 18 green: 3015/3015 Rust tests passed',
    status: 'completed',
  });
  assert.equal(slaveAck.ok, true);

  // Master receives receipt via SSE push and wakes master-1 automatically!
  const wakeup1 = await waitFor(() => masterWakeups.find(w => w.text.includes('Batch 18 green')));
  assert.equal(wakeup1.sessionId, 'master-1');
  assert.match(wakeup1.text, /MacPro \/ slave-chat-1/);
  const masterOp1 = await masterOrch.operations.get(opId1);
  assert.equal(masterOp1.status, 'completed');

  // Verify Slave received Master's ack and persisted remoteReceiptAckedSettle >= 1!
  await waitFor(async () => {
    const op = await slave.slaveOrch.operations.get(opId1);
    return Number(op?.remoteReceiptAckedSettle || 0) >= 1;
  });

  // 4. missing_dispatch_slave -> auto-failed pushed to Master -> late dispatch_slave resettle corrects Master!
  const asyncLate = await masterRouter.execute(masterCap, 'dispatch_master', {
    machine_id: macproId,
    target_session_id: 'slave-chat-2',
    mode: 'async',
    message: 'Task where worker forgets dispatch_slave initially',
    idempotency_key: 'async-late-1',
  });
  const opLate = asyncLate.operation_id;
  await waitFor(() => slave.deliveredToSlave.some(d => d.text.includes(opLate)));

  // Simulate turn end on Slave without calling dispatch_slave
  await slave.slaveOrch.completeDispatch(opLate, {
    status: 'failed',
    sessionName: 'slave-chat-2',
    text: 'The worker finished without calling dispatch_slave to submit the async receipt.',
    error: 'The worker finished without calling dispatch_slave to submit the async receipt.',
    source: 'missing_dispatch_slave',
  });
  await waitFor(async () => (await masterOrch.operations.get(opLate))?.status === 'failed');

  // Now Slave worker submits late dispatch_slave -> triggers 3-arg resettle: true -> pushes settle=2 to Master!
  const slaveCap2 = slave.slaveRouter.issueContext({ sessionId: 'slave-chat-2', turnId: 'slave-t2' });
  const lateRes = await slave.slaveRouter.execute(slaveCap2, 'dispatch_slave', {
    operation_id: opLate,
    result: 'Late recovery report: all checks succeeded',
    status: 'completed',
  });
  assert.equal(lateRes.corrected, true);

  const correctedWakeup = await waitFor(() => masterWakeups.find(w => w.text.includes('Late recovery report')));
  assert.match(correctedWakeup.text, /迟到回执/);
  assert.equal((await masterOrch.operations.get(opLate)).status, 'completed');

  // 5. dispatch_master(mode="sync", new_task={ dir_id, title }) with live progress over SSE!
  const progressEvents = [];
  const syncPromise = masterRouter.execute(masterCap, 'dispatch_master', {
    machine_id: macproId,
    new_task: { dir_id: 'dir_remote', title: 'Remote x64 Build' },
    mode: 'sync',
    message: 'Build x64 artifact and report path',
    idempotency_key: 'sync-new-task-1',
    timeout_seconds: 15,
  }, {
    onProgress: p => progressEvents.push(p),
  });

  const syncDelivery = await waitFor(() => slave.deliveredToSlave.find(d => d.text.includes('Build x64 artifact')));
  const syncOpId = syncDelivery.opts.originDispatchId;
  await waitFor(async () => !!(await masterOrch.operations.get(syncOpId)));
  slave.emitProgress(syncOpId, { kind: 'thinking', text: 'Compiling x64 release...' });
  await waitFor(() => progressEvents.some(p => p?.text === 'Compiling x64 release...'));

  await slave.slaveOrch.completeDispatch(syncOpId, {
    status: 'completed',
    sessionName: syncDelivery.sessionId,
    text: 'Built /artifacts/x64-ok.zip',
    source: 'sync_final_output',
  });
  const syncResult = await syncPromise;
  assert.equal(syncResult.ok, true);
  assert.equal(syncResult.mode, 'sync');
  assert.equal(syncResult.machine_id, macproId);
  assert.equal(syncResult.result, 'Built /artifacts/x64-ok.zip');
  assert.equal(syncResult.task_id, 'tsk_remote_1');

  // 6. dispatch_status & dispatch_cancel (queued cancel on remote peer)
  slave.setBusy('slave-chat-1');
  const queuedRemote = await masterRouter.execute(masterCap, 'dispatch_master', {
    machine_id: macproId,
    target_session_id: 'slave-chat-1',
    mode: 'async',
    message: 'Queued job to cancel remotely',
    idempotency_key: 'cancel-remote-1',
  });
  const opCancel = queuedRemote.operation_id;
  const statusRes = await masterRouter.execute(masterCap, 'dispatch_status', { operation_id: opCancel });
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.dispatch.machine_id, macproId);
  assert.equal(statusRes.dispatch.queue_state, 'queued');

  const cancelRes = await masterRouter.execute(masterCap, 'dispatch_cancel', {
    operation_id: opCancel,
    reason: 're-routing to another machine',
  });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.status, 'cancelled');
  assert.equal(cancelRes.disposition, 'queued');
  assert.equal((await slave.slaveOrch.operations.get(opCancel)).status, 'cancelled');
  slave.setBusy(null);

  // 7. Reconnect catch-up replay: drop SSE while Slave completes -> Rust client reconnects -> catch-up delivers receipt!
  const catchupAdmitted = await masterRouter.execute(masterCap, 'dispatch_master', {
    machine_id: macproId,
    target_session_id: 'slave-chat-1',
    mode: 'async',
    message: 'Job finishing during laptop sleep',
    idempotency_key: 'catchup-1',
  });
  const opCatchup = catchupAdmitted.operation_id;
  await waitFor(() => slave.deliveredToSlave.some(d => d.text.includes(opCatchup)));
  slave.disconnectAllSse();
  // Slave finishes while Master is disconnected!
  await slave.slaveRouter.execute(slaveCap1, 'dispatch_slave', {
    operation_id: opCatchup,
    result: 'Completed while master was offline',
    status: 'completed',
  });
  // Rust SSE client reconnects within ~1s and Slave replays unacked receipt!
  const catchupWakeup = await waitFor(() => masterWakeups.find(w => w.text.includes('Completed while master was offline')), 8000);
  assert.equal(catchupWakeup.sessionId, 'master-1');
  assert.equal((await masterOrch.operations.get(opCatchup)).status, 'completed');
});
