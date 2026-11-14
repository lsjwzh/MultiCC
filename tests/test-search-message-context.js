'use strict';

// What a retrieved message chunk must carry to be usable as *context*, not just as
// a hit: the message's own time (not the file's mtime), its task and directory, a
// scope filter that narrows in SQL, and a result order that one long conversation
// cannot monopolise.
//
// The last test is the end-to-end proof: it builds a temporary corpus, indexes it,
// and prints the session distribution of the same query before and after the
// diversity pass (the raw SQL order vs `findMessages`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MESSAGE_SCOPE, messageTaskId, messageTime, sessionChunkRows,
} = require('../src/search/message-corpus');
const { createSearchIndex, SCHEMA_VERSION } = require('../src/search/index-store');
const { createSearchRuntime } = require('../src/search/runtime');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');
const { createTaskSearchRoutes } = require('../src/routes/task-search');
const { databaseConstructor } = require('../src/sqlite/driver');

const logger = { warn() {}, log() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-message-context-'));
}

function memIndex() {
  return createSearchIndex({ dbFile: ':memory:', logger });
}

function row(refId, ord, text, extra = {}) {
  return { scope: MESSAGE_SCOPE, refId, ord, kind: 'assistant', text, updatedAt: 1000, ...extra };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// ── the message's own time and task ─────────────────────────────────────────

test('a message time is read from ts as a number or an ISO string', () => {
  assert.equal(messageTime({ ts: 1704153600000 }), 1704153600000);
  assert.equal(messageTime({ ts: 1704153600000.9 }), 1704153600000);
  assert.equal(messageTime({ ts: '2024-01-02T00:00:00.000Z' }), 1704153600000);
  assert.equal(messageTime({ ts: '2024-01-02T00:00:00Z' }), 1704153600000);
  // Unusable values fall back to 0, which the corpus turns into the file mtime.
  assert.equal(messageTime({ ts: 'not a date' }), 0);
  assert.equal(messageTime({ ts: 0 }), 0);
  assert.equal(messageTime({ ts: -5 }), 0);
  assert.equal(messageTime({ ts: null }), 0);
  assert.equal(messageTime({}), 0);
  assert.equal(messageTime(null), 0);
});

test('a task id is carried as a string, or empty when absent', () => {
  assert.equal(messageTaskId({ taskId: 'task-1' }), 'task-1');
  assert.equal(messageTaskId({}), '');
  assert.equal(messageTaskId({ taskId: null }), '');
  assert.equal(messageTaskId(null), '');
});

test('every chunk carries its own message ts, task id and directory', () => {
  const messages = [
    { id: 'm1', role: 'user', content: '第一条消息，讲的是全文检索。', ts: 1000, taskId: 'task-a' },
    { id: 'm2', role: 'assistant', content: '第二条消息，讲的是缓存层。', ts: '1970-01-01T00:00:02.500Z', taskId: 'task-a' },
    { id: 'm3', role: 'user', content: '第三条没有时间戳的消息，只能用文件时间。' },
  ];
  const { rows } = sessionChunkRows('s1', messages, { updatedAt: 999_999, dirId: 'dir-x' });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.updatedAt), [1000, 2500, 999_999]);
  assert.deepEqual(rows.map(r => r.taskId), ['task-a', 'task-a', '']);
  assert.deepEqual(rows.map(r => r.dirId), ['dir-x', 'dir-x', 'dir-x']);
  // The file mtime is kept separately: it is the sync's freshness signal, not a
  // message property, so a message with a ts does not overwrite it.
  assert.deepEqual(rows.map(r => r.sourceMtime), [999_999, 999_999, 999_999]);
});

test('a chunk never spans two messages, so the attribution is unambiguous', () => {
  // Each message is 500 characters: chunkText(400/60) yields two chunks per message,
  // and both chunks of message 2 must carry message 2's ts and task, not message 1's.
  const long = (mark) => mark.repeat(500);
  const messages = [
    { id: 'm1', role: 'user', content: long('一'), ts: 111, taskId: 'task-1' },
    { id: 'm2', role: 'assistant', content: long('二'), ts: 222, taskId: 'task-2' },
  ];
  const { rows } = sessionChunkRows('s1', messages, { updatedAt: 1, dirId: 'd' });
  assert.equal(rows.length, 4);
  for (const chunk of rows) {
    const expected = chunk.itemId === 'm1' ? 111 : 222;
    const task = chunk.itemId === 'm1' ? 'task-1' : 'task-2';
    assert.equal(chunk.updatedAt, expected, `chunk of ${chunk.itemId}`);
    assert.equal(chunk.taskId, task, `chunk of ${chunk.itemId}`);
  }
});

// ── the store: new columns, filters, schema version ─────────────────────────

test('task and directory filters narrow in SQL and round-trip on the hit', () => {
  const index = memIndex();
  index.upsert([
    row('s1', 0, '共同的词，属于任务一和目录甲。', { taskId: 'task-1', dirId: 'dir-a' }),
    row('s2', 0, '共同的词，属于任务二和目录甲。', { taskId: 'task-2', dirId: 'dir-a' }),
    row('s3', 0, '共同的词，属于任务一和目录乙。', { taskId: 'task-1', dirId: 'dir-b' }),
  ]);
  const hits = (options) => index.search({ text: '共同的词', scope: MESSAGE_SCOPE, ...options }).results;
  assert.equal(hits({}).length, 3);
  assert.deepEqual(hits({ taskId: 'task-1' }).map(hit => hit.refId).sort(), ['s1', 's3']);
  assert.deepEqual(hits({ dirId: 'dir-a' }).map(hit => hit.refId).sort(), ['s1', 's2']);
  assert.deepEqual(hits({ dirId: 'dir-a', taskId: 'task-1' }).map(hit => hit.refId), ['s1']);
  const [hit] = hits({ taskId: 'task-2' });
  assert.equal(hit.taskId, 'task-2');
  assert.equal(hit.dirId, 'dir-a');
  assert.ok(hit.contentHash, 'the content hash reaches the caller so it can be deduped');
  index.close();
});

test('the LIKE path honours the same scope filters', () => {
  const index = memIndex();
  index.upsert([
    row('s1', 0, '这个块里出现了缓这个字。', { taskId: 'task-1', dirId: 'dir-a' }),
    row('s2', 0, '这个块里也有缓这个字。', { taskId: 'task-2', dirId: 'dir-b' }),
  ]);
  const scoped = index.search({ text: '缓', scope: MESSAGE_SCOPE, taskId: 'task-1' });
  assert.equal(scoped.mode, 'like');
  assert.deepEqual(scoped.results.map(hit => hit.refId), ['s1']);
  index.close();
});

test('task attribution written after the text still lands in the index', () => {
  // annotateTurn rewrites a finished message with its task id but the content string
  // is unchanged, so the content hash matches. The row must still pick up the task.
  const index = memIndex();
  const text = '这一轮已经写完，标注之前没有任务归属。';
  index.upsert([row('s1', 0, text, { taskId: '' })]);
  assert.equal(index.search({ text: '标注之前', scope: MESSAGE_SCOPE, taskId: 'task-9' }).results.length, 0);
  const written = index.upsert([row('s1', 0, text, { taskId: 'task-9', dirId: 'dir-a' })]);
  assert.deepEqual(written, { inserted: 0, updated: 1, skipped: 0 });
  assert.equal(index.search({ text: '标注之前', scope: MESSAGE_SCOPE, taskId: 'task-9' }).results.length, 1);
  // And an unchanged row is still skipped, so the sync counters keep their meaning.
  assert.deepEqual(index.upsert([row('s1', 0, text, { taskId: 'task-9', dirId: 'dir-a' })]),
    { inserted: 0, updated: 0, skipped: 1 });
  index.close();
});

test('a v1 index is rebuilt rather than read with the wrong columns', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'search-index.sqlite');
  try {
    const first = createSearchIndex({ dbFile, logger });
    first.upsert([row('s1', 0, '旧版本写进去的内容，升级之后必须重建。')]);
    first.close();

    // Pretend the file says it is the previous schema: same tokenizer, older version.
    const Database = databaseConstructor();
    const raw = new Database(dbFile);
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.close();

    const second = createSearchIndex({ dbFile, logger });
    assert.equal(second.available, true);
    assert.deepEqual(second.stats().scopes, [], 'an older schema is dropped, not migrated');
    second.upsert([row('s1', 0, '新版本写进去的内容，任务列存在。', { taskId: 'task-new' })]);
    assert.equal(second.search({ text: '任务列', scope: MESSAGE_SCOPE, taskId: 'task-new' }).results.length, 1);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the corpus resolves the directory from the host ─────────────────────────

function corpusFixture({ sessions, dirs = {}, messages }) {
  const dir = tempDir();
  const history = createChatHistoryFileRepository({ dataDir: dir });
  for (const [sessionId, list] of Object.entries(sessions)) history.write(sessionId, list);
  const index = createSearchIndex({ dbFile: path.join(dir, 'search-index.sqlite'), logger });
  const dirMap = { ...dirs };
  const corpus = createMessageCorpusFor(index, history, dirMap);
  return {
    dir,
    history,
    index,
    dirMap,
    corpus,
    cleanup: () => { index.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function createMessageCorpusFor(index, history, dirMap) {
  const { createMessageCorpus } = require('../src/search/message-corpus');
  return createMessageCorpus({
    index, history, logger,
    resolveDirId: sessionId => dirMap[sessionId] || '',
  });
}

test('the corpus stamps the directory the host resolves and follows a relocate', () => {
  const fixture = corpusFixture({
    sessions: {
      s1: [{ id: 'm1', role: 'user', content: '这一段属于目录甲，讲的是缓存层。', ts: 5000 }],
      s2: [{ id: 'm2', role: 'user', content: '这一段也属于目录甲，讲的是排序。', ts: 5001 }],
    },
    dirs: { s1: 'dir-a', s2: 'dir-a' },
  });
  try {
    fixture.corpus.syncAll();
    assert.equal(fixture.corpus.search({ text: '缓存层', dirId: 'dir-a' }).results.length, 1);
    assert.equal(fixture.corpus.search({ text: '排序', dirId: 'dir-b' }).results.length, 0);

    // The session moves to another directory; the transcript does not change, so
    // the next pass skips the file but must still correct the column.
    fixture.dirMap.s1 = 'dir-b';
    const moved = fixture.corpus.syncSession('s1');
    assert.equal(moved.sessionSkipped, true, 'the file itself did not change');
    assert.equal(fixture.corpus.search({ text: '缓存层', dirId: 'dir-b' }).results.length, 1);
    assert.equal(fixture.corpus.search({ text: '缓存层', dirId: 'dir-a' }).results.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('an unknown directory never clears a value the index already has', () => {
  const fixture = corpusFixture({
    sessions: { s1: [{ id: 'm1', role: 'user', content: '这一段有目录，讲的是全文检索。', ts: 7000 }] },
    dirs: { s1: 'dir-a' },
  });
  try {
    fixture.corpus.syncAll();
    delete fixture.dirMap.s1;
    fixture.corpus.syncAll({ force: true });
    assert.equal(fixture.corpus.search({ text: '全文检索', dirId: 'dir-a' }).results.length, 1,
      'a lookup that answers nothing is unknown, not "no directory"');
  } finally {
    fixture.cleanup();
  }
});

// ── the HTTP route ─────────────────────────────────────────────────────────

test('the message route forwards dirId and taskId without changing its shape', () => {
  const calls = [];
  const port = {
    findMessages(options) {
      calls.push(options);
      return [{
        sessionId: 'sess-1', messageId: 'm-1', kind: 'user', updatedAt: 42, score: 1.5,
        taskId: 'task-1', dirId: 'dir-a', contentHash: 'h',
        text: '完整正文', snippet: { text: '命中窗口', ranges: [[0, 2]] },
      }];
    },
    status: () => ({ warming: false }),
  };
  const routes = createTaskSearchRoutes({ getBoard: () => ({ tasks: {} }), messages: port });
  const res = fakeRes();
  routes.handleMessageSearch({ query: { q: '全文检索', dirId: ' dir-a ', taskId: 'task-1' } }, res);
  assert.deepEqual(calls[0], { text: '全文检索', limit: 20, dirId: 'dir-a', taskId: 'task-1' });
  assert.deepEqual(res.body.results, [{
    sessionId: 'sess-1', messageId: 'm-1', kind: 'user', updatedAt: 42, score: 1.5,
    taskIds: [], snippet: { text: '命中窗口', ranges: [[0, 2]] },
  }], 'the response contract is untouched (no dirId/taskId/contentHash leak)');

  // No filter means no option, exactly as before this change.
  const plain = fakeRes();
  routes.handleMessageSearch({ query: { q: '全文检索' } }, plain);
  assert.deepEqual(calls[1], { text: '全文检索', limit: 20 });

  const long = fakeRes();
  routes.handleMessageSearch({ query: { q: '全文检索', dirId: 'x'.repeat(201) } }, long);
  assert.equal(long.statusCode, 400);
  assert.equal(long.body.error, 'filter_too_long');
});

// ── end-to-end proof: a real corpus, before and after ──────────────────────

function distribution(hits) {
  const counts = new Map();
  for (const hit of hits) counts.set(hit.sessionId, (counts.get(hit.sessionId) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

function show(hits) {
  return distribution(hits).map(([id, n]) => `${id}:${n}`).join(' ');
}

test('end-to-end: message time, scope filters and session diversity on a temp corpus', () => {
  const dir = tempDir();
  const history = createChatHistoryFileRepository({ dataDir: dir });
  // The measured shape of the defect: one conversation whose chunks are short and
  // dense around the query (so bm25 ranks them all at the top) holds 13 of the 20
  // hits, while the seven other conversations each contribute one long chunk.
  // Chunk text differs per message so the corpus's within-session hash dedupe keeps
  // them all.
  const padding = '这一段是无关的铺垫文字，用来说明上下文的长度和主题都不相同。'.repeat(8);
  const loud = Array.from({ length: 13 }, (_, i) => ({
    id: `loud-${i}`,
    role: i % 2 ? 'assistant' : 'user',
    content: `全文检索全文检索。编号 ${i + 1} 的短消息。`,
    ts: 1_700_000_000_000 + 10_000 + i,
    taskId: 'task-loud',
  }));
  const quiet = Array.from({ length: 7 }, (_, i) => ({
    id: `quiet-${i}`,
    role: 'user',
    content: `${padding}最后才提到全文检索，前面的内容与主题无关。编号 ${i + 1}。`,
    ts: 1_600_000_000_000 + i,
    taskId: `task-quiet-${i}`,
  }));
  history.write('loud', loud);
  quiet.forEach((message, i) => history.write(`quiet-${i}`, [message]));

  const dirMap = { loud: 'dir-loud' };
  quiet.forEach((_, i) => { dirMap[`quiet-${i}`] = i % 2 ? 'dir-odd' : 'dir-even'; });

  const runtime = createSearchRuntime({
    dataDir: dir, logger, intervalMs: 0, quietMs: 0,
    resolveDirId: sessionId => dirMap[sessionId] || '',
  });
  try {
    runtime.sweep();
    const fileMtime = Math.floor(fs.statSync(history.fileFor('loud')).mtimeMs);

    // 1. updated_at is the message time, not the file mtime.
    const newest = runtime.search({ text: '全文检索', limit: 50 }).results
      .filter(hit => hit.refId === 'loud')
      .map(hit => hit.updatedAt);
    assert.equal(Math.max(...newest), 1_700_000_000_000 + 10_012);
    assert.ok(Math.max(...newest) !== fileMtime, 'the message time differs from the file mtime');

    // 2. dirId and taskId narrow the query.
    assert.equal(runtime.findMessages({ text: '全文检索', dirId: 'dir-odd' }).length, 3);
    const byTask = runtime.findMessages({ text: '全文检索', taskId: 'task-loud', limit: 3 });
    assert.equal(byTask.length, 3);
    assert.ok(byTask.every(hit => hit.sessionId === 'loud'), 'the task filter excludes every other chunk');
    const quietTask = runtime.findMessages({ text: '全文检索', taskId: 'task-quiet-2' });
    assert.deepEqual(quietTask.map(hit => hit.sessionId), ['quiet-2']);
    assert.ok(runtime.search({ text: '全文检索', dirId: 'dir-even' }).results
      .every(hit => hit.dirId === 'dir-even'));

    // 3. Same corpus, same query: raw relevance order vs the diversity pass.
    const limit = 20;
    const before = runtime.search({ text: '全文检索', limit: 50 }).results.slice(0, limit)
      .map(hit => ({ sessionId: hit.refId }));
    const after = runtime.findMessages({ text: '全文检索', limit });
    assert.equal(before.length, 20);
    assert.equal(after.length, 20, 'diversity must not shorten the answer');
    const beforeTop10 = before.slice(0, 10);
    const afterTop10 = after.slice(0, 10);
    logger.log?.(`[proof] raw (before):  ${show(before)}`);
    logger.log?.(`[proof] rerank (after): ${show(after)}`);
    console.log(`[proof] top-10 before: ${show(beforeTop10)}`);
    console.log(`[proof] top-10 after:  ${show(afterTop10)}`);
    assert.deepEqual(distribution(beforeTop10)[0], ['loud', 10], 'the raw order is monolithic');
    assert.equal(distribution(afterTop10)[0][1], 3, 'no session exceeds the quota in the top 10');
    assert.equal(distribution(afterTop10).length, 8, 'every session is represented');
    assert.deepEqual(distribution(after)[0], ['loud', 13], 'all hits are still returned (backfill)');

    // 4. Cross-session duplicate content is folded, and the answer is still complete.
    history.write('copy-1', [{ id: 'c1', role: 'user', content: '这一段被复制到了另一个会话，内容是完整的重复段落。', ts: 1_700_000_900_000 }]);
    history.write('copy-2', [{ id: 'c2', role: 'user', content: '这一段被复制到了另一个会话，内容是完整的重复段落。', ts: 1_700_000_800_000 }]);
    runtime.syncSession('copy-1');
    runtime.syncSession('copy-2');
    const copies = runtime.findMessages({ text: '完整的重复段落', limit: 10 });
    assert.equal(copies.length, 1, 'the same paragraph in two conversations is one hit');
    assert.equal(copies[0].sessionId, 'copy-1', 'the more recent copy wins the tie');
  } finally {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
