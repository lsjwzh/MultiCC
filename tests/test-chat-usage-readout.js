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
  assert.equal(measured.text, '上下文 123.0k / 200k · 61.5%');
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
  assert.equal(view.summary.text, '上下文 123.0k');
  assert.equal(view.summary.hasBar, false);
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
  assert.match(bar.innerHTML, /上下文 123\.0k/);
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
      'usageTurnDuration', 'usageSessionTotal', 'usageSessionHint']) {
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
