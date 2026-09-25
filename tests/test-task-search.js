'use strict';

// Full-text task search: the pure ranking module (src/task-board/search.js), the
// HTTP surface that exposes it (src/routes/task-search.js), and the browser wiring
// that puts a search box on it (public/task-search.js).
//
// Two invariants matter more than ranking quality and are asserted here directly:
//   1. a query made of real words is never satisfied by a lone CJK character, and
//   2. tombstones (deleted / explicitly merged / mid-delete) are never searchable —
//      an alias must not come back as a second hit for the same work.
// The client's own invariant is the third one: any failure — offline, old server,
// a stale answer — must land back on the caller's local title filter, never on an
// empty panel.

const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../src/task-board/search');
const { createTaskSearchRoutes, MAX_QUERY_CHARS } = require('../src/routes/task-search');
const taskSearchUi = require('../public/task-search.js');

function task(id, overrides = {}) {
  return {
    id,
    title: `任务 ${id}`,
    dirId: 'dir-web',
    status: 'active',
    updatedAt: 1,
    areas: [],
    refs: [],
    ...overrides,
  };
}

function board(tasks, overrides = {}) {
  return {
    revision: 7,
    modules: { web: { id: 'web', name: '前端 UI' } },
    tasks: Object.fromEntries(tasks.map(item => [item.id, item])),
    deletedTaskIds: [],
    ...overrides,
  };
}

test('tokenize keeps latin runs whole and gives CJK both bigrams and characters', () => {
  const terms = search.tokenize('全文检索 air.js');
  for (const bigram of ['全文', '文检', '检索']) assert.ok(terms.has(bigram), bigram);
  assert.equal(terms.get('检'), 0.5, 'a lone CJK character is half-weight evidence');
  assert.ok(terms.has('air.js'), 'latin runs stay one token');
  assert.equal(search.tokenize('AIR.JS').has('air.js'), true, 'latin is case-folded');
  assert.equal(search.tokenize('ＡＩＲ').has('air'), true, 'NFKC folds full-width latin');
});

test('analyzeQuery refuses to let weak single characters satisfy a word query', () => {
  const words = search.analyzeQuery('全文检索');
  assert.deepEqual(words.strong, ['全文', '文检', '检索']);
  assert.ok(words.all.includes('索'), 'characters are still usable for the snippet');
  assert.deepEqual(words.highlight, words.strong, 'highlighting stays on the real words');
  const single = search.analyzeQuery('索');
  assert.deepEqual(single.strong, []);
  assert.deepEqual(single.highlight, ['索'], 'a lone-character query highlights itself');
});

test('a title match outranks a body match, and both come back with a snippet', () => {
  const index = search.buildTaskSearchIndex(board([
    task('tsk-title', { title: '全文检索：任务搜索的排序' }),
    task('tsk-body', {
      title: '缓存层重构',
      description: '把会话缓存的键改成按目录聚合。',
      refs: [{ excerpt: '顺手把全文检索的排序接口接上，标题没命中时也能被找回来。' }],
    }),
  ]));
  const hits = search.searchTaskIndex(index, '全文检索');
  assert.deepEqual(hits.map(hit => hit.taskId), ['tsk-title', 'tsk-body']);
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual(hits[0].matchedFields, ['title']);
  assert.ok(hits[1].matchedFields.includes('body'));
  assert.ok(hits[1].snippet.text.includes('全文检索'));
  assert.ok(hits[0].dirId === 'dir-web' && hits[0].status === 'active');
});

test('snippet ranges point at the matched words inside the returned window', () => {
  const doc = {
    fields: {
      title: '无关标题',
      module: '',
      areas: '',
      body: 'x'.repeat(120) + '全文检索' + 'y'.repeat(120),
    },
  };
  const snippet = search.buildSnippet(doc, search.analyzeQuery('全文检索'));
  assert.ok(snippet.text.includes('全文检索'), 'the window is centred on the hit');
  const [start, end] = snippet.ranges[0];
  assert.equal(snippet.text.slice(start, end), '全文检索', 'ranges are offsets into this window');
  assert.equal(snippet.ranges.length, 1, 'overlapping bigram/character hits merge into one span');
});

test('a word query is not answered by a document holding only one of its characters', () => {
  const hits = search.searchBoard(board([
    task('tsk-word', { title: '检索排序' }),
    task('tsk-char', { title: '索要资源' }),
  ]), '检索');
  assert.deepEqual(hits.map(hit => hit.taskId), ['tsk-word']);
  const chars = search.searchBoard(board([
    task('tsk-word', { title: '检索排序' }),
    task('tsk-char', { title: '索要资源' }),
  ]), '索');
  assert.deepEqual(chars.map(hit => hit.taskId).sort(), ['tsk-char', 'tsk-word'],
    'a single-character query still answers by character');
});

test('tombstones and mid-delete tasks are not searchable', () => {
  const hits = search.searchBoard(board([
    task('tsk-live', { title: '全文检索' }),
    task('tsk-merged', { title: '全文检索', mergedInto: 'tsk-live' }),
    task('tsk-deleting', { title: '全文检索', deleting: true }),
    task('tsk-deleted', { title: '全文检索' }),
  ], { deletedTaskIds: ['tsk-deleted'] }), '全文检索');
  assert.deepEqual(hits.map(hit => hit.taskId), ['tsk-live']);
});

test('filters narrow the corpus by status, directory and explicit id set', () => {
  const fixture = board([
    task('tsk-a', { title: '全文检索', dirId: 'dir-web' }),
    task('tsk-b', { title: '全文检索', dirId: 'dir-api', status: 'archived' }),
  ]);
  assert.deepEqual(search.searchBoard(fixture, '全文检索', { statuses: ['archived'] })
    .map(hit => hit.taskId), ['tsk-b']);
  assert.deepEqual(search.searchBoard(fixture, '全文检索', { dirId: 'dir-api' })
    .map(hit => hit.taskId), ['tsk-b']);
  assert.deepEqual(search.searchBoard(fixture, '全文检索', { dirIds: ['dir-web'] })
    .map(hit => hit.taskId), ['tsk-a']);
  assert.deepEqual(search.searchBoard(fixture, '全文检索', {
    taskIds: ['tsk-a', 'tsk-b'], excludeTaskIds: ['tsk-a'],
  }).map(hit => hit.taskId), ['tsk-b']);
  assert.deepEqual(search.searchBoard(fixture, '全文检索', { taskIds: ['tsk-nope'] }), []);
});

test('the returned index is a snapshot: it does not mutate the board', () => {
  const fixture = board([task('tsk-a', { title: '全文检索' })]);
  const before = JSON.stringify(fixture);
  const index = search.buildTaskSearchIndex(fixture);
  search.searchTaskIndex(index, '全文检索');
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(index.docCount, 1);
  assert.equal(index.revision, 7);
  assert.equal(index.fieldsFor('tsk-a').title, '全文检索');
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('the task-board search route registers GET and answers with ranked hits', () => {
  const mounted = [];
  const routes = createTaskSearchRoutes({
    getBoard: () => board([
      task('tsk-a', { title: '全文检索：任务搜索', updatedAt: 9 }),
      task('tsk-b', { title: '全文检索：任务关联', updatedAt: 5 }),
    ]),
  });
  routes.mountRoutes({ get: (path, handler) => mounted.push([path, handler]) });
  assert.deepEqual(mounted.map(([path]) => path), ['/api/task-board/search', '/api/search/messages']);

  const res = fakeRes();
  mounted[0][1]({ query: { q: '全文检索', limit: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.query, '全文检索');
  assert.equal(res.body.count, 1, 'limit is honoured');
  assert.deepEqual(res.body.results.map(hit => hit.taskId), ['tsk-a']);
  assert.ok(res.body.results[0].snippet.text.includes('全文检索'));
});

test('the search route fails closed on an empty, oversized or unavailable board', () => {
  const routes = createTaskSearchRoutes({ getBoard: () => board([task('tsk-a', { title: '全文检索' })]) });
  const empty = fakeRes();
  routes.handleSearch({ query: { q: '   ' } }, empty);
  assert.deepEqual(empty.body, { ok: true, query: '', count: 0, results: [] });
  assert.equal(empty.statusCode, 200, 'an empty query is not an error');

  const long = fakeRes();
  routes.handleSearch({ query: { q: 'x'.repeat(MAX_QUERY_CHARS + 1) } }, long);
  assert.equal(long.statusCode, 400);
  assert.equal(long.body.error, 'query_too_long');

  const broken = fakeRes();
  createTaskSearchRoutes({ getBoard: () => { throw new Error('board offline'); }, logger: { warn() {} } })
    .handleSearch({ query: { q: '全文检索' } }, broken);
  assert.equal(broken.statusCode, 503);
  assert.equal(broken.body.error, 'task_board_unavailable');

  const missing = fakeRes();
  createTaskSearchRoutes({ getBoard: () => null }).handleSearch({ query: { q: '全文检索' } }, missing);
  assert.equal(missing.statusCode, 503);
  assert.deepEqual(missing.body, { error: 'task_board_unavailable' });
});

test('the route clamps limit and parses the csv filters it forwards', () => {
  const routes = createTaskSearchRoutes({
    getBoard: () => board([
      task('tsk-a', { title: '全文检索', dirId: 'dir-web' }),
      task('tsk-b', { title: '全文检索', dirId: 'dir-api', status: 'archived' }),
    ]),
  });
  const capped = fakeRes();
  routes.handleSearch({ query: { q: '全文检索', limit: '999' } }, capped);
  assert.equal(capped.statusCode, 200);
  assert.equal(capped.body.count, 2, 'an oversized limit is clamped, not rejected');

  const byStatus = fakeRes();
  routes.handleSearch({ query: { q: '全文检索', statuses: 'archived' } }, byStatus);
  assert.deepEqual(byStatus.body.results.map(hit => hit.taskId), ['tsk-b']);
  const byDir = fakeRes();
  routes.handleSearch({ query: { q: '全文检索', dirIds: 'dir-web, dir-api' } }, byDir);
  assert.deepEqual(byDir.body.results.map(hit => hit.taskId).sort(), ['tsk-a', 'tsk-b'],
    'a comma list with a space is still two ids');

  assert.throws(() => createTaskSearchRoutes({}), /getBoard/);
  assert.throws(() => routes.mountRoutes({}), /Express app\.get/);
});

// ── 消息级检索（GET /api/search/messages）────────────────────────────────────
// 结果的主键是 *会话* 而不是任务：任务身份由调用方按自己的任务板解析，这条路由
// 只回答「哪些对话正文命中了」。所以这里守的是它的契约：命中形状与任务板一致
// （同一套 snippet 结构）、查询过滤器按调用方的词表达、索引不可用/未接线时明确
// 报 503 而不是静默返回空数组（空数组会被客户端当成「没有命中」缓存下来）。

function fakeMessages(hits, { warming = false, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    findMessages(options) {
      calls.push(options);
      if (throws) throw new Error('index closed');
      return hits;
    },
    status: () => ({ warming }),
  };
}

test('the message search route returns session-level hits with the board snippet shape', () => {
  const port = fakeMessages([{
    sessionId: 'sess-1', messageId: 'm-3', kind: 'user', updatedAt: 42, score: 1.5,
    text: '完整正文', snippet: { text: '命中窗口', ranges: [[0, 2]] },
  }]);
  const routes = createTaskSearchRoutes({ getBoard: () => board([]), messages: port });
  const res = fakeRes();
  routes.handleMessageSearch({ query: { q: '全文检索', limit: '3' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.warming, false);
  assert.deepEqual(res.body.results, [{
    sessionId: 'sess-1', messageId: 'm-3', kind: 'user', updatedAt: 42, score: 1.5,
    taskIds: [],
    snippet: { text: '命中窗口', ranges: [[0, 2]] },
  }]);
  // 正文整块不回传：客户端渲染的是服务端算好的窗口 + 高亮区间。
  assert.equal('text' in res.body.results[0], false);
  assert.deepEqual(port.calls[0], { text: '全文检索', limit: 3 });
});

// 命中是 *会话*，而搜索框摆的是任务行。会话 → 任务的映射只有任务板知道
// （refs[].sessionId；客户端手里的池子根本没有 refs 字段），所以由这条路由补上，
// 否则这些命中在界面上无处可放。
test('the message search route resolves each session to the tasks it belongs to', () => {
  const port = fakeMessages([
    { sessionId: 'sess-1', messageId: 'm-1', kind: 'user', snippet: { text: 'a', ranges: [] } },
    { sessionId: 'sess-2', messageId: 'm-2', kind: 'user', snippet: { text: 'b', ranges: [] } },
    { sessionId: 'sess-orphan', messageId: 'm-3', kind: 'user', snippet: { text: 'c', ranges: [] } },
  ]);
  const routes = createTaskSearchRoutes({
    messages: port,
    getBoard: () => board([
      task('tsk-a', { refs: [{ sessionId: 'sess-1' }] }),
      // 一个会话被两个任务引用（续作/分叉）：两个 id 都留着，由客户端挑池子里有的那个。
      task('tsk-b', { refs: [{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }] }),
      // 没有 sessionId 的 ref、以及没有 refs 的任务都不参与映射。
      task('tsk-c', { refs: [{ sessionId: '  ' }, {}] }),
    ]),
  });
  const res = fakeRes();
  routes.handleMessageSearch({ query: { q: '缓存' } }, res);
  assert.deepEqual(res.body.results.map(hit => hit.taskIds), [
    ['tsk-a', 'tsk-b'], ['tsk-b'], [],
  ], '不属于任何任务的对话命中留空数组，不编造任务');
});

test('the message route still answers when the board cannot be read', () => {
  const warnings = [];
  const routes = createTaskSearchRoutes({
    messages: fakeMessages([{ sessionId: 'sess-1', messageId: 'm-1', kind: 'user', snippet: { text: 'a', ranges: [] } }]),
    getBoard: () => { throw new Error('board file is gone'); },
    logger: { warn: message => warnings.push(message) },
  });
  const res = fakeRes();
  routes.handleMessageSearch({ query: { q: '缓存' } }, res);
  assert.equal(res.statusCode, 200, '拿不到任务板只损失 taskIds，不该让整条答案变成 503');
  assert.deepEqual(res.body.results[0].taskIds, []);
  assert.deepEqual(warnings, ['message_search_board_failed: board file is gone']);
});

test('the message search route forwards role/session filters and reports a warming index', () => {
  const port = fakeMessages([], { warming: true });
  const routes = createTaskSearchRoutes({ getBoard: () => board([]), messages: port });
  const res = fakeRes();
  routes.handleMessageSearch({ query: { q: '缓存', role: 'user', session: 'a, b' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.warming, true, '部分结果必须能自证「还在预热」');
  assert.deepEqual(port.calls[0], { text: '缓存', limit: 20, kinds: ['user'], refIds: ['a', 'b'] });

  const empty = fakeRes();
  routes.handleMessageSearch({ query: {} }, empty);
  assert.deepEqual(empty.body, { ok: true, query: '', count: 0, results: [], warming: true });
  assert.equal(port.calls.length, 1, '空查询不打扰索引');

  const long = fakeRes();
  routes.handleMessageSearch({ query: { q: 'x'.repeat(MAX_QUERY_CHARS + 1) } }, long);
  assert.equal(long.statusCode, 400);
  assert.equal(long.body.error, 'query_too_long');
});

test('the message search route fails closed when the index is missing, unwired or throwing', () => {
  const unwired = fakeRes();
  createTaskSearchRoutes({ getBoard: () => board([]) }).handleMessageSearch({ query: { q: '检索' } }, unwired);
  assert.equal(unwired.statusCode, 503);
  assert.deepEqual(unwired.body, { error: 'message_search_unavailable' });

  // 惰性取用：port 可以是一个每请求现算的函数（server.js 就是这样接的）。
  const lazy = fakeRes();
  createTaskSearchRoutes({ getBoard: () => board([]), messages: () => null })
    .handleMessageSearch({ query: { q: '检索' } }, lazy);
  assert.equal(lazy.statusCode, 503);

  const throwing = fakeRes();
  createTaskSearchRoutes({
    getBoard: () => board([]), messages: fakeMessages([], { throws: true }), logger: { warn() {} },
  }).handleMessageSearch({ query: { q: '检索' } }, throwing);
  assert.equal(throwing.statusCode, 503);
  assert.deepEqual(throwing.body, { error: 'message_search_unavailable' });

  // 取用 port 本身也可能失败（它要打开索引）：同样是「暂时不可用」，不能升级成 500。
  const unopenable = fakeRes();
  createTaskSearchRoutes({
    getBoard: () => board([]), messages: () => { throw new Error('cannot open index'); }, logger: { warn() {} },
  }).handleMessageSearch({ query: { q: '检索' } }, unopenable);
  assert.equal(unopenable.statusCode, 503);
  assert.deepEqual(unopenable.body, { error: 'message_search_unavailable' });
});

// ── 浏览器侧：搜索框的接线 ──────────────────────────────────────────────────
// public/task-search.js 只做三件事（防抖+缓存、作废过期结果、渲染命中片段的
// DOM）。这里守的是它的失败形态：任何一次请求失败都必须回到「调用方自己的本地
// 过滤」，面板不能因为搜索接口不在而空掉。

function fakeInput(value = '') {
  const handlers = new Map();
  return {
    value,
    listeners: handlers,
    addEventListener(type, handler) { handlers.set(type, handler); },
    removeEventListener(type) { handlers.delete(type); },
    type(text) { this.value = text; handlers.get('input')?.(); },
  };
}

const tick = (ms = 8) => new Promise(resolve => setTimeout(resolve, ms));

test('the search box builds the query path and maps hits back onto the pool', () => {
  assert.equal(taskSearchUi.searchPath('全文检索'), '/api/task-board/search?q=%E5%85%A8%E6%96%87%E6%A3%80%E7%B4%A2&limit=20');
  assert.equal(taskSearchUi.searchPath('air', { dirId: 'dir-web', statuses: ['active'] }, 5),
    '/api/task-board/search?q=air&limit=5&dirId=dir-web&statuses=active');
  const pool = [{ id: 'tsk-a', title: 'A' }, { id: 'tsk-b', title: 'B' }];
  const ranked = taskSearchUi.rankedTasks({
    hits: [{ taskId: 'tsk-b', snippet: { text: 'B' } }, { taskId: 'tsk-gone' }, { taskId: 'tsk-a' }],
  }, pool);
  assert.deepEqual(ranked.map(({ task }) => task.id), ['tsk-b', 'tsk-a'],
    'server order is kept and ids missing from the pool are skipped');
  assert.equal(taskSearchUi.rankedTasks({ hits: [] }, pool), null);
  assert.equal(taskSearchUi.rankedTasks(null, pool), null, 'no results means "use the local filter"');
});

test('the search box caches hits, drops stale answers and degrades to local filtering', async () => {
  const input = fakeInput();
  const requested = [];
  const deferred = [];
  let fail = false;
  const control = taskSearchUi.attach(input, {
    delay: 1,
    request: path => {
      requested.push(path);
      if (fail) return Promise.reject(new Error('offline'));
      return new Promise(resolve => deferred.push(resolve));
    },
  });
  assert.equal(control.results(), null, 'an empty box is not a query');

  input.type('全文检索');
  await tick();
  assert.equal(requested.length, 1);
  assert.match(requested[0], /q=%E5%85%A8%E6%96%87%E6%A3%80%E7%B4%A2/);
  assert.equal(control.results(), null, 'nothing is claimed before the answer arrives');
  deferred.shift()({ results: [{ taskId: 'tsk-a' }] });
  await tick();
  assert.deepEqual(control.results(), { query: '全文检索', hits: [{ taskId: 'tsk-a' }], messageHits: [] });

  // 退格回到刚搜过的词：走缓存，立刻生效，不再打一次接口。
  input.type('全');
  await tick();
  input.type('全文检索');
  assert.equal(requested.length, 2, 'only the new query is requested, and its timer is dropped');
  assert.deepEqual(control.results()?.hits, [{ taskId: 'tsk-a' }]);

  // 输入变了以后再回来的答案只进缓存，不驱动重画。
  input.type('检索');
  await tick();
  const late = deferred.pop();
  input.type('排序');
  await tick();
  late({ results: [{ taskId: 'tsk-late' }] });
  await tick();
  assert.equal(control.results(), null, 'the late answer belongs to the old query');
  input.type('检索');
  assert.deepEqual(control.results()?.hits, [{ taskId: 'tsk-late' }], 'and it is still cached');

  fail = true;
  input.type('离线');
  await tick(20);
  assert.equal(control.results(), null, 'a failed request falls back to the local filter');
  const beforeDestroy = requested.length;
  control.destroy();
  input.type('全文检索');
  await tick();
  assert.equal(requested.length, beforeDestroy, 'a destroyed control stops listening');
});

// ── 浏览器侧：两条语料合流 ─────────────────────────────────────────────────
// 「只出现在对话里的词」唯一的召回路径是 /api/search/messages（任务板一条摘录只有
// 一句话）。这里守的是合流的两条规矩：① 两条语料各自失败只影响自己那一半；② 会话
// 命中要落回任务行（一个会话可能挂在多个任务上，池子里找不到就跳过）。

const pool = (...ids) => ids.map(id => ({ id, title: id }));

test('the search box asks the conversation index only when the scope says so', async () => {
  assert.equal(taskSearchUi.messagePath('全文检索'), '/api/search/messages?q=%E5%85%A8%E6%96%87%E6%A3%80%E7%B4%A2&limit=20');
  assert.equal(taskSearchUi.messagePath('air', { limit: 5 }), '/api/search/messages?q=air&limit=5');

  const paths = [];
  const input = fakeInput();
  let full = false;
  const control = taskSearchUi.attach(input, {
    delay: 1, fullText: () => full,
    request: path => { paths.push(path); return Promise.resolve({ results: [] }); },
  });
  input.type('全文检索');
  await tick();
  assert.deepEqual(paths, ['/api/task-board/search?q=%E5%85%A8%E6%96%87%E6%A3%80%E7%B4%A2&limit=20'],
    'scope=board 时不打会话索引');

  paths.length = 0;
  full = true;
  input.type('缓存');
  await tick();
  assert.deepEqual(paths.sort(), [
    '/api/search/messages?q=%E7%BC%93%E5%AD%98&limit=20',
    '/api/task-board/search?q=%E7%BC%93%E5%AD%98&limit=20',
  ], 'scope=full 时两条语料并行');
  // 两条都答了「没有命中」：这不是「搜索不可用」，调用方拿到空结果自然回落到本地
  // 过滤（rankedHits 为空），缓存里也留着这个词 —— 退格回来不必重打接口。
  assert.deepEqual(control.results(), { query: '缓存', hits: [], messageHits: [] });
  assert.equal(taskSearchUi.rankedHits(control.results(), pool('tsk-a')).length, 0);
  const before = paths.length;
  input.type('全');
  await tick();
  assert.equal(paths.length, before + 2, 'a different word asks both corpora');
  input.type('缓存');
  assert.equal(paths.length, before + 2, '退格回到刚搜过的词：走缓存，不再打接口');
  assert.equal(control.results()?.query, '缓存');
});

test('each corpus fails on its own: half an answer beats an empty panel', async () => {
  const input = fakeInput();
  let failBoard = false;
  let failMessages = false;
  const control = taskSearchUi.attach(input, {
    delay: 1, fullText: () => true,
    request: path => {
      const isBoard = path.startsWith('/api/task-board/');
      if (isBoard ? failBoard : failMessages) return Promise.reject(new Error('offline'));
      return Promise.resolve({ results: isBoard ? [{ taskId: 'tsk-a' }] : [{ sessionId: 'sess-1', taskIds: ['tsk-b'] }] });
    },
  });

  failMessages = true;
  input.type('缓存');
  await tick();
  assert.deepEqual(control.results(), { query: '缓存', hits: [{ taskId: 'tsk-a' }], messageHits: [] },
    '会话索引不可用时，任务板命中照旧');

  failMessages = false;
  failBoard = true;
  input.type('检索');
  await tick();
  assert.deepEqual(control.results(), { query: '检索', hits: [], messageHits: [{ sessionId: 'sess-1', taskIds: ['tsk-b'] }] },
    '任务板不可用时仍是「有全文结果」，由会话命中提供');

  failBoard = false;
  input.type('排序');
  await tick();
  assert.deepEqual(control.results()?.hits, [{ taskId: 'tsk-a' }]);
  assert.equal(control.results()?.messageHits.length, 1);

  // 两条都挂：回到调用方自己的本地过滤，而不是一个空面板。
  failBoard = true;
  failMessages = true;
  input.type('离线');
  await tick(20);
  assert.equal(control.results(), null);
});

test('board hits come first and conversation hits fill in behind them', () => {
  const full = taskSearchUi.rankedHits({
    hits: [{ taskId: 'tsk-a', snippet: { text: '板' } }],
    messageHits: [
      { sessionId: 'sess-1', taskIds: ['tsk-b', 'tsk-a'], snippet: { text: '对话 b' } },
      { sessionId: 'sess-2', taskIds: ['tsk-gone'], snippet: { text: '已删任务' } },
      { sessionId: 'sess-3', taskIds: [], snippet: { text: '不属于任何任务的对话' } },
    ],
  }, pool('tsk-a', 'tsk-b'));
  assert.deepEqual(full.map(row => [row.task.id, row.source || 'board']), [
    ['tsk-a', 'board'], ['tsk-b', 'message'],
  ], '任务板命中在前；会话命中里已被板子命中的任务不重复出现');
  assert.equal(full[1].hit.snippet.text, '对话 b');

  // 一个会话挂在多个任务上：取池子里第一个找得到的（服务端的 refs 顺序）。
  const shared = taskSearchUi.rankedMessageTasks(
    { messageHits: [{ sessionId: 'sess-1', taskIds: ['tsk-x', 'tsk-b'], snippet: { text: '共享' } }] }, pool('tsk-b'));
  assert.deepEqual(shared.map(row => row.task.id), ['tsk-b']);
  assert.equal(taskSearchUi.rankedMessageTasks({ messageHits: [] }, pool('tsk-b')).length, 0);
  assert.equal(taskSearchUi.rankedMessageTasks(null, pool('tsk-b')).length, 0);
  assert.equal(taskSearchUi.rankedHits({ hits: [], messageHits: [] }, pool('tsk-a')).length, 0,
    '两条语料都空 = 回到本地过滤（调用方看 rankedHits 为空就自己筛）');
});

test('snippet nodes are built from text nodes, never from HTML', () => {
  const created = [];
  global.document = {
    createElement(tag) {
      const node = { tagName: tag, className: '', textContent: '', children: [], append(...items) { this.children.push(...items); } };
      created.push(node);
      return node;
    },
  };
  try {
    const node = taskSearchUi.snippetNode({ text: '全文检索的排序', ranges: [[0, 4]] });
    assert.equal(node.tagName, 'small');
    assert.equal(node.className, 'task-note task-snippet');
    const [mark, rest] = node.children;
    assert.equal(mark.tagName, 'mark');
    assert.equal(mark.textContent, '全文检索');
    assert.equal(rest, '的排序', 'the rest of the window stays a plain text node');
    assert.equal(taskSearchUi.snippetNode({ text: '' }), null, 'no hit text means no node');
    assert.equal(taskSearchUi.snippetNode(null), null);
  } finally {
    delete global.document;
  }
});
