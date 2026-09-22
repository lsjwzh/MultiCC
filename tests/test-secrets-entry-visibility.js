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
  assertContains(airAdmin, /\['airAdminGroupFeatured', \['secrets', 'docs', 'memory', 'taskgraph'\]\]/,
    'the vault must be the first card of the settings center\'s first group');
  assertContains(airAdmin, /\['secrets', '🔐',/,
    'the vault must be the first card of the console\'s system tools');
  // 页头文案来自 air.js 的 adminHeadings：漏了这一条，页头会把 mode 原样显示
  // （「secrets」），设置中心的标题却是「敏感信息」。
  assertContains(airJs, /^\s{6}secrets: \[/m,
    'air.js adminHeadings must carry a secrets heading, or the page header shows the raw mode key');
});
