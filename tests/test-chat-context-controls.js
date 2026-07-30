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

function fixture({
  streaming = false, connected = true, confirmed = true,
  sessionId = 's1', level = undefined,
} = {}) {
  const wrap = element();
  const menu = element();
  const clearAll = element();
  const clearKeep = element();
  const rotate = element();
  const contextLevel = element();
  const keepInput = { value: '5' };
  menu.querySelector = selector => ({
    '[data-action="clear-all"]': clearAll,
    '[data-action="clear-keep"]': clearKeep,
    '[data-action="rotate-native"]': rotate,
    '[data-action="context-level"]': contextLevel,
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
  const systemMsgs = [];
  const requests = [];
  let confirmCalls = 0;
  const api = create({
    document,
    window: { confirm() { confirmCalls += 1; return confirmed; } },
    translate: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    getIsStreaming: () => streaming,
    cancelStreaming() {},
    resetHistoryPagination() {},
    messagesEl: { querySelectorAll: () => [] },
    addSystemMsg: message => systemMsgs.push(message),
    clearMessages() {},
    isConnected: () => connected,
    send: payload => sent.push(payload),
    showNotifyToast: (message, kind) => notices.push({ message, kind }),
    getSessionId: () => sessionId,
    fetch: async (url) => {
      requests.push(url);
      if (level === 'http-error') return { ok: false, status: 500, json: async () => ({}) };
      if (level === 'network-error') throw new Error('offline');
      return { ok: true, status: 200, json: async () => level };
    },
  });
  return {
    api, wrap, menu, rotate, contextLevel, sent, notices, systemMsgs, requests,
    confirmCalls: () => confirmCalls,
  };
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

// The readout is the only thing that tells a user how close the native CLI context
// is to the wall before "Prompt is too long" does. It must state the cost of a trim
// when there is one, and it must never mutate anything — it is a GET.
test('context level reports the water level and the cost of a trim', async () => {
  const fx = fixture({
    level: {
      ok: true,
      supported: true,
      transcript: {
        found: true, fileBytes: 33.76 * 1048576, liveBytes: 26.6 * 1048576,
        liveTurns: 39, estimatedTokens: 3782367, wouldPrune: true, overWatermark: true,
        compactBoundary: { present: true, summaryPresent: true },
      },
      plan: { afterBytes: 1.08 * 1048576, lostTurns: 34, lostSubstantiveTurns: 11, dryRun: true },
    },
  });
  await fx.api.showContextLevel();
  assert.deepEqual(fx.requests, ['/api/sessions/s1/context-level?plan=1']);
  assert.equal(fx.sent.length, 0, 'a readout must not send commands');
  assert.equal(fx.systemMsgs.length, 1);
  const text = fx.systemMsgs[0];
  assert.match(text, /contextLevelSummary/);
  assert.match(text, /26\.60 MB/);
  assert.match(text, /33\.76 MB/);
  assert.match(text, /3,782,367/);
  assert.match(text, /contextLevelCompacted/);
  assert.match(text, /contextLevelOverWatermark/);
  // A lossy plan must say so — the safe wording here would be a lie.
  assert.match(text, /contextLevelPlanLossy/);
  assert.match(text, /"turns":34/);
  // 34 dropped turns of which 11 said anything is a different cost from 34 real ones.
  assert.match(text, /"substantive":11/);
  assert.doesNotMatch(text, /contextLevelPlanSafe/);
});

// `wouldPrune` says the gate will look; `overWatermark` says the context is nearly
// full. They are independent, and reading one for the other misinforms both ways.
test('context level separates gate arming from context pressure', async () => {
  const armedButRoomy = fixture({
    level: {
      ok: true, supported: true,
      transcript: {
        found: true, fileBytes: 2.4 * 1048576, liveBytes: 0.2 * 1048576,
        liveTurns: 4, estimatedTokens: 52000, wouldPrune: true, overWatermark: false,
        triggers: ['file-bytes'],
      },
      plan: null,
    },
  });
  await armedButRoomy.api.showContextLevel();
  const armed = armedButRoomy.systemMsgs[0];
  assert.doesNotMatch(armed, /contextLevelOverWatermark/, 'a big file is not a full context');
  // A trigger with no plan means the gate will find nothing — silence would read as
  // "a trim is coming" to anyone who saw the file size.
  assert.match(armed, /contextLevelPlanNone/);

  const fullButSmall = fixture({
    level: {
      ok: true, supported: true,
      transcript: {
        found: true, fileBytes: 0.3 * 1048576, liveBytes: 0.3 * 1048576,
        liveTurns: 6, estimatedTokens: 160000, wouldPrune: false, overWatermark: true,
        triggers: [],
      },
      plan: null,
    },
  });
  await fullButSmall.api.showContextLevel();
  const full = fullButSmall.systemMsgs[0];
  assert.match(full, /contextLevelOverWatermark/, 'context pressure must show below the size gate');
  assert.doesNotMatch(full, /contextLevelPlanNone/, 'nothing is armed, so promise nothing');
});

test('context level distinguishes a lossless trim, an unsupported session and a failure', async () => {
  const safe = fixture({
    level: {
      ok: true, supported: true,
      transcript: {
        found: true, fileBytes: 35.44 * 1048576, liveBytes: 0.62 * 1048576,
        liveTurns: 3, estimatedTokens: 108717, wouldPrune: true,
        compactBoundary: { present: true, summaryPresent: true },
      },
      plan: { afterBytes: 0.62 * 1048576, lostTurns: 0, dryRun: true },
    },
  });
  await safe.api.showContextLevel();
  assert.match(safe.systemMsgs[0], /contextLevelPlanSafe/);
  assert.doesNotMatch(safe.systemMsgs[0], /contextLevelPlanLossy/);

  const unsupported = fixture({ level: { ok: true, supported: false, reason: 'cli-not-claude' } });
  await unsupported.api.showContextLevel();
  assert.deepEqual(unsupported.systemMsgs, ['contextLevelUnavailable']);
  assert.deepEqual(unsupported.notices, []);

  for (const mode of ['http-error', 'network-error']) {
    const failed = fixture({ level: mode });
    await failed.api.showContextLevel();
    assert.deepEqual(failed.systemMsgs, [], `${mode}: no readout may be invented`);
    assert.deepEqual(failed.notices, [{ message: 'contextLevelFail', kind: 'fail' }]);
  }

  const noSession = fixture({ sessionId: '' });
  await noSession.api.showContextLevel();
  assert.deepEqual(noSession.requests, []);
  assert.deepEqual(noSession.notices, [{ message: 'contextLevelFail', kind: 'fail' }]);
});
