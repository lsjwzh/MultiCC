'use strict';
// 常驻 SDK 流 × 保险箱：进程的环境在 spawn 时固定，所以
//   1. 已有条目要在 spawn 时就带进子进程环境；
//   2. 会话中途新增/修改/删除条目，要在下个回合边界回收重启（--resume 保留上下文）；
//   3. 后台任务占着进程时不能拒绝回合，顺延到后台结束后的下个回合。
// 真实 SDK 子进程 + 假上游，保险箱落在隔离的 MULTICC_DATA_DIR（绝不碰真实 secrets.json）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-vault-test-'));
process.env.MULTICC_DATA_DIR = dataDir;
const { assertTestDir } = require('../src/paths');
assertTestDir(dataDir);
const vault = require('../src/secrets-vault');
const { createSdkStream } = require('../src/chat/claude-sdk-stream');
const { createStreamRouter } = require('../src/chat/stream-router');
const { bundledClaudeCodeBinary } = require('../src/cli/claude-bundled-binary');
const sdkFixture = require('./helpers/claude-sdk-fixture');
const laneLedger = require('./helpers/claude-lane-ledger');

// Record spawn argv/env without changing the child identity: the wrapper
// execve()s the real binary, so resident-PID assertions stay meaningful.
const LANE_WRAPPER = path.join(__dirname, 'helpers', 'claude-lane-wrapper.js');

async function setup(t) {
  vault._resetForTests();
  t.after(() => vault._resetForTests());
  const fixture = await sdkFixture(t);
  const spawnFile = path.join(fixture.root, 'lane-ledger.jsonl');
  const sdk = createSdkStream({ binary: process.execPath, binaryArgs: [LANE_WRAPPER] });
  const runtime = createStreamRouter({ status: () => null, closeAndWait: async () => ({ closed: true }) }, sdk);
  fixture.teardown.tasks.push(async () => {
    try { await runtime.closeAndWait('sdk'); }
    finally {
      for (const spawn of laneLedger.rows(spawnFile)) laneLedger.kill(spawn.pid);
    }
  });
  const sessionId = randomUUID();
  let turn = 0;
  let background = false;
  let acknowledgedAnswers = 0;
  // 模拟 turn-engine：每个回合重建 env，并叠加保险箱，再 ensure + send。
  const sendTurn = text => {
    const cfg = {
      cwd: fixture.cwd, sessionId, resume: turn > 0, sdkOptions: { model: 'claude-sonnet-4-6' },
      env: vault.applyEnvOverlay({ ...fixture.env,
        MULTICC_LANE_LEDGER: spawnFile, MULTICC_LANE_REAL_BINARY: bundledClaudeCodeBinary() }),
      isBackgroundActive: () => background,
      // 不设上限提示；静默窗缩短，后台一结束就放行（只测进程是否被保留）。
      backgroundHold: { maxMs: 0, quietMs: 20 },
    };
    turn += 1;
    runtime.ensure('sdk', cfg);
    return runtime.send('sdk', text, event => {
      // The test host accepts the answer-history boundary just like turn-engine.
      // A held turn cannot release until its answer has been acknowledged.
      if (event.acknowledge) { event.acknowledge(); acknowledgedAnswers += 1; }
    });
  };
  return { ...fixture, runtime, spawns: () => laneLedger.rows(spawnFile), sendTurn,
    acknowledgedAnswers: () => acknowledgedAnswers,
    setBackground: v => { background = v; } };
}

const envOf = spawn => spawn.env;

async function until(predicate, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('existing vault entries reach the resident child env at spawn', { timeout: 90000 }, async t => {
  const f = await setup(t);
  vault.upsert({ name: 'ARK_API_KEY', value: 'ark-value-1' });
  assert.equal((await f.sendTurn('hello')).subtype, 'success');
  assert.equal(f.spawns().length, 1);
  assert.equal(envOf(f.spawns()[0]).ARK_API_KEY, 'ark-value-1');
});

test('an unchanged vault never restarts the resident process', { timeout: 90000 }, async t => {
  const f = await setup(t);
  vault.upsert({ name: 'STABLE_KEY', value: 'v' });
  await f.sendTurn('turn one');
  const pid = f.runtime.status('sdk').pid;
  await f.sendTurn('turn two');
  await f.sendTurn('turn three');
  assert.equal(f.spawns().length, 1, 'three turns, one native child');
  assert.equal(f.runtime.status('sdk').pid, pid);
});

test('an entry added mid-session restarts at the next turn and the new child sees it', { timeout: 90000 }, async t => {
  const f = await setup(t);
  await f.sendTurn('before the secret exists');
  assert.equal(f.spawns().length, 1);
  assert.equal(envOf(f.spawns()[0]).LATE_KEY, undefined);
  const firstPid = f.runtime.status('sdk').pid;

  vault.upsert({ name: 'LATE_KEY', value: 'late-value' });
  assert.equal((await f.sendTurn('after the secret exists')).subtype, 'success');
  assert.equal(f.spawns().length, 2, 'process recycled on the turn boundary');
  assert.notEqual(f.runtime.status('sdk').pid, firstPid);
  assert.equal(envOf(f.spawns()[1]).LATE_KEY, 'late-value');

  // 改值同样生效；删除后下一个进程里不再有它。
  vault.upsert({ name: 'LATE_KEY', value: 'late-value-2' });
  await f.sendTurn('value changed');
  assert.equal(f.spawns().length, 3);
  assert.equal(envOf(f.spawns()[2]).LATE_KEY, 'late-value-2');
  vault.remove('LATE_KEY');
  await f.sendTurn('entry removed');
  assert.equal(f.spawns().length, 4);
  assert.equal(envOf(f.spawns()[3]).LATE_KEY, undefined);
});

test('live background work defers the vault restart instead of refusing the turn', { timeout: 90000 }, async t => {
  const f = await setup(t);
  await f.sendTurn('start');
  f.setBackground(true);
  vault.upsert({ name: 'DEFERRED_KEY', value: 'd' });
  // 后台工作是回合的一部分：回答先被持有，进程保留（重启顺延到下一个回合边界）。
  const held = f.sendTurn('turn while background runs');
  await until(() => f.runtime.heldTurn('sdk')?.held === true, 'the answer was not held');
  assert.equal(f.acknowledgedAnswers(), 1, 'the test host acknowledged the held answer');
  assert.equal(f.spawns().length, 1, 'background work keeps its process');

  f.setBackground(false);
  assert.equal((await held).subtype, 'success', 'turn is not refused');
  await f.sendTurn('after background ends');
  assert.equal(f.spawns().length, 2);
  assert.equal(envOf(f.spawns()[1]).DEFERRED_KEY, 'd');
});
