'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const taskBoardUi = require('../public/task-board-ui');

function taskBoardFakeClassList() {
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
      return values.has(name);
    },
  };
}

function taskBoardFakeElement(overrides = {}) {
  const element = {
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    textContent: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    files: [],
    options: [],
    classList: taskBoardFakeClassList(),
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    focus() { this.focused = true; },
    click() { return typeof this.onclick === 'function' ? this.onclick() : undefined; },
    remove() {},
    ...overrides,
  };
  return element;
}

function taskBoardFakeSelect() {
  const select = taskBoardFakeElement();
  let html = '';
  Object.defineProperty(select, 'innerHTML', {
    get() { return html; },
    set(value) {
      html = String(value || '');
      this.options = [...html.matchAll(/<option value="([^"]*)"/g)]
        .map(match => ({ value: match[1] }));
      this.value = this.options[0]?.value || '';
    },
  });
  return select;
}

function createTaskBoardComposerHarness({
  providers, autoEditor, suggestedRuntime, pickAutoProvider, fetchProviders, contextKey,
  translate, onSendingChange, submit,
} = {}) {
  const selectors = new Map();
  for (const selector of [
    '.tb-input', '.tb-chiprow', '.tb-send-btn', '.tb-mic-btn', '.tb-goal-btn',
    '.tb-goalrow', '.tb-file-input', '.tb-result', '.tb-attach-btn',
    '.tb-goal-rounds', '.tb-goal-budget', '.tb-auto-provider-editor',
    '.tb-auto-summary-row', '.tb-auto-summary', '.tb-auto-config-btn',
  ]) selectors.set(selector, taskBoardFakeElement());
  selectors.set('.tb-cli', taskBoardFakeSelect());
  selectors.set('.tb-provider', taskBoardFakeSelect());
  selectors.get('.tb-chiprow').querySelectorAll = () => [];
  selectors.get('.tb-goal-rounds').value = '200';

  const host = {
    innerHTML: '',
    querySelector(selector) { return selectors.get(selector) || null; },
  };
  const fetchCalls = [];
  const submitCalls = [];
  const providerList = providers || [];
  const runtime = suggestedRuntime || { ok: true, cli: 'claude', provider: '' };
  let providerFetchCount = 0;
  const fetch = async (url) => {
    fetchCalls.push(String(url));
    if (url === '/api/task-board/suggested-runtime') {
      return { ok: true, json: async () => runtime };
    }
    if (String(url).startsWith('/api/providers?cli=')) {
      providerFetchCount += 1;
      if (fetchProviders) {
        return fetchProviders({
          url: String(url), callNo: providerFetchCount, providers: providerList,
        });
      }
      return { ok: true, json: async () => ({ providers: providerList }) };
    }
    return {
      ok: true,
      json: async () => ({ modules: [], tasks: [], sessions: [], sessionLabels: {} }),
    };
  };
  const window = {
    MultiCCTaskBoardUi: taskBoardUi,
    MultiCCAutoProviderEditor: autoEditor,
    crypto: { randomUUID: () => 'task-board-auto-provider-test' },
  };
  const context = vm.createContext({
    console,
    window,
    document: {
      getElementById: () => null,
      createElement: tag => taskBoardFakeElement({ tagName: String(tag).toUpperCase() }),
      body: { appendChild() {} },
      head: { appendChild() {} },
    },
    fetch,
    navigator: { mediaDevices: {} },
    FormData: class FormData { append() {} },
    Blob: class Blob { constructor() { this.size = 0; } },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    Date,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8'),
    context,
    { filename: 'manage-taskboard.js' },
  );
  context.__taskBoardComposerHost = host;
  context.__taskBoardComposerOptions = {
    placeholder: 'test',
    ...(contextKey == null ? {} : { contextKey }),
    ...(pickAutoProvider ? { pickAutoProvider } : {}),
    ...(translate ? { translate } : {}),
    ...(onSendingChange ? { onSendingChange } : {}),
    async submit(payload) {
      submitCalls.push(JSON.parse(JSON.stringify(payload)));
      return submit ? submit(payload) : 'ok';
    },
  };
  const composer = vm.runInContext(
    'createTbComposer(__taskBoardComposerHost, __taskBoardComposerOptions)',
    context,
  );
  return { context, window, host, selectors, composer, fetchCalls, submitCalls };
}

function createTaskBoardOriginFilterHarness() {
  const statusPresentation = require('../public/status-presentation');
  const now = Date.now();
  const board = {
    modules: [
      { id: 'mod-a', dirId: 'fleet-a', name: 'Fleet A', source: 'manual', lastTs: now },
      { id: 'mod-b', dirId: 'fleet-b', name: 'Fleet B', source: 'manual', lastTs: now },
    ],
    tasks: [
      {
        id: 'board-active', moduleId: 'mod-a', dirIds: ['fleet-a'], title: '独立任务进行中',
        body: 'board active body', status: 'active', runState: 'idle', origin: 'board',
        // Deliberately cross the planning capability with the admission source:
        // origin, not recordType, owns this filter.
        recordType: 'observed', refCount: 1, lastTs: now,
      },
      {
        id: 'board-done', moduleId: 'mod-a', dirIds: ['fleet-a'], title: '独立任务已完成',
        body: 'board done body', status: 'done', runState: 'succeeded', origin: 'board',
        recordType: 'observed', refCount: 1, lastTs: now - 1,
      },
      {
        id: 'session-active', moduleId: 'mod-a', dirIds: ['fleet-a'], title: '会话任务进行中',
        body: 'session active body', status: 'active', runState: 'idle', origin: 'session',
        recordType: 'planned', refCount: 1, lastTs: now - 2,
      },
      {
        id: 'session-done', moduleId: 'mod-a', dirIds: ['fleet-a'], title: '会话任务已完成',
        body: 'session done body', status: 'done', runState: 'succeeded', origin: 'session',
        recordType: 'planned', refCount: 1, lastTs: now - 3,
      },
      {
        id: 'session-only', moduleId: 'mod-b', dirIds: ['fleet-b'], title: '只有会话来源',
        body: 'session only body', status: 'active', runState: 'idle', origin: 'session',
        recordType: 'planned', refCount: 1, lastTs: now - 4,
      },
    ],
    sessionLabels: {},
  };
  const fetchCalls = [];
  const renderCalls = [];
  const fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url === '/api/task-board/archive-completed') {
      return { ok: true, json: async () => ({ ok: true, archivedCount: 2 }) };
    }
    if (url === '/api/task-board') {
      return { ok: true, json: async () => ({ ok: true, ...board }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const window = {
    MultiCCTaskBoardUi: taskBoardUi,
    MultiCCStatusPresentation: statusPresentation,
    t: key => key,
    open() {},
  };
  const context = vm.createContext({
    console,
    window,
    document: {
      getElementById: () => null,
      createElement: tag => taskBoardFakeElement({ tagName: String(tag).toUpperCase() }),
      body: { appendChild() {} },
      head: { appendChild() {} },
    },
    fetch,
    confirm: () => true,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    Date,
    _detailDirId: 'fleet-a',
    renderDirectoryDetailBody(dirId) { renderCalls.push(dirId); },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8'),
    context,
    { filename: 'manage-taskboard.js' },
  );
  context.__taskBoardOriginFixture = board;
  vm.runInContext('_tbBoard = __taskBoardOriginFixture', context);

  function call(name, ...args) {
    context.__taskBoardOriginArgs = args;
    return vm.runInContext(`${name}(...__taskBoardOriginArgs)`, context);
  }

  function state() {
    return JSON.parse(vm.runInContext(`JSON.stringify({
      origin: _tbOriginFilter,
      mergeMode: _tbMergeMode,
      mergeDirId: _tbMergeDirId,
      mergeTaskIds: [..._tbMergeTaskIds],
    })`, context));
  }

  return { board, call, context, fetchCalls, renderCalls, state };
}

async function settleTaskBoardComposer() {
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

function taskBoardDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('classic task board source filter renders all, independent, and session task views', () => {
  const harness = createTaskBoardOriginFilterHarness();
  let stopped = 0;
  const event = { stopPropagation() { stopped += 1; } };

  let html = harness.call('renderTaskBoardSection', 'fleet-a', { tabbed: true });
  assert.match(html, /<span>1 模块 · 4 任务<\/span>/);
  assert.match(html, /tb-origin-filter-btn active[^>]*aria-pressed="true"[^>]*>全部 <strong>4<\/strong>/);
  assert.match(html, /tb-origin-filter-btn"[^>]*aria-pressed="false"[^>]*>独立任务 <strong>2<\/strong>/);
  assert.match(html, /tb-origin-filter-btn"[^>]*aria-pressed="false"[^>]*>会话任务 <strong>2<\/strong>/);
  assert.match(html, /独立任务进行中/);
  assert.match(html, /独立任务已完成/);
  assert.match(html, /会话任务进行中/);
  assert.match(html, /会话任务已完成/);

  harness.call('setTaskBoardOriginFilter', event, 'board', 'fleet-a');
  html = harness.call('renderTaskBoardSection', 'fleet-a', { tabbed: true });
  assert.equal(harness.state().origin, 'board');
  assert.match(html, /<span>1 模块 · 显示 2\/4 任务<\/span>/);
  assert.match(html, /tb-origin-filter-btn active[^>]*aria-pressed="true"[^>]*>独立任务 <strong>2<\/strong>/);
  assert.match(html, /独立任务进行中/);
  assert.match(html, /独立任务已完成/);
  assert.doesNotMatch(html, /会话任务进行中/);
  assert.doesNotMatch(html, /会话任务已完成/);

  harness.call('setTaskBoardOriginFilter', event, 'session', 'fleet-a');
  html = harness.call('renderTaskBoardSection', 'fleet-a', { tabbed: true });
  assert.equal(harness.state().origin, 'session');
  assert.match(html, /<span>1 模块 · 显示 2\/4 任务<\/span>/);
  assert.match(html, /tb-origin-filter-btn active[^>]*aria-pressed="true"[^>]*>会话任务 <strong>2<\/strong>/);
  assert.match(html, /会话任务进行中/);
  assert.match(html, /会话任务已完成/);
  assert.doesNotMatch(html, /独立任务进行中/);
  assert.doesNotMatch(html, /独立任务已完成/);

  harness.call('setTaskBoardOriginFilter', event, 'all', 'fleet-a');
  html = harness.call('renderTaskBoardSection', 'fleet-a', { tabbed: true });
  assert.equal(harness.state().origin, 'all');
  assert.match(html, /<span>1 模块 · 4 任务<\/span>/);
  assert.match(html, /独立任务进行中/);
  assert.match(html, /会话任务进行中/);

  harness.call('setTaskBoardOriginFilter', event, 'board', 'fleet-b');
  html = harness.call('renderTaskBoardSection', 'fleet-b', { tabbed: true });
  assert.match(html, /<span>0 模块 · 显示 0\/1 任务<\/span>/);
  assert.match(html, /当前来源筛选下没有任务。/);
  assert.match(html, />全部 <strong>1<\/strong>/);
  assert.match(html, />独立任务 <strong>0<\/strong>/);
  assert.match(html, />会话任务 <strong>1<\/strong>/);
  assert.doesNotMatch(html, /只有会话来源/);

  assert.equal(stopped, 4);
  assert.deepEqual(harness.renderCalls, ['fleet-a', 'fleet-a', 'fleet-a', 'fleet-b']);
});

test('source filter exits merge mode while one-click cleanup remains Fleet-wide', async () => {
  const harness = createTaskBoardOriginFilterHarness();
  const event = { stopPropagation() {} };

  harness.call('toggleTaskBoardMergeMode', event, 'fleet-a');
  harness.call('handleTaskBoardRowClick', event, 'board-active');
  assert.deepEqual(harness.state(), {
    origin: 'all',
    mergeMode: true,
    mergeDirId: 'fleet-a',
    mergeTaskIds: ['board-active'],
  });

  harness.call('setTaskBoardOriginFilter', event, 'session', 'fleet-a');
  assert.deepEqual(harness.state(), {
    origin: 'session',
    mergeMode: false,
    mergeDirId: null,
    mergeTaskIds: [],
  });

  const html = harness.call('renderTaskBoardSection', 'fleet-a', { tabbed: true });
  assert.doesNotMatch(html, /class="tb-merge-bar"/);
  assert.match(html, /title="归档 Fleet 内全部已完成任务（不受来源筛选影响）"/);
  assert.match(html, /🧹 一键清理 \(2\)/,
    'the filtered session view has one completed row, but cleanup counts both Fleet sources');

  const button = { disabled: false };
  await harness.call('archiveCompletedTaskBoard', event, 'fleet-a', button);
  const request = harness.fetchCalls.find(call => call.url === '/api/task-board/archive-completed');
  assert.ok(request, 'cleanup must call the Fleet-wide archive endpoint');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { dirId: 'fleet-a' });
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(request.options.body), 'origin'), false,
    'the selected source is a view filter and must not narrow cleanup scope');
  assert.equal(button.disabled, true);
});

test('task board Auto provider defaults to the first two managed routes', () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'official', name: 'Official', protocol: 'anthropic', isOfficial: true },
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', name: 'Managed B', protocol: 'anthropic', model: 'model-b' },
    { id: 'managed-c', name: 'Managed C', protocol: 'anthropic', model: 'model-c' },
    { id: 'chat-only', name: 'Chat', protocol: 'openai_chat', model: 'chat-model' },
  ];

  assert.deepEqual(editor.defaultSelection(providers, 'anthropic'), {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true },
      { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true },
    ],
    maxAttempts: 2,
    sticky: true,
    allowCrossTrust: false,
  });
  assert.equal(editor.defaultSelection([
    providers[0], providers[1], providers[4],
  ], 'anthropic'), null, 'Official is visible in the editor but never silently fills the managed default');
});

test('task board Auto provider preserves the committed enabled order and models', () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'managed-a', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', protocol: 'anthropic', model: 'model-b' },
    { id: 'managed-c', protocol: 'anthropic', model: 'model-c' },
  ];
  const result = editor.serializeDraft({
    protocol: 'anthropic',
    providers,
    candidates: [
      { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: false },
      { providerId: 'managed-b', model: 'model-b-override', priority: 20, enabled: true },
      { providerId: 'managed-c', model: null, priority: 5, enabled: true },
    ],
    maxAttempts: 4,
    sticky: true,
    crossTrustConfirmed: false,
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-c', model: null, priority: 5, enabled: true },
      { providerId: 'managed-b', model: 'model-b-override', priority: 20, enabled: true },
    ],
    maxAttempts: 2,
    sticky: true,
    allowCrossTrust: false,
  });

  const tooSmall = editor.serializeDraft({
    protocol: 'anthropic',
    providers,
    candidates: [
      { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true },
      { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: false },
    ],
  });
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.code, 'insufficient_candidates');
});

test('manage loads the shared Auto provider editor before the task board composer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage.html'), 'utf8');
  const composer = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  const editor = html.indexOf('<script src="auto-provider-editor.js"></script>');
  const taskBoard = html.indexOf('<script src="manage-taskboard.js"></script>');
  assert.ok(editor > 0 && editor < taskBoard);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+auto-provider-editor/i);
  assert.match(composer, /editorApi\.mount\(/,
    'the production picker path must mount the shared editor, not a task-board-only copy');
});

test('task board Auto first selection commits the edited snapshot into the send payload', async () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'official', name: 'Official', protocol: 'anthropic', isOfficial: true },
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', name: 'Managed B', protocol: 'anthropic', model: 'model-b' },
    { id: 'managed-c', name: 'Managed C', protocol: 'anthropic', model: 'model-c' },
  ];
  const committed = {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-c', model: 'model-c-override', priority: 5, enabled: true },
      { providerId: 'managed-b', model: 'model-b-override', priority: 20, enabled: true },
    ],
    maxAttempts: 2,
    sticky: false,
    allowCrossTrust: false,
  };
  const pickerCalls = [];
  const harness = createTaskBoardComposerHarness({
    providers,
    autoEditor: editor,
    async pickAutoProvider(options) {
      pickerCalls.push(JSON.parse(JSON.stringify(options)));
      return committed;
    },
  });
  await settleTaskBoardComposer();

  const providerSelect = harness.selectors.get('.tb-provider');
  providerSelect.value = editor.optionValue('anthropic');
  await providerSelect.onchange();

  assert.equal(pickerCalls.length, 1, 'the first Auto choice must open the shared picker boundary');
  assert.deepEqual(pickerCalls[0].selection, editor.defaultSelection(providers, 'anthropic'));
  assert.equal(pickerCalls[0].protocol, 'anthropic');
  assert.deepEqual(pickerCalls[0].providers.map(provider => provider.id),
    ['official', 'managed-a', 'managed-b', 'managed-c']);
  assert.equal(harness.selectors.get('.tb-auto-summary-row').classList.contains('visible'), true);
  assert.match(harness.selectors.get('.tb-auto-summary').textContent, /Managed C → Managed B/);

  // The composer owns a committed clone. Neither a later catalog change nor a
  // mutation of the picker result may silently expand or rewrite the first turn.
  committed.candidates[0].model = 'mutated-after-confirm';
  providers.push({ id: 'managed-new', name: 'New', protocol: 'anthropic', model: 'new-model' });
  harness.selectors.get('.tb-input').value = 'send with committed Auto routes';
  await harness.selectors.get('.tb-send-btn').onclick();

  assert.equal(harness.submitCalls.length, 1);
  const payload = harness.submitCalls[0];
  assert.equal(payload.cli, 'claude');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'provider'), false,
    'Auto sends a virtual selection, never a concrete provider alongside it');
  assert.deepEqual(payload.providerSelection, {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-c', model: 'model-c-override', priority: 5, enabled: true },
      { providerId: 'managed-b', model: 'model-b-override', priority: 20, enabled: true },
    ],
    maxAttempts: 2,
    sticky: false,
    allowCrossTrust: false,
  });
});

test('task board refuses to send Auto without a committed two-candidate selection', async () => {
  const editor = require('../public/auto-provider-editor');
  const harness = createTaskBoardComposerHarness({
    providers: [
      { id: 'only-managed', name: 'Only', protocol: 'anthropic', model: 'model-only' },
      { id: 'official', name: 'Official', protocol: 'anthropic', isOfficial: true },
    ],
    autoEditor: editor,
  });
  await settleTaskBoardComposer();

  harness.selectors.get('.tb-provider').value = editor.optionValue('anthropic');
  harness.selectors.get('.tb-input').value = 'must not dispatch';
  await harness.selectors.get('.tb-send-btn').onclick();

  assert.equal(harness.submitCalls.length, 0);
  assert.equal(harness.selectors.get('.tb-result').textContent, '请先配置并确认 Auto Provider 候选');
});

test('a late Auto provider refresh cannot overwrite a manual provider choice', async () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', name: 'Managed B', protocol: 'anthropic', model: 'model-b' },
  ];
  const delayedRefresh = taskBoardDeferred();
  let pickerCalls = 0;
  const harness = createTaskBoardComposerHarness({
    providers,
    autoEditor: editor,
    fetchProviders({ callNo }) {
      if (callNo === 1) {
        return { ok: true, json: async () => ({ providers }) };
      }
      if (callNo === 2) return delayedRefresh.promise;
      throw new Error(`unexpected provider fetch ${callNo}`);
    },
    async pickAutoProvider() {
      pickerCalls += 1;
      return editor.defaultSelection(providers, 'anthropic');
    },
  });
  await settleTaskBoardComposer();

  const providerSelect = harness.selectors.get('.tb-provider');
  providerSelect.value = editor.optionValue('anthropic');
  const staleAutoChange = providerSelect.onchange();
  await Promise.resolve();
  assert.equal(providerSelect.disabled, true, 'the force refresh owns the loading state');
  assert.equal(harness.selectors.get('.tb-auto-config-btn').disabled, true,
    'the config button cannot start a competing catalog refresh while Auto is loading');

  providerSelect.value = 'managed-a';
  await providerSelect.onchange();
  assert.equal(providerSelect.disabled, false, 'a newer manual choice cancels Auto loading ownership');
  assert.equal(harness.selectors.get('.tb-auto-config-btn').disabled, false);

  delayedRefresh.resolve({ ok: true, json: async () => ({ providers }) });
  await staleAutoChange;
  assert.equal(pickerCalls, 0, 'the stale refresh must not open an Auto picker');
  assert.equal(providerSelect.value, 'managed-a');

  harness.selectors.get('.tb-input').value = 'keep the manual route';
  await harness.selectors.get('.tb-send-btn').onclick();
  assert.equal(harness.submitCalls.length, 1);
  assert.equal(harness.submitCalls[0].provider, 'managed-a');
  assert.equal(Object.prototype.hasOwnProperty.call(harness.submitCalls[0], 'providerSelection'), false);
});

test('changing Fleet clears the composer draft and requires a fresh Auto confirmation', async () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', name: 'Managed B', protocol: 'anthropic', model: 'model-b' },
  ];
  const pickerCalls = [];
  const selection = editor.defaultSelection(providers, 'anthropic');
  const harness = createTaskBoardComposerHarness({
    providers,
    autoEditor: editor,
    contextKey: 'fleet-a',
    async pickAutoProvider(options) {
      pickerCalls.push(JSON.parse(JSON.stringify(options)));
      return selection;
    },
  });
  await settleTaskBoardComposer();

  const providerSelect = harness.selectors.get('.tb-provider');
  providerSelect.value = editor.optionValue('anthropic');
  await providerSelect.onchange();
  assert.equal(pickerCalls.length, 1);

  harness.selectors.get('.tb-input').value = 'Fleet A unsent draft';
  harness.selectors.get('.tb-chiprow').innerHTML = '<span>attachment</span>';
  harness.selectors.get('.tb-chiprow').style.display = '';
  harness.selectors.get('.tb-goal-btn').classList.add('on');
  harness.selectors.get('.tb-goalrow').style.display = '';
  harness.selectors.get('.tb-file-input').value = 'stale-file';

  harness.composer.setContext('fleet-b');
  assert.equal(harness.selectors.get('.tb-input').value, '');
  assert.equal(harness.selectors.get('.tb-chiprow').innerHTML, '');
  assert.equal(harness.selectors.get('.tb-chiprow').style.display, 'none');
  assert.equal(harness.selectors.get('.tb-goal-btn').classList.contains('on'), false);
  assert.equal(harness.selectors.get('.tb-goalrow').style.display, 'none');
  assert.equal(harness.selectors.get('.tb-file-input').value, '');
  await settleTaskBoardComposer();

  // Even though Fleet A committed this same protocol, Fleet B owns a distinct
  // allowlist key and must not inherit A's first-turn authorization.
  providerSelect.value = editor.optionValue('anthropic');
  harness.selectors.get('.tb-input').value = 'Fleet B must confirm independently';
  await harness.selectors.get('.tb-send-btn').onclick();
  assert.equal(harness.submitCalls.length, 0);
  assert.equal(harness.selectors.get('.tb-result').textContent, '请先配置并确认 Auto Provider 候选');
  assert.equal(pickerCalls.length, 1, 'Fleet B has not opened or confirmed its own picker yet');
});

test('the start-now context switch preserves the visible draft but isolates Auto authorization', async () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', name: 'Managed B', protocol: 'anthropic', model: 'model-b' },
  ];
  let pickerCalls = 0;
  const harness = createTaskBoardComposerHarness({
    providers,
    autoEditor: editor,
    contextKey: 'fleet-a',
    async pickAutoProvider() {
      pickerCalls += 1;
      return editor.defaultSelection(providers, 'anthropic');
    },
  });
  await settleTaskBoardComposer();

  const providerSelect = harness.selectors.get('.tb-provider');
  providerSelect.value = editor.optionValue('anthropic');
  await providerSelect.onchange();
  assert.equal(pickerCalls, 1);

  harness.selectors.get('.tb-input').value = 'Keep this task while choosing its Fleet';
  harness.selectors.get('.tb-chiprow').innerHTML = '<span>uploaded attachment</span>';
  harness.selectors.get('.tb-chiprow').style.display = '';
  harness.selectors.get('.tb-goal-btn').classList.add('on');
  harness.selectors.get('.tb-goalrow').style.display = '';
  harness.selectors.get('.tb-file-input').value = 'selected-file';

  harness.composer.setContext('fleet-b', { preserveDraft: true });
  assert.equal(harness.selectors.get('.tb-input').value, 'Keep this task while choosing its Fleet');
  assert.equal(harness.selectors.get('.tb-chiprow').innerHTML, '<span>uploaded attachment</span>');
  assert.equal(harness.selectors.get('.tb-chiprow').style.display, '');
  assert.equal(harness.selectors.get('.tb-goal-btn').classList.contains('on'), true);
  assert.equal(harness.selectors.get('.tb-goalrow').style.display, '');
  assert.equal(harness.selectors.get('.tb-file-input').value, 'selected-file');
  await settleTaskBoardComposer();

  assert.equal(providerSelect.value, editor.optionValue('anthropic'));
  await harness.selectors.get('.tb-send-btn').onclick();
  assert.equal(harness.submitCalls.length, 0,
    'the new Fleet must confirm its own Auto allowlist before the preserved draft can send');
  assert.equal(pickerCalls, 1);
});

test('the shared composer renders translated accessible controls without fallback Chinese', async () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'i18n', 'en.json'), 'utf8'));
  const translate = (key, params) => {
    const value = en[key] || key;
    return params ? value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`)) : value;
  };
  const harness = createTaskBoardComposerHarness({
    suggestedRuntime: { ok: true, cli: '', provider: '' },
    translate,
  });
  await settleTaskBoardComposer();

  assert.match(harness.host.innerHTML, /class="tb-input" aria-label="Task message"/);
  assert.match(harness.host.innerHTML, /class="tb-result" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(harness.host.innerHTML, /Goal mode/);
  assert.match(harness.host.innerHTML, /🚀 Send/);
  assert.match(harness.selectors.get('.tb-cli').innerHTML, /CLI · Default/);
  assert.match(harness.selectors.get('.tb-provider').innerHTML, /Provider · Default/);
  assert.doesNotMatch(
    `${harness.host.innerHTML}${harness.selectors.get('.tb-cli').innerHTML}${harness.selectors.get('.tb-provider').innerHTML}`,
    /默认|发送|模式|上传|语音/,
  );
});

test('sending locks composer controls and reports busy state until submit settles', async () => {
  const pending = taskBoardDeferred();
  const sendingStates = [];
  const harness = createTaskBoardComposerHarness({
    onSendingChange(value) { sendingStates.push(value); },
    submit: () => pending.promise,
  });
  await settleTaskBoardComposer();
  harness.selectors.get('.tb-input').value = 'Dispatch safely';

  const sending = harness.selectors.get('.tb-send-btn').onclick();
  assert.equal(sendingStates.at(-1), true);
  for (const selector of ['.tb-input', '.tb-attach-btn', '.tb-mic-btn', '.tb-goal-btn', '.tb-send-btn']) {
    assert.equal(harness.selectors.get(selector).disabled, true, `${selector} should lock while sending`);
  }

  pending.resolve('sent');
  await sending;
  assert.equal(sendingStates.at(-1), false);
  assert.equal(harness.selectors.get('.tb-input').disabled, false);
});
