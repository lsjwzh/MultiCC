'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'tour.js'), 'utf8');
const root = path.join(__dirname, '..');
const airHtml = fs.readFileSync(path.join(root, 'public', 'air.html'), 'utf8');
const airJs = fs.readFileSync(path.join(root, 'public', 'air.js'), 'utf8');
const airOnboarding = fs.readFileSync(path.join(root, 'public', 'air-onboarding.js'), 'utf8');

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

test('the opt-in sample workspace never writes into the running source tree', async () => {
  const gatewayRoutes = fs.readFileSync(
    path.join(root, 'native', 'gateway', 'src', 'app', 'directory_routes.rs'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'src', 'routes', 'directory-host.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const { createDirectoryHost } = require('../src/routes/directory-host');
  const sampleRoot = path.join(require('node:os').tmpdir(), 'test-onboarding-data', 'samples');
  const workspace = path.join(sampleRoot, 'getting-started');
  const created = [], directories = [];
  const result = await createDirectoryHost({ fsPort: {
    sampleRoot: () => sampleRoot,
    mkdirp: dir => directories.push(dir),
    writeFileExclusive: file => { created.push(file); return true; },
  } }).invoke({ op: 'sample-ensure' });
  assert.match(server, /sampleRoot: \(\) => MULTICC_PATHS\.sampleWorkspacesDir/);
  assert.deepEqual(directories, [workspace]);
  assert.equal(result.path, workspace);
  assert.deepEqual(created, ['README.md', 'index.html', 'styles.css', 'TASKS.md'].map(file => path.join(workspace, file)));
  assert.match(gatewayRoutes, /Lit\("onboarding"\), Lit\("sample-workspace"\)/);
  assert.match(gatewayRoutes, /\/api\/onboarding\/sample-workspace/);
  assert.match(host, /case 'sample-ensure':/);
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
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));
  // 卡片本体与两个直达入口都在 Air 页上
  assert.match(airHtml, /id="setup-card"/);
  assert.match(airHtml, /id="setup-provider"/);
  assert.match(airHtml, /id="setup-aux"/);
  // 而且它住在**控制台那一页**里（#console-center）—— 落地页就是控制台，
  // 引导开在目录首页上等于开在用户第二眼才到的地方。
  const consoleCenter = airHtml.slice(
    airHtml.indexOf('<section id="console-center"'),
    airHtml.indexOf('<section id="task-layout"'),
  );
  assert.match(consoleCenter, /id="setup-card"/);
  // 目录首页（#empty）在它后面 —— 文档里没有第二张卡，也没有留在老地方的那一张。
  const setupAt = airHtml.indexOf('id="setup-card"');
  const directoryHomeAt = airHtml.indexOf('<div id="empty">');
  assert.ok(
    setupAt > 0 && setupAt < directoryHomeAt,
    '首启卡应当只出现在控制台那一页里，而不是目录首页',
  );
  assert.equal(airHtml.match(/id="setup-card"/g).length, 1);
  // 2.6.2 起卡片是三步引导（模型+AI 助手 / 项目 / 第一个任务）
  assert.equal(airHtml.match(/id="setup-step-\d"/g).length, 3);
  // 第一步覆盖两条来路：导入已有线路，或用 CLI 自带登录。文案已移入词典，
  // 结构留在 air.html（data-i18n 键仍指向同一句），所以断言落在词典与键上。
  assert.match(airHtml, /data-i18n="airGuideModel"/);
  assert.match(zh.airSetupModelText, /导入你已有的 API 线路/);
  assert.match(zh.airSetupModelText, /CLI 自带的登录/);
  // AI Assist 的定位要说清三件事：核心、必须配置、flash 级弱模型就够。
  assert.equal(zh.airSetupAuxMust, '必须配置');
  assert.match(zh.airSetupAuxText, /它是 MultiCC 的核心/);
  assert.match(zh.airSetupAuxText2, /flash \/ 轻量模型即可/);
});

test('the setup card is driven by the real aux config, not a guess', () => {
  // 显示与否由 /api/aux/config 的 providerId 说话：null=未配置才亮卡
  assert.match(airJs, /api\('\/api\/aux\/config'\)/);
  assert.match(airJs, /auxConfigured = !!config\.providerId/);
  // 2.6.2 起卡片按三步完成度决定去留（AI 助手 / 项目 / 第一个任务），
  // 完成度算在 air-onboarding.js 里；未查到配置（null）时不亮卡。
  assert.match(airOnboarding,
    /const done = \[auxConfigured === true, data\.directories\.length > 0, data\.tasks\.length > 0\]/);
  assert.match(airOnboarding, /const incomplete = count < 3 && auxConfigured !== null/);
  assert.match(airOnboarding, /\$\('setup-card'\)\.hidden = !incomplete \|\| dismissed/);
  // 离开 AI Assistant（或线路）设置页时重查：刚保存过的话卡片当场消失
  assert.match(airJs, /\['aux', 'provider'\]\.includes\(mode\) && next !== mode/);
  // 跳过只藏卡不等于已配置，且记录在本机
  assert.match(airOnboarding, /air:setup-dismissed/);
});
