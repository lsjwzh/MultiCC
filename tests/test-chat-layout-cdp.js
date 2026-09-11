'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('chat width fills, limits, persists across frames/reload and fits narrow screens', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public'), routes = {};
  for (const file of ['chat-layout.js', 'chat-layout.css', 'task-shell-air.css']) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: {
      'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css',
    } };
  }
  const content = '<main><div id="history"><article>完整的聊天消息内容</article></div><form id="composer"><textarea>保留草稿</textarea></form></main>';
  routes['/frame'] = { body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/task-shell-air.css"><style>*{box-sizing:border-box}body{margin:0}main{width:100%}</style><body class="air">' + content + '<script src="/chat-layout.js"></script>' };
  routes['/'] = { body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-layout.css"><style>body{margin:0}iframe{width:100%;height:600px;border:0}</style><button data-chat-layout>聊天宽度</button><iframe src="/frame"></iframe><script src="/chat-layout.js"></script>' };
  await withCdpHarness({ routes }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message))` });
    await page.navigate('/');
    const frame = `document.querySelector('iframe').contentDocument`;
    assert.ok(await page.waitFor(`${frame}?.getElementById('composer')`));
    const width = () => page.evaluate(`${frame}.getElementById('composer').getBoundingClientRect().width`);
    assert.ok(await width() > 1800, 'default fills available width');
    await page.evaluate(`document.querySelector('[data-chat-layout]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open]')`));
    await page.evaluate(`document.querySelector('[name=limited]').click();const r=document.querySelector('[name=width]');r.value=1000;r.dispatchEvent(new Event('input'));document.querySelector('button[value=save]').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('composer').getBoundingClientRect().width===1000`), JSON.stringify(await page.evaluate(`({errors:window.__errors,returnValue:document.querySelector('dialog')?.returnValue,storage:localStorage.getItem('multicc:chat-layout'),dialog:document.querySelector('dialog')?.outerHTML,frameStyle:${frame}.documentElement.style.cssText,width:${frame}.getElementById('composer').getBoundingClientRect().width,max:${frame}.defaultView.getComputedStyle(${frame}.getElementById('composer')).maxWidth})`)));
    assert.equal(await page.evaluate(`${frame}.querySelector('textarea').value`), '保留草稿');
    await page.navigate('/');
    assert.ok(await page.waitFor(`${frame}?.getElementById('composer')?.getBoundingClientRect().width===1000`));
    await page.evaluate(`document.querySelector('[data-chat-layout]').click();document.querySelector('[name=limited]').click();document.querySelector('button[value=cancel]').click()`);
    assert.equal(await width(), 1000, 'cancel keeps saved width');
    for (const viewport of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: true });
      assert.ok(await width() <= viewport);
      await page.evaluate(`document.querySelector('[data-chat-layout]').click()`);
      assert.ok(await page.evaluate(`document.querySelector('dialog').getBoundingClientRect().right<=innerWidth`));
      await page.evaluate(`document.querySelector('button[value=cancel]').click()`);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.querySelector('[data-chat-layout]').click();document.querySelector('[name=reset]').click();document.querySelector('button[value=save]').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('composer').getBoundingClientRect().width>1800`));
  });
});
