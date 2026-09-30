'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const store = new Map();

function rawKeys(file) {
  const source = fs.readFileSync(file, 'utf8');
  const counts = new Map();
  for (const match of source.matchAll(/^\s*"([^"]+)"\s*:/gm)) {
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  return counts;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
}

const files = {
  zh: path.join(root, 'app', 'assets', 'i18n', 'zh.json'),
  en: path.join(root, 'app', 'assets', 'i18n', 'en.json'),
};
const catalogs = Object.fromEntries(Object.entries(files).map(([locale, file]) => {
  const duplicates = [...rawKeys(file)].filter(([, count]) => count > 1);
  assert.deepStrictEqual(duplicates, [], `${locale} contains duplicate keys: ${duplicates.map(([key]) => key).join(', ')}`);
  return [locale, JSON.parse(fs.readFileSync(file, 'utf8'))];
}));

assert.deepStrictEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.zh).sort(),
  'zh/en catalog keys must match exactly');
for (const key of Object.keys(catalogs.zh)) {
  assert.deepStrictEqual(placeholders(catalogs.en[key]), placeholders(catalogs.zh[key]),
    `placeholder mismatch for ${key}`);
}

const context = {
  window: {},
  document: { addEventListener() {}, querySelectorAll() { return []; }, documentElement: {} },
  // 真存真取：切换语言要断言「写进去了什么」，不能再用一个恒返回 'zh' 的桩。
  localStorage: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  },
  location: { reload() {} },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'public', 'i18n-catalog.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'public', 'i18n.js'), 'utf8'), context);

// Air 是唯一的产品主界面（/ 、/manage、/chat.html、/task-shell.html 全都 302 到它），
// 所以它的每一个 key 都必须落在词典里 —— 每个 air*.js 都扫，新模块不用回来加名字。
const airFiles = ['air.html', ...fs.readdirSync(path.join(root, 'public'))
  .filter((name) => /^air.*\.js$/.test(name)).sort()];
// 主界面之外的那些页（memo / events / meta / task-shell / wechat / dashboard …）以前不在
// 这道闸里：它们的中文能切、也能漏，只是没人守。task-shell.html 就是现成的例子 ——
// 「任务计划 / 任务说明 / 验收标准」三个标题一直没挂 data-i18n，英文模式下露中文，
// 而这份名单扫不到它，CI 一点都看不出来。所以改成 public 下每个页面都扫：新页面
// 不用回来登记，漏了 key 当场红。
const pageFiles = fs.readdirSync(path.join(root, 'public'))
  .filter((name) => name.endsWith('.html')).sort();
const webRefs = new Set();
// chat-ai-config.js 和 auto-provider-editor.js 也是 Air 里真的会渲染出来的共享模块
// （任务配置弹窗的模型/线路下拉、Auto 候选池），所以一起扫。
for (const name of [...pageFiles, 'chat.js', 'manage.js', 'manage-session-lifecycle.js',
  'chat-ai-config.js', 'auto-provider-editor.js', ...airFiles]) {
  const source = fs.readFileSync(path.join(root, 'public', name), 'utf8');
  for (const match of source.matchAll(/(?:\btt|\bt)\(\s*(['"])([^'"\n]+)\1/g)) webRefs.add(match[2]);
  for (const match of source.matchAll(/data-i18n(?:-title|-placeholder|-aria-label|-value)?=["']([^"']+)["']/g)) webRefs.add(match[1]);
  // t() 的参数不一定当场写成字面量 —— 也有 t(enabled ? 'airLidSleepOn' : 'airLidSleepOff')
  // 和先存进数组、渲染时才 t(title) 的写法。上面那条正则只抓「t('key')」，
  // 这两种就漏了（airLidSleepOn/Off 真的漏过一次，界面上直接显示出 key 本身）。
  // 所以凡是长得像词典 key 的引号字面量都收进来一并核对：宁可多问一句，也别让
  // 界面上出现裸 key。
  for (const match of source.matchAll(/['"]([a-z][A-Za-z0-9]{3,})['"]/g)) {
    if (/^(?:air|language)[A-Z]/.test(match[1])) webRefs.add(match[1]);
  }
}
for (const locale of ['zh', 'en']) {
  const missing = [...webRefs].filter(key => !(key in context.window.I18N[locale]));
  assert.deepStrictEqual(missing, [], `${locale} Web catalog misses: ${missing.join(', ')}`);
}

// Air 壳的骨架：侧栏、页头、对话浮层、几个对话框各挑一个锚点。这些 key 掉了，
// 英文界面就会露出中文（或干脆露出 key 本身），是「整个壳能切语言」的最小证据。
const AIR_SHELL_KEYS = [
  'airDocTitle', 'airWorkspace', 'airNewTask', 'airRecentTasks', 'airScheduledTasks',
  'airConsole', 'airSettingsCenter', 'airMoreSystem', 'airQuickAddRole', 'airPinToTop',
  'airTaskDetails', 'airDeliveryProgress', 'airStepTurnSucceeded', 'airBackToTask',
  'airPaletteSearchHint', 'airNewScheduledTask', 'airScheduleCreateAndBind',
  'airOpsUpdateMultiCC', 'airOpsChecking', 'airOpsPushNotify', 'airHeaderLoadingDirectory',
  'language', 'languageToggle',
];
// language 的英文值是 'EN/中'，languageToggle 的英文值是 'Switch language: 中文 / English'
// —— 这两处的「中」都是名字本身，不是漏翻。
const AIR_HAN_ALLOWED = new Set(['language', 'languageToggle']);
for (const locale of ['zh', 'en']) {
  for (const key of AIR_SHELL_KEYS) {
    assert.ok(key in context.window.I18N[locale], `${locale} is missing Air shell key ${key}`);
  }
}
for (const key of AIR_SHELL_KEYS) {
  const en = context.window.I18N.en[key];
  assert.ok(en && en !== key, `en value for ${key} is an empty string or the key itself`);
  if (!AIR_HAN_ALLOWED.has(key)) {
    assert.ok(!/[㐀-鿿豈-﫿]/.test(en), `en value for ${key} still contains Chinese: ${en}`);
  }
}

// 语言来源三段：显式选择 ＞ 系统语言 ＞ 英文。国际目录站（AppImageHub 那类）要求
// 非中文环境默认英文界面，所以「取不到系统语言」（Node 单测、C locale 容器）也算
// 英文环境；中文环境里的默认仍然是中文，老用户显式选过的语言也永远优先。
function setSystemLanguage(tag, list) {
  context.navigator = tag === null ? undefined : { language: tag, languages: list || [tag] };
}
setSystemLanguage('en-US');
assert.strictEqual(context.window.systemLang(), 'en', 'an English system resolves to English');
assert.strictEqual(context.window.getLang(), 'en', 'nothing stored on an English system boots English');
setSystemLanguage('zh-CN', ['zh-CN', 'zh']);
assert.strictEqual(context.window.getLang(), 'zh', 'a Chinese system must stay Chinese');
setSystemLanguage('zh-TW');
assert.strictEqual(context.window.getLang(), 'zh', 'every zh-* variant counts as Chinese');
setSystemLanguage('de-DE');
assert.strictEqual(context.window.getLang(), 'en', 'a third language falls back to English, never to Chinese');
setSystemLanguage(null);
assert.strictEqual(context.window.getLang(), 'en', 'no system language at all (C locale) falls back to English');

context.window.setLang('zh');
assert.strictEqual(store.get('multicc_lang'), 'zh', 'setLang must persist the choice');
assert.strictEqual(context.window.getLang(), 'zh', 'an explicit choice wins over the system language');
assert.strictEqual(context.window.t('airWorkspace'), catalogs.zh.airWorkspace);
setSystemLanguage('zh-CN');
context.window.setLang('en');
assert.strictEqual(context.window.getLang(), 'en');
assert.strictEqual(context.window.t('airWorkspace'), catalogs.en.airWorkspace);
assert.notStrictEqual(context.window.t('airWorkspace'), catalogs.zh.airWorkspace);
context.window.applyI18n();
assert.strictEqual(context.document.documentElement.lang, 'en', 'applyI18n must sync <html lang>');
context.window.toggleLang();
assert.strictEqual(store.get('multicc_lang'), 'zh', 'toggleLang must flip back to Chinese');
assert.strictEqual(context.window.t('airWorkspace'), catalogs.zh.airWorkspace);
context.window.applyI18n();
assert.strictEqual(context.document.documentElement.lang, 'zh');
// 认不出的取值落到「系统语言」，而不是写死中文：英文系统上拼错一个 lang 参数，
// 不该把用户从英文界面翻回中文。
context.window.setLang('fr');
assert.strictEqual(store.get('multicc_lang'), 'zh', 'an unknown language falls back to the system language (zh here)');
setSystemLanguage('en-US');
context.window.setLang('fr');
assert.strictEqual(store.get('multicc_lang'), 'en', 'an unknown language on an English system stays English');

console.log(`i18n catalogs OK: ${Object.keys(catalogs.zh).length} shared keys, ${webRefs.size} Web references`);

