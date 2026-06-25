// Global Claude Code token usage, read straight from the canonical source:
// the claude CLI's own session transcripts under ~/.claude/projects/**/*.jsonl.
//
// This is independent of multicc's per-provider accounting (token_daily.json /
// token_usage.json), which only sees turns multicc itself spawned + closed and
// can miss usage during downtime/crashes. The transcripts are the ground truth:
// every assistant message carries a `usage` block. We dedupe by requestId+msgId
// (the CLI re-writes the same response across resume/summary), then aggregate by
// model across today / week / month / all windows, plus a per-day trend.
//
// Tokens are reported as four distinct buckets — input / output / cacheWrite
// (cache_creation) / cacheRead — never silently merged, so the UI can decide
// whether to show "fresh" (input+output) or "consumed" (all four). Cache reads
// dwarf everything on cache-heavy turns and are near-free, so conflating them
// would be misleading.
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CACHE_TTL_MS = 120 * 1000;

let cache = null;          // { generatedAt, data }
let inFlight = null;       // shared promise so concurrent requests scan once

function localDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Window boundaries (local time): today / Monday-week / month-1st.
function windowStarts() {
  const now = new Date();
  const today = localDateKey(now);
  const wk = new Date(now);
  wk.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // back to Monday
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return { today, week: localDateKey(wk), month: localDateKey(monthStart) };
}

function emptyBucket() {
  return { inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 };
}
function addInto(target, model, i, o, cw, cr) {
  const b = target[model] || (target[model] = emptyBucket());
  b.inputTokens += i; b.outputTokens += o; b.cacheWrite += cw; b.cacheRead += cr; b.msgs += 1;
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

async function compute() {
  const files = await listJsonl(PROJECTS_DIR);
  const W = windowStarts();
  const seen = new Set();
  const windows = { today: {}, week: {}, month: {}, all: {} };
  const byDay = {};                  // dateKey -> { model -> total }
  let responses = 0;

  for (const fp of files) {
    let text;
    try { text = await fsp.readFile(fp, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const ts = d.timestamp;
      const m = d.message;
      if (!ts || !m || !m.usage) continue;
      const rid = d.requestId || '';
      const mid = m.id || d.uuid || '';
      const key = rid + ':' + mid;
      if (seen.has(key)) continue;   // same API response already counted
      seen.add(key);
      responses++;

      const u = m.usage;
      const i = u.input_tokens || 0;
      const o = u.output_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      if (i + o + cw + cr === 0) continue;   // skip <synthetic>/no-op records
      const model = m.model || 'unknown';
      const dk = localDateKey(new Date(ts));

      addInto(windows.all, model, i, o, cw, cr);
      if (dk >= W.month) {
        addInto(windows.month, model, i, o, cw, cr);
        if (dk >= W.week) addInto(windows.week, model, i, o, cw, cr);
      }
      if (dk === W.today) addInto(windows.today, model, i, o, cw, cr);

      const day = byDay[dk] || (byDay[dk] = {});
      day[model] = (day[model] || 0) + i + o + cw + cr;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: PROJECTS_DIR,
    scannedFiles: files.length,
    responses,
    windows,
    byDay,   // { 'YYYY-MM-DD': { model: totalTokens } }
  };
}

// Cached accessor. Re-scans at most once per TTL; concurrent callers share the
// same in-flight scan. `force` bypasses the cache (UI "refresh" button).
async function getGlobalUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && (now - cache.at) < CACHE_TTL_MS) return cache.data;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await compute();
      cache = { at: Date.now(), data };
      return data;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

module.exports = { getGlobalUsage, _compute: compute };
