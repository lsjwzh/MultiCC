'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createMessageFocusController,
  readTargetMessageId,
} = require('../public/chat-message-focus');

const ROOT = path.join(__dirname, '..');

function fakeElement(id, ts = 1) {
  const classes = new Set();
  return {
    id,
    ts,
    classes,
    scrollCalls: [],
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
    },
    scrollIntoView(options) { this.scrollCalls.push(options); },
  };
}

test('reads only the explicit message query parameter', () => {
  assert.equal(readTargetMessageId('?session=s1&message=m%2F2#ignored'), 'm/2');
  assert.equal(readTargetMessageId('?session=s1'), '');
  assert.equal(readTargetMessageId('?message=%20%20'), '');
});

test('focuses the exact id when messages share the same timestamp', async () => {
  const wrong = fakeElement('m-wrong', 1234);
  const target = fakeElement('m-target', 1234);
  const nodes = new Map([[wrong.id, wrong], [target.id, target]]);
  let fetched = false;
  const controller = createMessageFocusController({
    targetId: 'm-target',
    findById: id => nodes.get(id) || null,
    fetchAround: async () => { fetched = true; return { found: false }; },
    highlightMs: 0,
  });

  assert.equal(await controller.ensureFocused(), true);
  assert.equal(fetched, false);
  assert.equal(target.scrollCalls.length, 1);
  assert.deepEqual(target.scrollCalls[0], {
    block: 'center', inline: 'nearest', behavior: 'smooth',
  });
  assert.equal(wrong.scrollCalls.length, 0);
});

test('loads an older around window then focuses its exact target', async () => {
  const nodes = new Map();
  const merged = [];
  const controller = createMessageFocusController({
    targetId: 'old-2',
    findById: id => nodes.get(id) || null,
    async fetchAround(id) {
      assert.equal(id, 'old-2');
      return {
        found: true,
        hasMore: true,
        messages: [
          { id: 'old-1', ts: 50 },
          { id: 'old-2', ts: 50 },
          { id: 'old-3', ts: 50 },
        ],
      };
    },
    mergeMessages(messages) {
      merged.push(...messages.map(message => message.id));
      for (const message of messages) nodes.set(message.id, fakeElement(message.id, message.ts));
    },
    highlightMs: 0,
  });

  assert.equal(await controller.ensureFocused(), true);
  assert.deepEqual(merged, ['old-1', 'old-2', 'old-3']);
  assert.equal(nodes.get('old-2').scrollCalls.length, 1);
  assert.equal(nodes.get('old-1').scrollCalls.length, 0);
  assert.equal(controller.shouldHoldBottom(), true);
});

test('missing ids fail closed so the host can restore bottom placement', async () => {
  let merged = false;
  const controller = createMessageFocusController({
    targetId: 'deleted-message',
    findById: () => null,
    fetchAround: async () => ({ found: false, messages: [] }),
    mergeMessages: () => { merged = true; },
  });

  assert.equal(controller.shouldHoldBottom(), true);
  assert.equal(await controller.ensureFocused(), false);
  assert.equal(controller.getState(), 'missing');
  assert.equal(controller.shouldHoldBottom(), false);
  assert.equal(merged, false);
});

test('highlight is removed by the injected timer without losing focus state', async () => {
  const target = fakeElement('m1');
  const timers = [];
  const controller = createMessageFocusController({
    targetId: 'm1',
    findById: () => target,
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    highlightMs: 75,
  });

  assert.equal(await controller.ensureFocused(), true);
  assert.equal(target.classes.has('msg-jump-target'), true);
  assert.equal(timers[0].delay, 75);
  timers[0].fn();
  assert.equal(target.classes.has('msg-jump-target'), false);
  assert.equal(controller.getState(), 'focused');
});

test('chat host loads the controller and gates bottom placement on exact-id focus', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  const focusTag = '<script src="chat-message-focus.js"></script>';
  assert.ok(html.indexOf(focusTag) > html.indexOf('<script src="chat-history-view.js"></script>'));
  assert.ok(html.indexOf(focusTag) < html.indexOf('<script src="chat.js"></script>'));
  assert.match(chat, /readTargetMessageId\(location\.search\)/);
  assert.match(chat, /history\?around=\$\{encodeURIComponent\(messageId\)\}&limit=31/);
  assert.match(chat, /chatMessageFocus\.shouldHoldBottom\(\)/);
  assert.match(chat, /chatMessageFocus\.ensureFocused\(\)\.then\(found/);
  assert.match(html, /\.msg\.msg-jump-target/);
});
