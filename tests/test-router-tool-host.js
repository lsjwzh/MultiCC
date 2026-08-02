'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const express = require('express');
const { isLocalRequest } = require('../src/request-locality');
const { createRouterToolHost } = require('../src/router-tool-host');

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
    operations: { get: async id => operations.get(id) || null },
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
