'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../public/chat-user-input-card.js');

// Minimal DOM stub: the controller only touches a bounded set of properties and
// methods, so a hand-rolled element is enough — no jsdom dependency.
function fakeEl(tag) {
  const el = {
    tagName: String(tag || '').toUpperCase(),
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    dataset: {},
    children: [],
    appendChild(child) { this.children.push(child); },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = Array.from(kids); },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    setAttribute() {},
    getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
  if (/^(input|checkbox)$/i.test(tag)) el.checked = false;
  return el;
}

function fakeDoc() {
  return { createElement: fakeEl, getElementById: () => null };
}

function fixture({ withCollapse = true } = {}) {
  const doc = fakeDoc();
  const elements = {
    root: Object.assign(fakeEl('section'), { hidden: true }),
    question: fakeEl('div'),
    reason: fakeEl('div'),
    options: fakeEl('div'),
    textInput: fakeEl('textarea'),
    submitButton: fakeEl('button'),
  };
  if (withCollapse) {
    elements.collapseBtn = fakeEl('button');
    // The fab starts hidden in the HTML (it appears only when collapsed).
    elements.fab = Object.assign(fakeEl('button'), { hidden: true });
  }
  const submitted = [];
  const controller = createController({
    document: doc,
    elements,
    isConnected: () => true,
    submitAnswer: (value, requestId) => { submitted.push({ value, requestId }); return true; },
  });
  return { controller, elements, submitted };
}

test('render shows the card and hides the floating bubble', () => {
  const fx = fixture();
  fx.controller.render({ requestId: 'usrq-1', question: '部署？', options: ['是', '否'] });
  assert.equal(fx.elements.root.hidden, false);
  assert.equal(fx.elements.fab.hidden, true);
});

test('collapse hides the card and shows the bubble; expand restores the card', () => {
  const fx = fixture();
  fx.controller.render({ requestId: 'usrq-1', question: '部署？', options: ['是'] });
  assert.equal(fx.controller.collapse(), true);
  assert.equal(fx.elements.root.hidden, true);
  assert.equal(fx.elements.fab.hidden, false);
  assert.equal(fx.controller.expand(), true);
  assert.equal(fx.elements.root.hidden, false);
  assert.equal(fx.elements.fab.hidden, true);
});

test('collapse without a pending prompt is a no-op and keeps the bubble hidden', () => {
  const fx = fixture();
  assert.equal(fx.controller.collapse(), false);
  assert.equal(fx.elements.fab.hidden, true);
  assert.equal(fx.elements.root.hidden, true);
});

test('clear hides both the card and the bubble (answered from another window while collapsed)', () => {
  const fx = fixture();
  fx.controller.render({ requestId: 'usrq-1', question: '部署？' });
  fx.controller.collapse();
  assert.equal(fx.elements.fab.hidden, false);
  fx.controller.clear('usrq-1');
  assert.equal(fx.elements.root.hidden, true);
  assert.equal(fx.elements.fab.hidden, true);
});

test('a new prompt arriving while collapsed re-expands the card and hides the bubble', () => {
  const fx = fixture();
  fx.controller.render({ requestId: 'usrq-1', question: 'first' });
  fx.controller.collapse();
  fx.controller.render({ requestId: 'usrq-2', question: 'second' });
  assert.equal(fx.elements.root.hidden, false);
  assert.equal(fx.elements.fab.hidden, true);
});

test('expand after collapse rebuilds option inputs so submit still works', () => {
  const fx = fixture();
  fx.controller.render({ requestId: 'usrq-1', question: '部署？', options: ['是', '否'] });
  fx.controller.collapse();
  fx.controller.expand();
  assert.equal(fx.controller.submit('是'), true);
  assert.deepEqual(fx.submitted, [{ value: '是', requestId: 'usrq-1' }]);
  // submit success clears → bubble hidden too.
  assert.equal(fx.elements.fab.hidden, true);
});

test('collapse/expand are robust when the host omits the bubble affordances', () => {
  const fx = fixture({ withCollapse: false });
  fx.controller.render({ requestId: 'usrq-1', question: '部署？' });
  // No fab/collapseBtn wired: collapse still flips the card hidden (the feature
  // degrades to "just hide"); expand re-shows it. Nothing throws.
  assert.equal(fx.controller.collapse(), true);
  assert.equal(fx.elements.root.hidden, true);
  assert.equal(fx.controller.expand(), true);
  assert.equal(fx.elements.root.hidden, false);
});
