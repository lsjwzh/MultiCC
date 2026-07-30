'use strict';

// ── Claude transcript governor ──
//
// Every multicc chat session runs `claude -p` against a transcript JSONL under
// ~/.claude/projects/<cwd-slashed>/<session-id>.jsonl, and `--resume` replays it.
// The file is append-only for the life of the session, so without a gate it grows
// without bound (observed in the wild: 39 transcripts over 3 MB, largest 72 MB).
//
// What the transcripts actually show (measured, not assumed):
//
//   • Claude Code DOES auto-compact. A compaction writes
//     {type:'system', subtype:'compact_boundary', parentUuid:null, compactMetadata}
//     followed by an isCompactSummary user entry, and the replayed conversation is
//     the parentUuid chain rooted at that boundary. Example from a 33.8 MB file:
//     10 boundaries, the last with preTokens 169695 → postTokens 15689.
//   • Therefore everything BEFORE the last compact boundary is already dead to the
//     model: claude never replays it. Dropping it is a pure win — megabytes off the
//     file with zero context loss. That is this module's primary lever.
//   • What auto-compact cannot fix is a single oversized entry. One tool result of
//     a few hundred KB is ~100K tokens on its own, and compaction has to send the
//     conversation to summarize it, so a blob that overflows the window breaks the
//     compaction too. Eliding oversized entries is this module's second lever.
//
// multicc's display history (dataDir/chatHistory/*.json) and per-turn token
// accounting are independent of this file, so nothing multicc shows the user is
// lost by trimming it.
//
// Two hard invariants, both learned from the way `--resume` reconstructs state:
//
//  1. NEVER drop an entry from the middle of the file. Entries form a parentUuid
//     chain; a hole in the middle makes the walk from the leaf stop early and
//     silently truncates the conversation to whatever sits after the hole. Only
//     head cuts are allowed, and any kept entry whose parent was cut is re-rooted
//     with parentUuid:null. Blocks inside an entry may be replaced, never the entry.
//  2. NEVER break tool_use ↔ tool_result pairing. A kept tool_result whose
//     tool_use was cut makes the API reject the whole request. Sidechain (subagent)
//     pairs interleave with the main chain, so a cut at a real turn boundary is not
//     sufficient on its own — orphans are found and neutralised explicitly.
//
// Also deliberate: `thinking` / `redacted_thinking` blocks are never edited (their
// signature is verified upstream) and base64 image data is never truncated (a half
// image is a 400) — an oversized image block is replaced wholesale by a marker.

const fs = require('fs');
const path = require('path');
const os = require('os');

// High-water mark: above this the transcript is examined. Below it, one stat().
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
// What the ladder actually aims for, and the correction that makes it work.
//
// Every threshold here used to be denominated in file bytes, which is not the thing
// that fails. "Prompt is too long" is a token count, and a transcript is ~26% CLI
// bookkeeping (`toolUseResult`, its own copy of every tool output) that is never
// sent upstream. Measured on the 33.8MB session that produced the error: the old
// ladder ran to its last rung, dropped 33 substantive turns, reached the 1.2MB file
// target — and landed at 215,142 tokens, still over a 200K window. It did its worst
// damage and the next turn failed anyway. Denominated in tokens instead, the same
// file stops at 93,715 tokens and fits.
//
// Room is left for what shares the window with the transcript: the CLI's system
// prompt, tool and MCP schemas, CLAUDE.md, injected memory, the new user turn, and
// the model's own output.
const DEFAULT_TARGET_TOKENS = 120000;
// Above this the lossy lever engages — dropping whole real turns, which also risks
// claude's own compact summary and with it the model's memory of everything before.
// Auto-compact normally keeps us far below this; crossing it means compaction is not
// running (or not keeping up) and something has to give.
const DEFAULT_HARD_MAX_TOKENS = 160000;
// Tried in order once the lossy lever is unavoidable. The low rungs exist because
// the ladder must be able to REACH the target: on a session whose replayed slice is
// mostly a few enormous turns, stopping at 5 leaves it over the wall.
const DEFAULT_KEEP_TURNS_LADDER = [20, 10, 5, 3, 2];
// An entry above this is elided. Sized so ordinary tool output (a file read, a
// test run) survives verbatim and only genuine blobs are cut.
const DEFAULT_MAX_ENTRY_BYTES = 200 * 1024;
// Nothing is protected above this: an entry this large is ~100K tokens on its own,
// which is what overflows the window in the first place. Keeping it "because it is
// recent" is what breaks the very turn we are trying to protect.
const DEFAULT_HARD_ENTRY_BYTES = 400 * 1024;
// How many trailing entries are shielded from ordinary elision — the tool output
// the model is most likely still working from. Deliberately a small window and NOT
// "the whole current turn": one autonomous turn can run for thousands of entries
// (a workflow, a long agent loop), and protecting all of it protects nothing.
const PROTECT_TAIL_LINES = 24;
const ELIDE_CHARS = 8000;        // per-string budget, first pass
const ELIDE_CHARS_TIGHT = 800;   // last-resort pass, last-turn protection lifted
// Don't rewrite the file (or recycle the process) for a trivial win.
const MIN_GAIN_BYTES = 64 * 1024;
// How far back from a compact boundary to look for its preserved messages.
const PRESERVED_SCAN_LINES = 500;
// Floor for anything past the O(1) stat() gate. Below it the deeper triggers are
// unreachable by construction: a file this small cannot hold an entry over the hard
// per-entry ceiling, nor a replay slice anywhere near the token watermark.
const DEFAULT_SCAN_MIN_BYTES = 384 * 1024;
// Context-pressure trigger, in estimated tokens of the *replayed* slice. ~70% of a
// 200K window: below claude's own auto-compact threshold, so eliding stale blobs
// relieves the pressure instead of racing compaction for the same bytes.
const DEFAULT_TOKEN_WATERMARK = 140000;
// Crude but honest: transcripts are JSON-escaped prose and tool output.
const BYTES_PER_TOKEN = 4;
// Parsing the live slice is what separates the payload from the CLI's own
// bookkeeping, and it is cheap enough to do on demand: measured at ~290ms for a
// 26MB live slice and ~580ms for the worst file on this machine (69MB). The budget
// exists only so a pathological file degrades to "no estimate" instead of stalling.
const MEASURE_PARSE_BUDGET = 128 * 1024 * 1024;
// Characters of genuine user text below which a turn carries nothing a later reader
// would miss ("继续", "ok", "api", "1"). Only decides whether a turn SPENDS the
// keep-N budget — never whether it is kept.
const FILLER_MAX_CHARS = 12;

function claudeProjectDir(cwd) {
  // Claude Code stores transcripts under ~/.claude/projects/<sanitised-cwd>/, where
  // EVERY non-alphanumeric character of the cwd becomes '-' — not just the slashes.
  // Case is preserved. So /Users/me/p/.multicc-worktrees/x maps to
  // -Users-me-p--multicc-worktrees-x (the dot contributes the second dash), and a
  // CJK path segment collapses to one dash per character. Replacing only '/' — as
  // this did originally — resolves to a directory that never exists for any
  // multicc worktree session, since they all live under `.multicc-worktrees`.
  const slug = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

function findTranscriptFile(cwd, cliSessionId) {
  const dir = claudeProjectDir(cwd);
  if (!fs.existsSync(dir)) return null;
  // Prefer an exact match on the session id; fall back to the largest JSONL.
  if (cliSessionId) {
    const exact = path.join(dir, `${cliSessionId}.jsonl`);
    if (fs.existsSync(exact)) return exact;
  }
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      // Never select our own sidecar as the file to trim/resume: it holds only
      // already-removed rows (kept so global token stats still read their usage).
      if (name.endsWith('.pruned.jsonl')) continue;
      const p = path.join(dir, name);
      const sz = fs.statSync(p).size;
      if (!best || sz > best.size) best = { path: p, size: sz };
    }
  } catch (_) {}
  return best ? best.path : null;
}

function parseLine(line) {
  try { return JSON.parse(line); } catch (_) { return null; }
}

const UUID_RE = /(?:^|[{,])"uuid":"([^"]+)"/;
const PARENT_RE = /(?:^|[{,])"parentUuid":"([^"]+)"/;

function extractUuid(line) {
  const m = UUID_RE.exec(line);
  return m ? m[1] : null;
}

/**
 * A *real* user turn: a message the human (or multicc on their behalf) sent.
 * Everything claude writes back into the `user` role — tool results, meta entries,
 * sidechain traffic — is explicitly not one. That distinction is load-bearing: in
 * a real transcript tool_result entries outnumber real user turns ~7:1, so a naive
 * `type === 'user'` count turns "keep the last 10 turns" into "keep 1.5 turns" and
 * cuts mid-turn.
 */
function isRealUserTurn(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.isSidechain === true) return false;    // subagent conversation, not ours
  if (obj.isMeta === true) return false;         // local-command output, hooks, reminders
  if (obj.isCompactSummary === true) return false; // claude's own summary, not a turn
  if (obj.type !== 'user' && !(obj.message && obj.message.role === 'user')) return false;
  const content = obj.message && obj.message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  if (content.some((b) => b && b.type === 'tool_result')) return false;
  return content.some((b) => b && (b.type === 'text' || b.type === 'image'));
}

// multicc wraps the user's words in its own bracketed prompt layers — the gateway
// system prompt, the Commander routing block, cross-agent notes, Goal-mode limits —
// and the harness adds <system-reminder> blocks plus a trailing [Dispatch] directive.
// That boilerplate runs to several KB and is near-identical every turn, so measuring
// it would make even a bare "继续" look substantial and collapse the substantive
// count back into a positional one. Every layer closes with a line of the form
// `[... end]` / `[...结束]`, so the user's own text is whatever follows the last one.
const HARNESS_END_LINE = /^\[[^\]\n]{0,64}(?:end|结束)\]$/gm;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TRAILING_DIRECTIVE = /\n\[Dispatch\][\s\S]*$/;

function userVisibleText(str) {
  if (typeof str !== 'string' || !str) return '';
  let text = str.replace(SYSTEM_REMINDER, '');
  HARNESS_END_LINE.lastIndex = 0;
  let end = -1;
  for (let m = HARNESS_END_LINE.exec(text); m; m = HARNESS_END_LINE.exec(text)) {
    end = m.index + m[0].length;
  }
  // Only strip when something survives it: a user whose entire message happens to
  // be such a line should be measured, not erased.
  if (end > 0 && text.slice(end).trim()) text = text.slice(end);
  return text.replace(TRAILING_DIRECTIVE, '').trim();
}

/**
 * Does this turn carry information a later reader would miss? "继续" / "ok" / "api"
 * do not; anything carrying an image does. Deliberately generous — scoring filler as
 * substantive only moves the keep-N cut earlier, i.e. keeps more than necessary,
 * while the reverse would drop a real exchange.
 */
function isSubstantiveTurn(obj) {
  if (!isRealUserTurn(obj)) return false;
  const content = obj.message.content;
  if (typeof content === 'string') return userVisibleText(content).length > FILLER_MAX_CHARS;
  let chars = 0;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'image') return true;
    if (b.type === 'text') chars += userVisibleText(b.text).length;
  }
  return chars > FILLER_MAX_CHARS;
}

function elideMarker(kind, chars) {
  return `\n\n[multicc pruned ${chars} chars of ${kind} to keep this session inside the model context window]`;
}

function truncateString(str, maxChars, stats) {
  if (typeof str !== 'string' || str.length <= maxChars) return str;
  const head = str.slice(0, Math.max(0, maxChars - 160));
  stats.strings += 1;
  stats.savedChars += str.length - head.length;
  return head + elideMarker('older output', str.length - head.length);
}

// Generic deep elision for payloads that are plain JSON (tool_use inputs,
// toolUseResult sidecars, non-conversation entries): long strings are truncated,
// structure preserved.
function elideDeep(value, maxChars, stats, depth = 0) {
  if (depth > 24) return value;
  if (typeof value === 'string') return truncateString(value, maxChars, stats);
  if (Array.isArray(value)) return value.map((v) => elideDeep(v, maxChars, stats, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // A truncated signature fails verification upstream; thinking text is what
      // the signature covers. Both stay byte-for-byte.
      if (k === 'signature' || k === 'thinking') out[k] = v;
      else out[k] = elideDeep(v, maxChars, stats, depth + 1);
    }
    return out;
  }
  return value;
}

function imageBytes(block) {
  const data = block && block.source && typeof block.source.data === 'string' ? block.source.data : '';
  return data.length;
}

function elideContentBlock(block, maxChars, stats) {
  if (!block || typeof block !== 'object') return block;
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return block;
  if (block.type === 'image') {
    const bytes = imageBytes(block);
    if (bytes <= maxChars) return block;
    stats.images += 1;
    stats.savedChars += bytes;
    return { type: 'text', text: elideMarker('an inline image', bytes).trim() };
  }
  if (block.type === 'text') {
    return { ...block, text: truncateString(block.text, maxChars, stats) };
  }
  if (block.type === 'tool_result') {
    const out = { ...block };
    if (typeof out.content === 'string') {
      out.content = truncateString(out.content, maxChars, stats);
    } else if (Array.isArray(out.content)) {
      const blocks = out.content.map((b) => elideContentBlock(b, maxChars, stats));
      // An empty tool_result content array is rejected upstream; keep a stub.
      out.content = blocks.length ? blocks : [{ type: 'text', text: elideMarker('tool output', 0).trim() }];
    }
    return out;
  }
  if (block.type === 'tool_use') {
    return { ...block, input: elideDeep(block.input, maxChars, stats) };
  }
  return block;
}

function elideEntry(obj, maxChars) {
  const stats = { strings: 0, images: 0, savedChars: 0 };
  if (obj.type !== 'user' && obj.type !== 'assistant') {
    // Attachments, file-history snapshots and friends: no block structure worth
    // preserving, so elide the whole payload.
    return { obj: elideDeep(obj, maxChars, stats), stats };
  }
  const next = { ...obj };
  if (next.message && typeof next.message === 'object') {
    const msg = { ...next.message };
    if (typeof msg.content === 'string') msg.content = truncateString(msg.content, maxChars, stats);
    else if (Array.isArray(msg.content)) msg.content = msg.content.map((b) => elideContentBlock(b, maxChars, stats));
    next.message = msg;
  }
  // `toolUseResult` is the CLI's own copy of the tool output (for its transcript
  // view, not the API request) and is frequently the largest field on a line.
  if (next.toolUseResult !== undefined) next.toolUseResult = elideDeep(next.toolUseResult, maxChars, stats);
  return { obj: next, stats };
}

function collectPairIds(obj) {
  const uses = [];
  const results = [];
  const content = obj && obj.message && obj.message.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.id) uses.push(String(b.id));
      if (b.type === 'tool_result' && b.tool_use_id) results.push(String(b.tool_use_id));
    }
  }
  return { uses, results };
}

// Replace tool_result blocks whose tool_use was cut with a plain text block. The
// entry itself always survives — see invariant 1 (no holes in the chain).
function neutraliseOrphans(text, orphanIds) {
  const obj = parseLine(text);
  if (!obj || !obj.message || !Array.isArray(obj.message.content)) return text;
  const content = obj.message.content.map((b) => (
    b && b.type === 'tool_result' && orphanIds.has(String(b.tool_use_id))
      ? { type: 'text', text: '[multicc: tool result dropped with its call during context pruning]' }
      : b
  ));
  return JSON.stringify({ ...obj, message: { ...obj.message, content } });
}

function setParent(text, parentUuid) {
  const obj = parseLine(text);
  if (!obj || obj.parentUuid === undefined || obj.parentUuid === parentUuid) return text;
  return JSON.stringify({ ...obj, parentUuid });
}

/**
 * Per-line analysis, memoised so the transcript is parsed at most once per line
 * however many candidates are evaluated. `text` is the elided line, or the
 * original when nothing needed eliding.
 */
function createAnalyzer(lines, { maxEntryBytes, hardEntryBytes, elideChars, protectFrom }) {
  const memo = new Map();
  return function analyze(i) {
    let m = memo.get(i);
    if (m) return m;
    const raw = lines[i];
    const oversized = raw.length > hardEntryBytes
      || (raw.length > maxEntryBytes && (protectFrom < 0 || i < protectFrom));
    const mayPair = raw.indexOf('tool_use') >= 0 || raw.indexOf('tool_result') >= 0;
    let text = raw;
    let elided = false;
    let uses = [];
    let results = [];
    if (oversized || mayPair) {
      const obj = parseLine(raw);
      if (obj) {
        let effective = obj;
        if (oversized) {
          const e = elideEntry(obj, elideChars);
          if (e.stats.strings || e.stats.images) {
            effective = e.obj;
            text = JSON.stringify(e.obj);
            elided = true;
          }
        }
        if (mayPair) {
          const pairs = collectPairIds(effective);
          uses = pairs.uses;
          results = pairs.results;
        }
      }
    }
    m = {
      text,
      bytes: Buffer.byteLength(text) + 1,
      elided,
      uses,
      results,
      uuid: extractUuid(raw),
    };
    memo.set(i, m);
    return m;
  };
}

function buildCandidate(lines, indices, analyze, splice) {
  const keptUuids = new Set();
  for (const i of indices) {
    const u = analyze(i).uuid;
    if (u) keptUuids.add(u);
  }
  const headCut = indices.length === 0 || indices[0] !== 0;
  const texts = [];
  const seenUses = new Set();
  let bytes = 0;
  let elidedEntries = 0;
  let orphanBlocks = 0;
  let rerooted = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const m = analyze(i);
    let text = m.text;
    let bytesOf = m.bytes;
    let rewritten = false;
    if (m.results.length) {
      const orphans = new Set(m.results.filter((id) => !seenUses.has(id)));
      if (orphans.size) {
        text = neutraliseOrphans(text, orphans);
        orphanBlocks += orphans.size;
        rewritten = true;
      }
    }
    for (const id of m.uses) seenUses.add(id);
    if (splice && k === splice.at) {
      // Graft the surviving conversation onto claude's own compact summary so the
      // model keeps its memory of everything the summary covers.
      text = setParent(text, splice.parentUuid);
      rewritten = true;
    } else if (headCut) {
      // Re-root every entry whose parent was cut away, so the replay walk from the
      // leaf terminates on a real root instead of a dangling reference.
      const parent = PARENT_RE.exec(text);
      if (parent && !keptUuids.has(parent[1])) {
        text = setParent(text, null);
        rerooted += 1;
        rewritten = true;
      }
    }
    if (rewritten) bytesOf = Buffer.byteLength(text) + 1;
    if (m.elided) elidedEntries += 1;
    texts.push(text);
    bytes += bytesOf;
  }
  return { texts, bytes, elidedEntries, orphanBlocks, rerooted };
}

function collectPreservedUuids(boundary) {
  const out = new Set();
  const meta = boundary && boundary.compactMetadata;
  if (!meta || typeof meta !== 'object') return out;
  const add = (v) => { if (typeof v === 'string' && v) out.add(v); };
  const seg = meta.preservedSegment || {};
  add(seg.headUuid); add(seg.anchorUuid); add(seg.tailUuid);
  const msgs = meta.preservedMessages || {};
  add(msgs.anchorUuid);
  for (const key of ['uuids', 'allUuids']) {
    if (Array.isArray(msgs[key])) msgs[key].forEach(add);
  }
  return out;
}

/**
 * Locate the last auto-compaction. `cut` is the index of the first entry claude
 * still replays: the boundary line, pulled back to the earliest of its preserved
 * messages — those sit just *before* the boundary in the file and are re-attached
 * by uuid from compactMetadata rather than through the parentUuid chain, so
 * cutting them leaves dangling references. `summaryIdx` is the isCompactSummary
 * entry that chains off the boundary and carries the model's memory of everything
 * before it. All zero/-1 when the transcript has never been compacted.
 */
function compactCutIndex(lines) {
  let boundaryIdx = -1;
  let preserved = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf('compact_boundary') < 0) continue;
    const obj = parseLine(lines[i]);
    if (!obj || obj.subtype !== 'compact_boundary') continue;
    boundaryIdx = i;
    preserved = collectPreservedUuids(obj);
    break;
  }
  if (boundaryIdx <= 0) return { cut: 0, boundaryIdx: -1, summaryIdx: -1 };
  let cut = boundaryIdx;
  if (preserved && preserved.size) {
    const from = Math.max(0, boundaryIdx - PRESERVED_SCAN_LINES);
    for (let i = boundaryIdx - 1; i >= from; i--) {
      const u = extractUuid(lines[i]);
      if (u && preserved.has(u) && i < cut) cut = i;
    }
  }
  let summaryIdx = -1;
  for (let i = boundaryIdx + 1; i < Math.min(lines.length, boundaryIdx + 6); i++) {
    if (lines[i].indexOf('isCompactSummary') < 0) continue;
    const obj = parseLine(lines[i]);
    if (obj && obj.isCompactSummary === true) { summaryIdx = i; break; }
  }
  return { cut, boundaryIdx, summaryIdx };
}

// Cheap pass over the replayed slice: no JSON parsing, so it stays affordable on
// every turn. `largestEntryBytes` is measured over the live slice only — an
// oversized entry that sits before the compact cut costs file bytes but no context,
// and the compact-cut lever removes it losslessly anyway.
function liveExtent(lines, cut) {
  let liveBytes = 0;
  let largestEntryBytes = 0;
  for (let i = cut; i < lines.length; i++) {
    liveBytes += Buffer.byteLength(lines[i]) + 1;
    if (lines[i].length > largestEntryBytes) largestEntryBytes = lines[i].length;
  }
  return { liveBytes, largestEntryBytes };
}

// What one entry actually costs upstream. The CLI's own `toolUseResult` copy is
// never sent, and on a tool-heavy session it is most of the line — which is exactly
// why file bytes overstate the real load (0.74 file→api on the measured session).
function apiBytesOfLine(text) {
  const obj = parseLine(text);
  if (!obj) return Buffer.byteLength(text);
  return obj.message
    ? Buffer.byteLength(JSON.stringify(obj.message))
    : Math.min(Buffer.byteLength(text), 4096);
}

// O(liveBytes) — returns null rather than stall on a pathological file.
function liveApiBytes(lines, cut, liveBytes, parseBudget) {
  if (liveBytes > parseBudget) return null;
  let apiBytes = 0;
  for (let i = cut; i < lines.length; i++) apiBytes += apiBytesOfLine(lines[i]);
  return apiBytes;
}

/**
 * What a candidate would cost upstream, in estimated tokens — the number the ladder
 * stops on. Deliberately conservative on CJK: a Chinese character is \uXXXX-escaped
 * to 6 bytes in the JSONL but is roughly one token, so BYTES_PER_TOKEN overestimates
 * a Chinese session by ~1.5x. Erring high trims slightly more than necessary; erring
 * low would let the very error we are here to prevent through.
 */
function candidateTokens(candidate) {
  if (candidate.tokens == null) {
    let bytes = 0;
    for (const text of candidate.texts) bytes += apiBytesOfLine(text);
    candidate.tokens = Math.round(bytes / BYTES_PER_TOKEN);
  }
  return candidate.tokens;
}

/**
 * When to look inside the file at all. File size alone is a poor proxy for context
 * pressure in both directions: a 35MB transcript that auto-compacted replays 0.6MB
 * and is harmless, while a 1.5MB one that never compacted replays all of itself.
 * `oversized-entry` covers the case file size misses — a single 400KB tool result is
 * ~100K tokens, half a window, on its own, yet on file size alone nothing looks at
 * it until the file crosses 2MB. Measured on 3,985 real transcripts it fires on 5
 * that the size gate ignored, each a pure elision with no replayed turn lost.
 *
 * Deliberately NOT a trigger: the estimated-token watermark. It reads well and it is
 * reported by measureFile(), but as a prune trigger it was worthless — of 57 real
 * sessions over the watermark on replay alone, every single one had nothing left to
 * elide (their weight is many medium entries, not a few blobs), so the gate did ~10ms
 * of work per turn to return null and `wouldPrune` claimed a trim that would never
 * happen. The only lever that would bite there is dropping whole turns, and below
 * hardMaxTokens claude's own compaction summarises that same history far better than
 * we can truncate it. So the watermark stays a readout, not an action.
 *
 * Pure, and shared with measureFile() so the readout cannot promise a trim the gate
 * would not run.
 */
function triggersFor({ fileBytes, largestEntryBytes }, { maxBytes, hardEntryBytes, scanMinBytes }) {
  const reasons = [];
  if (fileBytes > maxBytes) reasons.push('file-bytes');
  if (fileBytes > scanMinBytes && largestEntryBytes >= hardEntryBytes) reasons.push('oversized-entry');
  return reasons;
}

/**
 * Prune the transcript for (cwd, sessionId) when triggersFor() says so — the file
 * is over the high-water mark, or it holds an entry too large for any single turn
 * (or when `force` is set by a caller that has its own reason to compact).
 *
 * Returns null when nothing was done, otherwise a report. `contextAffected` says
 * whether the live model context changed (entries elided or real turns dropped) —
 * i.e. whether a warm `claude -p` process should be recycled to pick it up. A
 * pure compact-boundary cut removes only what claude already ignores, so it never
 * sets that flag.
 */
function pruneFile(file, {
  maxBytes = DEFAULT_MAX_BYTES,
  targetTokens = DEFAULT_TARGET_TOKENS,
  hardMaxTokens = DEFAULT_HARD_MAX_TOKENS,
  keepTurnsLadder = DEFAULT_KEEP_TURNS_LADDER,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  hardEntryBytes = DEFAULT_HARD_ENTRY_BYTES,
  scanMinBytes = DEFAULT_SCAN_MIN_BYTES,
  minGainBytes = MIN_GAIN_BYTES,
  force = false,
  dryRun = false,
} = {}) {
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }
  if (stat.size <= minGainBytes) return null;
  // O(1) pre-gate: the common case is a small transcript and a single stat(). The
  // floor is the smaller of the two — past it we read the file (a few ms at these
  // sizes) so the oversized-entry trigger below can see it at all.
  if (!force && stat.size <= Math.min(maxBytes, scanMinBytes)) return null;

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const lines = raw.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return null;

  const { cut: compactCut, boundaryIdx, summaryIdx } = compactCutIndex(lines);

  // Scan-only: no JSON parsing on the gate path, so a session that is merely large
  // costs one read plus two linear scans per turn (~7ms at 2MB) and not a parse.
  let triggers = ['forced'];
  if (!force) {
    const { largestEntryBytes } = liveExtent(lines, compactCut);
    triggers = triggersFor({ fileBytes: stat.size, largestEntryBytes },
      { maxBytes, hardEntryBytes, scanMinBytes });
    if (!triggers.length) return null;
  }

  const starts = [];
  const substantiveStarts = [];
  for (let i = 0; i < lines.length; i++) {
    // Cheap pre-filter: a real user entry always carries a user role/type literal,
    // so only those lines are parsed. Multi-MB tool_result rows are the bulk of a
    // fat transcript and are never a real user turn at that size, so they are
    // skipped unparsed. A false skip only removes a turn boundary, which moves a
    // cut EARLIER (keeping more) — it can never produce a mid-turn cut.
    if (lines[i].indexOf('"user"') < 0) continue;
    if (lines[i].length > 65536 && lines[i].indexOf('"tool_result"') >= 0) continue;
    const obj = parseLine(lines[i]);
    if (!isRealUserTurn(obj)) continue;
    starts.push(i);
    if (isSubstantiveTurn(obj)) substantiveStarts.push(i);
  }
  // Shield the freshest entries from ordinary elision — but at most a small tail
  // window, and never past the start of the current turn. The last-resort pass
  // below lifts this entirely.
  const protectFrom = Math.max(
    starts.length ? starts[starts.length - 1] : 0,
    lines.length - PROTECT_TAIL_LINES,
  );

  // Indices to keep for a given head cut. A cut deeper than the summary keeps the
  // compact prologue (preserved messages + boundary + summary) and grafts the
  // survivors onto the summary, so dropping turns costs the turns themselves and
  // not the model's whole memory of the session.
  const indicesFor = (cut) => {
    if (summaryIdx >= 0 && cut > summaryIdx) {
      const prologue = [];
      for (let i = compactCut; i <= summaryIdx; i++) prologue.push(i);
      const indices = prologue.slice();
      for (let i = cut; i < lines.length; i++) indices.push(i);
      return { indices, splice: { at: prologue.length, parentUuid: extractUuid(lines[summaryIdx]) } };
    }
    const indices = [];
    for (let i = cut; i < lines.length; i++) indices.push(i);
    return { indices, splice: null };
  };

  let best = null;
  let strategy = null;
  // Elide progressively harder before touching a single turn: losing detail inside
  // old tool output is cheaper than losing the exchange it belonged to.
  const levels = [
    { max: maxEntryBytes, chars: ELIDE_CHARS, protectFrom, name: 'elide' },
    { max: Math.min(maxEntryBytes, 64 * 1024), chars: 4000, protectFrom, name: 'elide-hard' },
    { max: Math.min(maxEntryBytes, 24 * 1024), chars: ELIDE_CHARS_TIGHT, protectFrom, name: 'elide-max' },
    { max: Math.min(maxEntryBytes, 24 * 1024), chars: ELIDE_CHARS_TIGHT, protectFrom: -1, name: 'elide-max-unprotected' },
  ];
  // Every comparison here is in tokens, not bytes: bytes are what the file costs on
  // disk, tokens are what the next turn costs against the window.
  const take = (candidate, cut, name) => {
    const tokens = candidateTokens(candidate);
    if (!best || tokens < best.tokens) {
      best = { ...candidate, cut };
      strategy = name;
    }
    return tokens;
  };

  let analyze = null;
  for (const level of levels) {
    analyze = createAnalyzer(lines, {
      maxEntryBytes: level.max, hardEntryBytes, elideChars: level.chars, protectFrom: level.protectFrom,
    });
    // Levers 1+2: drop what claude already ignores, then elide the blobs.
    const plan = indicesFor(compactCut);
    const base = buildCandidate(lines, plan.indices, analyze, plan.splice);
    const tokens = take(base, compactCut, compactCut > 0 ? `compact-cut+${level.name}` : level.name);
    // Under the ceiling: stop here rather than trade more detail for room we don't
    // need. This also keeps the ordinary case to a single pass over the file.
    if (tokens <= hardMaxTokens) break;
  }
  // Lever 3 (lossy): drop whole real turns, but only when eliding everything we are
  // allowed to elide still left us far above target — i.e. auto-compaction is not
  // keeping this session in bounds on its own. Uses the most aggressive elision,
  // since giving up detail beats giving up more turns.
  if (best && best.tokens > hardMaxTokens) {
    for (const keep of keepTurnsLadder) {
      // keep-N spends its budget on turns that carry information. A session driven
      // by "继续" / "ok" burns N positional turns on maybe two real exchanges, so
      // the filler is not counted: the cut lands on the Nth *substantive* turn and
      // whatever filler follows rides along free (it is a few hundred bytes).
      // Since substantiveStarts ⊆ starts, this cut is always at or before the
      // positional one — it can only keep more than the old rule, never less.
      // Fall back to positional when a session has fewer substantive turns than the
      // rung asks for, otherwise the ladder would find no cut at all and give up.
      const pool = substantiveStarts.length >= keep ? substantiveStarts : starts;
      if (keep >= pool.length) continue;
      const cut = pool[pool.length - keep];
      if (cut <= compactCut) continue;   // would keep more, not less
      const plan = indicesFor(cut);
      const candidate = buildCandidate(lines, plan.indices, analyze, plan.splice);
      // Stop on tokens, not on file bytes. Measured on the 33.8MB session that
      // produced "Prompt is too long": the byte rule stopped at keep-5 because
      // 1.11MB was under the 1.2MB byte target — and that candidate was still
      // 215,142 tokens, over a 200K window. It dropped 33 substantive turns and
      // the next turn failed anyway. keep-2, one rung lower, fits in 93,715.
      if (take(candidate, cut, `keep-${keep}-turns`) <= targetTokens) break;
    }
  }
  if (!best) return null;
  if (best.bytes >= stat.size - minGainBytes) return null;  // not worth a rewrite

  const kept = new Set(indicesFor(best.cut).indices);
  const removed = [];
  for (let i = 0; i < lines.length; i++) if (!kept.has(i)) removed.push(i);
  const droppedTurns = starts.filter((i) => !kept.has(i)).length;
  // Turns before the compact boundary are already gone from the model's view (its
  // own summary replaced them), so only dropping a turn after the boundary loses
  // anything claude would otherwise have replayed.
  const lostTurns = starts.filter((i) => i >= compactCut && !kept.has(i)).length;
  // The honest cost figure: of the replayed turns we are dropping, how many said
  // anything. Reporting only lostTurns overstates the damage on a session where
  // half the turns were "继续".
  const lostSubstantiveTurns = substantiveStarts.filter((i) => i >= compactCut && !kept.has(i)).length;
  if (!dryRun) {
    // Cut rows move to <id>.pruned.jsonl so global token accounting (which walks
    // ~/.claude/projects/**/*.jsonl — see src/token-global.js) still reads their
    // usage, while --resume only loads the trimmed file. Rows we KEEP are never
    // copied there — neither elided ones nor the compact prologue — since their
    // usage stays in the live file and a second copy would double-count it.
    if (removed.length) {
      const sidecar = file.replace(/\.jsonl$/, '.pruned.jsonl');
      try {
        fs.appendFileSync(sidecar, removed.map((i) => lines[i]).join('\n') + '\n');
      } catch (_) {}
    }
    // Truncate-and-write keeps the inode, so an fd claude still holds in append
    // mode lands after our content instead of at a stale offset.
    fs.writeFileSync(file, best.texts.join('\n') + '\n');
  }

  return {
    file,
    strategy,
    triggers,
    beforeBytes: stat.size,
    afterBytes: best.bytes,
    // What the plan costs upstream, and whether it actually clears the wall. Bytes
    // alone cannot answer that — this is the number the ladder stopped on.
    afterTokens: best.tokens,
    fitsTarget: best.tokens <= targetTokens,
    beforeLines: lines.length,
    afterLines: best.texts.length,
    droppedLines: removed.length,
    keptSummary: !!(summaryIdx >= 0 && kept.has(summaryIdx)),
    realUserTurns: starts.length,
    substantiveTurns: substantiveStarts.length,
    droppedTurns,
    lostTurns,
    lostSubstantiveTurns,
    compactBoundary: boundaryIdx >= 0,
    elidedEntries: best.elidedEntries,
    orphanBlocks: best.orphanBlocks,
    rerootedEntries: best.rerooted,
    // A pure compact-boundary cut removes only entries claude already ignores, so
    // a warm process needs no recycle; elision and deeper cuts do change context.
    contextAffected: best.elidedEntries > 0 || lostTurns > 0,
    forced: force === true,
    dryRun: dryRun === true,
  };
}

function maybePrune(cwd, sessionId, opts = {}) {
  return pruneFile(findTranscriptFile(cwd, sessionId), opts);
}

/**
 * Read-only water level for (cwd, sessionId). Answers "how close is this session
 * to the wall, and what is actually taking the room" without touching the file.
 *
 * Three different numbers matter and conflating them is how you end up chasing
 * the wrong problem:
 *   fileBytes  — what the gate in maybePrune() triggers on;
 *   liveBytes  — only the entries claude still replays (everything from the last
 *                compact cut on), so a session that auto-compacted can be a huge
 *                file with a small live context;
 *   apiBytes   — of those, just the `message` payloads. The CLI's own
 *                `toolUseResult` copy is never sent upstream, and on a
 *                tool-heavy session it is most of the file — which is why
 *                fileBytes alone badly overstates the real token load.
 * `estimatedTokens` is apiBytes/4 when we could compute it: a rough proxy, and
 * deliberately labelled as such rather than dressed up as a token count.
 */
function measureFile(file, {
  maxBytes = DEFAULT_MAX_BYTES,
  targetTokens = DEFAULT_TARGET_TOKENS,
  hardMaxTokens = DEFAULT_HARD_MAX_TOKENS,
  hardEntryBytes = DEFAULT_HARD_ENTRY_BYTES,
  scanMinBytes = DEFAULT_SCAN_MIN_BYTES,
  tokenWatermark = DEFAULT_TOKEN_WATERMARK,
  parseBudget = MEASURE_PARSE_BUDGET,
} = {}) {
  if (!file) return { found: false };
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return { found: false }; }

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { found: false }; }
  const lines = raw.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const { cut, boundaryIdx, summaryIdx } = compactCutIndex(lines);
  const { liveBytes, largestEntryBytes } = liveExtent(lines, cut);

  let realUserTurns = 0;
  let liveTurns = 0;
  let substantiveTurns = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('"user"') < 0) continue;
    if (lines[i].length > 65536 && lines[i].indexOf('"tool_result"') >= 0) continue;
    const obj = parseLine(lines[i]);
    if (!isRealUserTurn(obj)) continue;
    realUserTurns++;
    if (i >= cut) liveTurns++;
    if (isSubstantiveTurn(obj)) substantiveTurns++;
  }

  const apiBytes = liveApiBytes(lines, cut, liveBytes, parseBudget);
  const estimatedTokens = apiBytes == null ? null : Math.round(apiBytes / BYTES_PER_TOKEN);
  const triggers = triggersFor(
    { fileBytes: stat.size, largestEntryBytes },
    { maxBytes, hardEntryBytes, scanMinBytes },
  );
  // Reported, never acted on — see triggersFor(). This is the number that predicts
  // "Prompt is too long", and also the one multicc has no lossless answer to: when
  // it is high with no oversized entry, the room is gone to many medium entries and
  // only claude's own compaction can reclaim it.
  const overWatermark = estimatedTokens != null && estimatedTokens >= tokenWatermark;

  return {
    found: true,
    fileBytes: stat.size,
    lines: lines.length,
    liveBytes,
    liveLines: lines.length - cut,
    apiBytes,
    estimatedTokens,
    largestEntryBytes,
    realUserTurns,
    liveTurns,
    substantiveTurns,
    compactBoundary: {
      present: boundaryIdx >= 0,
      atLine: boundaryIdx >= 0 ? boundaryIdx + 1 : null,
      summaryPresent: summaryIdx >= 0,
      droppedByCompaction: cut,
    },
    // Bytes gate the work; tokens are what the ladder stops on. Both are reported
    // because reading one for the other is how the ladder came to aim at the wrong
    // number in the first place.
    thresholds: { maxBytes, hardEntryBytes, scanMinBytes, targetTokens, hardMaxTokens, tokenWatermark },
    // Computed by the same pure function the prune gate uses, so the readout cannot
    // promise a trim the next turn would not run.
    triggers,
    wouldPrune: triggers.length > 0,
    overWatermark,
    // 'over' is reserved for actual context pressure — a big file that already
    // auto-compacted is not it, and a session over the watermark is, whether or not
    // we have any lever for it. When the live slice was too large to parse we have
    // no token figure at all; a slice that size is over the wall by construction.
    status: (overWatermark || (estimatedTokens == null && liveBytes > hardMaxTokens * BYTES_PER_TOKEN))
      ? 'over' : (triggers.length ? 'watch' : 'ok'),
    modifiedAt: stat.mtime instanceof Date ? stat.mtime.toISOString() : null,
  };
}

function measure(cwd, sessionId, opts = {}) {
  return measureFile(findTranscriptFile(cwd, sessionId), opts);
}

module.exports = {
  maybePrune,
  pruneFile,
  measure,
  measureFile,
  findTranscriptFile,
  claudeProjectDir,
  isRealUserTurn,
  isSubstantiveTurn,
  userVisibleText,
  triggersFor,
  compactCutIndex,
  DEFAULT_MAX_BYTES,
  DEFAULT_TARGET_TOKENS,
  DEFAULT_HARD_MAX_TOKENS,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_HARD_ENTRY_BYTES,
  DEFAULT_KEEP_TURNS_LADDER,
  DEFAULT_SCAN_MIN_BYTES,
  DEFAULT_TOKEN_WATERMARK,
};
