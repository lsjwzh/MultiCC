'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../src/task-board');
const { createTaskBoardRuntime, assertTaskBoardDeps } = require('../src/routes/task-board');
const { routeLegacyCommanderMarkers } = require('../src/dispatch/legacy-commander-route');
const taskBoardUi = require('../public/task-board-ui');

test('task board snapshot reconciliation is taskId-idempotent and prunes replay ghosts', () => {
  const reconciled = taskBoardUi.reconcileSnapshot({
    modules: [{ id: 'mod-1', updatedAt: 1 }, { id: 'mod-1', updatedAt: 2 }],
    tasks: [
      { id: 'tsk-1', title: 'same title', updatedAt: 1 },
      { id: 'tsk-1', title: 'newer projection', updatedAt: 2 },
      { id: 'tsk-2', title: 'same title', updatedAt: 3 },
    ],
  });
  assert.equal(reconciled.modules.length, 1);
  assert.equal(reconciled.tasks.length, 2);
  assert.equal(reconciled.tasks.find(task => task.id === 'tsk-1').title, 'newer projection');
  assert.equal(reconciled.tasks.find(task => task.id === 'tsk-2').title, 'same title',
    'two explicit task ids with identical titles must remain two cards');

  const afterReconnect = taskBoardUi.reconcileSnapshot({
    modules: [{ id: 'mod-1' }],
    tasks: [{ id: 'tsk-2', title: 'same title' }],
  });
  assert.deepEqual(afterReconnect.tasks.map(task => task.id), ['tsk-2']);
});

test('legacy tasks with unresolved identity are separated without destructive merging', () => {
  const grouped = taskBoardUi.partitionTaskIdentity([
    { id: 'tsk-canonical', identityState: 'canonical', title: '新任务' },
    { id: 'tsk-orphan', identityState: 'orphaned_admission', title: '新任务' },
    { id: 'tsk-legacy', identityState: 'legacy_unresolved', title: '新任务' },
  ]);
  assert.deepEqual(grouped.canonical.map(task => task.id), ['tsk-canonical']);
  assert.deepEqual(grouped.unresolved.map(task => task.id), ['tsk-orphan', 'tsk-legacy']);
});

test('task detail session links use the encoded chat navigation contract', () => {
  assert.equal(
    taskBoardUi.sessionChatUrl('session one&中文'),
    '/chat.html?session=session+one%26%E4%B8%AD%E6%96%87',
  );
  assert.equal(
    taskBoardUi.sessionChatUrl('session one&中文', 'msg/1?x'),
    '/chat.html?session=session+one%26%E4%B8%AD%E6%96%87&message=msg%2F1%3Fx',
  );
  assert.equal(taskBoardUi.sessionChatUrl(''), null);
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'meta.html'), 'utf8');
  assert.match(source, /<script src="task-board-ui\.js"><\/script>/);
  assert.match(source, /t\.sessionIds\.map[\s\S]*?sessionChatUrl\(sid\)[\s\S]*?target="_blank"/);
  assert.match(source, /sessionChatUrl\(it\.sessionId, it\.messageId\)/);
  assert.match(source, /td-msg-link/);
  const manage = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  assert.match(manage, /sessionChatUrl\(it\.sessionId, it\.messageId\)/);
  assert.match(manage, /tb-msg-link/);
  assert.doesNotMatch(source, /sessionChatUrl\([^)]*\)[^\n]*(?:token|cwd)=/);
});

test('manage task detail renders clickable session links in chips and message rows', async () => {
  const content = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const context = vm.createContext({
    console,
    window: { MultiCCTaskBoardUi: taskBoardUi },
    document: {
      getElementById: id => id === 'tb-detail-content' ? content : null,
      createElement: () => ({}),
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
    },
    fetch: async () => ({ json: async () => ({ ok: false }) }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
  });
  // Same script order as manage.html: the shared status registry loads first, and
  // the board renders its badges through it rather than through a local map.
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'status-presentation.js'), 'utf8'),
    context,
  );
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  vm.runInContext(source, context);
  vm.runInContext(`
    _tbBoard = {
      modules: [{ id: 'mod-1', name: '前端 UI' }],
      tasks: [],
      sessionLabels: { 'session one&中文': '会话一' }
    };
    renderTaskBoardDetail({
      task: {
        id: 'task-1', moduleId: 'mod-1', title: '跳转修复', status: 'active',
        sessionIds: ['session one&中文'], areas: [], moduleAssignment: null
      },
      items: [{
        sessionId: 'session one&中文', sessionLabel: '会话一', role: 'user',
        messageId: 'msg/1?x', ts: 1, text: '检查跳转'
      }]
    });
  `, context);

  const sessionUrl = '/chat.html?session=session+one%26%E4%B8%AD%E6%96%87';
  const messageUrl = sessionUrl + '&amp;message=msg%2F1%3Fx';
  assert.equal((content.innerHTML.match(/<a /g) || []).length, 2);
  assert.match(content.innerHTML, new RegExp(sessionUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(content.innerHTML, new RegExp(messageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((content.innerHTML.match(/target="_blank"/g) || []).length, 2);
  assert.match(content.innerHTML, /tb-chip tb-session-link/);
  assert.match(content.innerHTML, /tb-msg user tb-msg-link/);
});

test('task board UI keeps pending modules first and sorts tasks by last activity', () => {
  const modules = [
    { id: 'z', name: 'Beta', source: 'ai' },
    { id: 'p', name: '待归类', source: 'classify' },
    { id: 'a', name: 'Alpha', source: 'ai' },
  ];
  const tasks = [
    { id: 'old', title: '旧任务', lastTs: 10 },
    { id: 'new', title: '新任务', lastTs: 30 },
    { id: 'middle', title: '中间任务', lastTs: 20 },
  ];
  assert.deepEqual(taskBoardUi.sortModules(modules).map(m => m.id), ['p', 'a', 'z']);
  assert.deepEqual(taskBoardUi.sortTasks(tasks).map(t => t.id), ['new', 'middle', 'old']);
  assert.deepEqual(modules.map(m => m.id), ['z', 'p', 'a']);
  assert.deepEqual(tasks.map(t => t.id), ['old', 'new', 'middle']);

  const manageSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  const metaSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'meta.html'), 'utf8');
  for (const source of [manageSource, metaSource]) {
    assert.match(source, /MultiCCTaskBoardUi\.sortModules/);
    assert.match(source, /MultiCCTaskBoardUi\.sortTasks/);
  }
});

test('task board display state follows classify runState for icon and status text', () => {
  // Icons, tones, copy keys and the animation policy come from the shared
  // registry (public/status-presentation.js) — the board no longer keeps its own
  // table. `label` is an i18n key here because no translator is installed in the
  // node lane; tests/test-status-presentation.js proves the keys exist in zh+en.
  const cases = [
    [{ status: 'active', runState: 'done' }, ['done', '✅', 'statusDone', 'success', true, false]],
    [{ status: 'active', runState: 'running' }, ['running', '🔄', 'statusRunning', 'running', false, true]],
    [{ status: 'active', runState: 'queued' }, ['queued', '📥', 'statusQueued', 'info', false, false]],
    [{ status: 'active', runState: 'waiting' }, ['waiting', '⏸️', 'statusWaiting', 'waiting', false, false]],
    [{ status: 'active', runState: 'error' }, ['error', '❌', 'statusError', 'danger', false, false]],
    [{ status: 'active', runState: 'idle' }, ['idle', '⚪', 'statusIdle', 'neutral', false, false]],
    [{ status: 'done', runState: 'running' }, ['done', '✅', 'statusDone', 'success', true, false]],
    [{ status: 'archived', runState: 'done' }, ['archived', '🗄', 'statusArchived', 'muted', false, false]],
    // A value this build does not know lands neutrally — never on done, never on
    // running, and never on the error glyph.
    [{ status: 'active', runState: 'teleporting' }, ['unknown', '❔', 'statusUnknown', 'neutral', false, false]],
  ];
  for (const [task, expected] of cases) {
    const display = taskBoardUi.taskDisplayState(task);
    assert.deepEqual(
      [display.key, display.icon, display.label, display.tone, display.done, display.running],
      expected,
    );
    // Only `running` may animate: an errored card stops spinning the moment it
    // turns red, which is the whole point of routing through the registry.
    assert.equal(display.running, display.key === 'running');
  }

  const manage = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  const meta = fs.readFileSync(path.join(__dirname, '..', 'public', 'meta.html'), 'utf8');
  for (const source of [manage, meta]) {
    assert.match(source, /MultiCCTaskBoardUi\.taskDisplayState\(t\)/);
    assert.match(source, /tb-run-state st-tone-\$\{display\.tone\}[\s\S]*?\$\{(?:_tbEsc|esc)\(display\.label\)\}/);
    // The row glyph is the shared badge, not a locally chosen emoji.
    assert.match(source, /statusBadgeHtml\('task', display\.status/);
    assert.match(source, /className: 'tb-icon'/);
    assert.match(source, /moduleAssignment/);
    assert.doesNotMatch(source, /\.classification\b|classificationLabel|waiting_reply|retry_wait/);
  }

  const runStateAdapter = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'session-work-host.js'), 'utf8');
  assert.match(runStateAdapter, /classifyDisplay\(classifyState\)\.cardStatus/);
  // The phantom `classifyState === 'A'` branch is removed — no code ever wrote
  // 'A' (the D/C/W/B/E/P vocabulary never included it), so it was dead.
  assert.doesNotMatch(runStateAdapter, /classifyState === 'A'/);
  // Frozen sessions resolve their runState through the explicit reason map, not
  // the old `includes('error')` substring heuristic.
  assert.match(runStateAdapter, /runStateForFreezeReason\(state\.queueFreezeReason\)/);
  assert.doesNotMatch(runStateAdapter, /queueFreezeReason \|\| ''\)\.includes\('error'\)/);
  assert.match(runStateAdapter, /cardStatus === 'completed' \? 'done' : cardStatus/);
  assert.doesNotMatch(runStateAdapter, /classifyState === 'D' \|\| classifyState === 'C'/);
  // A task card must follow the session's persisted classify verdict, never a
  // momentary session-busy flag. The `if (sessionBusy(sid)) return 'running'`
  // short-circuit used to make every historical card light up as「进行中」
  // whenever its owning session ran any new turn — do not reintroduce it.
  assert.doesNotMatch(runStateAdapter, /Busy\(/);
});

test('task board UI hides the Commander routing chip on the card', () => {
  // The routing chip is intentionally suppressed: a card should read as just
  // "新任务 · 进行中" and sync title/state from the worker's own classify. The
  // label function returns '' for every routing shape (data is kept on the DTO,
  // see the persistence test below), so no "已交给 Commander → worker" chip shows.
  assert.equal(taskBoardUi.taskRoutingLabel({
    routing: {
      mode: 'commander', targetSessionId: 'commander-1', targetLabel: 'Agent Commander',
    },
  }), '');
  assert.equal(taskBoardUi.taskRoutingLabel({
    routing: {
      mode: 'commander', targetSessionId: 'commander-1', targetLabel: '指挥',
      workerSessionId: 'worker-3', workerLabel: '弹性 Worker 3', elasticWorkerCreated: true,
    },
  }), '');
  assert.equal(taskBoardUi.taskRoutingLabel({
    routing: { mode: 'manual', targetSessionId: 'worker-1' },
  }), '');
  for (const file of ['public/manage-taskboard.js', 'public/meta.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /taskRoutingLabel/);
  }
  // The one-shot send toast ("已由 Commander…") is a transient send-time
  // acknowledgement, not the card chip — it stays.
  const composerSrc = fs.readFileSync(path.join(__dirname, '..', 'public/manage-taskboard.js'), 'utf8');
  assert.match(composerSrc, /已由 Commander/);
});

// ── parseTagResult ──────────────────────────────────────────────────────────

test('parseTagResult accepts clean JSON and sanitizes entries', () => {
  const out = core.parseTagResult(JSON.stringify({
    tasks: [
      { id: 'new', title: '实现任务板后端', module: '服务端', areas: ['src/task-board.js', ''] },
      { id: 'tsk-x', areas: 'not-an-array' },
    ],
  }));
  assert.equal(out.tasks.length, 2);
  assert.deepEqual(out.tasks[0], {
    id: 'new', title: '实现任务板后端', module: '服务端', areas: ['src/task-board.js'],
  });
  assert.deepEqual(out.tasks[1], { id: 'tsk-x', title: '', module: '', areas: [] });
});

test('parseTagResult strips thinking blocks and code fences', () => {
  const fenced = '```json\n{"tasks":[{"id":"new","title":"修复登录","module":"前端 UI","areas":[]}]}\n```';
  assert.equal(core.parseTagResult(fenced).tasks[0].title, '修复登录');
  const think = '<think>废话</think>前置噪声 {"tasks":[{"id":"new","title":"A","module":"B","areas":[]}]} 尾巴';
  assert.equal(core.parseTagResult(think).tasks[0].title, 'A');
  const dsThink = '推理…<｜end▁of▁thinking｜>{"tasks":[]}';
  assert.deepEqual(core.parseTagResult(dsThink).tasks, []);
});

test('parseTagResult returns empty task list on garbage and caps entries', () => {
  assert.deepEqual(core.parseTagResult('对不起我无法输出 JSON').tasks, []);
  assert.deepEqual(core.parseTagResult('').tasks, []);
  assert.deepEqual(core.parseTagResult(null).tasks, []);
  const many = { tasks: Array.from({ length: 9 }, (_, i) => ({ id: 'new', title: `T${i}`, module: 'M', areas: [] })) };
  assert.equal(core.parseTagResult(JSON.stringify(many)).tasks.length, core.MAX_TAGS_PER_TURN);
});

// ── applyTagResult / aggregation ────────────────────────────────────────────

function mkRef(overrides = {}) {
  return {
    sessionId: 's1', dirId: 'd1', dirLabel: 'multicc',
    userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 1000, excerpt: '做点事',
    ...overrides,
  };
}

test('applyTagResult creates module and task, attaches the turn ref', () => {
  const board = core.createEmptyBoard();
  const touched = core.applyTagResult(board, [
    { id: 'new', title: '实现任务板', module: '服务端', areas: ['src/task-board.js'] },
  ], mkRef(), 2000);
  assert.equal(touched.length, 1);
  const task = board.tasks[touched[0]];
  assert.equal(task.title, '实现任务板');
  assert.equal(task.refs.length, 1);
  assert.equal(task.refs[0].assistantMsgId, 'ma1');
  const mod = board.modules[task.moduleId];
  assert.equal(mod.name, '服务端');
  assert.equal(mod.dirId, 'd1');
});

test('applyTagResult reuses modules but preserves distinct task admissions with similar titles', () => {
  const board = core.createEmptyBoard();
  core.applyTagResult(board, [{ id: 'new', title: '修复登录', module: '前端 UI', areas: [] }], mkRef(), 1);
  core.applyTagResult(board, [{ id: 'new', title: '修复 登录', module: '前端UI', areas: [] }],
    mkRef({ assistantMsgId: 'ma2', userMsgId: 'mu2' }), 2);
  assert.equal(Object.keys(board.modules).length, 1);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.deepEqual(Object.values(board.tasks).map(t => t.refs.length), [1, 1]);
});

test('task title canonicalization merges same intent but preserves opposite actions', () => {
  assert.equal(
    core.canonicalTaskTitle('删除 [TikTok] 会话 和 WorkTree'),
    core.canonicalTaskTitle('清理 tiktok 会话与 worktree'),
  );
  assert.ok(core.taskTitleSimilarity('实现达人营销全流程管理系统后端', '设计达人营销全流程管理系统核心后端') >= 0.78);
  assert.ok(core.taskTitleSimilarity('删除 tiktok 会话', '恢复 tiktok 会话') < 0.78);
  assert.equal(core.taskTitleSimilarity('删除 tiktok 会话及其全部 worktree 和分支', '恢复 tiktok 会话及其全部 worktree 和分支'), 0);
});

test('title similarity is diagnostic only and never merges logical task identity', () => {
  const board = core.createEmptyBoard();
  core.applyTagResult(board, [
    { id: 'new', title: '删除 [tiktok] 会话和 worktree', module: '发布运维', areas: [] },
  ], mkRef(), 1);
  core.applyTagResult(board, [
    { id: 'new', title: '清理 tiktok 会话与 worktree', module: '会话管理', areas: [] },
  ], mkRef({ sessionId: 's2', userMsgId: 'mu2', assistantMsgId: 'ma2' }), 2);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.deepEqual(Object.values(board.tasks).map(t => t.refs[0].sessionId), ['s1', 's2']);

  core.applyTagResult(board, [
    { id: 'new', title: '删除 tiktok 会话和 worktree', module: '发布运维', areas: [] },
  ], mkRef({ dirId: 'd2', sessionId: 'other', userMsgId: 'mu3', assistantMsgId: 'ma3' }), 3);
  assert.equal(Object.keys(board.tasks).length, 3);
});

test('addRefToTask upgrades an in-flight user ref with the final assistant id', () => {
  const task = { status: 'active', updatedAt: 1, refs: [] };
  assert.equal(core.addRefToTask(task, mkRef({ assistantMsgId: null, ts: 10 }), 10), true);
  assert.equal(core.addRefToTask(task, mkRef({ assistantMsgId: 'ma-final', ts: 20 }), 20), true);
  assert.equal(task.refs.length, 1);
  assert.equal(task.refs[0].assistantMsgId, 'ma-final');
  assert.equal(task.refs[0].ts, 20);
});

test('pending tasks are unique placeholders and converge in place after classification', () => {
  const board = core.createEmptyBoard();
  const first = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 's1', seed: '实现任务板手动重试', now: 10,
  });
  const second = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 's1', seed: '修复另一件事', now: 11,
  });
  assert.notEqual(first.id, second.id);
  assert.equal(Object.keys(board.modules).length, 1);
  assert.equal(first.title, '新任务');
  assert.equal(first.moduleAssignment.running, false);

  const result = core.applyTaskClassification(board, first.id, {
    id: first.id, title: '完善任务归类', module: '任务板', areas: ['src/task-board.js'],
  }, mkRef({ userMsgId: 'u-live', assistantMsgId: 'a-live' }), 20);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, first.id);
  assert.equal(board.tasks[first.id].title, '完善任务归类');
  assert.equal(board.modules[board.tasks[first.id].moduleId].name, '任务板');
  assert.equal(board.tasks[first.id].moduleAssignment, undefined);
  assert.equal(Object.keys(board.tasks).length, 2);
});

test('classification cannot merge a pending canonical task into another task id', () => {
  const board = core.createEmptyBoard();
  const [existingId] = core.applyTagResult(board, [
    { id: 'new', title: '修复登录', module: '前端 UI', areas: [] },
  ], mkRef({ userMsgId: 'u-old', assistantMsgId: 'a-old' }), 1);
  const pending = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 's1', seed: '继续修复登录', now: 2,
  });
  const result = core.applyTaskClassification(board, pending.id, {
    id: existingId, title: '', module: '', areas: ['public/login.js'],
  }, mkRef({ userMsgId: 'u-new', assistantMsgId: 'a-new' }), 3);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, pending.id);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.deepEqual(board.tasks[existingId].refs.map(r => r.userMsgId), ['u-old']);
  assert.deepEqual(board.tasks[pending.id].refs.map(r => r.userMsgId), ['u-new']);
});

test('applyTagResult routes by existing id and dedups refs by assistant msg id', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }], mkRef(), 1);
  const again = core.applyTagResult(board, [{ id: tid, title: '', module: '', areas: [] }], mkRef(), 2);
  assert.deepEqual(again, []);            // same assistantMsgId → no new ref, nothing touched
  assert.equal(board.tasks[tid].refs.length, 1);
  const more = core.applyTagResult(board, [{ id: tid, title: '', module: '', areas: [] }],
    mkRef({ assistantMsgId: 'ma9', userMsgId: 'mu9', sessionId: 's2' }), 3);
  assert.deepEqual(more, [tid]);
  assert.equal(board.tasks[tid].refs.length, 2);
});

test('one turn can be tagged into multiple tasks', () => {
  const board = core.createEmptyBoard();
  const touched = core.applyTagResult(board, [
    { id: 'new', title: 'A', module: 'M', areas: [] },
    { id: 'new', title: 'B', module: 'M', areas: [] },
  ], mkRef(), 1);
  assert.equal(touched.length, 2);
  assert.equal(Object.keys(board.modules).length, 1);
  for (const t of Object.values(board.tasks)) assert.equal(t.refs[0].assistantMsgId, 'ma1');
});

test('new conversation reactivates a done task', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }], mkRef(), 1);
  board.tasks[tid].status = 'done';
  core.applyTagResult(board, [{ id: tid }], mkRef({ assistantMsgId: 'ma2' }), 2);
  assert.equal(board.tasks[tid].status, 'active');
});

// ── backfill parse / apply ──────────────────────────────────────────────────

test('parseBackfillResult validates turn lists and drops entries without turns', () => {
  const out = core.parseBackfillResult(JSON.stringify({ tasks: [
    { id: 'new', title: '实现语音', module: '移动 App', areas: ['app/voice'], turns: [1, 2, 2, '3', -1, 'x'] },
    { id: 'new', title: '没有轮次', module: 'M', areas: [], turns: [] },
  ] }));
  assert.equal(out.tasks.length, 1);
  assert.deepEqual(out.tasks[0].turns, [1, 2, 3]);
});

test('applyBackfillResult uses source-message identity and is replay-idempotent', () => {
  const board = core.createEmptyBoard();
  const refByTurn = new Map([
    [1, mkRef({ userMsgId: 'u1', assistantMsgId: 'a1', ts: 10 })],
    [2, mkRef({ userMsgId: 'u2', assistantMsgId: 'a2', ts: 20 })],
    [3, mkRef({ userMsgId: 'u3', assistantMsgId: 'a3', ts: 30 })],
  ]);
  const touched = core.applyBackfillResult(board, [
    { id: 'new', title: '实现语音', module: '移动 App', areas: ['app/voice'], turns: [1, 3] },
    { id: 'new', title: '修复构建', module: '发布运维', areas: [], turns: [2, 9] },   // turn 9 unknown → skipped
  ], refByTurn, 100);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.equal(touched.length, 2);
  const voice = Object.values(board.tasks).find(t => t.title === '实现语音');
  assert.deepEqual(voice.refs.map(r => r.assistantMsgId), ['a1', 'a3']);
  const build = Object.values(board.tasks).find(t => t.title === '修复构建');
  assert.deepEqual(build.refs.map(r => r.assistantMsgId), ['a2']);
  // Re-running the same backfill is a no-op (ref dedup).
  const again = core.applyBackfillResult(board, [
    { id: 'new', title: '实现语音', module: '移动 App', areas: [], turns: [1, 3] },
  ], refByTurn, 200);
  assert.deepEqual(again, []);
  assert.equal(voice.refs.length, 2);
});

// ── normalizeBoard ──────────────────────────────────────────────────────────

test('normalizeBoard drops malformed entries and survives garbage', () => {
  assert.deepEqual(core.normalizeBoard(null), { modules: {}, tasks: {} });
  assert.deepEqual(core.normalizeBoard('junk'), { modules: {}, tasks: {} });
  const board = core.normalizeBoard({
    modules: { m1: { name: '服务端' }, bad: { nope: 1 } },
    tasks: {
      t1: {
        title: 'T', moduleId: 'm1', refs: [{ sessionId: 's1', ts: 5 }, { bad: true }],
        classification: { state: 'waiting_reply', lastError: '/tmp/private token=secret' },
      },
      bad: { refs: [] },
    },
  });
  assert.deepEqual(Object.keys(board.modules), ['m1']);
  assert.deepEqual(Object.keys(board.tasks), ['t1']);
  assert.equal(board.tasks.t1.refs.length, 1);
  assert.equal(board.tasks.t1.status, 'active');
  assert.equal(board.tasks.t1.classification, undefined);
  assert.equal(board.tasks.t1.moduleAssignment.running, false);
  assert.equal(board.tasks.t1.moduleAssignment.lastError, 'classification_failed');
});

test('normalizeBoard migrates legacy classify module names to 待归类', () => {
  const dirId = '56783e84-80bb-49d2-89d4-6b412cdc9617';
  const board = core.normalizeBoard({
    modules: {
      legacyUuid: { name: dirId.slice(0, 20), source: 'classify', dirId },
      legacyUnclassified: { name: '未分类', source: 'classify', dirId: 'dir-2' },
    },
  });
  assert.equal(board.modules.legacyUuid.name, core.CLASSIFY_PENDING_MODULE_NAME);
  assert.equal(board.modules.legacyUnclassified.name, core.CLASSIFY_PENDING_MODULE_NAME);
});

// ── routing ─────────────────────────────────────────────────────────────────

function mkRecords(entries) {
  return new Map(Object.entries(entries));
}

test('pickRouteTarget keeps affinity with an available prior participant', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    mkRef({ sessionId: 'old', assistantMsgId: 'a1' }), 1);
  core.applyTagResult(board, [{ id: tid }], mkRef({ sessionId: 'newer', userMsgId: 'u2', assistantMsgId: 'a2' }), 2);
  const records = mkRecords({
    old: { kind: 'chat', dirId: 'd1' },
    newer: { kind: 'chat', dirId: 'd1' },
  });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, null), 'newer');
});

test('pickRouteTarget skips invalid candidates and selects a relevant session in the module dir', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    mkRef({ sessionId: 'gone', dirId: 'd1' }), 1);
  const records = mkRecords({
    __aux__: { kind: 'chat', type: 'aux', dirId: 'd1' },
    term1: { kind: 'term', dirId: 'd1' },
    eph: { kind: 'chat', ephemeral: true, dirId: 'd1' },
    otherdir: { kind: 'chat', dirId: 'd2' },
    good: { kind: 'chat', dirId: 'd1', label: '前端任务工程师' },
  });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, null, { queryText: '前端任务' }), 'good');
});

test('pickRouteTarget honors an explicit valid target and returns null when nothing fits', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }], mkRef(), 1);
  const records = mkRecords({ pick: { kind: 'chat', dirId: 'd9' } });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, 'pick'), 'pick');
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], mkRecords({}), null), null);
});

test('pickDirTarget uses recency only to break equal relevance scores', () => {
  const records = mkRecords({
    stale: { kind: 'chat', dirId: 'd1', label: '前端消息', lastActivity: '2026-07-01T00:00:00Z' },
    fresh: { kind: 'chat', dirId: 'd1', label: '前端消息', lastActivity: '2026-07-20T00:00:00Z' },
    otherdir: { kind: 'chat', dirId: 'd2', label: '前端消息', lastActivity: '2026-07-21T00:00:00Z' },
    __aux__: { kind: 'chat', type: 'aux', dirId: 'd1', lastActivity: '2026-07-21T00:00:00Z' },
  });
  assert.equal(core.pickDirTarget(records, 'd1', null, { queryText: '前端消息' }), 'fresh');
  assert.equal(core.pickDirTarget(records, 'd1', 'stale'), 'stale');   // explicit wins
  assert.equal(core.pickDirTarget(records, 'd3', null), null);
  assert.equal(core.pickDirTarget(records, null, null, { queryText: '前端消息' }), 'otherdir');
});

// ── routed-message marker ───────────────────────────────────────────────────

test('new routed messages keep taskId out of user-visible text while legacy markers still parse', () => {
  const task = { id: 'tsk-abc_1', title: '实现任务板' };
  const msg = core.buildRoutedMessage(task, '继续加个删除按钮');
  assert.equal(msg, '【任务：实现任务板】\n继续加个删除按钮');
  assert.doesNotMatch(msg, /tsk-abc_1|tb:/);
  assert.equal(core.extractTaskMarker('【任务：旧任务｜tb:tsk-legacy】\n继续'), 'tsk-legacy');
  assert.equal(core.extractTaskMarker('普通消息'), null);
});

// ── messageText / DTO ───────────────────────────────────────────────────────

test('messageText handles string and block-array content', () => {
  assert.equal(core.messageText({ content: 'hi' }), 'hi');
  assert.equal(core.messageText({ content: [
    { type: 'thinking', thinking: 'x' },
    { type: 'text', text: 'a' },
    { type: 'tool_use' },
    { type: 'text', text: 'b' },
  ] }), 'a\nb');
  assert.equal(core.messageText(null), '');
});

test('buildBoardDto aggregates counts, sessions and sorts by recency', () => {
  const board = core.createEmptyBoard();
  const [t1] = core.applyTagResult(board, [{ id: 'new', title: '旧任务', module: 'M', areas: [] }],
    mkRef({ ts: 100 }), 100);
  const [t2] = core.applyTagResult(board, [{ id: 'new', title: '新任务', module: 'M', areas: [] }],
    mkRef({ assistantMsgId: 'a2', sessionId: 's2', ts: 900 }), 900);
  const dto = core.buildBoardDto(board);
  assert.equal(dto.tasks[0].id, t2);
  assert.equal(dto.tasks[1].id, t1);
  assert.equal(dto.modules.length, 1);
  assert.equal(dto.modules[0].taskCount, 2);
  assert.deepEqual(dto.tasks[0].sessionIds, ['s2']);
});

test('routing retries append attempts on one task and replayed operations stay idempotent', () => {
  const task = {
    id: 'tsk-stable', title: 'T', status: 'active', areas: [], refs: [],
    createdAt: 1, updatedAt: 1,
  };
  const first = {
    mode: 'router-tool', targetSessionId: 'worker-1', workerSessionId: 'worker-1',
    operationId: 'op-1', status: 'admitted', routedAt: 10,
  };
  core.setTaskRouting(task, first);
  core.setTaskRouting(task, first);
  core.setTaskRouting(task, {
    ...first, operationId: 'op-2', status: 'completed', routedAt: 20,
  });
  assert.deepEqual(task.routing.attempts.map(attempt => attempt.operationId), ['op-1', 'op-2']);
  const dto = core.buildBoardDto({
    modules: {},
    tasks: { [task.id]: task },
  }, () => 'idle');
  assert.equal(dto.tasks[0].attemptCount, 2);
});

test('Commander one-way card status follows the executing worker classify only', () => {
  const board = core.createEmptyBoard();
  const pending = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 'commander-1', seed: '修复 URL 保存', now: 1,
  });
  core.setTaskRouting(pending, {
    mode: 'commander', targetSessionId: 'commander-1', workerSessionId: 'worker-1',
    status: 'admitted', oneWay: true, routedAt: 2,
  });
  delete pending.runState; // legacy cards fall back to session-level state
  const states = new Map([['commander-1', 'waiting'], ['worker-1', 'running']]);
  let dto = core.buildBoardDto(board, sid => states.get(sid) || null).tasks[0];
  assert.equal(dto.runState, 'running');
  assert.equal(dto.moduleAssignment.running, false);

  states.set('worker-1', 'done');
  dto = core.buildBoardDto(board, sid => states.get(sid) || null).tasks[0];
  assert.equal(dto.runState, 'done');
});

// ── runtime (integration with fake deps) ────────────────────────────────────

function mkRuntime(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-'));
  const file = path.join(tmp, 'task_board.json');
  const auxCalls = [];
  const broadcasts = [];
  const dispatches = [];
  const sessionMessages = [];
  let auxResolve;
  let runtime;
  const deps = {
    file,
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue(task) {
        auxCalls.push(task);
        return new Promise(resolve => { auxResolve = resolve; });
      },
    },
    records: new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: '工程师1' }],
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
    ]),
    loadHistory: () => [
      { id: 'mu1', role: 'user', content: '实现任务板', ts: 10 },
      { id: 'ma1', role: 'assistant', content: '已实现，改了 src/task-board.js', ts: 20 },
    ],
    dispatchToSession: async (target, message, opts) => {
      dispatches.push({ target, message, opts, route: opts.allowCommander ? 'commander' : 'manual' });
      return { ok: true, chatId: target, operationId: 'op-1', status: 'delivering' };
    },
    routeCommanderTask: async ({ commanderId, message, idempotencyKey, ...taskContext }) => {
      dispatches.push({
        target: commanderId,
        message,
        opts: { idempotencyKey, oneWay: true, ...taskContext },
        route: 'commander',
      });
      return {
        ok: true, targetSessionId: 'sess-1', targetLabel: '工程师1',
        operationId: 'op-1', status: 'delivering', queued: false,
      };
    },
    sendSessionMessage: async (sessionId, text, options) => {
      sessionMessages.push({ sessionId, text, options: { ...options } });
      // New design: Commander goes through runTurn; sendSessionMessage just confirms delivery.
      return { ok: true, handled: false, chatId: sessionId };
    },
    workspaceBroadcast: (dirId, payload) => broadcasts.push({ dirId, payload }),
    atomicWriteJson: (f, value) => fs.writeFileSync(f, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => 'idle',
    isSessionBusy: () => false,
    logger: { log: () => {} },
    ...overrides,
  };
  runtime = createTaskBoardRuntime(deps);
  return {
    runtime, deps, file, auxCalls, broadcasts, dispatches, sessionMessages,
    resolveAux: v => auxResolve(v),
  };
}

test('assertTaskBoardDeps rejects missing deps', () => {
  assert.throws(() => assertTaskBoardDeps({}), /missing dep/);
});

test('ordinary chat never creates a task or queues task tagging', () => {
  const { runtime, auxCalls } = mkRuntime();
  runtime.onTurnEnd({
    currentUserText: '实现任务板',
    currentAssistantText: '已实现完整功能。',
  }, 'sess-1');
  runtime.onClassifyGoal('sess-1', '实现任务板', 'planning', {
    currentUserText: '实现任务板',
    runState: 'running',
  });
  assert.equal(auxCalls.length, 0);
  assert.deepEqual(runtime.getBoard(), { modules: {}, tasks: {} });
});

test('canonical task messages create one projection, retain full body, and classify updates it', () => {
  const history = [];
  const { runtime, broadcasts } = mkRuntime({ loadHistory: () => history });
  const taskId = 'tsk-canonical-1';
  const text = '第一行\n<script>alert(1)</script>\n最后一行';
  const user = {
    id: 'u1', role: 'user', content: '【任务：新任务】\n' + text, ts: 10,
    taskId, taskStart: true, taskSource: 'task-board', taskText: text,
  };
  history.push(user);
  assert.equal(runtime.onMessagePersisted('sess-1', user), true);
  assert.equal(runtime.onMessagePersisted('sess-1', user), true);
  assert.equal(Object.keys(runtime.getBoard().tasks).length, 1);
  assert.equal(runtime.getBoard().tasks[taskId].refs.length, 1);

  runtime.onClassifyGoal('sess-1', '统一任务链路', 'implementing', {
    currentUserText: user.content,
    taskId,
    runState: 'waiting',
  });
  assert.equal(runtime.getBoard().tasks[taskId].title, '第一行');
  assert.equal(runtime.getBoard().tasks[taskId].runState, 'waiting');
  assert.equal(broadcasts[0].payload.kind, 'created');

  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: () => {} });
  const res = { json(body) { this.body = body; return this; } };
  routes.get('/api/task-board')({}, res);
  const dto = res.body.tasks[0];
  assert.equal(dto.body, text);
  assert.equal(dto.legacy, false);
  assert.equal(JSON.stringify(runtime.getBoard()).includes(text), false,
    'task body must not be copied into task_board.json');
});

test('taskId boundaries keep intervening events on the current task and open a second card only for a new id', () => {
  const history = [];
  const { runtime } = mkRuntime({ loadHistory: () => history });
  const push = message => {
    history.push(message);
    runtime.onMessagePersisted('sess-1', message);
  };
  push({ id: 'u1', role: 'user', content: '任务一', taskText: '任务一', taskId: 'tsk-one', taskStart: true, taskSource: 'task-board', ts: 1 });
  push({ id: 'a1', role: 'assistant', content: '任务一回复', taskId: 'tsk-one', ts: 2 });
  push({ id: 'u2', role: 'user', content: '任务一后续', taskId: 'tsk-one', ts: 3 });
  push({ id: 'a2', role: 'assistant', content: '任务一后续回复', taskId: 'tsk-one', ts: 4 });
  push({ id: 'u3', role: 'user', content: '任务二', taskText: '任务二', taskId: 'tsk-two', taskStart: true, taskSource: 'commander', ts: 5 });
  assert.deepEqual(Object.keys(runtime.getBoard().tasks).sort(), ['tsk-one', 'tsk-two']);
  assert.equal(runtime.getBoard().tasks['tsk-one'].refs.length, 2);
  assert.equal(runtime.getBoard().tasks['tsk-two'].refs.length, 1);
});

test('streaming classify path creates or merges the task-board card before returning', () => {
  // recordTaskBoardGoal / applyClassifyResult / scanAndReclassify now live in the
  // extracted classify state machine.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'classify', 'state-machine.js'), 'utf8');
  const taskContextHostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'task-context-host.js'), 'utf8');
  assert.match(source, /function recordTaskBoardGoal[\s\S]*?getTaskContextHost\(\)\.recordGoal/);
  assert.match(taskContextHostSource, /function recordGoal[\s\S]*?getTaskBoard\(\)\?\.onClassifyGoal/);
  const start = source.indexOf('function applyClassifyResult(');
  const end = source.indexOf('\n  function scanAndReclassify()', start);
  assert.ok(start >= 0 && end > start, 'applyClassifyResult slice anchors must resolve');
  const body = source.slice(start, end);
  const streaming = body.indexOf('if (cs && cs.isStreaming)');
  const create = body.indexOf('recordTaskBoardGoal(', streaming);
  const earlyReturn = body.indexOf('\n      return;', streaming);
  assert.ok(streaming >= 0 && create > streaming && earlyReturn > create);
});

test('host task-board dispatch rejects busy targets before durable admission', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const gatewayHost = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'dispatch', 'gateway-host.js'),
    'utf8',
  );
  // Busy is a classify verdict plus the repo lease — see the liveness→classify
  // invariants in tests/test-architecture-boundaries.js.
  assert.match(source, /function dispatchTargetBusy\(sid\)[\s\S]*?isRunActive\(sid\)[\s\S]*?isLeased\(sid\)/);
  // The task board reads the run state directly; it has no busy port of its own.
  assert.doesNotMatch(source, /createTaskBoardRuntime\([\s\S]*?isSessionBusy:/);
  // The dispatch admission path lives in src/dispatch/gateway-host.js now.
  const start = gatewayHost.indexOf('async function dispatchToSession(');
  const end = gatewayHost.indexOf('\n  // ── Dispatch ↔', start);
  const body = gatewayHost.slice(start, end);
  const guard = body.indexOf('opts.requireIdle && isTargetBusy(chatId)');
  const admission = body.indexOf('getOrchestrationRuntime().admitDispatch(');
  assert.ok(guard >= 0 && admission > guard);
  assert.match(gatewayHost, /validateDispatchTarget\(targetId, fromSessionId = null, allowCommander = false\)/);
  assert.match(gatewayHost, /rec\.type === 'commander' && !allowCommander/);
  assert.match(source, /isBusy: dispatchTargetBusy/);
  assert.match(gatewayHost, /oneWay: !!opts\.oneWay/);
  assert.match(source, /replayRecoveredDispatchEffects: \(\) => \{\}/);
});

test('legacy Commander marker admission uses the canonical task source and honest queue receipt', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const gatewayHost = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'dispatch', 'gateway-host.js'),
    'utf8',
  );
  const legacyRoute = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'dispatch', 'legacy-commander-route.js'),
    'utf8',
  );
  const start = gatewayHost.indexOf('function maybeDispatchFromChatTurn(');
  const body = gatewayHost.slice(start);
  assert.ok(start >= 0);
  assert.match(body, /routeLegacyCommanderMarkers/);
  assert.match(legacyRoute, /taskSource: 'commander'/);
  assert.doesNotMatch(legacyRoute, /taskSource: 'commander-route'/);
  assert.match(legacyRoute, /explicitlyNamesTerminal\(sourceUserText, terminal\)/);
  assert.match(legacyRoute, /已持久排队给/);
  assert.ok(legacyRoute.indexOf('已持久排队给') > legacyRoute.indexOf('.then(result =>'),
    'the receipt must be emitted only after durable admission resolves');
});

test('legacy Commander marker reuses chat workers and keeps terminal gateways internal', async () => {
  const records = new Map([
    ['chat-a', { id: 'chat-a', kind: 'chat', dirId: 'dir-1', label: 'Worker A' }],
    ['chat-b', { id: 'chat-b', kind: 'chat', dirId: 'dir-2', label: 'Worker B' }],
    ['term-a', { id: 'term-a', kind: 'terminal', dirId: 'dir-1', label: 'Terminal A' }],
    ['term-a-gw-chat', {
      id: 'term-a-gw-chat', kind: 'chat', dirId: 'dir-1',
      ephemeral: true, label: 'Terminal A (gw)',
    }],
  ]);
  const calls = [];
  const notices = [];
  const base = {
    dispatcherId: 'commander',
    from: { id: 'commander', type: 'commander', dirId: 'dir-1' },
    sourceKey: 'source-1',
    records,
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
    isPlaceholder: () => false,
    validateTarget: target => {
      const rec = records.get(target);
      return rec ? { ok: true, rec } : { ok: false, error: 'missing' };
    },
    appendEvent: () => {},
    dispatch: async (target, message, options) => {
      calls.push({ target, message, options });
      return {
        ok: true,
        chatId: target === 'term-a' ? 'term-a-gw-chat' : target,
      };
    },
    inject: text => notices.push(text),
  };

  const genericTerminal = routeLegacyCommanderMarkers({
    ...base,
    markers: [{ target: 'term-a', message: 'install terminal software' }],
    sourceUserText: '给我安装好 zcode 和 qoder 终端',
  });
  assert.equal(genericTerminal.length, 0);
  assert.equal(calls.length, 0);
  assert.match(notices.pop(), /没有点名/);

  const gateway = routeLegacyCommanderMarkers({
    ...base,
    markers: [{ target: 'term-a-gw-chat', message: 'x' }],
    sourceUserText: '派给 term-a',
  });
  assert.equal(gateway.length, 0);
  assert.match(notices.pop(), /执行网关/);

  const crossDirectory = routeLegacyCommanderMarkers({
    ...base,
    markers: [{ target: 'chat-b', message: 'cross-directory task' }],
    sourceUserText: '完成任务',
  });
  assert.equal(crossDirectory.length, 0);
  assert.match(notices.pop(), /同目录/);

  const chat = routeLegacyCommanderMarkers({
    ...base,
    markers: [{ target: 'chat-a', message: 'reuse existing worker' }],
    sourceUserText: '完成任务',
  });
  await Promise.all(chat);
  assert.equal(calls.at(-1).target, 'chat-a');
  assert.equal(calls.at(-1).options.taskSource, 'commander');
  assert.match(notices.pop(), /已持久排队给/);

  const terminal = routeLegacyCommanderMarkers({
    ...base,
    markers: [{ target: 'term-a', message: 'run there' }],
    sourceUserText: '明确派给 Terminal A',
  });
  await Promise.all(terminal);
  assert.equal(calls.at(-1).target, 'term-a');
  assert.match(notices.pop(), /实际执行会话「term-a-gw-chat」/);
});

test('onTurnEnd skips aux/gateway sessions, short replies and injected turns', () => {
  const { runtime, auxCalls, deps } = mkRuntime();
  runtime.onTurnEnd({ currentUserText: 'x', currentAssistantText: '短' }, 'sess-1');
  deps.records.set('__aux__', { kind: 'chat', type: 'aux', dirId: 'dir-1' });
  runtime.onTurnEnd({ currentUserText: '实现任务板', currentAssistantText: 'a'.repeat(50) }, '__aux__');
  runtime.onTurnEnd({ currentUserText: '实现任务板', currentAssistantText: 'a'.repeat(50) }, 'unknown-session');
  assert.equal(auxCalls.length, 0);
});

test('legacy marker turns still attach without re-enabling AI task creation', () => {
  const { runtime, auxCalls } = mkRuntime();
  const seeded = runtime.getBoard();
  seeded.tasks['tsk-seed'] = {
    id: 'tsk-seed', moduleId: null, title: '种子任务', status: 'active',
    areas: [], createdAt: 1, updatedAt: 1, refs: [],
  };
  runtime.onTurnEnd({
    currentUserText: '【任务：种子任务｜tb:tsk-seed】\n继续做',
    currentAssistantText: '好的，已经继续推进并完成了相应的修改内容，包括删除按钮与确认弹窗的实现细节说明。',
  }, 'sess-1');
  assert.equal(seeded.tasks['tsk-seed'].refs.length, 1);
  assert.equal(auxCalls.length, 0);

  // Short-reply routed turn still attaches deterministically (no AI pass).
  runtime.onTurnEnd({
    currentUserText: '【任务：种子任务｜tb:tsk-seed】\n继续',
    currentAssistantText: '收到',
  }, 'sess-1');
  assert.equal(auxCalls.length, 0);
});

test('REST: board, messages, send and status flow', async () => {
  const { runtime, dispatches, sessionMessages } = mkRuntime();
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
  };
  runtime.mountRoutes(app);
  assert.deepEqual([...routes.keys()], [
    'GET /api/task-board',
    'GET /api/task-board/tasks/:taskId/messages',
    'POST /api/task-board/tasks/:taskId/send',
    'POST /api/task-board/tasks/:taskId/status',
    'POST /api/task-board/archive-completed',
    'POST /api/task-board/tasks/:taskId/reclassify',
    'POST /api/task-board/send',
    'POST /api/task-board/backfill',
    'POST /api/task-board/reclassify-pending',
  ]);

  // seed one task with a ref
  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 20, excerpt: 'x' }, 20);
  const tid = Object.keys(runtime.getBoard().tasks)[0];

  const res = () => {
    const r = { code: 200, body: null, headersSent: false };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; r.headersSent = true; return r; };
    return r;
  };

  const boardRes = res();
  routes.get('GET /api/task-board')({}, boardRes);
  assert.equal(boardRes.body.ok, true);
  assert.equal(boardRes.body.tasks.length, 1);
  assert.equal(boardRes.body.sessionLabels['sess-1'], '工程师1');

  const msgRes = res();
  routes.get('GET /api/task-board/tasks/:taskId/messages')({ params: { taskId: tid } }, msgRes);
  assert.equal(msgRes.body.items.length, 2);
  assert.equal(msgRes.body.items[0].role, 'user');
  assert.equal(msgRes.body.items[0].messageId, 'mu1');
  assert.equal(msgRes.body.items[0].sessionLabel, '工程师1');
  assert.equal(msgRes.body.items[1].role, 'assistant');
  assert.equal(msgRes.body.items[1].messageId, 'ma1');

  const missRes = res();
  routes.get('GET /api/task-board/tasks/:taskId/messages')({ params: { taskId: 'nope' } }, missRes);
  assert.equal(missRes.code, 404);

  const sendRes = res();
  routes.get('POST /api/task-board/tasks/:taskId/send')(
    { params: { taskId: tid }, body: { text: '加个删除按钮' } }, sendRes);
  await new Promise(r => setImmediate(r));
  assert.equal(sendRes.body.ok, true);
  assert.equal(sendRes.body.target, 'commander-1');
  assert.equal(sendRes.body.routingMode, 'commander');
  // Commander mode: message delivered via sendSessionMessage, no synchronous dispatch
  assert.equal(sessionMessages.length >= 1, true, 'message delivered to Commander');
  assert.equal(sessionMessages.length, 1);
  assert.equal(sessionMessages[0].sessionId, 'commander-1');
  assert.equal(sessionMessages[0].text, '加个删除按钮');
  assert.equal(sessionMessages[0].options.taskId, tid);
  assert.equal(sessionMessages[0].options.taskStart, false);
  assert.equal(sessionMessages[0].options.taskSource, 'task-board');

  const stRes = res();
  routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: tid }, body: { status: 'done' } }, stRes);
  await new Promise(r => setImmediate(r));
  assert.equal(stRes.body.ok, true);
  assert.equal(runtime.getBoard().tasks[tid].status, 'done');

  const archiveRes = res();
  routes.get('POST /api/task-board/archive-completed')({ body: {} }, archiveRes);
  assert.equal(archiveRes.body.ok, true);
  assert.equal(archiveRes.body.archivedCount, 1);
  assert.deepEqual(archiveRes.body.taskIds, [tid]);
  assert.equal(runtime.getBoard().tasks[tid].status, 'archived');

  const badRes = res();
  routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: tid }, body: { status: 'weird' } }, badRes);
  assert.equal(badRes.code, 400);
});

test('bulk cleanup archives only completed tasks in scope and is idempotent', () => {
  const { runtime, broadcasts } = mkRuntime({
    getSessionRunState: sid => sid === 'session-done-by-session' ? 'done' : 'idle',
  });
  const board = runtime.getBoard();
  const add = (id, dirId, status, runState) => {
    const task = core.createPendingTask(board, {
      taskId: id, dirId, sessionId: `session-${id}`, now: 1,
    });
    task.status = status;
    task.runState = runState;
    return task;
  };
  const byClassify = add('done-by-classify', 'dir-1', 'active', 'done');
  const bySession = add('done-by-session', 'dir-1', 'active', 'idle');
  delete bySession.runState;
  const byStatus = add('done-by-status', 'dir-1', 'done', 'running');
  const waiting = add('still-waiting', 'dir-1', 'active', 'waiting');
  const otherDir = add('other-directory', 'dir-2', 'active', 'done');
  const alreadyArchived = add('already-archived', 'dir-1', 'archived', 'done');
  const routes = new Map();
  runtime.mountRoutes({
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
  });
  const response = () => ({
    code: 200,
    status(c) { this.code = c; return this; },
    json(body) { this.body = body; return this; },
  });

  const first = response();
  routes.get('POST /api/task-board/archive-completed')(
    { body: { dirId: 'dir-1' } }, first);
  assert.equal(first.body.archivedCount, 3);
  assert.deepEqual(
    new Set(first.body.taskIds),
    new Set([byClassify.id, bySession.id, byStatus.id]),
  );
  assert.equal(byClassify.status, 'archived');
  assert.equal(bySession.status, 'archived');
  assert.equal(byStatus.status, 'archived');
  assert.equal(waiting.status, 'active');
  assert.equal(otherDir.status, 'active');
  assert.equal(alreadyArchived.status, 'archived');
  assert.deepEqual(broadcasts.at(-1).payload.taskIds.sort(), first.body.taskIds.sort());

  const second = response();
  routes.get('POST /api/task-board/archive-completed')(
    { body: { dirId: 'dir-1' } }, second);
  assert.equal(second.body.archivedCount, 0);
  assert.deepEqual(second.body.taskIds, []);
});

test('task board cleanup controls use the bulk archive endpoint and display-state predicate', () => {
  const manage = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  const meta = fs.readFileSync(path.join(__dirname, '..', 'public', 'meta.html'), 'utf8');
  for (const source of [manage, meta]) {
    assert.match(source, /一键清理/);
    assert.match(source, /\/api\/task-board\/archive-completed/);
    assert.match(source, /MultiCCTaskBoardUi\.taskDisplayState\(t\)\.done/);
  }
  assert.match(manage, /JSON\.stringify\(\{ dirId \}\)/);
  assert.match(meta, /body: '\{\}'/);
});

test('task rows expose quick archive immediately after the classify action', () => {
  const manage = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  const meta = fs.readFileSync(path.join(__dirname, '..', 'public', 'meta.html'), 'utf8');

  assert.match(manage, /_tbModuleAssignmentHtml\(task\)[\s\S]*?_tbQuickArchiveHtml\(task\)/);
  assert.match(manage, /archiveTaskBoardTask\(event,'\$\{_tbEsc\(task\.id\)\}',this\)/);
  assert.match(meta,
    /\$\{assignment \? `<button class="tb-reclassify"[\s\S]*?<\/button>` : ''\}<button class="tb-quick-archive"/);
  for (const source of [manage, meta]) {
    assert.match(source, /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/status/);
    assert.match(source, /归档该任务？（从任务板隐藏，数据保留）/);
    assert.match(source, /stopPropagation\(\)/);
  }
});

test('automatic board routing is Commander-first even with multiple active ordinary sessions', async () => {
  const commanderCalls = [];
  const workerCalls = [];
  const records = new Map([
    ['worker-newest', { id: 'worker-newest', kind: 'chat', dirId: 'dir-1', label: '最近活跃 worker', active: true, lastActivity: 999 }],
    ['worker-other', { id: 'worker-other', kind: 'chat', dirId: 'dir-1', label: '普通 worker', status: 'running' }],
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: '稳定角色 Commander' }],
  ]);
  const { runtime } = mkRuntime({
    records,
    isSessionBusy: sid => sid !== 'commander-1',
    dispatchToSession: async (target, message, opts) => {
      workerCalls.push({ target, message, opts });
      return { ok: true, chatId: target, operationId: 'op-command', status: 'admitted' };
    },
    routeCommanderTask: async request => {
      commanderCalls.push(request);
      return { ok: true, targetSessionId: 'worker-newest', targetLabel: '最近活跃 worker', operationId: 'op-command', status: 'admitted' };
    },
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', text: '修复任务详情路由' } }, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.code, 200);
  assert.equal(res.body.target, 'commander-1');
  assert.equal(res.body.commanderSessionId, 'commander-1');
  assert.equal(res.body.routingMode, 'commander');
  assert.equal(commanderCalls.length, 0, 'task board no longer calls routeCommanderTask synchronously');
  assert.equal(workerCalls.length, 0, 'task board must never bypass Commander');
  assert.equal(res.body.workerSessionId, null, 'worker assignment happens async via LLM <<route>> markers');
});

test('same panel client id reuses taskId and operation without a second Commander decision', async () => {
  const commanderCalls = [];
  const replayCalls = [];
  const { runtime, sessionMessages } = mkRuntime({
    routeCommanderTask: async request => {
      commanderCalls.push(request);
      return {
        ok: true, targetSessionId: 'sess-1', targetLabel: '工程师1',
        operationId: 'op-idempotent', status: 'admitted',
      };
    },
    dispatchToSession: async (target, message, opts) => {
      replayCalls.push({ target, message, opts });
      return {
        ok: true, chatId: target, operationId: 'op-idempotent',
        status: 'admitted', duplicate: true,
      };
    },
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const response = () => ({
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const request = {
    body: {
      dirId: 'dir-1',
      text: '幂等任务正文',
      clientMsgId: 'stable-client-message',
    },
  };
  const first = response();
  routes.get('/api/task-board/send')(request, first);
  await new Promise(resolve => setImmediate(resolve));
  const second = response();
  routes.get('/api/task-board/send')(request, second);
  await new Promise(resolve => setImmediate(resolve));

  // Commander mode: taskId is null (async routing), both calls deliver to Commander
  assert.equal(first.body.taskId, null);
  assert.equal(second.body.taskId, null);
  assert.equal(first.body.routingMode, 'commander');
  assert.equal(second.body.routingMode, 'commander');
  assert.equal(sessionMessages.length, 2);
  assert.equal(sessionMessages[0].options.clientMsgId, 'stable-client-message');
  assert.equal(sessionMessages[1].options.clientMsgId, 'stable-client-message');

  const changedRoute = response();
  routes.get('/api/task-board/send')({
    body: { ...request.body, target: 'sess-1' },
  }, changedRoute);
  await new Promise(resolve => setImmediate(resolve));
  // With explicit target change, it's a manual route to a busy session → 409
  // Explicit target to a non-busy session succeeds as manual route
  assert.equal(changedRoute.code, 200);
  assert.equal(changedRoute.body.routingMode, 'manual');
});

test('panel routing sends the original user source through the canonical Commander session ingress', async () => {
  const { runtime, sessionMessages } = mkRuntime({
    routeCommanderTask: async () => ({
      ok: true, targetSessionId: 'sess-1', targetLabel: '工程师1',
      operationId: 'op-1', status: 'admitted', queued: false,
    }),
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', text: '让工程师改 README' } }, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.body.routingMode, 'commander');
  assert.deepEqual(sessionMessages, [{
    sessionId: 'commander-1',
    text: '让工程师改 README',
    options: {
      clientMsgId: sessionMessages[0].options.clientMsgId,
      taskSource: 'task-board',
      goalNote: '',
    },
  }]);
  assert.ok(sessionMessages[0].options.clientMsgId);
  assert.equal(JSON.stringify(runtime.getBoard()).includes('让工程师改 README'), false);
});

test('task body UI folds long text and escapes or text-renders untrusted content', () => {
  const manage = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8');
  const meta = fs.readFileSync(path.join(__dirname, '..', 'public', 'meta.html'), 'utf8');
  assert.match(manage, /tb-body-fold[\s\S]*?_tbEsc\(t\.body\)/);
  assert.match(manage, /tb-body-detail[\s\S]*?_tbEsc\(t\.body\)/);
  assert.match(meta, /tb-body-fold[\s\S]*?esc\(task\.body\)/);
  assert.match(meta, /querySelector\('\.tb-body-fold'\)[\s\S]*?stopPropagation/);
  assert.match(meta, /pre\.textContent = t\.body/);
  assert.match(meta, /reconcileSnapshot\(d\)/);
  assert.match(meta, /partitionTaskIdentity\(tasks\)/);
  assert.match(meta, /历史身份待确认/);
  assert.doesNotMatch(manage, /innerHTML\s*=\s*t\.body/);
  assert.doesNotMatch(meta, /innerHTML\s*=\s*t\.body/);
});

test('Commander busy state is irrelevant; worker queue receipt survives refresh', async () => {
  const commanderCalls = [];
  const workerCalls = [];
  const records = new Map([
    ['worker-idle', { id: 'worker-idle', kind: 'chat', dirId: 'dir-1', label: '空闲 worker' }],
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
  ]);
  const fixture = mkRuntime({
    records,
    isSessionBusy: sid => sid === 'commander-1',
    dispatchToSession: async (target, message, opts) => {
      workerCalls.push({ target, message, opts });
      return { ok: true, chatId: target, operationId: 'op-queued', status: 'admitted' };
    },
    routeCommanderTask: async request => {
      commanderCalls.push(request);
      return {
        ok: true, targetSessionId: 'worker-idle', targetLabel: '空闲 worker',
        operationId: 'op-queued', status: 'queued', queued: true,
      };
    },
  });
  const routes = new Map();
  fixture.runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', text: '排队任务' } }, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.body.ok, true);
  assert.equal(res.body.queued, false, 'queued is async now; Commander LLM decides routing');
  // Commander mode: no synchronous routing; message delivered to Commander for LLM to route
  assert.equal(fixture.sessionMessages.length >= 1, true, 'message delivered to Commander');
  assert.equal(res.body.commanderSessionId, 'commander-1');
  // No task routing saved synchronously
  assert.equal(res.body.taskId, null);
  // No synchronous routing data to verify on restart; Commander LLM routes async.
});

test('automatic routing fails closed without a same-directory typed Commander', async () => {
  const dispatches = [];
  for (const records of [
    new Map([
      ['active-worker', { id: 'active-worker', kind: 'chat', dirId: 'dir-1', label: 'Agent Commander', active: true }],
    ]),
    new Map([
      ['commander-other', { id: 'commander-other', kind: 'chat', type: 'commander', dirId: 'dir-2', label: 'Other Commander' }],
      ['worker-local', { id: 'worker-local', kind: 'chat', dirId: 'dir-1', label: '本地 worker' }],
    ]),
  ]) {
    const { runtime } = mkRuntime({
      records,
      dispatchToSession: async (...args) => { dispatches.push(args); return { ok: true }; },
    });
    const routes = new Map();
    runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', text: '不可越权路由' } }, res);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.code, 409);
    assert.equal(res.body.error, 'commander_not_found');
    assert.deepEqual(runtime.getBoard(), { modules: {}, tasks: {} });
  }
  assert.equal(dispatches.length, 0);
});

test('automatic routing is unavailable until Commander migration finishes, while manual targeting is unchanged', async () => {
  let migration = { ready: false, code: 'commander_migration_pending' };
  const { runtime, dispatches } = mkRuntime({
    getCommanderMigrationStatus: dirId => ({ ...migration, directoryId: dirId }),
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const response = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  const blocked = response();
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', text: '自动任务' } }, blocked);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(blocked.code, 503);
  assert.equal(blocked.body.error, 'commander_migration_pending');
  assert.equal(blocked.body.directoryId, 'dir-1');
  assert.equal(dispatches.length, 0);
  assert.deepEqual(runtime.getBoard(), { modules: {}, tasks: {} });

  const manual = response();
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', target: 'sess-1', text: '手工任务' } }, manual);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manual.code, 200);
  assert.equal(manual.body.routingMode, 'manual');
  assert.equal(dispatches.length, 1);

  migration = { ready: true, code: null };
  const automatic = response();
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', text: '迁移完成后自动任务' } }, automatic);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(automatic.code, 200);
  assert.equal(automatic.body.target, 'commander-1');
  // Commander mode: message delivered to Commander via sendSessionMessage
  assert.equal(automatic.body.routingMode, 'commander');
});

test('manual target remains worker-only and admits into the durable queue while busy', async () => {
  const commanderCalls = [];
  const workerCalls = [];
  const { runtime } = mkRuntime({
    dispatchToSession: async (target, message, opts) => {
      (opts.allowCommander ? commanderCalls : workerCalls).push({ target, message, opts });
      return { ok: true, chatId: target, operationId: 'op-manual', status: 'admitted' };
    },
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', target: 'sess-1', text: '手工任务' } }, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.body.routingMode, 'manual');
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].target, 'sess-1');
  assert.equal(workerCalls[0].opts.requireIdle, false);
  assert.equal(workerCalls[0].opts.oneWay, true);
  assert.equal(runtime.getBoard().tasks[res.body.taskId].routing.oneWay, true);
  assert.equal(commanderCalls.length, 0);

  const followup = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/tasks/:taskId/send')({
    params: { taskId: res.body.taskId },
    body: { target: 'sess-1', text: '手工继续任务' },
  }, followup);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(followup.code, 200);
  assert.equal(workerCalls.length, 2);
  assert.equal(workerCalls[1].opts.oneWay, true);
  assert.equal(runtime.getBoard().tasks[res.body.taskId].routing.oneWay, true);
});

test('Commander chat input uses the same card-first one-way route as the board composer', async () => {
  const routed = [];
  const { runtime } = mkRuntime({
    routeCommanderTask: async request => {
      routed.push(request);
      return {
        ok: true, targetSessionId: 'sess-1', targetLabel: '工程师1',
        operationId: 'op-chat-input', status: 'admitted', queued: false,
      };
    },
  });
  const result = await runtime.routeCommanderInput('commander-1', '实现新的路由入口', {
    idempotencyKey: 'client-message-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetSessionId, 'sess-1');
  assert.equal(routed.length, 1);
  assert.equal(routed[0].commanderId, 'commander-1');
  assert.equal(routed[0].idempotencyKey, `task-start:${result.taskId}`);
  assert.match(routed[0].message, /Commander 单向路由任务/);
  assert.doesNotMatch(routed[0].message, /tb:/);
  assert.equal(routed[0].taskId, result.taskId);
  assert.equal(routed[0].taskStart, true);
  assert.equal(routed[0].taskSource, 'commander');
  assert.equal(routed[0].taskText, '实现新的路由入口');
  const task = runtime.getBoard().tasks[result.taskId];
  assert.equal(task.routing.targetSessionId, 'commander-1');
  assert.equal(task.routing.workerSessionId, 'sess-1');
  assert.equal(task.routing.oneWay, true);
});

test('backfill scans dir sessions, tags turns via aux and reports progress', async () => {
  const auxCalls = [];
  const { runtime } = mkRuntime({
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue(task) {
        auxCalls.push(task);
        // Immediately resolve with a verdict putting turns 1+2 in one task.
        return Promise.resolve({
          cancelled: false,
          text: '{"tasks":[{"id":"new","title":"历史任务","module":"服务端","areas":["src/x.js"],"turns":[1,2]}]}',
        });
      },
    },
    loadHistory: () => [
      { id: 'u1', role: 'user', content: '做第一件事', ts: 10 },
      { id: 'a1', role: 'assistant', content: '第一件事完成', ts: 20 },
      { id: 'uSys', role: 'user', content: '[任务询问] 系统注入', ts: 25 },
      { id: 'aSys', role: 'assistant', content: '注入回复', ts: 26 },
      { id: 'u2', role: 'user', content: '继续第二步', ts: 30 },
      { id: 'aInt', role: 'assistant', content: '临时', ts: 31, _interim: true },
      { id: 'a2', role: 'assistant', content: '第二步完成', ts: 40 },
    ],
    isSystemInjected: (t) => t.startsWith('['),
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/backfill')({ body: { dirId: 'dir-1' } }, r);
  await new Promise(rr => setTimeout(rr, 10));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.queued, 1);
  assert.equal(auxCalls.length, 1);
  assert.equal(auxCalls[0].type, 'task_backfill');
  assert.match(auxCalls[0].prompt, /【轮次 1】/);
  assert.match(auxCalls[0].prompt, /【轮次 2】/);
  assert.doesNotMatch(auxCalls[0].prompt, /系统注入/);
  const board = runtime.getBoard();
  const task = Object.values(board.tasks).find(t => t.title === '历史任务');
  assert.ok(task);
  assert.deepEqual(task.refs.map(x => x.assistantMsgId), ['a1', 'a2']);
});

test('backfill reports unhealthy aux and concurrent runs', async () => {
  let healthy = true;
  const { runtime } = mkRuntime({
    auxQueue: {
      isUnhealthy: () => !healthy,
      cancel: () => {},
      enqueue: () => new Promise(() => {}),   // hangs → keeps backfill running
    },
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const mk = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  healthy = false;
  const r1 = mk();
  routes.get('/api/task-board/backfill')({ body: {} }, r1);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r1.code, 503);

  healthy = true;
  const r2 = mk();
  routes.get('/api/task-board/backfill')({ body: {} }, r2);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r2.body.ok, true);

  const r3 = mk();
  routes.get('/api/task-board/backfill')({ body: {} }, r3);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r3.code, 409);
});

test('goal-flagged sends prepend the goal note; board-level send routes by dir', async () => {
  const { runtime, dispatches, sessionMessages } = mkRuntime({
    records: new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', dirId: 'dir-1', label: '项目整体推进工程师' }],
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
    ]),
    resolveGoalLimits: (o) => ({ maxRounds: Number(o?.maxRounds) || 200, maxBudget: Number(o?.maxBudget) || 0 }),
    buildGoalLimitNote: (l) => `[Goal 模式限制]\nrounds=${l.maxRounds}\n[限制结束]\n\n`,
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 20, excerpt: 'x' }, 20);
  const tid = Object.keys(runtime.getBoard().tasks)[0];

  const r1 = res();
  routes.get('POST /api/task-board/tasks/:taskId/send')(
    { params: { taskId: tid }, body: { text: '继续', goal: true, goalLimits: { maxRounds: '50' } } }, r1);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r1.body.ok, true);
  // Commander mode: message delivered via sendSessionMessage with goal note
  assert.equal(sessionMessages.length >= 1, true);
  const cmdMsg = sessionMessages.find(m => m.sessionId === 'commander-1');
  assert.ok(cmdMsg, 'Commander received the message');
  assert.match(cmdMsg.options.goalNote || '', /rounds=50/);

  const r2 = res();
  routes.get('POST /api/task-board/send')(
    { body: { dirId: 'dir-1', text: '整体推进一下' } }, r2);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.target, 'commander-1');
  assert.equal(r2.body.routingMode, 'commander');
  // Commander mode: taskId is null (async routing via LLM <<route>> markers)
  assert.equal(r2.body.taskId, null);
  assert.equal(r2.body.routingMode, 'commander');

  const r3 = res();
  routes.get('POST /api/task-board/send')({ body: { dirId: 'nope', text: 'x' } }, r3);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r3.code, 409);
});

test('goal flag is ignored gracefully when goal helpers are not wired', async () => {
  const { runtime, dispatches } = mkRuntime();
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('POST /api/task-board/send')(
    { body: { dirId: 'dir-1', target: 'sess-1', text: 'hi', goal: true, goalLimits: { maxRounds: 5 } } }, r);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r.body.ok, true);
  assert.equal(dispatches[0].message, '【任务：新任务】\nhi');
  assert.equal(dispatches[0].opts.taskStart, true);
});

test('board placeholder stays in 待归类 at turn end (方案A：仅手动归类)', async () => {
  let history = [];
  const { runtime, dispatches, auxCalls } = mkRuntime({
    loadHistory: () => history,
    records: new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', dirId: 'dir-1', label: '任务板重新归类工程师' }],
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
    ]),
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('POST /api/task-board/send')({ body: { dirId: 'dir-1', text: '增加手动重新归类按钮' } }, r);
  await new Promise(rr => setImmediate(rr));
  // Commander mode: message delivered to Commander, routing is async.
  // No taskId in response; no dispatch called synchronously.
  assert.equal(r.body.taskId, null);
  assert.equal(r.body.routingMode, 'commander');
  // Simulate a worker turn that was routed by Commander's LLM (async path).
  const simTaskId = 'tsk-simulated12345';
  history = [
    {
      id: 'u-new', role: 'user', content: '增加手动重新归类按钮', ts: 30,
      taskId: simTaskId, taskStart: true, taskSource: 'commander-route',
      taskText: '增加手动重新归类按钮',
    },
    {
      id: 'a-new', role: 'assistant',
      content: '已经完成按钮、接口以及失败重试状态的实现。', ts: 40, taskId: simTaskId,
    },
  ];
  runtime.onMessagePersisted('sess-1', history[0]);
  runtime.onMessagePersisted('sess-1', history[1]);
  await new Promise(rr => setImmediate(rr));
  const board = runtime.getBoard();
  const tasks = Object.values(board.tasks);
  assert.equal(auxCalls.length, 0);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, simTaskId);
  assert.equal(tasks[0].title, '增加手动重新归类按钮');
  assert.ok(tasks[0].moduleAssignment, '占位卡仍待归类');
  assert.equal(board.modules[tasks[0].moduleId].source, 'classify');
  assert.ok(tasks[0].refs.some(ref => ref.assistantMsgId === 'a-new'), '本轮 ref 已挂到占位卡');
});

test('manual reclassify retries a failed pending card and exposes batch route', async () => {
  const history = [
    { id: 'u1', role: 'user', content: '实现重试', ts: 1 },
    { id: 'a1', role: 'assistant', content: '已经完成详细实现内容。', ts: 2 },
  ];
  const { runtime, auxCalls, resolveAux } = mkRuntime({ loadHistory: () => history });
  const pending = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '实现重试', now: 1,
  });
  pending.refs[0].userMsgId = 'u1';
  pending.refs[0].assistantMsgId = 'a1';
  pending.moduleAssignment.lastError = 'previous_failure';
  pending.moduleAssignment.attempts = 5;
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  const single = res();
  routes.get('POST /api/task-board/tasks/:taskId/reclassify')({ params: { taskId: pending.id }, body: {} }, single);
  assert.equal(single.body.ok, true);
  assert.equal(auxCalls.length, 1);
  assert.equal(pending.moduleAssignment.running, true);
  assert.equal(pending.moduleAssignment.attempts, 6);
  resolveAux({ cancelled: false, text: '{"tasks":[]}' });
  await new Promise(rr => setImmediate(rr));
  assert.equal(pending.moduleAssignment.running, false);
  assert.equal(pending.moduleAssignment.lastError, 'empty_classification');

  const batch = res();
  routes.get('POST /api/task-board/reclassify-pending')({ body: { dirId: 'dir-1' } }, batch);
  assert.equal(batch.body.ok, true);
  assert.equal(batch.body.queued, 1);
});

test('automatic pending scan no longer auto-classifies (方案A：仅手动归类)', async () => {
  const history = [
    { id: 'u1', role: 'user', content: '需要自动归类', ts: 1 },
    { id: 'a1', role: 'assistant', content: '已经完成这项任务的完整实现。', ts: 2 },
  ];
  const { runtime, auxCalls } = mkRuntime({ loadHistory: () => history });
  const pending = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '需要自动归类', now: 1,
  });
  pending.refs[0].userMsgId = 'u1';
  pending.refs[0].assistantMsgId = 'a1';

  // 方案A：定时扫描不再触发自动归类——卡片原地停在「待归类」，attempts 不增长，
  // 也不排队 aux 任务。用户手动点「归类」才会分类。
  assert.equal(runtime.scanPendingClassifications(), 0);
  assert.equal(auxCalls.length, 0);
  assert.equal(pending.moduleAssignment.attempts, 0);
  assert.equal(pending.moduleAssignment.running, false);
  assert.equal(Object.values(runtime.getBoard().modules).some(m => m.source === 'classify'), true);

  // A persisted in-flight assignment has no live Aux owner after restart. The
  // startup pass marks only that operation interrupted and still queues no AI.
  pending.moduleAssignment.running = true;
  assert.equal(runtime.scanPendingClassifications(99), 1);
  assert.equal(pending.moduleAssignment.running, false);
  assert.equal(pending.moduleAssignment.lastError, 'classification_interrupted');
  assert.equal(auxCalls.length, 0);
});

test('manual classification can use the submitted task text before a reply exists', async () => {
  const history = [];
  const { runtime, auxCalls, resolveAux } = mkRuntime({ loadHistory: () => history });
  const pending = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '先实现一个归类按钮', now: 1,
  });
  const user = {
    id: 'u-pending', role: 'user', content: '【任务：新任务】\n先实现一个归类按钮',
    taskId: pending.id, taskStart: true, taskSource: 'task-board',
    taskText: '先实现一个归类按钮', ts: 2,
  };
  history.push(user);
  runtime.onMessagePersisted('sess-1', user);
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('POST /api/task-board/tasks/:taskId/reclassify')({ params: { taskId: pending.id }, body: {} }, r);
  assert.equal(r.body.ok, true);
  assert.match(auxCalls[0].prompt, /尚无助手回复/);
  resolveAux({
    cancelled: false,
    text: `{"tasks":[{"id":"${pending.id}","title":"实现归类按钮","module":"任务板","areas":[]}]}`,
  });
  await new Promise(rr => setImmediate(rr));
  assert.equal(runtime.getBoard().tasks[pending.id].title, '实现归类按钮');
});

test('reclassifying an input-less card returns a note guiding the user to delete it', () => {
  // Supplement over b81218f: a card whose refs resolve to no user text can never
  // be classified. The reclassify note must give an actionable exit (delete the
  // dead card) instead of only reporting that content is "missing".
  const { runtime } = mkRuntime({ loadHistory: () => [] });
  const pending = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '够不到的种子', now: 1,
  });
  pending.refs.length = 0;   // corrupt: no refs → resolveTaskClassificationInput returns null
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('POST /api/task-board/tasks/:taskId/reclassify')({ params: { taskId: pending.id }, body: {} }, r);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, 'missing_context');
  assert.match(r.body.note, /删除/);   // actionable: tells the user to delete the dead card
});

test('authenticated task-board mutations do not depend on transport locality', async () => {
  const { runtime } = mkRuntime();
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const task = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '允许远程归档', now: 1,
  });
  const response = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const remoteRequest = { socket: { remoteAddress: '203.0.113.10' }, headers: { host: 'dashboard.example.com' } };

  const status = response();
  routes.get('/api/task-board/tasks/:taskId/status')({
    ...remoteRequest, params: { taskId: task.id }, body: { status: 'archived' },
  }, status);
  assert.equal(status.code, 200);
  assert.equal(status.body.task.status, 'archived');

  const completed = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '允许远程批量归档', now: 2,
  });
  completed.status = 'done';
  const cleanup = response();
  routes.get('/api/task-board/archive-completed')({
    ...remoteRequest, body: { dirId: 'dir-1' },
  }, cleanup);
  assert.equal(cleanup.code, 200);
  assert.equal(cleanup.body.archivedCount, 1);
  assert.equal(completed.status, 'archived');

  const missingSend = response();
  routes.get('/api/task-board/tasks/:taskId/send')({
    ...remoteRequest, params: { taskId: 'missing' }, body: { text: 'hi' },
  }, missingSend);
  await new Promise(rr => setImmediate(rr));
  assert.equal(missingSend.code, 404);
  assert.equal(missingSend.body.error, 'task_not_found');

  const retry = response();
  routes.get('/api/task-board/tasks/:taskId/reclassify')({
    ...remoteRequest, params: { taskId: 'missing' }, body: {},
  }, retry);
  assert.equal(retry.code, 404);
});

test('failed board dispatch rolls back its placeholder and empty pending module', async () => {
  const { runtime } = mkRuntime({
    dispatchToSession: async () => ({ ok: false, error: 'dispatch_failed' }),
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-1', target: 'sess-1', text: '不会成功的任务' } }, r);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r.code, 502);
  assert.deepEqual(runtime.getBoard(), { modules: {}, tasks: {} });
});

test('manual task followup admits to the same durable queue even when the worker is busy', async () => {
  let busyChecks = 0;
  const { runtime, dispatches } = mkRuntime({ isSessionBusy: () => ++busyChecks >= 3 });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const task = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '修复任务跳转', now: 1,
  });
  const reply = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  const race = reply();
  routes.get('/api/task-board/tasks/:taskId/send')({
    params: { taskId: task.id }, body: { text: '继续修复跳转', target: 'sess-1' },
  }, race);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(race.code, 200);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].opts.requireIdle, false);

});

test('a durable admission failure rolls back the board placeholder', async () => {
  const { runtime } = mkRuntime({
    dispatchToSession: async () => ({ ok: false, error: 'queue_unavailable', code: 'queue_unavailable' }),
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/send')({
    body: { dirId: 'dir-1', target: 'sess-1', text: '修复前端消息跳转' },
  }, r);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.code, 502);
  assert.equal(r.body.error, 'queue_unavailable');
  assert.deepEqual(runtime.getBoard(), { modules: {}, tasks: {} });
});

test('board persists across runtime restarts', () => {
  const { runtime, file, deps } = mkRuntime();
  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: '持久化', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'u', assistantMsgId: 'a', ts: 1, excerpt: 'x' }, 1);
  runtime.save();
  const rt2 = createTaskBoardRuntime(deps);
  assert.equal(Object.values(rt2.getBoard().tasks)[0].title, '持久化');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
