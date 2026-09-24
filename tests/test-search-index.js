'use strict';

// The durable message index: the shared tokenizer (src/search/tokenize.js), the
// FTS5 store over node:sqlite (src/search/index-store.js) and the chat_history
// corpus that feeds it (src/search/message-corpus.js).
//
// What is worth asserting here, beyond "a search returns something":
//   1. the 2-character Chinese word has no blind spot — it is the whole reason the
//      tokenizer is bigram-based and not an FTS5 tokenizer at all;
//   2. a changed chunk replaces its postings instead of accumulating them, and an
//      unchanged one is not rewritten;
//   3. a source that shrank stops answering from its retired tail;
//   4. the index is derived: a schema or tokenizer change drops and rebuilds it,
//      and a build with no FTS5 available degrades instead of throwing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskSearch = require('../src/task-board/search');
const tokenizeModule = require('../src/search/tokenize');
const { createSearchIndex, hashOf, buildSnippet, escapeLike } = require('../src/search/index-store');
const {
  MESSAGE_SCOPE, chunkText, createMessageCorpus, isSearchableSession, messageText, sessionChunkRows,
} = require('../src/search/message-corpus');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');
const { databaseConstructor } = require('../src/sqlite/driver');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-search-index-'));
}

function memIndex(overrides = {}) {
  return createSearchIndex({ dbFile: ':memory:', logger: { warn() {}, log() {} }, ...overrides });
}

// A chunk of text long enough to be stored, carrying the terms under test.
function row(refId, ord, text, extra = {}) {
  return { scope: MESSAGE_SCOPE, refId, ord, kind: 'assistant', text, updatedAt: 1000, ...extra };
}

test('the task board and the message index tokenize identically', () => {
  // The board re-exports the shared tokenizer, so its callers (and its tests keep
  // passing) while both corpora are guaranteed to split a query the same way.
  assert.equal(taskSearch.tokenize, tokenizeModule.tokenize);
  for (const sample of ['全文检索 air.js', 'provider-router 切分', '缓存层', 'a 检索']) {
    assert.deepEqual([...taskSearch.tokenize(sample)], [...tokenizeModule.tokenize(sample)]);
  }
});

test('every token is quoted, and a term-shaped run is required whole', () => {
  assert.equal(tokenizeModule.matchExpression('缓存层'), '("缓存" AND "存层")');
  assert.equal(tokenizeModule.matchExpression('air.js'), '"air.js"');
  // A lone CJK character has no index term at all — the caller must use LIKE.
  assert.equal(tokenizeModule.matchExpression('索'), null);
  assert.equal(tokenizeModule.matchExpression('，。'), null);
  // Unquoted, FTS5 would read these as syntax and as `provider NOT router`.
  assert.equal(tokenizeModule.matchExpression('provider-router 缓存'), '"provider-router" OR "缓存"');
  assert.ok(!tokenizeModule.matchExpression('a 缓存').includes('"a"'));
});

test('a run longer than a term is a bag of words, not a required phrase', () => {
  // Requiring every bigram of a sentence asks for the sentence verbatim: measured on
  // the real corpus, 任务关联与搜索支持全文检索 and 怎么让新任务的关联加上全文搜索 both fell to
  // 0 hits that way, and 记忆图谱体系 to 4. Past a term-shaped run the bigrams are
  // alternatives again and bm25 sorts the chunks that cover more of them.
  const groups = tokenizeModule.matchGroups('记忆图谱体系');
  assert.equal(groups.length, 5, 'a 6-character run is five alternative bigrams');
  assert.deepEqual(groups[0], ['记忆']);
  assert.equal(tokenizeModule.matchExpression('记忆图谱体系'), groups.map(group => `"${group[0]}"`).join(' OR '));
  // Word-shaped runs in the same query keep their phrase requirement.
  assert.equal(tokenizeModule.matchExpression('记忆图谱体系 缓存层'),
    '"记忆" OR "忆图" OR "图谱" OR "谱体" OR "体系" OR ("缓存" AND "存层")');
  // The phrase requirement is a bound, not a rule about length alone: 3 bigrams (a
  // 4-character term) is the last length that is still one term.
  assert.equal(tokenizeModule.MAX_PHRASE_BIGRAMS, 3);
  assert.equal(tokenizeModule.matchGroups('全文检索').length, 1);
});

test('the expression stops growing at MAX_MATCH_TERMS', () => {
  // Thirty distinct characters, so the run really does carry 29 bigrams.
  const long = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';
  assert.equal(tokenizeModule.matchGroups(long).length, 29);
  const expression = tokenizeModule.matchExpression(long);
  assert.equal((expression.match(/"/g) || []).length / 2, tokenizeModule.MAX_MATCH_TERMS);
});

test('a 2-character Chinese query is not blind', () => {
  const index = memIndex();
  index.upsert([
    row('s1', 0, '这次把全文检索接进了任务搜索，检索结果按相关度排序。'),
    row('s2', 0, '重构了会话历史的写入路径，没有提到那个词。'),
  ]);
  const result = index.search({ text: '检索', scope: MESSAGE_SCOPE });
  assert.equal(result.mode, 'fts');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].refId, 's1');
  index.close();
});

test('latin terms keep their punctuation and are matched case-insensitively', () => {
  const index = memIndex();
  index.upsert([
    row('s1', 0, 'the provider-router decides where a turn goes in air.js'),
    row('s2', 0, 'an unrelated chunk about something else entirely'),
  ]);
  for (const query of ['provider-router', 'air.js', 'AIR.JS']) {
    const result = index.search({ text: query, scope: MESSAGE_SCOPE });
    assert.equal(result.results.length, 1, `${query} should hit exactly one chunk`);
    assert.equal(result.results[0].refId, 's1');
  }
  index.close();
});

test('a rewritten chunk replaces its postings instead of keeping both', () => {
  const index = memIndex();
  index.upsert([row('s1', 0, '旧内容讲的是缓存层的重构方式')]);
  const before = index.search({ text: '缓存', scope: MESSAGE_SCOPE });
  assert.equal(before.results.length, 1);

  const written = index.upsert([row('s1', 0, '新内容讲的是分词器的选择方式')]);
  assert.equal(written.updated, 1);
  assert.equal(index.search({ text: '缓存', scope: MESSAGE_SCOPE }).results.length, 0);
  assert.equal(index.search({ text: '分词器', scope: MESSAGE_SCOPE }).results.length, 1);
  index.close();
});

test('an unchanged chunk is skipped, not rewritten', () => {
  const index = memIndex();
  const rows = [row('s1', 0, '内容没有变化的一段话，用来验证哈希跳过。'), row('s1', 1, '第二段也一样没有变化。')];
  assert.deepEqual(index.upsert(rows), { inserted: 2, updated: 0, skipped: 0 });
  assert.deepEqual(index.upsert(rows), { inserted: 0, updated: 0, skipped: 2 });
  assert.equal(index.stats().scopes[0].chunks, 2);
  index.close();
});

test('a source that shrank stops answering from its retired tail', () => {
  const index = memIndex();
  index.upsert([row('s1', 0, '第一段提到航空面板'), row('s1', 1, '第二段提到排水治理')]);
  assert.equal(index.search({ text: '排水', scope: MESSAGE_SCOPE }).results.length, 1);
  // The transcript was pruned: only ord 0 survives.
  assert.equal(index.pruneRef(MESSAGE_SCOPE, 's1', 0), 1);
  assert.equal(index.search({ text: '排水', scope: MESSAGE_SCOPE }).results.length, 0);
  assert.equal(index.search({ text: '航空', scope: MESSAGE_SCOPE }).results.length, 1);
  index.close();
});

test('a deleted session leaves neither rows nor postings behind', () => {
  const index = memIndex();
  index.upsert([row('s1', 0, '这段文字只属于被删除的会话'), row('s2', 0, '这段文字属于另一个会话')]);
  assert.equal(index.removeRefs(MESSAGE_SCOPE, ['s1']), 1);
  assert.equal(index.search({ text: '删除', scope: MESSAGE_SCOPE }).results.length, 0);
  assert.deepEqual(index.listRefs(MESSAGE_SCOPE).map(ref => ref.refId), ['s2']);
  index.close();
});

test('a single CJK character is served by the LIKE scan', () => {
  const index = memIndex();
  index.upsert([row('s1', 0, '这个块里出现了缓这个字，但查询只有它自己。')]);
  const result = index.search({ text: '缓', scope: MESSAGE_SCOPE });
  assert.equal(result.mode, 'like');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].refId, 's1');
  // The snippet must still point at the character it matched.
  assert.ok(result.results[0].snippet.ranges.length >= 1);
  index.close();
});

test('like patterns escape their own wildcards', () => {
  const index = memIndex();
  index.upsert([row('s1', 0, '进度是 50% 而另一个块是 5000 字')]);
  const result = index.search({ text: '%', scope: MESSAGE_SCOPE });
  assert.equal(result.mode, 'like');
  assert.equal(result.results.length, 1, '% must match a literal percent sign only');
  assert.equal(escapeLike('a_b%c'), 'a\\_b\\%c');
  index.close();
});

test('filters narrow by kind, by source and by exclusion', () => {
  const index = memIndex();
  index.upsert([
    row('s1', 0, '共同的词出现在用户说的话里', { kind: 'user' }),
    row('s2', 0, '共同的词也出现在助手的回答里', { kind: 'assistant' }),
    row('s3', 0, '共同的词还出现在第三个会话里', { kind: 'user' }),
  ]);
  const all = index.search({ text: '共同的词', scope: MESSAGE_SCOPE });
  assert.equal(all.results.length, 3);
  const users = index.search({ text: '共同的词', scope: MESSAGE_SCOPE, kinds: ['user'] });
  assert.deepEqual(users.results.map(r => r.refId).sort(), ['s1', 's3']);
  const only = index.search({ text: '共同的词', scope: MESSAGE_SCOPE, refIds: ['s2'] });
  assert.deepEqual(only.results.map(r => r.refId), ['s2']);
  const not = index.search({ text: '共同的词', scope: MESSAGE_SCOPE, excludeRefIds: ['s2'] });
  assert.deepEqual(not.results.map(r => r.refId).sort(), ['s1', 's3']);
  assert.equal(index.search({ text: '共同的词', scope: MESSAGE_SCOPE, limit: 2 }).results.length, 2);
  index.close();
});

test('an empty or oversized query is refused without touching the store', () => {
  const index = memIndex();
  index.upsert([row('s1', 0, '随便什么内容都行，这段只是用来确认查询被拦下。')]);
  assert.equal(index.search({ text: '', scope: MESSAGE_SCOPE }).mode, 'empty');
  assert.equal(index.search({ text: 'x'.repeat(500), scope: MESSAGE_SCOPE }).mode, 'rejected');
  assert.throws(() => index.search({ text: '缓存' }), /requires a scope/);
  index.close();
});

test('bm25 puts the chunk that is actually about the query first', () => {
  const index = memIndex();
  // The query terms have to be a minority of the corpus: bm25 gives a term present
  // in half the documents (or more) an IDF of zero, so a two-document corpus cannot
  // show a ranking at all — which is also why `detail=full` is required, since
  // `detail=none` reports bm25 = 0 for every row.
  index.upsert([
    row('s1', 0, '会议纪要：讨论了排期、人员和预算，顺带提了一句分词。'),
    row('s2', 0, '分词器的选型：为什么用 bigram 而不是 trigram，以及它对检索的影响。'),
    row('s3', 0, '完全无关的一段话，讲的是部署和回滚。'),
    row('s4', 0, '另一段无关的话，讲的是电池和屏幕亮度。'),
    row('s5', 0, '还有一段无关的话，讲的是推送通道和证书。'),
    row('s6', 0, '最后一段无关的话，讲的是目录授权和沙箱。'),
  ]);
  const result = index.search({ text: '分词 检索', scope: MESSAGE_SCOPE });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].refId, 's2', 'the chunk holding both terms wins');
  assert.ok(result.results[0].score > result.results[1].score);
  index.close();
});

test('snippet offsets are relative to the returned window', () => {
  const text = `${'前缀'.repeat(40)}关键命中词${'后缀'.repeat(40)}`;
  const snippet = buildSnippet(text, ['关键命中词']);
  const start = snippet.ranges[0][0];
  assert.equal(snippet.text.slice(start, snippet.ranges[0][1]), '关键命中词');
  // And the window is trimmed rather than the whole chunk being echoed back.
  assert.ok(snippet.text.length < text.length);
});

test('without FTS5 the index degrades instead of throwing', () => {
  const index = createSearchIndex({
    dbFile: ':memory:',
    probe: () => false,
    logger: { warn() {} },
  });
  assert.equal(index.available, false);
  assert.match(index.reason, /fts5/);
  assert.deepEqual(index.upsert([row('s1', 0, '什么都不会被写入')]), { inserted: 0, updated: 0, skipped: 0 });
  assert.deepEqual(index.search({ text: '缓存', scope: MESSAGE_SCOPE }).results, []);
  assert.deepEqual(index.listRefs(MESSAGE_SCOPE), []);
  assert.equal(index.removeRefs(MESSAGE_SCOPE, ['s1']), 0);
  assert.equal(index.pruneRef(MESSAGE_SCOPE, 's1', 0), 0);
  assert.equal(index.stats().available, false);
  index.close();
});

test('a schema or tokenizer change rebuilds the index instead of trusting it', () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'search-index.sqlite');
  const logger = { warn() {} };
  const first = createSearchIndex({ dbFile, logger });
  first.upsert([row('s1', 0, '旧口径下写入的内容，重建之后不应该还在。')]);
  assert.equal(first.stats().scopes[0].chunks, 1);
  first.close();

  // A future version wrote this file; it cannot be read by this one.
  const Database = databaseConstructor();
  const raw = new Database(dbFile);
  raw.pragma('user_version = 99');
  raw.close();

  const second = createSearchIndex({ dbFile, logger });
  assert.equal(second.available, true);
  assert.deepEqual(second.stats().scopes, []);
  second.upsert([row('s1', 0, '新口径下重新写入的内容，检索得到。')]);
  assert.equal(second.search({ text: '检索', scope: MESSAGE_SCOPE }).results.length, 1);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the corpus reads conversation text and nothing else', () => {
  // `tools` is by far the biggest field in a stored message and the easiest thing
  // to index by accident; it must stay out.
  const message = {
    role: 'assistant',
    content: '这是一段会进入索引的对话正文，长度足够。',
    tools: [{ name: 'Bash', input: { command: 'echo 工具载荷不该被检索到' }, result: '工具载荷不该被检索到' }],
    usage: { input_tokens: 10 },
    cost: 0.5,
  };
  const text = messageText(message);
  assert.match(text, /对话正文/);
  assert.ok(!text.includes('工具载荷'));
  assert.equal(messageText({ role: 'system', content: 'system 指令不进索引' }), '');
  assert.equal(messageText({ role: 'user', content: [{ type: 'text', text: 'x' }] }), '');
  assert.equal(messageText({ role: 'user' }), '');
  assert.equal(messageText(null), '');
});

test('chunks overlap and short fragments are dropped', () => {
  const long = 'a'.repeat(1000);
  const pieces = chunkText(long);
  assert.ok(pieces.length >= 2);
  assert.equal(pieces[0].length, 400);
  // 60 characters of overlap: the next chunk starts 340 in, so a term spanning the
  // boundary is still whole inside one of them.
  assert.equal(pieces[1], long.slice(340, 740));
  // The floor drops acknowledgements, not short questions: 6 characters is already
  // a real question in Chinese, so it must survive.
  assert.deepEqual(chunkText('好的'), []);
  assert.deepEqual(chunkText('继续'), []);
  assert.deepEqual(chunkText('分词器用哪个'), ['分词器用哪个']);
});

test('session rows dedupe, keep ord stable and count every candidate', () => {
  const repeated = '这段话在会话里出现了两次，内容完全相同因此只应该留下一个块。';
  const messages = [
    { id: 'm1', role: 'user', content: repeated },
    { id: 'm2', role: 'assistant', content: '回应上面那段话，内容不同所以应当各自成块。' },
    { id: 'm3', role: 'system', content: '系统消息不进索引，但它不应该打乱序号。' },
    { id: 'm4', role: 'user', content: repeated },
  ];
  const { rows, candidates } = sessionChunkRows('s1', messages, { updatedAt: 42 });
  assert.equal(rows.length, 2, 'the repeated chunk is stored once');
  assert.deepEqual(rows.map(r => r.ord), [0, 1]);
  assert.equal(candidates, 3, 'ord counts candidates, so it does not renumber');
  assert.equal(rows[0].refId, 's1');
  assert.equal(rows[0].kind, 'user');
  assert.equal(rows[1].itemId, 'm2');
  assert.equal(rows[0].updatedAt, 42);
});

test('synthetic sessions are never indexed', () => {
  assert.equal(isSearchableSession('__aux__'), false);
  assert.equal(isSearchableSession('__gateway__'), false);
  assert.equal(isSearchableSession('abc__aux__x'), false);
  assert.equal(isSearchableSession(''), false);
  assert.equal(isSearchableSession('2choi9lq-chat'), true);
});

test('a single-session sync refuses a synthetic session too', () => {
  const dir = tempDir();
  const logger = { warn() {}, log() {} };
  const history = createChatHistoryFileRepository({ dataDir: dir });
  const index = createSearchIndex({ dbFile: path.join(dir, 'search-index.sqlite'), logger });
  const corpus = createMessageCorpus({ index, history, logger });

  // The gateway's own bookkeeping is written through the same history repository,
  // so a server syncing one session on turn end would index it unless the guard is
  // inside syncSession rather than only in the sweep.
  history.write('__gateway__', [{ id: 'g1', role: 'user', content: '网关自己的记账内容不能被检索到。' }]);
  const result = corpus.syncSession('__gateway__');
  assert.equal(result.sessionSkipped, true);
  assert.equal(corpus.search({ text: '记账内容' }).results.length, 0);
  assert.deepEqual(index.listRefs(MESSAGE_SCOPE), []);

  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session with nothing to index is parsed once, not every sweep', () => {
  const dir = tempDir();
  const logger = { warn() {}, log() {} };
  const history = createChatHistoryFileRepository({ dataDir: dir });
  const index = createSearchIndex({ dbFile: path.join(dir, 'search-index.sqlite'), logger });
  const corpus = createMessageCorpus({ index, history, logger });

  // Tool-heavy transcripts are the real case: hundreds of KB whose content strings
  // are all too short to index, so they never produce a ref row.
  history.write('s1', [
    { id: 'm1', role: 'user', content: '好' },
    { id: 'm2', role: 'assistant', content: 'ok' },
  ]);
  const first = corpus.syncAll();
  assert.equal(first.synced, 1);
  assert.equal(first.chunks, 0);
  // Nothing to search for, so there is no ref — but the emptiness is remembered.
  assert.deepEqual(index.listRefs(MESSAGE_SCOPE), []);
  assert.equal(corpus.syncSession('s1').sessionSkipped, true);
  assert.equal(corpus.syncAll().skipped, 1);

  // Content appears: the session turns into a real ref and the marker is retired.
  history.write('s1', [
    { id: 'm1', role: 'user', content: '好' },
    { id: 'm2', role: 'assistant', content: 'ok' },
    { id: 'm3', role: 'user', content: '现在这条内容够长了，应该被索引进来。' },
  ]);
  const grown = corpus.syncAll();
  assert.equal(grown.synced, 1);
  assert.equal(grown.chunks, 1);
  assert.equal(index.listRefs(MESSAGE_SCOPE).length, 1);
  assert.equal(index.readMarker(MESSAGE_SCOPE, 's1'), null);
  assert.equal(corpus.search({ text: '够长了' }).results.length, 1);

  // A deleted session takes its marker with it, so markers cannot pile up.
  history.deleteSession('s1');
  const swept = corpus.syncAll();
  assert.equal(swept.removedRefs, 1);
  assert.deepEqual(index.listMarkers(MESSAGE_SCOPE), []);

  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the sync follows a session file: append, skip, prune, delete', () => {
  const dir = tempDir();
  const logger = { warn() {}, log() {} };
  const history = createChatHistoryFileRepository({ dataDir: dir });
  const index = createSearchIndex({ dbFile: path.join(dir, 'search-index.sqlite'), logger });
  const corpus = createMessageCorpus({ index, history, logger });

  const first = { id: 'm1', role: 'user', content: '第一个问题：分词器为什么用 bigram 而不是 trigram。' };
  const second = { id: 'm2', role: 'assistant', content: '第二个回答：因为 trigram 对两个字的中文词完全失明。' };
  history.write('s1', [first, second]);
  const built = corpus.syncAll();
  assert.equal(built.synced, 1);
  assert.equal(corpus.search({ text: '分词器' }).results.length, 1);

  // Unchanged file: skipped without being re-read.
  assert.equal(corpus.syncSession('s1').sessionSkipped, true);

  // Appended turn: only the new content is written.
  history.write('s1', [first, second, { id: 'm3', role: 'user', content: '第三个问题：那索引占多少空间。' }]);
  const appended = corpus.syncSession('s1');
  assert.equal(appended.sessionSkipped, false);
  assert.equal(appended.inserted, 1);
  assert.equal(appended.updated, 0);
  assert.equal(corpus.search({ text: '占多少空间' }).results.length, 1);

  // Pruned turn: the retired tail stops answering.
  history.write('s1', [first]);
  const pruned = corpus.syncSession('s1');
  assert.ok(pruned.pruned >= 1);
  assert.equal(corpus.search({ text: '占多少空间' }).results.length, 0);
  assert.equal(corpus.search({ text: '第一个问题' }).results.length, 1);

  // Deleted session: swept on the next full sync.
  history.deleteSession('s1');
  const swept = corpus.syncAll();
  assert.equal(swept.removedRefs, 1);
  assert.deepEqual(index.listRefs(MESSAGE_SCOPE), []);

  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a sweep that finds no sources keeps the index unless told otherwise', () => {
  const dir = tempDir();
  const logger = { warn() {}, log() {} };
  const history = createChatHistoryFileRepository({ dataDir: dir });
  const index = createSearchIndex({ dbFile: path.join(dir, 'search-index.sqlite'), logger });
  const corpus = createMessageCorpus({ index, history, logger });

  history.write('s1', [{ id: 'm1', role: 'user', content: '这条内容在空扫描之后必须还在。' }]);
  corpus.syncAll();
  assert.equal(index.listRefs(MESSAGE_SCOPE).length, 1);

  // Pointing the sweep at a directory with no history at all is the wrong-directory
  // case: it must not be read as "every conversation was deleted".
  const emptyDir = tempDir();
  const emptyHistory = createChatHistoryFileRepository({ dataDir: emptyDir });
  const blind = createMessageCorpus({ index, history: emptyHistory, logger });
  const guarded = blind.syncAll();
  assert.equal(guarded.sessions, 0);
  assert.equal(guarded.removedRefs, 0);
  assert.equal(guarded.pruneSkipped, 1);
  assert.equal(guarded.pruneSkippedReason, 'no-sources-discovered');
  assert.equal(corpus.search({ text: '空扫描' }).results.length, 1);

  // An explicit force is the operator saying the empty directory is the truth.
  const forced = blind.syncAll({ force: true });
  assert.equal(forced.removedRefs, 1);
  assert.deepEqual(index.listRefs(MESSAGE_SCOPE), []);

  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

test('an mtime that has not settled is re-read rather than trusted', () => {
  const dir = tempDir();
  const logger = { warn() {}, log() {} };
  const history = createChatHistoryFileRepository({ dataDir: dir });
  const index = createSearchIndex({ dbFile: path.join(dir, 'search-index.sqlite'), logger });
  // A clock pinned to the file's own mtime is exactly the ambiguous window the
  // fast path refuses to trust.
  const corpus = createMessageCorpus({ index, history, logger, now: () => fs.statSync(history.fileFor('s1')).mtimeMs });
  history.write('s1', [{ role: 'user', content: '这段话在同一个毫秒里被写入，快路径不能直接跳过它。' }]);
  assert.equal(corpus.syncSession('s1').sessionSkipped, false);
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hashOf is stable and short enough to store per chunk', () => {
  assert.equal(hashOf('同样的文字'), hashOf('同样的文字'));
  assert.notEqual(hashOf('同样的文字'), hashOf('同样的文字 '));
  assert.equal(hashOf('x').length, 16);
});
