'use strict';
// Unit tests for the Air floating reminder deck (public/air-notify-deck.js)
// and how the notifier feeds it (public/air-task-notify.js).
//
// A tiny fake DOM is enough: the deck only creates elements, toggles classes
// and writes CSS variables. What is pinned here is the contract the user sees:
//   - one reminder → one card; several → one deck, most important on top;
//   - the deck only fans out when there is more than one card, and folds back
//     by itself when it drops to one;
//   - ✕ / 打开 take exactly that card off (打开 also opens the task);
//   - the arc never has more than MAX_ON_ARC cards, and stays on screen;
//   - the notifier puts every task of a batch on the deck and removes a card
//     when its task is opened or stops waiting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DECK_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'air-notify-deck.js'), 'utf8');
const NOTIFY_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'air-task-notify.js'), 'utf8');

function fakeDom() {
  function node(tag) {
    const classes = new Set();
    const vars = new Map();
    const n = {
      tag, children: [], parent: null, attrs: {}, textContent: '', hidden: false, inert: false,
      style: { zIndex: '', setProperty: (k, v) => vars.set(k, v), getPropertyValue: k => vars.get(k) },
      vars,
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      },
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
      setAttribute(k, v) { n.attrs[k] = v; },
      append(...kids) { kids.forEach(k => n.appendChild(k)); },
      appendChild(k) { k.parent = n; n.children.push(k); return k; },
      remove() { if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n); n.parent = null; },
      find(pred) {
        for (const c of n.children) { if (pred(c)) return c; const hit = c.find(pred); if (hit) return hit; }
        return null;
      },
      findAll(pred, out = []) { for (const c of n.children) { if (pred(c)) out.push(c); c.findAll(pred, out); } return out; },
    };
    return n;
  }
  const listeners = {};
  const doc = {
    body: node('body'),
    visibilityState: 'visible',
    createElement: node,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const timers = [];
  const win = {
    document: doc, innerWidth: 1280, innerHeight: 800,
    addEventListener() {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    navigator: { language: 'zh-CN' },
  };
  const has = c => n => n.classList.contains(c);
  return {
    win, doc, listeners,
    runTimers: () => { while (timers.length) timers.shift()(); },
    deckEl: () => doc.body.find(has('task-notify-deck')),
    scrim: () => doc.body.find(has('task-notify-scrim')),
    cards: () => doc.body.findAll(has('task-notify-card')).filter(c => !c.classList.contains('is-leaving')),
    card: id => doc.body.findAll(has('task-notify-card'))
      .find(c => c.find(has('task-notify-body')).textContent.includes(id)),
    button: (card, cls) => card.find(has(cls)),
    has,
  };
}

function loadDeck(dom) {
  const mod = { exports: {} };
  new Function('window', 'module', DECK_SRC)(dom.win, mod);
  return dom.win.MultiCCNotifyDeck;
}

const translate = (key, vars = {}) => `${key}:${vars.title ?? vars.n ?? ''}`;
let clock = 1000;
const now = () => (clock += 1);

function makeDeck(dom, extra = {}) {
  return loadDeck(dom).create({ window: dom.win, document: dom.doc, translate, now, ...extra });
}

test('one reminder is one card with no badge and no fan-out', () => {
  const dom = fakeDom();
  const deck = makeDeck(dom);
  deck.upsert({ id: 'a', title: 'A' }, 'completed');
  assert.equal(dom.cards().length, 1);
  assert.equal(dom.deckEl().classList.contains('is-multi'), false);
  deck.setOpen(true);
  assert.equal(deck.isOpen(), false, 'a single card has nothing to fan out');
});

test('several reminders stack with the most important on top', () => {
  const dom = fakeDom();
  const deck = makeDeck(dom);
  deck.upsert({ id: 'done1', title: 'done1' }, 'completed');
  deck.upsert({ id: 'err', title: 'err' }, 'error');
  deck.upsert({ id: 'ask', title: 'ask' }, 'waiting');
  deck.upsert({ id: 'done2', title: 'done2' }, 'completed');
  assert.deepEqual(deck.ids(), ['err', 'ask', 'done2', 'done1']);
  assert.ok(dom.card('err').classList.contains('is-top'));
  assert.ok(dom.deckEl().classList.contains('is-multi'));
  assert.equal(dom.deckEl().find(dom.has('task-notify-badge')).textContent, '4');
  // folded: only the top card is interactive
  assert.equal(dom.card('err').inert, false);
  assert.equal(dom.card('ask').inert, true);
});

test('clicking the folded deck fans it out; Esc and the scrim fold it back', () => {
  const dom = fakeDom();
  const deck = makeDeck(dom);
  deck.upsert({ id: 'a', title: 'a' }, 'completed');
  deck.upsert({ id: 'b', title: 'b' }, 'error');
  dom.card('b').onclick();
  assert.equal(deck.isOpen(), true);
  assert.ok(dom.scrim().classList.contains('is-on'));
  for (const card of dom.cards()) assert.equal(card.inert, false, 'every fanned-out card is clickable');
  dom.listeners.keydown.forEach(fn => fn({ key: 'Escape' }));
  assert.equal(deck.isOpen(), false);
  dom.card('b').onclick();
  dom.scrim().onclick();
  assert.equal(deck.isOpen(), false);
});

test('✕ takes only that card off; the deck folds when one card is left', () => {
  const dom = fakeDom();
  const deck = makeDeck(dom);
  deck.upsert({ id: 'a', title: 'a' }, 'completed');
  deck.upsert({ id: 'b', title: 'b' }, 'completed');
  deck.upsert({ id: 'c', title: 'c' }, 'completed');
  deck.setOpen(true);
  dom.button(dom.card('b'), 'task-complete-close').onclick({ stopPropagation() {} });
  assert.deepEqual(deck.ids().sort(), ['a', 'c']);
  assert.equal(deck.isOpen(), true);
  dom.button(dom.card('a'), 'task-complete-close').onclick({ stopPropagation() {} });
  assert.equal(deck.isOpen(), false, 'one card left → nothing to fan out');
  dom.runTimers();
  assert.equal(dom.cards().length, 1);
  deck.remove('c');
  dom.runTimers();
  assert.equal(dom.deckEl().hidden, true);
});

test('打开 opens that task and removes only its card', () => {
  const dom = fakeDom();
  const opened = [];
  const deck = makeDeck(dom, { onOpen: task => opened.push(task.id) });
  deck.upsert({ id: 'a', title: 'a' }, 'completed');
  deck.upsert({ id: 'b', title: 'b' }, 'waiting');
  dom.button(dom.card('a'), 'task-complete-open').onclick({ stopPropagation() {} });
  assert.deepEqual(opened, ['a']);
  assert.deepEqual(deck.ids(), ['b']);
});

test('the arc holds at most MAX_ON_ARC cards and keeps them on screen', () => {
  const dom = fakeDom();
  const api = loadDeck(dom);
  const deck = makeDeck(dom);
  for (let i = 0; i < api.MAX_ON_ARC + 3; i++) deck.upsert({ id: 't' + i, title: 't' + i }, 'completed');
  deck.setOpen(true);
  const onArc = dom.cards().filter(c => c.vars.get('--o') === '1');
  assert.equal(onArc.length, api.MAX_ON_ARC);
  assert.equal(dom.deckEl().find(dom.has('task-notify-more')).textContent, 'deckMore:3');
  for (const card of onArc) {
    const x = parseFloat(card.vars.get('--x'));
    const y = parseFloat(card.vars.get('--y'));
    // anchor is 16px from the bottom-right; a fanned card is 224×58
    assert.ok(x - 224 > -(dom.win.innerWidth - 16), `card left edge on screen (x=${x})`);
    assert.ok(y - 58 > -(dom.win.innerHeight - 16), `card top edge on screen (y=${y})`);
  }
});

test('narrow screens get a column instead of an arc', () => {
  const dom = fakeDom();
  dom.win.innerWidth = 390;
  const deck = makeDeck(dom);
  deck.upsert({ id: 'a', title: 'a' }, 'completed');
  deck.upsert({ id: 'b', title: 'b' }, 'completed');
  deck.setOpen(true);
  assert.ok(dom.deckEl().classList.contains('is-narrow'));
  for (const card of dom.cards()) assert.equal(parseFloat(card.vars.get('--x')), 0);
});

test('notifier: a batch lands on the deck; opening or answering removes the card', () => {
  const dom = fakeDom();
  const store = new Map();
  dom.win.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  dom.win.speechSynthesis = null;
  loadDeck(dom);
  new Function('window', 'document', NOTIFY_SRC)(dom.win, dom.doc);
  const ctrl = dom.win.MultiCCTaskNotify.create({
    window: dom.win, document: dom.doc, presence: null, now,
    setTimeout: dom.win.setTimeout, clearTimeout: dom.win.clearTimeout,
    openTask() {},
  });
  const tasks = [
    { id: 'a', title: 'A', status: 'running' },
    { id: 'b', title: 'B', status: 'running' },
    { id: 'c', title: 'C', status: 'running' },
  ];
  ctrl.onSnapshot(tasks, '');
  tasks[0].status = 'done'; tasks[1].status = 'error'; tasks[2].status = 'waiting';
  ctrl.onSnapshot(tasks, '');
  assert.deepEqual(ctrl.deckIds(), ['b', 'c', 'a']);
  ctrl.markOpened('b');
  assert.deepEqual(ctrl.deckIds(), ['c', 'a']);
  tasks[2].status = 'running';           // answered elsewhere
  ctrl.onSnapshot(tasks, '');
  assert.deepEqual(ctrl.deckIds(), ['a']);
  ctrl.onSnapshot(tasks, 'a');           // now on screen
  assert.deepEqual(ctrl.deckIds(), []);
});
