'use strict';

// 宿主端口（host port）：`GET /plugins/:id/*`（插件 UI 静态树）与
// `POST /api/channels/recheck`（插件发送前复核）已经由 Rust 前门
// （multicc-gateway）独占 —— 目录穿越、UI 子树闸门、MIME/Cache-Control 与
// 200 条上限都在那边判。这里只剩前门进程看不到的 Node 侧事实：
//
//   findPlugin          按 id 在各插件根目录里找 manifest（内置优先），回报插件
//                       目录与 UI 入口；前门据此重新做 realpath 与子树闸门
//   channelStillActive  逐个 (sessionId, category) 问 channel registry：那条任务
//                       的问题还在不在（会话状态机只在本进程里）
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求，所以前门的公网端口也拿不到额外能力
// （docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/plugins';

// 退役的 servePluginFile 用 `manifest.ui || 'ui/index.html'` 拼 UI 子树根：空值、
// 缺省与假值走默认；非字符串真值（数字、对象…）会在 path.dirname 抛 TypeError
// 变成 500。宿主端口把这层隐式 500 显式化成 `{ok:false,error}`，前门照此回错。
const DEFAULT_UI = 'ui/index.html';

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`[plugins-host] ${label} must be a function`);
}

// 与原 recheck 处理器同口径：`item && typeof item === 'object'` 才处理（数组也算对
// 象，字段缺省成空串），sessionId/category 截断照旧；真正的非对象项在新契约里
// 占一个 false 保持等长同序（原处理器是直接过滤掉）。
function recheckItems(items, stillActive) {
  return items.map(item => {
    if (!item || typeof item !== 'object') return false;
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.slice(0, 128) : '';
    const category = typeof item.category === 'string' ? item.category.slice(0, 32) : '';
    return Boolean(stillActive(sessionId, category));
  });
}

function mountPluginsHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[plugins-host] Express-compatible app is required');
  }
  const findManifest = options.findManifest;
  assertFunction(findManifest, 'findManifest');
  // deps 既可以是 channel registry 本身，也可以直接给 stillActive 函数。
  const stillActive = typeof options.stillActive === 'function'
    ? options.stillActive
    : options.channelRegistry && options.channelRegistry.stillActive;
  assertFunction(stillActive, 'channelRegistry.stillActive');
  // 测试注入；生产解析与其余路由同一个实现，每次请求现取。
  const isLocal = options.isLocal || options.isLocalRequest || isLocalRequest;

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    if (body.op === 'findPlugin') {
      const id = typeof body.id === 'string' ? body.id : '';
      const found = findManifest(id);
      if (!found || !found.manifest || typeof found.manifest !== 'object') {
        return res.json({ ok: true, found: false });
      }
      const declared = found.manifest.ui;
      if (declared) {
        if (typeof declared !== 'string') return res.json({ ok: false, error: { message: 'invalid manifest ui' } });
        return res.json({ ok: true, found: true, dir: found.dir, ui: declared });
      }
      return res.json({ ok: true, found: true, dir: found.dir, ui: DEFAULT_UI });
    }
    if (body.op === 'channelStillActive') {
      const items = Array.isArray(body.items) ? body.items : [];
      return res.json({ ok: true, active: recheckItems(items, stillActive) });
    }
    return res.status(400).json({ error: 'unknown host operation' });
  });
}

module.exports = { mountPluginsHostRoute, recheckItems, HOST_PATH, DEFAULT_UI };
