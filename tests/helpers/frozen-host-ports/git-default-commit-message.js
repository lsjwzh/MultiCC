'use strict';

// The default message generator lives in Rust. User-supplied messages are
// passed to Git without a project-independent language policy.
const { getNative } = require('../../../src/native/runtime');

function native() {
  let addon;
  try { addon = getNative(); } catch (_) {}
  if (typeof addon?.quickCommitMessage !== 'function') {
    throw new Error('提交说明生成模块不可用，请构建当前版本的 Rust 模块后重试');
  }
  return addon;
}

function quickCommitMessage(porcelain) {
  return native().quickCommitMessage(String(porcelain || ''));
}

module.exports = { quickCommitMessage };
