'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rate = require('../public/chat-token-rate.js');

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; return t; } };
}

function meterAt() {
  const c = clock();
  const meter = rate.createTokenRateMeter({ now: c.now });
  return { c, meter };
}

test('the estimate counts a CJK character as a token and ~4 latin characters as one', () => {
  assert.equal(rate.estimateTokens(''), 0);
  assert.equal(rate.estimateTokens(null), 0);
  assert.equal(rate.estimateTokens('abcd'), 1);
  assert.equal(rate.estimateTokens('你好世界'), 4);
  assert.equal(rate.estimateTokens('你好 abcd'), 2 + 5 / 4);
});

test('streamed output reads as flowing tokens per second over the recent window', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  // 40 latin chars (= 10 tokens) every 250ms for 3s → 40 tok/s.
  let text = '';
  for (let i = 0; i < 12; i++) {
    c.advance(250);
    text += 'x'.repeat(40);
    meter.noteText(text);
  }
  const snap = meter.snapshot();
  assert.equal(snap.phase, 'flowing');
  assert.equal(snap.tone, 'flowing');
  assert.ok(Math.abs(snap.rate - 40) < 5, `rate ${snap.rate}`);
  assert.equal(snap.total, 120);
  assert.equal(snap.ttftMs, 250);
});

test('a young burst is measured over its own age, never inflated past one second', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  c.advance(100);
  meter.noteChunk('y'.repeat(120)); // 30 tokens in one fragment
  assert.equal(meter.snapshot().rate, 30, 'a single fragment is 30 tok over a 1s floor, not 30/0.0s');
});

test('only growth of the visible text counts, so a snapshot that repeats deltas is free', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  c.advance(200);
  meter.noteText('abcdefgh');            // 2 tokens of deltas
  meter.noteText('abcdefgh');            // authoritative snapshot: same text
  assert.equal(meter.snapshot().total, 2);
  meter.noteText('');                    // new bubble: re-anchor, not negative
  meter.noteText('abcd');
  assert.equal(meter.snapshot().total, 3);
});

test('a reconnect that restores the reply in one go re-anchors instead of spiking', () => {
  const { c, meter } = meterAt();
  const restored = 'z'.repeat(40_000);
  meter.begin(restored.length);          // the bubble already showed this
  c.advance(100);
  meter.noteText(restored + 'abcd');
  assert.equal(meter.snapshot().total, 1);
  const { meter: other } = meterAt();
  other.begin(0);
  other.noteText('q'.repeat(4 * (rate.RESYNC_TOKENS + 1)));
  assert.equal(other.snapshot().total, 0, 'an oversize jump is replay, not generation');
  assert.equal(other.snapshot().phase, 'waiting');
});

test('waiting for the first token escalates only after a large-context allowance', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  c.advance(5_000);
  assert.deepEqual([meter.snapshot().phase, meter.snapshot().tone], ['waiting', 'idle']);
  c.advance(133_000);
  assert.equal(meter.snapshot().tone, 'idle', '2m18s of prefill-sized silence is not an alarm');
  c.advance(rate.WAITING_MS[0]);
  assert.equal(meter.snapshot().tone, 'warning');
  c.advance(rate.WAITING_MS[1]);
  assert.equal(meter.snapshot().tone, 'danger');
});

test('output that stops mid-stream turns amber sooner than a slow first token', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  c.advance(500);
  meter.noteChunk('abcdabcd');
  c.advance(rate.WINDOW_MS + 1);
  let snap = meter.snapshot();
  assert.deepEqual([snap.phase, snap.tone, snap.rate], ['paused', 'idle', 0]);
  c.advance(rate.PAUSED_MS[0]);
  assert.equal(meter.snapshot().tone, 'warning');
  c.advance(rate.PAUSED_MS[1]);
  snap = meter.snapshot();
  assert.equal(snap.tone, 'danger');
  assert.ok(snap.phaseMs > rate.PAUSED_MS[1]);
});

test('a running tool or an open thinking block explains the quiet', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  c.advance(1_000);
  meter.noteChunk('{"cmd":"npm test"}');
  const toolStart = c.advance(500);
  c.advance(120_000);
  let snap = meter.snapshot({ toolRunning: true, toolSince: toolStart });
  assert.deepEqual([snap.phase, snap.tone], ['tool', 'busy']);
  assert.equal(snap.phaseMs, 120_000);
  // The tool returned: the next request is now waiting, timed from its end.
  const toolEnd = c.advance(0);
  c.advance(2_000);
  snap = meter.snapshot({ toolRunning: false, toolEndedAt: toolEnd });
  assert.deepEqual([snap.phase, snap.phaseMs, snap.tone], ['waiting', 2_000, 'idle']);
  meter.noteBlock('thinking');
  c.advance(60_000);
  snap = meter.snapshot({ toolEndedAt: toolEnd });
  assert.deepEqual([snap.phase, snap.tone], ['thinking', 'busy']);
  meter.noteBlock(null);
  assert.equal(meter.snapshot({ toolEndedAt: toolEnd }).phase, 'waiting');
});

test('running background tasks explain the quiet without escalating', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  c.advance(500);
  meter.noteChunk('abcdabcd');
  c.advance(rate.WINDOW_MS + 1);
  c.advance(rate.PAUSED_MS[1] + 1_000);
  const snap = meter.snapshot({ bgRunning: true });
  assert.deepEqual([snap.phase, snap.tone], ['bg', 'busy']);
  assert.ok(snap.phaseMs > rate.PAUSED_MS[1]);
  // The same silence with nothing running behind it stays the alarming pause.
  assert.deepEqual([meter.snapshot().phase, meter.snapshot().tone], ['paused', 'danger']);
  // Silence before any output is explained the same way.
  const { c: c2, meter: fresh } = meterAt();
  fresh.begin(0);
  c2.advance(120_000);
  assert.equal(fresh.snapshot({ bgRunning: true }).phase, 'bg');
  assert.equal(
    rate.describe({ active: true, total: 0, ttftMs: null, phase: 'bg', phaseMs: 375_000, tone: 'busy' }).text,
    '⏸ AI 请求已停 6m 15s · 后台任务执行中');
});

test('a fresh turn heartbeat explains silence the task panel cannot see', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  c.advance(500);
  meter.noteChunk('abcdabcd');
  c.advance(rate.WINDOW_MS + 1);
  c.advance(rate.PAUSED_MS[1] + 1_000);
  const tNow = c.advance(0);
  const snap = meter.snapshot({ heartbeatAt: tNow - 5_000 });
  assert.deepEqual([snap.phase, snap.tone], ['alive', 'busy']);
  // A stale beat means the runner stopped reporting: the alarm comes back.
  assert.equal(meter.snapshot({ heartbeatAt: tNow - rate.HEARTBEAT_FRESH_MS - 1 }).phase, 'paused');
  assert.equal(meter.snapshot({ heartbeatAt: 0 }).phase, 'paused');
  assert.equal(
    rate.describe({ active: true, total: 0, ttftMs: null, phase: 'alive', phaseMs: 375_000, tone: 'busy' }).text,
    '⏸ AI 请求已停 6m 15s · 任务执行中');
});

test('the exact per-request count becomes a measured rate', () => {
  const { c, meter } = meterAt();
  meter.begin(0);
  meter.noteRequest();
  c.advance(10_000);
  meter.noteUsage(500);
  assert.deepEqual(meter.snapshot().exact, { tokens: 500, ms: 10_000, rate: 50 });
  meter.noteUsage(900);                  // no request open: ignored
  assert.equal(meter.snapshot().exact.tokens, 500);
});

test('nothing is measured outside a turn, and end() hides the chip', () => {
  const { meter } = meterAt();
  meter.noteChunk('abcd');
  meter.noteText('abcd');
  assert.equal(meter.isActive(), false);
  assert.equal(rate.describe(meter.snapshot()).text, '');
  meter.begin(0);
  meter.noteChunk('abcd');
  meter.end();
  assert.equal(rate.describe(meter.snapshot()).text, '');
});

test('describe() renders every phase with its duration and a detailed tooltip', () => {
  const base = { active: true, total: 1234, ttftMs: 2100, exact: { tokens: 812, ms: 14000, rate: 58 } };
  const flowing = rate.describe({ ...base, phase: 'flowing', rate: 42.4, tone: 'flowing' });
  assert.equal(flowing.text, '⚡ 42 tok/s');
  assert.equal(flowing.tone, 'flowing');
  assert.equal(flowing.title, [
    '实时输出速度（按流式文本估算，近 3 秒）',
    '本轮已输出 ≈1.2k tokens',
    '首字耗时 2.1s',
    '上个请求实测 58 tok/s（812 tokens / 14s）',
  ].join('\n'));
  assert.equal(rate.describe({ ...base, phase: 'flowing', rate: 4.25 }).text, '⚡ 4.3 tok/s');
  assert.equal(rate.describe({ ...base, phase: 'tool', phaseMs: 12000 }).text, '🔧 工具运行 12s');
  assert.equal(rate.describe({ ...base, phase: 'thinking', phaseMs: 3500 }).text, '💭 思考中 3.5s');
  assert.equal(rate.describe({ ...base, phase: 'waiting', phaseMs: 75000, tone: 'warning' }).text, '⏳ AI 请求处理中 1m 15s');
  const paused = rate.describe({ active: true, total: 0, ttftMs: null, phase: 'paused', phaseMs: 50000, tone: 'danger' });
  assert.equal(paused.text, '⏸ 0 tok/s · AI 请求已停 50s');
  assert.equal(paused.tone, 'danger');
  assert.equal(paused.title, '实时输出速度（按流式文本估算，近 3 秒）');
});

test('the chat page ships the chip, its stylesheet and the module in load order', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/chat.html'), 'utf8');
  const row = html.slice(html.indexOf('id="usage-context-row"'), html.indexOf('id="usage-detail-pop"'));
  assert.match(row, /<span id="token-rate-bar" class="usage-summary-bar"/);
  assert.ok(html.includes('<link rel="stylesheet" href="/chat-token-rate.css" />'));
  const format = html.indexOf('<script src="shared/format.js"></script>');
  const module = html.indexOf('<script src="chat-token-rate.js"></script>');
  const controller = html.indexOf('<script src="chat-event-controller.js"></script>');
  const chat = html.indexOf('<script src="chat.js"></script>');
  assert.ok(format > 0 && format < module && module < controller && controller < chat);
  const chatJs = fs.readFileSync(path.join(__dirname, '../public/chat.js'), 'utf8');
  assert.match(chatJs, /function renderCurrentText\(final = false\) \{\n  tokenRate\?\.noteText\(currentTextContent\);/,
    'visible text is metered where the bubble renders it');
  assert.match(chatJs, /pendingUserInputController\.setConnected\(\);\n  syncTokenRate\(\);\n\}/,
    'the chip follows every streaming transition through updateUI');
  assert.match(chatJs, /\n    tokenRate,\n/, 'the event controller reports into the same meter');
  assert.match(chatJs, /bgRunning: chatBgActivity\.runningCount\(\) > 0/,
    'running background tasks feed the meter so explained silence stays neutral');
  assert.match(chatJs, /chatLiveUi\.danmakuRunningCount\(\) > 0/,
    'the panel’s spinning rows are a second source of background truth');
  assert.match(chatJs, /heartbeatAt: _turnHeartbeatAt/, 'the turn heartbeat feeds the meter');
  const liveUi = fs.readFileSync(path.join(__dirname, '../public/chat-live-ui.js'), 'utf8');
  assert.match(liveUi, /function danmakuRunningCount\(\)/, 'the panel exposes its spinning task rows');
});
