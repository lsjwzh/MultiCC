'use strict';
// X 第二帖配图：docker lab (http://127.0.0.1:3300) 的 Air 界面，英文模式真实截图。
const fs = require('node:fs');
const { createCdpHarness } = require('../tests/helpers/cdp-harness');

const OUT_DIR = '/tmp/x-post-shots';
const LAB = 'http://127.0.0.1:3300';

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const h = await createCdpHarness({ timeoutMs: 30000, screenshotDir: OUT_DIR });
  try {
    await h.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
    // 1. 登录（表单 POST，同源 fetch 自动带 cookie）
    await h.navigate(`${LAB}/login`);
    await h.evaluate(`fetch('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=multicc-docker-lab&redirect=/air', redirect: 'manual' }).then(r => r.status)`);
    // 2. 英文模式
    await h.evaluate(`localStorage.setItem('multicc_lang', 'en'); localStorage.getItem('multicc_lang')`);
    // 3. 打开 Air
    await h.navigate(`${LAB}/air`);
    await h.waitFor(`document.querySelector('#tasks') && document.querySelectorAll('#tasks .nav-item, #tasks a, #tasks button').length >= 2`, { timeoutMs: 20000 });
    await new Promise(r => setTimeout(r, 2500)); // 等状态行/时间等异步细节
    await h.evaluate(`(() => {
      const skip = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Skip for now');
      if (skip) skip.click();
      return Boolean(skip);
    })()`);
    await new Promise(r => setTimeout(r, 600));
    const zh = await h.evaluate(`[...document.querySelectorAll('#air main, #air #content, main')].some(el => el.innerText && /[\\u4e00-\\u9fff]/.test(el.innerText))`);
    console.log('main-has-chinese:', zh);
    console.log('body-lang:', await h.evaluate('document.documentElement.lang'));
    const shot = await h.screenshot('air-en-board.png');
    console.log('SHOT:', shot);
    // 顺带存一份可见文本，便于核对文案与图内字段
    const text = await h.evaluate(`document.body.innerText.slice(0, 4000)`);
    fs.writeFileSync(OUT_DIR + '/air-en-board.txt', text);
    console.log(text.slice(0, 1200));
  } finally {
    await h.close();
  }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
