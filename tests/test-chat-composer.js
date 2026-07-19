'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadModule(overrides = {}) {
  const document = overrides.document || {
    activeElement: null,
    getElementById() { return null; },
    createElement() { throw new Error('unexpected DOM creation'); },
    createTextNode(text) { return { textContent: text }; },
  };
  const window = Object.assign({
    document,
    navigator: { userAgent: 'test', mediaDevices: null },
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
  }, overrides.window || {});
  const context = vm.createContext({ window, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/chat-composer.js'), 'utf8'), context, {
    filename: 'chat-composer.js',
  });
  return { api: window.MultiCCChatComposer, window, document };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClassList() {
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

function fakeElement() {
  return {
    classList: fakeClassList(),
    style: {},
    textContent: '',
    innerHTML: '',
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    querySelector() { return null; },
  };
}

function voiceFixture(ticketPromises) {
  const ids = new Map();
  for (const id of ['voice-hud', 'vh-raw-text', 'vh-refined-text', 'vh-status-text', 'vh-cancel', 'vh-send']) {
    ids.set(id, fakeElement());
  }
  const document = {
    activeElement: null,
    getElementById(id) { return ids.get(id) || null; },
    createElement() { return fakeElement(); },
    createTextNode(text) { return { textContent: text }; },
  };
  const created = [];
  class FakeVoiceStream {
    constructor(options) {
      this.options = options;
      this.startCount = 0;
      this.closeCount = 0;
      created.push(this);
    }
    start() { this.startCount++; return Promise.resolve(); }
    abort() { this.closeCount++; }
    stop() { this.closeCount++; }
  }
  let ticketCalls = 0;
  const { api, window } = loadModule({
    document,
    window: {
      document,
      navigator: { userAgent: 'test', mediaDevices: {} },
      location: { protocol: 'http:', host: 'localhost:3000' },
      VoiceStream: FakeVoiceStream,
      AbortController,
      multiccWsUrl() {
        const ticket = ticketPromises[ticketCalls++];
        if (!ticket) throw new Error('unexpected ticket request');
        return ticket.promise;
      },
      setTimeout,
      clearTimeout,
    },
  });
  const micButton = fakeElement();
  const composer = api.createComposer({
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    autoBind: false,
    elements: { input: input(''), micButton },
  });
  return { composer, created, ids, micButton, ticketCalls: () => ticketCalls };
}

function input(value) {
  return { value, style: {}, scrollHeight: 32 };
}

function attachmentArea(paths = []) {
  const chips = paths.map(value => ({ dataset: { path: value }, removed: false, remove() { this.removed = true; } }));
  return {
    children: chips,
    classList: { toggle() {} },
    querySelectorAll(selector) {
      assert.equal(selector, '.attach-chip[data-path]');
      return chips;
    },
  };
}

function composerFixture(overrides = {}) {
  const { api, window, document } = loadModule();
  const sent = [];
  const system = [];
  const users = [];
  const starts = [];
  const pending = [];
  const retries = [];
  const inputEl = input(overrides.text || 'hello');
  const area = attachmentArea(overrides.paths || []);
  const composer = api.createComposer({
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    autoBind: false,
    elements: { input: inputEl, attachArea: area },
    isSocketOpen: () => overrides.open !== false,
    transportSend: payload => { sent.push(JSON.parse(JSON.stringify(payload))); return overrides.sendResult !== false; },
    retryTransport: () => retries.push(true),
    addSystemMessage: text => system.push(text),
    addUserMessage: text => users.push(text),
    updateUi() {},
    getIsStreaming: () => overrides.streaming === true,
    hasOpenTurn: () => overrides.openTurn === true,
    finishOpenTurn: () => starts.push('finish-open'),
    finishCancelledTurn: () => starts.push('cancelled'),
    setPendingCancel: value => pending.push(value),
    onTurnStarted: () => starts.push('started'),
    resetHistory: () => starts.push('reset'),
    goalWrap: task => `[goal] ${task}`,
    debug() {},
  });
  return { api, composer, inputEl, area, sent, system, users, starts, pending, retries };
}

test('classic module exports a frozen narrow API and stable helpers', () => {
  const { api } = loadModule();
  assert.equal(Object.isFrozen(api), true);
  assert.equal(api.pastedFileName({ type: 'image/jpeg' }), 'pasted-file.jpg');
  assert.equal(api.pastedFileName({ type: 'application/pdf' }), 'pasted-file.pdf');
  assert.match(api.defaultClientMessageId(1234, 0.123456), /^c[0-9a-z]+-[0-9a-z]+$/);
});

test('send appends durable attachment paths and starts exactly one turn', () => {
  const fixture = composerFixture({ text: 'inspect', paths: ['/tmp/a.png', '/tmp/b.txt'] });
  assert.equal(fixture.composer.send(), true);
  assert.deepEqual(fixture.users, ['inspect /tmp/a.png /tmp/b.txt']);
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].type, 'user_message');
  assert.equal(fixture.sent[0].text, 'inspect /tmp/a.png /tmp/b.txt');
  assert.match(fixture.sent[0].clientMsgId, /^c/);
  assert.deepEqual(fixture.starts, ['started']);
  assert.deepEqual(fixture.pending, [false]);
  assert.equal(fixture.inputEl.value, '');
  assert.equal(fixture.area.children.every(chip => chip.removed), true);
});

test('send closes a stale turn before dispatching a new message', () => {
  const fixture = composerFixture({ openTurn: true });
  fixture.composer.send();
  assert.deepEqual(fixture.starts, ['finish-open', 'started']);
});

test('goal slash command uses the same send path and preserves goal metadata', () => {
  const fixture = composerFixture({ text: '/goal ship it' });
  fixture.composer.send();
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].text, '[goal] ship it');
  assert.equal(fixture.sent[0].goal, true);
  assert.deepEqual(fixture.sent[0].goalLimits, {});
});

test('disconnected send is fail-closed and schedules reconnect', () => {
  const fixture = composerFixture({ open: false });
  assert.equal(fixture.composer.send(), false);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.users.length, 0);
  assert.equal(fixture.retries.length, 1);
  assert.match(fixture.system[0], /已断开/);
});

test('cancel remains idempotent and remembers an offline intent', () => {
  const offline = composerFixture({ open: false, streaming: true });
  assert.equal(offline.composer.cancelStreaming(), true);
  assert.deepEqual(offline.pending, [true]);
  assert.deepEqual(offline.starts, ['cancelled']);

  const idle = composerFixture({ open: true, streaming: false });
  assert.equal(idle.composer.cancelStreaming(), false);
  assert.deepEqual(idle.sent, [{ type: 'cancel' }]);
  assert.deepEqual(idle.pending, [false]);
  assert.deepEqual(idle.starts, []);
});

test('double streaming-voice start shares one pending ticket and one microphone', async () => {
  const ticket = deferred();
  const fixture = voiceFixture([ticket]);
  const first = fixture.composer.startStreamingVoice();
  const second = fixture.composer.startStreamingVoice();
  assert.strictEqual(second, first);
  assert.equal(fixture.ticketCalls(), 1);
  assert.equal(fixture.created.length, 0);
  ticket.resolve('ws://localhost:3000/ws/voice?ticket=once');
  assert.equal(await first, true);
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.created[0].startCount, 1);
});

test('cancel invalidates a streaming-voice start while its ticket is pending', async () => {
  const ticket = deferred();
  const fixture = voiceFixture([ticket]);
  const pending = fixture.composer.startStreamingVoice();
  fixture.composer.cancelStreamingVoice();
  ticket.resolve('ws://localhost:3000/ws/voice?ticket=stale');
  assert.equal(await pending, false);
  assert.equal(fixture.created.length, 0);
  assert.equal(fixture.ids.get('voice-hud').classList.contains('open'), false);
  assert.equal(fixture.micButton.classList.contains('recording'), false);
});

test('an old late ticket cannot replace the newer streaming-voice generation', async () => {
  const oldTicket = deferred();
  const newTicket = deferred();
  const fixture = voiceFixture([oldTicket, newTicket]);
  const oldStart = fixture.composer.startStreamingVoice();
  fixture.composer.cancelStreamingVoice();
  const newStart = fixture.composer.startStreamingVoice();

  newTicket.resolve('ws://localhost:3000/ws/voice?ticket=new');
  assert.equal(await newStart, true);
  assert.equal(fixture.created.length, 1);
  assert.match(fixture.created[0].options.wsUrl, /ticket=new/);

  oldTicket.resolve('ws://localhost:3000/ws/voice?ticket=old');
  assert.equal(await oldStart, false);
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.created[0].closeCount, 0);
  assert.equal(fixture.micButton.classList.contains('recording'), true);
});

test('chat host loads composer before chat and keeps compatibility/password gates', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'public/chat.js'), 'utf8');
  const module = fs.readFileSync(path.join(ROOT, 'public/chat-composer.js'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.indexOf('chat-notifications.js') < scripts.indexOf('chat-composer.js'));
  assert.ok(scripts.indexOf('chat-composer.js') < scripts.indexOf('chat.js'));
  assert.match(host, /function send\(opts = \{\}\) \{ return chatComposer\?\.send\(opts\); \}/);
  assert.match(host, /function cancelStreaming\(\) \{ return chatComposer\?\.cancelStreaming\(\); \}/);
  assert.match(host, /enforceFirstRunPassword/);
  assert.match(host, /firstrun-pw-gate/);
  assert.doesNotMatch(host, /new MediaRecorder\(/);
  assert.doesNotMatch(host, /new VoiceStream\(/);
  assert.match(module, /new win\.VoiceStream\(/);
  assert.ok(host.split('\n').length <= 4100, `chat.js has ${host.split('\n').length} lines`);
  assert.ok(module.split('\n').length < 2000);
});
