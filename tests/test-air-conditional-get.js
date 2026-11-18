'use strict';
// 旧客户端仍保留兼容快照读取，新首页通过增量同步获取状态。详情（线上约 580KB）和当前任务详情
// （实测 3.5MB，其中 3.2MB 是消息正文）。内容没变时必须能 304 收场，否则
// 服务端每轮都要把这几 MB 写出去、浏览器每轮都要解析并重建一遍 DOM。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountAir } = require('./helpers/air-host');

function snapshotFixture() {
  const board = { tasks: { tsk_1: { id: 'tsk_1', title: '任务', status: 'active', refs: [{ sessionId: 's', dirId: 'd1' }] } } };
  // 正文与 ETag 在宿主定稿；304 判定在前门（native/core/src/air_routes.rs）。
  const air = mountAir({
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: { residentLimit: 4 } }), capacityReason: () => null },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex' }]]), directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => board, clis: ['codex'], shell: { taskAccess: () => ({ readOnly: true }) },
  });
  return { air, board };
}

test('/api/air 的校验器由正文派生：内容没变 ETag 就一样，变了才不一样', async () => {
  const { air, board } = snapshotFixture();
  const first = await air.snapshot();
  assert.match(first.etag, /^W\//, 'ETag 必须是弱校验器（正文派生）');
  assert.equal(first.json.tasks.length, 1);

  // 前门拿 If-None-Match 与这份 ETag 比对：同一份内容必须命中，所以宿主再算一遍
  // 必须逐字节复现同一份正文与同一份校验器（否则客户端的 304 永远拿不到）。
  const second = await air.snapshot(first.etag);
  assert.equal(second.etag, first.etag, '同一份内容必须给出同一个校验器');
  assert.equal(second.body, first.body, '同一份内容必须逐字节同一份正文');

  board.tasks.tsk_2 = { id: 'tsk_2', title: '新任务', status: 'active', refs: [{ sessionId: 's', dirId: 'd1' }] };
  const changed = await air.snapshot(first.etag);
  assert.notEqual(changed.etag, first.etag, '内容变了校验器必须变');
  assert.equal(changed.json.tasks.length, 2);
});

test('/api/air 不把迁移的内部 task 全表随正文发出去', async () => {
  const marker = 'MARKER_TASK_BODY';
  // 宿主为了省掉第二遍全表扫描，会把迁移读到的 task 全表跟着结果带回来
  // （src/task-shell/host.js）。这份内部载荷一旦进了快照，每轮正文会从 0.74MB
  // 涨到 5.5MB —— 客户端只用 migration.errors，不该付这份钱。
  const air = mountAir({
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }), capacityReason: () => null },
    records: new Map(), directories: new Map(), getBoard: () => ({ tasks: {} }), clis: [],
    shell: {
      migrateTaskSessions: async () => ({ ok: true, migrated: ['t1'], errors: [],
        tasks: [{ id: 't1', blob: marker.repeat(400) }] }),
      taskAccess: () => ({ readOnly: true }),
    },
  });
  const { body, json: payload } = await air.snapshot();
  assert.equal(payload.migration.tasks, undefined, '内部 task 全表不能进正文');
  assert.deepEqual(payload.migration.migrated, ['t1'], '其余字段照旧透传');
  assert.equal(payload.migration.ok, true);
  assert.ok(!body.includes(marker), '正文里不该出现任务体内容');
});

test('/api/air/tasks/:id 详情同样由正文派生校验器（3.5MB 的消息正文不再每 15 秒重传）', async () => {
  let messages = [{ id: 'm1', role: 'user', content: 'x'.repeat(64) }];
  // 详情正文与 ETag 都在宿主定稿：前门只做 304 判定后原样发出。
  const air = mountAir({
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }), capacityReason: () => null,
      deliveryEvidence: () => ({ run: null, integration: null }) },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex' }]]), directories: new Map([['d1', { id: 'd1', path: '/repo' }]]),
    getBoard: () => ({ tasks: {} }), clis: ['codex'],
    shell: { taskEntry: async id => ({ ok: true, task: { id, title: '任务' }, messages, execution: { busy: false }, sessionId: 's' }),
      attributionCandidate: () => null, roleBindings: () => null },
  });
  const first = await air.ok({ op: 'task-detail', taskId: 't' });
  assert.deepEqual(JSON.parse(first.body).messages, messages);
  assert.match(first.etag, /^W\//);

  const same = await air.ok({ op: 'task-detail', taskId: 't' });
  assert.equal(same.etag, first.etag, '同一份详情必须给出同一个校验器');
  assert.equal(same.body, first.body);

  messages = [...messages, { id: 'm2', role: 'assistant', content: 'y' }];
  const next = await air.ok({ op: 'task-detail', taskId: 't' });
  assert.notEqual(next.etag, first.etag, '新消息到达时必须换校验器，前门才会给完整详情');
  assert.equal(JSON.parse(next.body).messages.length, 2);
});

test('Air 前端显式发条件请求，并在 304 时跳过解析与重画', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'air.js'), 'utf8');
  const openEntry = fs.readFileSync(path.join(__dirname, '..', 'public', 'air-task-entry.js'), 'utf8');
  assert.match(source, /'If-None-Match': knownEtag/, '轮询要带上上一次的 ETag');
  assert.match(source, /if \(conditional && response\.status === 304\) return \{ ok: true, unchanged: true \}/);
  // 通用 api() 不能带条件请求：别的 GET 调用方收到「没变」会当成空数据。
  assert.match(source, /const apiConditional = path => request\(path, \{ method: 'GET', body: undefined, conditional: true \}\);/);
  // live 时走 liveSync.sync() 而不是条件请求；sync 失败由 onIssue 挂持久告警，
  // 本轮按失败收尾而不是把异常抛给外层当 304 处理。
  assert.match(source, /if \(liveSync\) \{ try \{ await liveSync\.sync\(\); \} catch \{ failed = true; return; \} \}/);
  assert.match(source, /const path = `\/api\/air\/tasks\/\$\{encodeURIComponent\(selected\)\}`;/);
  assert.match(source, /const result = await apiConditional\(path\);/);
  // 「没变」的前提是上一次那份正文还在手上。entry 会被 navigate / popstate /
  // dismissChat 清掉，ETag 却还留着 —— 那时再问一次只会换回 304，页头就停在
  // 「正在读取任务…」等这条任务下次真的变了。所以手里没有 entry 就先忘掉校验符。
  assert.match(source, /if \(entry\?\.task\?\.id !== selected\) resourceEtag\.delete\(path\);/);
  // 校验符只能记在正文被收下之后：失败响应也带 ETag（Express 自己生成的那个），
  // 提前记下来等于把一次失败固化成「永远 304」。
  assert.ok(source.indexOf('resourceEtag.set(path, etag)') > source.indexOf('if (!response.ok || result.ok === false)'),
    'ETag 要记在收下正文之后');
  assert.match(source, /if \(result\.unchanged\) return false;/, '详情没变就不重建会话区');
  assert.match(source, /if \(!snapshot\.unchanged\) \{\s*acceptSnapshot\(snapshot\);/, '兼容读取没变时跳过渲染');
  // 打开对话只核验轻量绑定；含审计历史的详情只在用户展开详情面板时读取。
  assert.match(openEntry, /\/api\/air\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/open/);
  assert.match(source, /MultiCCAirTaskEntry\?\.open\(\{ taskId, api, notice \}\)/);
  assert.match(source, /window\.__multiccAirTaskOpen\?\.taskId === taskId/);
  // 后台轮询只在详情面板展开时才要完整详情；页头刷新按钮走另一条路 —— 交付与
  // 归因不在面板里，所以按下去时即使面板是收起状态也要刷新选中的那条。
  assert.match(source, /taskId && \(refreshSelectedEntry \|\| !\$\('task-details'\)\.hidden\)\s*\? await refreshEntry\(\) : false/);
  assert.doesNotMatch(source, /void refreshEntry\(\);/, '导航不能再先下载完整详情');
  assert.match(source, /if \(snapshot\.unchanged && !entryChanged\) return;/);
  // 只有一个轮询档：15 秒（2026-09-30 要求活跃/后台/空闲全拉平，App 端
  // air_tasks_view.dart 的 _snapshotPollInterval 也是同一个数字）。
  assert.match(source, /const POLL_MS = 15000;/);
  // 分档机械已经删干净，别再长回来：三档同值后降档判断无档可降，留着只会误导。
  // 只钉声明与赋值（注释里会照实写到这些名字，那是删除记录，不是复活）。
  assert.doesNotMatch(source, /const POLL_HIDDEN_MS|const POLL_IDLE_MS|idleRounds\s*=/);
  // 判据不与「有没有卡片在跑」挂钩 —— 任务板上长期挂着别人留下的 running/queued 旧卡。
  assert.doesNotMatch(source, /anyRunning/);
  // 失败退避仍在，且以这唯一一档为底：别在服务端打嗝时持续加码。
  assert.match(source, /const delay = liveSync \? 60000 \+ Math\.random\(\) \* 5000 : pollFailures/);
});
