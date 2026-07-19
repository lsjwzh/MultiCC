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

// Bucket one record into every window it belongs to, plus the per-day trend.
function record(windows, byDay, W, dk, model, i, o, cw, cr) {
  addInto(windows.all, model, i, o, cw, cr);
  // Week and month are independent windows: a Monday-start week can cross a
  // month boundary.  Future-dated records remain visible in all/byDay for
  // diagnostics but must not leak into current rolling windows.
  if (dk >= W.month && dk <= W.today) addInto(windows.month, model, i, o, cw, cr);
  if (dk >= W.week && dk <= W.today) addInto(windows.week, model, i, o, cw, cr);
  if (dk === W.today) addInto(windows.today, model, i, o, cw, cr);
  const day = byDay[dk] || (byDay[dk] = {});
  day[model] = (day[model] || 0) + i + o + cw + cr;
}

// Codex (the codex CLI) keeps its own transcripts under ~/.codex/sessions as a
// rollout event stream. Token usage arrives as `event_msg`/`token_count` events
// whose `info.total_token_usage` is CUMULATIVE per session. We diff cumulative
// high-water marks (so repeats, stale events, and resets cannot double-count)
// and bucket each safe delta by its own timestamp's day. Codex's
// cached_input_tokens is a subset of input_tokens, so fresh = input - cached and
// cached maps to our cacheRead bucket; codex has no separate cache-write notion.
function codexUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
  if (!fields.every((key) => Object.prototype.hasOwnProperty.call(value, key)
    && Number.isFinite(value[key]) && value[key] >= 0)) return null;
  return {
    input: value.input_tokens,
    cached: value.cached_input_tokens,
    output: value.output_tokens,
  };
}

function exclusiveCodexUsage(value) {
  const usage = codexUsage(value);
  if (!usage || usage.cached > usage.input) return null;
  return {
    fresh: usage.input - usage.cached,
    cached: usage.cached,
    output: usage.output,
  };
}

// A spawned Codex subagent starts its rollout with the parent's cumulative
// token counters.  That inherited total is a baseline, not work performed by
// the child.  Recent Codex versions expose several equivalent, explicit
// metadata markers; keep the test deliberately structural so paths, prompts,
// or other transcript content never participate in accounting.
function isDerivedCodexRollout(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return Boolean(
    meta.forked_from_id
    || meta.parent_thread_id
    || meta.thread_source === 'subagent'
    || meta.source === 'subagent'
    || (Array.isArray(meta.source) && meta.source.includes('subagent'))
    || (meta.source && typeof meta.source === 'object' && meta.source.subagent)
  );
}

function findCodexRolloutMeta(text) {
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"session_meta"') === -1) continue;
    try {
      const value = JSON.parse(line);
      if (value.type === 'session_meta') return value.payload || {};
    } catch (_) {}
  }
  return {};
}

function completeCodexLastUsage(info, total) {
  const value = info && info.last_token_usage;
  if (!value || typeof value !== 'object') return null;
  const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
  if (!fields.every((key) => Object.prototype.hasOwnProperty.call(value, key)
    && Number.isFinite(value[key]) && value[key] >= 0)) return null;
  const last = exclusiveCodexUsage(value);
  if (!last) return null;
  if (last.fresh > total.fresh || last.cached > total.cached || last.output > total.output) return null;
  return last;
}

function recordCodexUsage(windows, byDay, W, timestamp, model, usage) {
  if (usage.fresh + usage.output + usage.cached <= 0) return 0;
  const at = new Date(timestamp);
  if (!Number.isFinite(at.getTime())) return 0;
  record(windows, byDay, W, localDateKey(at), model, usage.fresh, usage.output, 0, usage.cached);
  return usage.output > 0 ? 1 : 0;
}

function scanCodexRollout(text, windows, byDay, W) {
  const derived = isDerivedCodexRollout(findCodexRolloutMeta(text));
  let model = 'codex';
  let highWater = null;              // accepted cumulative { fresh, cached, output }
  let responses = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.indexOf('"token_count"') === -1 && line.indexOf('"model"') === -1) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (p.model) model = p.model;
    if (!(d.type === 'event_msg' && p.type === 'token_count')) continue;
    const info = p.info || {};
    const cur = exclusiveCodexUsage(info.total_token_usage);
    if (!cur) continue;
    const timestamp = new Date(d.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;

    if (!highWater) {
      // Main rollouts originate at zero, so their first cumulative snapshot is
      // real usage.  A derived rollout inherits its parent's counters: only
      // Codex's complete per-request `last_token_usage` is safe to attribute.
      const initial = derived ? completeCodexLastUsage(info, cur) : cur;
      if (initial) responses += recordCodexUsage(windows, byDay, W, d.timestamp, model, initial);
      highWater = { ...cur };
      continue;
    }

    // Fresh input, cached input, and output are mutually exclusive cumulative
    // buckets.  Accept the snapshot only when the entire vector is monotonic.
    // Advancing one bucket while another regresses can merely reclassify the
    // same tokens (fresh -> cached); counting that partial rise would double
    // charge. A reset therefore fails closed without moving the baseline.
    if (cur.fresh < highWater.fresh
      || cur.cached < highWater.cached
      || cur.output < highWater.output) continue;
    const delta = {
      fresh: cur.fresh - highWater.fresh,
      cached: cur.cached - highWater.cached,
      output: cur.output - highWater.output,
    };
    highWater = { ...cur };
    responses += recordCodexUsage(windows, byDay, W, d.timestamp, model, delta);
  }

  return responses;
}

async function addCodexInto(windows, byDay, W, codexDir = CODEX_DIR) {
  const files = await listJsonl(codexDir);
  let responses = 0;
  for (const fp of files) {
    let text;
    try { text = await fsp.readFile(fp, 'utf8'); } catch { continue; }
    responses += scanCodexRollout(text, windows, byDay, W);
  }
  return { files: files.length, responses };
}

async function compute({ projectsDir = PROJECTS_DIR, codexDir = CODEX_DIR, now = new Date() } = {}) {
  const files = await listJsonl(projectsDir);
  const W = windowStarts(now);
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
      const u = m.usage;
      const i = u.input_tokens || 0;
      const o = u.output_tokens || 0;
      const cw = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      if (i + o + cw + cr === 0) continue;   // skip <synthetic>/no-op records
      if (seen.has(key)) continue;   // same non-empty API response already counted
      seen.add(key);
      responses++;
      const model = m.model || 'unknown';
      record(windows, byDay, W, localDateKey(new Date(ts)), model, i, o, cw, cr);
    }
  }

  const codex = await addCodexInto(windows, byDay, W, codexDir);

  return {
    generatedAt: new Date().toISOString(),
    sources: { claude: projectsDir, codex: codexDir },
    scannedFiles: files.length + codex.files,
    responses: responses + codex.responses,
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

module.exports = {
  getGlobalUsage,
  _compute: compute,
  _scanCodexRollout: scanCodexRollout,
  _isDerivedCodexRollout: isDerivedCodexRollout,
};
