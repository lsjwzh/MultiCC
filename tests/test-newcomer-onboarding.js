'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'tour.js'), 'utf8');

test('onboarding teaches a safe first result instead of implementation concepts', () => {
  assert.match(source, /选择一个工作区/);
  assert.match(source, /开始一段对话/);
  assert.match(source, /先不要修改任何文件/);
  assert.match(source, /第一份结果已经完成/);
  assert.doesNotMatch(source, /Fleet就是一个 git 仓库/);
  assert.doesNotMatch(source, /session 就是一个子 agent/);
  assert.doesNotMatch(source, /第一条多 CLI 编排命令/);
});

test('a real first assistant result advances the final onboarding step', () => {
  assert.match(source, /selector: '#input',[\s\S]*fill: true/);
  assert.match(source, /selector: '#messages'/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /resultBaseline\.sent/);
  assert.match(source, /addEventListener\('click', markSent, true\)/);
  assert.match(source, /users > resultBaseline\.users/);
  assert.match(source, /assistants > resultBaseline\.assistants/);
  assert.match(source, /show\(4\)/);
});
