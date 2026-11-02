'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../public/chat-token-readout.js');
const { buildUsageView, createUsageReadout } = require('../public/chat-usage-readout.js');

const WINDOW = 200_000;

// The screenshot that started this: one turn whose counters sum every request
// it made, so the billed figure is far past the window.
const AGGREGATED_TURN = {
  input_tokens: 70,
  cache_read_input_tokens: 7_000_000,
  cache_creation_input_tokens: 951_800,
  output_tokens: 7_700,
};

// What message_start reports for one call: this is the context, measured.
const REQUEST = {
  input_tokens: 4,
  cache_read_input_tokens: 120_000,
  cache_creation_input_tokens: 3_000,
  output_tokens: 1,
};

test('a live request measures the context; the turn total only estimates it', () => {
  const measured = buildUsageView({
    requestUsage: REQUEST, turnUsage: AGGREGATED_TURN, contextWindow: WINDOW,
  }).summary;
  // 占用量与窗口用同一个紧凑口径（formatTokenCount + dropZeroDecimal）：123000
  // 写「123k」，跟旁边那个「200k」一样不带 .0。
  assert.equal(measured.text, '上下文 123k / 200k · 61.5%');
  assert.equal(measured.exact, true);
  assert.ok(!measured.text.includes('≈'), 'a measurement is not hedged');

  const estimated = buildUsageView({ turnUsage: AGGREGATED_TURN, contextWindow: WINDOW }).summary;
  assert.equal(estimated.exact, false);
  assert.match(estimated.text, /^上下文 ≈7\.8k \/ 200k · 约 3\.9%$/,
    'without a request block the aggregate heuristic is all we have, and it says so');
});

test('an aggregate still above the window refuses to invent a percentage', () => {
  const view = buildUsageView({
    turnUsage: { input_tokens: 3_000_000, cache_read_input_tokens: 40_000_000, output_tokens: 90_000 },
    contextWindow: WINDOW,
  });
  assert.equal(view.summary.text, '上下文 —');
  assert.equal(view.summary.hasBar, false);
  assert.match(view.summary.title, /无法据此折算/);
});

test('the default line is context and nothing else', () => {
  const view = buildUsageView({
    requestUsage: REQUEST,
    turnUsage: AGGREGATED_TURN,
    contextWindow: WINDOW,
    sessionTokens: { input: 313_000_000, output: 1_500_000 },
    providerWindows: { today: { inputTokens: 5, outputTokens: 5 } },
    providerLabel: 'Claude Official',
    turnMeta: { durationText: '4m 8s', turns: 13 },
    formatWindow: () => '新:70/出:29.6K',
  });
  assert.ok(view.summary.text.startsWith('上下文 '));
  assert.doesNotMatch(view.summary.text, /Claude Official|会话累计|turn|\$/,
    'provider windows, cumulative billing and timing never reach the default line');

  const labels = view.details.map(row => row.label);
  assert.deepEqual(labels, ['本轮计费', '本轮耗时', '会话累计', 'Claude Official 用量']);
  const joined = JSON.stringify(view.details);
  assert.doesNotMatch(joined, /\$|USD|美元/, 'no price survives anywhere in the panel');
});

test('nothing known renders nothing, so the row disappears instead of lying', () => {
  const view = buildUsageView({});
  assert.equal(view.summary.text, '');
  assert.deepEqual(view.details, []);
  assert.equal(buildUsageView(null).summary.text, '');
});

test('an unknown context window reports occupancy without a fake denominator', () => {
  const view = buildUsageView({ requestUsage: REQUEST, contextWindow: 0 });
  assert.equal(view.summary.text, '上下文 123k');
  assert.equal(view.summary.hasBar, false);
});

test('a verified trace adds a compact source link and an honest managed-only scope', () => {
  const trace = {
    traceId: 'sr-1',
    currentTask: { taskId: 'tsk-current', taskName: '当前任务' },
    sources: [{ taskId: 'tsk-source', taskName: '<source>', mode: 'refilled', messageCount: 2, estimatedTokens: 300 }],
    managedOnly: true,
  };
  const bar = fakeElement();
  const panel = fakeElement();
  const readout = createUsageReadout({ bar, panel, document: fakeElement() });
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: trace });
  assert.match(bar.innerHTML, /⌁ 引用 2/);
  bar.fire('click');
  assert.match(panel.innerHTML, /本轮引用来源/);
  assert.match(panel.innerHTML, /按需补取/);
  assert.match(panel.innerHTML, /&lt;source&gt;/);
  assert.match(panel.innerHTML, /不属于逐 token 拆分/);
});

test('graph context sources carry their own labels and excerpt bodies', async () => {
  const trace = {
    traceId: 'sr-2', currentTask: { taskId: 'tsk-current', taskName: '当前任务' },
    sources: [
      { taskId: 'tsk-parent', taskName: '父任务', mode: 'graph:parent', estimatedTokens: 12 },
      { taskId: 'tsk-parent', taskName: '父任务', mode: 'graph:memory', estimatedTokens: 30 },
    ],
  };
  let loads = 0;
  const bar = fakeElement();
  const panel = fakeElement();
  const readout = createUsageReadout({
    bar, panel, document: fakeElement(),
    loadContextTrace: async () => {
      loads += 1;
      return { ...trace, sources: [
        trace.sources[0],
        { ...trace.sources[1], excerpt: '  父任务记忆（节选）：<b>接口已对齐</b>' },
      ] };
    },
  });
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: trace });
  assert.match(bar.innerHTML, /⌁ 引用 3/);
  bar.fire('click');
  // 图谱来源不显示「N 条消息」，只显示各自的关系标签与 token 量。
  assert.match(panel.innerHTML, /图谱·父任务/);
  assert.match(panel.innerHTML, /图谱·父任务记忆/);
  assert.doesNotMatch(panel.innerHTML, /0 条消息/);
  assert.match(panel.innerHTML, /· 约 12 tokens/);
  assert.doesNotMatch(panel.innerHTML, /注入节选/, '摘要态没有节选正文');
  await panel.listeners.get('click')({ target: { closest: () => true } });
  assert.equal(loads, 1);
  assert.match(panel.innerHTML, /查看注入节选/);
  assert.match(panel.innerHTML, /&lt;b&gt;接口已对齐&lt;\/b&gt;/);
  assert.doesNotMatch(panel.innerHTML, /<b>接口已对齐/);
});

test('referenced message bodies load only on demand and remain escaped', async () => {
  const trace = {
    traceId: 'sr-1', currentTask: { taskId: 'tsk-current', taskName: 'current' },
    sources: [{ taskId: 'tsk-source', taskName: 'source', mode: 'imported', messageCount: 1 }],
  };
  let loads = 0;
  const bar = fakeElement();
  const panel = fakeElement();
  const readout = createUsageReadout({
    bar, panel, document: fakeElement(),
    loadContextTrace: async () => {
      loads += 1;
      return { ...trace, sources: [{ ...trace.sources[0], messages: [{ role: 'user', content: '<img src=x>' }] }] };
    },
  });
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: trace });
  bar.fire('click');
  assert.doesNotMatch(panel.innerHTML, /&lt;img/, 'message bodies are absent from the live manifest');
  await panel.listeners.get('click')({ target: { closest: () => true } });
  assert.equal(loads, 1);
  assert.match(panel.innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(panel.innerHTML, /<img/);
});

function fakeElement() {
  const listeners = new Map();
  return {
    innerHTML: '', title: '', style: {}, attrs: {},
    listeners,
    addEventListener(type, fn) { listeners.set(type, fn); },
    setAttribute(name, value) { this.attrs[name] = value; },
    contains() { return false; },
    fire(type, event) { listeners.get(type)?.(event || {}); },
  };
}

test('the panel opens on hover, pins on click, and never opens with nothing to show', () => {
  const bar = fakeElement();
  const panel = fakeElement();
  const readout = createUsageReadout({ bar, panel, document: fakeElement() });
  const sources = {
    requestUsage: REQUEST,
    contextWindow: WINDOW,
    sessionTokens: { input: 10, output: 5 },
  };

  readout.render(sources);
  assert.match(bar.innerHTML, /上下文 123k/);
  assert.match(bar.innerHTML, /详情/, 'the row advertises that there is more');
  assert.equal(readout.isOpen(), false);

  bar.fire('mouseenter');
  assert.equal(readout.isOpen(), true);
  assert.match(panel.innerHTML, /会话累计/);
  bar.fire('mouseleave');
  assert.equal(readout.isOpen(), false, 'an unpinned hover closes again');

  bar.fire('click');
  assert.equal(readout.isOpen(), true);
  bar.fire('mouseleave');
  assert.equal(readout.isOpen(), true, 'a click pins the panel open for touch users');
  bar.fire('click');
  assert.equal(readout.isOpen(), false);

  // Context alone: there is no panel to open, so hovering must not flash one.
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW });
  assert.doesNotMatch(bar.innerHTML, /详情/);
  bar.fire('mouseenter');
  assert.equal(readout.isOpen(), false);
});

test('the app bar answers the same question the same way, and prices nothing', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = name => fs.readFileSync(
    path.join(__dirname, '..', 'app', 'lib', name), 'utf8',
  );
  const model = app('models/usage_readout.dart');
  // Same order of trust as contextState() above: one request wins, the turn
  // total is the labelled fallback.
  assert.match(model, /class ContextReadout/);
  assert.match(model, /cacheReadTokens \+ usage\.cacheCreationTokens/);
  assert.match(model, /exact: false/, 'the aggregate branch is marked as an estimate');

  const provider = app('providers/chat_provider.dart');
  assert.match(provider, /_onMessageStart\(Map<String, dynamic>\? evt\)/,
    'the app must stop discarding the per-request usage payload');
  assert.doesNotMatch(provider, /_costText|toStringAsFixed\(4\)/,
    'no USD line survives in the app provider');

  const screen = app('screens/chat_screen.dart');
  assert.doesNotMatch(screen, /_CostBar|costText/);
  assert.match(screen, /onTap:.*_showDetail|onLongPress:.*_showDetail/s,
    'tap and long-press both open the detail dialog');

  for (const locale of ['zh', 'en']) {
    const strings = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'app', 'assets', 'i18n', `${locale}.json`), 'utf8',
    ));
    for (const key of ['contextUsage', 'usageDetailTitle', 'usageTurnBilled',
      'usageTurnDuration', 'usageSessionTotal', 'usageSessionHint',
      'usageContextSources', 'usageContextManagedScope',
      'usageContextGraphParent', 'usageContextGraphMemory',
      'usageContextGraphTask', 'usageContextExcerpt']) {
      assert.ok(strings[key], `${locale}.json is missing ${key}`);
    }
    assert.doesNotMatch(strings.usageSessionHint, /\$|USD|美元/);
  }
});

test('rendered text is escaped, so a provider label cannot inject markup', () => {
  const bar = fakeElement();
  const panel = fakeElement();
  const readout = createUsageReadout({ bar, panel, document: fakeElement() });
  readout.render({
    requestUsage: REQUEST,
    contextWindow: WINDOW,
    providerWindows: { today: {} },
    providerLabel: '<img src=x onerror=alert(1)>',
    formatWindow: () => '新:1/出:1',
  });
  bar.fire('mouseenter');
  assert.doesNotMatch(panel.innerHTML, /<img/);
  assert.match(panel.innerHTML, /&lt;img/);
});

test('memory manifests with no task id retain distinct excerpts, managed budget and omission reasons', async () => {
  const trace = { traceId: 'mem', currentTask: { taskId: 'self' }, budget: { used: 450, limit: 8000 },
    retained: [{ id: 'prior' }], omitted: [{ id: '<omitted>', reason: 'budget' }], sources: [
      { id: 'memory:a', mode: 'memory:shared', path: 'shared/a.md', version: '111111111111', taskName: 'a', truncated: true },
      { id: 'memory:b', mode: 'memory:shared', path: 'shared/b.md', version: '222222222222', taskName: 'b' },
    ] };
  const bar = fakeElement(), panel = fakeElement();
  const readout = createUsageReadout({ bar, panel, document: fakeElement(), loadContextTrace: async () => ({ ...trace,
    sources: trace.sources.map((s, i) => ({ ...s, excerpt: `excerpt ${i} <script>` })) }) });
  readout.render({ contextTrace: trace }); bar.fire('click');
  assert.match(panel.innerHTML, /450 \/ 8000/); assert.match(panel.innerHTML, /记忆·目录/);
  assert.match(panel.innerHTML, /已截断/); assert.match(panel.innerHTML, /&lt;omitted&gt;/);
  assert.doesNotMatch(panel.innerHTML, /0 条消息/);
  await panel.listeners.get('click')({ target: { closest: () => true } });
  assert.match(panel.innerHTML, /excerpt 0 &lt;script&gt;/); assert.match(panel.innerHTML, /excerpt 1 &lt;script&gt;/);
});

// ── 摘要 trace：新消息只内嵌 count，明细在展开时按需拉 ─────────────────────────────

const flush = () => new Promise(resolve => setImmediate(resolve));

// 后端新消息内嵌的形状：没有 sources / retained / omitted / diagnostics。
const SUMMARY = {
  version: 1, traceId: 'sr-sum', currentTask: { taskId: 'tsk-current', taskName: '当前任务', mode: 'native' },
  managedOnly: true, summary: true, count: 124, budget: { limit: 8000, used: 450, managedOnly: true },
  contextStatus: 'sent',
};

// 明细接口（不带 include）回的完整对象；not_relevant 只在 omittedCounts 里。
function fullDetail(extra = {}) {
  return {
    version: 1, traceId: 'sr-sum', currentTask: SUMMARY.currentTask, managedOnly: true,
    budget: SUMMARY.budget, contextStatus: 'sent',
    sources: [
      { id: 'memory:a', mode: 'memory:shared', path: 'shared/a.md', version: '111111111111', taskName: '记忆 A', estimatedTokens: 40 },
      { id: 'graph:parent:tsk-p', mode: 'graph:parent', taskId: 'tsk-p', taskName: '父任务', estimatedTokens: 12, retained: true },
    ],
    retained: [{ id: 'graph:parent:tsk-p' }],
    omitted: [{ id: 'memory:big', reason: 'budget' }],
    omittedCounts: { not_relevant: 123, budget: 1 },
    diagnostics: [{ path: 'shared/bad.md', reason: 'unreadable' }],
    ...extra,
  };
}

function mountReadout(loadContextTrace) {
  const bar = fakeElement();
  const panel = fakeElement();
  const readout = createUsageReadout({ bar, panel, document: fakeElement(), loadContextTrace });
  return { bar, panel, readout };
}

test('a legacy full trace renders exactly as before and never fetches on open', async () => {
  const trace = {
    traceId: 'sr-old', currentTask: { taskId: 'tsk-current', taskName: '当前任务' }, budget: { used: 450, limit: 8000 },
    retained: [{ id: 'prior' }], omitted: [{ id: 'memory:x', reason: 'budget' }, { id: 'memory:y', reason: 'not_relevant' }],
    diagnostics: [{ path: 'shared/bad.md', reason: 'unreadable' }],
    sources: [{ taskId: 'tsk-source', taskName: '源任务', mode: 'refilled', messageCount: 2, estimatedTokens: 300 }],
  };
  const calls = [];
  const { bar, panel, readout } = mountReadout(async (t, options) => { calls.push(options); return trace; });
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: trace });
  assert.match(bar.innerHTML, /⌁ 引用 2/);
  bar.fire('click');
  await flush();
  assert.deepEqual(calls, [], 'an embedded full trace already carries its detail');
  assert.match(panel.innerHTML, /托管上下文：约 450 \/ 8000 tokens · 沿用 1 项 · 省略 2 项/);
  // 逐条清单里的原因原样显示（不翻译、不加计数行）。
  assert.match(panel.innerHTML, /memory:x · budget/);
  assert.match(panel.innerHTML, /memory:y · not_relevant/);
  assert.doesNotMatch(panel.innerHTML, /与本轮无关|条<\/div>/);
  assert.match(panel.innerHTML, /按需补取 · 2 条消息 · 约 300 tokens/);
  assert.match(panel.innerHTML, /查看引用内容/);
  assert.doesNotMatch(panel.innerHTML, /较早|已清理|正在读取/);
});

test('a summary trace shows its count without any source arrays', () => {
  const { bar, readout } = mountReadout();
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: SUMMARY });
  assert.match(bar.innerHTML, /⌁ 引用 124/);
  assert.equal(bar.attrs['aria-label'], '上下文占用详情，124 个可追溯来源');
  // 摘要里没有 count 或 count 不合法时，退回「1 + 来源数」，不显示 NaN。
  const { bar: bar2, readout: readout2 } = mountReadout();
  readout2.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: { ...SUMMARY, count: 'many' } });
  assert.match(bar2.innerHTML, /⌁ 引用 1/);
  assert.doesNotMatch(bar2.innerHTML, /NaN/);
});

test('opening a summary trace fetches the detail once, without messages, and renders it as a full trace', async () => {
  const calls = [];
  let release;
  const { bar, panel, readout } = mountReadout((trace, options) => {
    calls.push({ traceId: trace.traceId, ...options });
    return new Promise(resolve => { release = () => resolve(fullDetail()); });
  });
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: SUMMARY });
  assert.deepEqual(calls, [], 'a closed panel fetches nothing');

  bar.fire('click');
  assert.deepEqual(calls, [{ traceId: 'sr-sum', includeMessages: false }]);
  // 读取中：当前任务行 + 预算，但不把还没拿到的沿用 / 省略数字写成 0。
  assert.match(panel.innerHTML, /正在读取…/);
  assert.match(panel.innerHTML, /托管上下文：约 450 \/ 8000 tokens/);
  assert.doesNotMatch(panel.innerHTML, /沿用 0 项|省略 0 项/);
  assert.doesNotMatch(panel.innerHTML, /记忆 A/);

  release();
  await flush();
  assert.doesNotMatch(panel.innerHTML, /正在读取…/);
  assert.match(panel.innerHTML, /记忆·目录 · 约 40 tokens/);
  assert.match(panel.innerHTML, /记忆 A/);
  assert.match(panel.innerHTML, /父任务/);
  assert.match(panel.innerHTML, /沿用（本轮未重发）/);
  // 省略总数：预算类逐条列出又在计数里，同一原因只算一次；与本轮无关 123 条只在计数里。
  assert.match(panel.innerHTML, /沿用 1 项 · 省略 124 项/);
  assert.match(panel.innerHTML, /shared\/bad\.md unreadable/);
  assert.match(panel.innerHTML, /查看引用内容/, 'message bodies still need the explicit button');

  // 收起再展开，或悬停抖动，都不再重复拉取。
  bar.fire('click');
  bar.fire('click');
  bar.fire('mouseenter');
  await flush();
  assert.equal(calls.length, 1);
  assert.match(bar.innerHTML, /⌁ 引用 124/, 'the bar keeps the count the summary declared');
});

test('the view-content button on an expanded summary still pulls include=messages', async () => {
  const calls = [];
  const { bar, panel, readout } = mountReadout(async (trace, options) => {
    calls.push(options);
    return options.includeMessages
      ? fullDetail({ sources: fullDetail().sources.map((s, i) => ({ ...s, excerpt: `节选 ${i} <b>` })) })
      : fullDetail();
  });
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: SUMMARY });
  bar.fire('click');
  await flush();
  assert.doesNotMatch(panel.innerHTML, /节选 0/);
  await panel.listeners.get('click')({ target: { closest: () => true } });
  assert.deepEqual(calls, [{ includeMessages: false }, { includeMessages: true }]);
  assert.match(panel.innerHTML, /节选 0 &lt;b&gt;/);
  assert.match(panel.innerHTML, /节选 1 &lt;b&gt;/);
  assert.doesNotMatch(panel.innerHTML, /<b>/);
  assert.match(panel.innerHTML, /记忆 A/, 'rows stay put while the bodies arrive');
});

test('a failed detail fetch shows the error and waits for an explicit retry', async () => {
  let attempts = 0;
  const { bar, panel, readout } = mountReadout(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('boom <x>');
    return fullDetail();
  });
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: SUMMARY });
  bar.fire('click');
  await flush();
  assert.match(panel.innerHTML, /boom &lt;x&gt;/);
  assert.match(panel.innerHTML, /usage-context-load[^>]*>重试</);
  assert.doesNotMatch(panel.innerHTML, /正在读取/);

  bar.fire('click');
  bar.fire('click');
  await flush();
  assert.equal(attempts, 1, 'reopening must not hammer a failing endpoint');

  await panel.listeners.get('click')({ target: { closest: () => true } });
  assert.equal(attempts, 2);
  assert.match(panel.innerHTML, /记忆 A/);
  assert.doesNotMatch(panel.innerHTML, /boom/);

  // 返回空体也是失败，不能卡在「读取中」或无限重拉。
  const empty = mountReadout(async () => null);
  empty.readout.render({ contextTrace: SUMMARY });
  empty.bar.fire('click');
  await flush();
  assert.match(empty.panel.innerHTML, /引用内容读取失败/);
});

test('a detail that lands after a newer turn arrived is dropped', async () => {
  const pending = [];
  const { bar, panel, readout } = mountReadout((trace) => new Promise(resolve => {
    pending.push(() => resolve(fullDetail({ traceId: trace.traceId, sources: [{ id: `memory:${trace.traceId}`, mode: 'memory:task', taskName: `来自 ${trace.traceId}` }] })));
  }));
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: SUMMARY });
  bar.fire('click');
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: { ...SUMMARY, traceId: 'sr-next', count: 3 } });
  assert.equal(pending.length, 2, 'the open panel fetches the new turn right away');
  pending[0]();
  await flush();
  assert.doesNotMatch(panel.innerHTML, /来自 sr-sum/);
  assert.match(panel.innerHTML, /正在读取…/);
  pending[1]();
  await flush();
  assert.match(panel.innerHTML, /来自 sr-next/);
  assert.doesNotMatch(panel.innerHTML, /来自 sr-sum/);
});

test('an expired detail says so, lists omissions by reason, and does not invent fields for thin sources', async () => {
  const detail = fullDetail({
    detailExpired: true,
    retained: [], omitted: [{ id: 'memory:big', reason: 'budget' }],
    omittedCounts: { not_relevant: 12345, duplicate_in_native: 2, '<odd>': 1, budget: 0, bogus: 'x' },
    sources: [
      { id: 'memory:gone', version: 'abcdef0123456789', reason: 'scope_default', retained: true },
      { id: 'memory:a', mode: 'memory:shared', path: 'shared/a.md', version: '111111111111', taskName: '记忆 A' },
    ],
  });
  const { bar, panel, readout } = mountReadout(async () => detail);
  readout.render({ requestUsage: REQUEST, contextWindow: WINDOW, contextTrace: SUMMARY });
  bar.fire('click');
  await flush();
  const html = panel.innerHTML;
  assert.match(html, /这一轮较早，沿用与省略明细已清理，仅保留实际注入的来源/);
  assert.ok(html.indexOf('这一轮较早') < html.indexOf('memory:gone'), 'the note sits above the source list');
  assert.match(html, /查看省略原因/);
  assert.match(html, /与本轮无关 12,345 条/);
  assert.match(html, /原生历史中已有 2 条/);
  assert.match(html, /&lt;odd&gt; 1 条/, 'an unknown reason is shown as-is and escaped');
  assert.doesNotMatch(html, /超出上下文预算 0|bogus/, 'zero and non-numeric counts are ignored');
  assert.match(html, /memory:big · budget/, 'itemised omissions keep listing');
  assert.match(html, /省略 12349 项/, 'total = 12345 + 2 + 1 counted, plus the one itemised budget entry');
  // 只剩 id/version/reason 的来源：不编造「初始化导入 · 0 条消息」，只显示实际有的信息。
  const rowStart = html.lastIndexOf('<div class="usage-context-source">', html.indexOf('memory:gone'));
  const thin = html.slice(rowStart, html.indexOf('</div>', rowStart));
  assert.match(thin, /沿用（本轮未重发） · v abcdef012345/);
  assert.match(thin, /<small>scope_default<\/small>/);
  assert.doesNotMatch(thin, /初始化导入|0 条消息|<strong><\/strong>/);
  // 完整来源照旧。
  assert.match(html, /记忆·目录 · v 111111111111/);
  assert.match(html, /<strong>记忆 A<\/strong><code>shared\/a\.md<\/code>/);

  // 没过期的明细不出这句提示。
  const fresh = mountReadout(async () => fullDetail());
  fresh.readout.render({ contextTrace: SUMMARY });
  fresh.bar.fire('click');
  await flush();
  assert.doesNotMatch(fresh.panel.innerHTML, /较早，沿用与省略明细已清理/);
  assert.match(fresh.panel.innerHTML, /与本轮无关 123 条/);
});

test('the web chat loader asks for include=messages only when bodies are wanted', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  assert.match(chat, /loadContextTrace: \(trace, \{ includeMessages = true \} = \{\}\)/,
    'a caller that passes no options keeps the old include=messages behaviour');
  assert.match(chat, /\$\{includeMessages \? '&include=messages' : ''\}/);
  assert.match(chat, /\/api\/sessions\/\$\{encodeURIComponent\(_sessionName\)\}\/context\?traceId=/);
});
