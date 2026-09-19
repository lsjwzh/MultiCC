'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('http');
const test = require('node:test');
const express = require('express');
// Isolate the vault store before router-tool-host (→ secrets-vault) resolves
// its STORE path: the spawnProcess env-injection test below writes entries.
process.env.MULTICC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rth-test-'));
const { isLocalRequest } = require('../src/request-locality');
const { createRouterToolHost } = require('../src/router-tool-host');
const vault = require('../src/secrets-vault');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

test('internal bridge requires loopback plus its scoped process capability', async t => {
  const records = new Map([
    ['caller', { id: 'caller', dirId: 'dir', kind: 'chat', type: 'worker' }],
    ['worker', { id: 'worker', dirId: 'dir', kind: 'chat', type: 'worker' }],
  ]);
  let sequence = 0;
  const userInputSignals = [];
  const admissionObservers = [];
  const observerWarnings = [];
  let taskBoardObserverCalls = 0;
  const operations = new Map();
  const waits = new Map();
  let syncProgressSink = null;
  const orchestrationRuntime = {
    operations: {
      get: async id => operations.get(id) || null,
      list: async ({ kind, ownerSessionId, statuses } = {}) => [...operations.values()]
        .filter(operation => !kind || operation.kind === kind)
        .filter(operation => !ownerSessionId || operation.ownerSessionId === ownerSessionId)
        .filter(operation => !statuses || statuses.includes(operation.status)),
    },
    waits: { get: async id => waits.get(id) || null },
    completeDispatch: async () => ({ ok: true }),
    tick: async () => {},
    register: async spec => {
      const wait = {
        id: spec.id,
        sessionId: spec.session,
        mode: spec.mode,
        status: 'pending',
        metadata: {
          source: spec.source,
          reason: spec.reason,
          registrationFingerprint: spec.registrationFingerprint,
          dueAt: spec.mode === 'delay' ? 20_000 : null,
        },
        createdAt: 10_000,
      };
      waits.set(wait.id, wait);
      return {
        ...wait,
        token: spec.mode === 'callback' ? 'host-callback-secret' : null,
        callbackUrl: null,
        dueAt: wait.metadata.dueAt,
      };
    },
    listForSession: async sessionId => [...waits.values()]
      .filter(wait => wait.sessionId === sessionId && wait.status === 'pending'),
    cancel: async id => {
      const wait = waits.get(id);
      if (!wait) return { ok: false, code: 'not_found' };
      wait.status = 'cancelled';
      wait.cancelledAt = 12_000;
      return { ok: true, idempotent: false };
    },
  };
  const host = createRouterToolHost({
    express,
    isLocalRequest,
    logger: { warn: (event, fields) => observerWarnings.push({ event, fields }), error() {} },
  });
  host.configure({
    records,
    orchestrationRuntime,
    dispatchToSession: async (targetId, message, opts) => {
      const operationId = `op-${++sequence}`;
      operations.set(operationId, {
        id: operationId,
        status: 'admitted',
        spec: { targetId, chatId: targetId, message, resultMode: opts.resultMode },
      });
      if (opts.resultMode === 'sync') {
        setImmediate(() => {
          syncProgressSink?.({ kind: 'text', message: 'live delta' });
          operations.set(operationId, {
            ...operations.get(operationId),
            status: 'completed',
            result: { status: 'completed', text: 'inline final' },
          });
        });
      }
      return { ok: true, operationId, status: 'admitted', chatId: targetId };
    },
    subscribeDispatchProgress: ({ onProgress }) => {
      syncProgressSink = onProgress;
      return () => { syncProgressSink = null; };
    },
    recordUserInput: async signal => {
      userInputSignals.push(signal);
      return { ok: true, duplicate: false };
    },
    taskBoard: {
      recordRouterAdmission() {
        taskBoardObserverCalls += 1;
        if (taskBoardObserverCalls === 1) throw new Error('task board unavailable');
        return false;
      },
    },
    recordRouterAdmission: async admission => { admissionObservers.push(admission); },
  });
  const app = express();
  host.mount(app);
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(async () => {
    host.clear();
    await new Promise(resolve => server.close(resolve));
  });

  const context = host.processContext({
    sessionId: 'caller',
    turnId: 'turn-1',
    requestId: 'request-1',
    baseUrl: `http://127.0.0.1:${port}`,
  });
  t.after(() => context.revoke());
  const url = `http://127.0.0.1:${port}/api/internal/router-tools/route_task`;
  const missing = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      arguments: { target_session_id: 'worker', message: 'test' },
    }),
  });
  assert.equal(missing.status, 401);

  const accepted = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multicc-router-capability': context.env.MULTICC_ROUTER_CAPABILITY,
    },
    body: JSON.stringify({
      arguments: { target_session_id: 'worker', message: 'test' },
    }),
  });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.result.operation_id, 'op-1');
  assert.equal(admissionObservers.length, 1, 'voice observer still runs when task board throws');
  assert.equal(admissionObservers[0].callerTurnId, 'turn-1');
  assert.equal(admissionObservers[0].callerRequestId, 'request-1');
  assert.deepEqual(observerWarnings.map(entry => entry.event), [
    'router_admission_observer_failed',
  ]);
  assert.equal(observerWarnings[0].fields.observer, 'task_board');

  const callback = await fetch(
    `http://127.0.0.1:${port}/api/internal/router-tools/wait_for_external_result`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multicc-router-capability': context.env.MULTICC_ROUTER_CAPABILITY,
      },
      body: JSON.stringify({
        arguments: {
          mode: 'callback',
          reason: '等待外部构建完成',
          idempotency_key: 'build-1',
        },
      }),
    },
  );
  assert.equal(callback.status, 200);
  const callbackBody = await callback.json();
  assert.match(
    callbackBody.result.callback_url,
    new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/wait/`),
  );
  assert.equal(callbackBody.result.callback_url.includes('host-callback-secret'), true);
  assert.equal(callbackBody.result.wait_id.startsWith('wait-router-'), true);

  const question = await fetch(
    `http://127.0.0.1:${port}/api/internal/router-tools/request_user_input`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multicc-router-capability': context.env.MULTICC_ROUTER_CAPABILITY,
      },
      body: JSON.stringify({
        arguments: {
          question: '是否继续？',
          options: ['继续', '停止'],
        },
      }),
    },
  );
  assert.equal(question.status, 200);
  const questionBody = await question.json();
  assert.equal(questionBody.result.status, 'waiting_reply_signal_recorded');
  assert.equal(userInputSignals.length, 1);
  assert.equal(userInputSignals[0].sessionId, 'caller');
  assert.equal(userInputSignals[0].turnId, 'turn-1');

  const syncResponse = await fetch(
    `http://127.0.0.1:${port}/api/internal/router-tools/dispatch_master`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multicc-router-capability': context.env.MULTICC_ROUTER_CAPABILITY,
      },
      body: JSON.stringify({
        arguments: {
          target_session_id: 'worker', message: 'sync work', mode: 'sync',
          timeout_seconds: 2,
        },
      }),
    },
  );
  assert.equal(syncResponse.status, 200);
  assert.match(syncResponse.headers.get('content-type'), /application\/x-ndjson/);
  const frames = (await syncResponse.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames[0], {
    type: 'progress', progress: { kind: 'text', message: 'live delta' },
  });
  assert.equal(frames[1].type, 'result');
  assert.equal(frames[1].result.result, 'inline final');
  assert.equal(observerWarnings.length, 2, 'a fulfilled false projection is observable too');
  assert.equal(observerWarnings[1].fields.observer, 'task_board');
  assert.equal(observerWarnings[1].fields.error, 'task_board_declined_admission');
});

test('spawnProcess injects vault entries into the child env (set-if-absent)', () => {
  vault._resetForTests();
  vault.upsert({ name: 'RTH_SMOKE_TOKEN', value: 'smoke-1' });
  vault.upsert({ name: 'ANTHROPIC_API_KEY', value: 'must-not-inject' });
  const host = createRouterToolHost({ express, isLocalRequest, logger: { warn() {}, error() {} } });
  host.configure({
    records: new Map([['s1', { id: 's1', dirId: 'dir', kind: 'chat', type: 'worker' }]]),
    orchestrationRuntime: {
      operations: { get: async () => null, list: async () => [] },
      waits: { get: async () => null },
    },
    dispatchToSession: async () => ({ ok: false }),
    recordUserInput: async () => ({ ok: true }),
    listSecrets: () => vault.list(),
  });
  const spawnProbe = baseEnv => {
    let seen = null;
    host.spawnProcess({
      cli: 'claude',
      spawn: (cmd, args, opts) => { seen = opts.env; return { on() {}, once() {}, kill() {} }; },
      command: 'true', args: [], cwd: process.cwd(),
      env: { ...baseEnv }, sessionId: 's1', turnId: 't1',
    });
    return seen;
  };
  // Fresh child env: injectable entry lands, routing namespace never does, and
  // the MULTICC_* host marker set by processContext stays authoritative.
  const fresh = spawnProbe({ PATH: process.env.PATH });
  assert.equal(fresh.RTH_SMOKE_TOKEN, 'smoke-1');
  assert.equal('ANTHROPIC_API_KEY' in fresh, false);
  assert.equal(fresh.MULTICC_SESSION_ID, 's1', 'processContext MULTICC_* markers stay authoritative');
  // Provider-set keys win (set-if-absent): the vault value must not clobber.
  const pinned = spawnProbe({ RTH_SMOKE_TOKEN: 'provider-set' });
  assert.equal(pinned.RTH_SMOKE_TOKEN, 'provider-set');
});
