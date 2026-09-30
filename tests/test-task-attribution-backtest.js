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

test('prompt tells the parser to read the task progress and status before naming it', () => {
  // This is the prompt that actually runs (the scan + turn-end Aux job): it owns
  // taskName and phase, and phase *is* the progress verdict. It has to be told
  // where to read that from, and that `done` means the goal was reached — a
  // narration-only tail used to read as done.
  const system = buildTaskAttributionSystemPrompt({
    recentTasks: recentTaskContext(history), currentTaskId: 'tsk-login',
  });
  assert.match(system, /先读进度与状态/);
  // ① 的读数优先来自助手自报的步骤进度（turn-plan 层要求每轮报 N/M done），
  // 没有才回退逐条找落点——两条路都必须在提示词里。
  assert.match(system, /自报进度[\s\S]*?不要自己另编一份/);
  assert.match(system, /已经落地 \/ 做了一半 \/ 只说了要做 \/ 完全没做/);
  assert.match(system, /所有步骤都标完成、且没有未决步骤或遗留下一步，才填 done/);
  assert.match(system, /不算 done/);
  // Naming rule: verifiable verb + object, and a continuation keeps its name.
  assert.match(system, /不写过程或手段/);
  assert.match(system, /不要换个说法/);
});

test('prompt distinguishes provisional admission from locked explicit continuation', () => {
  const provisional = buildTaskAttributionSystemPrompt({
    recentTasks: recentTaskContext(history),
    currentTaskId: 'tsk-candidate',
    provisionalTaskId: 'tsk-candidate',
  });
  assert.match(provisional, /候选 ID/);
  assert.match(provisional, /relation=new\/taskId=null/);
  assert.match(provisional, /relatedTaskId/);
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
    taskName: '登录页样式调整', phase: 'implementing', goalState: null, relation: 'same', taskId: 'tsk-login',
    relatedTaskId: null, memoryCandidate: null,
  });
  assert.deepEqual(parseTaskAttribution(JSON.stringify({
    taskName: '增加导出功能', phase: 'planning', relation: 'new', taskId: 'tsk-login',
  })), {
    taskName: '增加导出功能', phase: 'planning', goalState: null, relation: 'new', taskId: null,
    relatedTaskId: null, memoryCandidate: null,
  });
});

test('parser passes the model goalState through and drops unknown values', () => {
  // 模型直接推理的「执行成功」子状态：合法值原样通过（resolveGoalState 会优先采信），
  // 不认识的词按没给处理，绝不把脏词带进判定。
  assert.equal(parseTaskAttribution('{"taskName":"换登录页 logo","phase":"verifying","goalState":"interact","relation":"same"}').goalState, 'interact');
  assert.equal(parseTaskAttribution('{"taskName":"换登录页 logo","phase":"done","goalState":"ACHIEVED","relation":"same"}').goalState, 'achieved');
  assert.equal(parseTaskAttribution('{"taskName":"换登录页 logo","phase":"done","goalState":"一半","relation":"same"}').goalState, null);
  assert.equal(parseTaskAttribution('{"taskName":"换登录页 logo","phase":"done","relation":"same"}').goalState, null);
  // 提示词契约必须真的把 goalState 要出来（模型不知道要答它，判定就永远走回退）。
  assert.match(buildTaskAttributionSystemPrompt({}), /随后独立判断 goalState（achieved\|interact\|null）/);
  assert.match(buildTaskAttributionSystemPrompt({}), /"goalState":"achieved\|interact\|null"/);
});

test('phase reads the assistant self-reported step progress before inferring its own', () => {
  // chat 轮次都带 turn-plan 层（host-prompts buildPlanProgressPrompt）：助手每轮被
  // 要求列 2-6 步计划并报「N/M done」。归因 phase 必须优先采信这份自报进度，
  // 只有记录里没有时才回退自己逐条找落点——否则就是第二份口径。
  const prompt = buildTaskAttributionSystemPrompt({});
  assert.match(prompt, /自报进度/);
  assert.match(prompt, /不要自己另编一份/);
  assert.match(prompt, /"N\/M done"/);
  assert.match(prompt, /所有步骤都标完成、且没有未决步骤或遗留下一步，才填 done/);
  assert.match(prompt, /还有未勾项而口头说"已完成"[\s\S]*?不算 done/);
});

test('new related tasks keep a distinct identity and accept only a recent related task id', () => {
  assert.deepEqual(parseTaskAttribution(JSON.stringify({
    taskName: '登录页截图测试', phase: 'planning', relation: 'new', taskId: null,
    relatedTaskId: 'tsk-login',
  }), {
    fallbackTaskId: 'tsk-candidate',
    allowedTaskIds: ['tsk-candidate', 'tsk-login'],
  }), {
    taskName: '登录页截图测试', phase: 'planning', goalState: null, relation: 'new', taskId: null,
    relatedTaskId: 'tsk-login', memoryCandidate: null,
  });
  assert.equal(parseTaskAttribution(JSON.stringify({
    taskName: '伪造关联', relation: 'new', relatedTaskId: 'tsk-hallucinated',
  }), {
    fallbackTaskId: 'tsk-candidate', allowedTaskIds: ['tsk-candidate', 'tsk-login'],
  }).relatedTaskId, null);
  // P4：relation=same 时 relatedTaskId 允许保留——只形成弱分组边，不改归属。
  assert.equal(parseTaskAttribution(JSON.stringify({
    taskName: '同一任务续作', relation: 'same', taskId: 'tsk-login', relatedTaskId: 'tsk-other',
  }), { allowedTaskIds: ['tsk-login', 'tsk-other'] }).relatedTaskId, 'tsk-other');
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
    taskName: '登录页样式调整', phase: 'verifying', goalState: null, relation: 'same', taskId: 'tsk-login',
    relatedTaskId: null, memoryCandidate: null,
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

test('an answer that reads like JSON but yields no name is unclassified, not a permanent same', () => {
  const broken = parseTaskAttribution('{"taskName":"登录页","relation":"same"', { fallbackTaskId: 'tsk-login' });
  assert.equal(broken.unclassified, true);
  assert.equal(broken.relation, 'same');
  assert.equal(broken.taskId, 'tsk-login', 'the admitted identity is still preserved');
  // A legacy three-line answer may mention braces in its goal without becoming
  // "unreadable": only a failed structured answer is unclassified.
  const prose = parseTaskAttribution('目标: 修复 {name} 占位符渲染\n阶段: 实现中\nC', { fallbackTaskId: 'tsk-login' });
  assert.equal(prose.unclassified, undefined);
  assert.equal(prose.taskName, '修复 {name} 占位符渲染');
  // And an answer with no usable name at all is also unclassified.
  assert.equal(parseTaskAttribution('D', { fallbackTaskId: 'tsk-login' }).unclassified, true);
});
