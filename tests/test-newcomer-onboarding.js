'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'tour.js'), 'utf8');
const root = path.join(__dirname, '..');
const setupSource = fs.readFileSync(path.join(root, 'public', 'manage-workspace-setup.js'), 'utf8');
const manageHtml = fs.readFileSync(path.join(root, 'public', 'manage.html'), 'utf8');

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

test('empty state offers a safe opt-in sample instead of registering live source', () => {
  const dashboard = fs.readFileSync(path.join(root, 'public', 'manage-dashboard.js'), 'utf8');
  const sample = fs.readFileSync(path.join(root, 'src', 'directory', 'sample-workspace.js'), 'utf8');
  assert.match(dashboard, /体验示例工作区（约 2 分钟）/);
  assert.match(dashboard, /不会修改正在运行的 MultiCC 源码/);
  assert.match(setupSource, /\/api\/onboarding\/sample-workspace/);
  assert.match(sample, /sampleRoot\(\)/);
  assert.doesNotMatch(sample, /PKG_ROOT|__dirname/);
  assert.match(sample, /writeFileExclusive/);
  const sampleDialog = setupSource.slice(
    setupSource.indexOf('function createSampleWorkspace()'),
    setupSource.indexOf('Object.assign(global'),
  );
  assert.match(sampleDialog, /loadTemplates\(\)/);
  assert.doesNotMatch(sampleDialog, /api\.json/);
  assert.match(setupSource, /sampleFlow\s*\?\s*await api\.json\('\/api\/onboarding\/sample-workspace'/);
});

test('workspace setup exposes curated team bundles backed by valid role presets', () => {
  const teams = JSON.parse(fs.readFileSync(path.join(root, 'public', 'team-presets.json'), 'utf8'));
  const agents = JSON.parse(fs.readFileSync(path.join(root, 'public', 'agent-presets.json'), 'utf8'));
  const ids = new Set(agents.presets.map(item => item.id));
  assert.equal(teams.defaultTemplateId, 'quick-product');
  assert.ok(teams.templates.length >= 4);
  assert.ok(teams.templates.some(item => item.roles.length === 0));
  for (const team of teams.templates) {
    assert.ok(team.name.zh && team.name.en && team.description.zh && team.description.en);
    assert.ok(team.roles.length <= 4, `${team.id} should stay cognitively bounded`);
    for (const role of team.roles) assert.ok(ids.has(role.presetId), `${role.presetId} must exist`);
  }
  assert.match(setupSource, /role-workers\/\$\{encodeURIComponent\(role\.presetId\)\}/);
  assert.match(setupSource, /for \(let index = 0; index < roles\.length; index\+\+\)/);
  assert.match(setupSource, /timeoutMs: 60000/);
  assert.match(setupSource, /submit\.disabled = busy \|\| !templatesReady/);
  assert.match(setupSource, /workspace-role-details/);
});

test('primary creation UI explains workspace, path, team, and runtime impact', () => {
  assert.match(manageHtml, /创建工作区/);
  assert.match(manageHtml, /工作区是希望 MultiCC 帮你处理的本地文件夹/);
  assert.match(manageHtml, /选择 Agent 团队/);
  assert.match(manageHtml, /角色创建后不会自动执行任务/);
  assert.match(manageHtml, /路径不存在时，创建这个文件夹/);
  assert.doesNotMatch(manageHtml, /Fleet不存在时自动创建/);
});
