'use strict';

// 交接包的两个弹窗（public/chat-handoff.js）是 web 上唯一能点到 handoff 接口的
// 地方，所以这里守三件事：
//   1. 导出 URL 永远带全五个记忆 scope，且只有一个「只导执行环境」开关 —— 代码层
//      同不同仓库由服务端 sameRepository 判定，界面上不许再长出 git 设置。
//   2. 导入按容器分流：zip 发原始字节到 import-zip，JSON 解出来再补落地参数；
//      三种落点（envOnly / dirId / targetSessionId）互斥，各自只带自己那一个。
//   3. 入口真的接上了：chat.html 先加载这个模块再加载 chat.js，chat.js 的分享
//      卡片里有那两个按钮并且转交给它。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'chat-handoff.js'), 'utf8');
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
const ZH = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));
// 模块不自己转义，用的是页面全局那一份（chat.html 先加载 shared/dom-helpers.js）。
// 沙箱里就放规范实现，顺带证明它确实在委托。
const { escapeHtml } = require(path.join(ROOT, 'public', 'shared', 'dom-helpers.js'));

// ── 极简 DOM：querySelector 只认模块真会问的那几种选择器，并且要求 innerHTML 里
//    真的写出了这个 data-role —— 弹窗里少写一个字段，测试会红，而不是被桩吞掉。
function stubElement(tag) {
  const roles = new Map();
  const buttons = new Map();
  const element = {
    tagName: tag,
    children: [],
    appended: [],
    style: { cssText: '' },
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    files: [],
    appendChild(child) {
      element.children.push(child);
      element.appended.push(child);
      child.parentNode = element;
      return child;
    },
    remove() {
      const parent = element.parentNode;
      if (parent) parent.children = parent.children.filter(item => item !== element);
    },
    click() { if (typeof element.onclick === 'function') element.onclick({ target: element }); },
    querySelector(selector) {
      const role = /\[data-role="([^"]+)"\]/.exec(selector);
      if (!role) return null;
      if (!element.innerHTML.includes(`data-role="${role[1]}"`)) return null;
      return nodeFor(roles, role[1], 0, stubElement('input'));
    },
    querySelectorAll(selector) {
      if (selector === 'button') {
        const total = (element.innerHTML.match(/<button/g) || []).length;
        return Array.from({ length: total }, (_, index) => nodeFor(buttons, 'button', index, stubElement('button')));
      }
      const role = /\[data-role="([^"]+)"\]/.exec(selector);
      if (!role) return [];
      const total = (element.innerHTML.match(new RegExp(`data-role="${role[1]}"`, 'g')) || []).length;
      return Array.from({ length: total }, (_, index) => nodeFor(roles, role[1], index, stubElement('input')));
    },
  };
  return element;
}

function nodeFor(cache, key, index, fallback) {
  const id = `${key}#${index}`;
  if (!cache.has(id)) cache.set(id, fallback);
  return cache.get(id);
}

function translate(key, params) {
  let text = ZH[key] || key;
  if (params) {
    text = text.replace(/\{(\w+)\}/g, (all, name) => (name in params ? String(params[name]) : all));
  }
  return text;
}

function createHarness({ fetchImpl }) {
  const body = stubElement('body');
  const calls = [];
  const context = vm.createContext({
    console,
    setTimeout: (fn) => { fn(); return 0; },
    URL: Object.assign(function URL() {}, { createObjectURL: () => 'blob:handoff', revokeObjectURL() {} }),
    URLSearchParams,
    TextDecoder,
    document: { body, createElement: (tag) => stubElement(tag) },
    escapeHtml,
    t: translate,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return fetchImpl(String(url), options);
    },
  });
  vm.runInContext(SOURCE, context);
  const overlay = () => body.appended[0];
  const box = () => overlay().children[0];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    api: context.MultiCCChatHandoff,
    calls,
    settle,
    box,
    anchor: () => body.appended.find(item => item.download),
    message: () => box().querySelector('[data-role="msg"]').textContent,
  };
}

const json = (data, status = 200) => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(data),
  json: async () => data,
});

const zipFile = () => ({ arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01]).buffer });

test('the pure helpers answer for both containers and every layer', () => {
  const harness = createHarness({ fetchImpl: async () => json({}) });
  const { exportUrl, isZip, reportText } = harness.api;

  const full = exportUrl('ses-1', { passphrase: 'secret1', envOnly: false });
  assert.match(full, /^\/api\/sessions\/ses-1\/bundle\.zip\?/);
  const query = new URLSearchParams(full.slice(full.indexOf('?') + 1));
  assert.equal(query.get('scopes'), 'session,shared,task,cli,machine');
  assert.equal(query.get('skillsMode'), 'auto');
  assert.equal(query.get('passphrase'), 'secret1');
  // 没有 git 开关：代码层由服务端按仓库身份决定，界面只提供「只导执行环境」。
  assert.equal(query.has('git'), false);
  assert.equal(query.has('context'), false);

  const envQuery = new URLSearchParams(exportUrl('ses-1', { passphrase: 'secret1', envOnly: true }).split('?')[1]);
  assert.equal(envQuery.get('context'), '0');
  assert.equal(envQuery.get('git'), '0');

  assert.equal(isZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.equal(isZip(new Uint8Array([0x7b, 0x22, 0x73, 0x61])), false);

  const report = reportText({
    mode: 'env',
    sessionId: null,
    restored: {
      messages: 0,
      memoryScopes: {
        machine: { written: ['handoff-machine.md'], skipped: [] },
        shared: { written: [], skipped: [{ name: '*', reason: 'shared scope is not resolvable on this machine' }] },
      },
      skills: [{ name: 'demo', status: 'installed' }],
      assets: { restored: 0 },
      gitRestored: false,
      gitNote: 'environment-only import — the code layer was not applied',
    },
  });
  assert.match(report, /只装执行环境/);
  assert.match(report, /记忆：写入 1 个，跳过 1 个/);
  // 整个 scope 没有落点这件事必须说出来，不能被折进一个「跳过 1 个」的数字里。
  assert.match(report, /shared scope is not resolvable on this machine/);
  assert.match(report, /demo \(installed\)/);
  assert.match(report, /代码层：environment-only import/);
});

test('export downloads the zip under the server filename', async () => {
  const harness = createHarness({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name === 'content-disposition'
          ? 'attachment; filename="multicc-handoff-20260926-101112.zip"' : null),
      },
      blob: async () => ({ size: 2048 }),
    }),
  });
  harness.api.openExportDialog({ sessionId: 'ses-1' });
  harness.box().querySelector('[data-role="pass"]').value = 'secret1';
  harness.box().querySelector('[data-role="go"]').click();
  await harness.settle();

  assert.equal(harness.calls.length, 1);
  assert.match(harness.calls[0].url, /scopes=session%2Cshared%2Ctask%2Ccli%2Cmachine/);
  assert.equal(harness.calls[0].options.method, 'GET');
  // 文件名由服务端给（时间戳，不含会话 id），界面只照抄。
  assert.equal(harness.anchor().download, 'multicc-handoff-20260926-101112.zip');
  assert.match(harness.message(), /multicc-handoff-20260926-101112\.zip/);
  assert.match(harness.message(), /2 KB|2048/);
});

test('a short passphrase never reaches the network', async () => {
  const harness = createHarness({ fetchImpl: async () => json({}) });
  harness.api.openExportDialog({ sessionId: 'ses-1' });
  harness.box().querySelector('[data-role="pass"]').value = '123';
  harness.box().querySelector('[data-role="go"]').click();
  await harness.settle();
  assert.equal(harness.calls.length, 0);
  assert.match(harness.message(), /口令至少 6 位/);
});

test('a zip bundle is imported as raw bytes into the environment layer', async () => {
  const harness = createHarness({ fetchImpl: async () => json({
    ok: true, mode: 'env', sessionId: null,
    restored: { messages: 0, memoryScopes: { machine: { written: ['a.md'], skipped: [] } },
                skills: [], assets: { restored: 0 }, gitRestored: false,
                gitNote: 'environment-only import — the code layer was not applied' },
  }) });
  harness.api.openImportDialog({ currentSessionId: 'ses-9' });
  const box = harness.box();
  box.querySelector('[data-role="file"]').files = [zipFile()];
  box.querySelector('[data-role="pass"]').value = 'secret1';
  box.querySelector('[data-role="go"]').click();
  await harness.settle();

  assert.equal(harness.calls.length, 1);
  const [call] = harness.calls;
  assert.match(call.url, /^\/api\/sessions\/import-zip\?/);
  const query = new URLSearchParams(call.url.slice(call.url.indexOf('?') + 1));
  assert.equal(query.get('envOnly'), '1');
  assert.equal(query.has('dirId'), false);
  assert.equal(query.has('targetSessionId'), false);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'application/zip');
  assert.equal(call.options.body.byteLength, 5);
  assert.match(harness.message(), /导入完成 · 只装执行环境/);
  assert.match(harness.message(), /记忆：写入 1 个，跳过 0 个/);
});

test('a JSON container is parsed, and each target carries only its own parameter', async () => {
  const seen = [];
  const harness = createHarness({ fetchImpl: async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return json({ ok: true, mode: 'merge', sessionId: 'ses-9',
      restored: { messages: 3, memoryScopes: {}, skills: [], assets: { restored: 0 },
                  gitRestored: true, gitNote: null } });
  } });
  harness.api.openImportDialog({ currentSessionId: 'ses-9' });
  const box = harness.box();
  const bundle = { salt: 'AA', iv: 'BB', ct: 'CC', tag: 'DD' };
  box.querySelector('[data-role="file"]').files = [{
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(bundle)).buffer,
  }];
  box.querySelector('[data-role="pass"]').value = 'secret1';
  // 三个落点：只装环境 / 新建会话 / 并入当前会话（有当前会话时才出现第三个）。
  const targets = box.querySelectorAll('[data-role="target"]');
  assert.equal(targets.length, 3);
  targets[2].value = 'merge';
  targets[2].checked = true;
  box.querySelector('[data-role="go"]').click();
  await harness.settle();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/sessions/import');
  assert.deepEqual(seen[0].body, { ...bundle, passphrase: 'secret1', targetSessionId: 'ses-9' });
  assert.match(harness.message(), /导入完成 · 并入当前会话/);
  assert.match(harness.message(), /会话：ses-9/);
  assert.match(harness.message(), /上下文：3 条历史消息/);
  assert.match(harness.message(), /已 replay 到目标 worktree/);
});

test('an import failure is reported, not swallowed', async () => {
  const harness = createHarness({
    fetchImpl: async () => json({ error: 'decrypt failed (wrong passphrase or corrupt bundle)' }, 400),
  });
  harness.api.openImportDialog({});
  const box = harness.box();
  box.querySelector('[data-role="file"]').files = [zipFile()];
  box.querySelector('[data-role="pass"]').value = 'secret1';
  // 没有当前会话时不允许出现「并入当前会话」这个落点。
  assert.equal(box.querySelectorAll('[data-role="target"]').length, 2);
  box.querySelector('[data-role="go"]').click();
  await harness.settle();
  assert.match(harness.message(), /decrypt failed/);
});

test('the chat page loads the module before chat.js and wires both entry buttons', () => {
  const moduleAt = CHAT_HTML.indexOf('<script src="chat-handoff.js"></script>');
  const chatAt = CHAT_HTML.indexOf('<script src="chat.js"></script>');
  assert.ok(moduleAt > 0, 'chat.html must load chat-handoff.js');
  assert.ok(chatAt > moduleAt, 'chat-handoff.js must load before chat.js');
  assert.match(CHAT_JS, /id="sh-handoff"/);
  assert.match(CHAT_JS, /id="sh-handoff-in"/);
  assert.match(CHAT_JS, /MultiCCChatHandoff\?\.openExportDialog\(\{ sessionId: _sessionName \}\)/);
  assert.match(CHAT_JS, /MultiCCChatHandoff\?\.openImportDialog\(\{ currentSessionId: _sessionName \}\)/);
});
