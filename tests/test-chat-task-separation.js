'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, showDialog, showPill } = require('../public/chat-task-separation');

function fakeDocument() {
  const elements = [];
  const element = tag => ({ tag, children: [], style: {}, listeners: {},
    append(...children) { this.children.push(...children); }, setAttribute(name, value) { this.attributes = { ...this.attributes, [name]: value }; },
    addEventListener(event, fn) { this.listeners[event] = fn; }, show() { this.nonModal = true; },
    showModal() { this.modal = true; }, close() { this.closed = true; }, remove() { this.removed = true; } });
  return { elements, document: { createElement: tag => { const node = element(tag); elements.push(node); return node; }, body: element('body') } };
}
function fixture() {
  const f = { suggestion: { id: 'sep_1', title: 'New goal' }, session: 's1', requests: [], shown: [], closes: 0, navigated: [] };
  f.controller = createController({ getSession: () => f.session,
    request: async (url, options) => {
      f.requests.push({ url, options });
      if (!options) return { suggestion: f.suggestion };
      if (f.error) throw f.error;
      f.suggestion = null;
      return { decision: options.json.decision, url: '/air?task=new' };
    },
    show: (suggestion, decide) => { f.shown.push({ suggestion, decide }); return () => { f.closes++; }; },
    navigate: url => f.navigated.push(url),
  }); return f;
}
test('reconnect restores one dialog, keep saves an explicit decision without navigation', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.shown.length, 1); await f.shown[0].decide('keep');
  await f.controller.refresh(); assert.equal(f.shown.length, 1); assert.equal(f.closes, 1);
  assert.deepEqual(f.requests[2].options.json, { decision: 'keep' }); assert.equal(f.navigated.length, 0);
});
test('confirmation navigates only after success; source errors preserve the same dialog for retry', async () => {
  const f = fixture(); await f.controller.refresh(); f.error = new Error('Commit source changes first');
  await assert.rejects(f.shown[0].decide('separate'), /Commit source/);
  assert.equal(f.closes, 0); assert.equal(f.navigated.length, 0);
  f.error = null; await f.shown[0].decide('separate');
  assert.deepEqual(f.navigated, ['/air?task=new']);
});
test('stale or resolved suggestion closes, and execution switches cannot submit an old decision', async () => {
  const f = fixture(); await f.controller.refresh(); f.session = 's2';
  await assert.rejects(f.shown[0].decide('separate'), /separation_stale/);
  f.suggestion = null; await f.controller.refresh(); assert.equal(f.closes, 1);
});
test('a late fetch cannot display a suggestion for an old session', async () => {
  let session = 'a', release, shows = 0;
  const c = createController({ getSession: () => session,
    request: () => session === 'a' ? new Promise(r => { release = r; }) : Promise.resolve({ suggestion: null }),
    show: () => { shows++; }, navigate() {} });
  const p = c.refresh(); session = 'b'; release({ suggestion: { id: 'old' } }); await p;
  await new Promise(r => setImmediate(r)); assert.equal(shows, 0);
});
test('popup renders untrusted names/reasons as text and disables both actions while saving', async () => {
  const old = global.document;
  const elements = [];
  const element = tag => ({ tag, children: [], style: {}, listeners: {},
    append(...children) { this.children.push(...children); }, setAttribute() {},
    addEventListener(event, fn) { this.listeners[event] = fn; }, showModal() {}, close() {}, remove() {} });
  global.document = { createElement: tag => { const e = element(tag); elements.push(e); return e; }, body: element('body') };
  try {
    let release; const handle = showDialog({ sourceTitle: '<img onerror=alert(1)>', title: 'New', reason: '<script>bad()</script>' }, () => new Promise(r => { release = r; }));
    assert.ok(elements.some(e => e.textContent === '<script>bad()</script>'));
    assert.ok(elements.every(e => e.innerHTML === undefined));
    const buttons = elements.filter(e => e.tag === 'button'); buttons[1].onclick();
    assert.ok(buttons.every(e => e.disabled)); release(); await new Promise(r => setImmediate(r));
    assert.ok(buttons.every(e => !e.disabled)); handle.close();
  } finally { global.document = old; }
});

test('separation suggestion uses a non-modal dialog when the browser supports it', () => {
  const old = global.document, elements = [];
  const element = tag => ({ tag, children: [], style: {},
    append(...children) { this.children.push(...children); }, setAttribute() {},
    addEventListener() {}, show() { this.nonModal = true; }, showModal() { this.modal = true; },
    close() {}, remove() {} });
  global.document = { createElement: tag => { const e = element(tag); elements.push(e); return e; }, body: element('body') };
  try {
    showDialog({ title: 'New' }, () => {});
    const dialog = elements.find(e => e.tag === 'dialog');
    assert.equal(dialog.nonModal, true);
    assert.equal(dialog.modal, undefined);
  } finally { global.document = old; }
});

test('later replaces the card with a durable pill instead of deciding or navigating', async () => {
  const state = { suggestion: { id: 'sep_1', title: 'New goal' }, pills: [], cards: [], closed: 0, navigated: [] };
  const controller = createController({ getSession: () => 's1',
    request: async (url, options) => options ? { decision: options.json.decision, url: '/air?task=new' } : { suggestion: state.suggestion },
    show: (suggestion, decide, collapse) => { state.cards.push({ suggestion, decide, collapse }); return { close() { state.closed += 1; } }; },
    showPill: suggestion => { state.pills.push(suggestion); return { close() {} }; },
    navigate: url => state.navigated.push(url) });
  await controller.refresh();
  await state.cards[0].decide('defer');
  assert.equal(state.pills.length, 1);
  assert.equal(state.pills[0].deferred, true);
  // The card is replaced, never left stacked underneath the pill.
  assert.equal(state.closed, 1);
  assert.deepEqual(state.navigated, []);
});

test('a collapsed card reopens from the pill, and a stale pill can only be dismissed', () => {
  const { elements, document } = fakeDocument();
  const old = global.document;
  global.document = document;
  try {
    let expanded = 0;
    showPill({ id: 'sep_1', title: 'X', deferred: true }, () => {}, () => { expanded += 1; });
    const live = elements.filter(node => node.tag === 'button');
    assert.deepEqual(live.map(node => node.textContent), ['taskSeparationExpand']);
    live[0].onclick();
    assert.equal(expanded, 1);
    elements.length = 0;
    showPill({ id: 'sep_1', title: 'X', stale: true }, () => {}, () => { expanded += 1; });
    const stale = elements.filter(node => node.tag === 'button');
    assert.deepEqual(stale.map(node => node.textContent), ['taskSeparationDiscard']);
    stale[0].onclick();
    assert.equal(expanded, 1);
  } finally { global.document = old; }
});

test('escape collapses the card without choosing an answer', () => {
  const { elements, document } = fakeDocument();
  const old = global.document;
  global.document = document;
  try {
    let decisions = 0, collapses = 0;
    showDialog({ id: 'sep_1', title: 'New' }, () => { decisions += 1; }, () => { collapses += 1; });
    const dialog = elements.find(node => node.tag === 'dialog');
    let prevented = false;
    dialog.listeners.cancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(collapses, 1);
    assert.equal(decisions, 0);
  } finally { global.document = old; }
});
