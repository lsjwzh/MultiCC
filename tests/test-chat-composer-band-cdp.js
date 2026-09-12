'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 手机上输入框上面那一摞：「额度行 → 上下文行 → 子任务药丸 → 输入框」。
// 上下文行和子任务药丸说的是同一件事（这一轮怎么跑），中间只该是一条缝，不该是
// 一条沟 —— 之前是 10px（额度区下 3px + 药丸区上 5px + 行高余量 2px），现在收到 5px。
// 量的是文字墨迹到药丸边框，那才是眼睛看到的那个数；纯靠 padding 断言会把行高
// 余量漏掉，量出来跟看到的不一样。
const publicDir = path.resolve(__dirname, '../public');

const routes = {};
for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
  routes['/' + file] = {
    body: fs.readFileSync(path.join(publicDir, file)),
    headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' },
  };
}
for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
  routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
}
routes['/auth-client.js'] = {
  headers: { 'content-type': 'text/javascript' },
  body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
};
routes['/api/sessions'] = () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, sessions: [], directories: [] }) });

// 上下文那一行是 WS 上报了用量才长出来的；这里给它填一段等长的文字，只为把这一行
// 的版式摆出来（量的是行与行的间隔，不是那串数字）。
const FILL = `(() => {
  const bar = document.getElementById('cost-bar');
  bar.innerHTML = '上下文 83.3k / 1000k · 8.3% <span class="usage-ctx-meter">'
    + '<span style="width:8%;background:#3fb950"></span></span>'
    + '<span class="usage-ctx-more">⌃ 引用 1 详情</span>';
  // 合并提示是第四种行，有自己的显隐条件；这次量的是它不在时的常态。
  document.getElementById('merge-hint').style.display = 'none';
  return !!bar.textContent.trim();
})()`;

const MEASURE = `(() => {
  const ink = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
  const box = id => { const el = document.getElementById(id); const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el); return { top: r.top, bottom: r.bottom, display: cs.display,
      pt: cs.paddingTop, pb: cs.paddingBottom }; };
  const cost = box('cost-bar'), pill = document.getElementById('subagent-pill').getBoundingClientRect();
  const costInk = ink(document.getElementById('cost-bar'));
  return { gap: Math.round(pill.top - costInk.bottom),
           costInkBottom: Math.round(costInk.bottom), pillTop: Math.round(pill.top),
           summary: box('usage-summary'), preInput: box('pre-input-bar') };
})()`;

const qaDir = () => process.env.MULTICC_COMPOSER_BAND_QA_DIR || path.join(os.tmpdir(), 'multicc-composer-band-qa');

test('mobile: the context line and the subtask pill read as one band, not two', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/chat.html?session=composer-band');
    assert.ok(await page.waitFor(`document.getElementById('subagent-pill') && document.getElementById('cost-bar')`));
    assert.equal(await page.evaluate(FILL), true);
    const band = await page.evaluate(MEASURE);
    // 挤在一起、但没叠上：既不能留出一条沟，也不能连成一坨。
    assert.ok(band.gap <= 6, `上下文行到子任务药丸之间最多一条缝：实测 ${band.gap}px（${JSON.stringify(band)}）`);
    assert.ok(band.gap >= 2, `两行不该贴在一起：实测 ${band.gap}px`);
    assert.ok(band.summary.bottom <= band.preInput.top, `上下文区不该压到药丸区：${JSON.stringify(band)}`);
    // 这两个值的来源就是那两条 CSS；写死在这里，改动时能一眼看出改的是哪条。
    assert.equal(band.summary.pb, '1px', `手机上额度区下边距该收到 1px：${band.summary.pb}`);
    assert.equal(band.preInput.pt, '2px', `手机上药丸区上边距该收到 2px：${band.preInput.pt}`);
    await page.screenshot('composer-band-mobile-390');

    // 桌面本来就比手机紧（额度区下 3px、药丸区上 2px），这次只动手机。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    const desktop = await page.evaluate(MEASURE);
    assert.equal(desktop.summary.pb, '3px', `桌面不该被这次收紧波及：${JSON.stringify(desktop)}`);
    assert.equal(desktop.preInput.pt, '2px', `桌面不该被这次收紧波及：${JSON.stringify(desktop)}`);
  });
});
