'use strict';

// The sidebar's CLI update badge, in a real browser. The unit test pins the
// module against a DOM shim; what a shim cannot see is whether the markup, the
// stylesheet and the module agree once they meet — in particular whether the
// badge actually sits on the brand row instead of pushing a new one into the
// sidebar, and whether the fixed-position popover lands on screen rather than
// outside it (the reason it lives outside #sidebar's transform container).
//
// The page's own scripts are stripped: air.js would boot the whole console from
// a directory API this test does not own. i18n and the module under test are
// re-added, so it runs exactly as it ships.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const CONTENT_TYPE = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };

const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

const VERSIONS = {
  ok: true,
  cached: false,
  checkedAt: '2026-09-21T10:00:00.000Z',
  updateCount: 2,
  versions: {
    claude: { cmd: '/bin/claude', available: true, version: '2.1.251', error: null, latest: '2.1.278', updateAvailable: true, updateSource: 'npm', inUseCount: 2 },
    codex: { cmd: '/bin/codex', available: true, version: '0.151.0', error: null, latest: '0.155.1', updateAvailable: true, updateSource: 'npm', inUseCount: 0 },
    qoder: { cmd: '/bin/qoderclicn', available: true, version: '1.1.4', error: null, latest: null, updateAvailable: false, updateSource: null, inUseCount: 0 },
    kimi: { cmd: 'kimi', available: false, version: null, error: null, latest: null, updateAvailable: false, updateSource: 'npm', inUseCount: 0 },
  },
};

test('the CLI update badge sits on the brand row and its popover lands on screen', async t => {
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
  const html = fs.readFileSync(path.join(publicDir, 'air.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script src="/i18n-catalog.js"></script><script src="/i18n.js"></script>'
      + '<script src="/shared/format.js"></script><script src="/provider-catalog.js"></script>'
      + '<script src="/air-cli-update.js"></script></body>');
  // provider-catalog.js 住在 public/shared 之外但依赖 shared/format.js（读目录只扫
  // 顶层，所以这两条得手工挂上）。页面里它们先于 air-cli-update.js 加载：行名是家族
  // 名，取自这份共享目录，少了它渲染到第一行就抛、行区是空的。
  routes['/shared/format.js'] = {
    body: fs.readFileSync(path.join(publicDir, 'shared', 'format.js')),
    headers: { 'content-type': 'text/javascript' },
  };
  routes['/'] = { body: html, headers: { 'content-type': 'text/html; charset=utf-8' } };

  let upgrades = 0;
  // 宿主按 pathname 路由，所以 ?refresh=1 和普通读取落在同一条上，用查询串区分：
  // 强制重探必须看到「已经升到最新」，否则角标不会消失。
  routes['/api/cli/versions'] = ({ url }) => (url.searchParams.get('refresh') === '1'
    ? json({
      ...VERSIONS,
      updateCount: 0,
      versions: { ...VERSIONS.versions, claude: { ...VERSIONS.versions.claude, version: '2.1.278', updateAvailable: false } },
    })
    : json(VERSIONS));
  routes['/api/cli/claude/upgrade'] = () => { upgrades += 1; return json({ ok: true, jobId: 'job_1', cli: 'claude', command: 'npm install -g @anthropic-ai/claude-code' }); };
  routes['/api/cli/install-status/job_1'] = () => json({
    ok: true,
    job: { id: 'job_1', cli: 'claude', status: 'done', exitCode: 0, error: null, logTail: 'changed 1 package\n' },
  });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-cli-update-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      // 升级前会走一次 window.confirm；真实浏览器里它会阻塞，headless 默认返回 false。
      window.confirm = () => true;
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    assert.ok(await page.waitFor('document.getElementById("cli-update-badge").hidden === false'),
      'the badge must appear once a version source reports an update');

    // ── The badge ──────────────────────────────────────────────────────────
    assert.equal(await page.evaluate('document.getElementById("cli-update-badge").textContent'), '2');
    assert.equal(await page.evaluate('document.getElementById("cli-update-btn").classList.contains("has-update")'), true);

    // 它在品牌行里，不是新的一栏：顶部贴齐品牌、左侧在侧栏内。
    const geometry = await page.evaluate(`(() => {
      const button = document.getElementById('cli-update-btn');
      const brand = document.querySelector('.brand-row');
      const card = document.querySelector('.space-card');
      const b = button.getBoundingClientRect(), row = brand.getBoundingClientRect(), c = card.getBoundingClientRect();
      return { top: b.top, rowTop: row.top, rowBottom: row.bottom, right: b.right, width: b.width, cardTop: c.top };
    })()`);
    assert.ok(geometry.top >= geometry.rowTop - 1 && geometry.top < geometry.rowBottom,
      `图标必须落在品牌行的高度内：${JSON.stringify(geometry)}`);
    assert.ok(geometry.top < geometry.cardTop, '图标要在工作目录卡片上方（页面左上角）');
    assert.ok(geometry.right < 300, '图标要留在侧栏宽度内');

    // ── The popover ────────────────────────────────────────────────────────
    await page.evaluate('document.getElementById("cli-update-btn").click()');
    assert.ok(await page.waitFor('document.getElementById("cli-update-pop").hidden === false'));
    const pop = await page.evaluate(`(() => {
      const el = document.getElementById('cli-update-pop');
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height,
               rows: document.getElementById('cli-update-rows').children.length,
               firstRow: document.getElementById('cli-update-rows').firstChild.textContent,
               summary: document.getElementById('cli-update-summary').textContent,
               expanded: document.getElementById('cli-update-btn').getAttribute('aria-expanded') };
    })()`);
    assert.ok(pop.left >= 0 && pop.right <= 1280, `浮层不能被挤出视口：${JSON.stringify(pop)}`);
    assert.ok(pop.top > geometry.rowBottom - 1, '浮层要贴在图标下方，而不是压在它身上');
    assert.equal(pop.rows, 4, '四个 CLI 都要列出来（可升级的排最前）');
    // 行名是家族: 升级的对象是家族的 CLI 制品, 不是某条车道。
    assert.match(pop.firstRow, /^Claude(?! Code)/);
    assert.match(pop.firstRow, /v2\.1\.251 → v2\.1\.278/);
    assert.match(pop.summary, /2/);
    assert.equal(pop.expanded, 'true');
    const qoderRow = await page.evaluate(`[...document.getElementById('cli-update-rows').children]
      .map(n => n.textContent).find(t => t.includes('Qoder CN'))`);
    assert.match(qoderRow, /无法检测最新版/);
    assert.doesNotMatch(qoderRow, /已是最新/, 'qoder 没有可比对的发布源，不能说成已是最新');

    // ── Upgrade ────────────────────────────────────────────────────────────
    await page.evaluate(`(() => {
      const row = document.getElementById('cli-update-rows').firstChild;
      row.querySelector('button').click();
    })()`);
    assert.ok(await page.waitFor('document.getElementById("cli-update-badge").hidden === true'),
      '升级完成后角标必须消失（靠 ?refresh=1 重探，而不是回放旧缓存）');
    assert.equal(upgrades, 1);
    assert.match(await page.evaluate('document.getElementById("cli-update-log").textContent'), /changed 1 package/);
    assert.deepEqual(await page.evaluate('window.__errors'), []);
  });
});

// 十个家族一起报时那块浮层比视口还高：它本来就是 overflow:auto 的，所以「滚不动、
// 后面的 CLI 被截断」不是排版没做，而是滚它自己会把它关掉 —— open() 挂在 window
// 捕获阶段的 scroll 监听分不清「侧栏滚了」和「浮层自己滚了」，而滚到头的继续滚动
// 还会链到侧栏去。两处都得堵：浮层内部的滚动不算离开锚点，滚到边界也不再外溢。
test('a long CLI update list scrolls to its last row instead of closing', async t => {
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
  const html = fs.readFileSync(path.join(publicDir, 'air.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script src="/i18n-catalog.js"></script><script src="/i18n.js"></script>'
      + '<script src="/shared/format.js"></script><script src="/provider-catalog.js"></script>'
      + '<script src="/air-cli-update.js"></script></body>');
  routes['/shared/format.js'] = {
    body: fs.readFileSync(path.join(publicDir, 'shared', 'format.js')),
    headers: { 'content-type': 'text/javascript' },
  };
  routes['/'] = { body: html, headers: { 'content-type': 'text/html; charset=utf-8' } };

  // 十个家族全都在、都没有新版：这是「CLI 比较多」时最常见的一屏（没有角标）。
  const families = ['claude', 'codex', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh', 'gemini', 'grok'];
  const versions = {};
  for (const cli of families) {
    versions[cli] = { cmd: `/bin/${cli}`, available: true, version: '1.0.0', error: null,
      latest: '1.0.0', updateAvailable: false, updateSource: 'npm', inUseCount: 0 };
  }
  routes['/api/cli/versions'] = () => json({ ok: true, cached: false, checkedAt: '2026-09-26T10:00:00.000Z', updateCount: 0, versions });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-cli-update-long') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    await page.evaluate(`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
    })()`);
    await page.evaluate('document.getElementById("cli-update-btn").click()');
    assert.ok(await page.waitFor('document.getElementById("cli-update-pop").hidden === false'));

    const box = () => page.evaluate(`(() => {
      const pop = document.getElementById('cli-update-pop');
      const rows = document.getElementById('cli-update-rows');
      const last = rows.lastElementChild, first = rows.firstElementChild;
      const p = pop.getBoundingClientRect();
      const l = last.getBoundingClientRect();
      return { rows: rows.children.length, hidden: pop.hidden,
        clientHeight: pop.clientHeight, scrollHeight: pop.scrollHeight, scrollTop: pop.scrollTop,
        bottom: Math.round(p.bottom), viewport: innerHeight,
        lastBottom: Math.round(l.bottom), firstTop: Math.round(first.getBoundingClientRect().top) };
    })()`);

    const initial = await box();
    assert.equal(initial.rows, families.length, '每个家族一行');
    assert.ok(initial.scrollHeight > initial.clientHeight,
      `这一屏本来就装不下，必须能滚：${JSON.stringify(initial)}`);
    assert.ok(initial.bottom <= initial.viewport, `浮层本身不能顶出屏幕：${JSON.stringify(initial)}`);
    assert.ok(initial.lastBottom > initial.bottom, `滚动前最后一行确实在框外：${JSON.stringify(initial)}`);

    // 用真实的滚轮事件在浮层上滚：这里以前会把它关掉（窗口捕获阶段的 scroll 监听）。
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 160, y: 400, deltaX: 0, deltaY: 240 });
    await page.waitFor(`document.getElementById('cli-update-pop').scrollTop > 0`).then(ok => {
      assert.ok(ok, `滚轮要能滚它：${JSON.stringify(initial)}`);
    });
    assert.equal(await page.evaluate('document.getElementById("cli-update-pop").hidden'), false,
      '滚浮层不该把它自己关掉');

    // 滚到底：最后一行要真的看见，不是被裁在框外。
    await page.evaluate(`(() => { const p = document.getElementById('cli-update-pop'); p.scrollTop = p.scrollHeight; return true; })()`);
    const scrolled = await box();
    assert.ok(scrolled.lastBottom <= scrolled.bottom + 1,
      `滚到底后最后一行要在框内：${JSON.stringify(scrolled)}`);
    assert.equal(scrolled.hidden, false, '滚到底也不该被关掉');
    // 滚到边界后的继续滚动不能外溢到侧栏去（overscroll-behavior: contain）。
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 160, y: 400, deltaX: 0, deltaY: 600 });
    assert.equal(await page.evaluate('document.getElementById("cli-update-pop").hidden'), false,
      '滚过头不能把浮层甩掉');
    assert.deepEqual(await page.evaluate('window.__errors'), []);
    await page.screenshot('cli-update-long-list.png');
  });
});

