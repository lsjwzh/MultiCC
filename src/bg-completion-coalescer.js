'use strict';

// Coalesce background-task completion nudges.
//
// When several bg tasks (Monitor / run_in_background Bash) belonging to ONE
// session finish within a short window, the old path woke the session once per
// task — N separate turns, each often just noting "nothing to do". This is the
// per-taskId dedup gap made concrete: TaskOutput(block=true) on one task never
// suppresses the completion nudges of the OTHER concurrent tasks (they are new
// information the session never pulled), so each one fired its own turn.
//
// This batches a session's completions over a small fixed window and emits ONE
// nudge — merged when >1 — cutting the turn amplification WITHOUT hiding any
// completion (every task is listed). It deliberately does NOT do session-level
// suppression: a completion the model never consumed must still reach it, or the
// session stalls waiting on a task it will never hear finished.
//
// Pure + injectable: the timer and the flush sink are passed in, so it
// unit-tests deterministically with a fake clock.

const DEFAULT_WINDOW_MS = 1500;
const MERGED_SNIPPET_CAP = 800; // per-task output cap when merging, keeps the combined nudge bounded

function createCoalescer({ windowMs = DEFAULT_WINDOW_MS, onFlush, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof onFlush !== 'function') throw new Error('createCoalescer: onFlush is required');
  const pending = new Map(); // session -> { items: [{desc,status,snippet,taskId?,toolUseId?}], timer }

  function add(session, item) {
    let p = pending.get(session);
    if (!p) {
      // The window starts at the FIRST completion (fixed, not debounced) so a
      // steady trickle of completions can never defer the flush indefinitely.
      p = { items: [], timer: setTimer(() => flush(session), windowMs) };
      pending.set(session, p);
    }
    p.items.push(item);
  }

  function flush(session) {
    const p = pending.get(session);
    if (!p) return;
    pending.delete(session);
    if (p.timer) clearTimer(p.timer);
    if (p.items.length) onFlush(session, p.items);
  }

  // Drop buffered completions for a session without flushing (e.g. teardown).
  function cancel(session) {
    const p = pending.get(session);
    if (!p) return false;
    if (p.timer) clearTimer(p.timer);
    pending.delete(session);
    return true;
  }

  function pendingCount(session) {
    const p = pending.get(session);
    return p ? p.items.length : 0;
  }

  return { add, flush, cancel, pendingCount };
}

// Build the nudge text. Single completion reproduces the legacy wording verbatim
// (back-compat for classifiers / any string matching); multiple are merged into
// one bounded summary that still lists every task.
function buildNudge(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  if (items.length === 1) {
    const { desc, status, snippet } = items[0];
    const outLine = snippet
      ? `\n以下是它的输出，请据此继续推进任务，不要重复已完成的步骤：\n${snippet}`
      : '\n（无输出）请据此继续推进任务。';
    const id = items[0].taskId || items[0].toolUseId;
    const ref = id ? ` [ref:${id}]` : '';
    return `【后台任务完成】你之前启动的后台任务（${desc}）已结束（状态：${status}）。${outLine}${ref}`;
  }
  const blocks = items.map((it, i) => {
    const n = i + 1;
    if (!it.snippet) return `${n}. （${it.desc}）状态：${it.status}——（无输出）`;
    const s = it.snippet.length > MERGED_SNIPPET_CAP ? it.snippet.slice(-MERGED_SNIPPET_CAP) : it.snippet;
    const indented = s.replace(/\n/g, '\n   ');
    return `${n}. （${it.desc}）状态：${it.status}——输出：\n   ${indented}`;
  });
  const ids = items.map(it => it.taskId || it.toolUseId).filter(Boolean);
  const ref = ids.length ? ` [refs:${ids.join(',')}]` : '';
  return `【后台任务完成 ×${items.length}】你之前启动的多个后台任务已先后结束，请据此一并推进、不要重复已完成的步骤：\n${blocks.join('\n')}${ref}`;
}

module.exports = { createCoalescer, buildNudge, DEFAULT_WINDOW_MS, MERGED_SNIPPET_CAP };
