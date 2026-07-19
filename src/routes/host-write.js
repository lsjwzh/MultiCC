'use strict';

const { resolveNotifySettingsUpdates } = require('./host-read');

const LOCAL_ONLY_MESSAGE = '仅可在本机修改';
const MAX_SECRET_TEXT_LENGTH = 4096;
const MAX_NOTIFY_URL_LENGTH = 2048;
const TUNNEL_LIMITS = Object.freeze({
  intervalSec: Object.freeze({ min: 10, max: 2147483 }),
  failThreshold: Object.freeze({ min: 1, max: 100 }),
  restartCooldownSec: Object.freeze({ min: 0, max: 86400 }),
  maxRestartsPerHour: Object.freeze({ min: 1, max: 100 }),
  funnelPort: Object.freeze({ min: 1, max: 65535 }),
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function snapshotEnv(deps, keys) {
  const current = deps.readEnvFile();
  const out = {};
  for (const key of keys) out[key] = hasOwn(current, key) ? current[key] : null;
  return out;
}

// The .env writer is atomic. Persist before changing live process state so a
// disk failure can never produce a successful response with a runtime-only
// value. The compensation path is only needed when a live setter unexpectedly
// throws after the durable write has committed.
function reportFailure(deps, stage, category) {
  try { deps.reportFailure(stage, category); } catch (_) { /* reporting is best-effort */ }
}

function persistThenApply(deps, updates, apply, rollbackApply, stage = 'env') {
  const before = snapshotEnv(deps, Object.keys(updates));
  deps.writeEnvFile(updates);
  try {
    apply();
  } catch (error) {
    const rollbackFailures = [];
    try { deps.writeEnvFile(before); } catch (failure) {
      rollbackFailures.push(failure);
      reportFailure(deps, `${stage}_persistence_rollback`, 'compensation_failed');
    }
    try { rollbackApply(); } catch (failure) {
      rollbackFailures.push(failure);
      reportFailure(deps, `${stage}_runtime_rollback`, 'compensation_failed');
    }
    if (rollbackFailures.length > 0) {
      // Keep raw secondary failures off the public/logging error path. Their
      // safe stage classification was emitted above for operator visibility.
      error.rollbackError = new Error(`${stage} compensation failed`);
    }
    throw error;
  }
}

function requireLocal(deps, req, res, message = LOCAL_ONLY_MESSAGE) {
  if (deps.isLocalRequest(req)) return true;
  res.status(403).json({ error: message });
  return false;
}

function normalizeTunnelUpdate(body = {}) {
  if (!body || typeof body !== 'object') body = {};
  const update = {};
  if (body.phddns && typeof body.phddns === 'object') {
    update.phddns = {};
    if (typeof body.phddns.enabled === 'boolean') update.phddns.enabled = body.phddns.enabled;
    if (typeof body.phddns.url === 'string') update.phddns.url = body.phddns.url.trim();
  }
  if (body.tailscale && typeof body.tailscale === 'object') {
    update.tailscale = {};
    if (typeof body.tailscale.enabled === 'boolean') update.tailscale.enabled = body.tailscale.enabled;
    if (typeof body.tailscale.url === 'string') update.tailscale.url = body.tailscale.url.trim();
    // Funnel is execution state. Only POST /api/tunnel/funnel may change it;
    // the ordinary config route deliberately ignores checkbox/port echoes.
  }
  for (const key of ['intervalSec', 'failThreshold', 'restartCooldownSec', 'maxRestartsPerHour']) {
    if (!hasOwn(body, key)) continue;
    const value = body[key];
    const limit = TUNNEL_LIMITS[key];
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      const error = new Error(`${key} must be an integer between ${limit.min} and ${limit.max}`);
      error.code = 'INVALID_TUNNEL_SETTING';
      throw error;
    }
    update[key] = value;
  }
  return update;
}

function publicTunnelRequested(body = {}) {
  return !!(body.phddns && body.phddns.enabled)
    || !!(body.tailscale && body.tailscale.enabled);
}

function publicTunnelEnabled(status = {}) {
  const config = status && status.config || {};
  return !!(config.phddns && config.phddns.enabled)
    || !!(config.tailscale && (config.tailscale.enabled || config.tailscale.funnel));
}

function validateSafeText(value, { maxLength = MAX_SECRET_TEXT_LENGTH, allowEmpty = true } = {}) {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && !value) return false;
  return value.length <= maxLength && !/[\r\n\0]/.test(value);
}

function validateNotifyUrl(value) {
  if (!validateSafeText(value, { maxLength: MAX_NOTIFY_URL_LENGTH })) return false;
  if (value === '') return true;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch (_) {
    return false;
  }
}

function validateFunnelPort(value) {
  const limit = TUNNEL_LIMITS.funnelPort;
  return Number.isInteger(value) && value >= limit.min && value <= limit.max;
}

function createNotifySettingsHandler(deps) {
  return function notifySettingsHandler(req, res, next) {
    try {
      const current = { ...deps.push.cfg };
      const updates = resolveNotifySettingsUpdates(req.body || {}, current);
      if (Object.values(updates).some(value => !validateNotifyUrl(value))) {
        return res.status(400).json({ error: `notification URL must be http(s) and at most ${MAX_NOTIFY_URL_LENGTH} characters` });
      }
      if (Object.keys(updates).length > 0) {
        persistThenApply(
          deps,
          updates,
          () => deps.push.applyEnvUpdates(updates),
          () => deps.push.applyEnvUpdates(current),
          'notify_settings',
        );
      }
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  };
}

function createTunnelSettingsHandler(deps) {
  return function tunnelSettingsHandler(req, res, next) {
    try {
      const body = req.body || {};
      if (publicTunnelRequested(body) && !deps.getAccessToken()) {
        return res.status(400).json({ error: '开启外网访问前必须先设置 ACCESS_TOKEN' });
      }
      let update;
      try { update = normalizeTunnelUpdate(body); }
      catch (error) {
        if (error && error.code === 'INVALID_TUNNEL_SETTING') {
          return res.status(400).json({ error: error.message });
        }
        throw error;
      }
      const config = deps.tunnel.applyConfig(update);
      return res.json({ ok: true, config });
    } catch (error) {
      return next(error);
    }
  };
}

function createTunnelRestartHandler(deps) {
  return async function tunnelRestartHandler(req, res, next) {
    try {
      const result = await deps.tunnel.restartNow(req.params.provider);
      if (result && result.ok) return res.json(result);
      const unknown = result && result.error === 'unknown provider';
      return res.status(400).json({
        ok: false,
        error: unknown ? 'unknown provider' : 'tunnel_restart_failed',
      });
    } catch (error) {
      return next(error);
    }
  };
}

function createTunnelFunnelHandler(deps) {
  return async function tunnelFunnelHandler(req, res, next) {
    try {
      const body = req.body || {};
      if (typeof body.on !== 'boolean') {
        return res.status(400).json({ ok: false, message: 'on must be a boolean' });
      }
      const on = body.on;
      if (on && !deps.getAccessToken()) {
        return res.status(400).json({ error: '开启公网 Funnel 前必须先设置 ACCESS_TOKEN' });
      }
      const port = hasOwn(body, 'port') ? Number(body.port) : 3000;
      if (!validateFunnelPort(port)) {
        return res.status(400).json({ ok: false, message: 'port must be an integer between 1 and 65535' });
      }
      const result = await deps.tunnel.setFunnel(on, port);
      if (!result || !result.ok) {
        // Preserve the historical { ok, message } validation DTO without
        // reflecting tailscale stderr or filesystem details to the client.
        return res.status(400).json({ ok: false, message: 'Funnel 操作失败' });
      }
      let status = '';
      try { status = await deps.tunnel.funnelStatus(); }
      catch (_) {
        // Mutation and durable config already committed. A diagnostic read must
        // not turn success into a misleading 500/retryable response.
        reportFailure(deps, 'funnel_status_probe', 'status_unavailable');
      }
      return res.json({ ...result, status });
    } catch (error) {
      return next(error);
    }
  };
}

function createAccessTokenHandler(deps) {
  return function accessTokenHandler(req, res, next) {
    if (!requireLocal(deps, req, res, '访问密码仅可在本机 (localhost) 打开本页时修改')) return undefined;
    const raw = req.body && req.body.token;
    if (typeof raw !== 'string' || raw.includes('****') || !validateSafeText(raw)) {
      return res.status(400).json({ error: '无有效改动' });
    }
    try {
      const token = raw.trim();
      if (!token && (deps.getAllowRemote() || publicTunnelEnabled(deps.tunnel.getStatus()))) {
        return res.status(400).json({ error: '当前已允许远程/公网访问，请先关闭外网入口再清空 ACCESS_TOKEN' });
      }
      const previous = deps.getAccessToken();
      persistThenApply(
        deps,
        { ACCESS_TOKEN: token },
        () => deps.setAccessToken(token),
        () => deps.setAccessToken(previous),
        'access_token',
      );
      deps.log(`[multicc/auth] ACCESS_TOKEN ${token ? 'updated' : 'cleared'} via localhost UI`);
      return res.json({ ok: true, hasToken: !!token });
    } catch (error) {
      return next(error);
    }
  };
}

function createBooleanSettingHandler(deps, setting) {
  return function booleanSettingHandler(req, res, next) {
    if (!requireLocal(deps, req, res)) return undefined;
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔' });
    try {
      const previous = setting.get();
      const value = enabled ? '1' : '0';
      persistThenApply(
        deps,
        { [setting.envKey]: value },
        () => setting.set(enabled),
        () => setting.set(previous),
        setting.envKey.toLowerCase(),
      );
      deps.log(setting.logMessage(enabled));
      return res.json({ ok: true, enabled });
    } catch (error) {
      return next(error);
    }
  };
}

function createPowerSettingsHandler(deps) {
  return async function powerSettingsHandler(req, res, next) {
    try {
      if (!deps.macosPower.isAvailable()) {
        return res.status(400).json({ error: 'This setting is only available on macOS' });
      }
      if (typeof (req.body && req.body.enabled) !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const status = await deps.macosPower.setLidSleepPrevention(req.body.enabled);
      return res.json({ ok: true, ...status });
    } catch (error) {
      return next(error);
    }
  };
}

function assertHostWriteDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('host write route dependencies are required');
  for (const name of [
    'readEnvFile',
    'writeEnvFile',
    'getAccessToken',
    'setAccessToken',
    'getAllowRemote',
    'isLocalRequest',
    'getProxyEnabled',
    'setProxyEnabled',
    'getOfficialOAuthEnabled',
    'setOfficialOAuthEnabled',
  ]) {
    if (typeof deps[name] !== 'function') throw new TypeError(`host write route dependency missing: ${name}`);
  }
  const requiredServiceMethods = {
    push: ['applyEnvUpdates'],
    tunnel: ['getStatus', 'applyConfig', 'restartNow', 'setFunnel', 'funnelStatus'],
    macosPower: ['isAvailable', 'setLidSleepPrevention'],
  };
  for (const [service, methods] of Object.entries(requiredServiceMethods)) {
    if (!deps[service] || typeof deps[service] !== 'object') {
      throw new TypeError(`host write route service missing: ${service}`);
    }
    for (const method of methods) {
      if (typeof deps[service][method] !== 'function') {
        throw new TypeError(`host write route service dependency missing: ${service}.${method}`);
      }
    }
  }
  if (!deps.push.cfg || typeof deps.push.cfg !== 'object') {
    throw new TypeError('host write route service dependency missing: push.cfg');
  }
  return {
    ...deps,
    log: typeof deps.log === 'function' ? deps.log : () => {},
    reportFailure: typeof deps.reportFailure === 'function' ? deps.reportFailure : () => {},
  };
}

function mountHostWriteRoutes(app, rawDeps) {
  if (!app || typeof app.post !== 'function') throw new TypeError('Express app.post is required');
  const deps = assertHostWriteDeps(rawDeps);
  app.post('/api/settings/notify', createNotifySettingsHandler(deps));
  app.post('/api/settings/tunnel', createTunnelSettingsHandler(deps));
  app.post('/api/tunnel/restart/:provider', createTunnelRestartHandler(deps));
  app.post('/api/tunnel/funnel', createTunnelFunnelHandler(deps));
  app.post('/api/settings/access-token', createAccessTokenHandler(deps));
  app.post('/api/settings/proxy', createBooleanSettingHandler(deps, {
    envKey: 'CLAUDE_PROXY_ENABLED',
    get: deps.getProxyEnabled,
    set: deps.setProxyEnabled,
    logMessage: enabled => `[multicc/proxy] claude proxy ${enabled ? 'enabled' : 'disabled'} via UI`,
  }));
  app.post('/api/settings/official-oauth', createBooleanSettingHandler(deps, {
    envKey: 'CLAUDE_OFFICIAL_VIA_PROXY',
    get: deps.getOfficialOAuthEnabled,
    set: deps.setOfficialOAuthEnabled,
    logMessage: enabled => `[multicc/proxy] official-via-proxy (OAuth replay) ${enabled ? 'enabled' : 'disabled'} via UI`,
  }));
  app.post('/api/settings/power', createPowerSettingsHandler(deps));
}

module.exports = {
  LOCAL_ONLY_MESSAGE,
  snapshotEnv,
  persistThenApply,
  normalizeTunnelUpdate,
  validateSafeText,
  validateNotifyUrl,
  validateFunnelPort,
  TUNNEL_LIMITS,
  publicTunnelRequested,
  publicTunnelEnabled,
  createNotifySettingsHandler,
  createTunnelSettingsHandler,
  createTunnelRestartHandler,
  createTunnelFunnelHandler,
  createAccessTokenHandler,
  createBooleanSettingHandler,
  createPowerSettingsHandler,
  mountHostWriteRoutes,
};
