'use strict';

// 超长历史会话的门禁回归：2026-11-13 OOM 事故的机制级不变量。
//
// 事故经过：一条每小时触发的巡检任务往同一会话追加了 951 轮，assistant
// 消息里 tools 字段原样保存了每次工具调用的完整输出（实测单条 564KB 中
// tools 占 403KB、contextTrace 147KB，而界面可见的 content 只有 5KB），
// 882 条 assistant 累积到 132MB。历史限额 CHAT_HISTORY_SOFT_CAP=10000 按
// 【条数】计，此时只用掉 19.5%，系统视为健康、不触发任何清理；而整份读取
// 把 135MB 文件变成约 434MB 堆对象，叠加任务看板快照撞破 Node 默认 ~2GB
// 堆，Node 主进程反复 FATAL OOM，Rust 网关每次 respawn 把正在跑的轮次连带
// 杀掉——表现为任务既无回复也无错误消息。
//
// 这里钉住的是【放大倍数不许再变大】和【服务一页不许动落盘文件】，
// 不是"条数限额已改成字节限额"（那个尚未修复，另案）。tools 字段的裁剪
// 逻辑本身由 test-history-frame-budget.js 单测覆盖，此处只验真文件的端到端。
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_MAX_BYTES, fitHistoryFrame } = require('../src/chat/history-frame-budget');
const { createChatHistoryRuntime } = require('../src/routes/chat-history');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');

const PROBE = path.join(__dirname, 'helpers', 'oversize-history-probe.js');
// 填充里混中文：纯 ASCII 会被 V8 存成单字节串，量不出真实事故里
// UTF-8 → UTF-16 的翻倍，合成样本必须和生产同构。
const CHUNK = '[watchdog] chat_windows=6 heartbeat=164s state=healthy 门禁通过，已落盘阻断报告。\n';

function filler(bytes) {
  return CHUNK.repeat(Math.ceil(bytes / Buffer.byteLength(CHUNK)));
}

// 一轮 = 一条用户指令 + 一条带完整工具输出的 assistant 回复。
function buildTranscript({ turns, toolBytes }) {
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    const base = 1700000000000 + index * 2000;
    messages.push({
      id: `u${index}`,
      role: 'user',
      ts: base,
      content: `执行“1688消息巡检与运营汇总”，不要只检查状态：${filler(2048)}`,
    });
    messages.push({
      id: `a${index}`,
      role: 'assistant',
      ts: base + 1000,
      content: '门禁已通过（healthy，心跳 164 秒）。现在执行数据集刷新并核对 dashboard 数量。',
      tools: [{
        name: 'Bash',
        input: { command: 'python3 /Users/x/scripts/1688_watchdog.py --state state.json' },
        output: filler(toolBytes),
      }],
      contextTrace: { steps: [{ label: '门禁', detail: filler(8192) }] },
      timeline: [{ phase: 'tool', ms: 1200 }],
      usage: { input_tokens: 1200, output_tokens: 340 },
    });
  }
  return messages;
}

function plant(t, { turns, toolBytes }) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-oversize-')));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const repository = createChatHistoryFileRepository({ dataDir });
  const sessionId = 'task-oversize';
  const messages = buildTranscript({ turns, toolBytes });
  const file = repository.fileFor(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${messages.map(message => JSON.stringify(message)).join('\n')}\n`);
  return { dataDir, repository, sessionId, file, planted: messages };
}

function runtimeFor(t, { repository, sessionId }) {
  const runtime = createChatHistoryRuntime({
    history: repository,
    persistedSessions: new Map([[sessionId, { id: sessionId, kind: 'chat', cli: 'claude' }]]),
    chatSessions: new Map([[sessionId, {}]]),
    idFactory: () => 'oversize-1',
    now: () => 1700000000000,
    chatBroadcast() {},
    distillHistoryIntoMemory() { return Promise.resolve(); },
    maybeSchedulePeriodicMemoryReview() {},
    async cliSwitchGitSnapshot() { return {}; },
    chatStream: { close() {} },
    clearAllNativeCliStates() { return 0; },
    buildHandoffCheckpoint() { return {}; },
    rememberActiveCliState() {},
    saveBestEffort() {},
    trackPendingMemoryDistill(_sessionId, promise) { return promise; },
    setImmediate() { return { unref() {} }; },
    setTimeout() { return { unref() {} }; },
    clearTimeout() {},
    logger: { warn() {} },
  });
  t.after(() => runtime.stop());
  return runtime;
}

test('整份读一个工具密集的超长历史必须留在有界堆内', t => {
  // 100 轮 × 140KB 工具输出 ≈ 15MB，assistant 平均 150KB，与事故实测的
  // 154KB/条同量级。标定（2026-11-13，macOS/Node 26）：读完 heapUsed 稳定在
  // 48MB ≈ 文件的 3.2 倍，与生产实测的放大倍数一致。
  //
  // 两条腿分工（都经实测反证，别只留一条）：
  //   · heapUsed ≤ 6×文件 是【紧的那条】。注入一份整份对象图拷贝（即生产上
  //     "每次追加整份 stringify+clone" 那类回归）后实测 48MB→112MB，超过
  //     89MB 闸门直接红。基线到闸门有近 2 倍余量，容得下平台与 GC 抖动。
  //   · --max-old-space-size=96 是【兜底那条】：证明 15MB 的工具密集会话
  //     本来就能在小堆里读完。注意 Node 的实际上限比该值高约 96MB
  //     （cap=96 时 heap_size_limit=192MB），所以它只兜得住 3 倍以上的
  //     灾难级放大，日常回归靠上面那条占比断言抓。
  const planted = plant(t, { turns: 100, toolBytes: 140 * 1024 });
  const fileMB = fs.statSync(planted.file).size / 1048576;
  assert.ok(fileMB > 12, `合成样本要够大才量得准，实际 ${fileMB.toFixed(1)}MB`);

  const stdout = execFileSync(
    process.execPath,
    ['--max-old-space-size=96', PROBE, planted.dataDir, planted.sessionId],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 },
  );
  const report = JSON.parse(stdout);

  assert.equal(report.messages, 200, '整份读必须拿到全部消息');
  assert.equal(report.tail, 5);
  assert.ok(report.tailHasTools, 'tools 字段要原样读回，否则这个样本没在考工具密集路径');
  assert.ok(
    report.heapUsedMB <= fileMB * 6,
    `读取放大回归：${fileMB.toFixed(1)}MB 文件用了 ${report.heapUsedMB}MB 堆（基线约 3.2 倍，闸门 6 倍）`,
  );
});

test('超长会话只服务一页，落盘文件分毫不动', t => {
  const planted = plant(t, { turns: 40, toolBytes: 140 * 1024 });
  const before = fs.readFileSync(planted.file);
  const runtime = runtimeFor(t, planted);

  const page = runtime.paginate(planted.sessionId, { limit: 5 });
  assert.equal(page.messages.length, 5, '一页只能是 limit 条，不能把整份 transcript 端上来');
  assert.equal(page.hasMore, true, 'hasMore 必须为真，否则前端不会再去 HTTP 取旧消息');
  assert.equal(page.messages.at(-1).id, 'a39', '最新一轮必须在页内');

  // 读路径绝不许改写落盘文件：事故期间每轮都在重写整份，这里钉死只读。
  assert.deepEqual(fs.readFileSync(planted.file), before, '分页读不得改写 transcript');
  assert.equal(runtime.load(planted.sessionId).length, 80, 'load 仍是整份读（当前语义，字节限额尚未实现）');
});

test('真会话构造的重放帧必须压在 WS 单帧上限内', t => {
  // 2026-10-01 的无限重连事故：连接时重放帧超过 maxFrameBytes 被 1013 关闭，
  // 每次重连又发同一帧。单条 500KB 工具输出的会话最容易踩中。
  const planted = plant(t, { turns: 40, toolBytes: 500 * 1024 });
  const before = fs.readFileSync(planted.file);
  const runtime = runtimeFor(t, planted);

  const page = runtime.paginate(planted.sessionId, { limit: 5 });
  const fitted = fitHistoryFrame(page.messages, { maxBytes: DEFAULT_MAX_BYTES });
  const frameBytes = Buffer.byteLength(JSON.stringify(fitted.messages));

  assert.ok(
    frameBytes <= DEFAULT_MAX_BYTES,
    `重放帧 ${(frameBytes / 1048576).toFixed(2)}MB 超过单帧上限 ${(DEFAULT_MAX_BYTES / 1048576).toFixed(0)}MB`,
  );
  assert.ok(fitted.messages.length >= 1, '至少保留最新一条，否则页面永远补不齐');
  assert.deepEqual(fs.readFileSync(planted.file), before, '装帧只改副本，落盘 transcript 不许动');
  assert.equal(
    page.messages.at(-1).tools[0].output.length,
    filler(500 * 1024).length,
    '源消息不许被裁剪，裁剪只发生在重放副本上',
  );
});
