'use strict';

// 锁屏密码存取：自动解锁用的登录密码只写进本机登录钥匙串（login keychain），
// 不进 MultiCC 的 vault、不经过 LLM。写路径在服务端（Air 全局设置里的密码框），
// 读路径在 MultiCC Agent（解锁时用 Security framework 读同一个条目）。
// `security` 工具的 -w 会把密码短暂出现在进程参数里（同 macos-power 里 osascript
// 弹管理员密码的先例），所以绝不把密码写进日志、错误消息或任何回复。
const { execFile } = require('node:child_process');
const { homedir, userInfo } = require('node:os');
const path = require('node:path');

const SERVICE = 'com.multicc.agent.unlock';
const MAX_PASSWORD_LENGTH = 2048;

// 读这条目的应用是 MultiCC Agent，写它的是服务端（/usr/bin/security）。登录钥匙串
// 默认「只信任创建条目的应用」（security(1) 原文），所以 Agent 读它会弹系统授权框
// ——锁屏时那个框点不到，Agent 就卡在读密码那步（实测卡死 3 分钟、整条 computer-use
// 链路跟着挂）。写入时显式把 Agent 放进 ACL，这一次授权就不需要了，用户「输一次密码、
// 之后零介入」。
// 用应用包路径而不是可执行文件路径：ACL 里记的是应用身份，人工点「始终允许」写进去的
// 也是同一个。Agent 是 Developer ID 签名（designated requirement 是 identifier+TeamID
// 而不是 cdhash），所以这条授权扛得住它被重新编译/更新，不会每次更新又弹一次。
function defaultAgentAppPath() {
  return process.env.MULTICC_AGENT_APP || path.join(homedir(), 'Applications', 'MultiCC Agent.app');
}

function defaultAccount() {
  return process.env.USER || (userInfo().username) || 'root';
}

function createUnlockPassword({
  platform = process.platform,
  execFileFn = execFile,
  account = defaultAccount(),
  agentAppPath = defaultAgentAppPath(),
} = {}) {
  function isAvailable() {
    return platform === 'darwin';
  }

  function run(args) {
    return new Promise((resolve) => {
      execFileFn('/usr/bin/security', args, { timeout: 8000 }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  async function hasPassword() {
    if (!isAvailable()) return false;
    // 只探测存在性：绝不带 -w，find 输出的是条目属性而不是密码本身。
    const r = await run(['find-generic-password', '-s', SERVICE, '-a', account]);
    return r.ok;
  }

  async function setPassword(password) {
    if (!isAvailable()) throw new Error('This setting is only available on macOS');
    if (typeof password !== 'string' || password.length === 0) throw new Error('unlock password is required');
    if (password.length > MAX_PASSWORD_LENGTH) throw new Error('unlock password is too long');
    const r = await run([
      'add-generic-password', '-U', '-s', SERVICE, '-a', account,
      '-T', agentAppPath, '-w', password,
    ]);
    if (!r.ok) {
      const detail = r.stderr.trim() || 'security returned an error';
      throw new Error(`failed to save unlock password: ${detail}`);
    }
  }

  async function clearPassword() {
    if (!isAvailable()) return;
    await run(['delete-generic-password', '-s', SERVICE, '-a', account]);
  }

  return { isAvailable, hasPassword, setPassword, clearPassword };
}

module.exports = { createUnlockPassword, SERVICE, MAX_PASSWORD_LENGTH };