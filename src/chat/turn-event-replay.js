'use strict';

// Derivation layer over the turn event journal (#110): replay journal lines
// and reconstruct turn facts — today, per-tool timing with the same
// measured/running/unknown provenance the UI renders. This is the parity leg
// of the epic: the journal is the ground truth, the persisted blob is one
// projection of it, and diffing the two catches lost turns, duplicate blobs,
// and stamp drift before they become user-visible mysteries.
//
// Shape note: both the claude path and the codex/opencode/zcode adapter path
// broadcast the SAME normalized events ({type:'assistant', message.content
// tool_use blocks} / {type:'user', message.content tool_result blocks}), so
// one derivation covers every CLI. The journal line's wall-clock `ts` is the
// timing source — tool_use arrival = startedAt, tool_result arrival = endedAt.

function contentBlocks(event) {
  const content = event && event.message && event.message.content;
  return Array.isArray(content) ? content : [];
}

// records: journal lines ({seq, ts, event}) in any order the file implies —
// callers pass them file-ordered. Returns tools ordered by first sighting.
function deriveToolTiming(records) {
  const byId = new Map();
  const order = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !record.event) continue;
    const { event, ts } = record;
    if (event.type === 'assistant') {
      for (const block of contentBlocks(event)) {
        if (!block || block.type !== 'tool_use' || !block.id) continue;
        if (!byId.has(block.id)) {
          byId.set(block.id, { id: block.id, name: block.name || '', startedAt: ts, endedAt: null, isError: false });
          order.push(block.id);
        }
      }
    } else if (event.type === 'user') {
      for (const block of contentBlocks(event)) {
        if (!block || block.type !== 'tool_result' || !block.tool_use_id) continue;
        const tool = byId.get(block.tool_use_id);
        // Results can only end tools the stream already opened; an orphan
        // result (opened pre-journal, or lost tool_use line) has no start to
        // anchor and is skipped rather than fabricated. First result wins —
        // a duplicate broadcast (WS replay) must not overwrite the real end.
        if (!tool || tool.endedAt !== null) continue;
        tool.endedAt = ts;
        tool.isError = !!block.is_error;
      }
    }
  }
  return order.map(id => byId.get(id));
}

const DEFAULT_TOLERANCE_MS = 2000;

// Compare derived tools against a persisted blob's tools array (the shape
// persistFinalAssistantResult writes: {name, id, startedAt, endedAt,
// is_error}). Returns a list of mismatch descriptors; empty means parity.
//
// Tolerances: the journal stamps at broadcast time, the blob at apply time —
// same call stack, so drift is milliseconds; tolerance absorbs replay and
// clock-jitter paths without blessing fabricated stamps.
function diffToolTiming(derivedTools, blobTools, { toleranceMs = DEFAULT_TOLERANCE_MS } = {}) {
  const mismatches = [];
  const blobById = new Map();
  for (const tool of Array.isArray(blobTools) ? blobTools : []) {
    if (tool && tool.id) blobById.set(tool.id, tool);
  }
  const seen = new Set();
  for (const d of Array.isArray(derivedTools) ? derivedTools : []) {
    seen.add(d.id);
    const b = blobById.get(d.id);
    if (!b) {
      mismatches.push({ id: d.id, kind: 'missing_from_blob', name: d.name });
      continue;
    }
    if ((b.name || '') !== d.name) {
      mismatches.push({ id: d.id, kind: 'name_mismatch', derived: d.name, blob: b.name });
    }
    const bStart = Number.isFinite(b.startedAt) ? b.startedAt : null;
    const bEnd = Number.isFinite(b.endedAt) ? b.endedAt : null;
    if (bStart === null || Math.abs(bStart - d.startedAt) > toleranceMs) {
      mismatches.push({ id: d.id, kind: 'startedAt_drift', derived: d.startedAt, blob: bStart });
    }
    if (d.endedAt === null) {
      // Derived says running/unknown. A blob that claims an end is a
      // fabrication risk worth flagging; a blob that also lacks it is fine.
      if (bEnd !== null) mismatches.push({ id: d.id, kind: 'endedAt_fabricated_in_blob', blob: bEnd });
    } else if (bEnd === null || Math.abs(bEnd - d.endedAt) > toleranceMs) {
      mismatches.push({ id: d.id, kind: 'endedAt_drift', derived: d.endedAt, blob: bEnd });
    }
    if (!!(b.is_error || b.isError) !== d.isError) {
      mismatches.push({ id: d.id, kind: 'isError_mismatch', derived: d.isError });
    }
  }
  for (const [id, b] of blobById) {
    if (!seen.has(id)) mismatches.push({ id, kind: 'missing_from_journal', name: b.name });
  }
  return mismatches;
}

// Background/subagent task trajectory from the journal: which tasks were
// still open when the journal ends (a monitor_started with progress but no
// monitor_done). After a restart those processes died with the server — this
// is the list the reconnect replay tells the danmaku about, honestly labelled
// as interrupted instead of silently disappearing or spinning forever.
//
// monitor_started/progress/done are the runtime's broadcast shapes; the
// authoritative background_tasks snapshots only refresh lastTs for tasks we
// already know (a start line that rotated away is not fabricated back —
// same first-sighting discipline as deriveToolTiming).
function deriveOpenTasks(records) {
  const tasks = new Map();
  const order = [];
  const touch = (id, fields) => {
    if (!tasks.has(id)) {
      tasks.set(id, { task_id: id, description: '', lastTs: null, ...fields });
      order.push(id);
    } else {
      Object.assign(tasks.get(id), fields);
    }
  };
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !record.event) continue;
    const { event, ts } = record;
    if (event.type === 'monitor_started' && event.task_id) {
      touch(event.task_id, {
        description: event.description || event.command || '',
        lastTs: ts,
      });
    } else if (event.type === 'monitor_progress' && event.task_id && tasks.has(event.task_id)) {
      touch(event.task_id, { lastTs: ts });
    } else if (event.type === 'monitor_done' && event.task_id) {
      tasks.delete(event.task_id);
    } else if (event.type === 'background_tasks' && Array.isArray(event.tasks)) {
      for (const t of event.tasks) {
        const id = t && (t.task_id || t.id);
        if (id && tasks.has(id)) touch(id, { lastTs: ts });
      }
    }
  }
  return order.map(id => tasks.get(id)).filter(Boolean);
}

module.exports = Object.freeze({ deriveToolTiming, diffToolTiming, deriveOpenTasks, DEFAULT_TOLERANCE_MS });
