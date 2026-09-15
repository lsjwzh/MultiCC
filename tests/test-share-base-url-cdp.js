'use strict';

// 分享对话框里那个「链接根域」下拉，在真浏览器里跑一遍。
//
// 它是分享流程里唯一必须做对的选择：默认值错了，链接看着生成成功、接收方却
// 打不开。而默认值不是列表第一项 —— 第一项永远是「当前页面地址」，管理员多半
// 就开着 127.0.0.1。所以这里量的是三件光看代码看不出来的事：候选怎么排、谁被
// 预选、以及同一个根域的多种写法有没有收敛成一条。
//
// 用真浏览器而不是 DOM shim：`<select>` 的选中项、`isConnected`、以及
// `document.getElementById` 找提示元素，都只有真实文档才说了算。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MODULE_SOURCE = fs.readFileSync(path.join(PUBLIC_DIR, 'base-url-options.js'), 'utf8');

// 分享对话框里那一段的最小形态：一个 disabled 的下拉 + 一行提示。
const FIXTURE = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"><title>share base url</title>
<script src="base-url-options.js"></script></head>
<body>
  <select id="base" disabled data-hint-id="base-hint"><option>读取可用地址…</option></select>
  <div id="base-hint"></div>
</body></html>`;

const MODULE_ROUTE = {
  headers: { 'content-type': 'text/javascript; charset=utf-8' },
  body: MODULE_SOURCE,
};
const PAGE_ROUTE = { headers: { 'content-type': 'text/html; charset=utf-8' }, body: FIXTURE };
const jsonRoute = (value) => ({
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(value),
});

const READ_SELECT = `(() => {
  const select = document.getElementById('base');
  return {
    disabled: select.disabled,
    value: select.value,
    options: [...select.options].map(option => ({
      value: option.value,
      text: option.textContent,
      selected: option.selected,
    })),
    hint: document.getElementById('base-hint').textContent,
  };
})()`;

const MOUNT_AND_READ = `(async () => {
  await multiccMountBaseUrlSelect(document.getElementById('base'));
  return ${READ_SELECT};
})()`;

// 夹具服务监听随机端口，所以「当前页面地址」那一项得从页面里问，不能写死。
async function mountSelect(page) {
  const origin = await page.evaluate('location.origin');
  const shown = await page.evaluate(MOUNT_AND_READ);
  return { origin, shown };
}

function setViewport(page) {
  return page.send('Emulation.setDeviceMetricsOverride', {
    width: 520, height: 320, deviceScaleFactor: 2, mobile: false,
  });
}

test('the share-link root select preselects a reachable address in a real browser', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({
    routes: {
      '/': PAGE_ROUTE,
      '/base-url-options.js': MODULE_ROUTE,
      '/api/server-info': jsonRoute({ lanUrls: ['http://192.168.1.10:3000'] }),
      '/api/settings/tunnel': jsonRoute({
        // 尾斜杠、路径、非 http(s) 三种写法都要被收拾干净。
        config: { tailscale: { url: 'https://mac.tail94695a.ts.net/' }, natapp: { url: 'ftp://bad-scheme' } },
        providers: { cpolar: { publicUrl: 'https://abc.cpolar.cn' } },
      }),
    },
    screenshotDir: path.join(os.tmpdir(), 'multicc-share-base-url-qa'),
  }, async page => {
    await setViewport(page);
    await page.navigate('/');
    const { origin, shown } = await mountSelect(page);

    // 探活接口给的是异步的，填完之前下拉必须是禁用的 —— 否则手快的人点下生成，
    // 拿到的是一条写死 127.0.0.1 的链接。
    assert.equal(shown.disabled, false, '探活回来后下拉要可用');
    assert.deepEqual(shown.options.map(option => option.value), [
      origin,
      'http://192.168.1.10:3000',
      'https://mac.tail94695a.ts.net',
      'https://abc.cpolar.cn',
    ]);
    // 默认值不是第一项：第一项是本机地址，发出去对方打不开。
    assert.equal(shown.value, 'https://mac.tail94695a.ts.net');
    assert.deepEqual(shown.options.map(option => option.selected), [false, false, true, false]);
    assert.equal(shown.hint, '', '有公网地址时不该提示「只有本机能打开」');
    // 每一项都要说清这个地址是怎么来的：同一台机器可能既配了穿透工具、又手填过
    // 地址，只显示 URL 的话人分不出该信哪个。
    assert.match(shown.options[2].text, /\(tailscale\)/);
    assert.equal(shown.options[3].text, '公网(cpolar) · https://abc.cpolar.cn');

    await page.screenshot('01-share-base-url');
  });
});

test('with no tunnel configured the select says so instead of silently offering localhost', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({
    routes: {
      '/': PAGE_ROUTE,
      '/base-url-options.js': MODULE_ROUTE,
      '/api/server-info': jsonRoute({ lanAvailable: false }),
      '/api/settings/tunnel': jsonRoute({}),
    },
    screenshotDir: path.join(os.tmpdir(), 'multicc-share-base-url-local-qa'),
  }, async page => {
    await setViewport(page);
    await page.navigate('/');
    const { origin, shown } = await mountSelect(page);

    assert.deepEqual(shown.options.map(option => option.value), [origin]);
    assert.equal(shown.value, origin);
    // 不配穿透时也得能用（本机自测），但必须说清这条链接别人打不开。
    assert.match(shown.hint, /只有本机能打开/);
    await page.screenshot('02-share-base-url-local-only');
  });
});

test('the select still fills when every probe endpoint is down', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({
    routes: {
      '/': PAGE_ROUTE,
      '/base-url-options.js': MODULE_ROUTE,
      // 两个探活接口都不注册：请求 404，收集器必须降级成「只有当前页面地址」，
      // 而不是让下拉空着、把用户挡在生成按钮外面。
    },
    screenshotDir: path.join(os.tmpdir(), 'multicc-share-base-url-dead-qa'),
  }, async page => {
    await setViewport(page);
    await page.navigate('/');
    const { origin, shown } = await mountSelect(page);

    assert.equal(shown.disabled, false, '探活全挂时下拉也必须可用');
    assert.deepEqual(shown.options.map(option => option.value), [origin]);
    await page.screenshot('03-share-base-url-probes-down');
  });
});
