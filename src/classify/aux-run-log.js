'use strict';

const fs = require('fs');
const path = require('path');

// Durable evidence for every Aux task-attribution call: what we asked, what
// came back verbatim, and which message the result was anchored to.
//
// Until now an Aux result was unfalsifiable after the fact: the queue dropped
// the response object and only the parsed task name survived. When messages
// landed in the wrong task there was no way to distinguish a bad model answer,
// a parser bug, or a stale result — and no way to test a parser change against
// real traffic without re-running the model.
//
// This log closes both gaps with one artefact:
//   * per-message provenance — `byAnchor()` answers "which Aux run produced the
//     attribution I am looking at, and what did the model actually say?"
//   * offline backtest corpus — `list()` over historical runs replays recorded
//     `rawText` through a new parser/state machine with no model in the loop.
//
// JSONL, one file per session, append-only, matching chat history's storage
// choice for the same reason: the common mutation is an append, not a rewrite.
// Rotation keeps the newest `maxRunsPerSession` entries; this is diagnostic
// evidence, not a ledger, so dropping the oldest is always safe.

const DEFAULT_MAX_RUNS_PER_SESSION = 200;

// Bound what a single run may occupy on disk. A classify prompt embeds recent
// transcript turns, so an unbounded copy would duplicate a meaningful slice of
// chat history per verdict. Truncation is marked so a reader never mistakes a
// clipped prompt for what the model actually saw.
const DEFAULT_MAX_FIELD_CHARS = 20_000;

function safeSessionName(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '_') || '_default';
}

function clip(value, limit) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function createAuxRunLog(options = {}) {
  const {
    dir,
    now = Date.now,
    log = () => {},
    maxRunsPerSession = DEFAULT_MAX_RUNS_PER_SESSION,
    maxFieldChars = DEFAULT_MAX_FIELD_CHARS,
    // Injected so tests can assert rotation without writing hundreds of runs.
    fileSystem = fs,
  } = options;

  if (!dir) throw new TypeError('[aux-run-log] dir is required');

  function fileFor(sessionId) {
    return path.join(dir, `${safeSessionName(sessionId)}.jsonl`);
  }

  function ensureDir() {
    try {
      fileSystem.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return true;
    } catch (error) {
      log('aux_run_log_mkdir_failed', { dir, error: error.message });
      return false;
    }
  }

  function readLines(sessionId) {
    let text;
    try {
      text = fileSystem.readFileSync(fileFor(sessionId), 'utf8');
    } catch (error) {
      // A session that never ran classify has no file; that is not a failure.
      if (error.code !== 'ENOENT') {
        log('aux_run_log_read_failed', { sessionId, error: error.message });
      }
      return [];
    }
    const runs = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        runs.push(JSON.parse(line));
      } catch (_) {
        // An append is not atomic, so a crash can leave one partial trailing
        // line. Evidence is best-effort by construction — skip and keep going
        // rather than failing a diagnostic read over a torn write.
      }
    }
    return runs;
  }

  // Rewrite keeping only the newest entries. Called after an append discovers
  // the file outgrew its cap, so the steady-state cost is one rewrite per
  // `maxRunsPerSession` appends rather than one per append.
  function rotate(sessionId) {
    const runs = readLines(sessionId);
    if (runs.length <= maxRunsPerSession) return false;
    const kept = runs.slice(runs.length - maxRunsPerSession);
    const body = kept.map(run => `${JSON.stringify(run)}\n`).join('');
    const target = fileFor(sessionId);
    const temp = `${target}.rotate.tmp`;
    try {
      fileSystem.writeFileSync(temp, body, { mode: 0o600 });
      fileSystem.renameSync(temp, target);
      return true;
    } catch (error) {
      log('aux_run_log_rotate_failed', { sessionId, error: error.message });
      try { fileSystem.unlinkSync(temp); } catch (_) {}
      return false;
    }
  }

  // Append one run. Returns the stored record so a caller can attach `runId` to
  // whatever it is about to persist. Never throws: losing evidence must not fail
  // the turn that produced it.
  function record(sessionId, run = {}) {
    const key = String(sessionId || '');
    if (!key) return null;
    const entry = {
      runId: run.runId || null,
      at: Number.isFinite(run.at) ? run.at : now(),
      kind: run.kind || 'intent_classify',
      sessionId: key,
      source: run.source || null,
      turnId: run.turnId || null,
      // The business task this verdict belongs to — the same value carried on
      // `message.taskId`, which is what makes runs groupable by task.
      taskId: run.taskId || null,
      // The task pointer before attribution. It differs when Aux starts a new
      // task or reconnects the turn to an older task.
      priorTaskId: run.priorTaskId || null,
      // The last message the classifier saw. Reverse lookup from a rendered
      // message back to the verdict that judged it goes through this field.
      anchorMessageId: run.anchorMessageId || null,
      // The anchor observed when the delayed result returned.  A different
      // value proves that a newer user/assistant message had already become
      // current, so the result was retained for audit but not applied live.
      observedAnchorMessageId: run.observedAnchorMessageId || null,
      model: run.model || null,
      latencyMs: Number.isFinite(run.latencyMs) ? run.latencyMs : null,
      systemPrompt: clip(run.systemPrompt, maxFieldChars),
      prompt: clip(run.prompt, maxFieldChars),
      // Verbatim, before `parseClassifyResult` strips thinking blocks. Replaying
      // a parser change against history is only meaningful against raw text.
      rawText: clip(run.rawText, maxFieldChars),
      parsed: run.parsed || null,
      error: run.error ? String(run.error) : null,
      cancelled: run.cancelled === true,
      superseded: run.superseded === true,
      supersededReason: run.supersededReason || null,
    };
    if (!ensureDir()) return entry;
    try {
      fileSystem.appendFileSync(fileFor(key), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      log('aux_run_log_append_failed', { sessionId: key, error: error.message });
      return entry;
    }
    // Cheap check: only pay for a full read when the file could plausibly have
    // outgrown the cap.
    try {
      const { size } = fileSystem.statSync(fileFor(key));
      if (size > maxRunsPerSession * 512) rotate(key);
    } catch (_) {}
    return entry;
  }

  function list(sessionId, { limit = 0 } = {}) {
    const runs = readLines(sessionId);
    if (limit > 0 && runs.length > limit) return runs.slice(runs.length - limit);
    return runs;
  }

  function get(sessionId, runId) {
    if (!runId) return null;
    const runs = readLines(sessionId);
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      if (runs[index].runId === runId) return runs[index];
    }
    return null;
  }

  // All verdicts anchored to one message, newest last. Usually one entry; a
  // message re-judged by the periodic scan yields several, and seeing that
  // sequence is exactly what diagnosing a flapping state needs.
  function byAnchor(sessionId, messageId) {
    if (!messageId) return [];
    return readLines(sessionId).filter(run => run.anchorMessageId === messageId);
  }

  function byTask(sessionId, taskId) {
    if (!taskId) return [];
    return readLines(sessionId).filter(run => run.taskId === taskId);
  }

  // Session ids that have recorded runs — the entry point for a backtest sweep.
  function sessions() {
    try {
      return fileSystem.readdirSync(dir)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => name.slice(0, -'.jsonl'.length));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log('aux_run_log_list_sessions_failed', { dir, error: error.message });
      }
      return [];
    }
  }

  return { record, list, get, byAnchor, byTask, sessions, fileFor };
}

module.exports = {
  createAuxRunLog,
  safeSessionName,
  DEFAULT_MAX_RUNS_PER_SESSION,
  DEFAULT_MAX_FIELD_CHARS,
};
