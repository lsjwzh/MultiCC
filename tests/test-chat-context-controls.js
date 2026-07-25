'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/chat-context-controls');

function element() {
  const listeners = new Map();
  return {
    style: {},
    listeners,
    addEventListener(type, handler) { listeners.set(type, handler); },
    click() { listeners.get('click')?.({ stopPropagation() {}, target: this }); },
    contains() { return false; },
  };
}

function fixture({ streaming = false, connected = true, confirmed = true } = {}) {
  const wrap = element();
  const menu = element();
  const clearAll = element();
  const clearKeep = element();
  const rotate = element();
  const keepInput = { value: '5' };
  menu.querySelector = selector => ({
    '[data-action="clear-all"]': clearAll,
    '[data-action="clear-keep"]': clearKeep,
    '[data-action="rotate-native"]': rotate,
  })[selector];
  const documentListeners = new Map();
  const document = {
    getElementById(id) {
      return {
        'clear-ctx-wrap': wrap,
        'clear-ctx-menu': menu,
        'clear-keep-n': keepInput,
      }[id];
    },
    addEventListener(type, handler) { documentListeners.set(type, handler); },
  };
  const sent = [];
  const notices = [];
  let confirmCalls = 0;
  create({
    document,
    window: { confirm() { confirmCalls += 1; return confirmed; } },
    translate: key => key,
    getIsStreaming: () => streaming,
    cancelStreaming() {},
    resetHistoryPagination() {},
    messagesEl: { querySelectorAll: () => [] },
    addSystemMsg() {},
    clearMessages() {},
    isConnected: () => connected,
    send: payload => sent.push(payload),
    showNotifyToast: (message, kind) => notices.push({ message, kind }),
  });
  return { wrap, menu, rotate, sent, notices, confirmCalls: () => confirmCalls };
}

test('manual rotation sends the preserve-history command only after confirmation', () => {
  const fx = fixture();
  fx.rotate.click();
  assert.equal(fx.confirmCalls(), 1);
  assert.deepEqual(fx.sent, [{ type: 'clear_history', preserveHistory: true }]);
  assert.equal(fx.menu.style.display, 'none');
});

test('manual rotation is blocked locally while streaming', () => {
  const fx = fixture({ streaming: true });
  fx.rotate.click();
  assert.equal(fx.confirmCalls(), 0);
  assert.deepEqual(fx.sent, []);
  assert.deepEqual(fx.notices, [{ message: 'rotateNativeContextBusy', kind: 'waiting' }]);
});

test('manual rotation preserves state when confirmation is declined', () => {
  const fx = fixture({ confirmed: false });
  fx.rotate.click();
  assert.equal(fx.confirmCalls(), 1);
  assert.deepEqual(fx.sent, []);
});

test('manual rotation reports an offline connection without sending', () => {
  const fx = fixture({ connected: false });
  fx.rotate.click();
  assert.deepEqual(fx.sent, []);
  assert.deepEqual(fx.notices, [{ message: 'rotateNativeContextOffline', kind: 'fail' }]);
});
