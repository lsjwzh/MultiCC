#!/usr/bin/env node
'use strict';

// 在已登录的本机账号环境中运行；MULTICC_RUST_ADDON 指向与网关同目录的新 addon。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { gatewayPath } = require('../src/native/binding');

const agy = process.argv[2] || 'agy';
const args = ['--output-format', 'stream-json', '--dangerously-skip-permissions'];
const prompt = '请只回复 OK，不使用工具。';

function start(cmd, argv) {
  const proc = spawn(cmd, argv, {
    stdio: ['pipe', 'pipe', 'inherit'], detached: process.platform !== 'win32',
  });
  const closed = once(proc, 'close');
  closed.catch(() => {});
  proc.stdin.on('error', () => {});
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  return { proc, closed, lines };
}

async function round(child, startTime) {
  let first, id;
  const timer = setTimeout(() => stop(child), 120000);
  try {
    for (;;) {
      const line = await child.lines.next();
      if (line.done) throw Error('进程在本轮 result 前退出');
      let evt;
      try { evt = JSON.parse(line.value); } catch { continue; }
      if (!['init', 'step_update', 'result'].includes(evt.event)) continue;
      first ??= performance.now() - startTime;
      id ||= evt.conversation_id || evt[evt.event]?.conversation_id;
      if (evt.event !== 'result') continue;
      if (evt.result.status !== 'SUCCESS') throw Error(evt.result.error || 'agy 未完成本轮');
      return { first, id, retired: !!evt.multicc_retire };
    }
  } finally { clearTimeout(timer); }
}

function stop(child) {
  if (!child?.proc.pid || child.proc.exitCode !== null || child.proc.signalCode) return;
  try {
    if (process.platform === 'win32') child.proc.kill();
    else process.kill(-child.proc.pid, 'SIGKILL');
  } catch {}
}

async function measure(warm) {
  let child, conversation;
  const times = [];
  try {
    for (let i = 0; i < 3; i++) {
      const begin = performance.now();
      if (warm) {
        child ??= start(gatewayPath(), ['agy-stream-bridge', agy, ...args]);
        child.proc.stdin.write(JSON.stringify({ text: prompt }) + '\n');
      } else {
        const argv = [...args, ...(conversation ? ['--conversation', conversation] : []), '-p', prompt];
        child = process.env.MULTICC_AGY_EGRESS_JSON
          ? start(gatewayPath(), ['agy-egress-exec','--bin',agy,'--', ...argv]) : start(agy, argv);
      }
      const result = await round(child, begin);
      if (warm && result.retired) throw Error('检测到逐轮回退，无法测量常驻延迟');
      if (conversation && result.id) assert.equal(result.id,conversation,'会话 ID 发生变化');
      conversation ||= result.id;
      assert.ok(conversation, '缺少可恢复的 agy 会话 ID');
      times.push((result.first / 1000).toFixed(3));
      if (!warm) { await child.closed; child = null; }
    }
  } finally {
    if (child) { stop(child); await child.closed; }
  }
  return times;
}

(async () => {
  if (process.env.MULTICC_AGY_REMOTE_ACCOUNT_JSON) throw Error('本测试需要可执行多轮 stdin 的本机 agy 账号');
  for (const warm of [false,true]) {
    const times = await measure(warm);
    console.log(`${warm ? '常驻复用' : '逐轮启动'}，三轮投递至首个协议事件（秒）：${times.join(' / ')}`);
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
