'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

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
  assert.match(admin, /const settingGroups = \[[\s\S]*?\['重要功能', \['docs', 'memory', 'taskgraph'\]\]/);
  assert.match(admin, /air-settings-feature-group/);
  assert.match(read('public/manage.html'), /manage-air-embed\.css/);
  assert.match(read('public/manage-air-embed.css'), /html\.air-embed #nav/);
});

test('global CLI and Provider settings are native in Air', () => {
  const provider = read('public/air-provider.js');
  assert.match(provider, /api\/providers/);
  assert.match(provider, /api\/provider-defaults/);
  assert.match(provider, /speedtest/);
  assert.match(provider, /Provider 已创建/);
  assert.match(provider, /air-provider-card/);
});

test('regional tunnel onboarding is native and self-contained in Air', () => {
  const admin = read('public/air-admin.js');
  const tunnel = read('public/air-tunnel.js');
  const css = read('public/air.css');

  assert.match(admin, /function renderTunnel\(context\)/);
  assert.match(admin, /if \(mode === 'tunnel'\) return renderTunnel\(context\)/);
  assert.match(tunnel, /中国大陆方案/);
  assert.match(tunnel, /海外方案/);
  assert.match(tunnel, /SakuraFrp · 樱花内网穿透/);
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
