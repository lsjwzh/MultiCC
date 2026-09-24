'use strict';

// Content-based task association: the retrieval half of attribution.
//
// Association is decided by the Aux model from a prompt, so what matters here is
// exactly what that prompt is allowed to see: retrieved tasks are *candidates*,
// kept apart from the recency list and labelled as content matches only. A hit
// must never by itself become an identity — the model is told so in the prompt,
// and parseTaskAttribution rejects any id that was not offered to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const taskSearch = require('../src/task-board/search');
const {
  attributionQueryText,
  buildTaskAttributionSystemPrompt,
  parseTaskAttribution,
  retrieveRelatedTasks,
  RETRIEVAL_RELATIVE_FLOOR,
} = require('../src/classify/task-attribution');

function task(id, overrides = {}) {
  return { id, title: `任务 ${id}`, dirId: 'dir-web', status: 'active', updatedAt: 1, areas: [], refs: [], ...overrides };
}

function board(tasks) {
  return {
    modules: { web: { id: 'web', name: '前端 UI' } },
    tasks: Object.fromEntries(tasks.map(item => [item.id, item])),
    deletedTaskIds: [],
  };
}

// One task is unmistakably about the query; the other merely mentions one of its
// words deep inside a long excerpt.
const FIXTURE = board([
  task('tsk-search', {
    title: '全文检索：任务搜索的排序',
    description: '给任务搜索加全文检索，标题没命中也能找回来。',
  }),
  task('tsk-cache', {
    title: '缓存层重构',
    refs: [{ excerpt: `${'无关的过程叙述。'.repeat(40)}顺带提了一句检索。` }],
  }),
]);

test('the retrieval query is the user text first, then a bounded slice of the reply', () => {
  const query = attributionQueryText({ userText: '把上次那个搜索再改一下', replyText: '改了 src/task-board/search.js' });
  assert.equal(query, '把上次那个搜索再改一下\n改了 src/task-board/search.js');
  assert.equal(attributionQueryText({}), '');
  assert.ok(attributionQueryText({ userText: 'a'.repeat(900) }).length === 400, 'the user slice is bounded');
});

test('retrieval only proposes content matches, never a lone-character coincidence', () => {
  const hits = retrieveRelatedTasks(FIXTURE, { userText: '全文检索' });
  assert.deepEqual(hits.map(hit => hit.taskId), ['tsk-search']);
  const hit = hits[0];
  assert.equal(hit.taskName, '全文检索：任务搜索的排序');
  assert.ok(hit.score > 0);
  assert.ok(hit.snippet.includes('全文检索'), 'the evidence the model judges with is quoted back');

  // The same query does reach the weak task — the relative floor is what keeps it
  // out of the prompt, and it is relative (not absolute) because idf moves with
  // corpus size on every real board.
  const all = taskSearch.searchBoard(FIXTURE, '全文检索', { limit: 10 });
  assert.deepEqual(all.map(item => item.taskId), ['tsk-search', 'tsk-cache']);
  assert.ok(all[1].score < all[0].score * RETRIEVAL_RELATIVE_FLOOR,
    'the dropped hit is below the floor');

  assert.deepEqual(retrieveRelatedTasks(FIXTURE, { userText: '嗯' }), [],
    'a query of lone characters is not evidence');
  assert.deepEqual(retrieveRelatedTasks(null, { userText: '全文检索' }), []);
  assert.deepEqual(retrieveRelatedTasks(FIXTURE, { userText: '' }), []);
  const hostile = { get tasks() { throw new Error('board unavailable'); } };
  assert.deepEqual(retrieveRelatedTasks(hostile, { userText: '全文检索' }), [],
    'a broken board degrades to no candidates, not to a failed attribution');
});

test('retrieval excludes the session’s own recent tasks and honours the limit', () => {
  assert.deepEqual(retrieveRelatedTasks(FIXTURE, {
    userText: '全文检索', excludeTaskIds: ['tsk-search'],
  }), []);
  const many = board([
    task('tsk-1', { title: '全文检索 一' }), task('tsk-2', { title: '全文检索 二' }),
    task('tsk-3', { title: '全文检索 三' }), task('tsk-4', { title: '全文检索 四' }),
  ]);
  const limited = retrieveRelatedTasks(many, { userText: '全文检索', limit: 2 });
  assert.equal(limited.length, 2, 'the limit is the prompt budget, not a page size');
});

test('the prompt shows retrieved tasks apart from the recency list, with their evidence', () => {
  const relatedTasks = retrieveRelatedTasks(FIXTURE, { userText: '全文检索' });
  const prompt = buildTaskAttributionSystemPrompt({
    recentTasks: [{ taskId: 'tsk-recent', taskName: '上一轮的任务' }],
    relatedTasks,
    currentTaskId: 'tsk-recent',
  });
  assert.match(prompt, /内容相关任务（/);
  assert.match(prompt, /- tsk-search: 全文检索：任务搜索的排序（.*全文检索.*）/);
  assert.match(prompt, /不要仅因命中就复用它的 taskId/,
    'a content hit must not become an identity on its own');
  assert.match(prompt, /最近任务：\n- tsk-recent: 上一轮的任务/,
    'the recency list stays its own section');

  const withoutRelated = buildTaskAttributionSystemPrompt({ recentTasks: [], relatedTasks: [] });
  assert.doesNotMatch(withoutRelated, /内容相关任务/);
  assert.doesNotMatch(withoutRelated, /不要仅因命中/);
  // Identity locking keeps overriding every other instruction, retrieval included.
  assert.match(buildTaskAttributionSystemPrompt({ identityLocked: true, currentTaskId: 'tsk-x', relatedTasks }),
    /任务身份已由明确任务卡或 #CODE 锁定为 tsk-x/);
});

test('a retrieved id is usable only because it was offered to the parser', () => {
  const relatedTasks = retrieveRelatedTasks(FIXTURE, { userText: '全文检索' });
  const allowed = ['tsk-recent', ...relatedTasks.map(hit => hit.taskId)];
  const verdict = parseTaskAttribution(JSON.stringify({
    taskName: '任务搜索的排序', phase: 'implementing', relation: 'same',
    taskId: 'tsk-search', relatedTaskId: null, contextRelevance: 'high',
  }), { fallbackTaskId: 'tsk-recent', allowedTaskIds: allowed });
  assert.equal(verdict.taskId, 'tsk-search', 'continuing a retrieved task is a real `same`');
  assert.equal(verdict.relation, 'same');

  const forged = parseTaskAttribution(JSON.stringify({
    taskName: '任务搜索的排序', relation: 'same', taskId: 'tsk-not-offered', contextRelevance: 'high',
  }), { fallbackTaskId: 'tsk-recent', allowedTaskIds: allowed });
  assert.equal(forged.taskId, 'tsk-recent', 'an id nobody offered falls back to the current task');

  const derived = parseTaskAttribution(JSON.stringify({
    taskName: '任务关联也走全文检索', relation: 'new', relatedTaskId: 'tsk-search', contextRelevance: 'high',
  }), { fallbackTaskId: 'tsk-recent', allowedTaskIds: allowed });
  assert.equal(derived.relation, 'new');
  assert.equal(derived.relatedTaskId, 'tsk-search', 'same material, different deliverable groups instead');
});
