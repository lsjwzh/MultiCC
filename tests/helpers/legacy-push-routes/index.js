'use strict';

// FROZEN ORACLE — the push cluster as it was mounted before the migration,
// assembled exactly the way HEAD:server.js assembled it:
//
//   pushRuntime.mountRoutes(app)
//     -> fcmDevices.mountRoutes(app, guard)
//     -> mountBarkDeviceRoutes(app, push.barkDevices, guard)
//     -> mountChannelSubscriptionRoutes(app, push.channelSubscriptions, guard, otherChannels)
//     -> POST /api/push/subscribe | /validate | /test | /notify | /test-bark | /test-webhook
//     -> DELETE /api/push/subscribe
//
// The four mount bodies below are `git show HEAD:src/push/*.js` snapshots of
// the retired handlers, with only the closure bindings turned into explicit
// arguments (the same modules' factory functions are still live and shared by
// both sides). The migration differential
// (docs/rust-migration/differential/push-routes.js) mounts this over the same
// scripted world (tests/helpers/push-scripted-world.js) the Rust front door
// calls through its host port, and compares status, body, headers and the
// side-effect call sequence.
//
// The live modules are still required underneath (fcm/bark/channel factories,
// the business push service, the channel registry): those data planes did not
// move and must not be forked here.

const { sanitizePublicText } = require('../../../src/http/public-safety');
const { BusinessPushRequestError } = require('../../../src/push/business');
const { BarkDeviceError } = require('../../../src/push/bark-devices');
const { ChannelSubscriptionError } = require('../../../src/push/channel-subscriptions');
const registry = require('../../../src/plugins/channel-registry');

// HEAD:src/push/fcm-devices.js validators, verbatim.
const FCM_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const validFcmId = value => typeof value === 'string' && FCM_ID.test(value);

// createPushRuntime's closure helpers, verbatim.
function makeGuard(logger) {
  function warn(label, error) {
    const safe = sanitizePublicText(error && error.message, 'push runtime failed');
    try { logger.warn(`[multicc/push] ${label}: ${safe}`); } catch (_) {}
  }
  return function route(handler) {
    return function guardedPushRoute(req, res, next) {
      Promise.resolve().then(() => handler(req, res)).catch(error => {
        if (res.headersSent && typeof next === 'function') return next(error);
        warn('request failed', error);
        return res.status(500).json({ error: 'push request failed' });
      });
    };
  };
}

// HEAD:src/push/fcm-devices.js `mountRoutes`, with the device object explicit.
function mountFcmRoutes(app, guard, devices) {
  // Host global authentication protects all of these endpoints.
  app.get('/api/push/fcm', guard((_req, res) => res.json(devices.status())));
  app.post('/api/push/fcm', guard((req, res) => { const r = devices.register(req.body); return res.status(r.status).json(r); }));
  app.delete('/api/push/fcm', guard((req, res) => { const r = devices.remove(req.body); return res.status(r.status).json(r); }));
  app.post('/api/push/fcm/test', guard(async (req, res) => {
    if (!validFcmId(req.body?.id)) return res.status(400).json({ error: 'INVALID_FCM_DEVICE' });
    const result = await devices.send({ title: 'MultiCC', body: 'FCM test' }, req.body.id);
    return res.status(result.ok ? 200 : 502).json(result);
  }));
}

// HEAD:src/push/bark-devices.js `mountBarkDeviceRoutes`, verbatim.
function mountBarkDeviceRoutes(app, devices, route) {
  const handle = fn => route(async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (!(error instanceof BarkDeviceError)) throw error;
      res.status(error.status).json({ error: error.code });
    }
  });
  app.get('/api/push/bark-devices', handle(async (_req, res) => res.json({ devices: devices.list() })));
  app.post('/api/push/bark-devices', handle(async (req, res) => {
    const input = req.body || {};
    if (input.action === 'add') {
      const id = devices.add(input);
      return res.json({ ok: true, id, devices: devices.list() });
    }
    if (input.action === 'update') devices.update(input.id, input);
    else if (input.action === 'remove') devices.remove(input.id);
    else if (input.action === 'test') {
      if (typeof input.id !== 'string' || !input.id) throw new BarkDeviceError('device_not_found', 404);
      const result = await devices.send('MultiCC 测试提醒', '收到这条通知，说明这台手机可以接收 MultiCC 提醒。', '', input.id);
      return res.status(result.ok ? 200 : 502).json({ ...result, ...(result.ok ? {} : { error: 'bark_test_failed' }) });
    } else throw new BarkDeviceError('invalid_action');
    return res.json({ ok: true, devices: devices.list() });
  }));
}

// HEAD:src/push/channel-subscriptions.js `mountChannelSubscriptionRoutes`,
// verbatim.
function mountChannelSubscriptionRoutes(app, store, route, otherChannels) {
  const payload = () => ({
    subscriptions: store.list(),
    categories: [...registry.CATEGORIES],
    defaults: [...registry.DEFAULT_CATEGORIES],
    otherChannels: otherChannels(),
  });
  const handle = work => route(async (req, res) => {
    try {
      await work(req);
      return res.json(payload());
    } catch (error) {
      if (!(error instanceof ChannelSubscriptionError)) throw error;
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
  });
  app.get('/api/push/channel-subscriptions', handle(async () => {}));
  app.put('/api/push/channel-subscriptions', handle(async req => store.replace(req.body && req.body.subscriptions)));
  app.post('/api/push/channel-subscriptions', handle(async req => store.upsert(req.body || {})));
  app.delete('/api/push/channel-subscriptions/:id', handle(async req => store.remove(String(req.params.id))));
  app.post('/api/push/test-channel', route(async (req, res) => {
    try {
      return res.json(await store.test(req.body || {}));
    } catch (error) {
      if (!(error instanceof ChannelSubscriptionError)) throw error;
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
  }));
}

// HEAD:src/push/runtime.js `mountRoutes`, with the runtime facts explicit.
function mountRoutes(app, { push, businessPush, logger, now }) {
  if (!app || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new TypeError('push routes require Express post/delete');
  }
  const route = makeGuard(logger);
  if (push.fcmDevices) mountFcmRoutes(app, route, push.fcmDevices);
  if (push.barkDevices) mountBarkDeviceRoutes(app, push.barkDevices, route);
  if (push.channelSubscriptions && typeof app.get === 'function' && typeof app.put === 'function') {
    mountChannelSubscriptionRoutes(app, push.channelSubscriptions, route, () => {
      const fcm = push.fcmDevices && typeof push.fcmDevices.list === 'function' ? push.fcmDevices.list().filter(device => device.enabled !== false).length
        : (push.fcmDevices?.hasEnabled() ? 1 : 0);
      const bark = Boolean(push.hasBarkDevices ? push.hasBarkDevices() : push.cfg.BARK_URL);
      const webhook = Boolean(push.cfg.WEBHOOK_URL);
      return { webPush: push.subscriptions.size, fcm, bark, webhook, any: push.subscriptions.size > 0 || fcm > 0 || bark || webhook };
    });
  }
  app.post('/api/push/subscribe', route(async (req, res) => {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const previous = push.subscriptions.get(subscription.endpoint);
    const existed = push.subscriptions.has(subscription.endpoint);
    push.subscriptions.set(subscription.endpoint, subscription);
    try {
      await push.saveSubscriptions();
    } catch (error) {
      if (existed) push.subscriptions.set(subscription.endpoint, previous);
      else push.subscriptions.delete(subscription.endpoint);
      throw error;
    }
    try { logger.log(`[multicc/push] New subscription (${push.subscriptions.size} total)`); } catch (_) {}
    return res.json({ ok: true });
  }));
  app.delete('/api/push/subscribe', route(async (req, res) => {
    const { endpoint } = req.body || {};
    if (endpoint && push.subscriptions.has(endpoint)) {
      const previous = push.subscriptions.get(endpoint);
      push.subscriptions.delete(endpoint);
      try {
        await push.saveSubscriptions();
      } catch (error) {
        push.subscriptions.set(endpoint, previous);
        throw error;
      }
    }
    return res.json({ ok: true });
  }));
  app.post('/api/push/validate', route((req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    return res.json({ known: push.subscriptions.has(endpoint) });
  }));
  app.post('/api/push/test', route(async (req, res) => {
    const payload = {
      title: 'MultiCC Test',
      body: `Push test at ${new Date(now()).toLocaleTimeString()}`,
      type: 'test',
      tag: 'multicc-test',
      url: '/manage',
    };
    await push.sendPushToAll(payload);
    await push.sendBarkNotification(payload.title, payload.body, payload.url);
    await push.sendWebhookNotification(payload);
    return res.json({ ok: true, subscribers: push.subscriptions.size });
  }));
  app.post('/api/push/notify', route(async (req, res) => {
    if (typeof req.is !== 'function' || !req.is('application/json')) {
      return res.status(415).json({
        ok: false,
        delivered: false,
        deduped: false,
        error: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }
    try {
      const result = await businessPush.notify(req.body);
      return res.status(result.statusCode).json(result.body);
    } catch (error) {
      if (!(error instanceof BusinessPushRequestError)) throw error;
      return res.status(error.statusCode).json({
        ok: false,
        delivered: false,
        deduped: false,
        error: error.code,
        ...(error.field ? { field: error.field } : {}),
      });
    }
  }));
  app.post('/api/push/test-bark', route(async (req, res) => {
    if (!(push.hasBarkDevices ? push.hasBarkDevices() : push.cfg.BARK_URL)) return res.status(400).json({ error: 'Bark URL not configured' });
    const result = await push.sendBarkNotification(
      'MultiCC Test', `Bark test at ${new Date(now()).toLocaleTimeString()}`, '/manage',
    );
    if (result?.ok === false) return res.status(502).json({ error: 'bark_test_failed' });
    return res.json({ ok: true });
  }));
  app.post('/api/push/test-webhook', route(async (req, res) => {
    if (!push.cfg.WEBHOOK_URL) return res.status(400).json({ error: 'Webhook URL not configured' });
    await push.sendWebhookNotification({
      title: 'MultiCC Test',
      body: `Webhook test at ${new Date(now()).toLocaleTimeString()}`,
      type: 'test',
    });
    return res.json({ ok: true });
  }));
  return app;
}

module.exports = {
  mountRoutes,
  mountFcmRoutes,
  mountBarkDeviceRoutes,
  mountChannelSubscriptionRoutes,
};
