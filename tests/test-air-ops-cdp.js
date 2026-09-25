'use strict';

// The Air sidebar's host-ops region, in a real browser. The unit test pins the
// module's behaviour against a DOM shim; what a shim cannot see is whether the
// markup, the stylesheet and the module actually agree once they meet — the
// region is the one part of the light shell that could quietly inherit a dark
// surface, and the QR code only exists as canvas pixels.
//
// The page's own scripts are stripped: air.js would boot the whole console from
// a directory API this test does not own, and the ops region is what is under
// test. air-ops.js and the QR encoder are re-added, so the module runs exactly
// as it ships.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const CONTENT_TYPE = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };

const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('the Air host-ops region renders, reads light, and drives the update flow', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public');
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(css|js|svg)$/.test(name))) {
    const extension = file.slice(file.lastIndexOf('.') + 1);
    routes[`/${file}`] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': CONTENT_TYPE[extension] || 'application/octet-stream' },
    };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes[`/shared/${file}`] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  // 只留 air-ops.js 是这个用例的本意（别的一起跑会把无关请求搅进来），但 i18n 现在是
  // 页面骨架的一部分：空中文的 t() 由 /i18n.js 提供，不装它模块一取文案就 ReferenceError。
  // shared/format.js 同理 —— air.html 里它在 air-ops.js 前面（tests/test-format-guard.js
  // 钉住这个顺序），剪掉它模块取不到数字格式化，下载那两行就画不出来。
  const html = fs.readFileSync(path.join(publicDir, 'air.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script src="/i18n-catalog.js"></script><script src="/i18n.js"></script>'
      + '<script src="/qrcode.min.js"></script><script src="/shared/format.js"></script>'
      + '<script src="/air-ops.js"></script></body>');
  routes['/'] = { body: html, headers: { 'content-type': 'text/html; charset=utf-8' } };

  routes['/api/version-check'] = json({ current: '1.6.10', channel: 'dev', latest: 'v1.7.0', latestVersion: '1.7.0', updateAvailable: true });
  routes['/api/server-info'] = json({ url: 'http://192.168.1.9:3000', uptimeMs: 3 * 3600 * 1000 + 25 * 60 * 1000 });
  routes['/api/apk-info'] = json({ exists: true, versionName: '2.29.12', versionCode: 125, size: 62737928, mtime: '2026-09-06T08:36:11.867Z', downloadUrl: '/multicc.apk' });
  routes['/api/ios-ota-info'] = json({ exists: true, versionName: '2.29.12', versionCode: '124', size: 13545599, mtime: '2026-09-05T16:17:48.323Z', installPage: '/ios-ota' });
  // A host that has nothing in flight until this page starts one: the version
  // row's pre-check must see `idle` (and offer the update) before the POST, and
  // the poll after it must see a run it can follow. It never reaches a terminal
  // state, because a terminal one would reload the page mid-test — the reload
  // is what the unit test pins.
  let updateStarted = false;
  routes['/api/update'] = () => { updateStarted = true; return json({ ok: true, status: 'started', force: false, activeStreaming: 2 }); };
  routes['/api/update/status'] = () => json(updateStarted
    ? { state: 'running', running: true, force: false, tail: 'Updating MultiCC (branch: main)...' }
    : { state: 'idle', running: false });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-ops-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    assert.ok(await page.waitFor('document.getElementById("air-ver-current").textContent === "v1.6.10"'),
      'the version row must report what the host answered');

    // ── The read-out ────────────────────────────────────────────────────────
    assert.equal(await page.evaluate('document.getElementById("air-ver-hint").textContent'), '有新版');
    assert.equal(await page.evaluate('document.getElementById("air-ver-badge").textContent'), 'v1.7.0');
    assert.equal(await page.evaluate('document.getElementById("air-ver-badge").hidden'), false);
    assert.match(await page.evaluate('document.getElementById("air-boot-time").textContent'), /^\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(await page.evaluate('document.getElementById("air-boot-uptime").textContent'), '已运行 3h 25m',
      'the boot read-out follows the reported uptime');

    // ── The region is light, like the rest of the shell ────────────────────
    const inspect = selectors => page.evaluate(`(() => {
      const rgb = s => { const a = String(s).match(/[\\d.]+/g)?.map(Number) || [0, 0, 0, 0]; return [a[0], a[1], a[2], a[3] ?? 1]; };
      const blend = (a, b) => a.slice(0, 3).map((c, i) => c * a[3] + b[i] * (1 - a[3]));
      const lum = a => a.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      function bg(el) { return el ? blend(rgb(getComputedStyle(el).backgroundColor), bg(el.parentElement)) : [255, 255, 255]; }
      return ${JSON.stringify(selectors)}.flatMap(selector => {
        const elements = [...document.querySelectorAll(selector)];
        if (!elements.length) return [{ selector, missing: true }];
        return elements.map(el => {
          const style = getComputedStyle(el), background = bg(el), fg = blend(rgb(style.color), background);
          const a = lum(fg), b = lum(background);
          return { selector, text: (el.textContent || '').trim().slice(0, 24), lightness: b, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
      });
    })()`);
    // Every surface in this region has to stay light — a dark component
    // leaking into the light shell is the failure mode this guards, and it is
    // invisible to the unit test. Contrast is measured separately because the
    // shell's own secondary tone (--muted, used by its captions) sits at 3.8;
    // holding this region to 4.5 while its siblings sit at 3.8 would make the
    // region the only part of the shell drawn in a different ink.
    const assertLight = async (selectors, floor) => {
      for (const check of await inspect(selectors)) {
        assert.ok(!check.missing, `missing ${check.selector}`);
        assert.ok(check.lightness > .75, `dark surface in the light shell: ${JSON.stringify(check)}`);
        assert.ok(check.contrast >= floor, `contrast ${check.contrast.toFixed(2)} < ${floor}: ${JSON.stringify(check)}`);
      }
    };
    await assertLight(['#sidebar', '#air-ver-row', '#air-ver-hint', '#air-boot-uptime', '#air-ops-status'], 3.7);
    await assertLight(['#air-ver-current', '#air-boot-time', '.ops-actions button', '.ops-actions a'], 4.5);
    const actions = await page.evaluate(`(() => {
      const row = document.querySelector('.ops-actions'), sidebar = document.getElementById('sidebar');
      return { buttons: [...row.querySelectorAll('button, a')].map(el => el.textContent.trim()),
        fits: row.getBoundingClientRect().right <= sidebar.getBoundingClientRect().right + 1,
        height: Math.min(...[...row.querySelectorAll('button')].map(el => el.getBoundingClientRect().height)) };
    })()`);
    assert.deepEqual(actions.buttons, ['安装包', '二维码', '推送通知', '🔄 重启', '退出登录']);
    assert.ok(actions.fits, 'the two-column action grid must fit the sidebar');
    assert.ok(actions.height >= 26, `tappable action rows, got ${actions.height}px`);
    // The sidebar is one column of bands that all want their natural height:
    // the fixed chrome, the task list, and this footer. Their minimums add up
    // to more than a 900px window, so something has to give — the footer keeps
    // the foot of the column, and a band that cannot fit must clip and scroll
    // rather than paint over its neighbour.
    assert.ok(await page.evaluate(`(() => {
      const sidebar = document.getElementById('sidebar');
      const footer = document.querySelector('.side-bottom');
      if (footer.getBoundingClientRect().bottom > sidebar.getBoundingClientRect().bottom + 1) return false;
      return [...sidebar.children].every(el => {
        const box = el.getBoundingClientRect();
        if (!box.height) return true;
        return el.scrollHeight <= el.clientHeight + 1 || getComputedStyle(el).overflowY !== 'visible';
      });
    })()`), 'the sidebar bands must not paint over each other');
    t.diagnostic('desktop: ' + await page.screenshot('air-ops-desktop'));

    // ── The update flow, in the real dialog element ────────────────────────
    await page.evaluate('document.getElementById("air-ver-row").click()');
    assert.ok(await page.waitFor('document.getElementById("ops-dialog").open'), 'the row must open the shared dialog');
    const confirmText = await page.evaluate('document.getElementById("ops-body").textContent');
    assert.match(confirmText, /当前版本：v1\.6\.10（通道：dev）/);
    assert.match(confirmText, /最新版本：v1\.7\.0/);
    assert.equal(page.requests.filter(entry => entry.path === '/api/update').length, 0,
      'opening the row asks; it must not start anything by itself');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#ops-actions button")].map(el => el.textContent)'), ['取消', '立即更新']);
    await assertLight(['#ops-dialog', '#ops-body', '#ops-extra .ops-force'], 3.7);
    t.diagnostic('dialog: ' + await page.screenshot('air-ops-dialog'));

    await page.evaluate('[...document.querySelectorAll("#ops-actions button")].find(el => el.textContent === "立即更新").click()');
    assert.ok(await page.waitFor('document.getElementById("ops-body").textContent.includes("正在更新，请勿关闭本机")'),
      'confirming starts the update and the dialog follows it');
    const started = page.requests.filter(entry => entry.path === '/api/update');
    assert.equal(started.length, 1, 'exactly one update request');
    assert.equal(started[0].method, 'POST');
    assert.deepEqual(JSON.parse(started[0].body), { force: false });
    assert.match(await page.evaluate('document.getElementById("air-ops-status").textContent'), /2 个会话正在输出/,
      'the interrupted turns are reported in the shell, not only in the dialog');
    await assertLight(['#air-ops-status.warn'], 3.7);

    // ── The install packages ───────────────────────────────────────────────
    await page.evaluate('document.getElementById("ops-dialog").close();document.getElementById("air-apk-btn").click()');
    assert.ok(await page.waitFor('document.querySelectorAll("#ops-extra .ops-download").length === 2'));
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#ops-extra .ops-download > div > strong")].map(el => el.textContent)'),
      ['Android APK · 2.29.12+125', 'iOS 安装包 · 2.29.12+124']);
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#ops-extra .ops-download a")].map(el => el.getAttribute("href"))'),
      ['/multicc.apk', '/ios-ota']);
    await assertLight(['.ops-download', '.ops-download small'], 3.7);
    await assertLight(['.ops-download strong'], 4.5);
    // The download control is a filled button, so it is dark by design — what
    // matters is that it wears the shell's own primary ink instead of a colour
    // of its own invention.
    assert.ok(await page.evaluate(`getComputedStyle(document.querySelector('.ops-download a')).backgroundColor
      === getComputedStyle(document.getElementById('schedule-save')).backgroundColor`),
      'the download button must carry the shell\'s primary button style');
    t.diagnostic('packages: ' + await page.screenshot('air-ops-packages'));

    // ── The QR code is pixels, not a description of pixels ─────────────────
    await page.evaluate('document.getElementById("ops-dialog").close();document.getElementById("air-qr-btn").click()');
    assert.ok(await page.waitFor('document.querySelector("#ops-extra .ops-qr canvas")'));
    const qr = await page.evaluate(`(() => {
      const canvas = document.querySelector('#ops-extra .ops-qr canvas');
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0, white = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        if (data[i] < 128) dark += 1; else if (data[i] > 200) white += 1;
      }
      return { dark, white, url: document.querySelector('#ops-extra .ops-qr small').textContent };
    })()`);
    assert.equal(qr.url, 'http://192.168.1.9:3000/air', 'the code carries this host\'s console URL');
    assert.ok(qr.dark > 50 && qr.white > 50, `an unscannable code would be blank or inverted: ${JSON.stringify(qr)}`);
    t.diagnostic('qr: ' + await page.screenshot('air-ops-qr'));

    // ── A laptop at 100% zoom: the opened region must still reach restart ──
    // 780px 是 1440×900 笔记本去掉浏览器栏后的视口。展开「更多与系统」后底栏比
    // 剩下的高度还高；侧栏曾经不滚、body 又 overflow:hidden，重启按钮直接被裁掉。
    await page.evaluate('document.getElementById("ops-dialog").close()');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 780, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.getElementById("side-more").open = true');
    assert.ok(await page.waitFor(`(() => {
      const box = document.getElementById('air-restart-btn').getBoundingClientRect();
      return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight + 1;
    })()`), 'opening 更多与系统 must bring the restart button on screen');
    assert.ok(await page.evaluate(`document.getElementById('tasks').getBoundingClientRect().height >= 100`),
      'the task list keeps a usable height instead of collapsing to nothing');
    t.diagnostic('laptop: ' + await page.screenshot('air-ops-laptop-780'));
    await page.evaluate('document.getElementById("side-more").open = false; document.getElementById("sidebar").scrollTop = 0');

    // ── The region holds up on a phone, where the sidebar is a drawer ──────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
    await page.evaluate('document.getElementById("ops-dialog").close();document.body.classList.add("nav-open");document.getElementById("sidebar").scrollTop = 1e6');
    assert.ok(await page.evaluate(`(() => {
      const row = document.querySelector('.ops-actions'), sidebar = document.getElementById('sidebar');
      return row.getBoundingClientRect().right <= innerWidth + 1 && row.scrollWidth <= row.clientWidth + 1
        && document.getElementById('air-ver-current').getBoundingClientRect().right <= sidebar.getBoundingClientRect().right + 1;
    })()`), 'the ops region must not overflow a 320px drawer');
    t.diagnostic('mobile: ' + await page.screenshot('air-ops-mobile-320'));

    assert.deepEqual(await page.evaluate('__errors'), []);
  });
});
