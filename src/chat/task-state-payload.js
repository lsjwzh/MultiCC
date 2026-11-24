'use strict';

// The single task_state wire contract. Two producers send this frame — the
// connect-time seed (src/chat/task-state-seed.js) and the live broadcast of
// the task-state store (src/routes/task-state-store.js, the one server.js
// runs) — and a page that reopens must see exactly what a live page sees. They
// once drifted: the seed omitted apiError, so the API-error bar existed only
// while the failing turn was on screen and vanished on reload even though the
// envelope was persisted.
//
// The contract now has one owner, `multicc_core::chat_task_state_frame`, so
// the two producers cannot drift again. This module supplies the two readings
// the kernel cannot derive — the persisted short code and the live Aux health
// — and forwards the rest.

const { getNative, auxVerdictStaleness } = require('../native/runtime');
const { taskShortCode } = require('../classify/task-short-code');

// `taskShortCode` reads (and can mint into) the persisted registry and
// `auxVerdictStaleness` reads live Aux health, so both are resolved here and
// passed in as facts. The staleness fields were spread LAST in the retired
// object literal, so a task record carrying its own `auxUnhealthy` could never
// win over the live reading; the kernel keeps that precedence.
function frameFacts(task) {
  const shortCode = taskShortCode((task || {}).taskId);
  const staleness = auxVerdictStaleness();
  return {
    taskShortCode: shortCode || '',
    auxUnhealthy: staleness.auxUnhealthy,
    auxUnhealthySince: staleness.auxUnhealthySince,
  };
}

function taskStatePayload(task) {
  const payload = JSON.parse(getNative().chatTaskStatePayload(JSON.stringify({
    task: task == null ? undefined : task,
    facts: frameFacts(task),
  })));
  // Rust 选择是否携带错误信封，宿主保留原对象引用。
  if (payload.apiError !== null) payload.apiError = task.apiError;
  return payload;
}

module.exports = { taskStatePayload };
