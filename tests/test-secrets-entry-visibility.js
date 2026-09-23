'use strict';

/**
 * Where the secrets vault (敏感信息) is allowed to live in the UI.
 *
 * Vault entries are injected into child processes as same-name environment
 * variables, so this is child-process environment configuration rather than a
 * switch inside some feature group — it belongs at the top of the control
 * center, not buried in a group. The complaint that produced these tests was
 * exactly that: the entry could not be found on the web side at all (the Air
 * shell hides manage.html's #nav, so the only web surfaces were the Air
 * console/settings center), and the App entry sat inside an advanced-only
 * 「服务器设置」 section.
 *
 * Static source assertions only — the rendered layout is measured elsewhere
 * (tests/test-manage-mobile-nav-layout.js, tests/test-air-console-cdp.js) and
 * the App side is pinned in app/test/secrets_entry_visibility_test.dart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** assert.match on a 100KB+ source file dumps the whole file on failure. */
function assertContains(haystack, needle, message) {
  assert.ok(
    needle instanceof RegExp ? needle.test(haystack) : haystack.includes(needle),
    `${message}\n  looked for: ${needle}`,
  );
}

const manageHtml = read('public/manage.html');
const manageSecrets = read('public/manage-secrets.js');
const airAdmin = read('public/air-admin.js');
const airJs = read('public/air.js');
const airHtml = read('public/air.html');
const airSecrets = read('public/air-secrets.js');

test('the vault card is pinned above the scrolling nav list, not inside a group', () => {
  assertContains(manageHtml, /\.nav-pinned\s*\{/, 'the pinned card needs its own rule so it can sit outside the scrolling list');
  const card = manageHtml.indexOf('class="nav-item nav-pinned"');
  const scrollingList = manageHtml.indexOf('id="nav-scroll"');
  assert.ok(card > 0, 'manage.html must render the pinned vault card');
  assert.ok(scrollingList > 0, 'manage.html must keep the scrolling nav list');
  assert.ok(card < scrollingList,
    'the pinned card must come before #nav-scroll, otherwise it scrolls away with the groups');
  assertContains(manageHtml, /class="nav-item nav-pinned" data-view="secrets"/,
    'the pinned card opens the secrets view');
  assertContains(manageHtml, /id="nav-secrets-count"/, 'the pinned card carries the entry-count badge');
});

test('the badge counts vault entries on load, not only after the panel is opened', () => {
  assertContains(manageSecrets, /function refreshSecretCount\(/,
    'the count must be refreshable without opening the panel');
  assertContains(manageSecrets, /document\.readyState === 'loading'[\s\S]{0,80}DOMContentLoaded[\s\S]{0,40}else boot\(\)/,
    'manage-secrets.js must boot the count fetch on page load (the badge otherwise sits at 0)');
  assertContains(manageSecrets, /window\.refreshSecretCount = refreshSecretCount/,
    'the console needs to re-read the count after a save or delete');
});

test('Air surfaces the vault first, and its page header is not the raw mode key', () => {
  assertContains(airAdmin, /^\s{4}secrets: \[t\('airAdminPanelSecrets'\)/m,
    'the vault panel must be registered in legacyPanels');
  assertContains(airAdmin, /\['airAdminGroupFeatured', \['secrets', 'docs', 'memory', 'taskgraph', 'workspaces'\]\]/,
    'the vault must be the first card of the settings center\'s first group');
  // 控制台那一格现在钉在顶栏上（不用滚到工具格才找得到），所以这条断的是
  // #console-head 里的常驻按钮，而不是工具格的卡。
  const consoleHead = airHtml.indexOf('id="console-head"');
  const consoleSecrets = airHtml.indexOf('id="console-secrets"');
  assert.ok(consoleSecrets > 0, 'air.html must render the console top-bar vault entry');
  assert.ok(consoleSecrets > consoleHead, 'the entry must sit inside #console-head');
  assertContains(airHtml, /id="console-secrets"[^>]*data-air-view="secrets"/,
    'air.js wires [data-air-view] → setMode, so the button needs the attribute to do anything');
  assert.ok(airAdmin.indexOf("['secrets', '🔐',") < 0,
    'the vault card must no longer sit in the console tools grid (it moved to the top bar)');
  // 页头文案来自 air.js 的 adminHeadings：漏了这一条，页头会把 mode 原样显示
  // （「secrets」），设置中心的标题却是「敏感信息」。
  assertContains(airJs, /^\s{6}secrets: \[/m,
    'air.js adminHeadings must carry a secrets heading, or the page header shows the raw mode key');
});

test('the Air vault panel is native: no manage iframe, its own module, loaded before the router', () => {
  // 渲染必须走 renderSecrets，不能在 render() 末尾掉进 renderLegacy 的 iframe 分支。
  assertContains(airAdmin, /function renderSecrets\(context\) \{/,
    'air-admin.js must own a native renderer for the vault');
  assertContains(airAdmin, /if \(mode === 'secrets'\) return renderSecrets\(context\);/,
    'render() must dispatch secrets to the native renderer before the legacy iframe fallback');
  assertContains(airAdmin, /root\.MultiCCAirSecrets/,
    'the native renderer must delegate to the air-secrets.js module');
  // legacyPanels 里那条只留作设置中心卡片与 modes 集合的元数据（同 aux），
  // 但元数据在、渲染却在 iframe 里的组合是这次要修掉的形态，所以反向断言一并钉住。
  const secretsRenderer = airAdmin.slice(airAdmin.indexOf('function renderSecrets(context) {'));
  const body = secretsRenderer.slice(0, secretsRenderer.indexOf('\n  }'));
  assert.ok(!/renderLegacy\(/.test(body),
    'renderSecrets must not fall back to the manage iframe');

  // 模块本体：列表只取元数据，明文值单独一条请求读回。
  assertContains(airSecrets, /context\.api\('\/api\/secrets'\)/,
    'the list must be read from the metadata-only endpoint');
  assertContains(airSecrets, /\/api\/secrets\/\$\{encodeURIComponent\(entry\.name\)\}\/value/,
    'revealing one value must go through the per-name value endpoint');
  assertContains(airSecrets, /root\.MultiCCAirSecrets = Object\.freeze\(\{ render, refresh:/,
    'the module must expose render/refresh on window for the router and the toolbar');

  // 注册顺序：air-admin.js 的 renderSecrets 读 root.MultiCCAirSecrets，晚于它的脚本
  // 会让面板每次都掉到「没加载」分支。
  const moduleTag = airHtml.indexOf('<script src="air-secrets.js"></script>');
  const adminTag = airHtml.indexOf('<script src="air-admin.js"></script>');
  assert.ok(moduleTag > 0, 'air.html must load air-secrets.js');
  assert.ok(moduleTag < adminTag, 'air-secrets.js must be registered before air-admin.js');
});
