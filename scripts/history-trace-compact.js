#!/usr/bin/env node
'use strict';
// Offline maintenance: downgrade the legacy full `contextTrace` objects that are
// still embedded in chat history messages to the summary shape the runtime
// writes today.
//
// Why this exists. `contextTraceFor` (src/chat/turn-engine.js) asks for
// `{ summary: true }`, and the summary branch in src/task-shell/runtime.js
// returns only { version, traceId, currentTask, managedOnly, summary, count,
// budget, contextStatus } -- about 304 bytes on real data. Messages written
// before that landed carry the full object instead (measured mean ~187KB per
// message), and those bytes dominate chat_history: on this machine they are
// over nine tenths of every oversized session file. They are also the reason a
// cold read of a large session explodes in Node: the whole file is parsed into
// an object graph before anything is projected.
//
// Why downgrading is not data loss in the usual sense. The panel never reads
// the embedded detail as the source of truth: public/chat-usage-readout.js
// normalizes both shapes and, for a summary, fetches the detail on demand from
// GET /api/sessions/:sessionId/context. What a downgrade costs is the fallback
// copy for receipts whose detail is already gone -- the panel then shows its
// existing `detailExpired` state for those old turns. Nothing in the
// conversation itself (role, content, ts, tools, usage, task fields) is
// touched: this tool rewrites only the contextTrace span of a line and leaves
// every other byte of that line exactly as it was.
//
// Default mode is a dry run. `--apply` additionally requires that the service
// is stopped, because the Rust history layer keeps an in-process cache plus a
// committed-bytes ledger for tail appends; rewriting files under a live server
// would make that ledger disagree with the disk.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const KEY = '"contextTrace":';

// Scan one JSON value starting at `start` and return the index just past it.
// Needed because we splice a single span out of a line instead of reparsing and
// reserializing the whole message, which would risk changing unrelated bytes
// (number formatting, escape choices) in history that is meant to be verbatim.
function scanJsonValue(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length) throw new Error('unexpected end of line while scanning a value');
  const first = text[i];
  if (first === '"') return scanJsonString(text, i);
  if (first === '{' || first === '[') return scanJsonContainer(text, i);
  // Primitive: run to the next structural character.
  let j = i;
  while (j < text.length && !',}]'.includes(text[j])) j += 1;
  if (j === i) throw new Error(`empty primitive at ${i}`);
  return j;
}

function scanJsonString(text, start) {
  if (text[start] !== '"') throw new Error(`expected a string at ${start}`);
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') return i + 1;
    i += 1;
  }
  throw new Error('unterminated string');
}

function scanJsonContainer(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') { i = scanJsonString(text, i); continue; }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  throw new Error(`unterminated ${open === '{' ? 'object' : 'array'}`);
}

// Build the summary shape, keeping the key order the runtime emits so the
// rewritten lines are indistinguishable from freshly written ones.
function summarizeTrace(trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;
  if (trace.summary === true) return null;
  if (!trace.traceId || !trace.currentTask) return null;
  const sources = Array.isArray(trace.sources) ? trace.sources.length : 0;
  const summary = {
    version: Number.isFinite(trace.version) ? trace.version : 1,
    traceId: trace.traceId,
    currentTask: trace.currentTask,
    managedOnly: true,
    summary: true,
    count: 1 + sources,
  };
  if (trace.budget !== undefined) summary.budget = trace.budget;
  if (trace.contextStatus !== undefined) summary.contextStatus = trace.contextStatus;
  return summary;
}

// Locate the *top-level* contextTrace member and return the span of its value.
// A plain indexOf is wrong: a message whose content discusses this very field
// contains the literal `"contextTrace":` inside a string, and splicing there
// would corrupt the text. Real history hit exactly that case, so the key is
// found by walking the object's members instead of searching the raw bytes.
function findTopLevelTrace(line) {
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  if (line[i] !== '{') return -1;
  i += 1;
  while (i < line.length) {
    while (i < line.length && /[\s,]/.test(line[i])) i += 1;
    if (line[i] === '}') return -1;
    if (line[i] !== '"') return -1;
    const keyEnd = scanJsonString(line, i);
    const key = JSON.parse(line.slice(i, keyEnd));
    let j = keyEnd;
    while (j < line.length && /\s/.test(line[j])) j += 1;
    if (line[j] !== ':') return -1;
    j += 1;
    const valueEnd = scanJsonValue(line, j);
    if (key === 'contextTrace') return j;
    i = valueEnd;
  }
  return -1;
}

// Returns null when the line needs no change, else { line, before, after }.
function rewriteLine(line) {
  if (!line.includes(KEY)) return null;
  const valueStart = findTopLevelTrace(line);
  if (valueStart < 0) return null;
  const valueEnd = scanJsonValue(line, valueStart);
  const raw = line.slice(valueStart, valueEnd);
  let trace;
  try { trace = JSON.parse(raw); } catch (error) {
    throw new Error(`contextTrace is not valid JSON: ${error.message}`);
  }
  const summary = summarizeTrace(trace);
  if (!summary) return null;
  const encoded = JSON.stringify(summary);
  const before = Buffer.byteLength(raw, 'utf8');
  const after = Buffer.byteLength(encoded, 'utf8');
  if (after >= before) return null;
  return { line: line.slice(0, valueStart) + encoded + line.slice(valueEnd), before, after };
}

// A line is only rewritten when the conversation-bearing fields survive it
// byte-for-byte. This is the safety net that makes --apply defensible.
const GUARDED = ['role', 'content', 'ts', 'id', 'tools', 'usage', 'taskId', 'turnId'];

function guardedEqual(original, rewritten) {
  let a;
  let b;
  try { a = JSON.parse(original); b = JSON.parse(rewritten); } catch (error) { return false; }
  for (const key of GUARDED) {
    const left = key in a ? JSON.stringify(a[key]) : null;
    const right = key in b ? JSON.stringify(b[key]) : null;
    if (left !== right) return false;
  }
  return b.contextTrace && b.contextTrace.summary === true;
}

async function planFile(file) {
  const plan = { file, lines: 0, changed: 0, before: 0, after: 0, errors: [] };
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    plan.lines += 1;
    if (!line) continue;
    let result;
    try { result = rewriteLine(line); } catch (error) {
      plan.errors.push(`line ${plan.lines}: ${error.message}`);
      continue;
    }
    if (!result) continue;
    if (!guardedEqual(line, result.line)) {
      plan.errors.push(`line ${plan.lines}: guarded fields would change; skipped`);
      continue;
    }
    plan.changed += 1;
    plan.before += result.before;
    plan.after += result.after;
  }
  return plan;
}

// Rewrite via a temp file in the same directory + rename, mirroring
// write_atomic in native/addon/src/chat_history_repository.rs (0600, same dir so
// the rename stays on one filesystem). The mtime is deliberately allowed to
// change: the search index keys recovery off file size and a content prefix, so
// letting it see a real change is what makes it re-sync that session.
async function applyFile(file, backupDir) {
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.compact-${process.pid}`);
  const out = fs.createWriteStream(temp, { encoding: 'utf8', mode: 0o600 });
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  const stats = { lines: 0, changed: 0, before: 0, after: 0 };
  try {
    for await (const line of rl) {
      stats.lines += 1;
      let emit = line;
      if (line) {
        let result = null;
        try { result = rewriteLine(line); } catch (error) { result = null; }
        if (result && guardedEqual(line, result.line)) {
          emit = result.line;
          stats.changed += 1;
          stats.before += result.before;
          stats.after += result.after;
        }
      }
      if (!out.write(`${emit}\n`)) await new Promise(resolve => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { out.end(err => (err ? reject(err) : resolve())); });
  } catch (error) {
    out.destroy();
    fs.rmSync(temp, { force: true });
    throw error;
  }
  // Verify the rewritten file parses line by line before it replaces anything.
  const check = readline.createInterface({
    input: fs.createReadStream(temp, { encoding: 'utf8', highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  let verified = 0;
  for await (const line of check) {
    if (!line) continue;
    try { JSON.parse(line); verified += 1; } catch (error) {
      fs.rmSync(temp, { force: true });
      throw new Error(`verification failed at line ${verified + 1}: ${error.message}`);
    }
  }
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  return stats;
}

// `lsof` on a state file the server always holds open is a precise liveness
// probe; matching on "node server.js" would also flag unrelated worktrees.
function serviceHolders(dataRoot) {
  const held = [];
  for (const name of ['sessions.json', 'task-deliveries.sqlite', 'search-index.sqlite']) {
    const target = path.join(dataRoot, name);
    if (!fs.existsSync(target)) continue;
    try {
      const out = execFileSync('lsof', ['-t', '--', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const pid of out.split('\n').map(s => s.trim()).filter(Boolean)) held.push(`${name}:${pid}`);
    } catch (error) { /* lsof exits non-zero when nobody holds the file */ }
  }
  return held;
}

function parseArgs(argv) {
  const args = { apply: false, force: false, dir: '', backupDir: '', limit: 0, minBytes: 4096 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--dir') args.dir = argv[++i] || '';
    else if (arg === '--backup-dir') args.backupDir = argv[++i] || '';
    else if (arg === '--limit') args.limit = Number(argv[++i]) || 0;
    else if (arg === '--min-bytes') args.minBytes = Number(argv[++i]) || 0;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const MB = n => `${(n / 1048576).toFixed(1)}MB`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/history-trace-compact.js [--dir <chat_history>] [--apply] [--backup-dir <dir>]
                                        [--limit <n>] [--min-bytes <n>] [--force]

Downgrades legacy full contextTrace objects in chat history to the summary shape
the runtime writes today. Dry run unless --apply is given. --apply refuses to run
while the service holds the data root open; --backup-dir is strongly recommended.`);
    return;
  }
  const dir = args.dir || path.join(process.cwd(), 'chat_history');
  if (!fs.existsSync(dir)) throw new Error(`no chat history directory at ${dir}`);
  const dataRoot = path.dirname(dir);
  if (args.apply) {
    const holders = serviceHolders(dataRoot);
    if (holders.length && !args.force) {
      throw new Error(`the service appears to be running (${holders.join(', ')}). `
        + 'Stop it before --apply, or pass --force if you are certain it is safe.');
    }
    if (!args.backupDir && !args.force) {
      throw new Error('--apply needs --backup-dir (or --force to skip backups)');
    }
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => ({ f, p: path.join(dir, f), n: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.n - a.n);
  const selected = args.limit ? files.slice(0, args.limit) : files;
  console.log(`${args.apply ? 'APPLY' : 'DRY RUN'}: ${selected.length} of ${files.length} files in ${dir}`);
  let totalBefore = 0;
  let totalAfter = 0;
  let totalChanged = 0;
  let touched = 0;
  const errors = [];
  for (const { f, p, n } of selected) {
    const plan = await planFile(p);
    if (plan.errors.length) errors.push(...plan.errors.map(e => `${f}: ${e}`));
    if (!plan.changed) continue;
    const saved = plan.before - plan.after;
    if (saved < args.minBytes) continue;
    touched += 1;
    totalChanged += plan.changed;
    totalBefore += plan.before;
    totalAfter += plan.after;
    console.log(`  ${f.padEnd(46)} ${MB(n).padStart(8)} -> reclaim ${MB(saved).padStart(8)}`
      + ` (${(100 * saved / n).toFixed(0)}% of file) in ${plan.changed} msgs`);
    if (args.apply) {
      const done = await applyFile(p, args.backupDir);
      console.log(`      applied: ${done.changed} msgs rewritten, file now ${MB(fs.statSync(p).size)}`);
    }
  }
  const saved = totalBefore - totalAfter;
  console.log(`--- ${touched} files, ${totalChanged} messages, reclaimable ${MB(saved)}`);
  if (errors.length) {
    console.log(`--- ${errors.length} skipped lines (first 10):`);
    for (const line of errors.slice(0, 10)) console.log(`    ${line}`);
  }
  if (!args.apply && saved > 0) {
    console.log('Re-run with --apply --backup-dir <dir> once the service is stopped to reclaim this.');
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { scanJsonValue, findTopLevelTrace, summarizeTrace, rewriteLine, guardedEqual, planFile, applyFile, serviceHolders, parseArgs };
