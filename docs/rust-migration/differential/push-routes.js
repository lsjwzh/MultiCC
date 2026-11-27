'use strict';
// Differential run for the eighteen push routes retired from
// src/push/runtime.js, src/push/channel-subscriptions.js,
// src/push/fcm-devices.js and src/push/bark-devices.js:
//
//   POST     /api/push/subscribe        DELETE /api/push/subscribe
//   POST     /api/push/validate         POST   /api/push/test
//   POST     /api/push/notify           POST   /api/push/test-bark
//   POST     /api/push/test-webhook
//   GET|HEAD /api/push/channel-subscriptions
//   PUT      /api/push/channel-subscriptions
//   POST     /api/push/channel-subscriptions
//   DELETE   /api/push/channel-subscriptions/:id
//   POST     /api/push/test-channel
//   GET|HEAD /api/push/fcm              POST   /api/push/fcm
//   DELETE   /api/push/fcm              POST   /api/push/fcm/test
//   GET|HEAD /api/push/bark-devices     POST   /api/push/bark-devices
//
// now answered by native/gateway/src/app/push_routes.rs (rules in
// native/core/src/push_routes.rs).
//
//   node docs/rust-migration/differential/push-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-push-routes/index.js) over the scripted world in
// tests/helpers/push-scripted-world.js. The Rust front door calls its host
// port (/api/__host/push); the stub Node child mounts the real
// src/routes/push-host.js composition over the same world, so both sides read
// one set of facts and the comparison covers the split itself: path matching,
// the `:id` decode, the Express OPTIONS union, the request-body gates
// (subscribe endpoint, validate endpoint, notify media type, FCM id/token
// shapes, Bark action vocabulary), and every response envelope with its key
// order stay in Rust while the subscription Map, the FCM/Bark device stores,
// the plugin channel store, the senders and the delivery receipts stay in Node.
//
// Side effects are compared too: every subscription save, outbound send,
// device/channel delivery and target check is recorded in-process by the
// oracle and in an NDJSON file by the stub, then compared per case in
// finalize(). A route that answers the same bytes but asks Node for the wrong
// thing (or twice) fails.
//
// No real endpoint can be reached: the world's FCM transport, Bark deliverer,
// plugin-channel deliverer and webhook sender are scripted recorders, and the
// business-push receipt store lives in the case's temp directory.
//
// Normalization: the frozen clock (writes, receipts, health stamps) is the same
// on both sides; only the uuid `crypto.randomUUID()` Bark assigns to a new
// device is per-side, and both the bodies and the recorded effects blank it.
//
// No documented differences: every case must agree byte for byte.
const fs = require('fs');
const path = require('path');
const { main, waitForFixture } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-push-1' };
const JSONH = { ...L, 'Content-Type': 'application/json' };
const FROZEN_NOW = 1794687600000;
const VALID_ID = 'abcdefghijklmnop';
const VALID_BINDING = 'mnopqrstuvwxyz01';
const VALID_TOKEN = 'ABCDEFGHIJ_KL:mnopqrstuv';

let worldPath = '';
let effectsPath = '';
let buildDeps = null;
let legacyBag = null;
let currentHandler = null;
let setLegacyHandler = null;
let upstreamText = '';
const nodeEffects = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

const pending = [];

function useScenario(scenario) {
  return {
    before(side) {
      if (side.name === 'node') {
        legacyBag = buildDeps(scenario);
        setLegacyHandler(legacyBag);
      } else {
        fs.writeFileSync(worldPath, JSON.stringify(scenario));
      }
    },
    capture(_response, side) {
      if (side.name === 'rust') return;
      nodeEffects.set(scenario.case, clone(legacyBag.effects.calls));
    },
  };
}

let counter = 0;

function add(name, buildRequest, buildScenario, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  const scenario = typeof buildScenario === 'function'
    ? buildScenario(tag) : (buildScenario || { answers: {} });
  scenario.case = tag;
  if (!scenario.answers) scenario.answers = {};
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) hooks[hook] = fn;
  pending.push([name, buildRequest, hooks]);
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  // Node's http client drops the body of a DELETE unless Content-Length is set.
  const del = (url, body, headers = JSONH) => {
    const payload = JSON.stringify(body === undefined ? {} : body);
    return {
      method: 'DELETE', url,
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(payload)) },
      body: payload,
    };
  };
  const post = (url, body, headers = JSONH) => ({
    method: 'POST', url, headers,
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const put = (url, body, headers = JSONH) => ({
    method: 'PUT', url, headers,
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const postRaw = (url, body, headers) => ({ method: 'POST', url, headers, body });
  // A new Bark device gets a random uuid; its ETag cannot agree by construction.
  const dropEtag = view => { delete view.headers.etag; return view; };

  const fcmDevice = index => ({
    id: `fcm-device-${String(index).padStart(6, '0')}`,
    binding: `fcm-binding-${String(index).padStart(6, '0')}`,
    token: `fcm-token-${String(index).padStart(8, '0')}-abcdefgh`,
    updatedAt: FROZEN_NOW - 1000,
  });
  const barkDevice = (id, name, key) => ({
    id, name, url: `https://api.day.app/${key}`, enabled: true,
  });
  const channelRow = (id, plugin, target, categories, enabled = true) => ({
    id, plugin, target, categories, enabled,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const notifyBody = (patch = {}) => ({
    title: 'Build finished', body: 'All green', type: 'strategy-actionable',
    tag: 'build', url: '/manage', dedupeKey: 'notify-key-1', ...patch,
  });

  // ── Express automatic OPTIONS ──────────────────────────────────────────
  add('OPTIONS fcm', () => options('/api/push/fcm'));
  add('OPTIONS fcm test', () => options('/api/push/fcm/test'));
  add('OPTIONS bark devices', () => options('/api/push/bark-devices'));
  add('OPTIONS channel subscriptions', () => options('/api/push/channel-subscriptions'));
  add('OPTIONS channel subscription id', () => options('/api/push/channel-subscriptions/chs_a'));
  add('OPTIONS subscribe', () => options('/api/push/subscribe'));
  add('OPTIONS validate', () => options('/api/push/validate'));
  add('OPTIONS notify', () => options('/api/push/notify'));

  // ── FCM ────────────────────────────────────────────────────────────────
  add('GET fcm', () => get('/api/push/fcm'));
  add('HEAD fcm', () => head('/api/push/fcm'));
  add('GET fcm with devices', () => get('/api/push/fcm'),
    () => ({ fcmSeed: [fcmDevice(1), fcmDevice(2)] }));
  add('GET fcm not configured', () => get('/api/push/fcm'), () => ({ fcmProjectId: null }));
  add('GET fcm storage unavailable', () => get('/api/push/fcm'), () => ({ fcmSeedInvalid: true }));
  add('GET fcm case insensitive', () => get('/api/push/FCM'));
  add('POST fcm register', () => post('/api/push/fcm', {
    id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, projectId: 'proj-diff', locale: 'en',
  }));
  add('POST fcm register without a project id', () => post('/api/push/fcm', {
    id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN,
  }));
  add('POST fcm register a short token', () => post('/api/push/fcm', {
    id: VALID_ID, binding: VALID_BINDING, token: 'short',
  }));
  add('POST fcm register a non-string id', () => post('/api/push/fcm', {
    id: 1234567890123456, binding: VALID_BINDING, token: VALID_TOKEN,
  }));
  add('POST fcm register for another project', () => post('/api/push/fcm', {
    id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, projectId: 'proj-other',
  }));
  add('POST fcm register not configured', () => post('/api/push/fcm', {
    id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN,
  }), () => ({ fcmProjectId: null }));
  add('POST fcm register storage unavailable', () => post('/api/push/fcm', {
    id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, projectId: 'proj-diff',
  }), () => ({ fcmSeedInvalid: true }));
  add('POST fcm register at the device limit', () => post('/api/push/fcm', {
    id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, projectId: 'proj-diff',
  }), () => ({ fcmSeed: Array.from({ length: 100 }, (_, i) => fcmDevice(i)) }));
  add('DELETE fcm', () => del('/api/push/fcm', { id: VALID_ID, binding: VALID_BINDING }),
    () => ({ fcmSeed: [{ id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, updatedAt: FROZEN_NOW - 1000 }] }));
  add('DELETE fcm with a short id', () => del('/api/push/fcm', { id: 'short', binding: VALID_BINDING }));
  add('DELETE fcm without a binding', () => del('/api/push/fcm', { id: VALID_ID }),
    () => ({ fcmSeed: [{ id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, updatedAt: FROZEN_NOW - 1000 }] }));
  add('POST fcm test', () => post('/api/push/fcm/test', { id: VALID_ID }),
    () => ({ fcmSeed: [{ id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, updatedAt: FROZEN_NOW - 1000 }] }));
  add('POST fcm test an unregistered device', () => post('/api/push/fcm/test', { id: VALID_ID }),
    () => ({
      fcmSeed: [{ id: VALID_ID, binding: VALID_BINDING, token: VALID_TOKEN, updatedAt: FROZEN_NOW - 1000 }],
      answers: { [`fcmSend:${VALID_TOKEN}`]: { value: { ok: false, code: 'unregistered' } } },
    }));
  add('POST fcm test without a device', () => post('/api/push/fcm/test', { id: VALID_ID }));
  add('POST fcm test a short id', () => post('/api/push/fcm/test', { id: 'short' }));

  // ── Bark ───────────────────────────────────────────────────────────────
  const BARK_URL = 'https://api.day.app/legacykey';
  add('GET bark devices', () => get('/api/push/bark-devices'));
  add('HEAD bark devices', () => head('/api/push/bark-devices'));
  add('GET bark devices with a legacy device', () => get('/api/push/bark-devices'),
    () => ({ barkUrl: BARK_URL }));
  add('GET bark devices storage unavailable', () => get('/api/push/bark-devices'),
    () => ({ barkSeedInvalid: true }));
  add('POST bark add', () => post('/api/push/bark-devices', {
    action: 'add', url: 'https://api.day.app/newkey', name: 'Phone',
  }), null, { normalize: dropEtag });
  add('POST bark add a duplicate', () => post('/api/push/bark-devices', {
    action: 'add', url: BARK_URL, name: 'Phone',
  }), () => ({ barkUrl: BARK_URL }));
  add('POST bark add an invalid url', () => post('/api/push/bark-devices', {
    action: 'add', url: 'ftp://example.com/key', name: 'Phone',
  }));
  add('POST bark add an example key', () => post('/api/push/bark-devices', {
    action: 'add', url: 'https://api.day.app/YOUR_KEY', name: 'Phone',
  }));
  add('POST bark add without a name', () => post('/api/push/bark-devices', {
    action: 'add', url: 'https://api.day.app/newkey', name: '   ',
  }));
  add('POST bark add at the device limit', () => post('/api/push/bark-devices', {
    action: 'add', url: 'https://api.day.app/extra', name: 'Extra',
  }), () => ({
    barkSeed: Array.from({ length: 20 }, (_, i) => barkDevice(`dev-${i}`, `Device ${i}`, `key${i}`)),
  }));
  add('POST bark update', () => post('/api/push/bark-devices', {
    action: 'update', id: 'dev-1', name: 'Renamed',
  }), () => ({ barkSeed: [barkDevice('dev-1', 'Phone', 'key1')] }));
  add('POST bark update enabled', () => post('/api/push/bark-devices', {
    action: 'update', id: 'dev-1', enabled: false,
  }), () => ({ barkSeed: [barkDevice('dev-1', 'Phone', 'key1')] }));
  add('POST bark update an unknown device', () => post('/api/push/bark-devices', {
    action: 'update', id: 'dev-gone', name: 'Renamed',
  }));
  add('POST bark update with a non-boolean enabled', () => post('/api/push/bark-devices', {
    action: 'update', id: 'dev-1', enabled: 'yes',
  }), () => ({ barkSeed: [barkDevice('dev-1', 'Phone', 'key1')] }));
  add('POST bark remove', () => post('/api/push/bark-devices', { action: 'remove', id: 'dev-1' }),
    () => ({ barkSeed: [barkDevice('dev-1', 'Phone', 'key1')] }));
  add('POST bark remove the legacy device', () => post('/api/push/bark-devices', {
    action: 'remove', id: 'legacy',
  }), () => ({ barkUrl: BARK_URL }));
  add('POST bark remove an unknown device', () => post('/api/push/bark-devices', {
    action: 'remove', id: 'dev-gone',
  }));
  add('POST bark test', () => post('/api/push/bark-devices', { action: 'test', id: 'dev-1' }),
    () => ({ barkSeed: [barkDevice('dev-1', 'Phone', 'key1')] }));
  add('POST bark test a rejecting server', () => post('/api/push/bark-devices', {
    action: 'test', id: 'dev-1',
  }), () => ({
    barkSeed: [barkDevice('dev-1', 'Phone', 'key1')],
    answers: { deliverBark: { value: { ok: false, error: 'bark_rejected' } } },
  }));
  add('POST bark test an unknown device', () => post('/api/push/bark-devices', {
    action: 'test', id: 'dev-gone',
  }));
  add('POST bark test without an id', () => post('/api/push/bark-devices', { action: 'test' }));
  add('POST bark an unknown action', () => post('/api/push/bark-devices', { action: 'bogus' }));
  add('POST bark without an action', () => post('/api/push/bark-devices', {}));

  // ── plugin channel subscriptions ───────────────────────────────────────
  add('GET channel subscriptions', () => get('/api/push/channel-subscriptions'));
  add('HEAD channel subscriptions', () => head('/api/push/channel-subscriptions'));
  add('GET channel subscriptions seeded', () => get('/api/push/channel-subscriptions'),
    () => ({ channelSeed: [channelRow('chs_a', 'wechat', 'u1', ['error'])] }));
  add('GET channel subscriptions unreadable', () => get('/api/push/channel-subscriptions'),
    () => ({ channelSeedInvalid: true }));
  add('PUT channel subscriptions', () => put('/api/push/channel-subscriptions', {
    subscriptions: [{ plugin: 'wechat', target: 'u2', categories: ['error', 'done'] }],
  }));
  add('PUT channel subscriptions empty', () => put('/api/push/channel-subscriptions', {
    subscriptions: [],
  }));
  add('PUT channel subscriptions without the list', () => put('/api/push/channel-subscriptions', {}));
  add('PUT channel subscriptions invalid categories', () => put('/api/push/channel-subscriptions', {
    subscriptions: [{ plugin: 'wechat', target: 'u2', categories: ['nowhere'] }],
  }));
  add('PUT channel subscriptions not a list', () => put('/api/push/channel-subscriptions', {
    subscriptions: 'nope',
  }));
  add('PUT channel subscriptions too many', () => put('/api/push/channel-subscriptions', {
    subscriptions: Array.from({ length: 51 }, (_, i) => ({
      plugin: 'wechat', target: `u-${i}`, categories: ['error'],
    })),
  }));
  add('PUT channel subscriptions a duplicate target', () => put('/api/push/channel-subscriptions', {
    subscriptions: [
      { plugin: 'wechat', target: 'u2', categories: ['error'] },
      { plugin: 'wechat', target: 'u2', categories: ['done'] },
    ],
  }));
  add('PUT channel subscriptions an unknown target', () => put('/api/push/channel-subscriptions', {
    subscriptions: [{ plugin: 'wechat', target: 'u9', categories: ['error'] }],
  }), () => ({ answers: { 'checkTarget:wechat:u9': { value: 'unknown channel target' } } }));
  add('PUT channel subscriptions unreadable store', () => put('/api/push/channel-subscriptions', {
    subscriptions: [],
  }), () => ({ channelSeedInvalid: true }));
  add('POST channel subscriptions upsert', () => post('/api/push/channel-subscriptions', {
    plugin: 'wechat', target: 'u3', categories: ['question'],
  }));
  add('POST channel subscriptions upsert existing', () => post('/api/push/channel-subscriptions', {
    plugin: 'wechat', target: 'u1', categories: ['done'],
  }), () => ({ channelSeed: [channelRow('chs_a', 'wechat', 'u1', ['error'])] }));
  add('POST channel subscriptions invalid plugin', () => post('/api/push/channel-subscriptions', {
    plugin: 'Bad Plugin', target: 'u3', categories: ['error'],
  }));
  add('POST channel subscriptions at the limit', () => post('/api/push/channel-subscriptions', {
    plugin: 'wechat', target: 'u-new', categories: ['error'],
  }), () => ({
    channelSeed: Array.from({ length: 50 }, (_, i) => channelRow(`chs_${i}`, 'wechat', `u-${i}`, ['error'])),
  }));
  add('DELETE channel subscription', () => del('/api/push/channel-subscriptions/chs_a'),
    () => ({ channelSeed: [channelRow('chs_a', 'wechat', 'u1', ['error'])] }));
  add('DELETE channel subscription encoded', () => del('/api/push/channel-subscriptions/chs%5Fa'),
    () => ({ channelSeed: [channelRow('chs_a', 'wechat', 'u1', ['error'])] }));
  add('DELETE channel subscription unknown', () => del('/api/push/channel-subscriptions/chs_gone'));
  add('DELETE channel subscription malformed escape', () => del('/api/push/channel-subscriptions/%E0%A4%A'));
  add('POST test-channel', () => post('/api/push/test-channel', { plugin: 'wechat', target: 'u1' }));
  add('POST test-channel down', () => post('/api/push/test-channel', { plugin: 'wechat', target: 'u1' }),
    () => ({ answers: { 'deliver:wechat': { value: { ok: false, down: true, error: 'offline' } } } }));
  add('POST test-channel refused', () => post('/api/push/test-channel', { plugin: 'wechat', target: 'u1' }),
    () => ({ answers: { 'deliver:wechat': { value: { ok: false, error: 'refused' } } } }));
  add('POST test-channel invalid target', () => post('/api/push/test-channel', {
    plugin: 'wechat', target: 'bad target',
  }));

  // ── web push subscriptions ─────────────────────────────────────────────
  add('POST subscribe', () => post('/api/push/subscribe', {
    endpoint: 'https://push.example/e1', keys: { p256dh: 'k', auth: 'a' },
  }));
  add('POST subscribe without an endpoint', () => post('/api/push/subscribe', { keys: {} }));
  add('POST subscribe an empty body', () => post('/api/push/subscribe', {}));
  add('POST subscribe a failing save', () => post('/api/push/subscribe', {
    endpoint: 'https://push.example/e1', keys: { p256dh: 'k', auth: 'a' },
  }), () => ({ answers: { saveSubscriptions: { throw: { message: 'disk full' } } } }));
  add('POST subscribe updates an existing endpoint', () => post('/api/push/subscribe', {
    endpoint: 'https://push.example/e1', keys: { p256dh: 'k2', auth: 'a2' },
  }), () => ({ subscriptions: { 'https://push.example/e1': { endpoint: 'https://push.example/e1', keys: { p256dh: 'k', auth: 'a' } } } }));
  add('DELETE subscribe', () => del('/api/push/subscribe', { endpoint: 'https://push.example/e1' }),
    () => ({ subscriptions: { 'https://push.example/e1': { endpoint: 'https://push.example/e1', keys: {} } } }));
  add('DELETE subscribe an unknown endpoint', () => del('/api/push/subscribe', {
    endpoint: 'https://push.example/gone',
  }));
  add('DELETE subscribe without a body', () => del('/api/push/subscribe'));
  add('DELETE subscribe a failing save', () => del('/api/push/subscribe', {
    endpoint: 'https://push.example/e1',
  }), () => ({
    subscriptions: { 'https://push.example/e1': { endpoint: 'https://push.example/e1', keys: {} } },
    answers: { saveSubscriptions: { throw: { message: 'disk full' } } },
  }));
  add('POST validate known', () => post('/api/push/validate', { endpoint: 'https://push.example/e1' }),
    () => ({ subscriptions: { 'https://push.example/e1': { endpoint: 'https://push.example/e1', keys: {} } } }));
  add('POST validate unknown', () => post('/api/push/validate', { endpoint: 'https://push.example/gone' }));
  add('POST validate without an endpoint', () => post('/api/push/validate', {}));

  // ── test / notify ──────────────────────────────────────────────────────
  const ONE_SUB = { 'https://push.example/e1': { endpoint: 'https://push.example/e1', keys: {} } };
  add('POST test', () => post('/api/push/test'), () => ({ subscriptions: ONE_SUB }));
  add('POST test a failing fan-out', () => post('/api/push/test'), () => ({
    subscriptions: ONE_SUB,
    answers: { sendPushToAll: { throw: { message: 'web push exploded' } } },
  }));
  add('POST test-bark not configured', () => post('/api/push/test-bark'));
  add('POST test-bark', () => post('/api/push/test-bark'), () => ({ barkUrl: BARK_URL }));
  add('POST test-bark failed', () => post('/api/push/test-bark'), () => ({
    barkUrl: BARK_URL,
    answers: { deliverBark: { value: { ok: false, error: 'bark_rejected' } } },
  }));
  add('POST test-webhook not configured', () => post('/api/push/test-webhook'));
  add('POST test-webhook', () => post('/api/push/test-webhook'),
    () => ({ webhookUrl: 'https://hooks.example/push' }));
  add('POST test-webhook failed', () => post('/api/push/test-webhook'), () => ({
    webhookUrl: 'https://hooks.example/push',
    answers: { sendWebhookNotification: { throw: { message: 'webhook exploded' } } },
  }));
  add('POST notify', () => post('/api/push/notify', notifyBody()),
    () => ({ subscriptions: ONE_SUB }));
  add('POST notify without subscribers', () => post('/api/push/notify', notifyBody()));
  add('POST notify a non-JSON media type', () => postRaw(
    '/api/push/notify', JSON.stringify(notifyBody()), { ...L, 'Content-Type': 'text/plain' },
  ), () => ({ subscriptions: ONE_SUB }));
  add('POST notify an unknown field', () => post('/api/push/notify', notifyBody({ extra: 1 })),
    () => ({ subscriptions: ONE_SUB }));
  add('POST notify a missing field', () => post('/api/push/notify', {
    title: 'Build finished', body: 'All green', type: 'strategy-actionable',
    tag: 'build', url: '/manage',
  }), () => ({ subscriptions: ONE_SUB }));
  add('POST notify an unsupported type', () => post('/api/push/notify', notifyBody({
    type: 'bogus',
  }), () => ({ subscriptions: ONE_SUB })));
  add('POST notify an unsafe url', () => post('/api/push/notify', notifyBody({ url: 'https://evil.example' }),
    () => ({ subscriptions: ONE_SUB })));
  add('POST notify an invalid dedupe key', () => post('/api/push/notify', notifyBody({
    dedupeKey: 'bad key!',
  }), () => ({ subscriptions: ONE_SUB })));
  add('POST notify deduped', () => post('/api/push/notify', notifyBody()), () => ({
    subscriptions: ONE_SUB,
    seedReceipt: { request: notifyBody() },
  }));
  add('POST notify a reused key', () => post('/api/push/notify', notifyBody()), () => ({
    subscriptions: ONE_SUB,
    seedReceipt: { request: notifyBody(), reuse: true },
  }));

  return pending;
}

// ── the stub Node child: the real host-port composition over the world ────

function upstreamSource(repo) {
  return `'use strict';
// Same frozen clock as the oracle side: receipts, device stamps and payload
// times must agree byte for byte.
Date.now = () => ${FROZEN_NOW};
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/native/binding')).authSecurity;
const { connectAuthControl } = require(path.join(REPO, 'src/native/binding')).gatewayChild;
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/push-scripted-world'));
const { mountPushHostRoute } = require(path.join(REPO, 'src/routes/push-host'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null, answers: {} }; }
}

// One world per case, like one server process: the four stores a route
// touches (subscriptions, FCM, Bark, channels, receipts) must keep the case's
// own state.
const bags = new Map();
const reported = new Map();
function bagFor(scenario) {
  const key = String(scenario.case || '');
  let bag = bags.get(key);
  if (!bag) { bag = world.buildDeps(scenario); bags.set(key, bag); }
  return bag;
}

const app = express();
app.get('/__health', (_req, res) => res.send('ok'));
app.use(express.json({ limit: '50mb' }));
app.post('/api/__host/push', (req, res, next) => {
  const scenario = readWorld();
  const key = String(scenario.case || '');
  const bag = bagFor(scenario);
  res.on('finish', () => {
    const calls = bag.effects.calls;
    const from = reported.get(key) || 0;
    const fresh = calls.slice(from);
    reported.set(key, calls.length);
    if (!fresh.length) return;
    fs.appendFileSync(effectsPath,
      JSON.stringify({ case: bag.scenario.case || null, calls: fresh }) + '\\n');
  });
  const inner = express();
  mountPushHostRoute(inner, world.currentHostOptions(bag));
  return inner(req, res, next);
});
app.use((_req, res) => res.status(404).end('forwarded'));

const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const end = buffered.indexOf('\\r\\n');
    if (end < 0) return;
    socket.removeListener('data', onData);
    socket.pause();
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket);
    socket.resume();
  };
  socket.on('data', onData);
  socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
`;
}

// ── response normalization ─────────────────────────────────────────────────

// Only the value that cannot agree by construction: the uuid the Bark store
// assigns to a newly added device. Everything else is frozen on both sides.
function normalize(text) {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'push-routes',
  mount(app, { repo, work }) {
    // A missed dependency would otherwise fall back to the data root (the
    // checkout itself) and leak test devices into the real files.
    process.env.MULTICC_DATA_DIR = work;
    // The Node side stamps receipts/devices in this process; the stub child
    // gets the same value (below), so the two sides see one clock.
    Date.now = () => FROZEN_NOW;
    worldPath = path.join(work, 'push-world.json');
    effectsPath = path.join(work, 'push-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify({ case: 'initial', answers: {} }));
    const helper = require(path.join(repo, 'tests/helpers/push-scripted-world'));
    buildDeps = helper.buildDeps;
    const express = require(require.resolve('express', { paths: [repo] }));
    setLegacyHandler = (bag) => {
      const inner = express();
      inner.use(express.json({ limit: '50mb' }));
      helper.mountLegacy(inner, bag);
      currentHandler = inner;
    };
    app.use((req, res, next) => (currentHandler ? currentHandler(req, res, next) : next()));
    legacyBag = buildDeps({ case: 'initial', answers: {} });
    setLegacyHandler(legacyBag);
    upstreamText = upstreamSource(repo);
  },
  ready: waitForFixture,
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    HOST: '127.0.0.1',
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: work,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
    // The retired handlers stamp the test payload with
    // `new Date(now()).toLocaleTimeString()`; the production gateway inherits
    // the server's locale, so the child must too (lib.js keeps only PATH/HOME
    // by default).
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
  }),
  normalize,
  corpus,
  finalize({ work, views }) {
    // Byte-identical is not enough on its own: if the scripted world failed to
    // resolve, both sides could 500 with the same envelope for every case and
    // still "match". Pin the answers that prove each route really ran, and
    // check that the routes are all exercised.
    const byName = new Map(views.map(view => [view.name, view]));
    const problems = [];
    const expect = (name, status, needle) => {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); return; }
      for (const side of ['node', 'rust']) {
        if (view[side].status !== status) {
          problems.push(`${name}: ${side} answered ${view[side].status}, expected ${status}`);
        }
        if (needle && !view[side].body.includes(needle)) {
          problems.push(`${name}: ${side} body lacks ${needle} (${view[side].body})`);
        }
      }
    };
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500 && view[side].body.includes('"error":"internal_error"')) {
          problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
        }
      }
    }
    // FCM
    expect('GET fcm', 200, '"configured":true');
    expect('GET fcm not configured', 200, '"configured":false');
    expect('GET fcm storage unavailable', 200, '"storageAvailable":false');
    expect('POST fcm register', 200, '"status":200,"ok":true');
    expect('POST fcm register for another project', 409, '"error":"FCM_PROJECT_MISMATCH"');
    expect('POST fcm register not configured', 503, '"error":"FCM_NOT_CONFIGURED"');
    expect('POST fcm register storage unavailable', 500, '"error":"push request failed"');
    expect('POST fcm register at the device limit', 409, '"error":"FCM_DEVICE_LIMIT"');
    expect('DELETE fcm', 200, '"status":200,"ok":true');
    expect('DELETE fcm without a binding', 400, '"error":"INVALID_FCM_DEVICE"');
    expect('POST fcm test', 200, '"accepted":1');
    expect('POST fcm test an unregistered device', 502, '"failed":1');
    // Bark
    expect('GET bark devices with a legacy device', 200, '"id":"legacy"');
    expect('GET bark devices storage unavailable', 503, '"error":"bark_storage_unavailable"');
    expect('POST bark add', 200, '"ok":true');
    expect('POST bark add a duplicate', 409, '"error":"device_already_added"');
    expect('POST bark update', 200, '"name":"Renamed"');
    expect('POST bark remove', 200, '"devices":[]');
    expect('POST bark test', 200, '"accepted":1');
    expect('POST bark test a rejecting server', 502, '"error":"bark_test_failed"');
    expect('POST bark an unknown action', 400, '"error":"invalid_action"');
    // plugin channels
    expect('GET channel subscriptions', 200, '"categories":["done","question","background","error"]');
    expect('PUT channel subscriptions', 200, '"id":"chs_');
    expect('PUT channel subscriptions an unknown target', 400, '"code":"unknownTarget"');
    expect('PUT channel subscriptions a duplicate target', 400, '"code":"duplicate"');
    expect('PUT channel subscriptions unreadable store', 500, '"code":"unreadable"');
    expect('DELETE channel subscription encoded', 200, '"subscriptions":[]');
    expect('DELETE channel subscription unknown', 404, '"code":"notFound"');
    expect('DELETE channel subscription malformed escape', 400, '"code":"request_error"');
    expect('POST test-channel', 200, '"ok":true');
    expect('POST test-channel down', 503, '"code":"pluginDown"');
    // web push
    expect('POST subscribe', 200, '"ok":true');
    expect('POST subscribe a failing save', 500, '"error":"push request failed"');
    expect('DELETE subscribe', 200, '"ok":true');
    expect('POST validate known', 200, '"known":true');
    expect('POST validate unknown', 200, '"known":false');
    expect('POST validate without an endpoint', 400, '"error":"Missing endpoint"');
    expect('POST test', 200, '"ok":true,"subscribers":1');
    expect('POST test-bark not configured', 400, '"error":"Bark URL not configured"');
    expect('POST test-bark failed', 502, '"error":"bark_test_failed"');
    expect('POST test-webhook not configured', 400, '"error":"Webhook URL not configured"');
    expect('POST test-webhook', 200, '"ok":true');
    expect('POST notify', 200, '"deduped":false');
    expect('POST notify without subscribers', 503, '"error":"NO_PUSH_SUBSCRIBERS"');
    expect('POST notify a non-JSON media type', 415, '"error":"UNSUPPORTED_MEDIA_TYPE"');
    expect('POST notify an unknown field', 400, '"error":"UNKNOWN_FIELD"');
    expect('POST notify deduped', 200, '"deduped":true');
    expect('POST notify a reused key', 409, '"error":"IDEMPOTENCY_KEY_REUSE"');
    // OPTIONS unions
    expect('OPTIONS fcm', 200, 'GET,HEAD,POST,DELETE');
    expect('OPTIONS fcm test', 200, 'POST');
    expect('OPTIONS bark devices', 200, 'GET,HEAD,POST');
    expect('OPTIONS channel subscriptions', 200, 'GET,HEAD,PUT,POST');
    expect('OPTIONS channel subscription id', 200, 'DELETE');
    expect('OPTIONS subscribe', 200, 'POST,DELETE');

    // Every route group must have produced a 2xx at least once; a corpus that
    // stopped exercising a route would otherwise silently shrink.
    const exercised = {
      'GET fcm': true,
      'POST fcm register': true,
      'DELETE fcm': true,
      'POST fcm test': true,
      'GET bark devices': true,
      'POST bark add': true,
      'GET channel subscriptions': true,
      'PUT channel subscriptions': true,
      'POST channel subscriptions upsert': true,
      'DELETE channel subscription': true,
      'POST test-channel': true,
      'POST subscribe': true,
      'DELETE subscribe': true,
      'POST validate known': true,
      'POST test': true,
      'POST notify': true,
      'POST test-bark': true,
      'POST test-webhook': true,
    };
    for (const [name, _flag] of Object.entries(exercised)) {
      const view = byName.get(name);
      if (!view || view.node.status < 200 || view.node.status >= 300) {
        problems.push(`${name}: route was not exercised (node status ${view ? view.node.status : 'missing'})`);
      }
    }

    // The 503 surface has no Node twin and is covered by the live suite only.
    const suitePath = path.join(__dirname, '../../../native/gateway/tests/push_routes.rs');
    let suiteText = '';
    try { suiteText = fs.readFileSync(suitePath, 'utf8'); } catch (_) {}
    if (!suiteText.includes('host_unreachable_is_the_documented_503')) {
      problems.push('native/gateway/tests/push_routes.rs lost the 503 coverage test');
    }

    const rustEffects = new Map();
    const text = fs.readFileSync(effectsPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!rustEffects.has(entry.case)) rustEffects.set(entry.case, []);
      rustEffects.get(entry.case).push(...entry.calls);
    }
    const mismatches = [];
    for (const [tag, calls] of nodeEffects) {
      const rust = rustEffects.get(tag) || [];
      if (JSON.stringify(calls) !== JSON.stringify(rust)) mismatches.push({ tag, node: calls, rust });
    }
    const details = path.join(work, 'effect-mismatches.json');
    fs.writeFileSync(details, JSON.stringify(mismatches, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
    }
    if (problems.length) {
      for (const problem of problems) console.log(`[push-routes] ${problem}`);
      const problemFile = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(problemFile, JSON.stringify(problems, null, 2));
      return { ok: false, details: problemFile };
    }
    if (mismatches.length) {
      console.log(`[push-routes] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[push-routes] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
