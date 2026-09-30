'use strict';
// 一轮 Air 快照线上要 ~390ms，而同一份数据、同一批语句在离线进程里只要 40~75ms。
// 差额既不在 SQL 条数也不在数据量上，于是有了分相位计时：它把一轮切成
// migrate / records / board / admission / 卡片循环 / 序列化，**只写日志**。
// 这个测试钉住四条：
//   1. 该打的那行打得出来，且带齐各段耗时与判读用的上下文（卡数、正文大小、状态码、
//      同进程校准值、以及「不在任何一段里」的差额）；
//   2. 正文与 ETag 逐字节不受影响：数字一旦进 payload，每轮快照都会"变"，客户端再也
//      拿不到 304 —— 那就等于为了诊断把代价乘十；
//   3. 静默与限流：默认阈值下快轮次一行不打、慢轮次也至少隔 gap 才打一行，否则日志
//      会比它要诊断的开销还贵（这接口每 15 秒一轮）；
//   4. 启动窗口那一档只在宿主接了 logger 时生效。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mountAirRoutes } = require('../src/workspace/air-routes');
const { airResponse } = require('./helpers/air-response');

// 日志契约：这十个分段名是对外可读的字段，改名要连测试一起改（别让日志悄悄少一段）。
const PHASE_MARKS = ['migrateMs', 'recordsMs', 'boardMs', 'admissionMs', 'admissionIndexMs',
  'cardListMs', 'cardLoopMs', 'tailMs', 'jsonMs', 'etagMs'];
const PAYLOAD_KEYS = ['ok', 'directories', 'tasks', 'taskPins', 'budgets', 'clis', 'migration',
  'lastRuntime', 'worktreePolicy', 'sessions'];
// 阈值压到 50ms、间隔清零：慢轮次必打、快轮次不打，两件事在同一个进程里都能验。
const EAGER = { logMs: 50, gapMs: 0, bootWindowS: 0, bootGapMs: 0 };
const DEFAULT_LIKE = { logMs: 200, gapMs: 30_000, bootWindowS: 0, bootGapMs: 30_000 };

// costMs 是每张卡片在 taskAccess 里空转的毫秒数：它就是「逐卡路径很贵」的可控版本。
function fixture({ costMs = 0, logger = true, diagnostics = EAGER } = {}) {
  const handlers = new Map(), lines = [];
  const app = { get: (path, fn) => handlers.set(path, fn), post() {} };
  // 空转按 hrtime 自己记一笔真实时长：Date.now() 只有毫秒刻度，拿它当断言会被读数
  // 截断坑到（实测两次 30ms 空转合计 58.9ms）。
  let burnedMs = 0;
  const burn = () => {
    const start = process.hrtime.bigint();
    const until = Date.now() + costMs;
    while (Date.now() < until);
    burnedMs += Number(process.hrtime.bigint() - start) / 1e6;
  };
  mountAirRoutes(app, {
    // 宿主真实接线里 server.js 会传 logger（air_snapshot_slow 就落在它上面）。
    ...(logger ? { logger: { warn: (event, fields) => lines.push({ event, fields }) } } : {}),
    phaseDiagnostics: diagnostics,
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: { residentLimit: 4 } }), capacityReason: () => null },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex' }]]),
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ tasks: {
      tsk_1: { id: 'tsk_1', title: '任务一', status: 'active', refs: [{ sessionId: 's', dirId: 'd1' }] },
      tsk_2: { id: 'tsk_2', title: '任务二', status: 'active', refs: [{ sessionId: 's', dirId: 'd1' }] },
    } }),
    clis: ['codex'],
    shell: { migrateTaskSessions: async () => ({ ok: true, errors: [] }),
      taskAccess: () => { burn(); return { readOnly: true }; } },
  });
  const phaseLines = () => lines.filter(line => line.event === 'air_snapshot_slow');
  return { handlers, lines, phaseLines, burnedMs: () => burnedMs };
}

const get = (handlers, headers) => {
  const res = airResponse();
  return handlers.get('/api/air')({ headers }, res).then(() => res);
};

test('慢轮次落一行 air_snapshot_slow，各段耗时与判读上下文齐全', async () => {
  const { handlers, phaseLines, burnedMs } = fixture({ costMs: 30 });   // 2 张卡 × 30ms 空转
  const res = await get(handlers, {});
  assert.equal(res.statusCode, 200);

  const lines = phaseLines();
  assert.equal(lines.length, 1, '一轮只该落一行');
  const fields = lines[0].fields;
  for (const name of PHASE_MARKS) {
    assert.equal(typeof fields[name], 'number', `缺分段 ${name}`);
    assert.ok(fields[name] >= 0, `${name} 不能是负数`);
  }
  assert.equal(fields.cardCount, 2, '卡数要随行下发，否则看不懂这段耗时对应多少东西');
  assert.equal(fields.status, 200);
  assert.ok(fields.bodyChars > 0, '正文大小要能对账');
  assert.equal(fields.inFlight, 0, '这一行是在响应发完之后打的，飞行中数量已归零');
  // 逐卡空转的合计必须落到 accessMs 上：这是「贵在逐卡路径」最直接的证据位。
  assert.ok(fields.accessMs >= burnedMs() - 1,
    `accessMs(${fields.accessMs}) 应覆盖两次空转实测合计 ${burnedMs().toFixed(1)}ms`);
  // 各段之和加差额必须等于总时长：对不上就说明这套分段会计本身失真了。
  const accounted = PHASE_MARKS.reduce((total, name) => total + fields[name], 0);
  assert.ok(Math.abs(accounted + fields.unaccountedMs - fields.totalMs) < 0.5,
    `分段之和 ${accounted} + 差额 ${fields.unaccountedMs} 与总时长 ${fields.totalMs} 对不上`);
  assert.ok(fields.totalMs >= burnedMs() - 1, `总时长应覆盖两次空转，实际 ${fields.totalMs}`);
  // 同进程校准值与内存快照：用来区分「这条路径更贵」和「这个进程当下的 CPU 就是慢」。
  assert.ok(fields.calibMs > 0, '校准值必须随行下发，否则 10× 倍率没法判读');
  assert.ok(fields.rssMB > 0 && fields.heapUsedMB > 0);
  assert.equal(typeof fields.uptimeSec, 'number');
});

test('304 那一轮同样计时，正文与 ETag 不受影响', async () => {
  const { handlers, phaseLines } = fixture({ costMs: 30 });
  const first = await get(handlers, {});
  const expected = `W/"${crypto.createHash('sha1').update(first.body).digest('base64url')}"`;
  assert.equal(first.headers.etag, expected, 'ETag 仍然只由正文派生');

  const second = await get(handlers, { 'if-none-match': first.headers.etag });
  assert.equal(second.statusCode, 304, '计时不许动摇条件请求');
  assert.equal(second.body, undefined);
  const lines = phaseLines();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].fields.status, 304, '304 也要留下耗时，否则「便宜的那一轮」没数据');
  assert.equal(lines[1].fields.cardCount, 2);
});

test('快轮次静默、慢轮次限流：日志不能比它诊断的开销还贵', async () => {
  const fast = fixture({ costMs: 0, diagnostics: DEFAULT_LIKE });
  assert.equal((await get(fast.handlers, {})).statusCode, 200);
  assert.equal(fast.phaseLines().length, 0, '低于阈值的一轮一行都不该打');

  // 默认间隔 30s：连着两轮都慢（每张卡 110ms 空转，稳稳越过 200ms 阈值），也只能落一行。
  const slow = fixture({ costMs: 110, diagnostics: DEFAULT_LIKE });
  await get(slow.handlers, {});
  await get(slow.handlers, {});
  assert.equal(slow.phaseLines().length, 1, '限流没生效，每 15 秒一轮会变成每轮一行');

  // 间隔清零后同样的两轮就该落两行 —— 证明上一条是限流而不是「根本没打」。
  const eager = fixture({ costMs: 30 });
  await get(eager.handlers, {});
  await get(eager.handlers, {});
  assert.equal(eager.phaseLines().length, 2);
});

test('启动窗口那一档只在宿主接了 logger 时生效', async () => {
  // 窗口极宽 + 间隔清零：慢轮次的阈值被放到不可能达到，唯一还能触发的就是启动窗口。
  const boot = { logMs: 1e9, gapMs: 0, bootWindowS: 1e6, bootGapMs: 0 };
  const withLogger = fixture({ costMs: 0, diagnostics: boot });
  await get(withLogger.handlers, {});
  assert.equal(withLogger.phaseLines().length, 1, '重启窗口内即便这一轮很快也要留下样本');

  const withoutLogger = fixture({ costMs: 0, logger: false, diagnostics: boot });
  await get(withoutLogger.handlers, {});
  assert.equal(withoutLogger.phaseLines().length, 0,
    '没有宿主 logger 的进程（测试/工具）不该被启动窗口刷屏到 console');
});

test('计时数字绝不进正文：payload 字段集合与从前逐字节一致', async () => {
  const { handlers } = fixture({ costMs: 0 });
  const res = await get(handlers, {});
  assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), [...PAYLOAD_KEYS].sort());
  for (const key of ['totalMs', 'calibMs', 'unaccountedMs', 'cardCount', 'cardLoopMs']) {
    assert.ok(!res.body.includes(key), `正文里不该出现诊断字段 ${key}`);
  }
});
