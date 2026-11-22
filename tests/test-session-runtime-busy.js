'use strict';

// 「这个会话的 chat 运行时忙不忙」只有一处判定：native/core/src/active_turns.rs。
// src/session/runtime-busy.js 是它的 Node 端口（addon 的 sessionChatStateBusy /
// sessionProcAlive），本文件钉三件事：
//   1. 四条痕迹各自的真假值，特别是「isStreaming 已经清了、runner 还在」的窗口，
//      以及 isStreaming 必须严格 === true、exitCode === 0 也算已退出；
//   2. Node 侧没有第二份手抄的判定分支：端口只调原生入口；
//   3. 该问这个判定的调用点都改问它了，刻意更窄 / 问另一件事的调用点保持原样。
//
// 这些用例真的加载原生模块：运行前必须设置 MULTICC_RUST_ADDON（或
// MULTICC_RUST_PREBUILT_DIR）到含本次源码的构建产物。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { sessionRuntimeIsChatStateBusy: isChatStateBusy, sessionRuntimeProcessAlive: processAlive } = require('../src/native/runtime').getNative();
const { createStateOwner } = require('../src/state/owner');
const { createChatSessions } = require('../src/chat/sessions');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// Node 写这两个字段的方式：null 表示「还没退出」，数字/字符串才是退出过。
const liveProc = () => ({ pid: 4242, exitCode: null, signalCode: null });
const exitedProc = () => ({ pid: 4242, exitCode: 0, signalCode: null });
const signalledProc = () => ({ pid: 4242, exitCode: null, signalCode: 'SIGTERM' });
// 测试里常见的假句柄：只给 pid / kill()，两个字段都没写。
const objectProc = () => ({ pid: 4242, kill() {} });

test('every trace of a live turn reads as busy', () => {
  assert.equal(isChatStateBusy(null), false);
  assert.equal(isChatStateBusy(undefined), false);
  assert.equal(isChatStateBusy({}), false, 'an idle chat state is not busy');

  assert.equal(isChatStateBusy({ isStreaming: true }), true, 'isStreaming');
  assert.equal(isChatStateBusy({ claudeProc: liveProc() }), true, 'claudeProc');
  assert.equal(isChatStateBusy({ claudeProc: objectProc() }), true, 'a fake handle with no exit fields is alive');
  assert.equal(isChatStateBusy({ _cancelledProc: liveProc() }), true, '_cancelledProc');
  assert.equal(isChatStateBusy({ _activeRunner: { runnerId: 'r1' } }), true, '_activeRunner');
});

test('isStreaming counts only when it is strictly true', () => {
  // 旧 JS 是 `cs.isStreaming === true`，truthy 值（1 / 'yes' / 对象）不算。
  assert.equal(isChatStateBusy({ isStreaming: 1 }), false);
  assert.equal(isChatStateBusy({ isStreaming: 'yes' }), false);
  assert.equal(isChatStateBusy({ isStreaming: new Boolean(true) }), false);
  assert.equal(isChatStateBusy({ isStreaming: true }), true);
});

test('non-object chat states are idle', () => {
  for (const value of [0, '', false, 'idle', 42, BigInt(1)]) {
    assert.equal(isChatStateBusy(value), false, `${String(value)} is not a chat state`);
  }
});

test('a throwing property getter is treated as missing, not as a crash', () => {
  // 调用点也传测试假对象，属性读取失败不能把整个忙判定炸掉。
  const exploding = Object.defineProperty({}, 'isStreaming', {
    get() { throw new Error('fixture getter'); },
  });
  assert.equal(isChatStateBusy(exploding), false);
  const explodingProc = Object.defineProperty({}, 'claudeProc', {
    get() { throw new Error('fixture getter'); },
  });
  assert.equal(isChatStateBusy(explodingProc), false);
  // 有别的真痕迹时，仍然照常判忙。
  const mixed = Object.defineProperty({ _activeRunner: {} }, 'isStreaming', {
    get() { throw new Error('fixture getter'); },
  });
  assert.equal(isChatStateBusy(mixed), true);
});

test('the teardown window is busy: isStreaming cleared, runner still owned', () => {
  // session-work/host.js stopRunner() 先清 isStreaming，确认子进程真的停了之后才
  // 释放 _activeRunner（chat/finalize-host.js 的收尾路径同样是先清 isStreaming）。
  // 只读 isStreaming 的老判定会在这个窗口里把会话说成空闲 —— 于是「搬工作树 / 切
  // CLI / 计数」都会在别人还在写的时候动它。
  const teardown = { isStreaming: false, claudeProc: null, _cancelledProc: null, _activeRunner: { runnerId: 'r1' } };
  assert.equal(isChatStateBusy(teardown), true);
  // 收尾真的走完（runner 也放了）之后才是空闲。
  assert.equal(isChatStateBusy({ ...teardown, _activeRunner: null }), false);
});

test('a reaped or nonexistent child is not busy', () => {
  assert.equal(processAlive(null), false);
  assert.equal(processAlive(undefined), false);
  assert.equal(processAlive(exitedProc()), false, 'exitCode set means reaped');
  assert.equal(processAlive({ pid: 4242, exitCode: 0, signalCode: null }), false,
    'exitCode === 0 still means reaped');
  assert.equal(processAlive(signalledProc()), false, 'signalCode set means reaped');
  assert.equal(processAlive({ pid: 4242, exitCode: null, signalCode: '' }), true,
    'an empty signalCode is falsy and not a reap');
  assert.equal(processAlive(liveProc()), true);
  assert.equal(processAlive(objectProc()), true, 'a fake handle with no exit fields is alive');
  // 已 detach 但还没退出的子进程仍然是活的：那是 _cancelledProc 存在的唯一理由。
  assert.equal(isChatStateBusy({ _cancelledProc: signalledProc() }), false);
  assert.equal(isChatStateBusy({ _cancelledProc: liveProc() }), true);
  // 已 reap 的 claudeProc 也不算忙。
  assert.equal(isChatStateBusy({ claudeProc: exitedProc() }), false);
});

test('the retired Node port delegates through the native owner', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src/session/runtime-busy.js')), false);
  const native = require('../src/native/runtime').getNative();
  assert.equal(typeof native.sessionRuntimeIsChatStateBusy, 'function');
  assert.equal(typeof native.sessionRuntimeProcessAlive, 'function');
  assert.match(read('native/core/src/active_turns.rs'), /fn chat_state_busy/);
  assert.match(read('native/core/src/active_turns.rs'), /fn process_alive/);
});

test('every call site asks the one predicate', () => {
  const callers = [
    // server.js 刻意不在列：`/metrics` 的活跃轮次遍历已随 server-core 簇迁入 Rust
    // 前门，计数走宿主端口的 owner.chatActiveTurns()，所以 server.js 既不问这个
    // 判定也不该再 require 它（下一条用例正面钉住这件事）。
    'src/cli/switch-runtime.js',
    'src/routes/session-git.js',
    'src/routes/session-lifecycle.js',
    'src/session/hibernation-composition.js',
    'src/session/pending-configuration.js',
    'src/task-shell/workspace.js',
    'src/workspace/admission.js',
  ];
  // 手抄的两元组：`X.isStreaming || X.claudeProc` 这类写法每一种组合都出现过。
  const handRolled = /(\w+)\??\.(?:isStreaming|claudeProc)\s*\|\|\s*\1\??\.(?:isStreaming|claudeProc)/;
  for (const file of callers) {
    const src = read(file);
    assert.match(src, /getNative\(\)\.sessionRuntimeIsChatStateBusy\(/, `${file} must ask the native shared predicate`);
    assert.doesNotMatch(src, handRolled, `${file} still hand-rolls a two-trace busy test`);
  }
  // session-work/host.js 只用它的 processAlive 一半：停止等待刻意不算 _activeRunner
  // （见下一条），所以这里单独钉，不进上面的 isChatStateBusy 列表。
  const workHost = read('src/session-work/host.js');
  assert.match(workHost, /getNative\(\)\.sessionRuntimeProcessAlive\(/);
  assert.match(workHost, /sessionRuntimeProcessAlive\(state\._cancelledProc\)/);
  assert.doesNotMatch(workHost, /function processAlive\(proc\) \{/,
    'the repo keeps one processAlive, in native/core/src/active_turns.rs');
});

test('the active-turn count has no Node fallback', () => {
  // 迁移前 server.js 的 /metrics 自己遍历 chatSessions 数活跃轮次；那条路由已经
  // 迁入 Rust 前门（native/gateway/src/app/server_core.rs），计数由 Rust 持有的
  // chat 表完成。这里钉三件事，防止有人"顺手"在 Node 里补一个回退实现：
  const server = read('server.js');
  assert.doesNotMatch(server, /require\('\.\/src\/session\/runtime-busy'\)/,
    'server.js no longer asks the busy predicate; the count moved behind the host port');
  assert.doesNotMatch(server, /activeTurns/,
    'server.js must not count active turns; owner.chatActiveTurns() does');

  // 宿主端口只许把事实转给 Rust，不许自己判忙或自己累加。
  const host = read('src/routes/server-core-host.js');
  assert.match(host, /chatActiveTurns\(/,
    'the host port must delegate the count to the Rust-owned chat table');
  assert.doesNotMatch(host, /for\s*\(const\s*\[[^\]]*\]\s*of\s*chatSessions/,
    'the host port must not re-introduce the Node-side table walk');
  // 注释里引用旧判定是可以的（它解释了为什么事实只有 Rust 有），所以这里钉的是
  // 「拿不到那个函数」而不是「文本里不出现」。
  assert.doesNotMatch(host, /require\([^)]*runtime-busy[^)]*\)/,
    'the host port must not import the predicate; it delegates to the Rust table');
});

test('the deliberately narrower call sites stay narrower', () => {
  // 1. cancel 的停止等待：已取消的常驻轮次在 cancel 走完之前一直持有
  //    _activeRunner，把它算进来会让这个循环永不收敛（只能靠超时收场）。
  const workHost = read('src/session-work/host.js');
  const stopped = workHost.slice(workHost.indexOf('function runnerStopped(sessionId) {'));
  const stoppedBody = stopped.slice(0, stopped.indexOf('\n  }'));
  assert.ok(stoppedBody.includes('Deliberately NOT the shared chat-runtime busy predicate'),
    'the reason must stay written down');
  assert.doesNotMatch(stoppedBody, /state\._activeRunner/, 'the code must not read it even though the comment names it');
  // 2. shutdown drain：收尾中的轮次不该延长停机宽限。这段表达式被
  //    tests/test-architecture-boundaries.js 逐字钉住。
  const drain = read('src/host-lifecycle.js');
  assert.match(drain, /cs\.claudeProc \|\| isStreamingBusy\(name, cs\)/);
  assert.doesNotMatch(drain, /isChatStateBusy/);
  // 3. liveness 的 processHandleAlive 更窄：已经发过信号（killed）对 liveness
  //    判定就等于不活着，对 runtime-busy 却仍是活着。
  const liveness = read('src/liveness/runtime.js');
  assert.match(liveness, /child\.killed !== true/);
  assert.doesNotMatch(liveness, /isChatStateBusy/);
});

test('the sites that ask a different question stay out of it, with reasons written', () => {
  // 这些地方也在读 isStreaming，但没有改用共享判定 —— 它们问的是另一件事，而且
  // 理由都写在原地（marker），别再靠记忆判断哪处是有意的。
  const narrow = [
    ['src/session-work/host.js', 'Widening it here would refuse answers it must accept'],
    ['src/classify/state-machine.js', 'single bounded retry'],
    ['src/chat/stalled-turn-recovery.js', 'is a STREAM in flight'],
    ['src/triggers/index.js', 'nothing is streaming'],
  ];
  for (const [file, marker] of narrow) {
    const src = read(file);
    assert.ok(src.includes(marker), `${file} must keep the reason it is not the shared predicate`);
    // 仍然只读自己那一两个痕迹，没有偷偷改问共享判定。
    assert.doesNotMatch(src, /isChatStateBusy/, `${file} asks a different question`);
  }
});

// ── Active-turn counter (server.js:442-446 before the migration) ─────────────
// The loop is now `RustSessionRecords#chatActiveTurns`: table order, a busy chat
// state short-circuits (the stream probe is NOT called), and only a strict
// `=== true` from the probe counts.

function activeTurnsHarness() {
  const owner = createStateOwner();
  return { owner: owner.native, sessions: createChatSessions(owner) };
}

test('chatActiveTurns counts nothing for an empty table', () => {
  const { owner } = activeTurnsHarness();
  let probes = 0;
  assert.equal(owner.chatActiveTurns(() => { probes += 1; return true; }), 0);
  assert.equal(probes, 0);
});

test('chatActiveTurns counts every busy chat state without probing the stream', () => {
  const { owner, sessions } = activeTurnsHarness();
  sessions.set('a', { isStreaming: true });
  sessions.set('b', { _activeRunner: {} });
  sessions.set('c', { claudeProc: liveProc() });
  let probes = 0;
  assert.equal(owner.chatActiveTurns(() => { probes += 1; return false; }), 3);
  assert.equal(probes, 0, 'a busy chat state must short-circuit the stream probe');
});

test('chatActiveTurns counts stream-busy rows only when the probe returns true', () => {
  const { owner, sessions } = activeTurnsHarness();
  sessions.set('a', {});
  sessions.set('b', { isStreaming: false });
  sessions.set('c', { _cancelledProc: null });
  const answers = { a: true, b: undefined, c: 'yes' };
  const probed = [];
  assert.equal(owner.chatActiveTurns(name => { probed.push(name); return answers[name]; }), 1);
  assert.deepStrictEqual(probed, ['a', 'b', 'c'], 'table order, one probe per idle row');
});

test('chatActiveTurns mixes both axes and skips falsy table values', () => {
  const { owner, sessions } = activeTurnsHarness();
  sessions.set('busy', { isStreaming: true });
  sessions.set('idle-busy-stream', {});
  sessions.set('idle', {});
  sessions.set('falsy', null);
  const probed = [];
  const total = owner.chatActiveTurns(name => {
    probed.push(name);
    return name === 'idle-busy-stream';
  });
  assert.equal(total, 2);
  assert.deepStrictEqual(probed, ['idle-busy-stream', 'idle'],
    'falsy values are skipped before the probe; busy rows are not probed');
});

test('chatActiveTurns keeps the chat-table order, not insertion by sorted id', () => {
  const { owner, sessions } = activeTurnsHarness();
  for (const id of ['z', 'a', 'm']) sessions.set(id, {});
  const probed = [];
  owner.chatActiveTurns(name => { probed.push(name); return false; });
  assert.deepStrictEqual(probed, ['z', 'a', 'm']);
});

test('chatActiveTurns lets a throwing stream probe escape unchanged', () => {
  const { owner, sessions } = activeTurnsHarness();
  sessions.set('a', {});
  const boom = new Error('probe exploded');
  assert.throws(() => owner.chatActiveTurns(() => { throw boom; }), error => error === boom);
});

test('the owner busy readers agree with the port', () => {
  const { owner, sessions } = activeTurnsHarness();
  sessions.set('busy', { _activeRunner: {} });
  sessions.set('idle', {});
  assert.equal(owner.chatSessionBusy('busy'), true);
  assert.equal(owner.chatSessionBusy('idle'), false);
  assert.equal(owner.chatSessionBusy('absent'), false);
  for (const cs of [{ isStreaming: true }, { isStreaming: 1 }, {}, null, 7]) {
    assert.equal(owner.chatStateBusy(cs), isChatStateBusy(cs), `owner reader matches the port for ${String(cs)}`);
  }
  for (const proc of [liveProc(), exitedProc(), signalledProc(), objectProc(), null, undefined]) {
    assert.equal(owner.procAlive(proc), processAlive(proc), 'owner reader matches the port');
  }
});
