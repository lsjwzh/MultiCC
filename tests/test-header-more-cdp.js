'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('More menu stays above tool messages, scrolls, closes and returns to its header', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const dir = path.resolve(__dirname, '../public');
  const style = fs.readFileSync(path.join(dir, 'chat.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
  const items = Array.from({ length: 18 }, (_, i) => `<button class="hdr-btn" id="action-${i}">菜单项 ${i}</button>`).join('');
  const routes = { '/': { body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}
    #header{isolation:isolate;z-index:0;backdrop-filter:blur(20px)}#header-more-wrap{display:block}#messages{position:relative;z-index:100;overflow:visible}.tool-call{position:relative;z-index:99999;height:700px;background:#eef4ff}
    </style><div id="header"><span class="hdr-spacer"></span><span id="header-more-wrap"><button class="hdr-btn" id="header-more-btn">更多</button><span id="header-more-menu">${items}</span></span></div><div id="messages"><div class="tool-call">tool use</div></div><script src="/chat-live-ui.js"></script><script>MultiCCChatLiveUi.bindHeaderMoreMenu({window,document,button:document.getElementById('header-more-btn'),menu:document.getElementById('header-more-menu'),wrap:document.getElementById('header-more-wrap')});</script>` },
    '/chat-live-ui.js': { body: fs.readFileSync(path.join(dir, 'chat-live-ui.js')), headers: { 'content-type': 'text/javascript' } },
  };
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/');
    for (const width of [1200, 700, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: width < 760 });
      await page.evaluate(`document.getElementById('header-more-btn').click()`);
      assert.ok(await page.waitFor(`document.getElementById('header-more-menu').matches(':popover-open')`));
      const bounds = await page.evaluate(`(()=>{const m=document.getElementById('header-more-menu'),r=m.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,over:m.contains(document.elementFromPoint(r.left+20,r.top+30)),scroll:m.scrollHeight>m.clientHeight}})()`);
      assert.equal(bounds.over, true, 'menu receives pointer hits above high-z tool messages');
      assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= 600, JSON.stringify(bounds));
      assert.equal(bounds.scroll, true);
      await page.evaluate(`document.getElementById('header-more-menu').scrollTop=9999;document.getElementById('action-17').click()`);
      assert.equal(await page.evaluate(`document.getElementById('header-more-menu').classList.contains('open')`), false);
      await page.evaluate(`document.getElementById('header-more-btn').click()`);
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.ok(await page.waitFor(`document.getElementById('header-more-btn').getAttribute('aria-expanded')==='false'`));
      assert.equal(await page.evaluate(`document.getElementById('header-more-menu').parentElement.id`), 'header-more-wrap');
    }
  });
});
