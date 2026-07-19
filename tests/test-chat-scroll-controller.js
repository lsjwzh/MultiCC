'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScrollController } = require('../public/chat-scroll-controller');

const ROOT = path.join(__dirname, '..');

class FakeClassList {
  constructor() { this.values = new Set(); }
  set(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toString() { return [...this.values].join(' '); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.style = {};
    this.listeners = new Map();
    this.scrollHeight = 1000;
    this.clientHeight = 300;
    this._scrollTop = 0;
    this.offsetHeight = 34;
    this.textContent = '';
  }
  set className(value) { this.classList.set(value); }
  get className() { return this.classList.toString(); }
  set scrollTop(value) {
    this._scrollTop = Math.max(0, Math.min(Number(value) || 0, this.scrollHeight - this.clientHeight));
  }
  get scrollTop() { return this._scrollTop; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  dispatch(name) { this.listeners.get(name)?.({ type: name }); }
  setAttribute() {}
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  getBoundingClientRect() { return { left: 0, top: 100, width: 390, bottom: 700 }; }
}

function fixture() {
  const messagesEl = new FakeElement('main');
  const body = new FakeElement('body');
  const document = { body, createElement: tag => new FakeElement(tag) };
  const windowListeners = new Map();
  const frames = [];
  const timers = [];
  let clock = 1000;
  const window = {
    document,
    visualViewport: {
      addEventListener(name, fn) { windowListeners.set(`viewport:${name}`, fn); },
      removeEventListener(name) { windowListeners.delete(`viewport:${name}`); },
    },
    addEventListener(name, fn) { windowListeners.set(name, fn); },
    removeEventListener(name) { windowListeners.delete(name); },
  };
  const controller = createScrollController({
    window,
    document,
    messagesEl,
    now: () => clock,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    setTimeout: (fn, delay) => { timers.push({ fn, delay, active: true }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].active = false; },
    translate: (key, params) => key === 'newMessagesCount'
      ? `${params.n} new`
      : key === 'backToBottom' ? 'Back to bottom' : key,
  });
  return {
    body,
    controller,
    frames,
    messagesEl,
    timers,
    advance(ms) { clock += ms; },
    runTimers() {
      for (const timer of timers.filter(item => item.active).sort((a, b) => a.delay - b.delay)) {
        timer.active = false;
        timer.fn();
      }
    },
  };
}

test('forceToBottom writes synchronously and converges after mobile layout growth', () => {
  const f = fixture();
  f.controller.forceToBottom();
  assert.equal(f.messagesEl.scrollTop, 700, 'does not depend on animation frames');

  f.messagesEl.scrollHeight = 1400;
  f.runTimers();
  assert.equal(f.messagesEl.scrollTop, 1100, 'settling retries use the final layout height');
  assert.equal(f.controller.snapshot().atBottom, true);
});

test('content growth follows whenever the user did not pin away', () => {
  const f = fixture();
  f.messagesEl.scrollTop = 700;
  f.messagesEl.scrollHeight = 1240;

  f.controller.maybeFollow();

  assert.equal(f.messagesEl.scrollTop, 940);
  assert.deepEqual(f.controller.snapshot(), {
    atBottom: true,
    distanceFromBottom: 0,
    userPinnedAway: false,
    unreadCount: 0,
    pillVisible: false,
  });
});

test('an intentional mobile scroll immediately shows Back to bottom', () => {
  const f = fixture();
  f.messagesEl.scrollTop = 400;

  f.controller.handleScroll({ userInitiated: true });

  assert.equal(f.controller.snapshot().userPinnedAway, true);
  assert.equal(f.controller.snapshot().pillVisible, true);
  const pill = f.body.children[0];
  assert.equal(pill.children[1].textContent, 'Back to bottom');
  assert.equal(pill.style.left, '195px');
  assert.equal(pill.style.top, '654px');
});

test('pinned users stay in place and unread counting is turn-bounded', () => {
  const f = fixture();
  f.messagesEl.scrollTop = 350;
  f.controller.handleScroll({ userInitiated: true });

  f.messagesEl.scrollHeight = 1300;
  f.controller.maybeFollow();
  f.controller.maybeFollow();
  assert.equal(f.messagesEl.scrollTop, 350);
  assert.equal(f.controller.snapshot().unreadCount, 1);
  assert.equal(f.body.children[0].children[1].textContent, '1 new');

  f.controller.rearmUnread();
  f.controller.maybeFollow();
  assert.equal(f.controller.snapshot().unreadCount, 2);
});

test('pill click returns to the latest layout and clears pinned state', () => {
  const f = fixture();
  f.messagesEl.scrollTop = 250;
  f.controller.handleScroll({ userInitiated: true });
  const pill = f.body.children[0];

  pill.listeners.get('click')();

  assert.equal(f.messagesEl.scrollTop, 700);
  assert.equal(f.controller.snapshot().userPinnedAway, false);
  assert.equal(f.controller.snapshot().pillVisible, false);
});

test('classic chat wires image and viewport growth into the controller', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  const controllerTag = '<script src="chat-scroll-controller.js"></script>';

  assert.ok(html.indexOf(controllerTag) < html.indexOf('<script src="chat.js"></script>'));
  assert.match(html, /\.new-msg-pill\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(chat, /createScrollController\(\{[\s\S]*?translate:\s*tt/);
  assert.match(chat, /querySelectorAll\('img'\)[\s\S]*?addEventListener\('load', \(\) => chatScrollController\?\.handleLayoutChange\(\)/);
  assert.doesNotMatch(chat, /!_userPinnedAway\s*&&\s*isAtBottom\(\)/);
});
