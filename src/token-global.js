// Global Claude Code token usage, read straight from the canonical source:
// the claude CLI's own session transcripts under ~/.claude/projects/**/*.jsonl.
//
// This is independent of multicc's per-provider accounting (token_daily.json /
// token_usage.json), which only sees turns multicc itself spawned + closed and
// can miss usage during downtime/crashes. The transcripts are the ground truth:
// every assistant message carries a `usage` block. Rust dedupes by
// requestId+msgId and aggregates by model across today / week / month / all
// windows, plus a per-day trend.
//
// Tokens are reported as four distinct buckets — input / output / cacheWrite
// (cache_creation) / cacheRead — never silently merged, so the UI can decide
// whether to show "fresh" (input+output) or "consumed" (all four). Cache reads
// dwarf everything on cache-heavy turns and are near-free, so conflating them
// would be misleading.
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CACHE_TTL_MS = 120 * 1000;

let cache = null;          // { generatedAt, data }
let inFlight = null;       // shared promise so concurrent requests scan once

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
async function compute({ projectsDir = PROJECTS_DIR, codexDir = CODEX_DIR, now = new Date(), telemetry = null } = {}, addon) {
  const native = require('./native/runtime');
  const input = JSON.stringify({
    claudeFiles: await listJsonl(projectsDir),
    codexFiles: (await listJsonl(codexDir)).sort(),
    windows: windowStarts(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const result = await native.runNative(() => addon.computeUsage(input));
  const data = JSON.parse(result.result);
  if (telemetry) telemetry.nativeMs = result.computeMs;
  native.record('usage');
  return { generatedAt: new Date().toISOString(), sources: { claude: projectsDir, codex: codexDir }, ...data };
}
async function computeGlobal(options = {}) {
  return compute(options, require('./native/runtime').getNative());
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

module.exports = {
  getGlobalUsage,
  _compute: computeGlobal,
};
