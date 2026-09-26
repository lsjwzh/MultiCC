'use strict';

// 终端页（public/index.html + public/client.js）—— 真浏览器里跑。
//
// 这个页面此前一个测试都没有：它不在 Air 壳里，靠一条 WebSocket 活着，而 CDP 夹具
// 起的是静态 HTTP 服务（没有 WS 升级）。所以这一份不测「连上来以后」的链路，测的是
// 页面自己那层能力：查找、字号、快捷键，以及服务端消息怎么落到 xterm 上。
// 页面为此暴露了 window.MultiCCTerminal（和 Air 侧 window.MultiCCAirXxx 同一个办法）
// —— 测试直接调它喂消息，不必先起一个真 socket。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('终端页：查找、字号缩放、快捷键与服务端消息落地', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public');
  const routes = {};
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml' };
  const serve = (rel, file) => {
    const type = types[file.slice(file.lastIndexOf('.') + 1)] || 'application/octet-stream';
    routes[rel] = { body: fs.readFileSync(file), headers: { 'content-type': `${type}; charset=utf-8` } };
  };
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html|svg)$/.test(name))) serve('/' + file, path.join(publicDir, file));
  const vendorDir = path.join(publicDir, 'vendor');
  for (const dir of fs.readdirSync(vendorDir)) {
    const full = path.join(vendorDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full).filter(name => /\.(js|css)$/.test(name))) serve(`/vendor/${dir}/${file}`, path.join(full, file));
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) serve('/shared/' + file, path.join(publicDir, 'shared', file));
  // 终端页 = index.html（/ 就是它）。
  routes['/'] = routes['/index.html'];
  routes['/api/sessions/s1'] = () => json({ id: 's1', dirId: 'd1', cli: 'claude', kind: 'terminal', label: 'Multicc Test Terminal', cwd: '/projects/multicc' });
  routes['/api/sessions'] = () => json([{ id: 's1', dirId: 'd1', cli: 'claude', kind: 'terminal', label: 'Multicc Test Terminal' }]);
  routes['/api/directories'] = () => json([{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }]);
  routes['/api/settings/voice'] = () => json({ ok: true, enabled: false });
  routes['/api/auth/ws-ticket'] = () => json({ ok: true, ticket: 'fixture' });

  const screenshots = [];
  const screenshotDir = path.join(os.tmpdir(), 'multicc-terminal-page');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `addEventListener('error',e=>(window.__errors||=[]).push(String(e.message)));`
        + `addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason&&e.reason.message||e.reason)))`,
    });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/?id=s1');
    assert.ok(await page.waitFor(`!!window.MultiCCTerminal?.terminal`), '终端页要暴露 MultiCCTerminal');

    // ── 服务端消息 → xterm ────────────────────────────────────────────────
    await page.evaluate(`window.MultiCCTerminal.applyServerMessage({ type: 'output', data: 'alpha one\\r\\nbeta two\\r\\nalpha three\\r\\n' })`);
    // 页面把 output 批到 rAF 里再写（避免刷屏），所以要等内容真的落到 buffer，不能只等行数
    // —— 空 buffer 的行数本来就有 rows 那么多。
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)==='alpha one'`),
      '第一行就是服务端发来的内容：' + await page.evaluate(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)`),
    );

    // ── 查找：开关、命中计数、上下一个、区分大小写、Esc 关闭 ───────────────
    assert.equal(await page.evaluate(`window.MultiCCTerminal.findVisible()`), false, '查找条默认收起');
    // ⌘F / Ctrl+F 走的是页面自己拦的那条路（xterm 不该把 F 发给 PTY）。
    await page.evaluate(`window.MultiCCTerminal.terminal.focus()`);
    const metaKey = await page.evaluate(`window.MultiCCTerminal.isMac`) ? 4 : 2;
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: metaKey, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findVisible()===true`), '⌘F 要开查找条');
    assert.equal(await page.evaluate(`document.activeElement.id`), 'find-input', '开完焦点在输入框');
    await page.evaluate(`(() => { const i = document.getElementById('find-input'); i.value = 'alpha'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='1/2'`), '命中计数要出来：' + await page.evaluate(`window.MultiCCTerminal.findCount()`));
    screenshots.push(await page.screenshot('terminal-find-bar'));
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='2/2'`), 'Enter = 下一个：' + await page.evaluate(`window.MultiCCTerminal.findCount()`));
    await page.evaluate(`document.getElementById('find-prev').click()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='1/2'`), '↑ = 上一个');
    // 区分大小写：ALPHA 在大小写敏感下不该命中。
    await page.evaluate(`(() => { document.getElementById('find-case').click(); const i = document.getElementById('find-input'); i.value = 'ALPHA'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='无匹配'`), '大小写敏感后 ALPHA 不该命中：' + await page.evaluate(`window.MultiCCTerminal.findCount()`));
    await page.evaluate(`document.getElementById('find-case').click(); document.getElementById('find-close').click()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findVisible()===false`), '✕ 关掉查找条');
    assert.equal(await page.evaluate(`window.MultiCCTerminal.findCount()`), '', '关掉要清掉计数');

    // ── 字号：按钮与 ⌘±，范围钳制，刷新后保持 ─────────────────────────────
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 14, '默认 14');
    await page.evaluate(`document.getElementById('font-up-btn').click()`);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 15);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.terminal.options.fontSize`), 15, '字号要真的落到 xterm 上');
    assert.equal(await page.evaluate(`localStorage.getItem(window.MultiCCTerminal.constants.FONT_KEY)`), '15', '字号要记住');
    await page.evaluate(`window.MultiCCTerminal.setFontPx(999)`);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 24, '上限 24');
    await page.evaluate(`window.MultiCCTerminal.setFontPx(1)`);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 10, '下限 10');
    await page.evaluate(`window.MultiCCTerminal.setFontPx(14)`);

    // ── 快捷键：清屏（⌘K / Ctrl+K）不该把 K 发给 PTY ────────────────────
    // 量「第一行还是不是那句话」而不是 buffer 行数：xterm 清屏清的是回看缓冲，
    // 视口那几行（rows）还在，行数本来就不会变小。
    assert.equal(
      await page.evaluate(`window.MultiCCTerminal.terminal.buffer.active.getLine(0).translateToString(true)`),
      'alpha one',
    );
    await page.evaluate(`window.MultiCCTerminal.terminal.focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: metaKey, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)===''`),
      '⌘K 之后第一行要空掉',
    );

    // ── 快照：重连时服务端补的那一屏是「替换」不是「追加」 ──────────────────
    // 放在最后：它会把上面查找/清屏依赖的那几行 alpha 冲掉。
    const dumpScreen = () => page.evaluate(
      `(()=>{const b=window.MultiCCTerminal.terminal.buffer.active;let s='';`
      + `for(let i=0;i<b.length;i++)s+=b.getLine(i).translateToString(true)+'\\n';return s;})()`,
    );
    await page.evaluate(`window.MultiCCTerminal.applyServerMessage({ type: 'output', data: 'stale line\\r\\n' })`);
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)==='stale line'`),
      '重连前的内容先落到屏上',
    );
    await page.evaluate(`window.MultiCCTerminal.applyServerMessage({ type: 'snapshot', data: 'fresh screen\\r\\n' })`);
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)==='fresh screen'`),
      '快照要顶到第一行：' + await page.evaluate(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)`),
    );
    assert.ok(!(await dumpScreen()).includes('stale line'),
      '快照是替换：刷新一次不该在屏上多留一份旧内容');

    assert.deepEqual(await page.evaluate(`window.__errors||[]`), [], '页面上不该有未捕获异常');
  });
  if (screenshots.length) console.log('screenshots:', screenshots.join(' '));
});
