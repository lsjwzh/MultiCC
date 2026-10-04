'use strict';

// Per-turn model timeline: the spans of a turn that are NOT tool execution.
//
//   request  — a model request is in flight and nothing has come back yet
//              (turn submit / tool results returned -> first streamed output)
//   thinking — the model is streaming reasoning
//   output   — the model is streaming answer text or tool-call arguments
//
// Tool spans already live on each persisted tool (startedAt/endedAt). Together
// they let the wall-clock trajectory strip label every stretch of a turn
// instead of leaving the model's own time as unexplained gray. One segmenter
// serves every lane: Claude stream-json (stream_event) and the normalized
// adapter events (codex, opencode, zcode, kimi, qoder, acp, ...).
//
// Wire/persist shape (absolute epoch ms, same clock as tool stamps):
//   timeline: { origin, spans: [{ k: 'request'|'thinking'|'output', s, e }] }

const MAX_SPANS = 4000;
// Same-kind frames closer than this merge into one span: streaming deltas
// arrive every few ms and a span per delta would only bloat the transcript.
const MERGE_GAP_MS = 1500;

function create(origin) {
  return { origin, spans: [{ k: 'request', s: origin, e: null }], open: new Set(), anon: 0 };
}

function startTurn(cs, now = Date.now()) {
  if (!cs) return null;
  cs.turnTimeline = create(Number.isFinite(cs.turnStartedAt) ? cs.turnStartedAt : now);
  return cs.turnTimeline;
}

function last(tl) { return tl.spans[tl.spans.length - 1] || null; }

function closeOpen(tl, t) {
  const cur = last(tl);
  if (cur && cur.e == null) cur.e = Math.max(cur.s, t);
}

function push(tl, span) {
  if (tl.spans.length >= MAX_SPANS) return;
  tl.spans.push(span);
}

// Streamed model output of `kind` observed at t.
function mark(tl, kind, t) {
  const cur = last(tl);
  if (cur && cur.k === 'request' && cur.e == null) cur.e = Math.max(cur.s, t);
  if (cur && cur.k === kind && (cur.e == null || t - cur.e <= MERGE_GAP_MS)) {
    cur.e = Math.max(cur.e == null ? cur.s : cur.e, t);
    return;
  }
  push(tl, { k: kind, s: t, e: t });
}

// A tool started: whatever the model was doing has ended.
function toolStart(tl, id, t) {
  closeOpen(tl, t);
  tl.open.add(id == null || id === '' ? `#anon${tl.anon++}` : String(id));
}

// A tool result returned. Once nothing is outstanding the CLI sends the next
// model request immediately, so a request span opens here.
function toolEnd(tl, id, t) {
  if (id != null && tl.open.has(String(id))) tl.open.delete(String(id));
  else if (tl.open.size) tl.open.delete(tl.open.values().next().value);
  if (tl.open.size) return;
  closeOpen(tl, t);
  push(tl, { k: 'request', s: t, e: null });
}

// Claude stream-json (CLI and Agent SDK lanes). Subagent traffic carries a
// parent_tool_use_id and belongs to the Task tool span, not the main model.
function observeClaude(cs, evt, t = Date.now()) {
  const tl = cs && cs.turnTimeline;
  if (!tl || !evt || typeof evt !== 'object' || evt.parent_tool_use_id) return;
  if (evt.type === 'stream_event') {
    const e = evt.event || {};
    if (e.type === 'content_block_start') {
      const bt = e.content_block && e.content_block.type;
      tl.block = bt === 'thinking' || bt === 'redacted_thinking' ? 'thinking' : 'output';
      mark(tl, tl.block, t);
    } else if (e.type === 'content_block_delta') {
      const dt = e.delta && e.delta.type;
      const kind = dt === 'thinking_delta' || dt === 'signature_delta' ? 'thinking'
        : (dt === 'text_delta' || dt === 'input_json_delta' ? 'output' : tl.block || 'output');
      mark(tl, kind, t);
    } else if (e.type === 'content_block_stop' && tl.block) {
      // The CLI emits the tool_use assistant message before this stop frame;
      // once a tool is running the output span is already closed for good.
      if (!tl.open.size) mark(tl, tl.block, t);
      tl.block = null;
    }
    return;
  }
  const content = evt.message && Array.isArray(evt.message.content) ? evt.message.content : [];
  if (evt.type === 'assistant') {
    for (const b of content) if (b && b.type === 'tool_use') toolStart(tl, b.id, t);
  } else if (evt.type === 'user') {
    for (const b of content) if (b && b.type === 'tool_result') toolEnd(tl, b.tool_use_id, t);
  }
}

// Normalized adapter events (all non-Claude lanes).
function observeAdapter(cs, evt, t = Date.now()) {
  const tl = cs && cs.turnTimeline;
  if (!tl || !evt || typeof evt !== 'object') return;
  switch (evt.type) {
    case 'thinking': mark(tl, 'thinking', t); break;
    case 'assistant_text': if (evt.text) mark(tl, 'output', t); break;
    case 'tool_start': toolStart(tl, evt.id, t); break;
    case 'tool_result': toolEnd(tl, evt.id, t); break;
    case 'tool_update': {
      const id = evt.id || `call_${(cs.currentToolCalls || []).length}`;
      if (!tl.open.has(String(id)) && !(cs.currentToolCalls || []).some(x => x && x.id === id)) toolStart(tl, id, t);
      if (evt.completed) toolEnd(tl, id, t);
      break;
    }
    case 'part_delta': {
      const d = evt.delta && typeof evt.delta === 'object' ? evt.delta : evt;
      if (d.type === 'reasoning') mark(tl, 'thinking', t);
      else if (d.type === 'text') mark(tl, 'output', t);
      break;
    }
    default: break;
  }
}

// Persistable snapshot; still-open spans are closed at `now`. Zero-length
// request spans (results that streamed back instantly) are dropped.
function snapshot(cs, now = Date.now()) {
  const tl = cs && cs.turnTimeline;
  if (!tl || !Number.isFinite(tl.origin)) return null;
  const spans = [];
  for (const sp of tl.spans) {
    const e = sp.e == null ? Math.max(sp.s, now) : sp.e;
    if (sp.k === 'request' && e - sp.s <= 0) continue;
    spans.push({ k: sp.k, s: sp.s, e });
  }
  return { origin: tl.origin, spans };
}

function field(cs, now = Date.now()) {
  const timeline = snapshot(cs, now);
  return timeline ? { timeline } : {};
}

module.exports = { MERGE_GAP_MS, startTurn, observeClaude, observeAdapter, snapshot, field, _mark: mark };
