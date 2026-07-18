'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MODEL_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'memory-model.js'), 'utf8');
const GRAPH_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'memory-graph.js'), 'utf8');
const CONTROLLER_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'memory-controller.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function classList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
    toggle(value, force) {
      const next = force === undefined ? !values.has(value) : !!force;
      if (next) values.add(value); else values.delete(value);
      return next;
    },
  };
}

function element(overrides = {}) {
  const listeners = new Map();
  return Object.assign({
    textContent: '',
    innerHTML: '',
    value: '',
    style: {},
    dataset: {},
    classList: classList(),
    firstChild: null,
    clientWidth: 800,
    clientHeight: 520,
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    removeEventListener(type, listener) {
      const group = listeners.get(type) || [];
      listeners.set(type, group.filter(item => item !== listener));
    },
    async emit(type, event = {}) {
      const payload = Object.assign({
        target: this,
        preventDefault() {},
        stopPropagation() {},
      }, event);
      return Promise.all((listeners.get(type) || []).map(listener => listener(payload)));
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    appendChild() {},
    removeChild() { this.firstChild = null; },
    setAttribute() {},
    querySelector() { return null; },
  }, overrides);
}

function createDocument(elements = {}) {
  const listeners = new Map();
  return {
    readyState: 'loading',
    hidden: false,
    body: element(),
    getElementById(id) { return elements[id] || null; },
    querySelectorAll() { return []; },
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    async emit(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map(listener => listener(event)));
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    createElement() { return element(); },
    createElementNS() { return element(); },
    execCommand() { return true; },
  };
}

function createHarness(jsonImpl, elements = {}) {
  const calls = [];
  const document = createDocument(elements);
  const api = {
    async json(url, options) {
      calls.push({ url, options });
      return jsonImpl(url, options, calls.length - 1);
    },
    errorDisplay(error) {
      return { message: error && error.safeMessage ? error.safeMessage : 'Request failed' };
    },
  };
  const window = {
    document,
    MultiCCApi: api,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    __confirmCalls: 0,
  };
  const context = {
    window,
    document,
    navigator: {},
    performance: window.performance,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    confirm: () => { window.__confirmCalls++; return true; },
    console,
  };
  vm.runInNewContext(MODEL_SOURCE, context, { filename: 'memory-model.js' });
  return {
    window,
    document,
    calls,
    runGraph() { vm.runInNewContext(GRAPH_SOURCE, context, { filename: 'memory-graph.js' }); },
    runController() { vm.runInNewContext(CONTROLLER_SOURCE, context, { filename: 'memory-controller.js' }); },
  };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function editorElements() {
  return {
    'mem-tree': element(),
    'mem-file-modal': element(),
    'mem-file-title': element(),
    'mem-file-path': element(),
    'mem-file-ta': element(),
    'mem-file-tok': element(),
    'mem-file-msg': element(),
    'mem-file-save': element(),
    'mem-file-del': element(),
  };
}

test('Memory DTOs are bounded whitelists and discard credentials and unknown internals', () => {
  const h = createHarness(async () => ({}));
  const model = h.window.MultiCCMemoryModel;
  const graph = plain(model.normalizeGraphPayload({
    nodes: [{
      id: 'n1', title: 'Title', summary: 'Summary', dirId: 'd1', rel: 'd1/a.md',
      path: '/private/memories/d1/a.md', tokens: 3, token: 'drop-node', headers: { authorization: 'drop' },
    }],
    edges: [{ source: 'n1', target: 'n2', strength: 2, apiKey: 'drop-edge' }],
    meta: { projects: [{ dirId: 'd1', name: 'Fleet', count: 1, secret: 'drop-project' }], secret: 'drop-meta' },
    authToken: 'drop-root',
  }));
  assert.deepEqual(Object.keys(graph.nodes[0]).sort(), [
    'degree', 'dirId', 'file', 'id', 'missing', 'path', 'rel', 'scope', 'sessionId',
    'size', 'slug', 'summary', 'title', 'tokens', 'type',
  ]);
  assert.deepEqual(graph.edges[0], { source: 'n1', target: 'n2', type: '', strength: 2 });
  assert.deepEqual(graph.meta.projects[0], { dirId: 'd1', name: 'Fleet', count: 1 });

  const tree = plain(model.normalizeTreePayload({
    projects: [{
      dirId: 'd1', name: 'Fleet', dirPath: '/must-drop', token: 'drop',
      shared: { dir: '/must-drop', files: [{ name: 'a.md', rel: 'd1/_shared/a.md', path: '/safe-display', token: 'drop-file' }] },
      sessions: [{ sessionId: 's1', label: 'Chat', cli: 'codex', live: true, nativeSessionId: 'drop', files: [] }],
    }],
    meta: { projectCount: 1, secret: 'drop-meta' },
  }));
  assert.equal(tree.projects[0].dirPath, undefined);
  assert.equal(tree.projects[0].shared.dir, undefined);
  assert.equal(tree.projects[0].sessions[0].nativeSessionId, undefined);

  const file = plain(model.normalizeFilePayload({
    rel: 'd1/a.md', content: '# safe', path: '/safe-display', authToken: 'drop', stack: 'drop',
  }));
  assert.deepEqual(Object.keys(file).sort(), [
    'content', 'contentTruncated', 'mtime', 'name', 'ok', 'originalLength', 'path',
    'readOnly', 'rel', 'size', 'tokens',
  ]);
  const serialized = JSON.stringify({ graph, tree, file });
  for (const secret of ['drop-node', 'drop-edge', 'drop-project', 'drop-root', 'drop-file', 'drop-meta']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('Memory model is the sole API boundary and normalizes every response', async () => {
  const h = createHarness(async (url, options) => {
    if (url === '/api/memory/graph') return { nodes: [], edges: [], meta: {}, token: 'drop' };
    if (url === '/api/memory/tree') return { projects: [], meta: {}, token: 'drop' };
    if (url.startsWith('/api/memory/file?')) return { rel: 'd/a.md', content: 'hello', token: 'drop' };
    if (options && options.method === 'PUT') return { ok: true, rel: options.json.rel, tokens: 2, secret: 'drop' };
    return { ok: true, secret: 'drop' };
  });
  const model = h.window.MultiCCMemoryModel;
  await model.loadGraph();
  await model.loadTree();
  const file = plain(await model.loadFile('d/a.md'));
  const saved = plain(await model.saveFile('d/a.md', 'hello'));
  const deleted = plain(await model.deleteFile('d/a.md'));

  assert.equal(file.content, 'hello');
  assert.equal(file.token, undefined);
  assert.equal(saved.secret, undefined);
  assert.deepEqual(deleted, { ok: true });
  assert.deepEqual(plain(h.calls.map(call => [call.url, call.options && call.options.method])), [
    ['/api/memory/graph', null],
    ['/api/memory/tree', null],
    ['/api/memory/file?rel=d%2Fa.md', null],
    ['/api/memory/file', 'PUT'],
    ['/api/memory/file', 'DELETE'],
  ]);
  assert.deepEqual(plain(h.calls[3].options.json), { rel: 'd/a.md', content: 'hello' });
  assert.deepEqual(plain(h.calls[4].options.json), { rel: 'd/a.md' });
});

test('Oversized Memory files are explicit read-only previews and can never be saved', async () => {
  const extra = 37;
  const oversized = 'x'.repeat(200000 + extra);
  const elements = editorElements();
  const h = createHarness(async (url) => {
    if (url.startsWith('/api/memory/file?')) {
      return { rel: 'd/large.md', path: '/private/large.md', content: oversized };
    }
    return { ok: true };
  }, elements);
  h.runController();
  await h.document.emit('DOMContentLoaded');

  const normalized = plain(h.window.MultiCCMemoryModel.normalizeFilePayload({ content: oversized }));
  assert.equal(normalized.content.length, 200000);
  assert.equal(normalized.originalLength, 200000 + extra);
  assert.equal(normalized.contentTruncated, true);
  assert.equal(normalized.readOnly, true);

  await h.window.openMemFileEditor('d/large.md');
  assert.equal(elements['mem-file-ta'].value.length, 200000);
  assert.equal(elements['mem-file-ta'].readOnly, true);
  assert.equal(elements['mem-file-save'].disabled, true);
  assert.match(elements['mem-file-msg'].textContent, /200037 字符/);
  assert.match(elements['mem-file-msg'].textContent, /禁用保存/);

  await elements['mem-file-save'].emit('click');
  assert.equal(h.calls.some(call => call.options && call.options.method === 'PUT'), false);
  assert.match(elements['mem-file-msg'].textContent, /避免覆盖完整文件/);
});

test('Reopening any editor generation invalidates stale save and delete completions', async () => {
  const saveResult = deferred();
  const deleteResult = deferred();
  let reads = 0;
  const elements = editorElements();
  const h = createHarness(async (url, options) => {
    if (url.startsWith('/api/memory/file?')) {
      reads++;
      return { rel: 'd/a.md', path: '/a', content: `server-${reads}` };
    }
    if (options && options.method === 'PUT') return saveResult.promise;
    if (options && options.method === 'DELETE') return deleteResult.promise;
    return {};
  }, elements);
  h.runController();
  await h.document.emit('DOMContentLoaded');

  await h.window.openMemFileEditor('d/a.md');
  elements['mem-file-ta'].value = 'old local save';
  const pendingSave = elements['mem-file-save'].emit('click');
  await h.window.openMemFileEditor('d/a.md');
  assert.equal(elements['mem-file-ta'].value, 'server-2');
  saveResult.resolve({ ok: true, rel: 'd/a.md', tokens: 4 });
  await pendingSave;
  assert.equal(elements['mem-file-ta'].value, 'server-2');
  assert.equal(elements['mem-file-msg'].textContent, '');
  const confirmsBeforeClose = h.window.__confirmCalls;
  h.window.memFileEditorClose();
  assert.equal(h.window.__confirmCalls, confirmsBeforeClose, 'stale save must not replace the new dirty baseline');

  await h.window.openMemFileEditor('d/a.md');
  const pendingDelete = elements['mem-file-del'].emit('click');
  await h.window.openMemFileEditor('d/a.md');
  elements['mem-file-ta'].value = 'unsaved after reopen';
  deleteResult.resolve({ ok: true });
  await pendingDelete;
  assert.equal(elements['mem-file-modal'].classList.contains('open'), true);
  assert.equal(elements['mem-file-ta'].value, 'unsaved after reopen');
});

test('Graph invalidation reloads on graph-tab return and lifecycle bindings stay idempotent', async () => {
  const elements = Object.assign(editorElements(), {
    'mem-graph-pane': element({ style: { display: 'none' } }),
    'mem-tree-pane': element({ style: { display: '' } }),
    'mem-graph-canvas': element(),
    'mem-graph-svg': element(),
    'mem-graph-project': element({ value: 'all' }),
    'mem-graph-meta': element(),
    'mem-graph-count-pill': element(),
    'nav-memory-count': element(),
    'mem-graph-legend': element(),
    'mem-graph-empty': element(),
  });
  const h = createHarness(async (url) => {
    if (url === '/api/memory/graph') return { nodes: [], edges: [], meta: { projects: [] } };
    return { projects: [], meta: {} };
  }, elements);
  h.runGraph();
  h.runController();
  // Re-evaluating the classic scripts must not duplicate document Escape listeners.
  h.runGraph();
  h.runController();
  await h.document.emit('DOMContentLoaded');
  assert.equal(h.document.listenerCount('keydown'), 2, 'one graph and one editor Escape listener');

  h.window.MultiCCMemoryGraph.invalidate();
  assert.equal(h.window.__memGraphLoaded, false);
  h.window.setMemTab('graph');
  await Promise.resolve();
  assert.equal(h.calls.filter(call => call.url === '/api/memory/graph').length, 1);
  assert.equal(h.window.__memGraphLoaded, true);
  h.window.setMemTab('graph');
  assert.equal(h.calls.filter(call => call.url === '/api/memory/graph').length, 1);
});

test('Failed graph and tree tab loads reset loaded flags so the next visit retries', async () => {
  let graphCalls = 0, treeCalls = 0;
  const elements = Object.assign(editorElements(), {
    'mem-graph-pane': element({ style: { display: 'none' } }),
    'mem-tree-pane': element({ style: { display: '' } }),
    'mem-graph-canvas': element(),
    'mem-graph-svg': element(),
    'mem-graph-project': element({ value: 'all' }),
    'mem-graph-meta': element(),
    'mem-graph-count-pill': element(),
    'nav-memory-count': element(),
    'mem-graph-legend': element(),
    'mem-graph-empty': element(),
    'mem-tree-stats': element(),
  });
  const h = createHarness(async (url) => {
    if (url === '/api/memory/graph') {
      graphCalls++;
      if (graphCalls === 1) throw new Error('graph unavailable');
      return { nodes: [], edges: [], meta: { projects: [] } };
    }
    if (url === '/api/memory/tree') {
      treeCalls++;
      if (treeCalls === 1) throw new Error('tree unavailable');
      return { projects: [], meta: {} };
    }
    return {};
  }, elements);
  h.runGraph();
  h.runController();

  h.window.MultiCCMemoryGraph.invalidate();
  h.window.setMemTab('graph');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.window.__memGraphLoaded, false);
  h.window.setMemTab('tree');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.window.__memTreeLoaded, false);

  h.window.setMemTab('graph');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(graphCalls, 2);
  assert.equal(h.window.__memGraphLoaded, true);
  h.window.setMemTab('tree');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(treeCalls, 2);
  assert.equal(h.window.__memTreeLoaded, true);
});

test('Graph and Tree stale responses cannot overwrite the newest request', async () => {
  const graphFirst = deferred(), graphSecond = deferred();
  const treeFirst = deferred(), treeSecond = deferred();
  let graphCalls = 0, treeCalls = 0;
  const elements = {
    'mem-graph-canvas': element(),
    'mem-graph-svg': element(),
    'mem-graph-project': element({ value: 'all' }),
    'mem-graph-meta': element(),
    'mem-graph-count-pill': element(),
    'nav-memory-count': element(),
    'mem-graph-legend': element(),
    'mem-graph-empty': element(),
    'mem-tree': element(),
    'mem-tree-stats': element(),
  };
  const h = createHarness(async (url) => {
    if (url === '/api/memory/graph') return (++graphCalls === 1 ? graphFirst : graphSecond).promise;
    if (url === '/api/memory/tree') return (++treeCalls === 1 ? treeFirst : treeSecond).promise;
    return {};
  }, elements);
  h.runGraph();
  h.runController();

  const g1 = h.window.loadMemoryGraph(undefined, true);
  const g2 = h.window.loadMemoryGraph(undefined, true);
  graphSecond.resolve({ nodes: [], edges: [], meta: { durationMs: 22, projects: [] } });
  await g2;
  graphFirst.resolve({ nodes: [], edges: [], meta: { durationMs: 11, projects: [] } });
  await g1;
  assert.match(elements['mem-graph-meta'].textContent, /22ms/);
  assert.doesNotMatch(elements['mem-graph-meta'].textContent, /11ms/);

  const t1 = h.window.loadMemoryTree(true);
  const t2 = h.window.loadMemoryTree(true);
  treeSecond.resolve({ projects: [], meta: { projectCount: 22 } });
  await t2;
  treeFirst.resolve({ projects: [], meta: { projectCount: 11 } });
  await t1;
  assert.match(elements['mem-tree-stats'].textContent, /^22 项目/);
});

test('Editor same-path reopen rejects stale data and tolerates missing optional DOM', async () => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const elements = {
    'mem-tree': element(),
    'mem-file-modal': element(),
    'mem-file-title': element(),
    'mem-file-path': element(),
    'mem-file-ta': element(),
    'mem-file-tok': element(),
    'mem-file-msg': element(),
  };
  const h = createHarness(async (url) => {
    if (url.startsWith('/api/memory/file?')) return (++reads === 1 ? first : second).promise;
    return {};
  }, elements);
  h.runController();

  const a = h.window.openMemFileEditor('d/a.md');
  const b = h.window.openMemFileEditor('d/a.md');
  second.resolve({ rel: 'd/a.md', content: 'new', path: '/new' });
  await b;
  first.resolve({ rel: 'd/a.md', content: 'stale', path: '/stale' });
  await a;
  assert.equal(elements['mem-file-ta'].value, 'new');
  assert.equal(elements['mem-file-path'].textContent, '/new');

  delete elements['mem-file-title'];
  await assert.doesNotReject(() => h.window.openMemFileEditor('d/missing-dom.md'));
});

test('Manage loads Memory classic scripts in dependency order and leaves only shell glue', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  const manage = fs.readFileSync(path.join(ROOT, 'public', 'manage.js'), 'utf8');
  const model = fs.readFileSync(path.join(ROOT, 'public', 'memory-model.js'), 'utf8');
  const graph = fs.readFileSync(path.join(ROOT, 'public', 'memory-graph.js'), 'utf8');
  const controller = fs.readFileSync(path.join(ROOT, 'public', 'memory-controller.js'), 'utf8');
  const headEnd = html.indexOf('</head>');
  const scripts = [
    'auth-client.js', 'api-client.js', 'memory-model.js', 'memory-graph.js',
    'memory-controller.js', 'memo-controller.js', 'provider-catalog.js',
  ].map(name => html.indexOf(`<script src="${name}"></script>`));
  assert.ok(scripts.every(index => index > 0 && index < headEnd));
  assert.deepEqual([...scripts].sort((a, b) => a - b), scripts);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+memory-/i);

  for (const source of [model, graph, controller]) {
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /\btokenQS\s*\(/);
  }
  assert.match(model, /MultiCCApi/);
  assert.match(model, /root\.MultiCCMemoryModel = Object\.freeze/);
  assert.match(graph, /root\.MultiCCMemoryGraph = Object\.freeze/);
  assert.match(controller, /root\.MultiCCMemoryController = Object\.freeze/);
  assert.match(graph, /invalidate\(\)\s*\{\s*stopSim\(\)/);
  assert.match(graph, /__multiccMemoryGraphEscapeBound/);
  assert.match(controller, /__multiccMemoryEditorEscapeBound/);
  assert.doesNotMatch(manage, /\/api\/memory\/(?:graph|tree|file)/);
  assert.doesNotMatch(manage, /window\.loadMemoryGraph\s*=/);
  assert.doesNotMatch(manage, /window\.loadMemoryTree\s*=/);
});
