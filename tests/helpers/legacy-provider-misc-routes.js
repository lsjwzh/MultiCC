// Frozen from src/routes/providers.js (speed test), src/providers/speedtest-request.js,
// src/routes/auto-provider-routing-test.js and server.js (`GET /api/v1/providers`)
// before their Rust front-door migration. Only the require paths changed: the
// differential suite compares the retired handlers against native/gateway.
'use strict';

const { sanitizePublicText } = require('../../src/http/public-safety');
const SPEEDTEST_DEADLINE_MS = 15000;
const SPEEDTEST_MAX_RESPONSE_BYTES = 64 * 1024;
const publicText = (value, fallback) => sanitizePublicText(typeof value === 'string' ? value : '', fallback);
const publicError = (error, fallback) => publicText(error && error.message, fallback);

function runSpeedtestRequest(options) {
  const {
    client,
    requestOptions,
    body,
    model,
    res,
    elapsed,
    setTimeoutFn,
    clearTimeoutFn,
  } = options;
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    let deadlineTimer = null;
    let responseBytes = 0;

    const finish = (payload) => {
      if (settled) return false;
      settled = true;
      if (deadlineTimer) clearTimeoutFn(deadlineTimer);
      res.json(payload);
      resolve();
      return true;
    };
    const destroyAfter = (payload) => {
      if (!finish(payload)) return;
      if (request && typeof request.destroy === 'function') request.destroy();
    };
    const timeout = () => destroyAfter({ ok: false, ms: elapsed(), error: 'timeout' });

    try {
      request = client.request(requestOptions, (response) => {
        let data = '';
        response.on('data', (chunk) => {
          if (settled) return;
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > SPEEDTEST_MAX_RESPONSE_BYTES) {
            destroyAfter({
              ok: false,
              ms: elapsed(),
              status: response.statusCode,
              model,
              error: 'response too large',
            });
            return;
          }
          data += chunk.toString();
        });
        response.on('error', (error) => {
          destroyAfter({
            ok: false,
            ms: elapsed(),
            error: publicError(error, 'provider speedtest failed'),
          });
        });
        response.on('end', () => {
          if (settled) return;
          const ms = elapsed();
          // CPR's proxy can return HTTP 200 and report an upstream failure in
          // its SSE envelope. Treat that as a failed probe; status-only checks
          // would paint an OAuth/account failure as a healthy provider.
          const failedEnvelope = /response\.failed|"error"\s*:\s*\{|"status"\s*:\s*"failed"/.test(data);
          if (failedEnvelope) {
            let message = 'provider speedtest failed';
            try {
              const parsed = JSON.parse(data);
              message = parsed.error?.message || parsed.response?.error?.message || message;
            } catch (_) {
              const match = /message["']?\s*:\s*["']([^"']+)/i.exec(data);
              if (match) message = match[1];
            }
            finish({ ok: false, ms, model, error: publicText(message, 'provider speedtest failed') });
            return;
          }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            finish({ ok: true, ms, status: response.statusCode, model });
            return;
          }
          let message = `HTTP ${response.statusCode}`;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) message = parsed.error.message || JSON.stringify(parsed.error);
          } catch (_) {}
          finish({
            ok: false,
            ms,
            status: response.statusCode,
            model,
            error: publicText(message, `HTTP ${response.statusCode}`),
          });
        });
      });
      request.on('error', (error) => {
        finish({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
      });
      request.setTimeout(SPEEDTEST_DEADLINE_MS, timeout);
      deadlineTimer = setTimeoutFn(timeout, SPEEDTEST_DEADLINE_MS);
      if (deadlineTimer && typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
      request.write(body);
      request.end();
    } catch (error) {
      finish({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
    }
  });
}

// ── Auto Provider · 难度路由「测试一下」 ─────────────────────────────────────
const { createJevClient } = require('../../src/providers/jev-client');
const { jevTarget, validateRoutingTarget } = require('../../src/providers/auto-provider-config');
const { safeCode } = require('../../src/http/public-safety');

const MAX_TEXT_LENGTH = 2000;
const TEST_TIMEOUT_MS = 8000;
const SAMPLE_TEXT = '把 README 里的一个错别字改掉';
const INVALID_TARGET_CODE = 'invalid_routing_target';

function vaultKeyResolver(vaultOf) {
  return name => {
    const result = vaultOf().reveal(name, { source: 'routing_test' });
    return result && result.entry ? result.entry.value : null;
  };
}

function createRoutingTest(options = {}) {
  const vaultOf = () => options.vault || require('../../src/secrets-vault');
  const jev = options.jev || createJevClient({
    fetchImpl: options.fetchImpl,
    resolveApiKey: vaultKeyResolver(vaultOf),
    logger: options.logger,
  });

  async function run(body = {}) {
    const target = validateRoutingTarget(body);
    if (target.ok === false) {
      return {
        status: 400,
        body: {
          ok: false,
          code: INVALID_TARGET_CODE,
          detail: sanitizePublicText(String(target.error || ''), '-'),
        },
      };
    }
    const text = String(body.text || '').trim().slice(0, MAX_TEXT_LENGTH) || SAMPLE_TEXT;
    const call = jevTarget(target.value);
    const verdict = await jev.classify({
      text,
      tiers: ['t1', 't2'],
      apiKeyName: call.apiKeyName,
      endpoint: call.endpoint,
      model: call.model,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const latencyMs = Math.round(Number(verdict && verdict.latencyMs) || 0);
    const detail = verdict && verdict.detail ? sanitizePublicText(String(verdict.detail), '-') : '-';
    if (verdict && verdict.ok) {
      return { status: 200, body: { ok: true, tier: verdict.tier === 't1' ? 't1' : 't2', latencyMs } };
    }
    return {
      status: 200,
      body: {
        ok: false,
        code: safeCode(String((verdict && verdict.code) || ''), 'jev_failed'),
        ...(verdict && verdict.status ? { status: Number(verdict.status) || 0 } : {}),
        ...(detail !== '-' ? { detail: detail.slice(0, 240) } : {}),
        latencyMs,
      },
    };
  }

  function mount(app) {
    app.post('/api/auto-provider/routing/test', async (req, res) => {
      try {
        const result = await run(req.body || {});
        res.status(result.status).json(result.body);
      } catch (_) {
        res.status(500).json({ ok: false, code: 'routing_test_failed' });
      }
    });
  }

  return Object.freeze({ run, mount });
}

// ── Speed test handler body, frozen from providers.js ───────────────────────
function wireModelId(value) {
  const model = String(value || '').trim();
  return model.replace(/\[[^\]]*\]$/, '').trim();
}

function preferredSpeedtestModel(values) {
  const models = (Array.isArray(values) ? values : [])
    .map(wireModelId)
    .filter(Boolean);
  if (!models.length) return '';
  const unique = [...new Set(models)];
  return unique.find(model => /haiku/i.test(model)) || unique[0];
}

function claudeSpeedtestModel(env, summary) {
  const explicit = [
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    summary && summary.model,
  ].map(value => (typeof value === 'string' ? value.trim() : '')).find(Boolean);
  if (explicit) return explicit;
  const fromCatalog = preferredSpeedtestModel(summary && summary.modelOptions);
  if (fromCatalog) return fromCatalog;
  const { relayRouteFromBaseUrl } = require('../../src/providers/relay-share-store');
  if (relayRouteFromBaseUrl(env.ANTHROPIC_BASE_URL)) {
    const { CLAUDE_MODELS_FALLBACK } = require('../../src/claude-models');
    return preferredSpeedtestModel(CLAUDE_MODELS_FALLBACK.map(entry => entry.model));
  }
  return '';
}

function mountSpeedtestRoute(app, deps) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const { isOfficialCodexOAuthProvider } = require('../../src/codex/official-relay');
  const { officialAccountIdFromProvider } = require('../../src/official-accounts');

  app.post('/api/providers/:appType/:id/speedtest', async (req, res) => {
    const startedAt = now();
    const elapsed = () => now() - startedAt;
    try {
      const provider = deps.providers.getProvider(req.params.appType, req.params.id);
      if (!provider) return res.status(404).json({ ok: false, ms: elapsed(), error: 'provider not found' });
      const config = typeof provider.settingsConfig === 'string'
        ? JSON.parse(provider.settingsConfig)
        : (provider.settingsConfig || {});
      const env = (config && config.env) || {};

      const officialCodex = isOfficialCodexOAuthProvider(provider);
      const runCodexHostSpeedtest = ({ model }) => runSpeedtestRequest({
        client: deps.http,
        requestOptions: {
          hostname: '127.0.0.1', port: deps.getPort(),
          path: `/codex-proxy/${encodeURIComponent(req.params.id)}/responses`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        },
        body: JSON.stringify({
          model, instructions: 'Reply with only OK.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          stream: true, store: false,
        }),
        model, res, elapsed, setTimeoutFn, clearTimeoutFn,
        streamProtocol: 'responses',
      });

      if (officialCodex) {
        const summary = deps.providerRouterRuntime.getProviderSummary('codex', req.params.id) || {};
        const model = summary.model || (summary.modelOptions || [])[0];
        if (!model) return res.json({ ok: false, ms: elapsed(), error: '官方模型目录为空，请先登录 Codex 并刷新模型列表' });
        await runCodexHostSpeedtest({ model });
        return;
      }

      if (req.params.appType === 'codex') {
        const target = deps.providers.resolveCodexDirectHttp(req.params.id);
        if (!target.canDirect) {
          return res.json({
            ok: false,
            ms: elapsed(),
            error: publicText(target.reason, 'OAuth 订阅型 provider 不支持测速'),
          });
        }
        const model = (target.modelOptions && target.modelOptions[0])
          || target.model
          || 'gpt-4o-mini';
        await runCodexHostSpeedtest({ model });
        return;
      }

      const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
      const isOfficial = req.params.id === 'claude-official' || !!officialAccountIdFromProvider(provider);
      const canDirect = (env.ANTHROPIC_BASE_URL && hasKey) || isOfficial;
      if (!canDirect) {
        return res.json({
          ok: false,
          ms: elapsed(),
          error: '缺少 API Key 或 Base URL',
        });
      }

      const speedtestSummary = deps.providerRouterRuntime.getProviderSummary(
        'claude',
        req.params.id,
      ) || {};
      const model = claudeSpeedtestModel(env, speedtestSummary)
        || deps.providers.WIRE_DEFAULT_MODEL;
      const isOfficialOAuth = isOfficial && !hasKey;
      const body = JSON.stringify({
        model,
        max_tokens: 1,
        ...(isOfficialOAuth
          ? { system: [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }] }
          : {}),
        messages: [{ role: 'user', content: 'hi' }],
      });

      await runSpeedtestRequest({
        client: deps.http,
        requestOptions: {
          hostname: '127.0.0.1',
          port: deps.getPort(),
          path: `/claude-proxy/${encodeURIComponent(req.params.id)}/speedtest/v1/messages?beta=true`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'multicc-speedtest',
            'anthropic-version': '2023-06-01',
            'x-api-key': 'multicc-speedtest',
            ...(isOfficialOAuth ? { 'x-app': 'cli' } : {}),
          },
        },
        body,
        model,
        res,
        elapsed,
        setTimeoutFn,
        clearTimeoutFn,
      });
    } catch (error) {
      res.json({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
    }
  });
}

// ── server.js `GET /api/v1/providers`, frozen ──────────────────────────────
function mountV1ProvidersRoute(app, deps) {
  const { toProviderDto, withApiMeta, requestContext } = require('../../src/api-contract');
  app.get('/api/v1/providers', (req, res) => {
    const appType = String(req.query.appType || '').trim();
    const list = deps.providers
      .listProviders(appType === 'claude' || appType === 'codex' ? appType : undefined)
      .map(toProviderDto);
    res.json(withApiMeta({ providers: list, count: list.length }, requestContext(req, res)));
  });
}

function mountLegacyProviderMiscRoutes(app, deps) {
  mountSpeedtestRoute(app, deps);
  mountV1ProvidersRoute(app, deps);
  (deps.autoProviderRoutingTest || createRoutingTest(deps.routingTest || {})).mount(app);
}

module.exports = {
  INVALID_TARGET_CODE,
  MAX_TEXT_LENGTH,
  SAMPLE_TEXT,
  createRoutingTest,
  mountLegacyProviderMiscRoutes,
  mountSpeedtestRoute,
  mountV1ProvidersRoute,
  runSpeedtestRequest,
};
