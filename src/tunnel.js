// External-tunnel monitor: watches the public URL of each enabled provider
// (花生壳/PhDDNS, Tailscale) and restarts that provider when its URL goes
// unreachable. Replaces the old phtunnel-monitor.sh + launchd watchdog, whose
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

const CONFIG_FILE = createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).tunnelConfigFile;
const TAILSCALE_BIN = '/usr/local/bin/tailscale';
const PHDDNS_APP = '/Applications/PhDDNS.app';

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
    lastAction: '', checking: false,
  };
}

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

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = {
        ...DEFAULT_CONFIG, ...saved,
        phddns:    { ...DEFAULT_CONFIG.phddns,    ...(saved.phddns || {}) },
        tailscale: { ...DEFAULT_CONFIG.tailscale, ...(saved.tailscale || {}) },
        natapp:    { ...DEFAULT_CONFIG.natapp,    ...(saved.natapp || {}) },
        cpolar:    { ...DEFAULT_CONFIG.cpolar,    ...(saved.cpolar || {}) },
        sakurafrp: { ...DEFAULT_CONFIG.sakurafrp, ...(saved.sakurafrp || {}) },
      };
    }
  } catch (e) {
    console.error('[multicc/tunnel] Failed to load config:', e.message);
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

async function restartTailscale() {
  // Gentle: re-establish the connection without bouncing tailscaled.
  const r = await execShell(TAILSCALE_BIN, ['up']);
  if (!r.ok) {
    const error = new Error('tailscale restart failed');
    error.cause = r.stderr || 'unknown error';
    throw error;
  }
  return '已执行 tailscale up';
}

// Turn public-internet Funnel on/off (Tailscale CLI v1.84+ syntax):
//   on  → `tailscale funnel --bg <port>`
//   off → `tailscale funnel reset`
// Returns { ok, message }.
async function setFunnel(on, port, { run = execShell, persist = saveConfig } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: 'Funnel operation failed' };
  }
  const p = port;
  const previous = { ...config.tailscale };
  const args = on ? ['funnel', '--bg', String(p)] : ['funnel', 'reset'];
  const r = await run(TAILSCALE_BIN, args);
  if (!r.ok) return { ok: false, message: `Funnel 操作失败: ${(r.stderr || '').slice(0, 200)}` };
  // Keep config in sync with the actual tailscale state so the UI doesn't
  // revert to stale values on the next loadTunnelSettings() reload.
  const nextConfig = {
    ...config,
    tailscale: { ...config.tailscale, funnel: !!on, funnelPort: p },
  };
  try {
    persist(nextConfig);
  } catch (error) {
    // The external command already committed. Best-effort compensate it so a
    // failed durable save does not silently leave tailscale and our config on
    // opposite sides of the transaction. The route still fails closed even if
    // this compensation also fails.
    const rollbackArgs = previous.funnel
      ? ['funnel', '--bg', String(previous.funnelPort || 3000)]
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
  return { ok: true, message: on ? `已开启 Funnel 公网访问 (端口 ${p})` : '已关闭所有 Funnel' };
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

// Decide+act for one provider. Returns nothing; mutates runtime[name].
// probeFn/restarter are injectable so isolated tests can drive the decision
// path without real network requests or process launches.
async function checkProvider(name, { probeFn = probe, restarter = RESTARTERS[name] } = {}) {
  const pc = config[name];
  const st = runtime[name];
  if (!pc || !pc.enabled || !pc.url || st.checking) return;
  st.checking = true;
  try {
    const code = await probeFn(pc.url);
    const healthy = code >= 200 && code < 400;
    st.lastCheckAt = Date.now();
    st.lastHttpCode = code;
    st.healthy = healthy;

    if (healthy) {
      st.consecutiveFails = 0;
      // A stale restart failure next to a healthy probe reads as a live error.
      // Clear failure text only; guardrail notes (cooldown/cap) and success
      // messages stay until the next decision overwrites them.
      if (st.lastAction.startsWith('重启失败')) st.lastAction = '';
      return;
    }
    st.consecutiveFails++;
    if (st.consecutiveFails < config.failThreshold) return;

    // Monitor-only: probe and report, but never touch the client process.
    if (pc.monitorOnly) {
      st.lastAction = '仅监控：探活异常，按设置不自动重启';
      return;
    }

    // Guardrail: cooldown since last restart.
    const now = Date.now();
    if (st.lastRestartAt && (now - st.lastRestartAt) < config.restartCooldownSec * 1000) {
      st.lastAction = `等待冷却（${Math.ceil((config.restartCooldownSec * 1000 - (now - st.lastRestartAt)) / 1000)}s）`;
      return;
    }
    // Guardrail: hourly restart cap.
    st.restartTimes = st.restartTimes.filter(t => now - t < 3600 * 1000);
    if (st.restartTimes.length >= config.maxRestartsPerHour) {
      st.lastAction = `已达每小时重启上限（${config.maxRestartsPerHour}），暂停重启`;
      return;
    }

    console.warn(`[multicc/tunnel] ${name} unreachable (HTTP ${code}), restarting...`);
    try {
      st.lastAction = await restarter();
      // Count the restart only once it actually happened, so a permanently
      // failing restart (e.g. client not installed) can't eat the hourly cap.
      st.restartTimes.push(now);
      st.lastRestartAt = now;
    } catch (e) {
      st.lastAction = '重启失败: ' + redactRestartError(name, e);
      console.error(`[multicc/tunnel] ${name} restart failed:`, e && (e.stack || e.message) || e);
    }
    console.log(`[multicc/tunnel] ${name}: ${st.lastAction}`);
  } finally {
    st.checking = false;
  }
}

async function tick() {
  for (const name of Object.keys(RESTARTERS)) {
    try { await checkProvider(name); } catch (_) {}
  }
}

// (Re)start the single monitor loop. Always clears the old timer first, so a
// config reload can never leave two intervals running.
function startLoop() {
  if (timer) { clearInterval(timer); timer = null; }
  const anyEnabled = config.phddns.enabled || config.tailscale.enabled
    || config.natapp.enabled || config.cpolar.enabled || config.sakurafrp.enabled;
  if (!anyEnabled) return;
  const ms = Math.max(10, config.intervalSec) * 1000;
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
  if (config.tailscale.enabled && !wasTailscale) runtime.tailscale = newProviderState();
  if (config.natapp.enabled && !wasNatapp) runtime.natapp = newProviderState();
  if (config.cpolar.enabled && !wasCpolar) runtime.cpolar = newProviderState();
  if (config.sakurafrp.enabled && !wasSakurafrp) runtime.sakurafrp = newProviderState();
  return config;
}

function getStatus() {
  const a = availability();
  return {
    config,
    availability: a,
    monitorRunning: !!timer,
    providers: {
      phddns:    { ...runtime.phddns },
      tailscale: { ...runtime.tailscale },
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
  try {
    st.lastAction = await restarter();
    const now = Date.now();
    st.restartTimes.push(now);
    st.lastRestartAt = now;
    return { ok: true, message: st.lastAction };
  } catch (e) {
    const message = redactRestartError(name, e);
    st.lastAction = '重启失败: ' + message;
    console.error(`[multicc/tunnel] manual ${name} restart failed:`, e && (e.stack || e.message) || e);
    return { ok: false, error: 'restart_failed', message };
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
