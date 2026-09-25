'use strict';

// 「这个会话的 chat 运行时忙不忙」只有一处判定：src/session/runtime-busy.js。
//
// 三条痕迹（isStreaming / claudeProc / _cancelledProc）加上只由 _activeRunner 单独
// 成立的那个收尾窗口，历史上每个消费者各读一个子集，于是同一个会话在不同路由上会
// 得到不同答案 —— session-git 的 isWorktreeActive 对同一个会话就有两种判定，App 上
// 排队中/等后台任务的任务则根本停不掉。本文件钉三件事：
//   1. 四条痕迹各自的真假值，特别是「isStreaming 已经清了、runner 还在」的窗口；
//   2. 该问这个判定的调用点都改问它了，没有第二份手抄的四元表达式；
//   3. 刻意更窄的两个调用点（cancel 的停止等待、shutdown drain）保持更窄。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { isChatStateBusy, processAlive } = require('../src/session/runtime-busy');

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
  assert.equal(processAlive(signalledProc()), false, 'signalCode set means reaped');
  assert.equal(processAlive(liveProc()), true);
  // 已 detach 但还没退出的子进程仍然是活的：那是 _cancelledProc 存在的唯一理由。
  assert.equal(isChatStateBusy({ _cancelledProc: signalledProc() }), false);
  assert.equal(isChatStateBusy({ _cancelledProc: liveProc() }), true);
});

test('every call site asks the one predicate', () => {
  const callers = [
    'server.js',
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
    assert.match(src, /require\('[^']*runtime-busy'\)/, `${file} must require the shared predicate`);
    assert.match(src, /isChatStateBusy\(/, `${file} must ask isChatStateBusy()`);
    assert.doesNotMatch(src, handRolled, `${file} still hand-rolls a two-trace busy test`);
  }
  // session-work/host.js 只用它的 processAlive 一半：停止等待刻意不算 _activeRunner
  // （见下一条），所以这里单独钉，不进上面的 isChatStateBusy 列表。
  const workHost = read('src/session-work/host.js');
  assert.match(workHost, /require\('\.\.\/session\/runtime-busy'\)/);
  assert.match(workHost, /processAlive\(state\._cancelledProc\)/);
  assert.doesNotMatch(workHost, /function processAlive\(proc\) \{/,
    'the repo keeps one processAlive, in src/session/runtime-busy.js');
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
