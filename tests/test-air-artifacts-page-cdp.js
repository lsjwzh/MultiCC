'use strict';

// 目录首页「本目录产物」这件事的两半：入口的排版（与「备忘」成组贴右边界）与那一页
// （/artifacts.html?dirId=…）自己的列表、两颗 PATCH 与两句兜底文案。
// 这里单独成篇而不是并进 test-air-workspace-fixes-cdp.js：那一篇在本仓 HEAD 上就已经
// 红在它的第一条断言（#tasks 的条数口径早变了，见那个文件里写死的 30），红在前面的
// 断言会让后面所有断言的结论都不可信 —— 这一篇从空目录页起，只跑这件事。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the directory artifacts entry sits with the memo and opens its own page', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, root = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const folder of ['', 'shared', 'vendor/dompurify']) {
    for (const file of fs.readdirSync(path.join(root, folder)).filter(f => /\.(js|css|html)$/.test(f))) {
      routes['/' + (folder ? folder + '/' : '') + file] = { body: fs.readFileSync(path.join(root, folder, file)),
        headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
    }
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: 'window.multiccWsUrl=async url=>url' };
  routes['/api/air'] = () => json({ ok: true, directories: [
    { id: 'd1', name: 'MultiCC', path: '/projects/multicc' }, { id: 'd2', name: '库存', path: '/projects/stock' },
  ], tasks: [], clis: ['codex'], migration: { errors: [] }, sessions: [] });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/providers'] = () => json({ available: false, providers: [], defaults: {} });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/aux/config'] = () => json({ providerId: 'configured' });
  routes['/api/cron'] = () => json([]);
  // 服务端给的顺序（永久保留 → 置顶 → 最后生成时间），服务（kind='service'）不在
  // 这一页里 —— 它归「服务与文档」那一格。
  // 每一行都带 dir —— 服务端按 ?dir= 过滤后必然如此（只返回 dir 等于该路径的行），
  // 也是这一页判定「过滤有没有生效」的依据。
  const artifacts = [
    { id: 'art-file', kind: 'file', title: '巡检日志', url: '/artifacts/run.log', createdAt: '2026-09-25T02:00:00.000Z', permanent: true, pinned: true, dir: '/projects/multicc' },
    { id: 'art-web', kind: 'page', title: '巡检报告', url: '/artifacts/report.html', createdAt: '2026-09-26T02:00:00.000Z', permanent: false, pinned: false, dir: '/projects/multicc' },
    { id: 'art-svc', kind: 'service', title: '预览服务', url: '/artifacts/svc/', dir: '/projects/multicc' },
  ];
  // 旧版本的服务端：看见 ?dir= 也照旧把整张表发回来，而且行上没有 dir。
  const unscoped = [
    { id: 'old-1', kind: 'page', title: '别处的产物', url: '/artifacts/other.html', createdAt: '2026-09-26T03:00:00.000Z' },
  ];
  routes['/api/docs-registry'] = ({ url }) => {
    const dir = url.searchParams.get('dir');
    if (dir === '/projects/multicc') return json(artifacts);
    if (dir === '/projects/legacy') return json(unscoped);
    return json([]);
  };
  routes['PATCH /api/docs-registry/art-web'] = ({ body }) => { Object.assign(artifacts[1], JSON.parse(body)); return json(artifacts[1]); };

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-artifacts-page') }, async page => {
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await page.navigate('/air?dir=d1');
    // 入口是模块自己插进去的，且与「备忘」同进同出。
    assert.ok(await page.waitFor(`document.getElementById('directory-artifacts')?.hidden === false`));
    // 排版：备忘与产物成组贴住工具条右边界（以前 space-between 把三个孩子摊成左中右
    // 三点，备忘孤零零悬在正中），视图切换还留在左边。
    const bar = await page.evaluate(`(() => {
      const memo = document.getElementById('directory-memo'), art = document.getElementById('directory-artifacts');
      const mode = document.getElementById('directory-mode');
      const box = document.querySelector('.directory-toolbar').getBoundingClientRect();
      const m = memo.getBoundingClientRect(), a = art.getBoundingClientRect(), s = mode.getBoundingClientRect();
      return { paired: memo.nextElementSibling === art, gap: Math.round(a.left - m.right),
        artRight: Math.round(box.right - a.right), memoLeft: Math.round(m.left - box.left),
        modeLeft: Math.round(s.left - box.left), barWidth: Math.round(box.width) };
    })()`);
    assert.equal(bar.paired, true, `产物入口要紧挨着备忘：${JSON.stringify(bar)}`);
    assert.ok(bar.artRight <= 2, `产物入口贴住工具条右边界：${JSON.stringify(bar)}`);
    assert.ok(bar.gap >= 0 && bar.gap <= 12, `两颗之间只有一个 gap：${JSON.stringify(bar)}`);
    assert.ok(bar.memoLeft > bar.barWidth / 2, `备忘被推回右半边，不再居中悬着：${JSON.stringify(bar)}`);
    assert.ok(bar.modeLeft < bar.barWidth / 2, `视图切换还留在左边：${JSON.stringify(bar)}`);
    // 目录页里不再有内联面板：点了是开一页（URL 带目录 id）。
    assert.equal(await page.evaluate(`document.getElementById('directory-artifacts-panel') === null`), true);
    assert.equal(await page.evaluate(`(()=>{window.open=u=>{window.artOpened=u};document.getElementById('directory-artifacts').click();return window.artOpened})()`),
      '/artifacts.html?dirId=d1');
    await page.screenshot('directory-artifacts-entry.png');

    // ── 那一页自己 ────────────────────────────────────────────────────────────
    await page.navigate('/artifacts.html?dirId=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#artifacts-list .directory-artifact-row').length === 2`),
      JSON.stringify({ body: await page.evaluate(`document.body.innerText.slice(0, 400)`) }));
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#artifacts-list .directory-artifact-copy a')].map(a => a.textContent)`),
      ['巡检日志', '巡检报告'], '服务端给的顺序照搬，不在这里重排');
    assert.equal(await page.evaluate(`document.getElementById('artifacts-list').textContent.includes('预览服务')`), false, '服务不在这一页');
    assert.equal(await page.evaluate(`document.getElementById('artifacts-workspace').textContent`), 'MultiCC · /projects/multicc');
    assert.equal(await page.evaluate(`document.getElementById('artifacts-manage').getAttribute('href')`), '/manage?view=docs');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.directory-artifact-row:first-child .air-doc-tag')].map(n => n.textContent)`),
      ['🔒 永久保留', '置顶'], '永久保留与置顶各是各的标记');
    await page.screenshot('artifacts-page.png');

    // 🔒 与 📌 各发各的 PATCH，互不牵连。
    const actions = row => `document.querySelectorAll('.directory-artifact-row')[${row}].querySelectorAll('.directory-artifact-actions button')`;
    const keep = actions(1);
    assert.ok(await page.waitFor(`${keep}[0].textContent === '永久保留'`));
    await page.evaluate(`${keep}[0].click()`);
    assert.ok(await page.waitFor(`document.getElementById('artifacts-status').textContent === '已设为永久保留'`),
      JSON.stringify({ status: await page.evaluate(`document.getElementById('artifacts-status').textContent`) }));
    assert.equal(artifacts[1].permanent, true, '🔒 只发 permanent');
    assert.equal(artifacts[1].pinned, false, '🔒 不顺手改置顶');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.directory-artifact-row')[1].querySelectorAll('.air-doc-tag')].map(n => n.textContent)`),
      ['🔒 永久保留'], '刷新后行上多出永久保留标记');
    await page.evaluate(`${keep}[1].click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.directory-artifact-row')[1].querySelectorAll('.air-doc-tag').length === 2`));
    assert.equal(artifacts[1].permanent, true, '📌 不顺手改永久保留');
    assert.equal(artifacts[1].pinned, true);

    // 服务端没按目录过滤（进程还在跑旧版本）时不装作没事：列表照旧显示，但状态行
    // 说明这一屏是全部目录的产物、重启服务即可。
    await page.navigate('/artifacts.html?dir=/projects/legacy');
    assert.ok(await page.waitFor(`document.getElementById('artifacts-status').textContent.includes('服务端没有按目录过滤')`),
      JSON.stringify({ status: await page.evaluate(`document.getElementById('artifacts-status').textContent`) }));
    await page.screenshot('artifacts-page-stale-server.png');
    // 过滤生效时不能误报这句话。
    await page.navigate('/artifacts.html?dir=/projects/multicc');
    assert.ok(await page.waitFor(`document.querySelectorAll('#artifacts-list .directory-artifact-row').length === 2`));
    assert.equal(await page.evaluate(`document.getElementById('artifacts-status').hidden`), true);
    await page.screenshot('artifacts-page-scoped.png');

    // 没有产物的目录 / 认不出的目录 id：各有一句话，不留白屏。
    await page.navigate('/artifacts.html?dir=/projects/stock');
    assert.ok(await page.waitFor(`document.getElementById('artifacts-list').textContent.includes('本目录还没有产物')`));
    await page.navigate('/artifacts.html?dirId=d9');
    assert.ok(await page.waitFor(`document.getElementById('artifacts-status').textContent === '未知目录'`));
    // 路径直给（?dir=）在这两处之外是可用形态：书签与外部链接都走它。
    assert.deepEqual(page.requests.map(r => r.path).filter(p => p === '/api/docs-registry').length > 0, true);
  });
});
