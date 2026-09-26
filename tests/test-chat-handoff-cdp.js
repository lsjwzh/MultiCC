'use strict';

// 交接包弹窗在真浏览器里跑一遍。
//
// tests/test-chat-handoff.js 用的是 DOM 桩：它能证明请求参数和文案分支对，证明不了
// 真的 DOM 里选择器选得到东西、真的 blob 能下载下来、真的 i18n 词典里有这些键
// （桩里的 t() 是直接读 zh.json 的）。这三件事恰恰是「界面上看得到」的全部前提，
// 所以这里用真 Chrome + 真的 public/ 脚本（i18n 词典、dom-helpers、format、
// chat-handoff.js）走一遍导出与导入，只有 /api 那几条是夹具。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const SCRIPTS = ['i18n-catalog.js', 'i18n.js', 'shared/dom-helpers.js', 'shared/format.js', 'chat-handoff.js'];
const ZIP_NAME = 'multicc-handoff-20260926-101112.zip';

function routes(handoff) {
  const out = {};
  for (const file of SCRIPTS) {
    out[`/${file}`] = {
      body: fs.readFileSync(path.join(PUBLIC_DIR, file)),
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    };
  }
  out['/'] = { body: `<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <body style="margin:0">
    ${SCRIPTS.map(file => `<script src="/${file}"></script>`).join('\n')}
    <button id="open-export">export</button>
    <button id="open-import">import</button>
    <script>
      document.getElementById('open-export').onclick =
        () => MultiCCChatHandoff.openExportDialog({ sessionId: 'ses-1' });
      document.getElementById('open-import').onclick =
        () => MultiCCChatHandoff.openImportDialog({ currentSessionId: 'ses-9' });
    </script>` };
  out['/api/directories'] = {
    body: JSON.stringify([{ id: 'dir-1', name: '仓库 A', path: '/tmp/a' }, { id: 'dir-2', name: '仓库 B', path: '/tmp/b' }]),
    headers: { 'content-type': 'application/json' },
  };
  out['/api/sessions/ses-1/bundle.zip'] = ({ url }) => {
    handoff.exports.push(url.search);
    return {
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
      headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${ZIP_NAME}"` },
    };
  };
  out['POST /api/sessions/import-zip'] = ({ url, body }) => {
    handoff.imports.push({ search: url.search, bytes: body.length });
    return {
      body: JSON.stringify({
        ok: true, mode: handoff.importMode, sessionId: handoff.importMode === 'env' ? null : 'ses-9',
        restored: { messages: 3, memoryScopes: { machine: { written: ['a.md'], skipped: [] } },
                    skills: [{ name: 'demo', status: 'installed' }], assets: { restored: 1 },
                    gitRestored: false, gitNote: 'environment-only import — the code layer was not applied' },
      }),
      headers: { 'content-type': 'application/json' },
    };
  };
  return out;
}

const dialog = () => 'document.body.querySelector(\'[data-role="msg"]\')';
const message = (page) => page.evaluate(`${dialog()} ? ${dialog()}.textContent : null`);
const role = (name) => `document.body.querySelector('[data-role="${name}"]')`;

// 夹具服务器的请求日志就在这个进程里，不必绕浏览器一圈去等。
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return predicate();
}

async function pickZip(page, selector) {
  // 真浏览器里 input.files 只能由 DataTransfer 赋值 —— 这正是桩测不到的那一段。
  await page.evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01])], 'bundle.zip',
      { type: 'application/zip' }));
    ${selector}.files = transfer.files;
  })()`);
}

test('the handoff dialogs work in a real browser', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const handoff = { exports: [], imports: [], importMode: 'env' };
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-handoff-cdp-'));
  await withCdpHarness({ routes: routes(handoff), screenshotDir: path.join(downloadDir, 'shots') }, async page => {
    try {
      await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    } catch (_) { /* older builds reject it; the message assertion below still holds */ }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    assert.ok(await page.waitFor('window.MultiCCChatHandoff && window.t("handoffExport") !== "handoffExport"'),
      '模块与 i18n 词典都得真的加载出来（裸 key 说明词典没接上）');

    // ── 导出 ────────────────────────────────────────────────────────────────
    await page.evaluate(`document.getElementById('open-export').click()`);
    assert.ok(await page.waitFor(`${role('pass')}`), '导出弹窗要在真 DOM 里问口令');
    assert.equal(await page.evaluate(`${role('envonly')}.checked`), false);
    await page.evaluate(`${role('pass')}.value = 'secret1'`);
    await page.evaluate(`${role('go')}.click()`);
    assert.ok(await page.waitFor(`${dialog()}.textContent.includes(${JSON.stringify(ZIP_NAME)})`),
      await message(page));
    assert.equal(handoff.exports.length, 1);
    const full = new URLSearchParams(handoff.exports[0].slice(1));
    assert.equal(full.get('scopes'), 'session,shared,task,cli,machine');
    assert.equal(full.get('skillsMode'), 'auto');
    assert.equal(full.has('git'), false, '界面上不许长出 git 设置');
    const saved = fs.readdirSync(downloadDir);
    assert.ok(saved.includes(ZIP_NAME), `真下载要落盘：${saved.join(', ') || '(空)'}`);

    // 「只导执行环境」是唯一的开关，它一次关掉上下文层与代码层。
    await page.evaluate(`${role('envonly')}.checked = true; ${role('go')}.click()`);
    assert.ok(await waitFor(() => handoff.exports.length === 2), 'envOnly 要再打一次接口');
    const envOnly = new URLSearchParams(handoff.exports[1].slice(1));
    assert.equal(envOnly.get('context'), '0');
    assert.equal(envOnly.get('git'), '0');
    await page.evaluate(`document.body.querySelector('[data-role="close"]').click()`);

    // ── 导入：默认落点是「只装执行环境」 ─────────────────────────────────────
    await page.evaluate(`document.getElementById('open-import').click()`);
    const targets = await page.evaluate(`(() => {
      const radios = [...document.body.querySelectorAll('[data-role="target"]')];
      return radios.map(radio => ({ value: radio.value, checked: radio.checked }));
    })()`);
    assert.deepEqual(targets, [
      { value: 'env', checked: true }, { value: 'new', checked: false }, { value: 'merge', checked: false },
    ], '有当前会话时三个落点都在，默认只装环境');
    assert.equal(await page.evaluate(`${role('dirrow')}.hidden`), true);

    await pickZip(page, role('file'));
    await page.evaluate(`${role('pass')}.value = 'secret1'; ${role('go')}.click()`);
    assert.ok(await page.waitFor(`${dialog()}.textContent.includes('导入完成')`), await message(page));
    assert.equal(handoff.imports.length, 1);
    const importQuery = new URLSearchParams(handoff.imports[0].search.slice(1));
    assert.equal(importQuery.get('envOnly'), '1');
    assert.equal(importQuery.has('dirId'), false);
    assert.equal(handoff.imports[0].bytes, 5, 'zip 要按原始字节发出去');
    const report = await message(page);
    assert.match(report, /记忆：写入 1 个/, report);
    assert.match(report, /demo \(installed\)/, report);
    assert.match(report, /代码层：environment-only import/, report);

    // ── 换落点：新建会话要先选目录 ───────────────────────────────────────────
    handoff.importMode = 'create';
    await page.evaluate(`(() => {
      const radio = [...document.body.querySelectorAll('[data-role="target"]')].find(item => item.value === 'new');
      radio.checked = true; radio.dispatchEvent(new Event('change'));
    })()`);
    assert.equal(await page.evaluate(`${role('dirrow')}.hidden`), false, '选了「新建会话」才露出目录下拉');
    assert.ok(await page.waitFor(`[...${role('dir')}.options].length === 2`), '目录要在选中落点时就取回来，不能等到点导入');
    const options = await page.evaluate(`[...${role('dir')}.options].map(option => option.textContent)`);
    assert.deepEqual(options, ['仓库 A', '仓库 B'], '目录来自 /api/directories，不是写死的');
    await page.evaluate(`${role('dir')}.value = 'dir-2'; ${role('go')}.click()`);
    assert.ok(await page.waitFor(`${dialog()}.textContent.includes('新建一个会话')`), await message(page));
    const createQuery = new URLSearchParams(handoff.imports[1].search.slice(1));
    assert.equal(createQuery.get('dirId'), 'dir-2');
    assert.equal(createQuery.has('envOnly'), false);

    // ── 并入当前会话 ─────────────────────────────────────────────────────────
    handoff.importMode = 'merge';
    await page.evaluate(`(() => {
      const radio = [...document.body.querySelectorAll('[data-role="target"]')].find(item => item.value === 'merge');
      radio.checked = true; radio.dispatchEvent(new Event('change'));
      ${role('go')}.click();
    })()`);
    assert.ok(await page.waitFor(`${dialog()}.textContent.includes('并入当前会话')`), await message(page));
    const mergeQuery = new URLSearchParams(handoff.imports[2].search.slice(1));
    assert.equal(mergeQuery.get('targetSessionId'), 'ses-9');

    // ── 窄屏：弹窗不许溢出视口 ───────────────────────────────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 720, deviceScaleFactor: 1, mobile: true });
    const box = await page.evaluate(`(() => {
      const overlay = [...document.body.children].find(node => node.style && node.style.position === 'fixed');
      const rect = overlay.firstElementChild.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: innerWidth,
               fits: rect.left >= 0 && rect.right <= innerWidth,
               overflow: document.documentElement.scrollWidth <= innerWidth };
    })()`);
    assert.equal(box.fits, true, JSON.stringify(box));
    assert.equal(box.overflow, true, JSON.stringify(box));
  });
  fs.rmSync(downloadDir, { recursive: true, force: true });
});
