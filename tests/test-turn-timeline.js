'use strict';

// Turn timeline through the JS facade over the Rust owner. The spans live in
// the Rust state keyed by session name (no `cs.turnTimeline` any more), so every
// call carries the session name the host already has.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tl = require('../src/chat/turn-progress');

const ROOT = path.join(__dirname, '..');
const se = (event, extra = {}) => ({ type: 'stream_event', event, parent_tool_use_id: null, ...extra });

test('claude stream: request -> thinking -> output -> tool -> request -> output', () => {
  const session = 'timeline-claude';
  const cs = { turnStartedAt: 1000 };
  tl.startTurn(session, cs);
  tl.observeClaude(session, cs, se({ type: 'message_start' }), 2500);
  tl.observeClaude(session, cs, se({ type: 'content_block_start', content_block: { type: 'thinking' } }), 3000);
  tl.observeClaude(session, cs, se({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } }), 4000);
  tl.observeClaude(session, cs, se({ type: 'content_block_stop' }), 5000);
  tl.observeClaude(session, cs, se({ type: 'content_block_start', content_block: { type: 'tool_use' } }), 5100);
  tl.observeClaude(session, cs, se({ type: 'content_block_delta', delta: { type: 'input_json_delta' } }), 5600);
  tl.observeClaude(session, cs, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } }, 5700);
  // Real CLI order: the stop frame trails the tool_use message; it must not
  // stretch the output span over the running tool.
  tl.observeClaude(session, cs, se({ type: 'content_block_stop' }), 5723);
  // Subagent traffic belongs to the tool span and must not open model spans.
  tl.observeClaude(session, cs, se({ type: 'content_block_start', content_block: { type: 'text' } }, { parent_tool_use_id: 't1' }), 6000);
  tl.observeClaude(session, cs, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }, 9000);
  tl.observeClaude(session, cs, se({ type: 'content_block_start', content_block: { type: 'text' } }), 11000);
  tl.observeClaude(session, cs, se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 12000);
  const snap = tl.snapshot(session, cs, 13000);
  assert.equal(snap.origin, 1000);
  assert.deepEqual(snap.spans, [
    { k: 'request', s: 1000, e: 3000 },
    { k: 'thinking', s: 3000, e: 5000 },
    { k: 'output', s: 5100, e: 5600 },
    { k: 'request', s: 9000, e: 11000 },
    { k: 'output', s: 11000, e: 12000 },
  ]);
});

test('parallel tools open the next request only after the last result', () => {
  const session = 'timeline-parallel';
  const cs = { turnStartedAt: 0 };
  tl.startTurn(session, cs);
  tl.observeAdapter(session, cs, { type: 'assistant_text', text: 'a' }, 100);
  tl.observeAdapter(session, cs, { type: 'tool_start', id: 'a' }, 200);
  tl.observeAdapter(session, cs, { type: 'tool_start', id: 'b' }, 210);
  tl.observeAdapter(session, cs, { type: 'tool_result', id: 'a' }, 500);
  tl.observeAdapter(session, cs, { type: 'tool_result', id: 'b' }, 900);
  tl.observeAdapter(session, cs, { type: 'thinking', delta: true, text: 'r' }, 1500);
  tl.observeAdapter(session, cs, { type: 'thinking', delta: true, text: 'r' }, 1800);
  tl.observeAdapter(session, cs, { type: 'part_delta', delta: { type: 'text' } }, 2000);
  assert.deepEqual(tl.snapshot(session, cs, 2100).spans, [
    { k: 'request', s: 0, e: 100 },
    { k: 'output', s: 100, e: 100 },
    { k: 'request', s: 900, e: 1500 },
    { k: 'thinking', s: 1500, e: 1800 },
    { k: 'output', s: 2000, e: 2000 },
  ]);
});

test('tool_update opens and completes a tool; open request closes at snapshot time', () => {
  const session = 'timeline-tool-update';
  const cs = { turnStartedAt: 0, currentToolCalls: [] };
  tl.startTurn(session, cs);
  tl.observeAdapter(session, cs, { type: 'tool_update', id: 'x', completed: false }, 300);
  cs.currentToolCalls.push({ id: 'x' });
  tl.observeAdapter(session, cs, { type: 'tool_update', id: 'x', completed: true }, 800);
  assert.deepEqual(tl.snapshot(session, cs, 1000).spans, [
    { k: 'request', s: 0, e: 300 },
    { k: 'request', s: 800, e: 1000 },
  ]);
  assert.deepEqual(tl.field('timeline-never-started', {}, 1000), {}, 'no timeline before a turn starts');
});

test('forget drops the per-session timeline (chat-session delete hook)', () => {
  const session = 'timeline-forget';
  tl.startTurn(session, { turnStartedAt: 500 });
  assert.equal(tl.snapshot(session, { turnStartedAt: 500 }, 600).origin, 500);
  assert.equal(tl.forget(session), true);
  assert.equal(tl.snapshot(session, { turnStartedAt: 500 }, 600), null);
  assert.equal(tl.forget(session), false);
});

test('every persist and result path carries the timeline (source guard)', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engine = read('src/chat/turn-engine.js');
  // One Rust owner: the old per-cs timeline module is gone from production.
  assert.doesNotMatch(engine, /require\(['"]\.\/turn-timeline['"]\)/);
  assert.doesNotMatch(engine, /turnTimeline\.startTurn\(cs\)/);
  assert.match(engine, /turnTimeline\.startTurn\(sessionName, cs\)/);
  // The observers are wired through the native reducer's port table, and the
  // reducer passes the session name it already owns as the trailing argument.
  assert.match(engine, /observeClaude: \(cs, event, session\) => turnTimeline\.observeClaude\(session, cs, event\)/);
  assert.match(engine, /observeAdapter: \(cs, event, session\) => turnTimeline\.observeAdapter\(session, cs, event\)/);
  assert.match(engine, /timelineField: \(cs, session\) => turnTimeline\.field\(session, cs\)/);
  // Result/persist readers carry the session name they already have.
  assert.match(read('src/chat/host-runtime.js'), /timelineField\(sessionId, state\)/);
  assert.match(read('src/codex/usage.js'), /timelineField\(sessionName, cs, now\(\)\)/);
  assert.match(read('src/chat/finalize-host.js'), /chatExecuteTurnFinalization\(plan, rawContext, ports, runtime\)/);
  assert.match(read('native/addon/src/chat_finalize_execution.rs'),
    /c"timelineField",\s*&\[session, cs, self\.runtime\(c"now", &\[\]\)\?\]/);
});

test('currentStage: request -> thinking -> output -> tool -> request across lanes', () => {
  const session = 'timeline-stage-claude';
  const claude = { cli: 'claude', turnStartedAt: 1000 };
  tl.startTurn(session, claude);
  assert.equal(tl.currentStage(session, claude, 1200).stage, 'request');
  assert.equal(tl.currentStage(session, claude, 1200).precise, true, 'claude streams partials from t0');
  tl.observeClaude(session, claude, se({ type: 'content_block_start', content_block: { type: 'thinking' } }), 2000);
  assert.equal(tl.currentStage(session, claude, 2100).stage, 'thinking');
  tl.observeClaude(session, claude, se({ type: 'content_block_start', content_block: { type: 'text' } }), 3000);
  assert.equal(tl.currentStage(session, claude, 3100).stage, 'output');
  tl.observeClaude(session, claude, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } }, 3200);
  assert.equal(tl.currentStage(session, claude, 3300).stage, 'tool');
  tl.observeClaude(session, claude, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }, 4000);
  assert.equal(tl.currentStage(session, claude, 4100).stage, 'request');

  // A completed-block-only lane (codex-style) is imprecise until a delta shows up.
  const codexSession = 'timeline-stage-codex';
  const codex = { cli: 'codex', turnStartedAt: 1000 };
  tl.startTurn(codexSession, codex);
  assert.deepEqual(
    (({ stage, precise }) => ({ stage, precise }))(tl.currentStage(codexSession, codex, 1500)),
    { stage: 'request', precise: false },
  );
  tl.observeAdapter(codexSession, codex, { type: 'thinking', text: 'x' }, 2000);
  assert.equal(tl.currentStage(codexSession, codex, 2100).stage, 'thinking');
  assert.equal(tl.currentStage(codexSession, codex, 2100).precise, false);
  tl.observeAdapter(codexSession, codex, { type: 'part_delta', delta: { type: 'text' } }, 2500);
  assert.equal(tl.currentStage(codexSession, codex, 2600).precise, true);
  assert.equal(tl.currentStage('timeline-stage-none', {}, 1), null);
});
