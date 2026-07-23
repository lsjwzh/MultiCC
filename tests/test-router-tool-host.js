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
  const operations = new Map();
  const orchestrationRuntime = {
    operations: { get: async id => operations.get(id) || null },
    completeDispatch: async () => ({ ok: true }),
    tick: async () => {},
  };
  const host = createRouterToolHost({ express, isLocalRequest });
  host.configure({
    records,
    orchestrationRuntime,
    dispatchToSession: async (targetId, message) => {
      const operationId = `op-${++sequence}`;
      operations.set(operationId, {
        id: operationId,
        status: 'admitted',
        spec: { targetId, chatId: targetId, message },
      });
      return { ok: true, operationId, status: 'admitted', chatId: targetId };
    },
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
});
