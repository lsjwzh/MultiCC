'use strict';

// Auto-prune a Claude Code transcript JSONL before --resume would exceed the
// model's context window. multicc's display history (dataDir/chatHistory/*.json)
// and token accounting (API result-event usage) are independent of this file,
// so truncating it only shrinks claude's context — no data loss in multicc.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Threshold: if the JSONL exceeds this many bytes, prune before resume.
// ~3 MB of JSONL ≈ 200K+ tokens (rough: 1 token ≈ 4 chars, JSON overhead).
// Keeping under this avoids context_length_exceeded on 200K-window models.
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const DEFAULT_KEEP_TURNS = 10;

function claudeProjectDir(cwd) {
  // Claude Code stores transcripts under ~/.claude/projects/<cwd-with-slashes-as-dashes>/
  const slashed = String(cwd || '').replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slashed);
}

function findTranscriptFile(cwd, cliSessionId) {
  const dir = claudeProjectDir(cwd);
  if (!fs.existsSync(dir)) return null;
  // Prefer an exact match on cliSessionId; fall back to the largest JSONL.
  if (cliSessionId) {
    const exact = path.join(dir, `${cliSessionId}.jsonl`);
    if (fs.existsSync(exact)) return exact;
  }
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(dir, name);
      const sz = fs.statSync(p).size;
      if (!best || sz > best.size) best = { path: p, size: sz };
    }
  } catch (_) {}
  return best ? best.path : null;
}

function isUserTurnStart(line) {
  try {
    const obj = JSON.parse(line);
    return obj.type === 'user' || (obj.message && obj.message.role === 'user');
  } catch { return false; }
}

/**
 * If the transcript JSONL for (cwd, cliSessionId) exceeds maxBytes, truncate it
 * to the last `keepTurns` user-turn segments. Returns info about what happened
 * (or null if no pruning was needed / file not found).
 */
function maybePrune(cwd, cliSessionId, { maxBytes = DEFAULT_MAX_BYTES, keepTurns = DEFAULT_KEEP_TURNS } = {}) {
  const file = findTranscriptFile(cwd, cliSessionId);
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }
  if (stat.size <= maxBytes) return null; // under threshold, no prune needed

  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  // Find the start of the Nth-to-last user turn.
  const userTurnStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (isUserTurnStart(lines[i])) userTurnStarts.push(i);
  }
  const cutIndex = userTurnStarts[Math.max(0, userTurnStarts.length - keepTurns)] || 0;
  if (cutIndex === 0) return null; // already small enough (fewer turns than keepTurns)

  const kept = lines.slice(cutIndex);

  // Move pruned lines to <sessionId>.pruned.jsonl (append) so token-global
  // still reads their usage via listJsonl(*.jsonl), while claude --resume
  // only loads the trimmed <sessionId>.jsonl. This preserves token stats.
  const prunedFile = file.replace(/\.jsonl$/, '.pruned.jsonl');
  try { fs.appendFileSync(prunedFile, lines.slice(0, cutIndex).join('\n') + '\n'); } catch (_) {}
  fs.writeFileSync(file, kept.join('\n') + '\n');

  const droppedLines = cutIndex;
  const beforeMB = (stat.size / 1024 / 1024).toFixed(2);
  const afterMB = (Buffer.byteLength(kept.join('\n') + '\n') / 1024 / 1024).toFixed(2);
  const msg = `[multicc/transcript] pruned ${path.basename(file)}: ${beforeMB}MB→${afterMB}MB (dropped ${droppedLines} lines, kept last ${keepTurns} turns)`;
  console.log(msg);
  return { file, droppedLines, beforeMB, afterMB };
}

module.exports = { maybePrune, findTranscriptFile, claudeProjectDir };
