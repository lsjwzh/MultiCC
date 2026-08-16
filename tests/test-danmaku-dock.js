'use strict';

// Danmaku floating dock (web side of the Background-Tasks draggable entry).
//
// Locks the contract the App's BackgroundTasksFloatingDock also honours:
//   * the fab only exists while task rows do — empty means fully hidden;
//   * badge counts RUNNING rows only, and aria-label carries the count;
//   * tap expands the anchored panel (scrim + aria-expanded), drag never does;
//   * release snaps to the nearest screen edge and persists side+dy exactly
//     once (never per pointermove); pointercancel settles instead of hanging;
//   * a stored placement restores clamped to the current viewport, and a
//     resize re-clamps an in-band position;
//   * all-terminal rows still converge through the legacy 5s auto-hide, which
//     now folds the whole dock (fab included) away.

const assert = require('node:assert/strict');
const test = require('node:test');

const liveUiApi = require('../public/chat-live-ui');

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      if (force === true) values.add(name);
      else if (force === false) values.delete(name);
      else if (values.has(name)) values.delete(name);
      else values.add(name);
    },
  };
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.classList = classList();
    this.style = {};
    this.textContent = '';
    this.attrs = {};
    this.handlers = new Map();
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.handlers.get(type) || []) {
      fn({ stopPropagation() {}, preventDefault() {}, ...event });
    }
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
  removeAttribute(key) { delete this.attrs[key]; }
  setPointerCapture() {}
  releasePointerCapture() {}
  append(...nodes) {
    nodes.forEach(node => {
      if (node == null) return;
      node.parentNode = this;
      this.children.push(node);
    });
  }
  appendChild(node) { this.append(node); return node; }
  prepend(node) { node.parentNode = this; this.children.unshift(node); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

function mapStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    dump: () => Object.fromEntries(data),
  };
}

function eventedWindow(size) {
  const handlers = new Map();
  return {
    ...size,
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    dispatch(type, event) {
      for (const fn of handlers.get(type) || []) fn(event || {});
    },
  };
}

function controlledClock() {
  const timers = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, ms: ms || 0 }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms <= ms) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

function dockFixture({ storage } = {}) {
  const ids = new Map();
  const make = (id, tag = 'div') => { const node = new FakeEl(tag); ids.set(id, node); return node; };
  make('danmaku-panel');
  make('danmaku-head');
  make('danmaku-body');
  make('danmaku-title');
  make('danmaku-count');
  make('danmaku-dot');
  make('danmaku-collapse-btn', 'button');
  make('danmaku-fab', 'button');
  make('danmaku-fab-badge');
  make('danmaku-scrim');
  const document = {
    body: new FakeEl('body'),
    createElement: tag => new FakeEl(tag),
    createTextNode(text) { const node = new FakeEl('#text'); node.textContent = text; return node; },
    getElementById: id => ids.get(id) || null,
    addEventListener() {},
    removeEventListener() {},
  };
  const timers = controlledClock();
  const win = eventedWindow({ innerWidth: 1280, innerHeight: 800 });
  const store = storage === null ? null : (storage || mapStorage());
  const liveUi = liveUiApi.createLiveUi({
    document,
    window: win,
    messagesEl: new FakeEl('div'),
    storage: store,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { ids, win, timers, store, liveUi };
}

const fabOf = fixture => fixture.ids.get('danmaku-fab');
const panelOf = fixture => fixture.ids.get('danmaku-panel');

test('fab stays hidden while empty; badge counts running rows only', () => {
  const fixture = dockFixture();
  assert.equal(fabOf(fixture).style.display, undefined);

  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  fixture.liveUi.pushDanmaku('start', '任务 B', 't2');
  fixture.liveUi.pushDanmaku('done', '任务 C', 't3');
  assert.equal(fabOf(fixture).style.display, 'flex');
  const badge = fixture.ids.get('danmaku-fab-badge');
  assert.equal(badge.textContent, '2');
  assert.match(fabOf(fixture).getAttribute('aria-label'), /2 个进行中/);

  fixture.liveUi.pushDanmaku('done', '任务 A done', 't1');
  fixture.liveUi.pushDanmaku('done', '任务 B done', 't2');
  assert.equal(badge.style.display, 'none');
  assert.equal(badge.textContent, '');
  assert.match(fabOf(fixture).getAttribute('aria-label'), /0 个进行中/);
});

test('tap expands the anchored panel with scrim + aria; scrim tap collapses', () => {
  const fixture = dockFixture();
  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  const fab = fabOf(fixture);

  // Tap = pointerdown/up with no movement, then the browser's click.
  fab.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0 });
  fab.dispatch('pointerup', { clientX: 100, clientY: 100 });
  fab.dispatch('click');
  assert.equal(panelOf(fixture).style.display, 'flex');
  assert.equal(fab.getAttribute('aria-expanded'), 'true');
  assert.equal(fixture.ids.get('danmaku-scrim').style.display, 'block');
  // Panel anchored to a left-snapped fab opens to its right; the fab rests at
  // the band bottom (top 632) so 632+260 overflows → the panel flips above.
  const panel = panelOf(fixture);
  assert.equal(panel.style.top, 'auto');
  assert.equal(panel.style.bottom, `${800 - 632 + 8}px`);
  assert.ok(Number.parseInt(panel.style.left, 10) > 58);

  fixture.ids.get('danmaku-scrim').dispatch('click');
  assert.equal(panelOf(fixture).style.display, 'none');
  assert.equal(fab.getAttribute('aria-expanded'), 'false');

  // Keyboard parity: Enter/Space are clicks on a <button>; Escape collapses.
  fab.dispatch('click');
  assert.equal(panelOf(fixture).style.display, 'flex');
  fab.dispatch('keydown', { key: 'Escape' });
  assert.equal(panelOf(fixture).style.display, 'none');
});

test('drag never expands; snaps to the nearest edge and persists once', () => {
  const fixture = dockFixture();
  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  const fab = fabOf(fixture);
  assert.equal(fab.style.left, '10px');
  assert.equal(fab.style.top, '632px');

  // Pointer sequence crossing centre-right; the first 5px stay under slop.
  fab.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0 });
  fab.dispatch('pointermove', { clientX: 105, clientY: 100 });
  assert.equal(fab.classList.contains('dm-dragging'), false, 'under slop: no drag yet');
  fab.dispatch('pointermove', { clientX: 110, clientY: 100 });
  assert.equal(fab.classList.contains('dm-dragging'), true);
  fab.dispatch('pointermove', { clientX: 720, clientY: 100 });
  assert.equal(fab.style.left, '630px');
  fab.dispatch('pointerup', { clientX: 720, clientY: 100 });

  // Snapped to the right edge, panel untouched, placement persisted once.
  assert.equal(fab.style.left, '1222px');
  assert.equal(fab.classList.contains('dm-dragging'), false);
  assert.equal(panelOf(fixture).style.display, undefined, 'drag must not expand');
  assert.deepEqual(fixture.store.dump(), { danmakuDockSide: 'right', danmakuDockDy: '1' });

  // The click the browser fires after a drag is suppressed...
  fab.dispatch('click');
  assert.equal(panelOf(fixture).style.display, undefined);
  // ...and normal toggling resumes on the next interaction.
  fixture.timers.tick(0);
  fab.dispatch('click');
  assert.equal(panelOf(fixture).style.display, 'flex');
});

test('pointercancel settles to the nearest edge instead of hanging mid-drag', () => {
  const fixture = dockFixture();
  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  const fab = fabOf(fixture);
  fab.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0 });
  fab.dispatch('pointermove', { clientX: 130, clientY: 100 });
  assert.equal(fab.style.left, '40px');
  fab.dispatch('pointercancel', { clientX: 130, clientY: 100 });
  // Left of centre → snaps back to the left edge.
  assert.equal(fab.style.left, '10px');
  assert.equal(fab.classList.contains('dm-dragging'), false);
  assert.equal(fixture.store.dump().danmakuDockSide, 'left');
});

test('stored placement restores, clamped to the current viewport', () => {
  const fixture = dockFixture({ storage: mapStorage({ danmakuDockSide: 'right', danmakuDockDy: '0.5' }) });
  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  const fab = fabOf(fixture);
  assert.equal(fab.style.left, '1222px');
  assert.equal(fab.style.top, '343px'); // 54 + 0.5 * (632 - 54)

  // A shorter viewport re-clamps the restored dy=1 (band bottom 632→332).
  const shrink = dockFixture({ storage: mapStorage({ danmakuDockSide: 'left', danmakuDockDy: '1' }) });
  shrink.liveUi.pushDanmaku('start', '任务 A', 't1');
  shrink.win.innerHeight = 500;
  shrink.win.dispatch('resize');
  assert.equal(fabOf(shrink).style.top, '332px'); // 500 - 120 - 48
});

test('all-terminal rows converge through auto-hide: the whole dock folds away', () => {
  const fixture = dockFixture();
  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  fixture.liveUi.pushDanmaku('done', '任务 A 完成', 't1');
  const fab = fabOf(fixture);
  const badge = fixture.ids.get('danmaku-fab-badge');

  fixture.timers.tick(5000);
  fixture.timers.tick(320);
  assert.equal(fab.style.display, 'none');
  assert.equal(panelOf(fixture).style.display, 'none');
  assert.equal(fixture.ids.get('danmaku-body').textContent, '');
  assert.equal(badge.style.display, 'none');

  // A fresh task brings the dock straight back.
  fixture.liveUi.pushDanmaku('start', '任务 B', 't2');
  assert.equal(fab.style.display, 'flex');
  assert.equal(badge.textContent, '1');
});

test('panel ▾ affordance folds the panel back into the fab', () => {
  const fixture = dockFixture();
  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  const fab = fabOf(fixture);
  fab.dispatch('click');
  assert.equal(panelOf(fixture).style.display, 'flex');
  fixture.ids.get('danmaku-collapse-btn').dispatch('click');
  assert.equal(panelOf(fixture).style.display, 'none');
  assert.equal(fab.getAttribute('aria-expanded'), 'false');

  // Escape works from inside the panel too.
  fab.dispatch('click');
  assert.equal(panelOf(fixture).style.display, 'flex');
  panelOf(fixture).dispatch('keydown', { key: 'Escape' });
  assert.equal(panelOf(fixture).style.display, 'none');
});

test('expanded panel flips above a low fab and stays on narrow viewports', () => {
  const fixture = dockFixture({ storage: mapStorage({ danmakuDockSide: 'right', danmakuDockDy: '1' }) });
  fixture.liveUi.pushDanmaku('start', '任务 A', 't1');
  const fab = fabOf(fixture);
  fab.dispatch('click');
  const panel = panelOf(fixture);
  // Right-snapped: opens leftwards of the fab...
  assert.equal(panel.style.left, `${1280 - 10 - 48 - 8 - 300}px`);
  // ...and flips above when the fab sits at the band bottom (632 + 260 > 800).
  assert.equal(panel.style.bottom, `${800 - 632 + 8}px`);
  assert.equal(panel.style.top, 'auto');
  assert.ok(Number.parseInt(panel.style.maxWidth, 10) > 200);

  // Narrow viewport: the width budget shrinks with the screen, never negative.
  const narrow = dockFixture();
  narrow.win.innerWidth = 360;
  narrow.liveUi.pushDanmaku('start', '任务 A', 't1');
  narrow.fabClick = () => {};
  fabOf(narrow).dispatch('click');
  const narrowPanel = panelOf(narrow);
  const maxWidth = Number.parseInt(narrowPanel.style.maxWidth, 10);
  assert.ok(maxWidth >= 220 && maxWidth <= 324, `budget ${maxWidth}`);
  assert.ok(Number.parseInt(narrowPanel.style.left, 10) >= 8);
});
