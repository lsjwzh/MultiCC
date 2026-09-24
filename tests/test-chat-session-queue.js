'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('../public/chat-session-queue.js');

const queueApi = globalThis.MultiCCChatSessionQueue;
const ROOT = path.join(__dirname, '..');
const ROW_HEIGHT = 30;

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains: name => values.has(name),
  };
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.classList = classList();
    this.style = {};
    this.textContent = '';
    this.attributes = {};
    this.listeners = new Map();
    this.parentNode = null;
    this.rect = { top: 0, height: ROW_HEIGHT };
  }

  // Real appendChild MOVES a node that already has a parent; the dock relies on
  // exactly that to rearrange rows after a drop.
  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter(node => node !== child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

  replaceChildren(...nodes) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this.append(...nodes);
  }

  walk() { return this.children.flatMap(child => [child, ...child.walk()]); }

  querySelector(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    if (!className) return null;
    return this.walk().find(node => String(node.className || '').split(/\s+/).includes(className)) || null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(pointerId) { this.captured = pointerId; }
  releasePointerCapture() { this.released = true; }

  fire(type, event = {}) {
    const full = { button: 0, preventDefault() {}, stopPropagation() {}, ...event };
    for (const handler of this.listeners.get(type) || []) handler(full);
  }
}

function dockFixture() {
  const ids = new Map([
    ['session-queue-dock', new FakeNode('details')],
    ['session-queue-count', new FakeNode('strong')],
    ['session-queue-hint', new FakeNode('span')],
    ['session-queue-list', new FakeNode('div')],
  ]);
  const documentRef = {
    createElement: tag => new FakeNode(tag),
    getElementById: id => ids.get(id) || null,
  };
  const list = ids.get('session-queue-list');
  return { documentRef, list, ids };
}

function queueItems(texts) {
  return texts.map((text, index) => ({
    entryId: `entry-${index + 1}`,
    state: 'pending',
    position: index + 1,
    text,
  }));
}

// Rows are stacked ROW_HEIGHT apart, which is all the drag math reads.
function layout(list) {
  list.children.forEach((row, index) => {
    row.rect = { top: index * ROW_HEIGHT, height: ROW_HEIGHT };
  });
  return list.children;
}

function texts(list) {
  return list.children.map(row => row.querySelector('.session-queue-text').textContent);
}

function positions(list) {
  return list.children.map(row => row.querySelector('.session-queue-position').textContent);
}

function handlers(list) {
  return list.children.map(row => row.querySelector('.session-queue-handle'));
}

function drag(list, from, clientY, step = ROW_HEIGHT) {
  const handle = handlers(list)[from];
  const startY = list.children[from].rect.top + ROW_HEIGHT / 2;
  handle.fire('pointerdown', { pointerId: 7, clientY: startY });
  handle.fire('pointermove', { pointerId: 7, clientY: startY + step });
  handle.fire('pointermove', { pointerId: 7, clientY });
  handle.fire('pointerup', { pointerId: 7, clientY });
}

test('dragging a staged message commits the index it was dropped on', () => {
  const moves = [];
  queueApi.configure({ onReorder: (entryId, toIndex) => moves.push([entryId, toIndex]) });
  const { documentRef, list } = dockFixture();
  queueApi.render(queueItems(['一', '二', '三']), {}, documentRef);
  layout(list);

  // Drop the first row below the third row's midpoint: position 3 of 3 (0-based
  // index 2), and the dock shows the result before the server answers.
  drag(list, 0, 3 * ROW_HEIGHT);
  assert.deepEqual(moves, [['entry-1', 2]]);
  assert.deepEqual(texts(list), ['二', '三', '一']);
  // The numbers follow the rows, so the list never contradicts itself.
  assert.deepEqual(positions(list), ['1.', '2.', '3.']);
  assert.equal(list.children[2].style.transform, '', 'the lifted row is put back down');
});

test('dragging upward lands on the row whose midpoint was passed', () => {
  const moves = [];
  queueApi.configure({ onReorder: (entryId, toIndex) => moves.push([entryId, toIndex]) });
  const { documentRef, list } = dockFixture();
  queueApi.render(queueItems(['一', '二', '三']), {}, documentRef);
  layout(list);

  drag(list, 2, 0, -ROW_HEIGHT);
  assert.deepEqual(moves, [['entry-3', 0]]);
  assert.deepEqual(texts(list), ['三', '一', '二']);
});

test('a tap or a nudge on the handle moves nothing', () => {
  const moves = [];
  queueApi.configure({ onReorder: (entryId, toIndex) => moves.push([entryId, toIndex]) });
  const { documentRef, list } = dockFixture();
  queueApi.render(queueItems(['一', '二', '三']), {}, documentRef);
  layout(list);

  const handle = handlers(list)[0];
  handle.fire('pointerdown', { pointerId: 3, clientY: 15 });
  handle.fire('pointerup', { pointerId: 3, clientY: 15 });
  assert.deepEqual(moves, [], 'a tap on the handle is not a move');

  // 2px of drift stays a tap: the slop exists so a finger resting on the handle
  // does not rearrange the queue by itself.
  handle.fire('pointerdown', { pointerId: 3, clientY: 15 });
  handle.fire('pointermove', { pointerId: 3, clientY: 17 });
  handle.fire('pointerup', { pointerId: 3, clientY: 17 });
  assert.deepEqual(moves, []);
  assert.deepEqual(texts(list), ['一', '二', '三']);
  assert.equal(list.children[0].style.transform, '');
});

test('a queue event during a drag drops the gesture instead of committing a stale index', () => {
  const moves = [];
  queueApi.configure({ onReorder: (entryId, toIndex) => moves.push([entryId, toIndex]) });
  const { documentRef, list } = dockFixture();
  queueApi.render(queueItems(['一', '二', '三']), {}, documentRef);
  layout(list);

  const handle = handlers(list)[0];
  handle.fire('pointerdown', { pointerId: 5, clientY: 15 });
  handle.fire('pointermove', { pointerId: 5, clientY: 75 });
  // A new message arrives mid-gesture: the rows the drag was measured against
  // are gone, so the drop must not be interpreted against them.
  queueApi.render(queueItems(['一', '二', '三', '四']), {}, documentRef);
  handle.fire('pointerup', { pointerId: 5, clientY: 75 });
  assert.deepEqual(moves, []);
});

test('arrow keys on the handle move one slot and stop at the ends', () => {
  const moves = [];
  queueApi.configure({ onReorder: (entryId, toIndex) => moves.push([entryId, toIndex]) });
  const { documentRef, list } = dockFixture();
  queueApi.render(queueItems(['一', '二', '三']), {}, documentRef);
  layout(list);

  const rows = handlers(list);
  rows[0].fire('keydown', { key: 'ArrowDown' });
  rows[2].fire('keydown', { key: 'ArrowUp' });
  assert.deepEqual(moves, [['entry-1', 1], ['entry-3', 1]]);
  // The first row has nowhere to go up to, and the last has nowhere to go down.
  rows[0].fire('keydown', { key: 'ArrowUp' });
  rows[2].fire('keydown', { key: 'ArrowDown' });
  rows[1].fire('keydown', { key: 'Enter' });
  assert.deepEqual(moves, [['entry-1', 1], ['entry-3', 1]]);
});

test('only entries the user may move get a handle', () => {
  queueApi.configure({ onReorder: () => { throw new Error('must not be called'); } });
  const { documentRef, list } = dockFixture();
  queueApi.render([
    { entryId: 'leased', state: 'leased', position: 1, text: '执行中' },
    { entryId: 'pending', state: 'pending', position: 2, text: '可移动' },
  ], {}, documentRef);
  assert.equal(handlers(list)[0], null, 'a claimed entry has no handle');
  assert.ok(handlers(list)[1], 'the pending entry does');

  // A single staged message has no order to change, so nothing is offered.
  queueApi.render(queueItems(['唯一一条']), {}, documentRef);
  assert.equal(handlers(list)[0], null);
});

test('the reorder handler posts the confirmed entry-scoped action', async () => {
  const requests = [];
  const notices = [];
  const handler = queueApi.createReorderHandler({
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, reordered: { to: 1 } }) };
    },
    withToken: url => `/tokenized${url}`,
    getSessionName: () => 'session/1',
    notify: (message, kind) => notices.push([message, kind]),
  });

  assert.equal(await handler('entry-2', 1), true);
  assert.equal(requests[0].url, '/tokenized/api/sessions/session%2F1/queue/action');
  assert.deepEqual(requests[0].body, {
    action: 'reorder_queued',
    entryId: 'entry-2',
    confirm: true,
    toIndex: 1,
  });
  assert.deepEqual(notices, [['已调整暂存消息顺序', 'completed']]);

  // A move the scheduler refuses is reported, and the row snaps back when the
  // queue event that follows re-renders it.
  const refusing = queueApi.createReorderHandler({
    fetch: async () => ({ ok: false, json: async () => ({ ok: false, code: 'queued_entry_already_claimed' }) }),
    withToken: url => url,
    getSessionName: () => 's1',
    notify: (message, kind) => notices.push([message, kind]),
  });
  await assert.rejects(() => refusing('entry-2', 0), /已经开始执行/);
  assert.deepEqual(notices.at(-1), ['这条消息已经开始执行，无法再调整。', 'error']);
});

test('the dock renders the order it was given and honours the shared status registry', () => {
  const { documentRef, list, ids } = dockFixture();
  queueApi.render([
    { entryId: 'b', state: 'pending', position: 1, text: '第二条被排到前面' },
    { entryId: 'a', state: 'pending', position: 2, text: '第一条' },
  ], { state: 'frozen', freezeReason: 'classify_error' }, documentRef);
  assert.deepEqual(texts(list), ['第二条被排到前面', '第一条']);
  assert.equal(ids.get('session-queue-count').textContent, '2');
  assert.equal(ids.get('session-queue-dock').hidden, false);

  queueApi.render([], {}, documentRef);
  assert.equal(ids.get('session-queue-dock').hidden, true);
  assert.equal(list.children.length, 0);
});

test('the queue dock keeps its textContent-only rendering', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'chat-session-queue.js'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=/, 'staged messages are user text: never parsed as HTML');
  assert.match(source, /session-queue-handle/);
  // The handle must be a button so the same move is reachable without a drag.
  assert.match(source, /handle\.type = 'button'/);
});

test('insert receipt never claims execution without started proof', async () => {
  const queue = queueApi;
  for (const started of [false, undefined, true]) {
    const notices = [];
    const run = queue.createInsertHandler({
      fetch: async () => ({ ok: true, json: async () => ({ ok: true, started }) }),
      withToken: x => x, getSessionName: () => 's1', notify: (...args) => notices.push(args),
    });
    assert.equal(await run('entry-1'), started === true);
    assert.equal(notices[0][1], started === true ? 'completed' : 'info');
    if (started !== true) assert.match(notices[0][0], /尚未开始/);
  }
});
