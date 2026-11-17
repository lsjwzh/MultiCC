'use strict';

// Migration bridge only: language validation and message generation live in
// Rust. Never fall back to unchecked text when the native module is missing.
const { getNative } = require('../native/runtime');

function native() {
  let addon;
  try { addon = getNative(); } catch (_) {}
  if (typeof addon?.validatePublicationText !== 'function' || typeof addon?.quickCommitMessage !== 'function'
      || typeof addon?.gitCommitEnvironment !== 'function' || typeof addon?.validatePublicationRange !== 'function') {
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
  await native().validatePublicationRange(cwd, range);
}

async function gitCommitEnvironment(cwd, args) {
  // Git CLI adapter shortlist only. Rust owns command interpretation and
  // identity resolution; read-only commands can run without the native addon.
  if (!args.some(arg => ['commit', 'merge', 'cherry-pick', 'rebase'].includes(arg))) return {};
  return JSON.parse(await native().gitCommitEnvironment(cwd, args));
}

module.exports = { validateCommitMessage, quickCommitMessage, validateCommitRange, gitCommitEnvironment };
