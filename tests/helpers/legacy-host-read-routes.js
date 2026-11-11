'use strict';
// FROZEN COPY, DIFFERENTIAL ONLY — do not import from product code.
//
// This is the retired src/routes/host-read.js as it stood at HEAD (the file was
// deleted when its ten GET routes moved to native/gateway/src/app/host_read.rs).
// It exists only as the Node oracle of
// docs/rust-migration/differential/host-read.js and must never be required by a
// production path.
//
// Verbatim rule: `mountHostReadRoutes`, every handler factory and every DTO
// helper below are copied unchanged from `git show HEAD:src/routes/host-read.js`
// (only the export list grew `mount`, `readPowerSettings` and the battery
// helpers). The retired module imported two product helpers
// (`../host-power-services` and `../host-battery`); to keep this file dependent
// on node builtins alone those two are frozen local copies:
//
//   * createBatteryReader / parsePmset / readLinux come verbatim from
//     src/host-battery.js (itself builtins-only). The differential always
//     injects `deps.readBattery`, so /usr/bin/pmset is never executed.
//   * readPowerSettings comes verbatim from src/host-power-services.js. Its
//     three lazy constructors (createUnlockPassword / createUnlockProbe /
//     createPowerPreferences) are the only removed product imports; the two
//     accessors that used them are replaced by accessors that throw, because
//     the differential always injects `unlockPassword`, `unlockProbe` and
//     `powerPreferences` and they are therefore unreachable.
//
// The scripted deps object (built by the differential) owns everything that
// touches process state, the network or a real CLI.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

// ── frozen local copy of src/host-battery.js ────────────────────────────────

const CACHE_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;
const UNAVAILABLE = Object.freeze({ available: false });

// `pmset -g batt` prints e.g. "-InternalBattery-0 (id=1)\t25%; discharging; 1:26 remaining present: true".
// Desktops answer with no InternalBattery line at all, which is "no battery", not an error.
function parsePmset(text) {
  const source = String(text || '');
  const line = source.split('\n').find(row => /InternalBattery/.test(row));
  if (!line) return UNAVAILABLE;
  const percent = Number((line.match(/(\d{1,3})\s*%/) || [])[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return UNAVAILABLE;
  const state = (line.match(/%;\s*([^;]+);/) || [])[1] || '';
  const remaining = line.match(/(\d+):(\d{2}) remaining/);
  const pluggedIn = /AC Power/.test(source);
  return {
    available: true,
    percent,
    charging: /^(charging|finishing charge)$/i.test(state.trim()),
    pluggedIn,
    remainingMinutes: remaining ? Number(remaining[1]) * 60 + Number(remaining[2]) : null,
  };
}

async function readLinux(readFile) {
  for (const name of ['BAT0', 'BAT1']) {
    try {
      const base = `/sys/class/power_supply/${name}`;
      const percent = Number(String(await readFile(`${base}/capacity`, 'utf8')).trim());
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
      const status = String(await readFile(`${base}/status`, 'utf8').catch(() => '')).trim();
      return {
        available: true,
        percent,
        charging: /^charging$/i.test(status),
        pluggedIn: /^(charging|full)$/i.test(status),
        remainingMinutes: null,
      };
    } catch (_) { /* try the next battery node */ }
  }
  return UNAVAILABLE;
}

function createBatteryReader({
  platform = process.platform,
  run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
    (error, stdout) => (error ? reject(error) : resolve(stdout)))),
  readFile = fs.readFile,
  now = Date.now,
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function probe() {
    if (platform === 'darwin') return parsePmset(await run('/usr/bin/pmset', ['-g', 'batt']));
    if (platform === 'linux') return readLinux(readFile);
    return UNAVAILABLE;
  }

  return async function readBattery() {
    if (cached && now() - cachedAt < CACHE_MS) return cached;
    // Concurrent sidebars (Web + App) share one probe instead of spawning one each.
    if (!inflight) {
      inflight = probe().catch(() => UNAVAILABLE).then(value => {
        cached = value;
        cachedAt = now();
        return value;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  };
}

// ── frozen local copy of src/host-power-services.js ─────────────────────────

// The three product constructors are replaced: the differential injects all
// three services, so these accessors are unreachable (and throw loudly if the
// frozen handler is ever mounted without the injected deps).
const getUnlockPassword = () => { throw new Error('frozen host-read: deps.unlockPassword is required'); };
const getUnlockProbe = () => { throw new Error('frozen host-read: deps.unlockProbe is required'); };
const getPowerPreferences = () => { throw new Error('frozen host-read: deps.powerPreferences is required'); };

async function readPowerSettings(deps, req) {
  if (!deps.macosPower.isAvailable()) return { available: false, enabled: false };
  const status = await deps.macosPower.getLidModeSettings();
  if (deps.batteryGuard) status.batteryGuard = deps.batteryGuard.getStatus();
  const password = deps.unlockPassword || getUnlockPassword();
  const preferences = deps.powerPreferences || getPowerPreferences();
  const canEdit = !!deps.isLocalRequest(req);
  try {
    const set = password.isAvailable() && await password.hasPassword();
    const requested = preferences.read(set); // Preserve existing users' consent.
    status.unlockPassword = { available: password.isAvailable(), set, canEdit,
      requested, enabled: set && (requested || status.enabled), requiredByLid: status.enabled };
    if (status.unlockPassword.enabled) {
      const authorization = await (deps.unlockProbe || getUnlockProbe()).desktopPermissions();
      if (authorization.state !== 'authorized') {
        status.unlockPassword.enabled = false;
        status.unlockPassword.authorization = authorization;
      }
    }
  } catch {
    status.unlockPassword = { available: password.isAvailable(), set: false, canEdit, error: 'read-failed' };
  }
  return status;
}

// ── verbatim retired handlers ───────────────────────────────────────────────

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
      bark: channelHealthDto(deps.push.hasBarkDevices ? deps.push.hasBarkDevices() : !!deps.push.cfg.BARK_URL, deps.push.barkHealth),
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
      hasBark: deps.push.hasBarkDevices ? deps.push.hasBarkDevices() : bark.configured,
      ...(deps.push.barkDevices ? { barkDevices: deps.push.barkDevices.list() } : {}),
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

// Live SakuraFrp account + tunnel enrichment for the manage panel. The access
// token is resolved server-side and never returned (getUserInfo redacts it);
// failures degrade to { ok:false, reason } rather than throwing.
function createTunnelSakurafrpHandler(deps) {
  return async function tunnelSakurafrpHandler(req, res, next) {
    try {
      res.json(await deps.tunnel.sakuraAccess());
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

function createPowerSettingsHandler(deps) {
  return async function powerSettingsHandler(req, res, next) {
    try {
      return res.json(await readPowerSettings(deps, req));
    } catch (error) {
      return next(error);
    }
  };
}

function createBatteryHandler(deps) {
  const readBattery = deps.readBattery || createBatteryReader();
  return async function batteryHandler(req, res, next) {
    try {
      return res.json(await readBattery());
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
  app.get('/api/tunnel/sakurafrp', createTunnelSakurafrpHandler(deps));
  app.get('/api/settings/access-token', createAccessTokenSettingsHandler(deps));
  app.get('/api/settings/power', createPowerSettingsHandler(deps));
  app.get('/api/host/battery', createBatteryHandler(deps));
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
  createTunnelSakurafrpHandler,
  createAccessTokenSettingsHandler,
  createPowerSettingsHandler,
  createBatteryHandler,
  mountHostReadRoutes,
  // Differential additions: the retired export name is kept above, `mount` is
  // the harness entry point, and the two frozen service helpers are exposed so
  // the stub Node child can answer the power op with the same body.
  mount: mountHostReadRoutes,
  readPowerSettings,
  createBatteryReader,
  parsePmset,
  UNAVAILABLE,
};
