'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildTaskAttributionConversation,
  buildTaskAttributionSystemPrompt,
  parseTaskAttribution,
  recentTaskContext,
} = require('../src/classify/task-attribution');
const {
  corpusFromAuxRuns,
  createFakeAuxModel,
  runHistoryBacktest,
} = require('../src/classify/history-backtest');
const { loadCorpus } = require('../scripts/backtest-task-attribution');

const history = [
  { id: 'm1', role: 'user', content: '把登录页按钮改成蓝色', taskId: 'tsk-login', taskName: '登录页样式调整' },
  { id: 'm2', role: 'assistant', content: '已完成按钮配色修改。', taskId: 'tsk-login', taskName: '登录页样式调整' },
  { id: 'm3', role: 'user', content: '再把 hover 颜色调深一点', taskId: 'tsk-login', taskName: '登录页样式调整' },
];

test('prompt carries recent message task names and forbids turn-state output', () => {
  const recent = recentTaskContext(history);
  const system = buildTaskAttributionSystemPrompt({ recentTasks: recent, currentTaskId: 'tsk-login' });
  const prompt = buildTaskAttributionConversation(history);
  assert.match(system, /tsk-login: 登录页样式调整/);
  assert.match(system, /不负责判断 turn/);
  assert.match(prompt, /\[任务 登录页样式调整 \| tsk-login\]/);
});

test('prompt distinguishes provisional admission from locked explicit continuation', () => {
  const provisional = buildTaskAttributionSystemPrompt({
    recentTasks: recentTaskContext(history),
    currentTaskId: 'tsk-candidate',
    provisionalTaskId: 'tsk-candidate',
  });
  assert.match(provisional, /候选 ID/);
  assert.match(provisional, /relation=new\/taskId=null/);
  const locked = buildTaskAttributionSystemPrompt({
    recentTasks: recentTaskContext(history),
    currentTaskId: 'tsk-login',
    identityLocked: true,
  });
  assert.match(locked, /身份已由明确任务卡或 #CODE 锁定/);
  assert.match(locked, /relation=same/);
});

test('parser keeps continuations on the existing task and permits genuinely new tasks', () => {
  assert.deepEqual(parseTaskAttribution(JSON.stringify({
    taskName: '登录页样式调整', phase: 'implementing', relation: 'same', taskId: 'tsk-login',
  })), {
    taskName: '登录页样式调整', phase: 'implementing', relation: 'same', taskId: 'tsk-login',
  });
  assert.deepEqual(parseTaskAttribution(JSON.stringify({
    taskName: '增加导出功能', phase: 'planning', relation: 'new', taskId: 'tsk-login',
  })), {
    taskName: '增加导出功能', phase: 'planning', relation: 'new', taskId: null,
  });
});

test('same-task attribution cannot select a task id absent from recent history', () => {
  assert.equal(parseTaskAttribution(JSON.stringify({
    taskName: '登录页样式调整', relation: 'same', taskId: 'hallucinated',
  }), {
    fallbackTaskId: 'tsk-login', allowedTaskIds: ['tsk-login'],
  }).taskId, 'tsk-login');
});

test('fake LLM replays historical cases and reports exact attribution regressions', async () => {
  const cases = [
    {
      id: 'continuation', history, fallbackTaskId: 'tsk-login',
      allowedTaskIds: ['tsk-login'],
      expected: { taskName: '登录页样式调整', relation: 'same', taskId: 'tsk-login' },
    },
    {
      id: 'new-task', history: [...history, { role: 'user', content: '现在增加 CSV 导出' }],
      fallbackTaskId: 'tsk-login',
      expected: { taskName: 'CSV 导出', relation: 'new', taskId: null },
    },
  ];
  const fake = createFakeAuxModel({
    continuation: '{"taskName":"登录页样式调整","phase":"implementing","relation":"same","taskId":"tsk-login"}',
    'new-task': '{"taskName":"CSV 导出","phase":"planning","relation":"new","taskId":null}',
  });
  const report = await runHistoryBacktest(cases, fake);
  assert.equal(report.total, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0].history, history);
});

test('historical backtest rejects a same-task id the fake model invented', async () => {
  const fake = createFakeAuxModel({
    hallucinated: '{"taskName":"登录页样式调整","relation":"same","taskId":"tsk-invented"}',
  });
  const report = await runHistoryBacktest([{
    id: 'hallucinated',
    fallbackTaskId: 'tsk-login',
    allowedTaskIds: ['tsk-login'],
    expected: { relation: 'same', taskId: 'tsk-login' },
  }], fake);
  assert.equal(report.failed, 0);
  assert.equal(report.results[0].actual.taskId, 'tsk-login');
});

test('legacy raw Aux text remains replayable as same-task naming evidence', () => {
  assert.deepEqual(parseTaskAttribution('登录页样式调整\n验证中\nD', {
    fallbackTaskId: 'tsk-login',
  }), {
    taskName: '登录页样式调整', phase: 'verifying', relation: 'same', taskId: 'tsk-login',
  });
});

test('durable aux-run JSONL records become a replayable fake-model corpus', async () => {
  const corpus = corpusFromAuxRuns([{
    runId: 'run-history-1',
    priorTaskId: 'tsk-old',
    taskId: 'tsk-export',
    rawText: '{"taskName":"CSV 导出","phase":"implementing","relation":"same","taskId":"tsk-export"}',
    parsed: { taskName: 'CSV 导出', phase: 'implementing', relation: 'same', taskId: 'tsk-export' },
  }]);
  assert.equal(corpus.cases.length, 1);
  assert.deepEqual(corpus.cases[0].allowedTaskIds, ['tsk-old', 'tsk-export']);
  const report = await runHistoryBacktest(corpus.cases, createFakeAuxModel(corpus.responses));
  assert.equal(report.failed, 0);
});

test('CLI corpus loader accepts the JSONL shape written by aux-run-log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-aux-backtest-'));
  const file = path.join(dir, 'runs.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({
      runId: 'r1', priorTaskId: 'tsk-old', taskId: 'tsk-old',
      rawText: '{"taskName":"旧任务","relation":"same","taskId":"tsk-old"}',
      parsed: { taskName: '旧任务', relation: 'same', taskId: 'tsk-old' },
    }),
    JSON.stringify({ runId: 'r2', error: 'aux_unhealthy', rawText: null }),
  ].join('\n'));
  const corpus = loadCorpus(file);
  assert.equal(corpus.cases.length, 1);
  assert.equal(corpus.cases[0].id, 'r1');
  assert.match(corpus.responses.r1, /旧任务/);
});
