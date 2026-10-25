'use strict';

// 迁移桥接：Express/宿主 JS 回调不能跨 N-API 传递，保留授权、凭据和事件适配。
// 路由、模型、HTTP/TLS、流解析和协议兼容均由 native/cpr 实现。
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getNative } = require('../native/runtime');

function resolveCprBackend(env = process.env) {
  const backend = String(env.MULTICC_CPR_BACKEND || 'rust').trim().toLowerCase();
  if (!['node', 'rust'].includes(backend)) throw new Error('MULTICC_CPR_BACKEND 只支持 node 或 rust');
  return backend;
}

function createRustCprRouter(router, { native, env = process.env } = {}) {
  const unavailable = () => new Error('Rust CPR 模块不可用或版本不匹配，请重新构建 Rust 模块，或将 MULTICC_CPR_BACKEND 设为 node');
  try { native ||= getNative('cpr', 'rust'); } catch (_) { throw unavailable(); }
  if (native?.cprProtocolVersion?.() !== 1 || ['cprRoute', 'cprPrepare', 'cprCreateExchange'].some(name => typeof native[name] !== 'function')) {
    throw unavailable();
  }
  // 复用锁定版本 CPR 的现有宿主回调/能力令牌接口，不另写一套 JS 业务策略。
  const cprRoot = path.dirname(require.resolve('cli-provider-router'));
  const { createRequestHooks, createRequestStage } = require(path.join(cprRoot, 'proxy/request-hook'));
  const { createHopCredentialStore, authorizeManagedRequest } = require(path.join(cprRoot, 'proxy/hop-credentials'));
  const safeCall = (fn, ...args) => { try { return fn?.(...args); } catch (_) { /* 观测不影响流。 */ } };
  // 这两个原生入口仅返回固定的配置校验文案，不包含 URL、令牌或正文。
  async function prepare(input) {
    try { return JSON.parse(await native.cprPrepare(JSON.stringify(input))); }
    catch (error) { throw Object.assign(error, { safeCprMessage: error.message, statusCode: 400 }); }
  }

  function createHandler(protocol, options) {
    const hooks = createRequestHooks(options);
    const credentials = options.hopCredentials || createHopCredentialStore({ paths: options.paths, cprHome: options.cprHome });
    const exchanges = new Set();
    let closed = false;
    async function handle(req, res) {
      if (closed) return reply(res, 503, { error: 'Rust CPR 已关闭' });
      let gone = !!res.destroyed, exchange, context, terminal = false, firstByte = false;
      const started = Date.now();
      const activity = (phase, extra = {}) => {
        if (context?.sessionId) safeCall(options.onActivity, { sessionId: context.sessionId, role: context.role,
          providerId: context.providerId, providerName: context.providerName, phase, at: Date.now(), ...extra });
      };
      function settle(status, errorCode, usage = null, statusCode) {
        if (terminal || !context) return;
        terminal = true;
        if (context.sessionId) {
          const event = { ...context, eventId: randomUUID(), usage, status, statusCode, errorCode,
            latencyMs: Date.now() - started, coverage: usage ? 'observed' : 'unobservable', source: 'exact' };
          safeCall(options.onUsageEvent, event);
          if (usage) safeCall(options.onUsage || options.usageSink, event);
        }
        activity('end', { status });
      }
      const disconnect = () => {
        if (res.writableEnded || terminal) return;
        gone = true; settle('error', 'CLIENT_DISCONNECTED'); exchange?.abort();
      };
      res.once('close', disconnect);
      res.on('error', () => {});
      res.on('error', disconnect);
      try {
        const body = await readBody(req);
        if (gone) return;
        let route;
        try { route = JSON.parse(await native.cprRoute(JSON.stringify({ protocol, url: req.url, body }))); }
        catch (error) { throw Object.assign(error, { safeCprMessage: error.message, statusCode: 400 }); }
        if (protocol === 'claude' && req.method === 'HEAD' && route.apiPath === '/') return reply(res, 200, {});
        const auth = authorizeManagedRequest(req, { cli: protocol, providerId: route.providerId, sessionId: route.sessionId,
          roleKind: route.role, agentRole: route.agentRole, routeName: route.routeName }, credentials, { requireManaged: options.requireHopCredential });
        if (!auth.ok) return reply(res, 401, { error: '路由能力凭据无效', reason: auth.reason });
        let provider = options.getProvider(protocol, route.providerId);
        if (!provider && protocol === 'claude' && route.role === 'sub' && route.providerId !== route.mainProviderId) {
          provider = options.getProvider(protocol, route.mainProviderId);
          if (provider) {
            safeCall(options.onRoutingEvent, { type: 'provider-routing-fallback', status: 'default-fallback', reason: 'unknown-sub-provider',
              cli: 'claude', sessionId: route.sessionId, providerId: route.providerId, fallbackProviderId: route.mainProviderId });
            route.providerId = route.mainProviderId;
          }
        }
        const input = { route, provider, body, method: req.method, headers: req.headers,
          officialViaProxy: env.CLAUDE_OFFICIAL_VIA_PROXY === '1', officialProviderId: options.officialProviderId,
          officialBaseUrl: options.officialBaseUrl, oauthBeta: options.oauthBeta, codexProxyPath: options.codexProxyPath,
          headersTimeoutMs: options.headersTimeoutMs };
        let prepared = await prepare(input), credentialAccountId;
        if (prepared.credentialRequest) {
          const accountId = prepared.credentialRequest.accountId;
          credentialAccountId = accountId;
          const keychainService = options.keychainService || 'Claude Code-credentials';
          const arg = accountId ? { provider, providerId: route.providerId, accountId, keychainService } : keychainService;
          const credential = await (options.readOfficialCredential || router.readOfficialOAuthToken)(arg);
          if (!credential?.token) return reply(res, 502, { error: `官方 OAuth 不可用：${credential?.reason || '无法读取凭据'}` });
          input.officialToken = credential.token;
          prepared = await prepare(input);
        }
        const plan = prepared.plan;
        context = { sessionId: route.sessionId, providerId: route.providerId, providerName: plan.providerName || route.providerId,
          role: route.role, roleKind: route.role, agentRole: route.agentRole || null, routeName: route.routeName,
          model: plan.route.model, isStream: plan.route.isStream,
          protocol: protocol === 'claude' ? 'anthropic-messages' : plan.mode === 'responses-compat' ? 'openai-responses-compat' : 'openai-responses' };
        activity('request');
        const stage = createRequestStage(hooks, { ...context, protocol: protocol === 'claude' ? 'anthropic-messages' : 'openai-responses', mode: plan.mode, body: plan.body });
        await stage.prepare();
        if (options.resolveUpstreamAgent) {
          const resolver = options.resolveUpstreamAgent;
          const args = { ...context, provider, url: plan.url, isOfficialOAuth: !!input.officialToken };
          if (typeof resolver.resolveProxyUrl === 'function') plan.proxyUrl = await resolver.resolveProxyUrl(args);
          else if (await resolver(args)) throw Object.assign(new Error('Rust CPR 需要出口地址接口，无法使用 Node 专属 Agent'), { code: 'RUST_CPR_EGRESS_UNSUPPORTED' });
        }
        // 复用宿主统一网络策略（含 macOS 系统代理和旁路规则），避免原生请求绕过它。
        plan.proxyUrl ||= await require('../network/outbound').policy.proxyForUrl(plan.url) || undefined;
        for (let attempt = 1; ; attempt++) {
          if (gone) return;
          // 修复后重新进入 Rust，统一重新计算模型和 Content-Length。
          input.body = stage.text;
          const updated = (await prepare(input)).plan;
          updated.proxyUrl = plan.proxyUrl;
          exchange = await native.cprCreateExchange(JSON.stringify(updated));
          exchanges.add(exchange);
          if (gone || closed) { exchange.abort(); return; }
          const head = JSON.parse(await exchange.open());
          context.isStream = head.isStream;
          if (head.status < 200 || head.status >= 300) {
            // 宿主 OAuth 暂存器必须在读取错误正文前收到响应头，才有机会超时取消。
            const heldAuth = !!(options.recoverOfficialCredential && input.officialToken && credentialAccountId && [401, 403].includes(head.status));
            if (heldAuth && !gone) res.writeHead(head.status, head.headers);
            const errorBody = await exchange.errorBody();
            if (!errorBody.complete) {
              if (!heldAuth && !gone) res.writeHead(head.status, head.headers);
              if (!gone && !res.write(errorBody.data)) await waitWritable(res);
              while (!gone) {
                const chunk = await exchange.read();
                if (chunk.data.length && !res.write(chunk.data)) await waitWritable(res);
                if (JSON.parse(chunk.meta).done) break;
              }
              settle('error', 'UPSTREAM_HTTP_ERROR', null, head.status);
              if (!gone) res.end();
              return;
            }
            const detail = errorBody.data.toString('utf8');
            await exchange.close(); exchanges.delete(exchange);
            if (!heldAuth && !gone && await stage.repair({ status: head.status, message: detail, attempt, errorCode: 'UPSTREAM_HTTP_ERROR' })) continue;
            if (!heldAuth && !gone) res.writeHead(head.status, head.headers);
            settle('error', 'UPSTREAM_HTTP_ERROR', null, head.status);
            if (!gone) res.end(errorBody.data);
            return;
          }
          if (gone) return;
          if (head.rateLimit) safeCall(options.onRateLimit, { ...context, rateLimitInfo: head.rateLimit });
          res.writeHead(head.status, head.headers);
          res.flushHeaders?.();
          while (!gone) {
            const chunk = await exchange.read();
            const meta = JSON.parse(chunk.meta);
            for (const event of meta.events) safeCall(options.onDelta, event, context);
            if (chunk.data.length) {
              if (!firstByte) { firstByte = true; activity('first_byte'); }
              if (!res.write(chunk.data)) await waitWritable(res);
            }
            if (meta.done) {
              settle(meta.failed ? 'error' : 'success', meta.failed ? 'UPSTREAM_RESPONSE_FAILED' : undefined, meta.usage, meta.statusCode);
              if (!gone) res.end();
              return;
            }
          }
        }
      } catch (error) {
        // 宿主授权必须保留原异常，让 admission 转成 409；不得掩盖成上游错误。
        if (error?.name === 'ProviderProxyAdmissionError' || error?.code === 'PROVIDER_PROXY_ADMISSION_REJECTED') throw error;
        const code = ['CLIENT_DISCONNECTED', 'UPSTREAM_HEADERS_TIMEOUT', 'UPSTREAM_CONNECT_FAILED', 'UPSTREAM_STREAM_FAILED'].includes(error.message)
          ? error.message : error.code === 'RUST_CPR_EGRESS_UNSUPPORTED' ? error.code : 'RUST_CPR_REQUEST_FAILED';
        settle('error', code);
        if (gone || res.destroyed) return;
        if (res.headersSent) res.destroy();
        else reply(res, error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502,
          { error: { type: code, message: error.safeCprMessage || (code === 'RUST_CPR_REQUEST_FAILED' ? 'Rust CPR 请求失败，请检查供应商配置或切回 Node 版本' : 'Rust CPR 上游请求失败') } });
      } finally {
        if (exchange) { await exchange.close(); exchanges.delete(exchange); }
        res.removeListener('close', disconnect); res.removeListener('error', disconnect);
      }
    }
    return { handle, async close() { closed = true; for (const item of exchanges) item.abort(); await Promise.allSettled([...exchanges].map(item => item.close())); exchanges.clear(); } };
  }
  return Object.freeze({ ...router,
    CAPABILITIES: Object.freeze({ ...router.CAPABILITIES, rustProtocolProxy: '1.0.0' }),
    mountClaudeProxy(app, options = {}) {
      const handler = createHandler('claude', options);
      const prefix = '/' + String(options.claudeProxyPath || options.mountPath || '/claude-proxy').replace(/^\/+|\/+$/g, '');
      app.use(prefix, handler.handle);
      return Object.freeze({ close: handler.close });
    },
    mountCodexProxy(app, options = {}) {
      const handler = createHandler('codex', options);
      const prefix = '/' + String(options.codexProxyPath || options.mountPath || '/codex-proxy').replace(/^\/+|\/+$/g, '');
      const invoke = (req, res) => handler.handle(new Proxy(req, { get(target, key) {
        if (key === 'url') return `/${encodeURIComponent(req.params.providerId)}/${req.params.sessionId ? `${encodeURIComponent(req.params.sessionId)}/${encodeURIComponent(req.params.role)}/` : ''}responses`;
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } }), res);
      app.post(`${prefix}/:providerId/:sessionId/:role/responses`, invoke);
      app.post(`${prefix}/:providerId/responses`, invoke);
      return Object.freeze({ close: handler.close });
    },
  });
}
function reply(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return JSON.stringify(req.body);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 50 * 1024 * 1024) throw Object.assign(new Error('请求正文超过限制'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function waitWritable(res) {
  return new Promise(resolve => {
    function done() { res.removeListener('drain', done); res.removeListener('close', done); res.removeListener('error', done); resolve(); }
    res.once('drain', done); res.once('close', done); res.once('error', done);
    if (res.destroyed || res.writableEnded) done();
  });
}
module.exports = { resolveCprBackend, createRustCprRouter };
