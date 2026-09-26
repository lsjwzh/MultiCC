'use strict';

// 锁屏密码存取：自动解锁用的登录密码只写进本机登录钥匙串（login keychain），
// 不进 MultiCC 的 vault、不经过 LLM。写路径在服务端（Air 全局设置里的密码框），
// 读路径在 MultiCC Agent（解锁时用 Security framework 读同一个条目）。
// `security` 工具的 -w 会把密码短暂出现在进程参数里（同 macos-power 里 osascript
// 弹管理员密码的先例），所以绝不把密码写进日志、错误消息或任何回复。
const { execFile } = require('node:child_process');
const { userInfo } = require('node:os');

const SERVICE = 'com.multicc.agent.unlock';
const MAX_PASSWORD_LENGTH = 2048;

function defaultAccount() {
  return process.env.USER || (userInfo().username) || 'root';
}

function createUnlockPassword({ platform = process.platform, execFileFn = execFile, account = defaultAccount() } = {}) {
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
    const r = await run(['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', password]);
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