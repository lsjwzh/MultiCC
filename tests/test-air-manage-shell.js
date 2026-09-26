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
  // 旧 manage 页已删：面板路由里不能再有任何一条「嵌回去」的退路（注释里的出处说明不算）。
  assert.doesNotMatch(admin, /embed=air/);
  assert.doesNotMatch(admin, /createElement\('iframe'\)|<iframe/);
  assert.doesNotMatch(admin, /manage\.html\?/);
  // 分组标题现在存的是 key（显示文案查词典，className 判定也比这个 key），
  // 但「四组、顺序、每组装哪些面板」这条结构不能变 —— 保险箱是有意插在第一组最前面
  // 的那一条：它是子进程环境变量，不归任何一组功能。工作区（worktree 休眠回收）是继
  // 任务图谱之后第一组里的第二个 legacy iframe 面板，视图与 manage 侧同名。
  assert.match(admin, /const settingGroups = \[[\s\S]*?\['airAdminGroupFeatured', \['secrets', 'docs', 'memory', 'taskgraph', 'workspaces'\]\]/);
  assertLocalized(admin, 'public/air-admin.js', 'airAdminGroupFeatured', '重要功能', "make\\('h3', t\\(title\\)\\)");
  assert.match(admin, /air-settings-feature-group/);
  // 兼容皮肤（manage-air-embed.css）随旧页一起退场，public/ 下不该再有它。
  assert.equal(fs.existsSync(path.join(root, 'public', 'manage-air-embed.css')), false);
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

// 产物面板与「服务与文档」那一格的两件新东西：排列方式（按时间 / 按目录）与
// 永久保留。两件是独立的 —— 置顶只改排序，永久保留才是「永不被回收」那句承诺
// （7 天清理与登记表淘汰都只看它，见 src/docs-registry.js 的 rank/listPermanentArtifactIds）。
test('the docs panel switches 按时间 / 按目录 and toggles 永久保留 independently of 置顶', () => {
  const admin = read('public/air-admin.js');
  const css = read('public/air.css');
  // 两个视图的选择存本机，读取失败退回按时间（同 air.js 的 air:task-sort）。
  assert.match(admin, /const DOCS_SCOPE_KEY = 'air:docs-scope'/);
  assert.match(admin, /let docsScope = 'time'/);
  assertLocalized(admin, 'public/air-admin.js', 'docsScopeTime', '按时间', "\\['time', 'docsScopeTime'\\]");
  assertLocalized(admin, 'public/air-admin.js', 'docsScopeDir', '按目录', "\\['dir', 'docsScopeDir'\\]");
  assertLocalized(admin, 'public/air-admin.js', 'docsScopeLabel', '排列方式', "setAttribute\\('data-i18n-aria-label', 'docsScopeLabel'\\)");
  // 按目录视图按 entry.dir 分组，dir 为 null 的归到「未归属目录」且排最后。
  assert.match(admin, /function docsDirGroups\(\)/);
  assertLocalized(admin, 'public/air-admin.js', 'docsNoDir', '未归属目录');
  assert.match(admin, /const ordered = \[\.\.\.groups\.values\(\)\]\.filter\(group => group\.key\)/);
  // 永久保留是独立的一次 PATCH，只带 permanent，不带 pinned。
  // 两颗文案按当前状态二选一（同一处写死两个 key，同 airLidSleepOn/Off 那种写法）。
  const keepForeverRef = "'artifactKeepForeverOff' : 'artifactKeepForever'";
  assertLocalized(admin, 'public/air-admin.js', 'artifactKeepForever', '永久保留', keepForeverRef);
  assertLocalized(admin, 'public/air-admin.js', 'artifactKeepForeverOff', '取消永久保留', keepForeverRef);
  assert.match(admin, /function togglePermanent\(entry\)/);
  assert.match(admin, /\{ permanent: !entry\.permanent \}, 'PATCH'\)/);
  // 置顶那条不能被顺带改成 permanent（两件事分开是这次改动的全部要点）。
  assert.match(admin, /\{ pinned: !entry\.pinned \}, 'PATCH'\)/);
  assert.doesNotMatch(admin, /permanent: !entry\.permanent, pinned|pinned: !entry\.pinned, permanent/);
  // 状态标记与切换控件各有自己的样式。
  assert.match(css, /\.air-doc-tag\.permanent \{/);
  assert.match(css, /\.air-docs-scope button\[aria-selected="true"\]/);
  assert.match(css, /\.air-doc-group-head \{/);
});

// 目录首页那一格走独立模块（public/air-artifacts.js）：air.js 卡在行数棘轮的天花板上
// （scripts/check-source-line-budget.js 登记的高水位就是它当前的行数），一行也加不了，
// 所以入口按钮、面板与数据都由模块自己接线，可见性靠盯 #directory-memo.hidden 对齐。
test('the directory home artifact panel is a self-wiring module that never touches air.js', () => {
  const html = read('public/air.html');
  const js = read('public/air.js');
  const artifacts = read('public/air-artifacts.js');
  assert.match(html, /src="air-artifacts\.js"/);
  assert.ok(html.indexOf('src="air-artifacts.js"') < html.indexOf('src="air.js"'), '模块要先于 air.js 注册');
  // 入口按钮的形状：id / aria / 图标 + 内层标签（data-i18n 挂内层，applyI18n 才不会
  // 把图标一起冲掉 —— 同 #directory-terminal-new）。
  assert.match(artifacts, /toggle\.id = 'directory-artifacts'/);
  assert.match(artifacts, /toggle\.setAttribute\('aria-controls', 'directory-artifacts-panel'\)/);
  assert.match(artifacts, /node\('span', '📦'\)/);
  assert.match(artifacts, /label\.setAttribute\('data-i18n', 'airDirArtifacts'\)/);
  assert.match(artifacts, /memo\.after\(toggle\)/);
  // 可见性：盯 #directory-memo 的 hidden，并顺带盯 #directory-name（air.js 换目录
  // 走 pushState，不触发 popstate，但每次渲染都会重写侧栏目录名）。
  assert.match(artifacts, /observer\.observe\(memo, \{ attributes: true, attributeFilter: \['hidden'\] \}\)/);
  assert.match(artifacts, /observer\.observe\(name, \{ childList: true, characterData: true, subtree: true \}\)/);
  // 数据：URL 里的目录 id → /api/air 里的绝对路径 → ?dir= 作用域的登记表。
  assert.match(artifacts, /new URLSearchParams\(root\.location\.search\)\.get\('dir'\)/);
  assert.match(artifacts, /fetchJson\('\/api\/air'/);
  assert.match(artifacts, /\/api\/docs-registry\?dir=\$\{encodeURIComponent\(path\)\}/);
  // 服务不在这格里（服务与文档那一格管），只留一扇到那里的门。
  assert.match(artifacts, /entry\.kind !== 'service'/);
  assert.match(artifacts, /manage\.href = '\/manage\?view=docs'/);
  assertLocalized(artifacts, 'public/air-artifacts.js', 'taskArtifactsManage', '全部服务与文档 ↗');
  assertLocalized(artifacts, 'public/air-artifacts.js', 'airDirArtifactsEmpty', '本目录还没有产物。');
  assertLocalized(artifacts, 'public/air-artifacts.js', 'airDirArtifactsHint', '永久保留的排最上，其次是置顶，其余按最后生成时间');
  // 两颗按钮各发各的 PATCH，与面板那一格同义。
  assert.match(artifacts, /\{ permanent: !entry\.permanent \}/);
  assert.match(artifacts, /\{ pinned: !entry\.pinned \}/);
  // 设计决定：air.js 里没有这个入口，一个字节都没动。
  assert.doesNotMatch(js, /directory-artifacts/);
});
