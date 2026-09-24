'use strict';

// Second evidence for a Stop candidate (status plan v4 §1.3). Each CLI writes a
// structured end-of-turn record into its own transcript, independently of the
// hook process — measured on Claude Code 2.1.280 and Codex CLI 0.156.1:
//
// - Claude: a `system/stop_hook_summary` entry is appended once every Stop hook
//   has settled; `preventedContinuation` tells whether a hook blocked the stop
//   (the turn continues). A user entry "[Request interrupted by user" marks an
//   interrupt, which fires no hook at all.
// - Codex: the rollout gets `event_msg/task_complete` (or `turn_aborted`)
//   carrying the same turn_id the hooks carry.
//
// Verdicts: 'confirmed' | 'continued' | 'interrupted' | 'pending'. Anything
// unreadable is 'pending' — the ledger then keeps P instead of guessing.

const TAIL_BYTES = 256 * 1024;

function readTailLines(fs, file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();  // first line is probably cut
    return lines.filter(Boolean);
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function parse(line) {
  try { return JSON.parse(line); } catch (_) { return null; }
}

function isTypedUserPrompt(entry) {
  if (!entry || entry.type !== 'user' || entry.isSidechain || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some(c => c && c.type === 'text');
}

function userText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
}

// Scan backwards until the prompt that opened this turn; only records after it
// can describe how the turn ended.
function claudeVerdict(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const e = parse(lines[i]);
    if (!e) continue;
    if (e.type === 'system' && e.subtype === 'stop_hook_summary' && !e.isSidechain) {
      return e.preventedContinuation === true ? 'continued' : 'confirmed';
    }
    if (isTypedUserPrompt(e)) {
      return /^\[Request interrupted by user/.test(userText(e).trim()) ? 'interrupted' : 'pending';
    }
  }
  return 'pending';
}

function codexVerdict(lines, turnId) {
  if (!turnId) return 'pending';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const e = parse(lines[i]);
    const p = e && e.type === 'event_msg' ? e.payload : null;
    if (!p || p.turn_id !== turnId) continue;
    if (p.type === 'task_complete') return 'confirmed';
    if (p.type === 'turn_aborted') return 'interrupted';
    if (p.type === 'task_started') return 'pending';
  }
  return 'pending';
}

function createTurnEndEvidence({ fs } = {}) {
  if (!fs || typeof fs.openSync !== 'function') throw new TypeError('[turn-evidence] fs is required');
  return async function confirmTurnEnd({ cli, turnId, transcriptPath }) {
    if (!transcriptPath) return 'pending';
    const lines = readTailLines(fs, transcriptPath);
    if (!lines) return 'pending';
    if (cli === 'claude') return claudeVerdict(lines);
    if (cli === 'codex') return codexVerdict(lines, turnId);
    return 'pending';
  };
}

module.exports = { createTurnEndEvidence, claudeVerdict, codexVerdict, readTailLines };
