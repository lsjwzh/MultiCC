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
// A forked Codex rollout is initialized by serializing the parent's event
// history into the child file. Those inherited token_count rows are emitted in
// one compressed prefix (normally a few milliseconds), while a real model
// response takes seconds. Keep this deliberately narrow: only a derived file,
// only its initial prefix, only when at least two token snapshots are adjacent.
const CODEX_FORK_REPLAY_GAP_MS = 100;
const CODEX_FORK_REPLAY_START_MS = 100;

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
function record(windows, byDay, byDayFresh, W, dk, model, i, o, cw, cr) {
  addInto(windows.all, model, i, o, cw, cr);
  // Week and month are independent windows: a Monday-start week can cross a
  // month boundary.  Future-dated records remain visible in all/byDay for
  // diagnostics but must not leak into current rolling windows.
  if (dk >= W.month && dk <= W.today) addInto(windows.month, model, i, o, cw, cr);
  if (dk >= W.week && dk <= W.today) addInto(windows.week, model, i, o, cw, cr);
  if (dk === W.today) addInto(windows.today, model, i, o, cw, cr);
  const day = byDay[dk] || (byDay[dk] = {});
  day[model] = (day[model] || 0) + i + o + cw + cr;
  const freshDay = byDayFresh[dk] || (byDayFresh[dk] = {});
  freshDay[model] = (freshDay[model] || 0) + i + o;
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

function recordCodexUsage(windows, byDay, byDayFresh, W, timestamp, model, usage) {
  if (usage.fresh + usage.output + usage.cached <= 0) return 0;
  const at = new Date(timestamp);
  if (!Number.isFinite(at.getTime())) return 0;
  record(
    windows, byDay, byDayFresh, W, localDateKey(at), model,
    usage.fresh, usage.output, 0, usage.cached,
  );
  return usage.output > 0 ? 1 : 0;
}

function parseCodexRollout(text, sourceOrder = 0) {
  let meta = {};
  let hasMeta = false;
  let metaTimestamp = NaN;
  let model = 'codex';
  const events = [];
  let eventOrder = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.indexOf('"session_meta"') === -1
        && line.indexOf('"token_count"') === -1
        && line.indexOf('"model"') === -1) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      // A derived rollout can embed its parent's session_meta immediately
      // after the child's own envelope. The first record owns this file; using
      // the last one would collapse independent child agents into the parent.
      if (!hasMeta) {
        meta = p && typeof p === 'object' ? p : {};
        metaTimestamp = new Date(d.timestamp).getTime();
        hasMeta = true;
      }
      continue;
    }
    if (p.model) model = p.model;
    if (!(d.type === 'event_msg' && p.type === 'token_count')) continue;
    const info = p.info || {};
    const current = exclusiveCodexUsage(info.total_token_usage);
    const timestamp = new Date(d.timestamp).getTime();
    if (!current || !Number.isFinite(timestamp)) continue;
    events.push({
      timestamp: d.timestamp,
      timestampMs: timestamp,
      model,
      current,
      last: completeCodexLastUsage(info, current),
      sourceOrder,
      eventOrder: eventOrder++,
    });
  }
  return Object.freeze({
    meta,
    derived: isDerivedCodexRollout(meta),
    metaTimestamp,
    events,
    sourceOrder,
  });
}

function codexForkReplayPrefixLength(fragment) {
  if (!fragment.derived || fragment.events.length < 2
      || !Number.isFinite(fragment.metaTimestamp)) return 0;
  const first = fragment.events[0];
  if (first.timestampMs < fragment.metaTimestamp
      || first.timestampMs - fragment.metaTimestamp > CODEX_FORK_REPLAY_START_MS) return 0;
  let length = 1;
  while (length < fragment.events.length) {
    const previous = fragment.events[length - 1].timestampMs;
    const current = fragment.events[length].timestampMs;
    if (current < previous || current - previous > CODEX_FORK_REPLAY_GAP_MS) break;
    length += 1;
  }
  return length >= 2 ? length : 0;
}

function scanCodexFragments(fragments, windows, byDay, byDayFresh, W) {
  const ordered = [...fragments].sort((left, right) => left.sourceOrder - right.sourceOrder);
  const derived = ordered.some(fragment => fragment.derived);
  let highWater = null;              // accepted cumulative { fresh, cached, output }
  let responses = 0;

  for (const fragment of ordered) {
    const replayPrefixLength = codexForkReplayPrefixLength(fragment);
    for (let index = 0; index < fragment.events.length; index += 1) {
      const event = fragment.events[index];
      const replayed = index < replayPrefixLength;
      const cur = event.current;

      if (!highWater) {
        // Main rollouts originate at zero, so their first cumulative snapshot
        // is real usage. A derived rollout inherits its parent's counters:
        // only Codex's complete per-request last usage is safe to attribute.
        const initial = derived ? event.last : cur;
        if (initial && !replayed) {
          responses += recordCodexUsage(
            windows, byDay, byDayFresh, W, event.timestamp, event.model, initial,
          );
        }
        highWater = { ...cur };
        continue;
      }

      // Fresh input, cached input, and output are mutually exclusive
      // cumulative buckets. Accept only a monotonic vector. This high-water is
      // shared by every resume file for the same logical Codex thread.
      if (cur.fresh < highWater.fresh
        || cur.cached < highWater.cached
        || cur.output < highWater.output) continue;
      const delta = {
        fresh: cur.fresh - highWater.fresh,
        cached: cur.cached - highWater.cached,
        output: cur.output - highWater.output,
      };
      highWater = { ...cur };
      if (!replayed) {
        responses += recordCodexUsage(
          windows, byDay, byDayFresh, W, event.timestamp, event.model, delta,
        );
      }
    }
  }

  return responses;
}

function scanCodexRollout(text, windows, byDay, W, byDayFresh = {}) {
  return scanCodexFragments([parseCodexRollout(text)], windows, byDay, byDayFresh, W);
}

async function addCodexInto(windows, byDay, byDayFresh, W, codexDir = CODEX_DIR) {
  const files = (await listJsonl(codexDir)).sort();
  const groups = new Map();
  let sourceOrder = 0;
  for (const fp of files) {
    let text;
    try { text = await fsp.readFile(fp, 'utf8'); } catch { continue; }
    const fragment = parseCodexRollout(text, sourceOrder++);
    const meta = fragment.meta || {};
    const nativeThreadId = meta.id || meta.session_id || meta.thread_id;
    // A file without an explicit native thread identity cannot safely share a
    // high-water with any other file.
    const key = nativeThreadId ? `thread:${nativeThreadId}` : `file:${fp}`;
    const group = groups.get(key) || [];
    group.push(fragment);
    groups.set(key, group);
  }
  let responses = 0;
  for (const fragments of groups.values()) {
    responses += scanCodexFragments(fragments, windows, byDay, byDayFresh, W);
  }
  return { files: files.length, responses };
}

async function compute({ projectsDir = PROJECTS_DIR, codexDir = CODEX_DIR, now = new Date() } = {}) {
  const files = await listJsonl(projectsDir);
  const W = windowStarts(now);
  const seen = new Set();
  const windows = { today: {}, week: {}, month: {}, all: {} };
  const byDay = {};                  // dateKey -> { model -> total }
  const byDayFresh = {};             // dateKey -> { model -> input + output }
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
      record(windows, byDay, byDayFresh, W, localDateKey(new Date(ts)), model, i, o, cw, cr);
    }
  }

  const codex = await addCodexInto(windows, byDay, byDayFresh, W, codexDir);

  return {
    generatedAt: new Date().toISOString(),
    sources: { claude: projectsDir, codex: codexDir },
    scannedFiles: files.length + codex.files,
    responses: responses + codex.responses,
    windows,
    byDay,   // { 'YYYY-MM-DD': { model: totalTokens } }
    byDayFresh, // same shape, excluding cache read/write
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
