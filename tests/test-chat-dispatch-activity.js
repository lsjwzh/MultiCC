'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_VISIBLE,
  buildSessionUrl,
  createDispatchActivity,
  normalizeDispatches,
  navigationCandidates,
  navigationSessionId,
} = require('../public/chat-dispatch-activity');

function fakeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); },
  };
}

function fakeTarget(initial = {}) {
  const handlers = new Map();
  return Object.assign({
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    classList: fakeClassList(),
    attrs: {},
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = handlers.get(type) || [];
      handlers.set(type, list.filter(candidate => candidate !== fn));
    },
    dispatch(type, event = {}) {
      const payload = {
        preventDefault() {},
        stopPropagation() {},
        ...event,
      };
      for (const fn of handlers.get(type) || []) fn(payload);
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    setPointerCapture() {},
    releasePointerCapture() {},
  }, initial);
}

function activityFixture() {
  const ids = new Map();
  for (const id of [
    'dispatch-activity-fab', 'dispatch-activity-count', 'dispatch-activity-panel',
    'dispatch-activity-title', 'dispatch-activity-list', 'dispatch-activity-refresh',
    'dispatch-activity-collapse',
  ]) ids.set(id, fakeTarget());
  ids.get('dispatch-activity-panel').offsetHeight = 220;

  const doc = fakeTarget({
    hidden: false,
    getElementById(id) { return ids.get(id) || null; },
    createElement() { return fakeTarget(); },
  });
  const stored = new Map();
  const writes = [];
  const storage = {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, value); writes.push([key, value]); },
  };
  const timeouts = [];
  const win = fakeTarget({
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'https://example.test/chat.html?session=owner' },
    localStorage: storage,
    matchMedia(query) { return { matches: query.includes('760px') && this.innerWidth <= 760 }; },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn) { timeouts.push(fn); return timeouts.length; },
    clearTimeout() {},
    open() {},
  });
  const fetch = async url => ({
    ok: true,
    async json() {
      if (url === '/api/sessions') return [];
      return {
        dispatches: [{
          operationId: 'op-live', status: 'running', terminal: false,
          relation: 'owner', targetSessionId: 'worker', queueState: 'running',
        }],
      };
    },
  });
  const api = createDispatchActivity({
    window: win,
    document: doc,
    sessionId: 'owner',
    fetch,
    storage,
    intervalMs: 60000,
  });
  return {
    api, doc, ids, storage, writes, win,
    async ready() {
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    },
    flushTimeouts() {
      while (timeouts.length) timeouts.shift()();
    },
  };
}

test('web dispatch activity dedups and orders live work before fresh terminal history', () => {
  const rows = normalizeDispatches([
    { operationId: 'done-old', terminal: true, status: 'completed', completedAt: 10 },
    { operationId: 'live-old', terminal: false, status: 'running', queueState: 'running', updatedAt: 2 },
    { operationId: 'done-new', terminal: true, status: 'failed', completedAt: 20 },
    { operationId: 'live-new', terminal: false, status: 'admitted', queueState: 'queued', updatedAt: 5 },
    { operationId: 'live-new', terminal: false, status: 'admitted', queueState: 'queued', updatedAt: 99 },
    { status: 'running' },
  ]);
  assert.deepEqual(rows.map(row => row.operationId), [
    'live-old', 'live-new', 'done-new', 'done-old',
  ]);
  assert.equal(MAX_VISIBLE, 5);
});

test('web dispatch activity navigates to execution chat, owner, or nowhere for self', () => {
  const outgoing = {
    relation: 'owner', executionSessionId: 'worker-gw-chat', targetSessionId: 'worker-terminal',
  };
  assert.deepEqual(navigationCandidates(outgoing), ['worker-gw-chat', 'worker-terminal']);
  assert.equal(navigationSessionId(outgoing), 'worker-gw-chat');
  assert.equal(navigationSessionId(outgoing, new Set(['worker-terminal'])), 'worker-terminal');
  assert.equal(navigationSessionId({ relation: 'target', ownerSessionId: 'commander' }), 'commander');
  assert.equal(navigationSessionId({ relation: 'self', ownerSessionId: 'same' }), '');
});

test('web dispatch activity keeps the projection label and task-bound marker', () => {
  const rows = normalizeDispatches([
    {
      operationId: 'op-bound', status: 'running', terminal: false, relation: 'owner',
      targetSessionId: 'worker-9', targetLabel: '任务 · App UI 适配',
      targetTaskBoundTaskId: '#A1N3', queueState: 'running',
    },
    { operationId: 'op-plain', status: 'running', relation: 'owner', targetSessionId: 'p' },
  ]);
  assert.equal(rows[0].targetLabel, '任务 · App UI 适配');
  assert.equal(rows[0].targetTaskBoundTaskId, '#A1N3');
  assert.equal(rows[1].targetLabel, '', 'absent server fields degrade to empty strings');
  assert.equal(rows[1].targetTaskBoundTaskId, '');
});

test('web dispatch rows show the task-bound label and jump to its chat', async () => {
  const opened = [];
  const ids = new Map();
  for (const id of [
    'dispatch-activity-fab', 'dispatch-activity-count', 'dispatch-activity-panel',
    'dispatch-activity-title', 'dispatch-activity-list', 'dispatch-activity-refresh',
    'dispatch-activity-collapse',
  ]) ids.set(id, fakeTarget());
  ids.get('dispatch-activity-panel').offsetHeight = 220;
  const doc = fakeTarget({
    getElementById(id) { return ids.get(id) || null; },
    createElement() { return fakeTarget(); },
  });
  const win = fakeTarget({
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'https://example.test/chat.html?session=owner' },
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia() { return { matches: false }; },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    open(url, target) { opened.push([url, target]); },
  });
  // The session list hides task-bound workers, so the projection-carried
  // label is the only friendly name available for the row.
  const fetch = async url => ({
    ok: true,
    async json() {
      if (url === '/api/sessions') return [];
      return {
        dispatches: [{
          operationId: 'op-bound', status: 'running', terminal: false,
          relation: 'owner', targetSessionId: 'worker-9', executionSessionId: 'worker-9',
          targetLabel: '任务 · App UI 适配', targetTaskBoundTaskId: '#A1N3',
          queueState: 'running', mode: 'async',
        }],
      };
    },
  });
  const api = createDispatchActivity({
    window: win, document: doc, sessionId: 'owner', fetch,
    storage: { getItem: () => null, setItem: () => {} },
    intervalMs: 60000,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const row = ids.get('dispatch-activity-list').children[0];
  assert.ok(row, 'a row rendered for the live dispatch');
  const body = row.children.find(child => child.className === 'dispatch-activity-row-body');
  assert.equal(body.textContent, 'To 任务 · App UI 适配 · async');
  assert.equal(row.title, '任务绑定会话 · #A1N3');
  row.dispatch('click');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'https://example.test/chat.html?session=worker-9');
  assert.equal(opened[0][1], '_blank');
  api.destroy();
});

test('web dispatch jump starts from a clean same-directory chat URL', () => {
  const url = new URL(buildSessionUrl(
    'https://example.test/ui/chat.html?session=old&token=secret&message=m1#debug',
    'worker-gw-chat',
  ));
  assert.equal(url.origin, 'https://example.test');
  assert.equal(url.pathname, '/ui/chat.html');
  assert.equal(url.search, '?session=worker-gw-chat');
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.searchParams.has('message'), false);
});

test('web dispatch activity uses bounded record query and text-only DOM rendering', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'chat-dispatch-activity.js'),
    'utf8',
  );
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.html'), 'utf8');
  assert.match(source, /activeOnly=false&relation=both&recentTerminalLimit=5/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(source, /textContent\s*=/);
  assert.match(html, /id="dispatch-activity-fab"/);
  assert.match(html, /src="chat-dispatch-activity\.js"/);
  assert.match(html, /href="chat-dispatch-activity\.css"/);
});

test('web dispatch fab is a 24px circle inside a draggable 44px hit box', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'chat-dispatch-activity.css'),
    'utf8',
  );
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.html'), 'utf8');
  const hitBox = css.slice(
    css.indexOf('#dispatch-activity-fab {'),
    css.indexOf('#dispatch-activity-fab[hidden]'),
  );
  const circle = css.slice(
    css.indexOf('.dispatch-activity-fab-circle {'),
    css.indexOf('#dispatch-activity-fab:hover'),
  );
  assert.match(hitBox, /width:\s*44px/);
  assert.match(hitBox, /height:\s*44px/);
  assert.match(hitBox, /background:\s*transparent/);
  assert.match(hitBox, /cursor:\s*grab/);
  assert.match(hitBox, /touch-action:\s*none/);
  assert.match(circle, /width:\s*24px/);
  assert.match(circle, /height:\s*24px/);
  assert.match(circle, /pointer-events:\s*none/);
  assert.match(html, /class="dispatch-activity-fab-circle"/);
});

test('web dispatch fab drags, snaps, persists, and a drag never expands the panel', async () => {
  const fixture = activityFixture();
  await fixture.ready();
  const fab = fixture.ids.get('dispatch-activity-fab');
  const panel = fixture.ids.get('dispatch-activity-panel');
  const collapse = fixture.ids.get('dispatch-activity-collapse');

  assert.equal(fab.hidden, false);
  assert.equal(fab.style.left, '12px');
  assert.equal(fab.style.top, '686px');

  fab.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 20, clientY: 690 });
  fab.dispatch('pointermove', { pointerId: 7, clientX: 1200, clientY: 300 });
  assert.equal(fab.classList.contains('dispatch-activity-dragging'), true);
  fab.dispatch('pointerup', { pointerId: 7 });

  assert.equal(fab.classList.contains('dispatch-activity-dragging'), false);
  assert.equal(fab.style.left, '1224px', 'release snaps to the right edge');
  assert.equal(fixture.writes.length, 1, 'one persisted write per completed drag');
  assert.equal(JSON.parse(fixture.writes[0][1]).side, 'right');

  fab.dispatch('click');
  assert.equal(panel.hidden, true, 'synthetic click after pointerup is suppressed');
  fixture.flushTimeouts();
  fab.dispatch('click');
  assert.equal(panel.hidden, false, 'a later tap expands normally');
  assert.equal(fab.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.style.right, '12px', 'panel follows the snapped side');

  collapse.dispatch('click');
  assert.equal(panel.hidden, true);
  fixture.win.innerWidth = 390;
  fixture.win.innerHeight = 700;
  fixture.win.dispatch('resize');
  assert.equal(fab.style.left, '334px', 'resize re-clamps the right-snapped hit box');
  assert.ok(Number.parseFloat(fab.style.top) <= 552, 'narrow layout clears the composer');
  fixture.api.destroy();
});
