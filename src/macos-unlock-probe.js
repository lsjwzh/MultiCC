'use strict';

// Bounded Agent readiness check, without returning credentials. Ordinary
// switch changes never prompt. Saving a password or explicitly checking access
// may allow the system sheet while the screen is unlocked.
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
//   authorized       Agent supports the power switches and can read the credential
//   waiting-for-user 系统正在等用户点「始终允许」（没点，或点了但这次读已经超时）
//   no-password      条目不在（保存没成功，或者刚被清掉）
//   unavailable      Agent 没装 / 没在跑 / 回话看不懂 —— 密码已保存，只是这次没能确认
//
// unavailable 还带 detail，界面照它给具体指引：execFile 的 errno 能分辨「程序没装」和
// 「程序装了但跑不起来」，混成一句「请确认 Agent 正在运行」会让用户在一个永远点不好的
// 「检查授权」上打转（后者正是安装脚本复制预编译二进制时丢了 0755 的现场）。修法是
// 重启 MultiCC —— 启动时的自动安装会把执行位补回来。
function spawnDetail(error) {
  if (!error) return 'bad-reply';
  if (error.code === 'EACCES') return 'agent-not-executable';
  if (error.code === 'ENOENT') return 'agent-not-installed';
  return 'agent-error';
}

function createUnlockProbe({
  platform = process.platform,
  execFileFn = execFile,
  agentBin = defaultAgentBin(),
} = {}) {
  function isAvailable() {
    return platform === 'darwin';
  }

  async function probe({ allowUI = false } = {}) {
    if (!isAvailable()) return { state: 'unavailable', detail: 'not-macos' };
    const reply = await new Promise((resolve) => {
      execFileFn(agentBin, ['probe-unlock', String(PROBE_SECONDS), ...(allowUI ? ['--allow-ui'] : [])], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
        resolve({ error, stdout: String(stdout || '') });
      });
    });
    let obj = null;
    try { obj = JSON.parse(reply.stdout.trim()); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') {
      return { state: 'unavailable', detail: spawnDetail(reply.error) };
    }
    if (obj.authorized === true) return obj.powerProtocol === 1
      ? { state: 'authorized' } : { state: 'unavailable', detail: 'agent-update-required' };
    if (obj.reason === 'no-password') return { state: 'no-password' };
    if (obj.reason === 'waiting-for-user') return { state: 'waiting-for-user' };
    return { state: 'unavailable', detail: String(obj.reason || obj.error || 'agent-error') };
  }

  async function runtimeReady() {
    if (!isAvailable()) return false;
    return new Promise(resolve => {
      execFileFn(agentBin, ['ping'], { timeout: 3000 }, (error, stdout) => {
        try { resolve(!error && JSON.parse(String(stdout)).powerProtocol === 1); }
        catch { resolve(false); }
      });
    });
  }
  return { isAvailable, probe, runtimeReady };
}

module.exports = { createUnlockProbe, PROBE_SECONDS, PROBE_TIMEOUT_MS };
