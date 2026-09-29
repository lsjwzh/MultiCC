'use strict';

// macos-unlock-probe: 保存密码之后问一次 Agent「你到底读不读得到钥匙串条目」。
// Agent 二进制在这里是桩：测试绝不 spawn 真 agent —— 在一台装着 Agent 的机器上那会
// 弹系统授权框。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnlockProbe, PROBE_SECONDS, PROBE_TIMEOUT_MS } = require('../src/macos-unlock-probe');

function harness(reply) {
  const calls = [];
  const execFileFn = (file, args, options, cb) => {
    calls.push({ file, args, options });
    if (reply instanceof Error) return cb(reply, '', '');
    return cb(null, typeof reply === 'string' ? reply : JSON.stringify(reply), '');
  };
  const make = (o = {}) => createUnlockProbe({
    platform: 'darwin', execFileFn, agentBin: '/tmp/fake-agent', ...o,
  });
  return { calls, make };
}

test('unlock probe maps the agent reply onto the four states the panel paints', async () => {
  const h = harness({ ok: true, authorized: true, powerProtocol: 1 });
  assert.deepEqual(await h.make().probe(), { state: 'authorized' });
  assert.equal(h.calls[0].file, '/tmp/fake-agent');
  assert.deepEqual(h.calls[0].args, ['probe-unlock', String(PROBE_SECONDS)]);
  // 整个请求必须落在 api-client 的 15 秒默认超时之内，否则界面会把「密码已保存、只是没
  // 等到授权确认」误报成一次网络超时。
  assert.ok(h.calls[0].options.timeout > PROBE_SECONDS * 1000);
  assert.ok(h.calls[0].options.timeout < 15000);

  assert.deepEqual(
    await harness({ ok: true, authorized: false, reason: 'waiting-for-user' }).make().probe(),
    { state: 'waiting-for-user' });
  assert.deepEqual(
    await harness({ ok: true, authorized: false, reason: 'no-password' }).make().probe(),
    { state: 'no-password' });
  // 剩下的原因一律归到「没能确认」，绝不假装授权成功。
  assert.deepEqual(
    await harness({ ok: true, authorized: false, reason: 'read-failed' }).make().probe(),
    { state: 'unavailable', detail: 'read-failed' });
});

test('unlock probe degrades to unavailable instead of failing the save', async () => {
  // Agent 没在跑时 CLI 打的是 {"ok":false,"error":"agent-not-running",...}
  assert.deepEqual(
    await harness({ ok: false, error: 'agent-not-running', socket: '/x' }).make().probe(),
    { state: 'unavailable', detail: 'agent-not-running' });
  // 二进制不在 / 被超时杀掉
  assert.deepEqual(await harness(new Error('ENOENT')).make().probe(), { state: 'unavailable', detail: 'agent-error' });
  // 带 errno 的要分清楚：界面照 detail 说话，「没执行权限」和「没装」都不是再点一次
  // 「检查授权」能解决的（现场就是安装时丢了 0755），要指向「重启 MultiCC 自修」。
  const eacces = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  assert.deepEqual(await harness(eacces).make().probe(), { state: 'unavailable', detail: 'agent-not-executable' });
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(await harness(enoent).make().probe(), { state: 'unavailable', detail: 'agent-not-installed' });
  const timeout = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
  assert.deepEqual(await harness(timeout).make().probe(), { state: 'unavailable', detail: 'agent-error' });
  assert.deepEqual(await harness('not json at all').make().probe(), { state: 'unavailable', detail: 'bad-reply' });

  // 非 macOS 上连 spawn 都不该发生
  const linux = harness({ ok: true, authorized: true });
  assert.deepEqual(await linux.make({ platform: 'linux' }).probe(), { state: 'unavailable', detail: 'not-macos' });
  assert.deepEqual(linux.calls, []);
  assert.ok(PROBE_TIMEOUT_MS > 0);
});

test('outdated Agent never claims it can enforce the new switch', async () => {
  assert.deepEqual(await harness({ ok: true, authorized: true }).make().probe(), { state: 'unavailable', detail: 'agent-update-required' });
  assert.equal(await harness({ ok: true }).make().runtimeReady(), false);
  assert.equal(await harness({ ok: true, powerProtocol: 1 }).make().runtimeReady(), true);
  const h = harness({ ok: true, authorized: true, powerProtocol: 1 });
  await h.make().probe({ allowUI: true });
  assert.equal(h.calls[0].args.at(-1), '--allow-ui');
});
