// External-tunnel monitor: watches each enabled provider's public path. Generic
// providers retain URL probing; Tailscale Funnel uses a layered control/origin/
// public-DNS/edge probe and only reapplies a mapping for confirmed public
// transport failures. Replaces the old phtunnel-monitor.sh + launchd watchdog, whose
// root failure was being an external shell that could fork into multiple
// fighting copies. Running inside the server process makes the monitor a single
// setInterval tied to the process lifetime — it can never run twice.
//
// Guardrails (so a permanently-down URL can't thrash restarts):
//   • failThreshold       — N consecutive failures before acting (debounce)
//   • restartCooldownSec  — min seconds between two restarts of one provider
//   • maxRestartsPerHour  — hard cap; over it the provider is parked
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createPaths } = require('./paths');
const { atomicWriteJson } = require('./runtime-security');
const { createTailscaleFunnelProbe } = require('./tailscale-funnel-health');

const PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const CONFIG_FILE = PATHS.tunnelConfigFile;
const REPAIR_LEDGER_FILE = PATHS.tunnelRepairLedgerFile;
const TAILSCALE_BIN = '/usr/local/bin/tailscale';
const PHDDNS_APP = '/Applications/PhDDNS.app';
const FUNNEL_MIN_FAILURES = 3;
const FUNNEL_REPAIR_COOLDOWN_MS = 15 * 60 * 1000;
const FUNNEL_REPAIR_MAX_PER_HOUR = 2;
const FUNNEL_REPAIR_MAX_PER_DAY = 4;
const MAX_REPAIR_LEDGER_BYTES = 16 * 1024;

// Binary detection for the CLI-based tunnel providers (natapp/cpolar/sakurafrp).
// Each product is probed across a few well-known install paths, then falls back
// to a PATH lookup so a user-installed binary still works.
const NATAPP_BIN_CANDIDATES = ['/opt/natapp/natapp', '/usr/local/bin/natapp', '/opt/homebrew/bin/natapp'];
const CPOLAR_BIN_CANDIDATES = ['/usr/local/bin/cpolar', '/opt/homebrew/bin/cpolar', '/usr/bin/cpolar'];
const SAKURAFRP_BIN_CANDIDATES = ['/usr/local/bin/frpc', '/opt/homebrew/bin/frpc', '/usr/bin/frpc'];
const NATAPP_DEFAULT_CMD = 'natapp -authtoken={authtoken}';
const CPOLAR_DEFAULT_CMD = 'cpolar http {port}';
const SAKURAFRP_DEFAULT_CMD = 'frpc -f {authtoken}';

// Defaults — phddns prefilled with the legacy URL but DISABLED (it is currently
// down; enabling a dead URL would just exercise the restart path on a loop).
const DEFAULT_CONFIG = {
  phddns:    { enabled: false, monitorOnly: false, url: 'https://1129874apfc68.vicp.fun/manage' },
  tailscale: { enabled: false, monitorOnly: false, url: '', funnel: false, funnelPort: 3000 },
  natapp:    { enabled: false, monitorOnly: false, url: '', authtoken: '', port: 3000, startCmd: NATAPP_DEFAULT_CMD },
  cpolar:    { enabled: false, monitorOnly: false, url: '', authtoken: '', port: 3000, startCmd: CPOLAR_DEFAULT_CMD },
  sakurafrp: { enabled: false, monitorOnly: false, url: '', authtoken: '', port: 3000, startCmd: SAKURAFRP_DEFAULT_CMD },
  intervalSec: 30,
  failThreshold: 2,
  restartCooldownSec: 120,
  maxRestartsPerHour: 5,
};

let config = { ...DEFAULT_CONFIG };
let timer = null;
let monitorGeneration = 0;
let tailscaleFunnelProbe = null;
// Every Tailscale CLI mutation shares one queue. A user reset/port change must
// be the final writer even when an automatic reapply was already in flight.
let tailscaleMutationQueue = Promise.resolve();
let failureReporter = () => {};
const SAFE_FAILURE_STAGES = new Set([
  'funnel_compensation',
  'config_persistence_rollback',
  'config_runtime_rollback',
]);
const consistency = {
  degraded: false,
  dirty: false,
  reason: '',
  lastFailureAt: 0,
};
// Per-provider runtime state (not persisted).
const runtime = {
  phddns:    newProviderState(),
  tailscale: newProviderState(),
  natapp:    newProviderState(),
  cpolar:    newProviderState(),
  sakurafrp: newProviderState(),
};

function newProviderState() {
  return {
    lastCheckAt: 0, lastHttpCode: null, healthy: null,
    consecutiveFails: 0, restartTimes: [], lastRestartAt: 0,
    repairableFailStreak: 0,
    attemptTimes: [], lastAttemptAt: 0,
    probeMode: 'url', probeVerdict: 'unknown', probeError: '',
    publicUrl: '', originHttpCode: null,
    resolvedAddressCount: 0, edgeSuccessCount: 0,
    lastAction: '', checking: false,
  };
}

function withTailscaleMutation(task) {
  const execution = tailscaleMutationQueue.then(task, task);
  // Keep the queue usable after a failed command without hiding that failure
  // from the caller that owns `execution`.
  tailscaleMutationQueue = execution.then(() => undefined, () => undefined);
  return execution;
}

function validFunnelPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function effectiveFunnelPort(value) {
  return validFunnelPort(value) ? value : DEFAULT_CONFIG.tailscale.funnelPort;
}

function effectiveFunnelFailureThreshold(value) {
  return Math.max(FUNNEL_MIN_FAILURES, effectiveFailureThreshold(value));
}

function effectiveFailureThreshold(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100
    ? value : DEFAULT_CONFIG.failThreshold;
}

function resetFailureEvidence(state) {
  state.consecutiveFails = 0;
  state.repairableFailStreak = 0;
}

// A probe result describes one concrete desired endpoint. Once a user turns
// Funnel on/off or changes that endpoint, publishing the old address as the
// current health would be false. Replace the state object so an in-flight check
// that captured the old object cannot repopulate it. Historical action times
// remain useful for UI/rate-limit observability and are deliberately retained.
function replaceProviderProbeSnapshot(name) {
  const previous = runtime[name];
  const next = newProviderState();
  if (previous) {
    next.restartTimes = Array.isArray(previous.restartTimes) ? [...previous.restartTimes] : [];
    next.lastRestartAt = Number.isFinite(previous.lastRestartAt) ? previous.lastRestartAt : 0;
    next.attemptTimes = Array.isArray(previous.attemptTimes) ? [...previous.attemptTimes] : [];
    next.lastAttemptAt = Number.isFinite(previous.lastAttemptAt) ? previous.lastAttemptAt : 0;
    pruneRuntimeTimes(next);
  }
  runtime[name] = next;
}

function pruneRuntimeTimes(state, now = Date.now()) {
  state.restartTimes = state.restartTimes.filter(at => Number.isFinite(at) && now - at < 3600 * 1000).slice(-100);
  state.attemptTimes = state.attemptTimes.filter(at => Number.isFinite(at) && now - at < 24 * 3600 * 1000).slice(-100);
}

function emptyRepairLedger() {
  return { version: 1, tailscaleFunnel: { attempts: [] } };
}

function sanitizeRepairLedger(value, now = Date.now()) {
  if (!value || value.version !== 1 || !value.tailscaleFunnel
      || !Array.isArray(value.tailscaleFunnel.attempts)) return null;
  const allowedOutcomes = new Set(['pending', 'command_succeeded', 'command_failed']);
  if (value.tailscaleFunnel.attempts.length > FUNNEL_REPAIR_MAX_PER_DAY) return null;
  for (const item of value.tailscaleFunnel.attempts) {
    if (!item || !Number.isSafeInteger(item.at) || item.at <= 0
        || !allowedOutcomes.has(item.outcome)) return null;
  }
  const attempts = value.tailscaleFunnel.attempts
    // Old evidence may expire. Future evidence is retained deliberately: it
    // can be a real clock rollback and must suppress, never reset, rate limits.
    .filter(item => item.at > now - 24 * 3600 * 1000)
    .map(item => ({ at: item.at, outcome: item.outcome }))
    .sort((a, b) => a.at - b.at)
    .slice(-FUNNEL_REPAIR_MAX_PER_DAY);
  return { version: 1, tailscaleFunnel: { attempts } };
}

let repairLedger = emptyRepairLedger();
let repairLedgerHealthy = true;

function loadRepairLedger() {
  if (!fs.existsSync(REPAIR_LEDGER_FILE)) return;
  try {
    if (fs.statSync(REPAIR_LEDGER_FILE).size > MAX_REPAIR_LEDGER_BYTES) throw new Error('oversized ledger');
    const loaded = sanitizeRepairLedger(JSON.parse(fs.readFileSync(REPAIR_LEDGER_FILE, 'utf8')));
    if (!loaded) throw new Error('invalid ledger');
    repairLedger = loaded;
  } catch (_) {
    repairLedgerHealthy = false;
    console.error('[multicc/tunnel] Funnel repair ledger is invalid; automatic repair disabled');
  }
}

loadRepairLedger();

function setFailureReporter(reporter) {
  failureReporter = typeof reporter === 'function' ? reporter : () => {};
}

function recordConsistencyFailure(stage) {
  const safeStage = SAFE_FAILURE_STAGES.has(stage) ? stage : 'config_runtime_rollback';
  consistency.degraded = true;
  consistency.dirty = true;
  consistency.reason = safeStage;
  consistency.lastFailureAt = Date.now();
  try { failureReporter(safeStage, 'compensation_failed'); } catch (_) { /* reporting is best-effort */ }
}

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function loadedBoolean(value, key, fallback, invalidFallback = fallback) {
  if (!hasOwn(value, key)) return fallback;
  return typeof value[key] === 'boolean' ? value[key] : invalidFallback;
}

function loadedInteger(value, key, { min, max, fallback }) {
  const candidate = value && value[key];
  return Number.isInteger(candidate) && candidate >= min && candidate <= max
    ? candidate : fallback;
}

function loadedUrl(value, fallback = '') {
  if (!value || !hasOwn(value, 'url')) return fallback;
  if (typeof value.url !== 'string' || value.url.length > 2048) return '';
  const candidate = value.url.trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname
      ? candidate : '';
  } catch (_) {
    return '';
  }
}

function loadedSafeText(value, key, fallback = '', { allowEmpty = true } = {}) {
  if (!value || !hasOwn(value, key)) return fallback;
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length > 4096 || /[\r\n\0]/.test(candidate)) return fallback;
  const trimmed = candidate.trim();
  return trimmed || (allowEmpty ? '' : fallback);
}

function sanitizeLoadedConfig(saved) {
  const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const provider = (name, { cli = false } = {}) => {
    const base = DEFAULT_CONFIG[name];
    const value = source[name] && typeof source[name] === 'object' && !Array.isArray(source[name])
      ? source[name] : {};
    const normalized = {
      ...base,
      // Corrupt enable flags disable actions; corrupt monitorOnly flags enable
      // the safer read-only mode. Missing fields retain legacy defaults.
      enabled: loadedBoolean(value, 'enabled', base.enabled, false),
      monitorOnly: loadedBoolean(value, 'monitorOnly', base.monitorOnly, true),
      url: loadedUrl(value, base.url),
    };
    if (name === 'tailscale') {
      normalized.funnel = loadedBoolean(value, 'funnel', base.funnel, false);
      normalized.funnelPort = loadedInteger(value, 'funnelPort', {
        min: 1, max: 65535, fallback: base.funnelPort,
      });
    }
    if (cli) {
      normalized.authtoken = loadedSafeText(value, 'authtoken', base.authtoken);
      normalized.port = loadedInteger(value, 'port', { min: 1, max: 65535, fallback: base.port });
      normalized.startCmd = loadedSafeText(value, 'startCmd', base.startCmd, { allowEmpty: false });
    }
    return normalized;
  };
  return {
    phddns: provider('phddns'),
    tailscale: provider('tailscale'),
    natapp: provider('natapp', { cli: true }),
    cpolar: provider('cpolar', { cli: true }),
    sakurafrp: provider('sakurafrp', { cli: true }),
    intervalSec: loadedInteger(source, 'intervalSec', {
      min: 10, max: 2147483, fallback: DEFAULT_CONFIG.intervalSec,
    }),
    failThreshold: loadedInteger(source, 'failThreshold', {
      min: 1, max: 100, fallback: DEFAULT_CONFIG.failThreshold,
    }),
    restartCooldownSec: loadedInteger(source, 'restartCooldownSec', {
      min: 0, max: 86400, fallback: DEFAULT_CONFIG.restartCooldownSec,
    }),
    maxRestartsPerHour: loadedInteger(source, 'maxRestartsPerHour', {
      min: 1, max: 100, fallback: DEFAULT_CONFIG.maxRestartsPerHour,
    }),
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = sanitizeLoadedConfig(saved);
    }
  } catch (_) {
    config = sanitizeLoadedConfig({});
    console.error('[multicc/tunnel] Tunnel config is unreadable; providers disabled');
  }
  return config;
}

function saveConfig(nextConfig = config) {
  // Configuration mutations are HTTP commit boundaries. Let the atomic writer
  // failure propagate so the route cannot report success for runtime-only
  // state. Callers prepare `nextConfig` first and publish it in memory only
  // after this durable write succeeds.
  atomicWriteJson(CONFIG_FILE, nextConfig);
}

function funnelRepairStatus(now = Date.now()) {
  const sanitized = sanitizeRepairLedger(repairLedger, now) || emptyRepairLedger();
  const attempts = sanitized.tailscaleFunnel.attempts;
  const lastAttemptAt = attempts.length ? attempts[attempts.length - 1].at : 0;
  return {
    ledgerHealthy: repairLedgerHealthy,
    lastAttemptAt,
    attemptsLastHour: attempts.filter(item => item.at > now - 3600 * 1000).length,
    attemptsLastDay: attempts.length,
  };
}

function funnelRepairGuard(now = Date.now()) {
  const status = funnelRepairStatus(now);
  if (!status.ledgerHealthy) return { ok: false, reason: 'ledger_unavailable', status };
  if (status.lastAttemptAt && now - status.lastAttemptAt < FUNNEL_REPAIR_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      waitSec: Math.ceil((FUNNEL_REPAIR_COOLDOWN_MS - (now - status.lastAttemptAt)) / 1000),
      status,
    };
  }
  if (status.attemptsLastHour >= FUNNEL_REPAIR_MAX_PER_HOUR) {
    return { ok: false, reason: 'hour_cap', status };
  }
  if (status.attemptsLastDay >= FUNNEL_REPAIR_MAX_PER_DAY) {
    return { ok: false, reason: 'day_cap', status };
  }
  return { ok: true, status };
}

function reserveFunnelRepair(now = Date.now()) {
  if (!repairLedgerHealthy) throw new Error('repair ledger unavailable');
  const current = sanitizeRepairLedger(repairLedger, now) || emptyRepairLedger();
  const next = {
    version: 1,
    tailscaleFunnel: {
      attempts: [...current.tailscaleFunnel.attempts, { at: now, outcome: 'pending' }]
        .slice(-FUNNEL_REPAIR_MAX_PER_DAY),
    },
  };
  try {
    atomicWriteJson(REPAIR_LEDGER_FILE, next);
  } catch (error) {
    repairLedgerHealthy = false;
    throw error;
  }
  repairLedger = next;
  return now;
}

function settleFunnelRepair(at, outcome) {
  if (!repairLedgerHealthy) return false;
  const next = JSON.parse(JSON.stringify(repairLedger));
  const attempt = [...next.tailscaleFunnel.attempts].reverse()
    .find(item => item.at === at && item.outcome === 'pending');
  if (!attempt) return false;
  attempt.outcome = outcome === 'command_succeeded' ? 'command_succeeded' : 'command_failed';
  try {
    atomicWriteJson(REPAIR_LEDGER_FILE, next);
    repairLedger = next;
    return true;
  } catch (_) {
    repairLedgerHealthy = false;
    console.error('[multicc/tunnel] Funnel repair ledger result write failed; automatic repair disabled');
    return false;
  }
}

// Provider availability on this machine (informs the UI; not a config value).
function availability() {
  return {
    phddns: fs.existsSync(PHDDNS_APP),
    tailscale: fs.existsSync(TAILSCALE_BIN),
    natapp: !!findBin(NATAPP_BIN_CANDIDATES, 'natapp'),
    cpolar: !!findBin(CPOLAR_BIN_CANDIDATES, 'cpolar'),
    sakurafrp: !!findBin(SAKURAFRP_BIN_CANDIDATES, 'frpc'),
  };
}

// HEAD/GET the URL; resolves to an HTTP status (or 0 on connect failure/timeout).
function probe(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(0);
    let mod;
    try { mod = url.startsWith('https') ? require('https') : require('http'); }
    catch { return resolve(0); }
    const req = mod.get(url, { timeout: 12000, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

function execShell(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' });
    });
  });
}

function getTailscaleFunnelProbe() {
  if (!tailscaleFunnelProbe) {
    tailscaleFunnelProbe = createTailscaleFunnelProbe({
      run: execShell,
      tailscaleBin: TAILSCALE_BIN,
    });
  }
  return tailscaleFunnelProbe;
}

// Locate a CLI binary: try explicit candidate paths first, then scan PATH.
function findBin(candidates, name) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const dirs = (process.env.PATH || '').split(':');
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      if (!fs.existsSync(full)) continue;
      if (!fs.statSync(full).isFile()) continue;
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch (_) { /* not executable / inaccessible */ }
  }
  return null;
}

// Wrap a value in single quotes for safe shell interpolation, escaping any
// embedded single quotes so the result can never break out of the quote.
function shellQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
}

// Substitute the {authtoken}/{port} placeholders in a startCmd template. The
// authtoken is single-quote-escaped to prevent shell injection; port is a
// coerced integer so it needs no quoting.
function renderStartCmd(template, pc) {
  let cmd = template || '';
  cmd = cmd.split('{authtoken}').join(shellQuote(pc.authtoken));
  cmd = cmd.split('{port}').join(String(pc.port || 3000));
  return cmd;
}

// Run a shell command that backgrounds a long-lived process via nohup ... &.
// bash returns immediately (the trailing & detaches), so the 15s timeout only
// guards against bash itself failing to start - it never waits on the tunnel.
function runDetached(shellCmd) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', ['-c', shellCmd], { timeout: 15000 }, (err) => {
      if (err) {
        const error = new Error('后台启动失败');
        error.cause = (err && err.message) || 'unknown error';
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function restartPhddns({ run = execShell, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  await run('/usr/bin/killall', ['PhtunnelService', 'PhDDNS']);
  await wait(3000);
  const opened = await run('/usr/bin/open', [PHDDNS_APP]);
  if (!opened.ok) {
    const error = new Error('phddns start failed');
    error.cause = opened.stderr || 'unknown error';
    throw error;
  }
  return '已重启花生壳 (PhDDNS)';
}

async function restartTailscale({ run = execShell } = {}) {
  const r = await run(TAILSCALE_BIN, ['up']);
  if (!r.ok) {
    const error = new Error('tailscale restart failed');
    error.cause = r.stderr || 'unknown error';
    throw error;
  }
  return '已执行 tailscale up';
}

async function reapplyTailscaleFunnel({ run = execShell, funnelConfig = config.tailscale } = {}) {
  if (!funnelConfig || funnelConfig.funnel !== true || !validFunnelPort(funnelConfig.funnelPort)) {
    throw new Error('invalid tailscale funnel config');
  }
  const port = funnelConfig.funnelPort;
  // Idempotent desired-mapping reapply only. Automatic code never emits reset
  // and never substitutes a generic control-plane `tailscale up` action.
  const r = await run(TAILSCALE_BIN, ['funnel', '--bg', String(port)]);
  if (!r.ok) {
    const error = new Error('tailscale funnel reapply failed');
    error.cause = r.stderr || 'unknown error';
    throw error;
  }
  return `已重新应用 Tailscale Funnel（端口 ${port}），等待公网复检`;
}

// Turn public-internet Funnel on/off (Tailscale CLI v1.84+ syntax):
//   on  → `tailscale funnel --bg <port>`
//   off → `tailscale funnel reset`
// Returns { ok, message }.
async function setFunnel(on, port, { run = execShell, persist = saveConfig } = {}) {
  if (!validFunnelPort(port)) {
    return { ok: false, message: 'Funnel operation failed' };
  }
  // Invalidate probes immediately, before waiting for the mutation queue. A
  // check that started against the old desired port can no longer act.
  monitorGeneration++;
  resetFailureEvidence(runtime.tailscale);
  if (tailscaleFunnelProbe) tailscaleFunnelProbe.clearCache();
  try {
    return await withTailscaleMutation(async () => {
      // Probes may have run while this user action waited behind another CLI
      // mutation. None of that evidence belongs to the state being committed.
      resetFailureEvidence(runtime.tailscale);
      const p = port;
      const previous = { ...config.tailscale };
      const args = on ? ['funnel', '--bg', String(p)] : ['funnel', 'reset'];
      const r = await run(TAILSCALE_BIN, args);
      if (!r.ok) return { ok: false, message: 'Funnel 操作失败' };
      // Keep config in sync with actual Tailscale state. Opening Funnel also
      // starts a read-only loop even when auto repair itself is disabled.
      const nextConfig = {
        ...config,
        tailscale: { ...config.tailscale, funnel: !!on, funnelPort: p },
      };
      try {
        persist(nextConfig);
      } catch (error) {
        // The external command already committed. Best-effort compensate it so
        // disk and Tailscale do not silently end on opposite sides.
        const rollbackArgs = previous.funnel === true
          ? ['funnel', '--bg', String(effectiveFunnelPort(previous.funnelPort))]
          : ['funnel', 'reset'];
        const rollback = await run(TAILSCALE_BIN, rollbackArgs);
        if (!rollback.ok) {
          const rollbackError = new Error('tailscale funnel compensation failed');
          rollbackError.cause = rollback.stderr || 'unknown error';
          error.rollbackError = rollbackError;
          recordConsistencyFailure('funnel_compensation');
        }
        throw error;
      }
      config = nextConfig;
      replaceProviderProbeSnapshot('tailscale');
      startLoop();
      return { ok: true, message: on ? `已开启 Funnel 公网访问 (端口 ${p})` : '已关闭所有 Funnel' };
    });
  } finally {
    // Also invalidate probes that began while the user mutation was queued.
    monitorGeneration++;
    resetFailureEvidence(runtime.tailscale);
    if (tailscaleFunnelProbe) tailscaleFunnelProbe.clearCache();
  }
}

// Read-only Funnel status text from tailscale.
async function funnelStatus() {
  const r = await execShell(TAILSCALE_BIN, ['funnel', 'status']);
  if (!r.ok) {
    const error = new Error('tailscale funnel status failed');
    error.cause = r.stderr || 'unknown error';
    throw error;
  }
  return (r.stdout || '').trim();
}

// This machine's globally-routable IPv6 address(es), read from the OS
// interfaces. Only global-unicast (2000::/3) counts — link-local (fe80::/10)
// and unique-local (fc00::/7) can't be reached by a remote peer, so they don't
// enable a direct path.
function hostGlobalV6() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const isV6 = a.family === 'IPv6' || a.family === 6;
      if (!isV6 || a.internal) continue;
      const ip = (a.address || '').toLowerCase();
      if (!ip || ip === '::1') continue;
      if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) continue; // link-local / ULA
      out.push({ iface, address: a.address });
    }
  }
  return out;
}

// IPv6 reachability for the "外网穿透" panel. When the host has a global IPv6
// AND tailscale netcheck confirms IPv6, remote clients (e.g. phone on cellular)
// can ride a direct IPv6 path instead of falling back to a far DERP relay.
async function ipv6Status() {
  const host = hostGlobalV6();
  const out = {
    host: { hasGlobalV6: host.length > 0, addresses: host },
    tailscale: { available: fs.existsSync(TAILSCALE_BIN), ipv6: null, detail: '', nearestDerp: '' },
    directReady: false,
  };
  if (out.tailscale.available) {
    const r = await execShell(TAILSCALE_BIN, ['netcheck']);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const m = text.match(/IPv6:\s*(yes|no)([^\n]*)/i);
    if (m) {
      out.tailscale.ipv6 = /yes/i.test(m[1]);
      out.tailscale.detail = `${m[1]}${m[2] || ''}`.trim();
    }
    const d = text.match(/Nearest DERP:\s*([^\n]+)/i);
    if (d) out.tailscale.nearestDerp = d[1].trim();
  }
  // Direct IPv6 is ready when we have a global address and, if tailscale is
  // present, it agrees the address is actually reachable over IPv6.
  out.directReady = out.host.hasGlobalV6 &&
    (out.tailscale.available ? out.tailscale.ipv6 === true : true);
  return out;
}

// Metadata for the CLI-based providers, used by the shared restart path.
const PROVIDER_META = {
  natapp:    { display: 'natapp', candidates: NATAPP_BIN_CANDIDATES, binName: 'natapp', defaultCmd: NATAPP_DEFAULT_CMD },
  cpolar:    { display: 'cpolar', candidates: CPOLAR_BIN_CANDIDATES, binName: 'cpolar', defaultCmd: CPOLAR_DEFAULT_CMD },
  sakurafrp: { display: '樱花frp (Sakura)', candidates: SAKURAFRP_BIN_CANDIDATES, binName: 'frpc', defaultCmd: SAKURAFRP_DEFAULT_CMD },
};

// Shared restart for the CLI-based providers: kill any stale instance, then
// launch a fresh one detached via nohup so bash returns immediately. cpolar
// additionally re-runs its idempotent `authtoken` config command first.
async function restartCliProvider(name) {
  const meta = PROVIDER_META[name];
  const pc = config[name] || {};
  const bin = findBin(meta.candidates, meta.binName);
  if (!bin) throw new Error(name + ' 未安装, 请先安装其客户端');
  if (name === 'cpolar' && pc.authtoken) {
    await execShell(bin, ['authtoken', pc.authtoken]);
  }
  const startCmd = renderStartCmd(pc.startCmd || meta.defaultCmd, pc);
  const logPath = '/tmp/multicc-' + name + '.log';
  const shellCmd = 'pkill -f ' + shellQuote(bin) + ' 2>/dev/null; sleep 1; nohup ' + startCmd + ' > ' + logPath + ' 2>&1 &';
  await runDetached(shellCmd);
  return '已后台启动 ' + meta.display + ' (日志 ' + logPath + ')';
}

async function restartNatapp() { return restartCliProvider('natapp'); }
async function restartCpolar() { return restartCliProvider('cpolar'); }
async function restartSakurafrp() { return restartCliProvider('sakurafrp'); }

// Root-cause messages from a failed restart may embed the failed shell command
// (execFile echoes it), which contains the rendered authtoken. Mask every
// occurrence before the text leaves the server (API response / UI / logs).
function redactRestartError(name, error) {
  let text = (error && error.message) || 'unknown error';
  if (error && error.cause) text += ': ' + error.cause;
  const secret = (config[name] || {}).authtoken;
  if (secret) text = text.split(secret).join('***');
  if (text.length > 300) text = text.slice(0, 300) + '…';
  return text;
}

const RESTARTERS = { phddns: restartPhddns, tailscale: restartTailscale, natapp: restartNatapp, cpolar: restartCpolar, sakurafrp: restartSakurafrp };

const SAFE_PROBE_ERRORS = new Set([
  '', 'partial_edge_failure', 'probe_failed',
  'tailscale_status_unavailable', 'tailscale_status_malformed', 'tailscale_offline',
  'local_origin_down', 'funnel_status_unavailable', 'funnel_status_malformed',
  'funnel_mapping_missing', 'doh_unreachable', 'non_public_resolution',
  'no_public_address', 'dns_no_record', 'too_many_public_addresses',
  'edge_identity_unverified', 'public_data_plane_down', 'probe_internal_error',
]);

function boundedInteger(value, max = 999) {
  return Number.isInteger(value) && value >= 0 ? Math.min(max, value) : 0;
}

function normalizeProbeResult(value) {
  if (typeof value === 'number') {
    const code = boundedInteger(value, 999);
    const healthy = code >= 200 && code < 400;
    return {
      mode: 'url', verdict: healthy ? 'healthy' : 'unhealthy', healthy,
      repairEligible: true, error: healthy ? '' : 'probe_failed', httpCode: code,
      originHttpCode: 0, publicUrl: '', resolvedAddressCount: 0, edgeSuccessCount: 0,
    };
  }
  const verdict = value && ['healthy', 'degraded', 'unhealthy', 'indeterminate'].includes(value.verdict)
    ? value.verdict : 'indeterminate';
  const error = SAFE_PROBE_ERRORS.has(value && value.error) ? value.error : 'probe_failed';
  const publicUrl = typeof (value && value.publicUrl) === 'string'
    && value.publicUrl.startsWith('https://') && value.publicUrl.length <= 512
    ? value.publicUrl : '';
  return {
    mode: value && value.mode === 'tailscale_funnel_public' ? value.mode : 'url',
    verdict,
    healthy: verdict === 'healthy',
    repairEligible: verdict === 'unhealthy' && value && value.repairEligible === true,
    error,
    httpCode: boundedInteger(value && value.httpCode, 999),
    originHttpCode: boundedInteger(value && value.originHttpCode, 999),
    publicUrl,
    resolvedAddressCount: boundedInteger(value && value.resolvedAddressCount, 32),
    edgeSuccessCount: boundedInteger(value && value.edgeSuccessCount, 32),
  };
}

function providerCanCheck(name, providerConfig) {
  if (!providerConfig) return false;
  // An active Funnel is always observed. `enabled` remains the separate,
  // explicit consent gate for automatic mutation.
  if (name === 'tailscale' && providerConfig.funnel === true) return true;
  if (providerConfig.enabled !== true) return false;
  return !!providerConfig.url;
}

function checkStillCurrent(name, state, generation) {
  return monitorGeneration === generation
    && runtime[name] === state
    && providerCanCheck(name, config[name]);
}

function applyProbeResult(state, result) {
  pruneRuntimeTimes(state);
  state.lastCheckAt = Date.now();
  state.lastHttpCode = result.httpCode;
  state.healthy = (result.verdict === 'indeterminate' || result.verdict === 'degraded')
    ? null : result.healthy;
  state.probeMode = result.mode;
  state.probeVerdict = result.verdict;
  state.probeError = result.error;
  state.publicUrl = result.publicUrl;
  state.originHttpCode = result.originHttpCode;
  state.resolvedAddressCount = result.resolvedAddressCount;
  state.edgeSuccessCount = result.edgeSuccessCount;
}

function describeFunnelGuard(guard) {
  if (guard.reason === 'ledger_unavailable') return 'Funnel 修复账本不可用，未执行自动修复';
  if (guard.reason === 'cooldown') return `Funnel 自动修复等待冷却（${guard.waitSec}s）`;
  if (guard.reason === 'hour_cap') return `已达 Funnel 每小时修复上限（${FUNNEL_REPAIR_MAX_PER_HOUR}）`;
  if (guard.reason === 'day_cap') return `已达 Funnel 每日修复上限（${FUNNEL_REPAIR_MAX_PER_DAY}）`;
  return 'Funnel 自动修复受保护规则抑制';
}

// Decide+act for one provider. Returns nothing; mutates runtime[name].
// probeFn/restarter are injectable so isolated tests can drive the decision
// path without real network requests or process launches.
async function checkProvider(name, options = {}) {
  const pc = config[name];
  const st = runtime[name];
  if (!providerCanCheck(name, pc) || st.checking) return;
  const generation = monitorGeneration;
  const funnelMode = name === 'tailscale' && pc.funnel === true;
  const probeFn = options.probeFn || probe;
  const expectedFunnelPort = funnelMode ? pc.funnelPort : null;
  const restarter = options.restarter || (funnelMode
    ? () => reapplyTailscaleFunnel({
      funnelConfig: { funnel: true, funnelPort: expectedFunnelPort },
    })
    : RESTARTERS[name]);
  st.checking = true;
  try {
    const rawResult = funnelMode && !options.probeFn
      ? await (options.funnelProbe || getTailscaleFunnelProbe()).probe({
        originPort: effectiveFunnelPort(pc.funnelPort),
      })
      : await probeFn(pc.url);
    if (!checkStillCurrent(name, st, generation)) return;
    const result = normalizeProbeResult(rawResult);
    applyProbeResult(st, result);

    if (result.verdict === 'indeterminate' || result.verdict === 'degraded') {
      resetFailureEvidence(st);
      st.lastAction = result.verdict === 'degraded'
        ? '公网边缘部分可用，已告警但不执行自动修复'
        : `探针不确定（${result.error}），未执行自动修复`;
      return;
    }

    if (result.healthy) {
      resetFailureEvidence(st);
      // A stale restart failure next to a healthy probe reads as a live error.
      // Clear failure text only; guardrail notes (cooldown/cap) and success
      // messages stay until the next decision overwrites them.
      if (st.lastAction.startsWith('重启失败') || st.lastAction.startsWith('修复失败')
          || st.lastAction.includes('等待公网复检') || st.lastAction.startsWith('探针不确定')
          || st.lastAction.startsWith('Funnel 探活异常')
          || st.lastAction.startsWith('公网边缘部分可用')) st.lastAction = '';
      return;
    }
    st.consecutiveFails++;
    if (funnelMode) {
      // Only an exact, transport-level public data-plane failure can build
      // repair evidence. Mapping absence, local-origin failure, DNS/cert/
      // identity uncertainty and mixed edge state all break the streak.
      const repairableEvidence = result.verdict === 'unhealthy'
        && result.repairEligible === true
        && result.error === 'public_data_plane_down'
        && validFunnelPort(expectedFunnelPort);
      if (!repairableEvidence) {
        st.repairableFailStreak = 0;
        st.lastAction = `Funnel 探活异常（${result.error}），故障层不满足自动修复条件`;
        return;
      }
      st.repairableFailStreak++;
      if (st.repairableFailStreak < effectiveFunnelFailureThreshold(config.failThreshold)) return;

      // Opening/observing Funnel and consenting to automatic mutation are
      // separate. Invalid legacy booleans also fail closed here.
      if (config.tailscale.enabled !== true || config.tailscale.monitorOnly !== false) {
        st.repairableFailStreak = 0;
        st.lastAction = config.tailscale.enabled !== true
          ? '仅观察：Funnel 自动修复监控未启用'
          : '仅监控：探活异常，按设置不自动修复';
        return;
      }

      await withTailscaleMutation(async () => {
        // Revalidate after actually reaching the single-writer slot. A queued
        // user reset/port change always invalidates this decision.
        if (!checkStillCurrent(name, st, generation)
            || config.tailscale.funnel !== true
            || config.tailscale.enabled !== true
            || config.tailscale.monitorOnly !== false
            || config.tailscale.funnelPort !== expectedFunnelPort) return;
        const now = Date.now();
        const guard = funnelRepairGuard(now);
        if (!guard.ok) {
          st.repairableFailStreak = 0;
          st.lastAction = describeFunnelGuard(guard);
          return;
        }
        let reservation;
        try {
          reservation = reserveFunnelRepair(now);
        } catch (_) {
          st.repairableFailStreak = 0;
          st.lastAction = 'Funnel 修复账本写入失败，未执行自动修复';
          return;
        }
        st.lastAttemptAt = now;
        pruneRuntimeTimes(st, now);
        st.attemptTimes.push(now);
        resetFailureEvidence(st);
        console.warn(`[multicc/tunnel] ${name} confirmed public data plane down; reapplying Funnel mapping`);
        try {
          const action = await restarter();
          settleFunnelRepair(reservation, 'command_succeeded');
          if (!checkStillCurrent(name, st, generation)
              || config.tailscale.funnelPort !== expectedFunnelPort) return;
          st.lastAction = action;
          st.restartTimes = [...st.restartTimes, now].slice(-100);
          st.lastRestartAt = now;
        } catch (_) {
          settleFunnelRepair(reservation, 'command_failed');
          if (!checkStillCurrent(name, st, generation)) return;
          st.lastAction = '修复失败: tailscale_funnel_reapply_failed';
          console.error(`[multicc/tunnel] ${name} Funnel repair command failed`);
        }
        if (checkStillCurrent(name, st, generation)) {
          console.log(`[multicc/tunnel] ${name}: ${st.lastAction}`);
        }
      });
      return;
    }

    const failThreshold = effectiveFailureThreshold(config.failThreshold);
    if (st.consecutiveFails < failThreshold) return;
    if (!result.repairEligible) {
      st.lastAction = `探活异常（${result.error}），未执行自动修复`;
      return;
    }
    if (config[name].monitorOnly !== false) {
      st.lastAction = '仅监控：探活异常，按设置不自动重启';
      return;
    }
    if (!checkStillCurrent(name, st, generation)) return;

    const now = Date.now();
    // Generic provider guardrails retain their existing semantics.
    const cooldownSec = Number.isInteger(config.restartCooldownSec) && config.restartCooldownSec >= 0
      ? config.restartCooldownSec : DEFAULT_CONFIG.restartCooldownSec;
    if (st.lastRestartAt && (now - st.lastRestartAt) < cooldownSec * 1000) {
      st.lastAction = `等待冷却（${Math.ceil((cooldownSec * 1000 - (now - st.lastRestartAt)) / 1000)}s）`;
      return;
    }
    pruneRuntimeTimes(st, now);
    const maxRestarts = Number.isInteger(config.maxRestartsPerHour) && config.maxRestartsPerHour >= 1
      ? Math.min(100, config.maxRestartsPerHour) : DEFAULT_CONFIG.maxRestartsPerHour;
    if (st.restartTimes.length >= maxRestarts) {
      st.lastAction = `已达每小时重启上限（${maxRestarts}），暂停重启`;
      return;
    }

    st.lastAttemptAt = now;
    st.attemptTimes = [...st.attemptTimes, now].slice(-100);
    console.warn(`[multicc/tunnel] ${name} unhealthy (${result.error || `HTTP ${result.httpCode}`}), repairing...`);
    try {
      st.lastAction = await restarter();
      st.restartTimes = [...st.restartTimes, now].slice(-100);
      st.lastRestartAt = now;
    } catch (e) {
      st.lastAction = '重启失败: ' + redactRestartError(name, e);
      console.error(`[multicc/tunnel] ${name} restart command failed`);
    }
    console.log(`[multicc/tunnel] ${name}: ${st.lastAction}`);
  } finally {
    st.checking = false;
  }
}

async function tick() {
  for (const name of Object.keys(RESTARTERS)) {
    try {
      await checkProvider(name);
    } catch (_) {
      const st = runtime[name];
      resetFailureEvidence(st);
      st.lastCheckAt = Date.now();
      st.healthy = null;
      st.probeVerdict = 'indeterminate';
      st.probeError = 'probe_internal_error';
      st.lastAction = '探针内部异常，未执行自动修复';
      console.error(`[multicc/tunnel] ${name} probe failed internally`);
    }
  }
}

// (Re)start the single monitor loop. Always clears the old timer first, so a
// config reload can never leave two intervals running.
function startLoop() {
  monitorGeneration++;
  if (timer) { clearInterval(timer); timer = null; }
  const anyEnabled = config.phddns.enabled === true || config.tailscale.enabled === true
    || config.tailscale.funnel === true || config.natapp.enabled === true
    || config.cpolar.enabled === true || config.sakurafrp.enabled === true;
  if (!anyEnabled) return;
  const intervalSec = Number.isInteger(config.intervalSec)
    && config.intervalSec >= 10 && config.intervalSec <= 2147483
    ? config.intervalSec : DEFAULT_CONFIG.intervalSec;
  const ms = intervalSec * 1000;
  timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
}

function init() {
  loadConfig();
  startLoop();
  const a = availability();
  console.log(`[multicc/tunnel] monitor ready (phddns:${config.phddns.enabled?'on':'off'}/${a.phddns?'installed':'missing'}, tailscale:${config.tailscale.enabled?'on':'off'}/${a.tailscale?'installed':'missing'}, natapp:${config.natapp.enabled?'on':'off'}/${a.natapp?'installed':'missing'}, cpolar:${config.cpolar.enabled?'on':'off'}/${a.cpolar?'installed':'missing'}, sakurafrp:${config.sakurafrp.enabled?'on':'off'}/${a.sakurafrp?'installed':'missing'})`);
}

// Stop the process-owned monitor interval. This is intentionally idempotent so
// the shutdown coordinator can call it from more than one cleanup path. Runtime
// provider state and the loaded config are retained; a later init() resumes the
// monitor without losing counters or creating a second interval.
function stop() {
  monitorGeneration++;
  if (tailscaleFunnelProbe) tailscaleFunnelProbe.clearCache();
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// Merge a partial config update, persist, and reload the loop. Resets a
// provider's fail/restart counters when it gets toggled on.
function applyConfig(update, { persist = saveConfig, publish = startLoop } = {}) {
  const previousConfig = config;
  const wasPhddns = config.phddns.enabled;
  const wasTailscale = config.tailscale.enabled;
  const wasNatapp = config.natapp.enabled;
  const wasCpolar = config.cpolar.enabled;
  const wasSakurafrp = config.sakurafrp.enabled;
  const nextConfig = {
    ...config, ...update,
    phddns:    { ...config.phddns,    ...(update.phddns || {}) },
    tailscale: { ...config.tailscale, ...(update.tailscale || {}) },
    natapp:    { ...config.natapp,    ...(update.natapp || {}) },
    cpolar:    { ...config.cpolar,    ...(update.cpolar || {}) },
    sakurafrp: { ...config.sakurafrp, ...(update.sakurafrp || {}) },
  };
  const tailscaleProbeTargetChanged = !!update.tailscale
    && ['enabled', 'url', 'funnel', 'funnelPort']
      .some(key => previousConfig.tailscale[key] !== nextConfig.tailscale[key]);
  persist(nextConfig);
  try {
    config = nextConfig;
    publish();
  } catch (error) {
    // The durable write happened before the live scheduler publish. Restore
    // both sides if publishing fails so HTTP never returns a split-brain state.
    let rollbackError = null;
    try { persist(previousConfig); } catch (failure) {
      rollbackError = failure;
      recordConsistencyFailure('config_persistence_rollback');
    }
    config = previousConfig;
    try { publish(); } catch (failure) {
      rollbackError ||= failure;
      recordConsistencyFailure('config_runtime_rollback');
    }
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  }
  if (config.phddns.enabled && !wasPhddns) runtime.phddns = newProviderState();
  if (tailscaleProbeTargetChanged) replaceProviderProbeSnapshot('tailscale');
  else if (config.tailscale.enabled && !wasTailscale) runtime.tailscale = newProviderState();
  if (config.natapp.enabled && !wasNatapp) runtime.natapp = newProviderState();
  if (config.cpolar.enabled && !wasCpolar) runtime.cpolar = newProviderState();
  if (config.sakurafrp.enabled && !wasSakurafrp) runtime.sakurafrp = newProviderState();
  if (update.tailscale) {
    resetFailureEvidence(runtime.tailscale);
    if (tailscaleFunnelProbe) tailscaleFunnelProbe.clearCache();
  }
  return config;
}

function getStatus() {
  for (const state of Object.values(runtime)) pruneRuntimeTimes(state);
  const a = availability();
  return {
    config,
    availability: a,
    monitorRunning: !!timer,
    providers: {
      phddns:    { ...runtime.phddns },
      tailscale: { ...runtime.tailscale, repairGuard: funnelRepairStatus() },
      natapp:    { ...runtime.natapp },
      cpolar:    { ...runtime.cpolar },
      sakurafrp: { ...runtime.sakurafrp },
    },
    consistency: { ...consistency },
  };
}

// Force an immediate restart of one provider (UI "restart now" button).
// restarter is injectable for isolated tests.
async function restartNow(name, { restarter = RESTARTERS[name] } = {}) {
  if (!RESTARTERS[name]) return { ok: false, error: 'unknown provider' };
  const st = runtime[name];
  const perform = async () => {
    resetFailureEvidence(st);
    try {
      st.lastAction = await restarter();
      const now = Date.now();
      pruneRuntimeTimes(st, now);
      st.restartTimes = [...st.restartTimes, now].slice(-100);
      st.lastRestartAt = now;
      return { ok: true, message: st.lastAction };
    } catch (e) {
      const message = name === 'tailscale'
        ? 'Tailscale 控制面重连失败'
        : redactRestartError(name, e);
      st.lastAction = '重启失败: ' + message;
      console.error(`[multicc/tunnel] manual ${name} restart failed`);
      return { ok: false, error: 'restart_failed', message };
    }
  };
  if (name !== 'tailscale') return perform();

  monitorGeneration++;
  if (tailscaleFunnelProbe) tailscaleFunnelProbe.clearCache();
  try {
    return await withTailscaleMutation(perform);
  } finally {
    monitorGeneration++;
    resetFailureEvidence(runtime.tailscale);
    if (tailscaleFunnelProbe) tailscaleFunnelProbe.clearCache();
  }
}

module.exports = {
  init,
  stop,
  applyConfig,
  getStatus,
  restartNow,
  checkProvider,
  restartPhddns,
  restartTailscale,
  reapplyTailscaleFunnel,
  restartNatapp,
  restartCpolar,
  restartSakurafrp,
  loadConfig,
  availability,
  setFunnel,
  funnelStatus,
  ipv6Status,
  setFailureReporter,
};
