'use strict';

// 宿主端口（host port）：`/api/subagent-defaults` 已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/subagent_defaults.rs）独占，规则、校验、
// 计划、序列化与错误映射都在 Rust。这里只剩 Node 独有的宿主事实与副作用：
//
//   state    会话表投影（pending 配置应用后的期望状态）+ provider-defaults 的 subagent
//   facts    provider 是否可用 / Codex 是否可代理 / 是否官方 OAuth（provider store 在内存里）
//   persist  写 provider-defaults.json 并更新进程内那份对象（旧 providerDefaults 的身份）
//   patch    逐个会话执行 applySessionPatch / previewSessionPatch（暂存、广播、工作区）
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求，所以前门的公网端口也拿不到额外能力
// （docs/gateway.md 的内网端口模型）。Rust 接管会话存储与 provider 默认值后本文件删除。

const { sanitizePublicText } = require('../http/public-safety');
const { isLocalRequest } = require('../request-locality');
const { desiredSession } = require('../session/pending-configuration');

const HOST_PATH = '/api/__host/subagent-defaults';

function listSessions(sessions) {
  if (sessions instanceof Map) return [...sessions.values()];
  return Array.isArray(sessions) ? sessions : [];
}

// 与退役的 src/routes/subagent-defaults.js 逐字段一致：归属判断必须在
// 「pending 配置已应用」的期望状态上做，和真正执行 PATCH 的会话看到的是同一份草稿。
function planSessions(sessions) {
  const list = [];
  for (const session of listSessions(sessions)) {
    if (!session || typeof session !== 'object') continue;
    let desired = session;
    try { desired = desiredSession(session); } catch (_) { desired = session; }
    list.push({
      id: String(session.id || ''),
      name: String(session.label || session.name || session.id || ''),
      cli: desired.cli || '',
      kind: desired.kind || '',
      type: desired.type == null ? null : desired.type,
      ephemeral: desired.ephemeral === true,
      loginFlow: desired.loginFlow == null ? null : desired.loginFlow,
      provider: desired.provider == null ? null : desired.provider,
      subagent: desired.subagent == null ? null : desired.subagent,
      pending: !!session.pendingConfiguration,
    });
  }
  return list;
}

function mountSubagentDefaultsHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[subagent-defaults-host] Express-compatible app is required');
  }
  const providerDefaults = options.providerDefaults;
  if (!providerDefaults || typeof providerDefaults !== 'object') {
    throw new TypeError('[subagent-defaults-host] providerDefaults object is required');
  }
  const sessions = options.sessions;
  const validProviderId = options.validProviderId;
  const providers = options.providers || {};
  const persistDefaults = options.persistDefaults;
  if (typeof validProviderId !== 'function' || typeof persistDefaults !== 'function') {
    throw new TypeError('[subagent-defaults-host] validProviderId and persistDefaults are required');
  }
  const applySessionPatch = options.applySessionPatch;
  const previewSessionPatch = options.previewSessionPatch;
  // 测试注入；生产解析与其余路由同一个原生实现，每次请求现取。
  const isLocal = options.isLocal || isLocalRequest;

  function isOfficialCodexProvider(providerId) {
    let provider = null;
    try { provider = typeof providers.getProvider === 'function' ? providers.getProvider('codex', providerId) : null; } catch (_) { provider = null; }
    if (!provider) return false;
    if (typeof providers.isOfficialCodexOAuthProvider === 'function') {
      try { return !!providers.isOfficialCodexOAuthProvider(provider); } catch (_) { return false; }
    }
    return provider.isOfficial === true;
  }

  function facts(family, providerId) {
    let valid = false;
    let proxyable = false;
    let official = false;
    try { valid = validProviderId(family, providerId)?.ok === true; } catch (_) { valid = false; }
    if (family === 'codex') {
      try { proxyable = !!providers.codexProviderProxyable?.(providerId); } catch (_) { proxyable = false; }
      official = isOfficialCodexProvider(providerId);
    }
    return { valid, proxyable, official };
  }

  // 一个会话失败（被拒或 patch 抛异常）不能掩盖其他会话已经发生的事：
  // 此刻默认值已落盘、前面的会话已 PATCH，所以失败按会话逐个回报。
  function patch(sessionId, targetRoute, dryRun) {
    const body = targetRoute ? { subagent: targetRoute, subagentInherited: true } : { subagent: null };
    if (dryRun && typeof previewSessionPatch !== 'function') {
      // 兼容路径：没有预览运行时时，dry run 唯一能预知的是已暂存的配置。
      return { ok: true, compat: true };
    }
    let result;
    try {
      result = dryRun ? previewSessionPatch(sessionId, body) : applySessionPatch(sessionId, body);
    } catch (error) {
      result = { status: 500, body: { error: error && error.message } };
    }
    if (!result || result.status !== 200) {
      return {
        ok: true,
        status: result && typeof result.status === 'number' ? result.status : 500,
        detail: sanitizePublicText(result && result.body && result.body.error, 'session patch rejected'),
      };
    }
    return { ok: true, status: 200, deferred: !!(result.body && result.body.deferred === true) };
  }

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    if (body.op === 'state') {
      return res.json({
        subagent: Object.prototype.hasOwnProperty.call(providerDefaults, 'subagent')
          ? providerDefaults.subagent : null,
        sessions: planSessions(sessions),
      });
    }
    if (body.op === 'facts') {
      const family = typeof body.family === 'string' ? body.family : '';
      const providerId = typeof body.providerId === 'string' ? body.providerId : '';
      return res.json(facts(family, providerId));
    }
    if (body.op === 'persist') {
      const next = { ...providerDefaults, subagent: body.defaults ?? null };
      try {
        persistDefaults(next);
      } catch (_) {
        return res.json({ ok: false });
      }
      Object.assign(providerDefaults, next);
      return res.json({ ok: true });
    }
    if (body.op === 'patch') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const targetRoute = body.subagent && typeof body.subagent === 'object' && !Array.isArray(body.subagent)
        ? body.subagent : null;
      return res.json(patch(sessionId, targetRoute, body.dryRun === true));
    }
    return res.status(400).json({ error: 'unknown host operation' });
  });
}

// 会话表投影也是宿主事实的一部分：差异测试用它给两侧喂同一份输入。
module.exports = { mountSubagentDefaultsHostRoute, planSessions, HOST_PATH };
