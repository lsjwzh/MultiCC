'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, showDialog } = require('../public/chat-task-separation');
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
    let release; const close = showDialog({ sourceTitle: '<img onerror=alert(1)>', title: 'New', reason: '<script>bad()</script>' }, () => new Promise(r => { release = r; }));
    assert.ok(elements.some(e => e.textContent === '<script>bad()</script>'));
    assert.ok(elements.every(e => e.innerHTML === undefined));
    const buttons = elements.filter(e => e.tag === 'button'); buttons[1].onclick();
    assert.ok(buttons.every(e => e.disabled)); release(); await new Promise(r => setImmediate(r));
    assert.ok(buttons.every(e => !e.disabled)); close();
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
