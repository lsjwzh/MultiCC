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

test('a user-edited tier survives its own change event and an unrelated row toggling afterward', () => {
  const document = fakeDocument();
  const container = document.createElement('div');
  document.body.appendChild(container);
  editor.mount({ document, container, providers: providers(), protocol: 'anthropic' });
  const row = id => container.querySelectorAll('.multicc-auto-editor-row')
    .find(candidate => candidate.dataset.providerId === id);

  // A third enabled candidate widens the ladder to three rungs, so there is
  // an alternative tier value that is neither the row's fixed creation seed
  // nor whatever syncRungs happened to compute for it.
  row('managed-c').querySelector('.multicc-auto-editor-enabled').checked = true;
  row('managed-c').querySelector('.multicc-auto-editor-enabled').emit('change');
  const routingEnabled = container.querySelector('.multicc-auto-editor-routing');
  routingEnabled.checked = true;
  routingEnabled.emit('change');

  const tier = row('managed-a').querySelector('.multicc-auto-editor-tier');
  const seed = tier.dataset.rung; // the one-time creation-time seed; must never win again
  const alternative = tier.options.map(option => option.value).find(value => value !== seed);
  assert.ok(alternative, 'the three-rung ladder must offer a value other than the seed');

  tier.value = alternative;
  tier.emit('change');
  assert.equal(tier.value, alternative,
    'the tier the user just picked must stick through its own change notification');

  // Toggling an unrelated row is exactly the trigger that used to silently
  // snap every other row's tier back to its stale dataset.rung seed.
  row('official').querySelector('.multicc-auto-editor-enabled').checked = true;
  row('official').querySelector('.multicc-auto-editor-enabled').emit('change');
  assert.equal(tier.value, alternative,
    'an unrelated row change must not revert a previously edited tier');
});

test('a difficulty-routing warning appears only when routing is on and the vault key is confirmed missing', () => {
  const document = fakeDocument();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const control = editor.mount({ document, container, providers: providers(), protocol: 'anthropic' });
  const warning = () => container.querySelector('.multicc-auto-editor-routing-key-warning');
  const routingEnabled = () => container.querySelector('.multicc-auto-editor-routing');

  assert.equal(warning().style.display, 'none', 'hidden before routing is ever touched');

  routingEnabled().checked = true;
  routingEnabled().emit('change');
  assert.equal(warning().style.display, 'none',
    'an unknown (null) key status must not be reported as missing');

  control.setContext({ routingKeyConfigured: false });
  routingEnabled().checked = true;
  routingEnabled().emit('change');
  assert.equal(warning().style.display, '', 'shown once routing is on and the key is confirmed absent');

  routingEnabled().checked = false;
  routingEnabled().emit('change');
  assert.equal(warning().style.display, 'none', 'hidden again as soon as routing is turned off');

  routingEnabled().checked = true;
  routingEnabled().emit('change');
  assert.equal(warning().style.display, '', 'reappears while routing is on and the key is still missing');

  control.setContext({ routingKeyConfigured: true });
  routingEnabled().checked = true;
  routingEnabled().emit('change');
  assert.equal(warning().style.display, 'none', 'hidden once the key is confirmed present');
});
