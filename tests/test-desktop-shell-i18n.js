'use strict';
// 桌面壳那两页（splash / 启动失败）的语言判定。
//
// 为什么值得单独钉死：AppImageHub 那类目录站在容器里启动这个 AppImage 并给窗口截图，
// LANG 未设，截图里只要还有中文就判「不是英文界面」—— 而启动失败页恰恰是最容易被截到
// 的那一页（后端在只读 squashfs 里起不来）。所以「非中文系统 ⇒ 英文」这条不能靠人眼。
//
// shell-i18n.js 是给 file:// 文档用的独立小词典（拿不到 public/i18n.js），规则必须和
// web 端一致：显式选择 ＞ 系统语言 ＞ 英文。这里按同样的顺序验一遍。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'assets', 'shell-i18n.js'), 'utf8');

// 起一个最小的 file:// 岛：只要 location / navigator / localStorage 三样。
function loadShell({ search = '', language = 'en-US', stored = null } = {}) {
  const store = new Map();
  if (stored) store.set('multicc_lang', stored);
  const sandbox = {
    location: { search, reload() {} },
    navigator: { language },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
    document: { documentElement: {}, querySelectorAll: () => [], body: null, title: '' },
    // file:// 岛也要这几个：shell-i18n.js 用 URLSearchParams 读 ?lang=，
    // 它们不在 vm 的新全局里，不注入就是 ReferenceError。
    URLSearchParams,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'shell-i18n.js' });
  return { shell: sandbox.MultiCCShellI18n, store };
}

test('a Chinese system language (BCP-47 or POSIX form) resolves to zh', () => {
  for (const tag of ['zh-CN', 'zh_CN.UTF-8', 'zh', 'ZH-TW']) {
    assert.strictEqual(loadShell({ language: tag }).shell.lang(), 'zh', tag);
  }
});

// 复现目录站容器的那一帧：没有 ?lang=、navigator 说的是 en-US 或干脆空。
test('a non-Chinese system language falls back to English, never to Chinese', () => {
  for (const tag of ['en-US', 'de-DE', 'ja-JP', 'C', '']) {
    const shell = loadShell({ language: tag }).shell;
    assert.strictEqual(shell.lang(), 'en', tag);
    assert.strictEqual(shell.t('failedTitle'), 'MultiCC failed to start');
    assert.strictEqual(shell.t('retry'), 'Retry');
  }
});

// Electron 把 LANG/LC_* 经 app.getLocale() 走 ?lang= 传进来，它是第一手信息；
// navigator.language 只是没有参数时的退路。
test('?lang= from the Electron main process outranks navigator.language', () => {
  const zh = loadShell({ search: '?lang=zh-CN', language: 'en-US' }).shell;
  assert.strictEqual(zh.lang(), 'zh');
  assert.strictEqual(zh.t('retry'), '重试启动');

  const en = loadShell({ search: '?lang=en-US', language: 'zh-CN' }).shell;
  assert.strictEqual(en.lang(), 'en');
});

// 用户在错误页点过 EN/中 之后，这个选择要压过系统语言（否则切了等于没切）。
test('an explicit choice in localStorage beats both ?lang= and the system language', () => {
  const en = loadShell({ search: '?lang=zh-CN', language: 'zh-CN', stored: 'en' }).shell;
  assert.strictEqual(en.lang(), 'en');
  assert.strictEqual(en.t('failedTitle'), 'MultiCC failed to start');

  const zh = loadShell({ search: '?lang=en-US', language: 'en-US', stored: 'zh' }).shell;
  assert.strictEqual(zh.lang(), 'zh');
});

test('toggleLang flips the stored choice and reloads', () => {
  const { shell, store } = loadShell({ language: 'en-US' });
  assert.strictEqual(shell.lang(), 'en');
  shell.toggleLang();
  assert.strictEqual(store.get('multicc_lang'), 'zh');
  shell.setLang('en');
  assert.strictEqual(store.get('multicc_lang'), 'en');
});

// 词典本身：两种语言键集必须一模一样，缺一条就会在界面上漏出 raw key。
test('both locales carry exactly the same keys, and every key has real text', () => {
  const { COPY } = loadShell().shell;
  const zh = Object.keys(COPY.zh).sort();
  const en = Object.keys(COPY.en).sort();
  assert.deepStrictEqual(en, zh);
  for (const key of zh) {
    assert.ok(COPY.zh[key] && COPY.zh[key].trim(), `zh.${key} is empty`);
    assert.ok(COPY.en[key] && COPY.en[key].trim(), `en.${key} is empty`);
    // 中英一字不差的条目是有意的语言中立文案（那颗 EN/中 切换按钮的标签和它的
    // title，两边都印双语），放过；其余条目英文那份不许还留着汉字 ——
    // 这一句就是目录站那条反馈本身。
    if (COPY.zh[key] === COPY.en[key]) continue;
    assert.ok(!/[㐀-鿿]/.test(COPY.en[key]), `en.${key} still has Chinese: ${COPY.en[key]}`);
  }
});

// 启动失败页的「后台日志末尾」标签：英文页面里不能印中文。
test('the startup-failure page speaks English for a non-Chinese system', () => {
  const { shell } = loadShell({ search: '?lang=en-US' });
  assert.strictEqual(shell.t('detail'), 'End of the backend log');
  assert.strictEqual(shell.t('logsLabel'), 'Logs');
  assert.strictEqual(shell.t('labelSep'), ': ');
  assert.strictEqual(shell.t('reasonMissingRuntime').slice(0, 8), 'The bund');
});
