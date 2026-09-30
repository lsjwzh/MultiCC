'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULE_FILE = path.join(ROOT, 'public', 'chat-worktree-status.js');

// Hand-rolled element: the module only creates spans/buttons, toggles classes on
// the status bar and reads it back — no attachment, no layout, so a 40-line fake
// keeps this in the dependency-free unit lane (same as test-chat-notifications).
function createElement(tag) {
  const classes = new Set();
  const element = {
    tagName: tag,
    children: [],
    className: '',
    id: '',
    textContent: '',
    title: '',
    hidden: false,
    disabled: false,
    onclick: null,
    parentNode: null,
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, on) {
        const want = on === undefined ? !classes.has(name) : !!on;
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
    },
    appendChild(child) { child.parentNode = element; element.children.push(child); return child; },
    insertBefore(child) { child.parentNode = element; element.children.unshift(child); return child; },
    remove() {
      if (!element.parentNode) return;
      const index = element.parentNode.children.indexOf(element);
      if (index >= 0) element.parentNode.children.splice(index, 1);
      element.parentNode = null;
    },
    querySelector() { return null; },
    set innerHTML(_value) { element.children.length = 0; },
    get innerHTML() { return ''; },
  };
  return element;
}

function loadModule() {
  const elements = new Map();
  const body = createElement('body');
  const document = {
    body,
    createElement,
    getElementById(id) { return elements.get(id) || null; },
  };
  const notices = [];
  const syncRenders = [];
  const window = {
    document,
    MultiCCWorktreeStatus: null,
    fetch: async () => { throw new Error('fetch not stubbed'); },
  };
  const context = vm.createContext({
    window,
    document,
    URL,
    console,
    setTimeout,
    clearTimeout,
    fetch: (...args) => window.fetch(...args),
  });
  vm.runInContext(fs.readFileSync(MODULE_FILE, 'utf8'), context);
  return {
    api: window.MultiCCWorktreeStatus,
    document, elements, notices, syncRenders, window,
    register(id, element) { elements.set(id, element); return element; },
    notice(text) { notices.push(text); },
    tt(key, params) { return params ? `${key}(${JSON.stringify(params)})` : key; },
    syncRequest: { render(parent, id) { syncRenders.push({ parent, id: id || null }); } },
    api_: {
      errorText: failure => (failure && failure.message) || String(failure),
      errorFromPayload: (data, { response }) => new Error((data && data.error) || `HTTP ${response.status}`),
    },
  };
}

function barChildren(bar) {
  return bar.children.map(child => child.id || child.textContent);
}

test('a reclaimed worktree shows the hibernation label and no sync button', async () => {
  const host = loadModule();
  const bar = host.register('worktree-bar', createElement('div'));
  const mergeButton = createElement('button');
  const mergeHint = createElement('div');
  const hintText = createElement('span');
  hintText.className = 'merge-hint-text';
  mergeHint.querySelector = selector => (selector === '.merge-hint-text' ? hintText : null);

  const status = host.api.create({
    document: host.document,
    tt: host.tt,
    withToken: url => url,
    sessionId: () => 'task-1',
    mergeButton,
    mergeHint,
    api: host.api_,
    notice: host.notice,
    syncRequest: host.syncRequest,
  });

  // Hibernated: the record keeps branch + worktreePath, the checkout is gone.
  // `behind: 2` is what the retained ref still answers — it must not turn into a
  // sync nudge for a worktree that is not on disk.
  status.apply({
    branch: 'multicc/task-1', baseBranch: 'main', behind: 2, ahead: 0,
    dirty: false, mergeReady: false, worktreeMissing: true,
  });

  assert.equal(bar.classList.contains('show'), true);
  assert.equal(bar.classList.contains('behind'), false, 'reclaim is not a "behind" state');
  assert.equal(bar.children[0].textContent, 'worktreeReclaimed');
  assert.deepEqual(barChildren(bar).includes('worktree-sync-btn'), false,
    'no one-click sync while there is no checkout to sync');
  assert.equal(host.syncRenders.length, 1, 'force sync stays: it dispatches through the session');
  assert.equal(host.syncRenders[0].id, 'worktree-force-sync-btn');
  assert.deepEqual(host.notices, [], 'no behind warning for a delta that cannot be acted on');
  assert.equal(mergeHint.classList.contains('show'), false);

  // The server may name the same reclaim through `reason` alone; both readings
  // mean "there is no checkout here".
  status.apply({ branch: 'multicc/task-1', baseBranch: 'main', behind: 0, reason: 'hibernated' });
  assert.equal(bar.children[0].textContent, 'worktreeReclaimed');
  assert.equal(host.syncRenders.length, 2);
});

test('a worktree that is genuinely behind keeps the sync button and the warning', async () => {
  const host = loadModule();
  const bar = host.register('worktree-bar', createElement('div'));
  const status = host.api.create({
    document: host.document,
    tt: host.tt,
    withToken: url => url,
    sessionId: () => 'task-1',
    mergeButton: null,
    mergeHint: null,
    api: host.api_,
    notice: host.notice,
    syncRequest: host.syncRequest,
  });

  status.apply({ branch: 'multicc/task-1', baseBranch: 'main', behind: 2, mergeReady: false });

  assert.equal(bar.classList.contains('behind'), true);
  assert.equal(bar.children[0].textContent, 'behindLabel({"branch":"multicc/task-1","base":"main","n":2})');
  const syncButton = bar.children.find(child => child.id === 'worktree-sync-btn');
  assert.ok(syncButton, 'the one-click sync lives on the status row');
  assert.equal(syncButton.textContent, 'sync');
  assert.equal(host.notices.length, 1);
  assert.match(host.notices[0], /^behindBanner/);

  // A later poll that repeats the same delta must not warn again.
  status.apply({ branch: 'multicc/task-1', baseBranch: 'main', behind: 2, mergeReady: false });
  assert.equal(host.notices.length, 1);
});

test('one-click sync reports the server refusal verbatim when the checkout vanished', async () => {
  const host = loadModule();
  const bar = host.register('worktree-bar', createElement('div'));
  const status = host.api.create({
    document: host.document,
    tt: host.tt,
    withToken: url => url,
    sessionId: () => 'task-1',
    mergeButton: null,
    mergeHint: null,
    api: host.api_,
    notice: host.notice,
    syncRequest: host.syncRequest,
  });
  status.apply({ branch: 'multicc/task-1', baseBranch: 'main', behind: 2, mergeReady: false });
  const syncButton = bar.children.find(child => child.id === 'worktree-sync-btn');

  // The workspace can be reclaimed between the status poll and the click; the
  // route then answers 409 worktree-missing and that reason has to reach the
  // user instead of a silent button reset.
  host.window.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      ok: false, blocked: true, worktreeMissing: true, reasons: ['worktree-missing'],
      error: '会话工作区已休眠回收，本地没有 checkout，无法同步；先给会话发一条消息恢复工作区',
    }),
  });
  await syncButton.onclick();

  assert.equal(host.notices.length, 2);
  assert.match(host.notices[1], /^✗ 同步失败：会话工作区已休眠回收/);
  assert.equal(syncButton.disabled, false, 'the button resets once the request is done');
});

test('fresh merge refresh bypasses the poll cache and returns the authoritative state', async () => {
  const host = loadModule();
  const mergeButton = createElement('button');
  const calls = [];
  host.window.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ mergeReady: true, dirty: true, ahead: 0, behind: 0 }) };
  };
  const status = host.api.create({
    document: host.document,
    tt: host.tt,
    withToken: url => url,
    sessionId: () => 'task-1',
    mergeButton,
    mergeHint: null,
    api: host.api_,
    notice: host.notice,
    syncRequest: host.syncRequest,
  });

  const state = await status.refresh({ fresh: true });
  assert.equal(calls[0], '/api/sessions/task-1/merge-status?refresh=1');
  assert.equal(state.mergeReady, true);
  assert.equal(mergeButton.classList.contains('merge-ready'), true);
});
