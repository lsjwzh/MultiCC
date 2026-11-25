'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAuxRunRoutes } = require('../src/routes/orchestration-host');

function fixture(create = createAuxRunRoutes) {
  const routes = new Map();
  const runs = [
    { runId: 'r1', anchorMessageId: 'm1', taskId: 't1' },
    { runId: 'r2', anchorMessageId: 'm2', taskId: 't1' },
  ];
  create({
    records: new Map([['s1', { id: 's1' }]]),
    getLog: () => ({
      list: () => runs,
      byAnchor: (_sid, id) => runs.filter(run => run.anchorMessageId === id),
      byTask: (_sid, id) => runs.filter(run => run.taskId === id),
      get: (_sid, id) => runs.find(run => run.runId === id) || null,
    }),
  }).mountRoutes({ get(path, handler) { routes.set(path, handler); } });
  function response() {
    return {
      statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }
  return { routes, response };
}

test('raw Aux replay is queryable by run, message and task', () => {
  const { routes, response } = fixture();
  const list = routes.get('/api/sessions/:id/aux-runs');
  const byMessage = response();
  list({ params: { id: 's1' }, query: { messageId: 'm2' } }, byMessage);
  assert.deepEqual(byMessage.body.runs.map(run => run.runId), ['r2']);
  const byTask = response();
  list({ params: { id: 's1' }, query: { taskId: 't1' } }, byTask);
  assert.equal(byTask.body.runs.length, 2);
  const one = response();
  routes.get('/api/sessions/:id/aux-runs/:runId')(
    { params: { id: 's1', runId: 'r1' } }, one,
  );
  assert.equal(one.body.run.anchorMessageId, 'm1');
});

test('unknown sessions and runs return 404', () => {
  const { routes, response } = fixture();
  const missingSession = response();
  routes.get('/api/sessions/:id/aux-runs')(
    { params: { id: 'missing' }, query: {} }, missingSession,
  );
  assert.equal(missingSession.statusCode, 404);
  const missingRun = response();
  routes.get('/api/sessions/:id/aux-runs/:runId')(
    { params: { id: 's1', runId: 'missing' } }, missingRun,
  );
  assert.equal(missingRun.statusCode, 404);
});

test('辅助运行与冻结索引对照选择优先级、截取和缺失会话', () => {
  const frozen = require('./helpers/frozen-file-batch9/aux-runs');
  function exercise(create) {
    const { routes, response } = fixture(create);
    const list = routes.get('/api/sessions/:id/aux-runs'), answers = [];
    for (const id of ['s1', 'missing']) {
      for (const messageId of ['', 'm1']) {
        for (const limit of [0, 1, -3, '02more', 999]) {
          const res = response();
          assert.equal(list({ params: { id }, query: { taskId: 't1', messageId, limit } }, res), res);
          answers.push([res.statusCode, res.body]);
        }
      }
    }
    return answers;
  }
  assert.deepEqual(exercise(createAuxRunRoutes), exercise(frozen.createAuxRunRoutes));
});
