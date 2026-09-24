'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const editor = require('../public/auto-provider-editor');
const serverContract = require('../src/providers/auto-provider-config');

function providers() {
  return [
    { id: 'official', name: 'Official', protocol: 'anthropic', isOfficial: true },
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a', modelOptions: ['model-a', 'model-a-fast'] },
    { id: 'managed-b', name: 'Managed B', protocol: 'anthropic', model: 'model-b' },
    { id: 'managed-c', name: 'Managed C', protocol: 'anthropic', model: 'model-c' },
    { id: 'chat-a', name: 'Chat A', apiFormat: 'openai_chat', model: 'chat-model' },
  ];
}

class FakeClassList {
  constructor(node) { this.node = node; }
  add(...names) { for (const name of names) if (name) this.node._classes.add(name); }
  remove(...names) { for (const name of names) this.node._classes.delete(name); }
  contains(name) { return this.node._classes.has(name); }
}

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this._classes = new Set();
    this.classList = new FakeClassList(this);
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }

  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  get className() { return [...this._classes].join(' '); }

  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }

  appendChild(node) {
    // Like the DOM: a node lives in one place, so appending moves it.
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node);
    this.children.push(node);
    node.parentNode = this;
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string'
      ? this.ownerDocument.createTextNode(node) : node);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }

  get innerText() { return this.textContent + this.children.map(child => child.innerText).join(''); }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type, target: this });
  }

  focus() { this.ownerDocument.activeElement = this; }

  matches(selector) {
    return selector.startsWith('.') && this.classList.contains(selector.slice(1));
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fakeDocument() {
  const document = {
    activeElement: null,
    createElement(tag) { return new FakeNode(tag, document); },
    createTextNode(text) {
      const node = new FakeNode('#text', document);
      node.textContent = String(text);
      return node;
    },
    getElementById(id) {
      const scan = node => {
        if (node.id === id) return node;
        for (const child of node.children) {
          const found = scan(child);
          if (found) return found;
        }
        return null;
      };
      return scan(document.head) || scan(document.body);
    },
  };
  document.head = document.createElement('head');
  document.body = document.createElement('body');
  return document;
}

test('browser Auto Provider constants stay aligned with the server contract', () => {
  assert.equal(editor.MAX_CANDIDATES, serverContract.MAX_CANDIDATES);
  assert.equal(editor.MAX_ATTEMPTS, serverContract.MAX_ATTEMPTS);
  assert.equal(editor.MAX_TIERS, serverContract.MAX_TIERS);
  assert.equal(editor.ROUTING_API_KEY_NAME, serverContract.DEFAULT_ROUTING_API_KEY);
  assert.deepEqual(editor.PROTOCOLS, [...serverContract.PROTOCOLS]);
  // The gateway names and the custom rules are mirrored, not shared: the page
  // must offer exactly the names the server accepts, and must not be the weaker
  // of the two readers when it rejects an address.
  assert.deepEqual(editor.ROUTING_GATEWAYS, [...serverContract.ROUTING_GATEWAYS]);
  assert.deepEqual(Object.keys(editor.ROUTING_GATEWAY_INFO), [...serverContract.ROUTING_GATEWAYS]);
  assert.equal(editor.CUSTOM_ROUTING_MODEL, serverContract.DEFAULT_CUSTOM_ROUTING_MODEL);
  assert.equal(editor.MAX_ROUTING_ENDPOINT_CHARS, serverContract.MAX_ROUTING_ENDPOINT_CHARS);
  assert.equal(editor.CUSTOM_ROUTING_GATEWAY, serverContract.CUSTOM_ROUTING_GATEWAY);
  assert.equal(editor.DEFAULT_ROUTING_GATEWAY, serverContract.DEFAULT_ROUTING_GATEWAY);
  // The per-gateway vault entries are the server's own defaults.
  assert.equal(editor.ROUTING_GATEWAY_INFO.custom.keyName, serverContract.DEFAULT_CUSTOM_ROUTING_API_KEY);
  assert.equal(editor.routingGatewayOf('nope'), serverContract.DEFAULT_ROUTING_GATEWAY);
  // Same address rule, same verdicts — an address this page accepts is one the
  // server would too, and vice versa.
  for (const endpoint of [
    'https://jev.example/v1/evaluate', 'http://127.0.0.1:8080/e', 'http://localhost/e', 'http://[::1]/e',
    '', 'not a url', 'http://jev.example/e', 'https://user:pw@jev.example/e', `https://x.example/${'y'.repeat(400)}`,
  ]) {
    assert.equal(editor.customEndpointError(endpoint) === '', serverContract.customEndpointError(endpoint) === null,
      endpoint);
  }
});

test('protocol helpers expose only concrete same-protocol pools', () => {
  assert.equal(editor.protocolOf({ apiFormat: 'openai_chat' }), 'openai_responses');
  assert.equal(editor.protocolOf({ protocol: 'unknown' }), null);
  assert.equal(editor.optionValue('anthropic'), '__auto__:anthropic');
  assert.equal(editor.optionValue('unknown'), '');
  assert.equal(editor.protocolFromValue('__auto__:openai_responses'), 'openai_responses');
  assert.equal(editor.protocolFromValue('__auto__:unknown'), null);
  assert.deepEqual(editor.providersForProtocol(providers(), 'anthropic').map(item => item.id),
    ['official', 'managed-a', 'managed-b', 'managed-c']);
  assert.deepEqual(editor.availableProtocols(providers()), [{
    protocol: 'anthropic', label: 'Anthropic Messages', count: 4, managedCount: 3,
  }]);
});

test('a new pool enables only the first two user-managed providers', () => {
  const selection = editor.defaultSelection(providers(), 'anthropic');
  assert.deepEqual(selection, {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true },
      { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true },
    ],
    maxAttempts: 2,
    sticky: true,
    allowCrossTrust: false,
  });
  assert.equal(editor.defaultSelection([
    { id: 'official', protocol: 'anthropic', isOfficial: true },
    { id: 'only-managed', protocol: 'anthropic' },
  ], 'anthropic'), null, 'Official routes must never be enabled implicitly');
});

test('serializeDraft keeps enabled candidates only, orders priorities and clamps attempts', () => {
  const result = editor.serializeDraft({
    protocol: 'anthropic',
    providers: providers(),
    candidates: [
      { providerId: 'managed-a', model: '', priority: 9, enabled: true },
      { providerId: 'managed-c', model: 'model-c', priority: 1, enabled: false },
      { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true },
    ],
    maxAttempts: 4,
    sticky: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true },
      { providerId: 'managed-a', model: null, priority: 9, enabled: true },
    ],
    maxAttempts: 2,
    sticky: false,
    allowCrossTrust: false,
  });
  assert.equal(editor.serializeDraft({
    protocol: 'anthropic', providers: providers(), candidates: result.value.candidates.slice(0, 1),
  }).code, 'insufficient_candidates');
  assert.equal(editor.serializeDraft({
    protocol: 'anthropic', providers: providers(),
    candidates: Array.from({ length: editor.MAX_CANDIDATES + 1 }, (_, index) => ({
      providerId: `provider-${index}`, priority: index + 1, enabled: true,
    })),
  }).code, 'too_many_candidates');
});

test('an unrouted pool serializes exactly as it did before difficulty routing', () => {
  const candidates = [
    { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true, rung: 2 },
    { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true, rung: 1 },
  ];
  const plain = editor.serializeDraft({ protocol: 'anthropic', providers: providers(), candidates });
  const off = editor.serializeDraft({
    protocol: 'anthropic', providers: providers(), candidates, routingEnabled: false,
  });
  assert.equal('routing' in plain.value, false);
  assert.equal('tier' in plain.value.candidates[0], false);
  assert.equal('rung' in plain.value.candidates[0], false);
  // The editor's own rung control value must never travel on the wire.
  assert.deepEqual(off.value, plain.value);
});

test('difficulty routing compacts rungs into a ladder the server accepts', () => {
  const candidates = [
    { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true, rung: 1 },
    { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true, rung: 3 },
  ];
  const result = editor.serializeDraft({
    protocol: 'anthropic', providers: providers(), candidates, routingEnabled: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.routing, {
    version: 1,
    provider: 'jev',
    gateway: 'vercel',
    apiKeyName: editor.ROUTING_API_KEY_NAME,
    tiers: ['t1', 't2'],
  });
  assert.deepEqual(result.value.candidates.map(candidate => candidate.tier), ['t1', 't2']);
  // Only the order of the rungs carries meaning, so 1/3 is the same pool as 1/2 —
  // and the server has to agree with the ladder the editor just wrote.
  const validated = serverContract.validateProviderSelection(result.value, {
    cli: 'claude',
    providers: providers().map(provider => ({ ...provider, appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'] })),
  });
  assert.equal(validated.ok, true, validated.error);
  assert.deepEqual([...validated.value.routing.tiers], ['t1', 't2']);
});

test('routing keeps knobs the editor cannot express, and refuses one tier', () => {
  const candidates = [
    { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true, rung: 1 },
    { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true, rung: 2 },
  ];
  const preserved = editor.serializeDraft({
    protocol: 'anthropic', providers: providers(), candidates, routingEnabled: true,
    initialRouting: { apiKeyName: 'my-key', onUnknown: 'priority', timeoutMs: 4_000, model: 'typesafe-ai/jev' },
  });
  assert.equal(preserved.value.routing.apiKeyName, 'my-key');
  assert.equal(preserved.value.routing.onUnknown, 'priority');
  assert.equal(preserved.value.routing.timeoutMs, 4_000);
  // Every candidate on the same rung is one tier: nothing would route.
  assert.equal(editor.serializeDraft({
    protocol: 'anthropic', providers: providers(), routingEnabled: true,
    candidates: candidates.map(candidate => ({ ...candidate, rung: 1 })),
  }).code, 'provider_routing_requires_tiers');
});

test('mixed Official and user-managed candidates require explicit confirmation', () => {
  const draft = {
    protocol: 'anthropic',
    providers: providers(),
    candidates: [
      { providerId: 'official', model: null, priority: 1, enabled: true },
      { providerId: 'managed-a', model: 'model-a', priority: 2, enabled: true },
    ],
    maxAttempts: 2,
    sticky: true,
  };
  assert.equal(editor.selectionCrossesTrust(draft.candidates, draft.providers), true);
  const denied = editor.serializeDraft(draft);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'cross_trust_confirmation_required');
  const confirmed = editor.serializeDraft({ ...draft, crossTrustConfirmed: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.value.allowCrossTrust, true);
});

function mountEditor(options = {}) {
  const document = fakeDocument();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const control = editor.mount({ document, container, providers: providers(), protocol: 'anthropic', presetStore: null, ...options });
  const $ = className => container.querySelector(`.multicc-auto-editor-${className}`);
  const row = id => container.querySelectorAll('.multicc-auto-editor-row')
    .find(candidate => candidate.dataset.providerId === id);
  const inList = () => $('list').children.map(child => child.dataset.providerId);
  const inPool = () => $('pool').children.map(child => child.dataset.providerId);
  const click = (id, action) => row(id).querySelector(`.multicc-auto-editor-${action}`).emit('click');
  const tier = id => row(id).querySelector('.multicc-auto-editor-tier');
  const pickTier = (id, rung) => tier(id).children.find(option => option.dataset.rung === String(rung)).emit('click');
  const routeOn = () => $('routing').emit('click');
  return { document, container, control, $, row, inList, inPool, click, tier, pickTier, routeOn };
}

test('mounted controller shows the lines in use in order and keeps the rest one click away', () => {
  const { document, container, control, $, row, inList, inPool, click } = mountEditor({
    formatProvider: provider => `Provider ${provider.name}`,
  });
  assert.equal(container.querySelectorAll('.multicc-auto-editor-row').length, 4);
  assert.deepEqual(inList(), ['managed-a', 'managed-b']);
  assert.deepEqual(inPool(), ['official', 'managed-c']);
  assert.deepEqual(inList().map(id => row(id).querySelector('.multicc-auto-editor-rank').textContent), ['1', '2']);
  assert.match($('add').children[0].textContent, /还有 2 条可用/);
  assert.equal(row('managed-a').querySelector('.multicc-auto-editor-move-up').disabled, true);
  assert.equal(row('managed-b').querySelector('.multicc-auto-editor-move-down').disabled, true);
  assert.equal(control.read().ok, true);

  click('official', 'add-one');
  assert.deepEqual(inList(), ['managed-a', 'managed-b', 'official']);
  const blocked = control.read();
  assert.equal(blocked.code, 'cross_trust_confirmation_required');
  const confirm = container.querySelector('.multicc-auto-editor-cross-trust-confirm');
  assert.equal(document.activeElement, confirm);
  confirm.checked = true;
  confirm.emit('change');
  const allowed = control.read();
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value.allowCrossTrust, true);
  assert.deepEqual(allowed.value.candidates.map(candidate => [candidate.providerId, candidate.priority]),
    [['managed-a', 1], ['managed-b', 2], ['official', 3]], 'priority is simply the position in the list');

  click('official', 'remove');
  assert.deepEqual(inPool(), ['official', 'managed-c'], 'a removed line goes back to the add list');
  assert.equal(confirm.checked, false, 'leaving the mixed pool drops the confirmation');

  const style = document.getElementById('multicc-auto-provider-editor-style');
  assert.match(style.textContent, /@container \(max-width:520px\)/);
  assert.match(style.textContent, /grid-template-columns:22px minmax\(0,1fr\)/);
  control.setContext({ protocol: null, initialSelection: null });
  assert.deepEqual(control.read(), { ok: true, value: null, error: null, code: null });
  control.destroy();
  assert.equal(control.read().code, 'editor_destroyed');
});

test('arrows reorder the lines and the new order is what gets saved', () => {
  const { control, inList, click, $ } = mountEditor();
  click('managed-c', 'add-one');
  click('managed-c', 'move-up');
  click('managed-c', 'move-up');
  click('managed-c', 'move-up');
  assert.deepEqual(inList(), ['managed-c', 'managed-a', 'managed-b'], 'the first line cannot move further up');
  click('managed-a', 'move-down');
  assert.deepEqual(control.read({ remember: false }).value.candidates.map(candidate => candidate.providerId),
    ['managed-c', 'managed-b', 'managed-a']);
  assert.match($('summary').textContent, /^效果：先用 Managed C（model-c），不行再换 Managed B/);
});

test('a pool with fewer than two lines says so and opens the add list', () => {
  const { control, click, $ } = mountEditor();
  click('managed-b', 'remove');
  assert.equal($('summary').classList.contains('bad'), true);
  assert.match($('summary').textContent, /至少要用两条线路/);
  assert.equal(control.read({ remember: false }).code, 'insufficient_candidates');
  const fresh = mountEditor({ initialSelection: { mode: 'auto', protocol: 'anthropic', candidates: [
    { providerId: 'managed-a', priority: 1, enabled: true },
  ] } });
  assert.equal(fresh.$('add').open, true);
});

function memoryPresetStore(initial = []) {
  let data = JSON.parse(JSON.stringify(initial));
  return { load: () => JSON.parse(JSON.stringify(data)), save(list) { data = JSON.parse(JSON.stringify(list)); }, get data() { return data; } };
}

test('a configured pool can be saved as a named preset and applied to a fresh editor', () => {
  const store = memoryPresetStore();
  const first = mountEditor({ presetStore: store });
  first.click('managed-c', 'add-one');
  first.click('managed-c', 'move-up');
  first.click('managed-c', 'move-up');
  first.click('managed-a', 'move-down');
  assert.equal(first.$('preset-form').style.display, 'none', 'the name field waits behind 存为预设');
  first.$('preset-open').emit('click');
  assert.equal(first.$('preset-form').style.display, '');
  first.$('preset-name').value = '便宜优先';
  first.$('preset-save').emit('click');
  assert.equal(store.data.length, 1);
  assert.equal(store.data[0].name, '便宜优先');
  assert.equal(store.data[0].recent, false);
  assert.deepEqual(store.data[0].candidates.map(c => c.providerId), ['managed-c', 'managed-b', 'managed-a']);

  const second = mountEditor({ presetStore: store });
  const select = second.$('preset-select');
  assert.equal(select.options.length, 2, '占位 + 一份预设');
  assert.match(select.options[1].textContent, /^便宜优先 · Managed C → Managed B → Managed A$/);
  assert.equal(second.$('preset-delete').style.display, 'none', 'nothing to delete before a preset is picked');
  select.value = store.data[0].id;
  select.emit('change');
  assert.equal(second.$('preset-delete').style.display, '');
  assert.deepEqual(second.inList(), ['managed-c', 'managed-b', 'managed-a']);
  const applied = second.control.read({ remember: false });
  assert.equal(applied.ok, true);
  assert.equal(store.data.length, 1, 'remember:false 不记最近使用');

  second.control.read();
  assert.equal(store.data.length, 1, '与已有预设同一份池子只顶到前面，不重复存');
  second.$('preset-delete').emit('click');
  assert.equal(store.data.length, 0);
});

test('reading a valid pool records it as a recent preset, deduplicated and capped', () => {
  const store = memoryPresetStore();
  const { control } = mountEditor({ presetStore: store });
  control.read();
  control.read();
  assert.equal(store.data.length, 1);
  assert.equal(store.data[0].recent, true);
  let list = [];
  for (let i = 0; i < 8; i += 1) {
    list = editor.rememberPreset(list, {
      protocol: 'anthropic', maxAttempts: 2, sticky: true,
      candidates: [{ providerId: 'managed-a', priority: 1 }, { providerId: 'managed-b', priority: i + 2 }],
    }, { recent: true, now: i });
  }
  assert.equal(list.length, 5, '最近使用最多留 5 份');
  // 协议不同或候选已失效（池里不足两个）的预设不出现在下拉里。
  const other = memoryPresetStore([{ id: 'x', name: 'gone', recent: false, protocol: 'anthropic', maxAttempts: 2, sticky: true,
    candidates: [{ providerId: 'managed-a', priority: 1 }, { providerId: 'deleted', priority: 2 }] }]);
  const { $ } = mountEditor({ presetStore: other });
  assert.equal($('preset-select').options.length, 1);
});

const flush = () => new Promise(resolve => setImmediate(resolve));

test('turning routing on gives a valid simple/complex split straight away, guessed from model names', () => {
  const pool = providers();
  pool[2] = { ...pool[2], model: 'deepseek-v4-flash' };
  const { control, container, $, tier, routeOn } = mountEditor({ providers: pool });
  assert.equal($('jev').style.display, 'none', 'the Jev step stays out of the way in order mode');
  assert.equal($('mode-order').getAttribute('aria-checked'), 'true');
  assert.equal(container.classList.contains('is-order'), true, 'task chips are hidden in order mode');
  routeOn();
  assert.equal($('mode-order').getAttribute('aria-checked'), 'false', 'the two modes are one choice');
  assert.equal($('routing').getAttribute('aria-checked'), 'true');
  assert.equal(container.classList.contains('is-order'), false);
  assert.equal($('jev').style.display, '');
  assert.equal(tier('managed-b').dataset.value, '1', 'a flash model takes simple tasks');
  assert.equal(tier('managed-a').dataset.value, '2');
  assert.deepEqual(tier('managed-a').children.map(option => option.textContent), ['简单', '复杂'],
    'two lines read as words, not numbers');
  assert.equal(tier('managed-b').children[0].getAttribute('aria-checked'), 'true');
  assert.equal($('summary').classList.contains('bad'), false);
  assert.match($('summary').textContent, /简单任务 → Managed B（deepseek-v4-flash）；复杂任务 → Managed A/);
  const result = control.read({ remember: false });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value.candidates.map(candidate => [candidate.providerId, candidate.tier]),
    [['managed-a', 't2'], ['managed-b', 't1']]);
});

test('when names give no hint the first line in order takes simple tasks; a model switch re-files an untouched row', () => {
  const pool = providers();
  pool[2] = { ...pool[2], modelOptions: ['model-b', 'model-b-mini'] };
  const { control, $, row, tier, routeOn } = mountEditor({ providers: pool });
  routeOn();
  assert.equal(tier('managed-a').dataset.value, '1');
  assert.equal(tier('managed-b').dataset.value, '2');
  assert.equal(control.read({ remember: false }).ok, true);
  const model = row('managed-b').querySelector('.multicc-auto-editor-model');
  model.value = 'model-b-mini';
  model.emit('change');
  assert.equal(tier('managed-b').dataset.value, '1', 'a mini model moves to simple tasks');
  assert.equal(tier('managed-a').dataset.value, '2');
  assert.equal($('summary').classList.contains('bad'), false);
});

test('a user-picked tier survives an unrelated row being added and its own model switch', () => {
  const { row, tier, pickTier, click, routeOn } = mountEditor();
  click('managed-c', 'add-one');
  routeOn();
  assert.deepEqual(tier('managed-a').children.map(option => option.textContent), ['简单', '复杂'],
    'three lines still get the two plain choices');
  const alternative = ['1', '2'].find(value => value !== tier('managed-a').dataset.value);
  pickTier('managed-a', alternative);
  assert.equal(tier('managed-a').dataset.value, alternative, 'the pick sticks through its own notification');
  click('official', 'add-one');
  assert.equal(tier('managed-a').dataset.value, alternative, 'an unrelated row change must not revert it');
  const model = row('managed-a').querySelector('.multicc-auto-editor-model');
  model.value = 'model-a-fast';
  model.emit('change');
  assert.equal(tier('managed-a').dataset.value, alternative, 'a hand-picked tier is no longer re-guessed');
});

test('putting every line on the same task type is flagged in the preview and refused on save', () => {
  const { control, $, pickTier, routeOn } = mountEditor();
  routeOn();
  pickTier('managed-a', 2);
  assert.equal($('summary').classList.contains('bad'), true);
  assert.match($('summary').textContent, /简单任务/);
  const result = control.read({ remember: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'provider_routing_requires_tiers');
});

test('a configured three-tier ladder keeps its middle chip', () => {
  const { tier } = mountEditor({ initialSelection: {
    mode: 'auto', protocol: 'anthropic', maxAttempts: 3, sticky: true,
    routing: { version: 1, provider: 'jev', tiers: ['t1', 't2', 't3'] },
    candidates: [
      { providerId: 'managed-a', priority: 1, enabled: true, tier: 't1' },
      { providerId: 'managed-b', priority: 2, enabled: true, tier: 't2' },
      { providerId: 'managed-c', priority: 3, enabled: true, tier: 't3' },
    ] } });
  assert.deepEqual(tier('managed-b').children.map(option => option.textContent), ['简单', '中等', '复杂']);
  assert.equal(tier('managed-b').dataset.value, '2');
});

test('the fallback choice for an unjudged message is written only when it differs from the server default', () => {
  const { control, $, routeOn } = mountEditor();
  assert.equal($('more').children[0].innerText.includes('判断不了'), false, 'the fallback only matters when routing');
  routeOn();
  assert.equal($('jev-unknown').value, 'strong');
  assert.match($('more').children[0].innerText, /最多试 2 条 · 沿用成功的线路 · 判断不了按复杂/);
  assert.equal('onUnknown' in control.read({ remember: false }).value.routing, false);
  $('jev-unknown').value = 'weak';
  $('jev-unknown').emit('change');
  assert.equal(control.read({ remember: false }).value.routing.onUnknown, 'weak');
  const again = mountEditor({ initialSelection: control.read({ remember: false }).value });
  assert.equal(again.$('routing').getAttribute('aria-checked'), 'true');
  assert.equal(again.$('jev-unknown').value, 'weak');
});

test('without a host key API the Jev step names the vault entry and offers no form', () => {
  const { $, routeOn } = mountEditor();
  routeOn();
  assert.match($('jev').innerText, /vercel-api-key/);
  assert.equal($('jev-form').style.display, 'none');
  assert.equal($('jev-test').style.display, 'none');
});

function fakeKeyApi({ present = false, test = { ok: true, tier: 't1', latencyMs: 412 } } = {}) {
  const calls = { check: [], save: [], test: [] };
  return {
    calls,
    check(name) { calls.check.push(name); return Promise.resolve(present); },
    save(name, value) { calls.save.push([name, value]); present = true; return Promise.resolve(); },
    test(request) { calls.test.push(request); return Promise.resolve(typeof test === 'function' ? test(request) : test); },
  };
}

test('the key is checked only once routing is chosen, and a missing key walks through the steps', async () => {
  const api = fakeKeyApi();
  const { $, routeOn } = mountEditor({ routingKey: api });
  await flush();
  assert.deepEqual(api.calls.check, [], 'a plain pool never touches the vault');
  routeOn();
  assert.match($('jev-status').textContent, /正在检查/);
  await flush();
  assert.deepEqual(api.calls.check, ['vercel-api-key']);
  assert.equal($('jev').classList.contains('missing'), true);
  assert.match($('jev-status').textContent, /还差一步/);
  assert.equal($('steps').style.display, '');
  assert.equal($('jev-form').style.display, '');
  assert.equal($('jev-test').style.display, 'none', 'nothing to test before a key exists');
});

test('saving a pasted key clears the field at once, stores it under the vault name and runs a test', async () => {
  const api = fakeKeyApi();
  const { $, routeOn } = mountEditor({ routingKey: api });
  routeOn();
  await flush();
  $('jev-key-input').value = '  vck_example  ';
  $('jev-key-save').emit('click');
  assert.equal($('jev-key-input').value, '', 'the secret does not linger in the form');
  await flush();
  await flush();
  assert.deepEqual(api.calls.save, [['vercel-api-key', 'vck_example']]);
  assert.equal(api.calls.test.length, 1);
  assert.equal($('jev').classList.contains('ok'), true);
  assert.equal($('jev-form').style.display, 'none');
  assert.equal($('steps').style.display, 'none');
  assert.equal($('jev-test-result').classList.contains('good'), true);
  assert.match($('jev-test-result').textContent, /412 ms.*错别字.*简单任务/);
});

test('a rejected key is explained in plain words and the form comes back to replace it', async () => {
  const api = fakeKeyApi({ present: true, test: { ok: false, code: 'jev_http_401', status: 401 } });
  const { $, routeOn } = mountEditor({ routingKey: api });
  routeOn();
  await flush();
  assert.equal($('jev-form').style.display, 'none', 'a stored key needs no form');
  assert.equal($('jev-key-change').style.display, '');
  $('jev-test').emit('click');
  await flush();
  await flush();
  assert.deepEqual(api.calls.test, [{
    apiKeyName: 'vercel-api-key', gateway: 'vercel', text: '把 README 里的一个错别字改掉',
  }]);
  assert.equal($('jev-test-result').classList.contains('bad'), true);
  assert.match($('jev-test-result').textContent, /key 无效.*401/);
  assert.equal($('jev-form').style.display, '');
});

test('更换 key opens the form on a connected key and closes it again', async () => {
  const api = fakeKeyApi({ present: true });
  const { $, routeOn } = mountEditor({ routingKey: api });
  routeOn();
  await flush();
  $('jev-key-change').emit('click');
  assert.equal($('jev-form').style.display, '');
  assert.equal($('jev-key-change').textContent, '取消');
  $('jev-key-change').emit('click');
  assert.equal($('jev-form').style.display, 'none');
});

test('a borrowed line with no catalog of its own offers models instead of a dead select', async () => {
  // 借道线路（导入的 Claude 中继）不声明任何模型，它的 Auto 行下拉曾只剩「Provider 默认」，
  // 于是整条 Auto 选不出模型；候选补的是本机 CLI 目录，不代表对端账号的权限。
  const catalog = ['claude-opus-5', 'claude-sonnet-5'];
  const pool = [
    { id: 'relay', name: 'Leo-Claude', protocol: 'anthropic' },
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a' },
  ];
  const { document, control, row } = mountEditor({ providers: pool, loadModels: async () => catalog });
  const select = id => row(id).querySelector('.multicc-auto-editor-model');
  const field = id => row(id).querySelector('.multicc-auto-editor-model-custom');
  const values = id => select(id).options.map(option => option.value);

  // 目录到达前就是这样，也就是被报告的现象。
  assert.deepEqual(values('relay'), ['', '__custom__']);
  assert.deepEqual(values('managed-a'), ['', 'model-a', '__custom__'], '一条自己声明了模型的线路不动它');
  assert.ok(select('relay').parentNode.classList.contains('multicc-auto-editor-model-field'),
    '下拉和自定义输入共用同一个栅格单元');
  const css = document.getElementById('multicc-auto-provider-editor-style').textContent;
  assert.match(css, /\.multicc-auto-editor \.multicc-auto-editor-model-field\{grid-area:model;/,
    '栅格单元挂在包装层上');
  assert.doesNotMatch(css, /\.multicc-auto-editor \.multicc-auto-editor-model\{grid-area:model;/,
    '下拉自己不再占栅格单元，否则自定义输入会被挤到另一列');
  assert.match(css, /-pool :is\([^)]*\.multicc-auto-editor-model-field[^)]*\)\{display:none\}/,
    '未启用线路的池子里，包装层和下拉一起隐藏');

  await flush();

  // 目录到达后候选补上，但已经选中的值不变。
  assert.deepEqual(values('relay'), ['', 'claude-opus-5', 'claude-sonnet-5', '__custom__']);
  assert.equal(select('relay').value, '');
  assert.deepEqual(values('managed-a'), ['', 'model-a', '__custom__'],
    '有自己目录的线路不会被本机目录覆盖');

  // 「自定义…」露出输入框，手填的 id 进配置。
  assert.equal(field('relay').style.display, 'none');
  select('relay').value = '__custom__';
  select('relay').emit('change');
  assert.equal(field('relay').style.display, '');
  field('relay').value = 'claude-opus-5-20260101';
  field('relay').emit('input');
  const written = control.read({ remember: false });
  assert.equal(written.ok, true);
  assert.equal(written.value.candidates.find(candidate => candidate.providerId === 'relay').model,
    'claude-opus-5-20260101');
});

// ── picking the Jev gateway ──────────────────────────────────────────────────
//
// The same evaluation is sold by three gateways and self-hosted behind a fourth
// ("自定义"). Which one is a property of the pool, like the tier ladder: it has to
// survive a save/reopen, and switching it means the key, the steps and the
// console are all somebody else's.

function gatewayButton(container, name) {
  return container.querySelector(`.multicc-auto-editor-gateway-${name}`);
}

function pickGateway(container, name) {
  gatewayButton(container, name).emit('click');
}

test('the Jev box leads with the gateway, defaulting to the saved one', () => {
  const { container, $ } = mountEditor({
    initialSelection: {
      mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
      routing: { version: 1, provider: 'jev', gateway: 'openrouter', tiers: ['t1', 't2'] },
      candidates: [
        { providerId: 'managed-a', priority: 1, enabled: true, tier: 't1' },
        { providerId: 'managed-b', priority: 2, enabled: true, tier: 't2' },
      ],
    },
  });
  const seg = $('gateways');
  assert.deepEqual(seg.children.map(node => node.dataset.gateway),
    ['vercel', 'openrouter', 'typesafe', 'custom']);
  assert.equal(gatewayButton(container, 'openrouter').getAttribute('aria-checked'), 'true');
  assert.equal(gatewayButton(container, 'vercel').getAttribute('aria-checked'), 'false');
  // The per-gateway copy follows: OpenRouter's console, and the entry it reads.
  assert.match(container.querySelector('.multicc-auto-editor-steps').innerText, /openrouter\.ai\/keys/);
});

test('a pool stored before gateways existed opens on Vercel, and re-saves unchanged', () => {
  const { container, control, $ } = mountEditor({
    initialSelection: {
      mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
      routing: { version: 1, provider: 'jev', apiKeyName: 'vercel-api-key', tiers: ['t1', 't2'] },
      candidates: [
        { providerId: 'managed-a', priority: 1, enabled: true, tier: 't1' },
        { providerId: 'managed-b', priority: 2, enabled: true, tier: 't2' },
      ],
    },
  });
  assert.equal(gatewayButton(container, 'vercel').getAttribute('aria-checked'), 'true');
  assert.equal($('jev-custom').style.display, 'none', 'the custom fields stay out of the way');
  const routing = control.read({ remember: false }).value.routing;
  assert.equal(routing.gateway, 'vercel');
  assert.equal(routing.apiKeyName, 'vercel-api-key');
  // A preset's host and model come from the server table, so the page writes
  // neither: a persisted copy would outlive a table update.
  assert.equal('endpoint' in routing, false);
  assert.equal('model' in routing, false);
});

test('switching gateway moves the key, the copy and the custom fields', async () => {
  const api = fakeKeyApi({ present: true });
  const { container, control, $, routeOn } = mountEditor({ routingKey: api });
  routeOn();
  await flush();
  assert.deepEqual(api.calls.check, ['vercel-api-key']);

  pickGateway(container, 'typesafe');
  await flush();
  // The previous gateway's verdict is gone, and the new entry is what is checked.
  assert.deepEqual(api.calls.check, ['vercel-api-key', 'typesafe-api-key']);
  assert.equal($('jev-test-result').style.display, 'none', 'a stale verdict never describes another host');
  assert.match(container.querySelector('.multicc-auto-editor-steps').innerText, /TypeSafe 控制台/);
  assert.equal(control.read({ remember: false }).value.routing.apiKeyName, 'typesafe-api-key');

  pickGateway(container, 'custom');
  await flush();
  assert.equal($('jev-custom').style.display, '', 'only the custom gateway shows an address and a model');
  assert.deepEqual(api.calls.check, ['vercel-api-key', 'typesafe-api-key', 'jev-custom-api-key']);
  // Nothing typed yet, so there is no address to save and the panel says why.
  const refused = control.read({ remember: false });
  assert.equal(refused.code, 'invalid_provider_routing');
  assert.equal($('error').style.display, '', 'the reason is shown, not just refused');
  assert.match($('error').textContent, /接口地址/);
});

test('a custom gateway writes its address, model and key entry, and a bad address blocks the save', () => {
  const { container, control, $, routeOn } = mountEditor();
  routeOn();
  pickGateway(container, 'custom');
  const endpoint = $('jev-endpoint');
  const model = $('jev-model');

  endpoint.value = 'http://jev.example/v1/evaluate';
  endpoint.emit('input');
  model.value = 'my-jev';
  model.emit('input');
  // The reason shows under the address while it is typed, before any save.
  assert.match($('jev-endpoint-error').textContent, /https/);
  assert.equal($('error').style.display, 'none');
  assert.equal(control.read({ remember: false }).code, 'invalid_provider_routing');
  assert.match($('error').textContent, /https/);

  endpoint.value = 'https://jev.example/v1/evaluate';
  endpoint.emit('input');
  const routing = control.read({ remember: false }).value.routing;
  assert.deepEqual(routing, {
    version: 1,
    provider: 'jev',
    gateway: 'custom',
    endpoint: 'https://jev.example/v1/evaluate',
    model: 'my-jev',
    apiKeyName: 'jev-custom-api-key',
    tiers: ['t1', 't2'],
  });
  // The rule the server enforces on the entry name is the one the page writes:
  // a config can never point the custom host at an unrelated vault secret.
  assert.equal(editor.customEndpointError('https://jev.example/v1'), '');
});

test('a gateway switch drops knobs that belonged to the other gateway', () => {
  const { container, control, routeOn } = mountEditor({
    initialSelection: {
      mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
      routing: {
        version: 1, provider: 'jev', gateway: 'vercel',
        apiKeyName: 'my-key', model: 'typesafe-ai/jev-preview', onUnknown: 'weak', timeoutMs: 4_000,
        tiers: ['t1', 't2'],
      },
      candidates: [
        { providerId: 'managed-a', priority: 1, enabled: true, tier: 't1' },
        { providerId: 'managed-b', priority: 2, enabled: true, tier: 't2' },
      ],
    },
  });
  routeOn();
  // Same gateway: the pinned entry, the tuned model and the knobs survive.
  const kept = control.read({ remember: false }).value.routing;
  assert.equal(kept.apiKeyName, 'my-key');
  assert.equal(kept.model, 'typesafe-ai/jev-preview');
  assert.equal(kept.onUnknown, 'weak');
  assert.equal(kept.timeoutMs, 4_000);

  pickGateway(container, 'openrouter');
  const moved = control.read({ remember: false }).value.routing;
  assert.equal(moved.apiKeyName, 'openrouter-api-key', 'another gateway\'s entry is not this one\'s key');
  assert.equal('model' in moved, false, 'the old model id belonged to the old gateway');
  assert.equal(moved.onUnknown, 'weak', 'the fallback is not a gateway property');
  assert.equal(moved.timeoutMs, 4_000, 'neither is the timeout');
});

test('a custom gateway carries the address and model to the test route', async () => {
  const api = fakeKeyApi({ present: true });
  const { container, $, routeOn } = mountEditor({ routingKey: api });
  routeOn();
  await flush();
  pickGateway(container, 'custom');
  $('jev-endpoint').value = 'https://jev.example/v1/evaluate';
  $('jev-endpoint').emit('input');
  $('jev-model').value = 'my-jev';
  $('jev-model').emit('input');
  await flush();
  $('jev-test').emit('click');
  await flush();
  await flush();
  assert.deepEqual(api.calls.test, [{
    apiKeyName: 'jev-custom-api-key', gateway: 'custom',
    endpoint: 'https://jev.example/v1/evaluate', model: 'my-jev',
    text: '把 README 里的一个错别字改掉',
  }]);
});
