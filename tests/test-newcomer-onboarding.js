'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'tour.js'), 'utf8');
const root = path.join(__dirname, '..');
const airHtml = fs.readFileSync(path.join(root, 'public', 'air.html'), 'utf8');
const airJs = fs.readFileSync(path.join(root, 'public', 'air.js'), 'utf8');

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

test('the opt-in sample workspace never writes into the running source tree', () => {
  const sample = fs.readFileSync(path.join(root, 'src', 'directory', 'sample-workspace.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'src', 'directory', 'controller.js'), 'utf8');
  assert.match(sample, /sampleRoot\(\)/);
  assert.doesNotMatch(sample, /PKG_ROOT|__dirname/);
  assert.match(sample, /writeFileExclusive/);
  assert.match(controller, /\/api\/onboarding\/sample-workspace/);
});

test('curated team bundles stay backed by valid role presets', () => {
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
});

test('directory creation leaves roles and execution to tasks', () => {
  const settings = fs.readFileSync(path.join(root, 'public', 'air-task-settings.js'), 'utf8');
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));
  assert.match(settings, /t\('airTaskSettingsCreateIfMissing'\)/);
  assert.equal(zh.airTaskSettingsCreateIfMissing, '路径不存在时自动创建');
  assert.doesNotMatch(settings, /选择 Agent 团队|role-workers|provisionTeam/);
});

// 2.0：新用户落地是 /air（/ 与 /manage 都重定向过去），而旧版 tour.js 只挂
// 在已退役的 manage/chat 页上——主入口此前没有任何引导。首启配置卡补上
// 这个缺口，且它教的是两件真正必须的事：先有模型，再配 AI Assistant。
test('the Air landing page teaches model setup and mandatory AI Assist config', () => {
  // 卡片本体与两个直达入口都在 Air 页上
  assert.match(airHtml, /id="setup-card"/);
  assert.match(airHtml, /id="setup-provider"/);
  assert.match(airHtml, /id="setup-aux"/);
  // 第一步覆盖两条来路：导入已有线路，或用 CLI 自带登录
  assert.match(airHtml, /导入你已有的 API 线路/);
  assert.match(airHtml, /CLI 自带的登录/);
  // AI Assist 的定位要说清三件事：核心、必须配置、flash 级弱模型就够。i18n 之后
  // 「配置 AI Assistant」和后半句各自带 data-i18n，中间隔着那个 span，所以这里容下它。
  assert.match(airHtml, /AI Assistant<\/strong><span[^>]*>：它是 MultiCC 的核心/);
  assert.match(airHtml, /必须配置/);
  assert.match(airHtml, /flash \/ 轻量模型即可/);
});

test('the setup card is driven by the real aux config, not a guess', () => {
  // 显示与否由 /api/aux/config 的 providerId 说话：null=未配置才亮卡
  assert.match(airJs, /api\('\/api\/aux\/config'\)/);
  assert.match(airJs, /auxConfigured = !!config\.providerId/);
  assert.match(airJs, /card\.hidden = !\(data && auxConfigured === false && !setupDismissed\)/);
  // 离开 AI Assistant 设置页时重查：刚保存过的话卡片当场消失
  assert.match(airJs, /mode === 'aux' && next !== 'aux'/);
  // 跳过只藏卡不等于已配置，且记录在本机
  assert.match(airJs, /air:setup-dismissed/);
});
