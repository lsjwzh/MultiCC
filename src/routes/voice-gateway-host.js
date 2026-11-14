'use strict';

// 宿主端口（host port）：`GET /api/voice-gateways` 与
// `GET/PUT/DELETE /api/directories/:id/voice-gateway`（含 /api/v1 变体）已经由
// Rust 前门（multicc-gateway）独占。HTTP 方法、路径、状态码、错误码映射、
// `acp.launch` 说明对象和 v1 的 apiVersion 元数据都在 Rust 一侧；这里只剩
// Node 独有的运行时事实与副作用：
//
//   list     内存记录表里仍存在的 per-Fleet 网关记录投影
//   inspect  一个目录的网关 + 绑定状态（Commander 解析依赖记录表）
//   ensure   写记录（sessionPersistence 的 mutate 端口）并按需 reconcile 子进程
//   remove   删记录并停掉对应子进程
//
// 四个 op 都是同步完成的：service 调用与 reconcile 之间没有 await，和旧单线程
// 路由逐请求等价（旧 `Promise.resolve(runtime?.stop?.(id))` 的同步抛错同样落进
// `thrown`）。`options` 缺失的键必须保持 undefined 交给 service 校验，JSON 里的
// null 原样透传。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const path = require('path');
const { isLocalRequest } = require('../request-locality');
const { createVoiceGatewayService, GATEWAY_PROVIDER } = require('../voice/gateway');

const HOST_PATH = '/api/__host/voice-gateway';

function publicBaseUrl(value) {
  try {
    const url = new URL(String(value || 'http://127.0.0.1:3000'));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    url.username = '';
    url.password = '';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return 'http://127.0.0.1:3000';
  }
}

function createVoiceGatewayHost({
  records,
  directories,
  sessionPersistence,
  acpAgentPath = path.join(__dirname, '..', 'voice', 'multicc-acp-agent.mjs'),
  nodePath = process.execPath,
  getBaseUrl = () => 'http://127.0.0.1:3000',
  runtime = null,
} = {}) {
  if (!sessionPersistence || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('[voice-gateway-host] sessionPersistence.mutate is required');
  }
  const service = createVoiceGatewayService({
    records,
    directories,
    mutate: (source, operation) => sessionPersistence.mutate(source, operation),
  });

  // 与旧 withLaunch 的启动事实同源（Rust 侧拼出完整的 acp 说明对象）。
  function launch() {
    return {
      command: nodePath,
      script: acpAgentPath,
      baseUrl: publicBaseUrl(getBaseUrl()),
    };
  }

  // 失败只回 code 与 gatewayIds；record 不外泄（旧 REST 失败体同样如此）。
  function failure(result) {
    return {
      ok: false,
      code: result.code,
      ...(result.gatewayIds ? { gatewayIds: result.gatewayIds } : {}),
    };
  }

  function thrown(error) {
    return { thrown: { code: error?.code, message: String(error?.message || error) } };
  }

  function mountRoutes(app) {
    if (!app || typeof app.post !== 'function') {
      throw new TypeError('[voice-gateway-host] Express-compatible app is required');
    }

    app.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      if (!isLocalRequest(req)) return res.status(404).json({ error: 'not found' });
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

      if (body.op === 'list') {
        return res.json({ gateways: service.list(), launch: launch() });
      }

      if (body.op === 'inspect') {
        const result = service.inspect(body.id);
        if (!result.ok) return res.json(failure(result));
        return res.json({ ok: true, gateway: result.gateway, launch: launch() });
      }

      if (body.op === 'ensure') {
        try {
          const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
            ? body.options : {};
          const result = service.ensure(body.id, {
            enabled: options.enabled,
            provider: options.provider,
            commanderSessionId: options.commanderSessionId,
          });
          if (!result.ok) return res.json(failure(result));
          runtime?.reconcile?.(body.id, { installIfNeeded: body.autoInstall === true });
          return res.json({
            ok: true,
            created: result.created,
            gateway: result.gateway,
            launch: launch(),
          });
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      if (body.op === 'remove') {
        try {
          const result = service.remove(body.id);
          if (!result.ok) return res.json(failure(result));
          Promise.resolve(runtime?.stop?.(body.id)).catch(() => {});
          return res.json(result);
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      return res.status(400).json({ error: 'unknown host operation' });
    });
  }

  return Object.freeze({ mountRoutes, service, provider: GATEWAY_PROVIDER });
}

module.exports = { createVoiceGatewayHost, publicBaseUrl, HOST_PATH };
