'use strict';
// Air 是纯轮询页面：每 4 秒拉一次任务板快照（线上约 580KB）和当前任务详情
// （实测 3.5MB，其中 3.2MB 是消息正文）。内容没变时必须能 304 收场，否则
// 服务端每轮都要把这几 MB 写出去、浏览器每轮都要解析并重建一遍 DOM。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountAirRoutes } = require('../src/workspace/air-routes');
const { airResponse } = require('./helpers/air-response');

function snapshotFixture() {
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  const board = { tasks: { tsk_1: { id: 'tsk_1', title: '任务', status: 'active', refs: [{ sessionId: 's', dirId: 'd1' }] } } };
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: { residentLimit: 4 } }), capacityReason: () => null },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex' }]]), directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => board, clis: ['codex'], shell: { taskAccess: () => ({ readOnly: true }) },
  });
  return { handlers, board };
}

test('/api/air 内容没变回 304，变了才重新发正文', async () => {
  const { handlers, board } = snapshotFixture();
  const first = airResponse();
  await handlers.get('/api/air')({ headers: {} }, first);
  assert.equal(first.statusCode, 200);
  assert.match(first.headers.etag, /^W\//, 'ETag 必须是弱校验器（正文派生）');
  const payload = JSON.parse(first.body);
  assert.equal(payload.tasks.length, 1);

  const second = airResponse();
  await handlers.get('/api/air')({ headers: { 'if-none-match': first.headers.etag } }, second);
  assert.equal(second.statusCode, 304, '同一份内容必须 304');
  assert.equal(second.body, undefined, '304 不带正文');

  // 多值 If-None-Match（浏览器/代理可能合并）里命中也要算命中。
  const third = airResponse();
  await handlers.get('/api/air')({ headers: { 'if-none-match': `"other", ${first.headers.etag}` } }, third);
  assert.equal(third.statusCode, 304);

  board.tasks.tsk_2 = { id: 'tsk_2', title: '新任务', status: 'active', refs: [{ sessionId: 's', dirId: 'd1' }] };
  const changed = airResponse();
  await handlers.get('/api/air')({ headers: { 'if-none-match': first.headers.etag } }, changed);
  assert.equal(changed.statusCode, 200, '内容变了必须重新发正文');
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.equal(JSON.parse(changed.body).tasks.length, 2);

  // 旧的校验器不能命中新内容：304 绝不能回给已经陈旧的客户端。
  const stale = airResponse();
  await handlers.get('/api/air')({ headers: { 'if-none-match': changed.headers.etag } }, stale);
  assert.equal(stale.statusCode, 304);
  assert.equal(JSON.parse(changed.body).tasks.length, 2);
});

test('/api/air/tasks/:id 详情同样支持 304（3.5MB 的消息正文不再每 4 秒重传）', async () => {
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  let messages = [{ id: 'm1', role: 'user', content: 'x'.repeat(64) }];
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }), capacityReason: () => null,
      deliveryEvidence: () => ({ run: null, integration: null }) },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex' }]]), directories: new Map([['d1', { id: 'd1', path: '/repo' }]]),
    getBoard: () => ({ tasks: {} }), clis: ['codex'],
    shell: { taskEntry: async id => ({ ok: true, task: { id, title: '任务' }, messages, execution: { busy: false }, sessionId: 's' }),
      attributionCandidate: () => null, roleBindings: () => null },
  });
  const first = airResponse();
  await handlers.get('/api/air/tasks/:id')({ params: { id: 't' }, headers: {} }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).messages.length, 1);

  const same = airResponse();
  await handlers.get('/api/air/tasks/:id')({ params: { id: 't' }, headers: { 'if-none-match': first.headers.etag } }, same);
  assert.equal(same.statusCode, 304);
  assert.equal(same.body, undefined);

  messages = [...messages, { id: 'm2', role: 'assistant', content: 'y' }];
  const next = airResponse();
  await handlers.get('/api/air/tasks/:id')({ params: { id: 't' }, headers: { 'if-none-match': first.headers.etag } }, next);
  assert.equal(next.statusCode, 200, '新消息到达时必须给完整详情');
  assert.equal(JSON.parse(next.body).messages.length, 2);
});

test('Air 前端显式发条件请求，并在 304 时跳过解析与重画', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'air.js'), 'utf8');
  assert.match(source, /'If-None-Match': knownEtag/, '轮询要带上上一次的 ETag');
  assert.match(source, /if \(conditional && response\.status === 304\) return \{ ok: true, unchanged: true \}/);
  // 通用 api() 不能带条件请求：别的 GET 调用方收到「没变」会当成空数据。
  assert.match(source, /const apiConditional = path => request\(path, \{ method: 'GET', body: undefined, conditional: true \}\);/);
  assert.match(source, /const snapshot = await apiConditional\('\/api\/air'\);/);
  assert.match(source, /const result = await apiConditional\(`\/api\/air\/tasks\/\$\{encodeURIComponent\(selected\)\}`\);/);
  assert.match(source, /if \(result\.unchanged\) return false;/, '详情没变就不重建会话区');
  assert.match(source, /if \(!snapshot\.unchanged\) \{[\s\S]{0,900}?render\(\);/, '快照没变就整块跳过渲染');
  // 快照没变不等于对话没变：详情仍然要问一次（多半也是 304）。
  assert.match(source, /const entryChanged = await refreshEntry\(\);/);
  assert.match(source, /if \(snapshot\.unchanged && !entryChanged\) return;/);
  // 后台标签页别再按 4 秒敲；失败要退避，别在服务端打嗝时持续加码。
  assert.match(source, /const POLL_HIDDEN_MS = 15000;/);
  assert.match(source, /const delay = pollFailures \? Math\.min\(base \* 2 \*\* pollFailures, POLL_MAX_MS\) : base;/);
});
