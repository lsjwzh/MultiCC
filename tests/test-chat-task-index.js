'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../public/chat-task-index');

class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.hidden = false;
    this.className = ''; this.classList = { values: new Set(), add: (...v) => v.forEach(x => this.classList.values.add(x)),
      remove: (...v) => v.forEach(x => this.classList.values.delete(x)), contains: v => this.classList.values.has(v) };
    this.attributes = {}; this.listeners = {}; this.scrolls = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  remove() { this.removed = true; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  scrollIntoView() { this.scrolls += 1; }
  querySelectorAll(selector) {
    if (selector === '.msg[data-task-short-code]') return this.children.filter(node => node.className === 'msg' && node.dataset.taskShortCode);
    return [];
  }
}

function fixture() {
  const messages = new FakeNode('section'), body = new FakeNode('body');
  const doc = { body, createElement: tag => new FakeNode(tag) };
  const storage = new Map();
  return { messages, doc, storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } };
}

test('index is hidden without task codes, then lists unique four-character codes and jumps', () => {
  const f = fixture(), detached = [];
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage,
    onDetach: item => detached.push(item) });
  assert.equal(f.doc.body.children[0].hidden, true);
  const first = new FakeNode('article'); first.className = 'msg'; first.dataset = { taskShortCode: 'b002', taskId: 'tsk-b', taskName: 'Beta' };
  const second = new FakeNode('article'); second.className = 'msg'; second.dataset = { taskShortCode: 'A001', taskId: 'tsk-a', taskName: 'Alpha' };
  f.messages.children.push(first, second); controller.refresh();
  const toggle = f.doc.body.children[0], rail = f.doc.body.children[1];
  assert.equal(toggle.hidden, false); toggle.onclick();
  assert.equal(rail.hidden, false); assert.equal(rail.children.length, 2);
  assert.equal(rail.children[0].children[0].textContent, 'A001');
  rail.children[1].children[0].onclick();
  assert.equal(first.scrolls, 1); assert.ok(first.classList.contains('task-index-target'));
  rail.children[0].children[1].onclick({ stopPropagation() {} });
  assert.equal(detached[0].taskId, 'tsk-a');
  controller.dispose();
});

test('toggle preference is persisted and detach action is omitted when no task id exists', () => {
  const f = fixture(); f.storage.setItem('multicc:task-index-open', '1');
  const controller = createController({ document: f.doc, messagesEl: f.messages, storage: f.storage });
  const message = new FakeNode('article'); message.className = 'msg'; message.dataset.taskShortCode = 'C003';
  f.messages.children.push(message); controller.refresh();
  assert.equal(f.doc.body.children[1].hidden, false);
  assert.equal(f.doc.body.children[1].children[0].children.length, 1);
});
