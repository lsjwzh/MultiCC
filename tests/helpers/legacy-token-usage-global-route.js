'use strict';

// Frozen Node implementation of GET /api/token-usage/global: src/token-global.js
// and the route handler from src/routes/token-usage.js, kept verbatim after both
// were retired into the Rust front door (native/gateway/src/app/token_usage_global.rs).
//
// Global Claude/Codex token usage, read straight from the canonical source: the
// claude CLI's own session transcripts under ~/.claude/projects/**/*.jsonl.
// Rust dedupes by requestId+msgId and aggregates by model across today / week /
// month / all windows, plus a per-day trend; this file only walks the trees,
// builds the local window boundaries, stamps generatedAt and caches the answer
// for 120s.
//
// Consumers:
//   - docs/rust-migration/differential/token-usage-global.js mounts the route
//     and compares it byte for byte against the gateway;
//   - tests/test-token-global.js and tests/test-rust-kernels.js call `_compute`
//     as the Node-side entry to the Rust usage kernel, so kernel regressions
//     stay covered after the production module was deleted.

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const CACHE_TTL_MS = 120 * 1000;
const PUBLIC_USAGE_ERROR = 'Token usage is temporarily unavailable';

let cache = null;          // { at, data }
let inFlight = null;       // shared promise so concurrent requests scan once

function sources() {
  const home = os.homedir();
  return {
    projectsDir: path.join(home, '.claude', 'projects'),
    codexDir: path.join(home, '.codex', 'sessions'),
  };
}

function localDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Window boundaries (local time): today / Monday-week / month-1st.
function windowStarts(now = new Date()) {
  const today = localDateKey(now);
  const wk = new Date(now);
  wk.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // back to Monday
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return { today, week: localDateKey(wk), month: localDateKey(monthStart) };
}

async function listJsonl(dir) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listJsonl(full));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// Rust 扫描与聚合在工作线程执行；目录顺序和窗口边界保持 Node 原有语义。
async function compute(options = {}, addon) {
  const defaults = sources();
  const {
    projectsDir = defaults.projectsDir,
    codexDir = defaults.codexDir,
    now = new Date(),
    telemetry = null,
  } = options;
  const input = JSON.stringify({
    claudeFiles: await listJsonl(projectsDir),
    codexFiles: (await listJsonl(codexDir)).sort(),
    windows: windowStarts(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const runtime = require('../../src/native/runtime');
  const result = await runtime.runNative(() => addon.computeUsage(input));
  runtime.record('usage'); // 与已退役的 src/token-global.js 一致：原生调用必须计数
  const data = JSON.parse(result.result);
  if (telemetry) telemetry.nativeMs = result.computeMs;
  return { generatedAt: new Date().toISOString(), sources: { claude: projectsDir, codex: codexDir }, ...data };
}

async function computeGlobal(options = {}) {
  return compute(options, require('../../src/native/runtime').getNative());
}

// Cached accessor. Re-scans at most once per TTL; concurrent callers share the
// same in-flight scan. `force` bypasses the cache (UI "refresh" button).
async function getGlobalUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && (now - cache.at) < CACHE_TTL_MS) return cache.data;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await computeGlobal();
      cache = { at: Date.now(), data };
      return data;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// The retired route (src/routes/token-usage.js `mountRoutes`).
function mountTokenUsageGlobalRoute(app) {
  app.get('/api/token-usage/global', async (req, res) => {
    try {
      const data = await getGlobalUsage({
        force: !!(req.query && req.query.refresh === '1'),
      });
      res.json(data);
    } catch (_) {
      res.status(500).json({ error: PUBLIC_USAGE_ERROR });
    }
  });
}

function _resetCacheForTest() {
  cache = null;
  inFlight = null;
}

module.exports = {
  CACHE_TTL_MS,
  PUBLIC_USAGE_ERROR,
  getGlobalUsage,
  mountTokenUsageGlobalRoute,
  localDateKey,
  windowStarts,
  _compute: computeGlobal,
  _resetCacheForTest,
};
