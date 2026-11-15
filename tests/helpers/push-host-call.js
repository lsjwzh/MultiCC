'use strict';

// Test harness for the push host port (src/routes/push-host.js). The public
// /api/push/* DTOs are answered by the Rust front door now; these tests drive
// the Node side of the split by posting to /api/__host/push and reading the
// { ok, value } envelope the front door would consume. No real FCM, Bark or
// webhook endpoint is contacted.

const assert = require('node:assert/strict');
const { mountPushHostRoute, HOST_PATH } = require('../../src/routes/push-host');

function basePush(overrides = {}) {
  return {
    subscriptions: new Map(),
    cfg: { BARK_URL: '', WEBHOOK_URL: '' },
    saveSubscriptions: async () => {},
    sendPushToAll: async () => {},
    sendBarkNotification: async () => ({ ok: true }),
    sendWebhookNotification: async () => {},
    hasBarkDevices: () => false,
    businessPush: { notify: async () => ({ statusCode: 200, body: { ok: true } }) },
    ...overrides,
  };
}

function createPushHost(options = {}) {
  const push = options.push || basePush();
  const routes = new Map();
  const app = { post: (path, handler) => routes.set(`POST ${path}`, handler) };
  mountPushHostRoute(app, {
    push,
    businessPush: options.businessPush || push.businessPush,
    isLocal: options.isLocal || (() => true),
    now: options.now || (() => 0),
    logger: options.logger || { log() {}, warn() {}, error() {} },
  });
  async function call(body) {
    const handler = routes.get(`POST ${HOST_PATH}`);
    assert.equal(typeof handler, 'function', `missing POST ${HOST_PATH}`);
    let done;
    const completed = new Promise(resolve => { done = resolve; });
    const res = {
      statusCode: 200,
      body: undefined,
      headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; this.headersSent = true; done(); return this; },
    };
    handler({ local: true, body }, res);
    await completed;
    return res;
  }
  return { app, routes, push, call };
}

module.exports = { basePush, createPushHost };
