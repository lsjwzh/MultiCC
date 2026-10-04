'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tl = require('../src/chat/turn-timeline');

const ROOT = path.join(__dirname, '..');
const se = (event, extra = {}) => ({ type: 'stream_event', event, parent_tool_use_id: null, ...extra });

test('claude stream: request -> thinking -> output -> tool -> request -> output', () => {
  const cs = { turnStartedAt: 1000 };
  tl.startTurn(cs);
  tl.observeClaude(cs, se({ type: 'message_start' }), 2500);
  tl.observeClaude(cs, se({ type: 'content_block_start', content_block: { type: 'thinking' } }), 3000);
  tl.observeClaude(cs, se({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } }), 4000);
  tl.observeClaude(cs, se({ type: 'content_block_stop' }), 5000);
  tl.observeClaude(cs, se({ type: 'content_block_start', content_block: { type: 'tool_use' } }), 5100);
  tl.observeClaude(cs, se({ type: 'content_block_delta', delta: { type: 'input_json_delta' } }), 5600);
  tl.observeClaude(cs, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } }, 5700);
  // Real CLI order: the stop frame trails the tool_use message; it must not
  // stretch the output span over the running tool.
  tl.observeClaude(cs, se({ type: 'content_block_stop' }), 5723);
  // Subagent traffic belongs to the tool span and must not open model spans.
  tl.observeClaude(cs, se({ type: 'content_block_start', content_block: { type: 'text' } }, { parent_tool_use_id: 't1' }), 6000);
  tl.observeClaude(cs, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }, 9000);
  tl.observeClaude(cs, se({ type: 'content_block_start', content_block: { type: 'text' } }), 11000);
  tl.observeClaude(cs, se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 12000);
  const snap = tl.snapshot(cs, 13000);
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
  const cs = { turnStartedAt: 0 };
  tl.startTurn(cs);
  tl.observeAdapter(cs, { type: 'assistant_text', text: 'a' }, 100);
  tl.observeAdapter(cs, { type: 'tool_start', id: 'a' }, 200);
  tl.observeAdapter(cs, { type: 'tool_start', id: 'b' }, 210);
  tl.observeAdapter(cs, { type: 'tool_result', id: 'a' }, 500);
  tl.observeAdapter(cs, { type: 'tool_result', id: 'b' }, 900);
  tl.observeAdapter(cs, { type: 'thinking', delta: true, text: 'r' }, 1500);
  tl.observeAdapter(cs, { type: 'thinking', delta: true, text: 'r' }, 1800);
  tl.observeAdapter(cs, { type: 'part_delta', delta: { type: 'text' } }, 2000);
  assert.deepEqual(tl.snapshot(cs, 2100).spans, [
    { k: 'request', s: 0, e: 100 },
    { k: 'output', s: 100, e: 100 },
    { k: 'request', s: 900, e: 1500 },
    { k: 'thinking', s: 1500, e: 1800 },
    { k: 'output', s: 2000, e: 2000 },
  ]);
});

test('tool_update opens and completes a tool; open request closes at snapshot time', () => {
  const cs = { turnStartedAt: 0, currentToolCalls: [] };
  tl.startTurn(cs);
  tl.observeAdapter(cs, { type: 'tool_update', id: 'x', completed: false }, 300);
  cs.currentToolCalls.push({ id: 'x' });
  tl.observeAdapter(cs, { type: 'tool_update', id: 'x', completed: true }, 800);
  assert.deepEqual(tl.snapshot(cs, 1000).spans, [
    { k: 'request', s: 0, e: 300 },
    { k: 'request', s: 800, e: 1000 },
  ]);
  assert.deepEqual(tl.field({}), {}, 'no timeline before a turn starts');
});

test('every persist and result path carries the timeline', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engine = read('src/chat/turn-engine.js');
  assert.match(engine, /turnTimeline\.startTurn\(cs\)/);
  assert.match(engine, /turnTimeline\.observeClaude\(cs, evt\)/);
  assert.match(engine, /turnTimeline\.observeAdapter\(cs, evt\)/);
  assert.match(engine, /\.\.\.turnTimeline\.field\(cs\) \}\);/);
  assert.match(read('src/chat/host-runtime.js'), /turnTimeline\.field\(state\)/);
  assert.match(read('src/codex/usage.js'), /turnTimeline\.field\(cs, now\(\)\)/);
  assert.match(read('src/chat/finalize-host.js'), /turnTimeline\.field\(cs, now\(\)\)/);
});
