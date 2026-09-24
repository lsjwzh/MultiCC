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

test('mounted controller renders conservative defaults and gates mixed trust', () => {
  const document = fakeDocument();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const control = editor.mount({
    document,
    container,
    providers: providers(),
    protocol: 'anthropic',
    formatProvider: provider => `Provider ${provider.name}`,
  });
  const rows = container.querySelectorAll('.multicc-auto-editor-row');
  assert.equal(rows.length, 4);
  const checkedIds = rows.filter(row => row.querySelector('.multicc-auto-editor-enabled').checked)
    .map(row => row.dataset.providerId);
  assert.deepEqual(checkedIds, ['managed-a', 'managed-b']);
  assert.deepEqual(rows.map(row => [
    row.dataset.providerId,
    Number(row.querySelector('.multicc-auto-editor-priority').value),
  ]), [
    ['official', 3], ['managed-a', 1], ['managed-b', 2], ['managed-c', 4],
  ]);
  assert.equal(control.read().ok, true);

  rows[0].querySelector('.multicc-auto-editor-enabled').checked = true;
  rows[0].querySelector('.multicc-auto-editor-enabled').emit('change');
  const blocked = control.read();
  assert.equal(blocked.code, 'cross_trust_confirmation_required');
  const confirm = container.querySelector('.multicc-auto-editor-cross-trust-confirm');
  assert.equal(document.activeElement, confirm);
  confirm.checked = true;
  confirm.emit('change');
  const allowed = control.read();
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value.allowCrossTrust, true);
  assert.deepEqual(allowed.value.candidates.map(candidate => candidate.providerId),
    ['managed-a', 'managed-b', 'official']);

  const style = document.getElementById('multicc-auto-provider-editor-style');
  assert.match(style.textContent, /@media \(max-width:640px\)/);
  assert.match(style.textContent, /grid-template-columns:22px minmax\(0,1fr\)/);
  control.setContext({ protocol: null, initialSelection: null });
  assert.deepEqual(control.read(), { ok: true, value: null, error: null, code: null });
  control.destroy();
  assert.equal(control.read().code, 'editor_destroyed');
});

function memoryPresetStore(initial = []) {
  let data = JSON.parse(JSON.stringify(initial));
  return { load: () => JSON.parse(JSON.stringify(data)), save(list) { data = JSON.parse(JSON.stringify(list)); }, get data() { return data; } };
}

test('a configured pool can be saved as a named preset and applied to a fresh editor', () => {
  const store = memoryPresetStore();
  const mountOne = () => {
    const document = fakeDocument();
    const container = document.createElement('div');
    document.body.appendChild(container);
    return { container, control: editor.mount({ document, container, providers: providers(), protocol: 'anthropic', presetStore: store }) };
  };
  const first = mountOne();
  const rows = first.container.querySelectorAll('.multicc-auto-editor-row');
  rows[3].querySelector('.multicc-auto-editor-enabled').checked = true; // managed-c
  rows[3].querySelector('.multicc-auto-editor-priority').value = '1';
  rows[1].querySelector('.multicc-auto-editor-priority').value = '5';
  first.container.querySelector('.multicc-auto-editor-preset-name').value = '便宜优先';
  first.container.querySelector('.multicc-auto-editor-preset-save').emit('click');
  assert.equal(store.data.length, 1);
  assert.equal(store.data[0].name, '便宜优先');
  assert.equal(store.data[0].recent, false);
  assert.deepEqual(store.data[0].candidates.map(c => c.providerId), ['managed-c', 'managed-b', 'managed-a']);

  const second = mountOne();
  const select = second.container.querySelector('.multicc-auto-editor-preset-select');
  assert.equal(select.options.length, 2, '占位 + 一份预设');
  assert.match(select.options[1].textContent, /^便宜优先 · Managed C → Managed B → Managed A$/);
  select.value = store.data[0].id;
  select.emit('change');
  const applied = second.control.read({ remember: false });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.value.candidates.map(c => c.providerId), ['managed-c', 'managed-b', 'managed-a']);
  assert.equal(store.data.length, 1, 'remember:false 不记最近使用');

  second.control.read();
  assert.equal(store.data.length, 1, '与已有预设同一份池子只顶到前面，不重复存');
  second.container.querySelector('.multicc-auto-editor-preset-delete').emit('click');
  assert.equal(store.data.length, 0);
});

test('reading a valid pool records it as a recent preset, deduplicated and capped', () => {
  const store = memoryPresetStore();
  const document = fakeDocument();
  const container = document.createElement('div');
  const control = editor.mount({ document, container, providers: providers(), protocol: 'anthropic', presetStore: store });
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
  const doc2 = fakeDocument();
  const box = doc2.createElement('div');
  editor.mount({ document: doc2, container: box, providers: providers(), protocol: 'anthropic', presetStore: other });
  assert.equal(box.querySelector('.multicc-auto-editor-preset-select').options.length, 1);
});

function mountRouted(options = {}) {
  const document = fakeDocument();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const control = editor.mount({ document, container, providers: providers(), protocol: 'anthropic', presetStore: null, ...options });
  const $ = className => container.querySelector(`.multicc-auto-editor-${className}`);
  const row = id => container.querySelectorAll('.multicc-auto-editor-row')
    .find(candidate => candidate.dataset.providerId === id);
  const toggle = (input, checked) => { input.checked = checked; input.emit('change'); };
  const routeOn = () => toggle($('routing'), true);
  return { document, container, control, $, row, toggle, routeOn };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('turning routing on gives a valid simple/complex split straight away, guessed from model names', () => {
  const pool = providers();
  pool[2] = { ...pool[2], model: 'deepseek-v4-flash' };
  const { control, $, row, routeOn } = mountRouted({ providers: pool });
  assert.equal($('jev').style.display, 'none', 'the Jev step stays out of the way in order mode');
  assert.equal($('mode-order').checked, true);
  routeOn();
  assert.equal($('mode-order').checked, false, 'the two modes are one choice');
  assert.equal($('jev').style.display, '');
  assert.equal(row('managed-b').querySelector('.multicc-auto-editor-tier').value, '1', 'a flash model takes simple tasks');
  assert.equal(row('managed-a').querySelector('.multicc-auto-editor-tier').value, '2');
  assert.deepEqual(row('managed-a').querySelector('.multicc-auto-editor-tier').options.map(option => option.textContent),
    ['简单任务', '复杂任务'], 'two lines read as words, not numbers');
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
  const { control, $, row, routeOn } = mountRouted({ providers: pool });
  routeOn();
  assert.equal(row('managed-a').querySelector('.multicc-auto-editor-tier').value, '1');
  assert.equal(row('managed-b').querySelector('.multicc-auto-editor-tier').value, '2');
  assert.equal(control.read({ remember: false }).ok, true);
  const model = row('managed-b').querySelector('.multicc-auto-editor-model');
  model.value = 'model-b-mini';
  model.emit('change');
  assert.equal(row('managed-b').querySelector('.multicc-auto-editor-tier').value, '1', 'a mini model moves to simple tasks');
  assert.equal(row('managed-a').querySelector('.multicc-auto-editor-tier').value, '2');
  assert.equal($('summary').classList.contains('bad'), false);
});

test('a user-edited tier survives its own change event and an unrelated row toggling afterward', () => {
  const { row, routeOn, toggle } = mountRouted();
  toggle(row('managed-c').querySelector('.multicc-auto-editor-enabled'), true);
  routeOn();
  const tier = row('managed-a').querySelector('.multicc-auto-editor-tier');
  assert.deepEqual(tier.options.map(option => option.textContent), ['简单任务', '中等任务', '复杂任务']);
  const alternative = tier.options.map(option => option.value).find(value => value !== tier.value);
  tier.value = alternative;
  tier.emit('change');
  assert.equal(tier.value, alternative, 'the pick sticks through its own change notification');
  toggle(row('official').querySelector('.multicc-auto-editor-enabled'), true);
  assert.equal(tier.value, alternative, 'an unrelated row change must not revert it');
  const model = row('managed-a').querySelector('.multicc-auto-editor-model');
  model.value = 'model-a-fast';
  model.emit('change');
  assert.equal(tier.value, alternative, 'a hand-picked tier is no longer re-guessed');
});

test('putting every line on the same task type is flagged in the preview and refused on save', () => {
  const { control, $, row, routeOn } = mountRouted();
  routeOn();
  const tier = row('managed-a').querySelector('.multicc-auto-editor-tier');
  tier.value = '2';
  tier.emit('change');
  assert.equal($('summary').classList.contains('bad'), true);
  assert.match($('summary').textContent, /简单任务/);
  const result = control.read({ remember: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'provider_routing_requires_tiers');
});

test('the fallback choice for an unjudged message is written only when it differs from the server default', () => {
  const { control, $, routeOn } = mountRouted();
  routeOn();
  assert.equal($('jev-unknown').value, 'strong');
  assert.equal('onUnknown' in control.read({ remember: false }).value.routing, false);
  $('jev-unknown').value = 'weak';
  $('jev-unknown').emit('change');
  assert.equal(control.read({ remember: false }).value.routing.onUnknown, 'weak');
  const again = mountRouted({ initialSelection: control.read({ remember: false }).value });
  assert.equal(again.$('routing').checked, true);
  assert.equal(again.$('jev-unknown').value, 'weak');
});

test('without a host key API the Jev step names the vault entry and offers no form', () => {
  const { $, routeOn } = mountRouted();
  routeOn();
  assert.match($('jev-status').textContent, /vercel-api-key/);
  assert.equal($('jev-key-input').parentNode.style.display, 'none');
  assert.equal($('jev-test').parentNode.style.display, 'none');
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

test('the key is checked only once routing is chosen, and a missing key opens the paste form', async () => {
  const api = fakeKeyApi();
  const { $, routeOn } = mountRouted({ routingKey: api });
  await flush();
  assert.deepEqual(api.calls.check, [], 'a plain pool never touches the vault');
  routeOn();
  assert.match($('jev-status').textContent, /正在检查/);
  await flush();
  assert.deepEqual(api.calls.check, ['vercel-api-key']);
  assert.equal($('jev-status').classList.contains('missing'), true);
  assert.equal($('jev-key-input').parentNode.style.display, '');
  assert.equal($('jev-test').parentNode.style.display, 'none', 'nothing to test before a key exists');
});

test('saving a pasted key clears the field at once, stores it under the vault name and runs a test', async () => {
  const api = fakeKeyApi();
  const { $, routeOn } = mountRouted({ routingKey: api });
  routeOn();
  await flush();
  $('jev-key-input').value = '  vck_example  ';
  $('jev-key-save').emit('click');
  assert.equal($('jev-key-input').value, '', 'the secret does not linger in the form');
  await flush();
  await flush();
  assert.deepEqual(api.calls.save, [['vercel-api-key', 'vck_example']]);
  assert.equal(api.calls.test.length, 1);
  assert.equal($('jev-status').classList.contains('ok'), true);
  assert.equal($('jev-key-input').parentNode.style.display, 'none');
  assert.equal($('jev-test-result').classList.contains('good'), true);
  assert.match($('jev-test-result').textContent, /412 ms.*简单任务/);
});

test('a rejected key is explained in plain words and the form comes back to replace it', async () => {
  const api = fakeKeyApi({ present: true, test: { ok: false, code: 'jev_http_401', status: 401 } });
  const { $, routeOn } = mountRouted({ routingKey: api });
  routeOn();
  await flush();
  assert.equal($('jev-key-input').parentNode.style.display, 'none', 'a stored key needs no form');
  $('jev-test-input').value = '重构整个鉴权模块';
  $('jev-test').emit('click');
  await flush();
  await flush();
  assert.deepEqual(api.calls.test, [{ apiKeyName: 'vercel-api-key', text: '重构整个鉴权模块' }]);
  assert.equal($('jev-test-result').classList.contains('bad'), true);
  assert.match($('jev-test-result').textContent, /key 无效.*401/);
  assert.equal($('jev-key-input').parentNode.style.display, '');
});
