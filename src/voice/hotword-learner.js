'use strict';

// Keeps voice_hotwords.json — the hotword list MultiCC learns on its own — up
// to date (the mining rules are in hotword-miner.js):
//
//   * first start: every saved voice correction is replayed once, then the
//     chat history is scanned in the background;
//   * each new correction (POST /api/voice/feedback) is learned immediately;
//   * the chat history is rescanned once a day.
//
// The scan reads the user's own messages, and — with a much higher bar — the
// assistant's: a term the user never types but the model writes consistently
// (CLI, AutoCommit, APK) is still a word the recogniser keeps getting wrong.
// Model text is far noisier (code, paths, stock tickers), so it must recur
// across many sessions, and one-off tickers are filtered by rhythm rather than
// by a list: an all-caps token has to be seen in twice as many sessions.
//
// voice_examples.json only keeps the last 50 corrections, so pair counts live
// here and accumulate. The scan reads only the tail of each session file
// (chat_history is ~GBs of JSONL on a long-lived install) and yields between
// files so it never stalls the server.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson } = require('../runtime-security');
const miner = require('./hotword-miner');

const VERSION = 1;
const RESCAN_MS = 24 * 3600 * 1000;
const FIRST_SCAN_DELAY_MS = 60 * 1000;
const TAIL_BYTES = 512 * 1024;
const MAX_FILES = 300;
const MAX_MESSAGE_CHARS = 1500;
const KEPT_CHARS = 800;
const MAX_KEPT_TEXTS = 1000;
const MAX_SEEN = 500;

const exampleId = e => crypto.createHash('sha1').update(`${e.ts || ''}\u0000${e.raw || ''}\u0000${e.userFinal || ''}`).digest('hex').slice(0, 16);

function emptyState() {
  return { version: VERSION, updatedAt: null, scannedAt: null, seededExamples: false, seen: [], pairs: {}, typed: [], rejected: [] };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Session files are JSONL now; older ones are a single JSON array. Both are
// flattened to {role, content} so one scan can look at user and model text.
function messagesOf(text) {
  const out = [];
  const take = m => {
    if (m && typeof m.role === 'string' && typeof m.content === 'string') out.push({ role: m.role, content: m.content });
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[')) {
    try { const arr = JSON.parse(trimmed); if (Array.isArray(arr)) { arr.forEach(take); return out; } } catch (_) {}
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"role"')) continue;
    try { take(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

function userMessagesOf(text) {
  return messagesOf(text).filter(m => m.role === 'user').map(m => m.content);
}

async function readTail(file, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // A cut-off first line is dropped instead of misparsed.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    await fh.close();
  }
}

// Scheduled prompts, background-task notices and other machine-written "user"
// messages repeat verbatim; the user's own words do not.
function isMachineText(text) {
  return /^\s*(?:[【\[🔇<]|\{)/.test(text) || /^\s*(?:Background|Task |\[multicc)/i.test(text);
}

function createHotwordLearner({ file, examplesFile, chatHistoryDir, log = console, now = () => Date.now() } = {}) {
  if (!file) throw new TypeError('hotword learner requires a state file');
  let state = null;
  let cached = null;
  let keptTexts = [];
  let scanning = null;
  let timer = null;

  function load() {
    if (state) return state;
    const data = readJson(file);
    state = data && data.version === VERSION ? { ...emptyState(), ...data } : emptyState();
    keptTexts = Array.isArray(state.keptTexts) ? state.keptTexts : [];
    delete state.keptTexts;
    return state;
  }

  function save() {
    state.updatedAt = new Date(now()).toISOString();
    cached = null;
    try {
      atomicWriteJson(file, { ...state, keptTexts });
    } catch (e) {
      log.error('[multicc/hotwords] Failed to write', path.basename(file), e.message);
    }
  }

  function result() {
    load();
    if (!cached) cached = miner.buildHotwords(state, keptTexts);
    return cached;
  }

  function rememberKept(text) {
    if (typeof text !== 'string' || !text.trim()) return;
    const kept = text.slice(0, KEPT_CHARS);
    if (keptTexts.includes(kept)) return;
    keptTexts.push(kept);
    if (keptTexts.length > MAX_KEPT_TEXTS) keptTexts = keptTexts.slice(-MAX_KEPT_TEXTS);
  }

  // Returns true when the example was new.
  function absorb(example) {
    const id = exampleId(example);
    if (state.seen.includes(id)) return false;
    state.seen.push(id);
    if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);
    const at = example.ts || new Date(now()).toISOString();
    for (const { term, alias } of miner.minePairs(example.raw, example.userFinal)) {
      const key = miner.pairKey(term, alias || '');
      const p = state.pairs[key] || { term, ...(alias ? { alias } : {}), count: 0, firstSeen: at };
      p.count++;
      p.term = term;
      p.lastSeen = at;
      state.pairs[key] = p;
    }
    // What the user sent is text they stand behind; it vetoes aliases later.
    rememberKept(example.userFinal);
    return true;
  }

  function learnFromExample(example) {
    if (!example || !example.raw || !example.userFinal) return;
    load();
    if (absorb(example)) save();
  }

  function seedFromExamples() {
    load();
    if (state.seededExamples) return;
    const examples = examplesFile ? readJson(examplesFile) : null;
    if (Array.isArray(examples)) for (const e of examples) if (e && e.raw && e.userFinal) absorb(e);
    state.seededExamples = true;
    save();
  }

  async function scanChatHistory() {
    if (!chatHistoryDir) return;
    let names;
    try { names = await fs.promises.readdir(chatHistoryDir); } catch (_) { return; }
    const files = [];
    for (const name of names) {
      // __aux__ and other internal sessions talk to models, not to the user.
      if (!name.endsWith('.json') || name.startsWith('__')) continue;
      try { files.push({ name, mtime: (await fs.promises.stat(path.join(chatHistoryDir, name))).mtimeMs }); } catch (_) {}
    }
    files.sort((a, b) => b.mtime - a.mtime);

    const messages = [];
    const modelMessages = [];
    for (const { name } of files.slice(0, MAX_FILES)) {
      let text;
      try { text = await readTail(path.join(chatHistoryDir, name), TAIL_BYTES); } catch (_) { continue; }
      for (const { role, content } of messagesOf(text)) {
        if (content.length > MAX_MESSAGE_CHARS) continue;
        if (role === 'user') {
          if (isMachineText(content)) continue;
          messages.push({ session: name, text: content });
        } else if (role === 'assistant') {
          modelMessages.push({ session: name, text: content });
        }
      }
      await new Promise(r => setImmediate(r));
    }
    // A prompt that recurs verbatim is a template (cron jobs, task board), and
    // so is a canned reply. Drop those from both sides before mining.
    const own = dropTemplates(messages);
    const fromModel = dropTemplates(modelMessages);

    const typed = miner.rankTypedHotwords(own, fromModel);

    load();
    state.typed = typed;
    state.scannedAt = new Date(now()).toISOString();
    for (const m of own.slice(-MAX_KEPT_TEXTS)) rememberKept(m.text);
    save();
    log.log(`[multicc/hotwords] Scanned ${Math.min(files.length, MAX_FILES)} sessions: ${typed.length} typed terms (${typed.filter(t => t.source === 'assistant').length} from model replies), ${result().active.length} active hotwords`);
  }

  function dropTemplates(list) {
    const counts = new Map();
    for (const m of list) {
      const prefix = m.text.slice(0, 24);
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
    return list.filter(m => counts.get(m.text.slice(0, 24)) < 3);
  }

  function refresh() {
    if (!scanning) {
      scanning = scanChatHistory()
        .catch(e => log.error('[multicc/hotwords] Chat history scan failed:', e.message))
        .finally(() => { scanning = null; });
    }
    return scanning;
  }

  function start() {
    try { seedFromExamples(); } catch (e) { log.error('[multicc/hotwords] Seeding failed:', e.message); }
    const last = Date.parse(load().scannedAt || '') || 0;
    const due = Math.max(FIRST_SCAN_DELAY_MS, last + RESCAN_MS - now());
    const schedule = delay => {
      timer = setTimeout(() => { refresh().finally(() => schedule(RESCAN_MS)); }, delay);
      if (timer.unref) timer.unref();
    };
    schedule(due);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // The user can veto any learned entry; it then stays out for good.
  function reject({ term, alias } = {}) {
    if (typeof term !== 'string' || !term.trim()) return false;
    load();
    const key = miner.pairKey(term.trim(), typeof alias === 'string' ? alias.trim() : '');
    if (!state.rejected.includes(key)) state.rejected.push(key);
    save();
    return true;
  }

  function snapshot() {
    const r = result();
    return {
      list: r.list,
      active: r.active,
      pending: r.pending.map(({ term, alias, count }) => ({ term, alias, count })),
      vetoed: r.vetoed.map(({ term, alias, count }) => ({ term, alias, count })),
      typed: state.typed,
      updatedAt: state.updatedAt,
      scannedAt: state.scannedAt,
    };
  }

  return {
    list: () => result().list,
    learnFromExample,
    seedFromExamples,
    refresh,
    start,
    stop,
    reject,
    snapshot,
  };
}

module.exports = { createHotwordLearner, messagesOf, userMessagesOf, isMachineText };
