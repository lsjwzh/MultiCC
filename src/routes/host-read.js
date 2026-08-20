'use strict';

const crypto = require('node:crypto');

const EMPTY_HEALTH = Object.freeze({
  successCount: 0,
  failCount: 0,
  lastSuccessTime: 0,
  lastFailTime: 0,
  lastFailReason: '',
  consecutiveFails: 0,
});
const SAFE_PUSH_TYPES = Object.freeze(new Set(['succeeded', 'completed', 'waiting', 'error']));

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeLabel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_PUSH_TYPES.has(text) ? text : (text ? 'other' : '');
}

function classifyFailureReason(value) {
  const reason = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!reason) return '';
  const http = reason.match(/(?:http|status(?:\s+code)?)\s*[:=]?\s*([1-5]\d{2})/i);
  if (http) return `http_${http[1][0]}xx`;
  if (/timed?\s*out|etimedout|timeout|aborted/.test(reason)) return 'timeout';
  if (/enotfound|eai_again|dns|name resolution/.test(reason)) return 'dns_error';
  if (/certificate|self.signed|tls|ssl/.test(reason)) return 'tls_error';
  if (/unauthori[sz]ed|forbidden|credential|token|auth/.test(reason)) return 'authentication_error';
  if (/econnrefused|connection refused/.test(reason)) return 'connection_refused';
  if (/econnreset|socket|network|fetch failed|connection closed/.test(reason)) return 'network_error';
  return 'delivery_error';
}

function healthDto(raw = EMPTY_HEALTH) {
  const source = raw && typeof raw === 'object' ? raw : EMPTY_HEALTH;
  return {
    successCount: finiteNonNegative(source.successCount),
    failCount: finiteNonNegative(source.failCount),
    lastSuccessTime: finiteNonNegative(source.lastSuccessTime),
    lastFailTime: finiteNonNegative(source.lastFailTime),
    lastFailReason: classifyFailureReason(source.lastFailReason),
    consecutiveFails: finiteNonNegative(source.consecutiveFails),
  };
}

function globalHealthDto(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    totalSent: finiteNonNegative(source.totalSent),
    totalSuccess: finiteNonNegative(source.totalSuccess),
    totalFail: finiteNonNegative(source.totalFail),
    lastPushTime: finiteNonNegative(source.lastPushTime),
    lastPushType: safeLabel(source.lastPushType),
  };
}

function channelHealthDto(configured, raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    configured: !!configured,
    lastSendTime: finiteNonNegative(source.lastSendTime),
    lastSuccess: source.lastSuccess === true,
    lastError: classifyFailureReason(source.lastError),
  };
}

function fingerprintEndpoint(endpoint) {
  return `sha256:${crypto.createHash('sha256').update(String(endpoint || '')).digest('hex').slice(0, 16)}`;
}

// Notification destinations often embed a device key or webhook token in the
// path/query/userinfo. Only the origin is safe to display. Invalid/non-HTTP
// values still get an opaque configured marker so their raw bytes never cross
// the read boundary.
function summarizeSecretUrl(value) {
  const configured = typeof value === 'string' && value.length > 0;
  if (!configured) return { configured: false, origin: '', masked: '' };
  let origin = '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
  } catch (_) { /* opaque configured value */ }
  return {
    configured: true,
    origin,
    masked: origin ? `${origin}/••••` : '••••',
  };
}

function matchesCurrentNotifyPlaceholder(value, currentValue) {
  return typeof value === 'string'
    && !!currentValue
    && value === summarizeSecretUrl(currentValue).masked;
}

// Shared by the POST composition root: an unchanged read-side placeholder is
// a no-op, while an explicit empty string still clears the channel.
function resolveNotifySettingsUpdates(body = {}, current = {}) {
  const updates = {};
  for (const [bodyKey, configKey] of [['barkUrl', 'BARK_URL'], ['webhookUrl', 'WEBHOOK_URL']]) {
    if (!Object.prototype.hasOwnProperty.call(body, bodyKey)) continue;
    const value = body[bodyKey];
    if (typeof value !== 'string') continue;
    if (matchesCurrentNotifyPlaceholder(value, current[configKey])) continue;
    updates[configKey] = value;
  }
  return updates;
}

function createVapidKeyHandler(deps) {
  return function vapidKeyHandler(req, res) {
    res.json({ publicKey: deps.getVapidPublicKey() });
  };
}

function createPushHealthHandler(deps) {
  return function pushHealthHandler(req, res) {
    const subs = [];
    for (const [endpoint] of deps.push.subscriptions) {
      const health = deps.push.healthStats.get(endpoint) || EMPTY_HEALTH;
      subs.push({
        endpointFingerprint: fingerprintEndpoint(endpoint),
        ...healthDto(health),
      });
    }
    res.json({
      subscriptions: subs,
      subscriptionCount: deps.push.subscriptions.size,
      global: globalHealthDto(deps.push.globalStats),
      bark: channelHealthDto(!!deps.push.cfg.BARK_URL, deps.push.barkHealth),
      webhook: channelHealthDto(!!deps.push.cfg.WEBHOOK_URL, deps.push.webhookHealth),
    });
  };
}

function createNotifySettingsHandler(deps) {
  return function notifySettingsHandler(req, res) {
    const bark = summarizeSecretUrl(deps.push.cfg.BARK_URL);
    const webhook = summarizeSecretUrl(deps.push.cfg.WEBHOOK_URL);
    res.json({
      barkUrl: bark.masked,
      barkOrigin: bark.origin,
      hasBark: bark.configured,
      webhookUrl: webhook.masked,
      webhookOrigin: webhook.origin,
      hasWebhook: webhook.configured,
    });
  };
}

function createTunnelSettingsHandler(deps) {
  return function tunnelSettingsHandler(req, res) {
    res.json(deps.tunnel.getStatus());
  };
}

function createTunnelFunnelHandler(deps) {
  return async function tunnelFunnelHandler(req, res, next) {
    try {
      res.json({ status: await deps.tunnel.funnelStatus() });
    } catch (error) {
      return next(error);
    }
  };
}

function createTunnelIpv6Handler(deps) {
  return async function tunnelIpv6Handler(req, res, next) {
    try {
      res.json(await deps.tunnel.ipv6Status());
    } catch (error) {
      return next(error);
    }
  };
}

function createAccessTokenSettingsHandler(deps) {
  return function accessTokenSettingsHandler(req, res) {
    const token = deps.getAccessToken() || '';
    res.json({
      hasToken: !!token,
      masked: token ? (token.length > 4 ? `****${token.slice(-4)}` : '****') : '',
      canEdit: deps.isLocalRequest(req),
    });
  };
}

// The relay token is read live from process.env by auth.js / providers.js,
// so no dedicated getter is wired from server.js (keeps its line budget).
function proxyTokenOf(deps) {
  return typeof deps.getProxyToken === 'function'
    ? deps.getProxyToken()
    : (process.env.MULTICC_PROXY_TOKEN || '');
}

function createProxyTokenSettingsHandler(deps) {
  return function proxyTokenSettingsHandler(req, res) {
    const token = proxyTokenOf(deps) || '';
    res.json({
      hasToken: !!token,
      masked: token ? (token.length > 4 ? `****${token.slice(-4)}` : '****') : '',
      canEdit: deps.isLocalRequest(req),
    });
  };
}

function createBooleanSettingHandler(getEnabled) {
  return function booleanSettingHandler(req, res) {
    res.json({ enabled: getEnabled() });
  };
}

function createPowerSettingsHandler(deps) {
  return async function powerSettingsHandler(req, res, next) {
    try {
      if (!deps.macosPower.isAvailable()) {
        return res.json({ available: false, enabled: false });
      }
      return res.json(await deps.macosPower.getLidSleepPrevention());
    } catch (error) {
      return next(error);
    }
  };
}

function assertHostReadDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('host read route dependencies are required');
  for (const name of [
    'getVapidPublicKey',
    'getAccessToken',
    'isLocalRequest',
    'getProxyEnabled',
    'getOfficialOAuthEnabled',
  ]) {
    if (typeof deps[name] !== 'function') throw new TypeError(`host read route dependency missing: ${name}`);
  }
  if (!deps.push || !deps.tunnel || !deps.macosPower) {
    throw new TypeError('host read route service dependencies are required');
  }
  return deps;
}

function mountHostReadRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app.get is required');
  const deps = assertHostReadDeps(rawDeps);
  app.get('/api/push/vapid-key', createVapidKeyHandler(deps));
  app.get('/api/push/health', createPushHealthHandler(deps));
  app.get('/api/settings/notify', createNotifySettingsHandler(deps));
  app.get('/api/settings/tunnel', createTunnelSettingsHandler(deps));
  app.get('/api/tunnel/funnel', createTunnelFunnelHandler(deps));
  app.get('/api/tunnel/ipv6', createTunnelIpv6Handler(deps));
  app.get('/api/settings/access-token', createAccessTokenSettingsHandler(deps));
  app.get('/api/settings/proxy-token', createProxyTokenSettingsHandler(deps));
  app.get('/api/settings/proxy', createBooleanSettingHandler(deps.getProxyEnabled));
  app.get('/api/settings/official-oauth', createBooleanSettingHandler(deps.getOfficialOAuthEnabled));
  app.get('/api/settings/power', createPowerSettingsHandler(deps));
}

module.exports = {
  EMPTY_HEALTH,
  classifyFailureReason,
  healthDto,
  globalHealthDto,
  channelHealthDto,
  fingerprintEndpoint,
  summarizeSecretUrl,
  matchesCurrentNotifyPlaceholder,
  resolveNotifySettingsUpdates,
  createVapidKeyHandler,
  createPushHealthHandler,
  createNotifySettingsHandler,
  createTunnelSettingsHandler,
  createTunnelFunnelHandler,
  createTunnelIpv6Handler,
  createAccessTokenSettingsHandler,
  createProxyTokenSettingsHandler,
  createBooleanSettingHandler,
  createPowerSettingsHandler,
  mountHostReadRoutes,
};
