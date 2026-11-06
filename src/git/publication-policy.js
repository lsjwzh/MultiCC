'use strict';

// Migration bridge only: language validation and message generation live in
// Rust. Never fall back to unchecked text when the native module is missing.
const { getNative } = require('../native/runtime');

function native() {
  let addon;
  try { addon = getNative(); } catch (_) {}
  if (typeof addon?.validatePublicationText !== 'function' || typeof addon?.quickCommitMessage !== 'function'
      || typeof addon?.gitCommitEnvironment !== 'function' || typeof addon?.validatePublicationRecords !== 'function') {
    throw new Error('提交身份与英文校验模块不可用，请构建当前版本的 Rust 模块后重试');
  }
  return addon;
}

async function validateCommitMessage(message) {
  await native().validatePublicationText('commit', String(message || ''));
  return message;
}

function quickCommitMessage(porcelain) {
  return native().quickCommitMessage(String(porcelain || ''));
}

async function validateCommitRange(execGit, cwd, range) {
  const records = await execGit(cwd, ['log', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00', range], { raw: true });
  await native().validatePublicationRecords(cwd, String(records || ''));
}

async function gitCommitEnvironment(cwd, args) {
  // Git CLI adapter shortlist only. Rust owns command interpretation and
  // identity resolution; read-only commands can run without the native addon.
  if (!args.some(arg => ['commit', 'merge', 'cherry-pick', 'rebase'].includes(arg))) return {};
  return JSON.parse(await native().gitCommitEnvironment(cwd, args));
}

module.exports = { validateCommitMessage, quickCommitMessage, validateCommitRange, gitCommitEnvironment };
