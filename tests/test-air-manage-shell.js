'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const zh = JSON.parse(read('app/assets/i18n/zh.json'));

// 这几条以前直接盯源码里的中文字面量。Air 支持中/英切换之后，文案只留在词典里，
// 源码里剩下的是 key —— 所以判据变成「词典里还写着这句中文，且模块确实按 key 取它」。
// 渲染出来的中文由 tests/test-air-*.js（沙箱里带中文 t()）和 CDP 那组去断。
function assertLocalized(source, file, key, chinese, reference) {
  assert.equal(zh[key], chinese, `zh.json must keep ${chinese} under ${key}`);
  // 默认判据是「源码里直接按字面量取这条 key」；分组标题那种把 key 存进数组、
  // 渲染时再 t(title) 的写法，由调用方给一条更贴切的引用断言。
  assert.match(source, new RegExp(reference || `t\\(\\s*'${key}'`), `${file} must read ${key} through i18n`);
}

test('Air owns the management home and exposes the management navigation', () => {
  const html = read('public/air.html');
  const js = read('public/air.js');
  assert.match(html, /id="overview"[^>]*>.*控制台/s);
  assert.match(html, /id="admin-center"/);
  assert.match(html, /data-air-view="docs"/);
  assert.match(html, /data-air-view="memory"/);
  assert.match(html, /data-air-view="settings"/);
  assert.match(html, /id="side-more"[\s\S]*?id="frequent-settings"[\s\S]*?data-air-view="provider"[\s\S]*?data-air-view="tunnel"[\s\S]*?data-air-view="bridges"/);
  // 「更多与系统」里每一组各一个框（.side-group），常用设置那一组自己还是可收缩的
  // details；Provider 配置是这一栏里最重的一行（is-primary），关盖运行跟在后面。
  assert.match(html, /class="side-group" open>[\s\S]*?id="frequent-settings"[\s\S]*?class="sidebar-setting-row is-primary" data-air-view="provider"/);
  assert.match(html, /id="air-lid-sleep"[\s\S]*?关盖运行/);
  assert.equal((html.match(/side-group"/g) || []).length, 4, '四组各一个框');
  assert.match(read('public/air.js'), /\/api\/settings\/power/);
  assert.match(read('public/air.css'), /\.frequent-settings \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(html, /src="air-admin\.js"/);
  assert.match(html, /src="air-provider\.js"/);
  assert.match(html, /src="air-tunnel\.js"/);
  assert.ok(html.indexOf('src="air-tunnel.js"') < html.indexOf('src="air-admin.js"'), 'native tunnel module must register before the Air admin router');
  assert.match(js, /adminModes\.has\(requested\)/);
  assert.match(js, /MultiCCAirAdmin\?\.render/);
});

test('native Air registry and compatibility panels preserve every former manage child', () => {
  const admin = read('public/air-admin.js');
  for (const view of ['memory', 'voice', 'goal', 'provider', 'global', 'push', 'tunnel', 'bridges', 'resources', 'skillsync', 'storage']) {
    assert.match(admin, new RegExp(`${view}: \\[`), `${view} should remain reachable inside Air`);
  }
  assert.doesNotMatch(admin, /planner: \[/);
  assert.match(admin, /api\/docs-registry/);
  assert.match(admin, /MultiCCAirProvider/);
  assert.match(admin, /service-dialog/);
  assert.match(admin, /embed=air/);
  // 分组标题现在存的是 key（显示文案查词典，className 判定也比这个 key），
  // 但「四组、顺序、每组装哪些面板」这条结构不能变 —— 保险箱是有意插在第一组最前面
  // 的那一条：它是子进程环境变量，不归任何一组功能。工作区（worktree 休眠回收）是继
  // 任务图谱之后第一组里的第二个 legacy iframe 面板，视图与 manage 侧同名。
  assert.match(admin, /const settingGroups = \[[\s\S]*?\['airAdminGroupFeatured', \['secrets', 'docs', 'memory', 'taskgraph', 'workspaces'\]\]/);
  assertLocalized(admin, 'public/air-admin.js', 'airAdminGroupFeatured', '重要功能', "make\\('h3', t\\(title\\)\\)");
  assert.match(admin, /air-settings-feature-group/);
  assert.match(read('public/manage.html'), /manage-air-embed\.css/);
  assert.match(read('public/manage-air-embed.css'), /html\.air-embed #nav/);
});

test('global CLI and Provider settings are native in Air', () => {
  const provider = read('public/air-provider.js');
  assert.match(provider, /api\/providers/);
  assert.match(provider, /api\/provider-defaults/);
  assert.match(provider, /speedtest/);
  assertLocalized(provider, 'public/air-provider.js', 'airProviderCreated', 'Provider 已创建。');
  assert.match(provider, /air-provider-card/);
});

test('regional tunnel onboarding is native and self-contained in Air', () => {
  const admin = read('public/air-admin.js');
  const tunnel = read('public/air-tunnel.js');
  const css = read('public/air.css');

  assert.match(admin, /function renderTunnel\(context\)/);
  assert.match(admin, /if \(mode === 'tunnel'\) return renderTunnel\(context\)/);
  assertLocalized(tunnel, 'public/air-tunnel.js', 'airTunnelCnPlanEyebrow', '中国大陆方案');
  assertLocalized(tunnel, 'public/air-tunnel.js', 'airTunnelGlobalPlanEyebrow', '海外方案');
  // 标题是「SakuraFrp · 樱花内网穿透」：品牌名是数据、后半句才是文案，断模板本身。
  assert.match(tunnel, /<h3 id="air-tunnel-cn-title">SakuraFrp · \$\{t\('airTunnelCnTitle'\)\}<\/h3>/);
  assertLocalized(tunnel, 'public/air-tunnel.js', 'airTunnelCnTitle', '樱花内网穿透');
  assert.match(tunnel, /Tailscale Funnel/);
  assert.match(tunnel, /api\/tunnel\/sakurafrp\/install/);
  assert.match(tunnel, /api\/tunnel\/sakurafrp\/public-url/);
  assert.match(tunnel, /api\/tunnel\/funnel/);
  assert.match(tunnel, /api\/tunnel\/ipv6/);
  assert.match(tunnel, /api\/settings\/access-token/);
  assert.match(tunnel, /type="password" autocomplete="new-password"/);
  assert.doesNotMatch(tunnel, /manage\.html\?view=tunnel/);
  assert.match(css, /\.air-tunnel-route-grid \{ display: grid; grid-template-columns: repeat\(2/);
  assert.match(css, /\.air-tunnel-compat-grid/);
});
