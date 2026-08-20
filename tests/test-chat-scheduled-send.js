'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scheduledSend = require('../public/chat-scheduled-send.js');

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
    attrs: {},
    classList: fakeClassList(),
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      handlers.set(type, (handlers.get(type) || []).filter(candidate => candidate !== fn));
    },
    dispatch(type, event = {}) {
      const payload = { preventDefault() {}, ...event };
      for (const fn of handlers.get(type) || []) fn(payload);
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    setPointerCapture() {},
    releasePointerCapture() {},
  }, initial);
}

function dockFixture(saved = null) {
  const values = new Map();
  if (saved) values.set('multicc.scheduledSendDock', JSON.stringify(saved));
  const writes = [];
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); writes.push([key, value]); },
  };
  const timeouts = [];
  const win = fakeTarget({
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: storage,
    matchMedia(query) { return { matches: query.includes('760px') && this.innerWidth <= 760 }; },
    setTimeout(fn) { timeouts.push(fn); return timeouts.length; },
    clearTimeout() {},
  });
  const fab = fakeTarget({ hidden: true });
  const panel = fakeTarget({ hidden: true, offsetHeight: 320, offsetWidth: 440 });
  const changes = [];
  const dock = scheduledSend.createFloatingDock({
    window: win, fab, panel, storage,
    onExpandedChange(value) { changes.push(value); },
  });
  return {
    dock, fab, panel, win, writes, changes,
    flushTimeouts() { while (timeouts.length) timeouts.shift()(); },
  };
}

test('delay parsing supports seconds through days and enforces the seven-day boundary', () => {
  assert.equal(scheduledSend.parseDelaySeconds(30, 'seconds'), 30);
  assert.equal(scheduledSend.parseDelaySeconds(10, 'minutes'), 600);
  assert.equal(scheduledSend.parseDelaySeconds(1.5, 'hours'), 5400);
  assert.equal(scheduledSend.parseDelaySeconds(7, 'days'), 604800);
  assert.equal(scheduledSend.parseDelaySeconds(8, 'days'), null);
  assert.equal(scheduledSend.parseDelaySeconds(0, 'minutes'), null);
  assert.equal(scheduledSend.parseDelaySeconds('nope', 'hours'), null);
  assert.equal(scheduledSend.parseDelaySeconds(1, 'weeks'), null);
  assert.match(scheduledSend.formatRemaining(31_000, 1_000), /30/);
  assert.match(scheduledSend.formatRemaining(3_601_000, 1_000), /1/);
});

test('scheduled message API scopes create, list and cancel requests to one encoded session', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: options.method === 'POST' ? 201 : 200,
      async json() {
        if (options.method === 'POST') return { ok: true, scheduledMessage: { id: 'scheduled:1' } };
        if (options.method === 'DELETE') return { ok: true, id: 'scheduled:1' };
        return { ok: true, scheduledMessages: [] };
      },
    };
  };
  const api = scheduledSend.createScheduledMessageApi({ fetch, sessionId: 'chat/a b' });
  await api.create('later', 600, 'retry-key');
  await api.list();
  await api.cancel('scheduled:1');

  assert.equal(calls[0].url, '/api/sessions/chat%2Fa%20b/scheduled-messages');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'retry-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: 'later', delaySeconds: 600 });
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(calls[2].url, '/api/sessions/chat%2Fa%20b/scheduled-messages/scheduled%3A1');
  assert.equal(calls[2].options.method, 'DELETE');
});

test('controller includes uploaded paths and routing decoration, clearing the draft only after success', async () => {
  const created = [];
  const chips = ['/tmp/a.png', '/tmp/b.txt'].map(value => ({
    dataset: { path: value }, removed: false,
    remove() { this.removed = true; },
  }));
  const attachArea = {
    children: chips,
    classList: { toggle() {} },
    querySelectorAll() { return chips; },
  };
  const input = { value: '检查附件', style: { height: '80px' }, dispatchEvent() {} };
  const controller = scheduledSend.createController({
    input,
    attachArea,
    makeId: () => 'stable-id',
    decorate: text => text + '\n\n[Dispatch] none',
    api: {
      async create(message, delaySeconds, id) {
        created.push({ message, delaySeconds, id });
        return { ok: true, scheduledMessage: { id: 'scheduled-1', dueAt: 1000 } };
      },
    },
  });

  const result = await controller.schedule(2, 'hours');
  assert.equal(result.scheduledMessage.id, 'scheduled-1');
  assert.deepEqual(created, [{
    message: '检查附件 /tmp/a.png /tmp/b.txt\n\n[Dispatch] none',
    delaySeconds: 7200,
    id: 'stable-id',
  }]);
  assert.equal(input.value, '');
  assert.equal(input.style.height, 'auto');
  assert.equal(chips.every(chip => chip.removed), true);
});

test('controller keeps the draft and reuses its idempotency key after an ambiguous failure', async () => {
  const input = { value: '不要重复投递', style: {} };
  const ids = [];
  let calls = 0;
  const controller = scheduledSend.createController({
    input,
    makeId: () => 'same-retry-key',
    api: {
      async create(_message, _delay, id) {
        ids.push(id);
        if (++calls === 1) throw new Error('connection reset after commit');
        return { ok: true, scheduledMessage: { id: 'scheduled-1' } };
      },
    },
  });

  await assert.rejects(controller.schedule(10, 'minutes'), /connection reset/);
  assert.equal(input.value, '不要重复投递');
  await controller.schedule(10, 'minutes');
  assert.deepEqual(ids, ['same-retry-key', 'same-retry-key']);
  assert.equal(input.value, '');
});

test('pending scheduled messages auto-open a floating panel and collapse to a counted dock', () => {
  const fixture = dockFixture();
  assert.equal(fixture.fab.hidden, true);
  assert.equal(fixture.panel.hidden, true);

  fixture.dock.setActive(true);
  assert.equal(fixture.panel.hidden, false, 'the first pending item is visible in chat by default');
  assert.equal(fixture.fab.hidden, true, 'expanded panel replaces its floating button');
  assert.equal(fixture.panel.style.right, '12px');

  fixture.dock.collapse();
  assert.equal(fixture.panel.hidden, true);
  assert.equal(fixture.fab.hidden, false);
  assert.equal(fixture.fab.getAttribute('aria-expanded'), 'false');
  assert.equal(JSON.parse(fixture.writes.at(-1)[1]).collapsed, true);

  fixture.fab.dispatch('click');
  assert.equal(fixture.panel.hidden, false);
  assert.equal(fixture.fab.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(fixture.changes, [true, false, true]);

  fixture.dock.setActive(false);
  assert.equal(fixture.panel.hidden, true, 'an auto-opened panel disappears after its last item runs');
  assert.equal(fixture.fab.hidden, true);
  fixture.dock.setActive(true);
  assert.equal(fixture.panel.hidden, false, 'a later item can auto-open again when not user-collapsed');
  fixture.dock.destroy();
});

test('composer-opened schedule form can remain visible when there are no pending messages', () => {
  const fixture = dockFixture();
  fixture.dock.expand();
  fixture.dock.setActive(false, true);
  assert.equal(fixture.panel.hidden, false);
  assert.equal(fixture.fab.hidden, true);
  fixture.dock.destroy();
});

test('scheduled-message floating button drags, snaps, persists and stays inside mobile bounds', () => {
  const fixture = dockFixture({ side: 'right', dy: 1, collapsed: true });
  fixture.dock.setActive(true);
  assert.equal(fixture.panel.hidden, true, 'saved collapse preference survives reload');
  assert.equal(fixture.fab.hidden, false);
  assert.equal(fixture.fab.style.left, '1224px');
  assert.equal(fixture.fab.style.top, '686px');

  fixture.fab.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 1230, clientY: 690 });
  fixture.fab.dispatch('pointermove', { pointerId: 7, clientX: 20, clientY: 180 });
  assert.equal(fixture.fab.classList.contains('schedule-send-dragging'), true);
  fixture.fab.dispatch('pointerup', { pointerId: 7 });
  assert.equal(fixture.fab.classList.contains('schedule-send-dragging'), false);
  assert.equal(fixture.fab.style.left, '12px');
  assert.equal(JSON.parse(fixture.writes.at(-1)[1]).side, 'left');

  fixture.fab.dispatch('click');
  assert.equal(fixture.panel.hidden, true, 'the synthetic click after dragging is suppressed');
  fixture.flushTimeouts();
  fixture.fab.dispatch('click');
  assert.equal(fixture.panel.hidden, false);
  assert.equal(fixture.panel.style.left, '12px');

  fixture.dock.collapse();
  fixture.win.innerWidth = 390;
  fixture.win.innerHeight = 700;
  fixture.win.dispatch('resize');
  assert.equal(fixture.fab.style.left, '12px');
  assert.ok(Number.parseFloat(fixture.fab.style.top) <= 544,
    'narrow layout keeps the dock above the mobile composer');
  fixture.dock.destroy();
});

test('chat page loads the isolated scheduler before chat boot without exceeding its line budget', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/chat.html'), 'utf8');
  const scheduler = source.indexOf('chat-scheduled-send.js');
  const chatBoot = source.indexOf('<script src="chat.js"></script>');
  assert.ok(scheduler > 0 && scheduler < chatBoot);
  assert.equal(source.split('\n').length - 1 <= 3000, true);
  const moduleSource = fs.readFileSync(path.join(__dirname, '../public/chat-scheduled-send.js'), 'utf8');
  assert.equal(moduleSource.includes('.innerHTML'), false,
    'scheduled message content must stay on textContent-only render paths');
  assert.match(moduleSource, /id = 'schedule-send-fab'/);
  assert.match(moduleSource, /multicc\.scheduledSendDock/);
  assert.match(moduleSource, /width:44px;height:44px/);
  assert.match(moduleSource, /width:24px;height:24px/);
});
