'use strict';

// 宿主端口：推送面 18 条公开路由已由 Rust 前门独占
// （native/gateway/src/app/push_routes.rs，规则在
// native/core/src/push_routes.rs）：
//
//   POST   /api/push/subscribe              DELETE /api/push/subscribe
//   POST   /api/push/validate               POST   /api/push/test
//   POST   /api/push/notify                 POST   /api/push/test-bark
//   POST   /api/push/test-webhook
//   GET    /api/push/channel-subscriptions  PUT    /api/push/channel-subscriptions
//   POST   /api/push/channel-subscriptions  DELETE /api/push/channel-subscriptions/:id
//   POST   /api/push/test-channel
//   GET    /api/push/fcm                    POST   /api/push/fcm
//   DELETE /api/push/fcm                    POST   /api/push/fcm/test
//   GET    /api/push/bark-devices           POST   /api/push/bark-devices
//
// 路径匹配、参数解码、Express 自动 OPTIONS、请求体闸门（subscribe/validate 的
// 必填字段、notify 的媒体类型、FCM id/token 形状、Bark action 词表）、以及每个
// 响应信封的字段与顺序都在 Rust。这里只剩 Rust 看不到的 Node 运行时事实与真实
// 副作用：进程内订阅/健康 Map、FCM 与 Bark 设备库、插件渠道订阅库、web-push /
// FCM / Bark / webhook 发送器、业务推送的去重回执库。
//
// 处理器按退休时的样子写 `res.status(...).json(...)`（captureReply 把渲染结果
// 变成 `{ status, body }`），Rust 决定最终信封。返回值里，某些成功体是原料
// （例如 validate 的 `known`、test-bark 的 `configured/ok`），由 Rust 组装
// 最终 DTO；某些是渲染好的 reply（业务推送、Bark action），因为错误类与回执库
// 融合在 Node 里。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { BusinessPushRequestError } = require('../push/business');

const HOST_PATH = '/api/__host/push';

/** Marker meaning "this op has no dependency to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[push-host] dependencies are required');
  }
  const push = deps.push;
  if (!push || typeof push !== 'object') {
    throw new TypeError('[push-host] dependency missing: push');
  }
  if (!push.subscriptions || typeof push.subscriptions.get !== 'function') {
    throw new TypeError('[push-host] dependency missing: push.subscriptions');
  }
  if (!push.cfg || typeof push.cfg !== 'object') {
    throw new TypeError('[push-host] dependency missing: push.cfg');
  }
  for (const name of ['saveSubscriptions', 'sendPushToAll', 'sendBarkNotification', 'sendWebhookNotification']) {
    if (typeof push[name] !== 'function') {
      throw new TypeError(`[push-host] push service missing: ${name}`);
    }
  }
  return deps;
}

/** `res` as the retired handlers used it: they render, we take the value. */
function captureReply() {
  const reply = { status: 200, body: null };
  const res = {
    headersSent: false,
    status(code) { reply.status = code; return res; },
    json(body) { reply.body = body === undefined ? null : body; return res; },
    send(body) { reply.body = body === undefined ? null : body; return res; },
    set() { return res; },
    setHeader() { return res; },
    end(body) { if (body !== undefined) reply.body = body; return res; },
  };
  return { reply, res };
}

// 插件渠道的「只开了插件渠道」提示：退休 handler 里 otherChannels() 的原样副本。
function otherChannels(push) {
  const fcm = push.fcmDevices && typeof push.fcmDevices.list === 'function'
    ? push.fcmDevices.list().filter(device => device.enabled !== false).length
    : (push.fcmDevices && push.fcmDevices.hasEnabled && push.fcmDevices.hasEnabled() ? 1 : 0);
  const bark = Boolean(push.hasBarkDevices ? push.hasBarkDevices() : push.cfg.BARK_URL);
  const webhook = Boolean(push.cfg.WEBHOOK_URL);
  return {
    webPush: push.subscriptions.size,
    fcm,
    bark,
    webhook,
    any: push.subscriptions.size > 0 || fcm > 0 || bark || webhook,
  };
}

// `mountChannelSubscriptionRoutes` 的 handle：捕获 ChannelSubscriptionError 渲染
// `{ status, error, code }`，其余抛出。这里把它变成结构化值，Rust 再渲染。
async function channelOp(push, work) {
  try {
    const subscriptions = await work();
    return { subscriptions, otherChannels: otherChannels(push) };
  } catch (error) {
    const { ChannelSubscriptionError } = require('../push/channel-subscriptions');
    if (!(error instanceof ChannelSubscriptionError)) throw error;
    return { channelError: { status: error.status, message: error.message, code: error.code } };
  }
}

async function testChannelOp(push, input) {
  const { ChannelSubscriptionError } = require('../push/channel-subscriptions');
  try {
    return await push.channelSubscriptions.test(input || {});
  } catch (error) {
    if (!(error instanceof ChannelSubscriptionError)) throw error;
    return { channelError: { status: error.status, message: error.message, code: error.code } };
  }
}

async function invoke(deps, body, extra) {
  const { push, businessPush, logger } = extra;
  switch (body.op) {
    case 'subscribe': {
      const subscription = body.body;
      if (!subscription || !subscription.endpoint) {
        return { status: 400, body: { error: 'Invalid subscription' } };
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
      return { ok: true };
    }
    case 'unsubscribe': {
      const { endpoint } = body.body || {};
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
      return { ok: true };
    }
    case 'validate': {
      return { known: push.subscriptions.has(body.endpoint) };
    }
    case 'test': {
      const payload = {
        title: 'MultiCC Test',
        body: `Push test at ${new Date(extra.now()).toLocaleTimeString()}`,
        type: 'test',
        tag: 'multicc-test',
        url: '/manage',
      };
      await push.sendPushToAll(payload);
      await push.sendBarkNotification(payload.title, payload.body, payload.url);
      await push.sendWebhookNotification(payload);
      return { subscribers: push.subscriptions.size };
    }
    case 'notify': {
      try {
        const result = await businessPush.notify(body.body);
        return { status: result.statusCode, body: result.body };
      } catch (error) {
        if (!(error instanceof BusinessPushRequestError)) throw error;
        return {
          status: error.statusCode,
          body: {
            ok: false,
            delivered: false,
            deduped: false,
            error: error.code,
            ...(error.field ? { field: error.field } : {}),
          },
        };
      }
    }
    case 'test-bark': {
      const configured = push.hasBarkDevices ? push.hasBarkDevices() : push.cfg.BARK_URL;
      if (!configured) return { configured: false };
      const result = await push.sendBarkNotification(
        'MultiCC Test', `Bark test at ${new Date(extra.now()).toLocaleTimeString()}`, '/manage',
      );
      return { configured: true, ok: !(result && result.ok === false) };
    }
    case 'test-webhook': {
      if (!push.cfg.WEBHOOK_URL) return { configured: false };
      await push.sendWebhookNotification({
        title: 'MultiCC Test',
        body: `Webhook test at ${new Date(extra.now()).toLocaleTimeString()}`,
        type: 'test',
      });
      return { configured: true };
    }
    case 'channel-get': {
      return channelOp(push, async () => push.channelSubscriptions.list());
    }
    case 'channel-replace': {
      return channelOp(push, async () => push.channelSubscriptions.replace(body.subscriptions));
    }
    case 'channel-upsert': {
      return channelOp(push, async () => push.channelSubscriptions.upsert(body.body || {}));
    }
    case 'channel-remove': {
      return channelOp(push, async () => push.channelSubscriptions.remove(String(body.id)));
    }
    case 'test-channel': {
      return testChannelOp(push, body.body);
    }
    case 'fcm-status': {
      // Raw `status()`; Rust reassembles `{ configured, devices, storageAvailable }`.
      return push.fcmDevices.status();
    }
    case 'fcm-register': {
      // Raw `r`; it carries its own `status`, which Rust lifts to the HTTP line.
      return push.fcmDevices.register(body.body);
    }
    case 'fcm-remove': {
      return push.fcmDevices.remove(body.body);
    }
    case 'fcm-test': {
      return push.fcmDevices.send({ title: 'MultiCC', body: 'FCM test' }, body.id);
    }
    case 'bark-list': {
      try {
        return { devices: push.barkDevices.list() };
      } catch (error) {
        const { BarkDeviceError } = require('../push/bark-devices');
        if (!(error instanceof BarkDeviceError)) throw error;
        return { status: error.status, body: { error: error.code } };
      }
    }
    case 'bark-action': {
      return barkAction(push, body.body || {});
    }
    default:
      return UNKNOWN;
  }
}

async function barkAction(push, input) {
  const { BarkDeviceError } = require('../push/bark-devices');
  try {
    if (input.action === 'add') {
      const id = push.barkDevices.add(input);
      return { status: 200, body: { ok: true, id, devices: push.barkDevices.list() } };
    }
    if (input.action === 'update') push.barkDevices.update(input.id, input);
    else if (input.action === 'remove') push.barkDevices.remove(input.id);
    else if (input.action === 'test') {
      if (typeof input.id !== 'string' || !input.id) throw new BarkDeviceError('device_not_found', 404);
      const result = await push.barkDevices.send(
        'MultiCC 测试提醒', '收到这条通知，说明这台手机可以接收 MultiCC 提醒。', '', input.id,
      );
      return {
        status: result.ok ? 200 : 502,
        body: { ...result, ...(result.ok ? {} : { error: 'bark_test_failed' }) },
      };
    } else throw new BarkDeviceError('invalid_action');
    return { status: 200, body: { ok: true, devices: push.barkDevices.list() } };
  } catch (error) {
    if (!(error instanceof BarkDeviceError)) throw error;
    return { status: error.status, body: { error: error.code } };
  }
}

function mountPushHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[push-host] Express-compatible app is required');
  }
  const deps = assertDependencies(options);
  const isLocal = options.isLocal || require('../native/binding').requestLocality.isLocalRequest;
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const extra = {
    push: deps.push,
    businessPush: deps.businessPush || deps.push.businessPush,
    logger,
    now,
  };
  if (!extra.businessPush || typeof extra.businessPush.notify !== 'function') {
    throw new TypeError('[push-host] dependency missing: businessPush');
  }

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    return Promise.resolve()
      .then(() => invoke(deps, body, extra))
      .then(
        (value) => {
          if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
          return res.json({ ok: true, value });
        },
        (error) => {
          try { logger.error(`[push-host] ${body.op} failed: ${error && error.message ? error.message : error}`); } catch (_) {}
          return res.status(500).json({ error: 'internal_error' });
        },
      );
  });
}

module.exports = { HOST_PATH, mountPushHostRoute };
