'use strict';

// The chat diff viewer used to be a full-screen modal over the conversation.
// It is now a dock: a side panel (bottom sheet when narrow) that can be closed
// outright or collapsed to a draggable floating button. These tests pin the
// shell behaviour — the rendering inside it is chatLiveUi's job and unchanged.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'public', 'chat-diff.js'), 'utf8');
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');

const IDS = [
  'diff-modal', 'diff-title', 'diff-subtitle', 'diff-close-btn', 'diff-min-btn',
  'diff-resize-handle', 'diff-dock-fab', 'diff-dock-count',
  'diff-list-view', 'diff-summary-bar', 'diff-summary-text', 'diff-summary-adds',
  'diff-summary-dels', 'diff-summary-chevron', 'diff-file-list',
  'diff-detail-view', 'diff-back-btn', 'diff-detail-basename', 'diff-detail-dir',
  'diff-detail-badge', 'diff-detail-stat', 'diff-ai-panel', 'diff-ai-content',
  'diff-patch',
  // Not part of the dock, but its height decides where the dock starts.
  'header',
];

function fakeElement(id) {
  const classes = new Set();
  const el = {
    id,
    // Mirrors the markup: the floating button ships hidden and is revealed on
    // minimise. The test below pins that the real chat.html still says so.
    hidden: id === 'diff-dock-fab',
    title: '',
    type: '',
    dir: '',
    dataset: {},
    attrs: {},
    offsetHeight: 0,
    children: [],
    listeners: {},
    style: { setProperty(name, value) { this[name] = value; } },
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c))),
    },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(el.attrs, k) ? el.attrs[k] : null; },
    appendChild(child) { el.children.push(child); return child; },
    remove() {},
    get textContent() { return el._text || ''; },
    set textContent(v) { el._text = String(v); el.children = []; },
    // Pointer capture exists on real elements; the code guards for it anyway.
    setPointerCapture() {}, releasePointerCapture() {},
  };
  return el;
}

function fire(el, type, event = {}) {
  (el.listeners[type] || []).forEach(fn => fn(Object.assign({
    preventDefault() {}, clientX: 0, clientY: 0, pointerId: 1,
  }, event)));
}

// A diff payload with three changed files.
const FILES = {
  branch: 'multicc/x', baseBranch: 'main', mergeState: { ahead: 2, dirty: false },
  totalAdditions: 12, totalDeletions: 3,
  files: [
    { path: 'a.js', status: 'M', additions: 5, deletions: 1 },
    { path: 'src/b.js', status: 'A', additions: 7, deletions: 0 },
    { path: 'c.md', status: 'D', additions: 0, deletions: 2 },
  ],
};

function browserContext(opts = {}) {
  const store = new Map(Object.entries(opts.session || {}));
  const elements = new Map(IDS.map(id => [id, fakeElement(id)]));
  const ctx = {
    console,
    JSON, Promise, Math, Number, Date, String, Array, Object, URLSearchParams,
    setTimeout, clearTimeout,
    fetch: opts.fetch || (async () => ({ ok: true, json: async () => FILES })),
    location: { search: opts.search === undefined ? '?session=s1' : opts.search },
    document: {
      readyState: 'complete',
      documentElement: { style: { props: {}, setProperty(n, v) { this.props[n] = v; } } },
      getElementById: id => elements.get(id) || null,
      createElement: tag => fakeElement('<' + tag + '>'),
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      listeners: {},
    },
  };
  ctx.window = ctx;
  ctx.innerWidth = opts.innerWidth || 1400;
  ctx.innerHeight = opts.innerHeight || 900;
  ctx.matchMedia = () => ({ matches: Boolean(opts.narrow) });
  ctx.addEventListener = (type, fn) => { (ctx._winListeners[type] = ctx._winListeners[type] || []).push(fn); };
  ctx._winListeners = {};
  ctx.sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx, { filename: 'chat-diff.js' });
  return {
    ctx,
    viewer: ctx.chatDiffViewer,
    el: id => elements.get(id),
    saved: () => JSON.parse(store.get('multicc.diffDock') || '{}'),
    cssVar: name => ctx.document.documentElement.style.props[name],
  };
}

const tick = () => new Promise(r => setImmediate(r));

test('the dock replaces the full-screen modal: no backdrop, chat stays clickable', () => {
  // A CSS assertion on purpose. The whole point of the change is that the
  // element no longer paints over the conversation, and that only lives in CSS.
  const rule = CHAT_HTML.slice(CHAT_HTML.indexOf('#diff-modal {'), CHAT_HTML.indexOf('#diff-modal.open'));
  assert.ok(!/inset:\s*0/.test(rule), '#diff-modal must not cover the viewport');
  assert.ok(!/background:\s*#000/.test(rule), '#diff-modal must not paint a backdrop');
  assert.ok(/pointer-events:\s*none/.test(rule), 'clicks must pass through to the chat');
  assert.ok(/width:\s*var\(--diff-dock-w/.test(rule), 'width is driven by the resize handle');

  // Narrow screens get a bottom sheet, not a full-screen takeover.
  // The fake DOM below assumes this; keep the two honest about each other.
  assert.match(CHAT_HTML, /<button id="diff-dock-fab" type="button" hidden/);

  const narrow = CHAT_HTML.slice(CHAT_HTML.indexOf('@media (max-width: 640px) {\n      /* Narrow screens'));
  const sheet = narrow.slice(0, narrow.indexOf('#diff-modal-head'));
  assert.ok(/height:\s*var\(--diff-dock-h/.test(sheet), 'sheet height is draggable');
  assert.ok(/max-height:\s*92vh/.test(sheet), 'the sheet never claims the whole screen');
});

test('the dock starts below the header, so the top-bar controls stay reachable', async () => {
  const rule = CHAT_HTML.slice(CHAT_HTML.indexOf('#diff-modal {'), CHAT_HTML.indexOf('#diff-modal.open'));
  assert.ok(/top:\s*var\(--diff-dock-top/.test(rule), 'the dock top is measured, not pinned to 0');

  const h = browserContext();
  // A header that wrapped to two rows: the offset has to follow it, not a
  // hardcoded single-row height.
  h.el('header').offsetHeight = 96;
  h.viewer.open('s1');
  await tick();
  assert.equal(h.cssVar('--diff-dock-top'), '96px');

  // No header (embedded elsewhere) must not produce "undefinedpx".
  const bare = browserContext();
  bare.viewer.open('s1');
  await tick();
  assert.equal(bare.cssVar('--diff-dock-top'), '0px');
});

test('opening shows the panel and hides the floating button', async () => {
  const h = browserContext();
  h.viewer.open('s1');
  await tick();
  assert.equal(h.el('diff-modal').classList.contains('open'), true);
  assert.equal(h.el('diff-dock-fab').hidden, true);
  assert.equal(h.el('diff-summary-text').textContent, '已更改 3 个文件');
});

test('minimising collapses the panel to a button badged with the file count', async () => {
  const h = browserContext();
  h.viewer.open('s1');
  await tick();
  fire(h.el('diff-min-btn'), 'click');

  assert.equal(h.el('diff-modal').classList.contains('open'), false, 'panel is out of the way');
  assert.equal(h.el('diff-dock-fab').hidden, false, 'button takes its place');
  assert.equal(h.el('diff-dock-count').textContent, '3');
  assert.match(h.el('diff-dock-fab').title, /3 个文件/);
  assert.equal(h.saved().minimized, true, 'the state survives a reload');
  assert.equal(h.saved().sessionId, 's1');
});

test('a tap on the button restores the panel; a drag does not', async () => {
  const h = browserContext();
  h.viewer.open('s1');
  await tick();
  fire(h.el('diff-min-btn'), 'click');
  const fab = h.el('diff-dock-fab');

  // Tap: press and release in place.
  fire(fab, 'pointerdown', { clientX: 1340, clientY: 500 });
  fire(fab, 'pointerup', { clientX: 1340, clientY: 500 });
  assert.equal(h.el('diff-modal').classList.contains('open'), true);
  assert.equal(fab.hidden, true);

  // Drag: a press that travels must move the button, not reopen the panel.
  fire(h.el('diff-min-btn'), 'click');
  fire(fab, 'pointerdown', { clientX: 1340, clientY: 500 });
  fire(fab, 'pointermove', { clientX: 200, clientY: 300 });
  fire(fab, 'pointerup', { clientX: 200, clientY: 300 });
  assert.equal(h.el('diff-modal').classList.contains('open'), false, 'dragging must not reopen');
  assert.equal(fab.hidden, false);
  assert.equal(h.saved().fabSide, 'left', 'dropped on the left half, snaps to the left edge');
  assert.equal(fab.style.left, '12px', 'snapped flush to the edge, not left mid-screen');
});

test('the floating button stays inside the viewport whatever was stored', () => {
  const h = browserContext({
    innerWidth: 390, innerHeight: 844,
    session: { 'multicc.diffDock': JSON.stringify({ fabSide: 'right', fabTopRatio: 1, minimized: false }) },
  });
  h.viewer.open('s1');
  const fab = h.el('diff-dock-fab');
  const top = parseFloat(fab.style.left) >= 0 ? parseFloat(fab.style.top) : NaN;
  assert.ok(top <= 844 - 44 - 12, 'clamped above the bottom margin: ' + top);
  assert.equal(fab.style.left, String(390 - 44 - 12) + 'px');
});

test('closing puts both the panel and the button away', async () => {
  const h = browserContext();
  h.viewer.open('s1');
  await tick();
  fire(h.el('diff-min-btn'), 'click');
  fire(h.el('diff-close-btn'), 'click');
  assert.equal(h.el('diff-modal').classList.contains('open'), false);
  assert.equal(h.el('diff-dock-fab').hidden, true);
  assert.equal(h.saved().minimized, false, 'closed is not minimised — it must not come back');
});

test('a reload with a minimised dock brings the button back, and it refetches', async () => {
  const stored = { minimized: true, sessionId: 's1', fabSide: 'right', fabTopRatio: 0.6, width: 500 };
  let calls = 0;
  const h = browserContext({
    session: { 'multicc.diffDock': JSON.stringify(stored) },
    fetch: async () => { calls += 1; return { ok: true, json: async () => FILES }; },
  });
  // Nothing was opened in this page load; the button is there from last time.
  assert.equal(h.el('diff-dock-fab').hidden, false);
  assert.equal(h.el('diff-modal').classList.contains('open'), false);
  assert.equal(h.cssVar('--diff-dock-w'), '500px', 'stored width is applied on load');

  fire(h.el('diff-dock-fab'), 'pointerdown', { clientX: 1344, clientY: 540 });
  fire(h.el('diff-dock-fab'), 'pointerup', { clientX: 1344, clientY: 540 });
  await tick();
  assert.equal(h.el('diff-modal').classList.contains('open'), true);
  assert.equal(calls, 1, 'the panel came back with fresh data, not an empty shell');
});

test('a minimised dock from another session does not resurrect', () => {
  const h = browserContext({
    session: { 'multicc.diffDock': JSON.stringify({ minimized: true, sessionId: 'other' }) },
  });
  assert.equal(h.el('diff-dock-fab').hidden, true);
});

test('dragging the handle resizes the panel and clamps to readable bounds', () => {
  const h = browserContext({ innerWidth: 1400 });
  h.viewer.open('s1');
  const handle = h.el('diff-resize-handle');

  fire(handle, 'pointerdown');
  fire(handle, 'pointermove', { clientX: 800 });
  assert.equal(h.cssVar('--diff-dock-w'), '600px');

  fire(handle, 'pointermove', { clientX: 1399 });   // dragged past the minimum
  assert.equal(h.cssVar('--diff-dock-w'), '320px');
  fire(handle, 'pointermove', { clientX: 0 });      // dragged past the maximum
  assert.equal(h.cssVar('--diff-dock-w'), '900px');

  fire(handle, 'pointerup');
  assert.equal(h.saved().width, 900, 'the width is remembered for the tab');
});

test('on a narrow screen the same handle drags the sheet height', () => {
  const h = browserContext({ narrow: true, innerWidth: 390, innerHeight: 800 });
  h.viewer.open('s1');
  const handle = h.el('diff-resize-handle');

  fire(handle, 'pointerdown');
  fire(handle, 'pointermove', { clientY: 400 });
  assert.equal(h.cssVar('--diff-dock-h'), '400px', 'half the screen, chat still visible above');

  fire(handle, 'pointermove', { clientY: 780 });    // dragged almost shut
  assert.equal(h.cssVar('--diff-dock-h'), '240px', 'floored at 30% rather than collapsing');
  fire(handle, 'pointermove', { clientY: 0 });      // dragged to the top
  assert.equal(h.cssVar('--diff-dock-h'), '736px', 'capped at 92% so the chat never disappears');
  fire(handle, 'pointerup');
});

test('the public surface exposes minimise and restore', () => {
  const h = browserContext();
  assert.deepEqual(
    Object.keys(h.viewer).sort(),
    ['close', 'minimize', 'open', 'restore'],
  );
  assert.equal(Object.isFrozen(h.viewer), true);
});
