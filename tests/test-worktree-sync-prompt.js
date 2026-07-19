'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('worktree prompt distinguishes same-session busy from real sync conflicts', () => {
  assert.match(server, /不要要求目标会话启动后再重复 sync/);
  assert.match(server, /唯一阻塞原因是 busy\/running/);
  assert.match(server, /目标正是 \$MULTICC_SESSION_ID/);
  assert.match(server, /git status --short/);
  assert.match(server, /git rev-list --left-right --count HEAD\.\.\.main/);
  assert.match(server, /工作区 clean 且结果为 `0 0` 才可继续/);
  assert.match(server, /dirty、conflict、分支落后\/分叉/);
  assert.match(server, /不要把“正在回答本轮消息”误报成 worktree 冲突/);
});
