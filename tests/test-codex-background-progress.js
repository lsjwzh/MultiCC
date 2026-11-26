'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexBackgroundEvents, safeText } = require('../src/native/binding').codexBackground;
const { createBackgroundTaskRuntime } = require('../src/chat/background-task-runtime');
const { createCodexExpAdapter } = require('../src/native/binding').codexAppAdapter;

function fixture(overrides = {}, create = createCodexBackgroundEvents) {
  let time = 0;
  const events = [], timers = [], attached = [];
  const tracker = create({ mainThreadId: 'main', emit: event => events.push(event),
    now: () => time, setTimer: (fn, ms) => { const timer = { fn, at: time + ms }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cancelled = true; }, attach: id => { attached.push(id); }, ...overrides });
  function advance(ms) {
    time += ms;
    for (const timer of timers.filter(t => !t.cancelled && t.at <= time)) {
      timer.cancelled = true; timer.fn();
    }
  }
  function item(threadId, item, method = 'item/completed') { return tracker.consume({ method, params: { threadId, item } }); }
  function spawn(id = 'child', parent = 'main') {
    return item(parent, { id: `spawn-${id}`, type: 'collabAgentToolCall', tool: 'spawnAgent',
      senderThreadId: parent, receiverThreadIds: [id], prompt: '检查接口', status: 'completed',
      agentsStates: { [id]: { status: 'running' } } });
  }
  return { tracker, events, advance, attached, item, spawn };
}

test('创建工具完成只标记子任务开始，子任务终态独立且去重', () => {
  const f = fixture();
  f.spawn();
  assert.equal(f.tracker.activeCount(), 1);
  assert.equal(f.events.some(e => e.subtype === 'codex_task_done'), false);
  const child = f.tracker.consume({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
  assert.equal(child.child, true);
  f.item('main', { type: 'collabAgentToolCall', agentsStates: { child: { status: 'completed' } } });
  assert.equal(f.events.filter(e => e.subtype === 'codex_task_done').length, 1);
  assert.equal(f.tracker.activeCount(), 0);
});

test('只接入当前会话树，无配置覆盖，已有子线程事件时不重复接入', async () => {
  const f = fixture();
  f.spawn('a'); f.spawn('b');
  f.tracker.consume({ method: 'thread/started', params: { thread: { id: 'b', parentThreadId: 'main' } } });
  assert.equal(f.tracker.consume({ method: 'thread/started', params: { thread: { id: 'foreign', parentThreadId: 'foreign-main' } } }).unrelated, true);
  f.advance(100); await Promise.resolve();
  assert.deepEqual(f.attached, ['a']);
  f.spawn('nested', 'b');
  assert.equal(f.tracker.activeCount(), 3);
  f.tracker.dispose();
  f.advance(60_000);
  assert.deepEqual(f.attached, ['a']);
});

test('新版子任务活动事件、未知状态和失败状态正确处理', () => {
  const f = fixture();
  f.item('main', { type: 'subAgentActivity', agentThreadId: 'child', kind: 'started', agentPath: '检查代码' });
  f.tracker.consume({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'unknown' } } });
  assert.equal(f.tracker.activeCount(), 1);
  f.item('main', { type: 'collabAgentToolCall', agentsStates: { child: { status: 'errored' } } });
  assert.equal(f.events.at(-1).status, 'failed');
  f.tracker.dispose();
});

test('接入前已完成的快速任务使用最新终态收尾，接入失败不能伪装完成', async () => {
  const f = fixture({ attach: async () => ({ thread: { status: { type: 'idle' } },
    latestTurn: { id: 'quick-turn', status: 'completed' } }) });
  f.spawn(); f.advance(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tracker.activeCount(), 0);
  assert.equal(f.events.at(-1).status, 'completed');
  const unavailable = fixture({ attach: async () => { throw new Error('模拟接入失败'); } });
  unavailable.spawn(); unavailable.advance(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unavailable.tracker.activeCount(), 1);
  assert.match(unavailable.events.at(-1).description, /详细进度暂时不可用/);
  unavailable.tracker.dispose();
});

test('重复的子任务创建活动不能重新激活已经完成的任务', () => {
  const f = fixture();
  const activity = { id: 'activity', type: 'subAgentActivity', agentThreadId: 'child', kind: 'started' };
  f.item('main', activity, 'item/started');
  f.tracker.consume({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
  f.item('main', activity);
  assert.equal(f.tracker.activeCount(), 0);
});

test('工具进度按子线程更新，节流，原始命令输出不进入浮窗', () => {
  const f = fixture(); f.spawn('a'); f.spawn('b');
  f.item('a', { id: 'tool', type: 'commandExecution', command: 'npm test' }, 'item/started');
  assert.match(f.events.at(-1).description, /正在运行测试/);
  const count = f.events.length;
  f.tracker.consume({ method: 'item/commandExecution/outputDelta', params: { threadId: 'a', itemId: 'tool', delta: '不应暴露的原始输出' } });
  assert.equal(f.events.length, count);
  f.advance(1000);
  f.tracker.consume({ method: 'item/mcpToolCall/progress', params: { threadId: 'b', itemId: 'tool', message: '正在检查路由' } });
  assert.equal(f.events.at(-1).task_id, 'codex-agent:b');
  assert.match(f.events.at(-1).description, /正在检查路由/);
  assert.equal(JSON.stringify(f.events).includes('不应暴露的原始输出'), false);
  f.advance(30_000);
  assert.ok(f.events.some(e => e.heartbeat));
  f.tracker.dispose();
});

test('主线程 MCP 进度显示为本轮工具，主回合结束收掉未完成工具', () => {
  const f = fixture();
  f.item('main', { id: 'tool', type: 'mcpToolCall', tool: '检查文件' }, 'item/started');
  f.tracker.consume({ method: 'item/mcpToolCall/progress', params: { threadId: 'main', itemId: 'tool', message: '已检查三个文件' } });
  assert.match(f.events.at(-1).description, /本轮工具.*已检查三个文件/);
  assert.equal(f.tracker.activeCount(), 0);
  f.tracker.consume({ method: 'turn/completed', params: { threadId: 'main', turn: { status: 'completed' } } });
  assert.equal(f.events.at(-1).status, 'interrupted');
});

test('摘要脱敏且长度有界', () => {
  const text = safeText('token=测试凭据 Bearer fake-test-key\n' + '内容'.repeat(300));
  assert.equal(text.includes('测试凭据'), false);
  assert.equal(text.includes('fake-test-key'), false);
  assert.ok(text.length <= 180);
});

test('任务快照隔离会话，心跳不伪造活动，退出中断且不重复投递结果', () => {
  let time = 10;
  const messages = [], observed = [];
  const runtime = createBackgroundTaskRuntime({
    broadcast: (name, event) => messages.push({ name, event }),
    observeTask: o => observed.push(o),
    noteBgResultInjected() {}, deliverSystem() {},
    readFile: () => { throw new Error('ENOENT'); }, realpath: value => value,
    tmpdir: () => '/tmp', getuid: () => 501,
    setTimer: () => ({}), clearTimer() {},
    now: () => time, logger: { info() {}, warn() {} },
  });
  const started = { subtype: 'codex_task_started', task_id: 'codex-agent:a', description: '检查代码', kind: 'agent' };
  runtime.handleEvent('s1', null, started);
  assert.equal(runtime.hasLiveBackgroundTasks('s1'), true); assert.equal(runtime.hasLiveBackgroundTasks('s2'), false);
  assert.equal(runtime.listActiveBackgroundTasks('s1')[0].description, '检查代码');
  time = 1000;
  runtime.handleEvent('s1', null, { ...started, subtype: 'codex_task_progress', heartbeat: true });
  assert.equal(runtime.backgroundSilenceMs('s1', time), 990);
  assert.equal(observed.length, 1);
  assert.equal(runtime.reapSessionShadows('s1'), 1);
  assert.equal(runtime.reapSessionShadows('s1'), 0);
  assert.equal(messages.at(-1).event.status, 'interrupted');
  runtime.handleEvent('s1', null, { ...started, subtype: 'codex_task_progress' });
  assert.equal(runtime.hasLiveBackgroundTasks('s1'), false);
  runtime.handleEvent('s1', null, { ...started, subtype: 'codex_task_started' });
  assert.equal(runtime.hasLiveBackgroundTasks('s1'), true);
});

test('适配器展示原生 Agent 工具卡片及中文状态', () => {
  const adapter = createCodexExpAdapter();
  const item = { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: '检查代码', receiverThreadIds: ['child'] };
  assert.equal(adapter.decodeEvent({ method: 'item/started', params: { item } })[0].name, 'Agent');
  const result = adapter.decodeEvent({ method: 'item/completed', params: { item: { ...item,
    status: 'completed', agentsStates: { child: { status: 'running' } } } } })[0];
  assert.match(result.content, /正在执行/);
});

test('本轮工具和子任务进度带上具体操作：命令、文件、MCP 参数、搜索词', () => {
  const f = fixture();
  f.item('main', { id: 'c1', type: 'commandExecution', command: "/bin/zsh -lc 'cd /Users/x/repo && gh run watch 19021 --exit-status'" }, 'item/started');
  assert.equal(f.events.at(-1).description, '本轮工具 · 正在执行命令 · gh run watch 19021 --exit-status');
  f.item('main', { id: 'c2', type: 'commandExecution', command: ['/bin/bash', '-lc', 'npm test -- --grep chat'] }, 'item/started');
  assert.equal(f.events.at(-1).description, '本轮工具 · 正在运行测试 · npm test -- --grep chat');
  f.item('main', { id: 'f1', type: 'fileChange', changes: [{ path: '/r/public/a.js' }, { path: 'b.css' }, { path: 'c.md' }, { path: 'd.ts' }] }, 'item/started');
  assert.equal(f.events.at(-1).description, '本轮工具 · 正在修改文件 · a.js, b.css, c.md 等 4 个文件');
  f.item('main', { id: 'm1', type: 'mcpToolCall', tool: 'search_docs', arguments: { query: '路由配置' } }, 'item/started');
  assert.equal(f.events.at(-1).description, '本轮工具 · 正在调用工具：search_docs · 路由配置');
  f.item('main', { id: 'w1', type: 'webSearch', query: 'codex app-server events' }, 'item/started');
  assert.equal(f.events.at(-1).description, '本轮工具 · 正在搜索资料 · codex app-server events');
  // 命令里的凭据照样脱敏。
  f.item('main', { id: 'c3', type: 'commandExecution', command: 'curl -H "Authorization: Bearer fake-test-key-123456" https://x' }, 'item/started');
  assert.equal(f.events.at(-1).description.includes('fake-test-key-123456'), false);
  // 子任务里的工具同样带内容。
  f.spawn('a');
  f.item('a', { id: 't', type: 'commandExecution', command: 'cargo build --release' }, 'item/started');
  assert.match(f.events.at(-1).description, /子任务 1：检查接口 · 正在执行命令 · cargo build --release/);
  f.tracker.dispose();
});

function frozenBackground() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-codex-background-events.cjs.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '8cd7aefe10b4a0e85d0a5d202ea4ce2418e6f66d01abc7f12d87f60109efb899');
  const filename = path.resolve(__dirname, '../src/cli-adapters/codex-background-events.cjs');
  const legacy = new Module(filename); legacy.filename = filename; legacy.paths = Module._nodeModulePaths(path.dirname(filename));
  legacy._compile(source, filename); return legacy.exports;
}

test('Rust 后台所有者逐事件、节流、心跳和重启匹配冻结实现', async () => {
  async function run(create) {
    const f = fixture({}, create), results = [];
    f.spawn('a'); f.spawn('b');
    results.push(f.tracker.consume({ method: 'thread/started', params: { thread: { id: 'alien', parentThreadId: 'foreign' } } }));
    for (let round = 0; round < 4; round++) {
      f.item('a', { id: 'command', type: 'commandExecution', command: '/bin/zsh -lc "cd /work && npm test"' }, 'item/started');
      f.tracker.consume({ method: 'item/commandExecution/outputDelta', params: { threadId: 'a', delta: '不要转发' } });
      f.advance(500);
      f.tracker.consume({ method: 'item/mcpToolCall/progress', params: { threadId: 'a', message: '进度' } });
      f.advance(500);
      f.item('a', { id: 'command', type: 'commandExecution', status: 'completed', exitCode: 0 });
      f.item('main', { id: 'tool', type: 'mcpToolCall', tool: 'query', arguments: { query: '文档' } }, 'item/started');
      f.tracker.consume({ method: 'item/mcpToolCall/progress', params: { threadId: 'main', itemId: 'tool', message: '下一页' } });
      f.tracker.consume({ method: 'turn/completed', params: { threadId: 'main', turn: { status: 'completed' } } });
    }
    f.advance(30_000); await new Promise(resolve => setImmediate(resolve));
    f.tracker.consume({ method: 'turn/completed', params: { threadId: 'a', turn: { status: 'completed' } } });
    f.item('main', { type: 'collabAgentToolCall', tool: 'resumeAgent', receiverThreadIds: ['a'] });
    f.tracker.consume({ method: 'thread/closed', params: { threadId: 'a' } });
    f.spawn('nested', 'b');
    f.tracker.consume({ method: 'thread/status/changed', params: { threadId: 'b', status: { type: 'systemError' } } });
    const active = f.tracker.activeCount();
    f.tracker.dispose(); f.advance(60_000);
    return { events: f.events, results, attached: f.attached, active, afterDispose: f.tracker.activeCount() };
  }
  assert.deepEqual(await run(createCodexBackgroundEvents), await run(frozenBackground().createCodexBackgroundEvents));
});

test('Rust 工具摘要与脱敏保留冻结版本及 UTF-16 切片', () => {
  const current = require('../src/native/binding').codexBackground, oracle = frozenBackground();
  for (const value of ['', null, 0, 'a\n\t\0b\u007fc', 'a'.repeat(179) + '😀尾', 'token=测试凭据 Bearer fake-test-key', 'proxy-route_test pr1.abc.def', Symbol('标记')]) {
    for (const limit of [0, 1, 80, 180, -1, Infinity, NaN]) assert.equal(current.safeText(value, limit), oracle.safeText(value, limit));
  }
  for (const value of [null, ['/bin/zsh', '-lc', 'cd /work && npm test'], ['echo', 'a', null], '/bin/bash -c " cd \'my work\' && pwd "', 'fish -lc "echo x"', '/bin/sh\u0085-c "pwd"', '/bin/sh\ufeff-c "pwd"', 'echo x']) {
    assert.equal(current.unwrapShellCommand(value), oracle.unwrapShellCommand(value));
  }
  const items = [
    { type: 'fileChange', changes: [null, {}, { path: 'C:\\a\\b.js' }, { path: '/a/' }] },
    ...['commandExecution', 'mcpToolCall', 'webSearch', 'unknown'].map(type => ({ type, command: 'npm test', arguments: { query: '关键词' }, action: { query: '搜索' } })),
  ];
  for (const item of items) assert.equal(current.toolDetail(item), oracle.toolDetail(item));
});
