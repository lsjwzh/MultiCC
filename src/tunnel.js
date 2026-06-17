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
const path = require('path');
const { execFile } = require('child_process');

const CONFIG_FILE = path.join(__dirname, '..', 'tunnel-config.json');
const TAILSCALE_BIN = '/usr/local/bin/tailscale';
const PHDDNS_APP = '/Applications/PhDDNS.app';

// Defaults — phddns prefilled with the legacy URL but DISABLED (it is currently
// down; enabling a dead URL would just exercise the restart path on a loop).
const DEFAULT_CONFIG = {
  phddns:    { enabled: false, url: 'https://1129874apfc68.vicp.fun/manage' },
  tailscale: { enabled: false, url: '' },
  intervalSec: 30,
  failThreshold: 2,
  restartCooldownSec: 120,
  maxRestartsPerHour: 5,
};

let config = { ...DEFAULT_CONFIG };
let timer = null;
// Per-provider runtime state (not persisted).
const runtime = {
  phddns:    newProviderState(),
  tailscale: newProviderState(),
};

function newProviderState() {
  return {
    lastCheckAt: 0, lastHttpCode: null, healthy: null,
    consecutiveFails: 0, restartTimes: [], lastRestartAt: 0,
    lastAction: '', checking: false,
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = {
        ...DEFAULT_CONFIG, ...saved,
        phddns:    { ...DEFAULT_CONFIG.phddns,    ...(saved.phddns || {}) },
        tailscale: { ...DEFAULT_CONFIG.tailscale, ...(saved.tailscale || {}) },
      };
    }
  } catch (e) {
    console.error('[multicc/tunnel] Failed to load config:', e.message);
  }
  return config;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[multicc/tunnel] Failed to save config:', e.message);
  }
}

// Provider availability on this machine (informs the UI; not a config value).
function availability() {
  return {
    phddns: fs.existsSync(PHDDNS_APP),
    tailscale: fs.existsSync(TAILSCALE_BIN),
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

async function restartPhddns() {
  await execShell('/usr/bin/killall', ['PhtunnelService', 'PhDDNS']);
  await new Promise(r => setTimeout(r, 3000));
  await execShell('/usr/bin/open', [PHDDNS_APP]);
  return '已重启花生壳 (PhDDNS)';
}

async function restartTailscale() {
  // Gentle: re-establish the connection without bouncing tailscaled.
  const r = await execShell(TAILSCALE_BIN, ['up']);
  return r.ok ? '已执行 tailscale up' : `tailscale up 失败: ${r.stderr.slice(0, 120)}`;
}

const RESTARTERS = { phddns: restartPhddns, tailscale: restartTailscale };

// Decide+act for one provider. Returns nothing; mutates runtime[name].
async function checkProvider(name) {
  const pc = config[name];
  const st = runtime[name];
  if (!pc || !pc.enabled || !pc.url || st.checking) return;
  st.checking = true;
  try {
    const code = await probe(pc.url);
    const healthy = code >= 200 && code < 400;
    st.lastCheckAt = Date.now();
    st.lastHttpCode = code;
    st.healthy = healthy;

    if (healthy) { st.consecutiveFails = 0; return; }
    st.consecutiveFails++;
    if (st.consecutiveFails < config.failThreshold) return;

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
    st.restartTimes.push(now);
    st.lastRestartAt = now;
    try { st.lastAction = await RESTARTERS[name](); }
    catch (e) { st.lastAction = `重启出错: ${e.message}`; }
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
  const anyEnabled = config.phddns.enabled || config.tailscale.enabled;
  if (!anyEnabled) return;
  const ms = Math.max(10, config.intervalSec) * 1000;
  timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
}

function init() {
  loadConfig();
  startLoop();
  const a = availability();
  console.log(`[multicc/tunnel] monitor ready (phddns:${config.phddns.enabled?'on':'off'}/${a.phddns?'installed':'missing'}, tailscale:${config.tailscale.enabled?'on':'off'}/${a.tailscale?'installed':'missing'})`);
}

// Merge a partial config update, persist, and reload the loop. Resets a
// provider's fail/restart counters when it gets toggled on.
function applyConfig(update) {
  const wasPhddns = config.phddns.enabled;
  const wasTailscale = config.tailscale.enabled;
  config = {
    ...config, ...update,
    phddns:    { ...config.phddns,    ...(update.phddns || {}) },
    tailscale: { ...config.tailscale, ...(update.tailscale || {}) },
  };
  if (config.phddns.enabled && !wasPhddns) runtime.phddns = newProviderState();
  if (config.tailscale.enabled && !wasTailscale) runtime.tailscale = newProviderState();
  saveConfig();
  startLoop();
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
    },
  };
}

// Force an immediate restart of one provider (UI "restart now" button).
async function restartNow(name) {
  if (!RESTARTERS[name]) return { ok: false, error: 'unknown provider' };
  const st = runtime[name];
  const now = Date.now();
  st.restartTimes.push(now);
  st.lastRestartAt = now;
  try {
    st.lastAction = await RESTARTERS[name]();
    return { ok: true, message: st.lastAction };
  } catch (e) {
    st.lastAction = `重启出错: ${e.message}`;
    return { ok: false, error: e.message };
  }
}

module.exports = { init, applyConfig, getStatus, restartNow, loadConfig, availability };
