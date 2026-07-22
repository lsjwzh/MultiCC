'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCommanderIngress } = require('../src/commander-host-runtime');

function harness(overrides = {}) {
  const history = new Set();
  const appended = [];
  const events = [];
  const statuses = [];
  const routes = [];
  const completions = [];
  const ingress = createCommanderIngress({
    containsDelivery: (_sessionId, id) => history.has(id),
    appendMessage: (_sessionId, message) => {
      appended.push(message);
      if (message.clientMsgId) history.add(message.clientMsgId);
      if (message.deliveryId) history.add(message.deliveryId);
      return true;
    },
    broadcast: (_sessionId, event) => events.push(event),
    setStatus: (_sessionId, status) => statuses.push(status.status),
    routeTask: async (sessionId, text, options) => {
      routes.push({ sessionId, text, options });
      return {
        ok: true, targetSessionId: 'worker-1', targetLabel: '全栈工程师 1',
        operationId: 'worker-op', status: 'admitted',
      };
    },
    completeDispatch: async (id, result) => { completions.push({ id, result }); },
    logger: { error() {} },
    ...overrides,
  });
  return { ingress, history, appended, events, statuses, routes, completions };
}

test('Commander ingress persists the user input, routes once, and emits no assistant reply', async () => {
  const h = harness();
  assert.equal(await h.ingress.runTurn('commander', '实现 API', { clientMsgId: 'client-1' }), true);
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].role, 'user');
  assert.deepEqual(h.routes, [{
    sessionId: 'commander', text: '实现 API', options: { idempotencyKey: 'client-1' },
  }]);
  assert.deepEqual(h.events.map(event => event.type), ['system', 'result']);
  assert.equal(h.events.some(event => event.type === 'assistant'), false);
  assert.deepEqual(h.statuses, ['thinking', 'idle']);

  assert.equal(await h.ingress.runTurn('commander', '重复', { clientMsgId: 'client-1' }), true);
  assert.equal(h.routes.length, 1, 'durable client ids prevent duplicate routing');
});

test('legacy inbound dispatch is closed after one-way routing without worker result injection', async () => {
  const h = harness();
  await h.ingress.runTurn('commander', '旧队列任务', {
    deliveryId: 'delivery-1', originDispatchId: 'legacy-op',
  });
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].id, 'legacy-op');
  assert.match(h.completions[0].result.text, /已单向路由/);
});

test('production runChatTurn exits to Commander ingress before CLI turn normalization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function runChatTurn(sessionName, text, opts = {})');
  const end = source.indexOf("bus.on('chat:run'", start);
  const body = source.slice(start, end);
  const guard = body.indexOf("persisted.type === 'commander'");
  const normalize = body.indexOf('normalizeTurnRequest({');
  assert.ok(guard >= 0 && normalize > guard, 'Commander must never reach the AI CLI preparation path');
  assert.match(body, /commanderIngress\.runTurn/);
});
