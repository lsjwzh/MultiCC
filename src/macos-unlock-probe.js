'use strict';

// 保存密码之后立刻问一次 Agent：它到底能不能读钥匙串里这条目？
//
// 为什么非要有这一步：钥匙串条目默认只信任「创建它的应用」（security(1) 原文），创建者
// 是服务端拉起的 /usr/bin/security，读它的是 MultiCC Agent —— 两个身份。所以 Agent 第一次
// 读这条目时 macOS 会弹系统授权框（SecurityAgent 的 SFAuthenticationWindow）。这个框必须
// 在「屏幕已解锁、用户就在跟前」的时候弹：锁屏时它点不到，Agent 会卡在读密码那步（实测
// 卡死 3 分钟，整条 computer-use 链路跟着挂）。
//
// 写入时已经用 -T 把 Agent 预授权了（见 macos-unlock-password.js），所以正常情况这条探测
// 是秒回的「已验证」；它同时是那个预授权的**验证**，以及万一没生效时把框拉到用户面前的
// 那条路（点一次「始终允许」，之后就再也不弹）。
//
// 只读、有界：回执里只有状态，永远没有密码本身；Agent 侧 probe-unlock 自己有秒数上限，
// 这里再套一层进程超时。
const { execFile } = require('node:child_process');
const { homedir } = require('node:os');
const path = require('node:path');

// Agent 侧等 8 秒（够用户看见框并点一下），进程再留 2 秒通信余量：整个请求必须落在
// api-client.js 的 15 秒默认超时之内，否则界面会把「已保存、只是没等到确认」误报成
// 一次网络超时，用户会以为密码没存上。
const PROBE_SECONDS = 8;
const PROBE_TIMEOUT_MS = 10_000;

function defaultAgentBin() {
  return process.env.MULTICC_AGENT_BIN || path.join(homedir(), '.multicc', 'bin', 'multicc-agent');
}

// state 四态：
//   authorized       Agent 读得到密码 —— 以后锁屏解锁不会再弹任何框
//   waiting-for-user 系统正在等用户点「始终允许」（没点，或点了但这次读已经超时）
//   no-password      条目不在（保存没成功，或者刚被清掉）
//   unavailable      Agent 没装 / 没在跑 / 回话看不懂 —— 密码已保存，只是这次没能确认
function createUnlockProbe({
  platform = process.platform,
  execFileFn = execFile,
  agentBin = defaultAgentBin(),
} = {}) {
  function isAvailable() {
    return platform === 'darwin';
  }

  async function probe() {
    if (!isAvailable()) return { state: 'unavailable', detail: 'not-macos' };
    const reply = await new Promise((resolve) => {
      execFileFn(agentBin, ['probe-unlock', String(PROBE_SECONDS)], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
        resolve({ error, stdout: String(stdout || '') });
      });
    });
    let obj = null;
    try { obj = JSON.parse(reply.stdout.trim()); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') {
      return { state: 'unavailable', detail: reply.error ? 'agent-error' : 'bad-reply' };
    }
    if (obj.authorized === true) return { state: 'authorized' };
    if (obj.reason === 'no-password') return { state: 'no-password' };
    if (obj.reason === 'waiting-for-user') return { state: 'waiting-for-user' };
    return { state: 'unavailable', detail: String(obj.reason || obj.error || 'agent-error') };
  }

  return { isAvailable, probe };
}

module.exports = { createUnlockProbe, PROBE_SECONDS, PROBE_TIMEOUT_MS };
