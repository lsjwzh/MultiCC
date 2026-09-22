'use strict';
// 临时上传面板这次从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-storage.js）。
// 这一页只有三行数字和一个真删文件的按钮，所以每条都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 数字来自服务端 —— 打开面板只打 GET /api/uploads/stats 一条，三个字段逐项对
//      （总大小断的是格式化后的文本，不是字节数）；
//   ③ 按钮跟统计联动 —— count:0 时清理按钮真的 disabled（空态还要说明为什么），
//      count>0 时才可点；
//   ④ 清理先问一句 —— 答「否」不发 DELETE，答「是」才删；删完面板里显示删了几个、
//      释放了多少，并紧接着重新拉一次 stats；
//   ⑤ 窄屏上最长的那个目录可换行、不溢出面板，一个 G 以上进位到 GB。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air uploads panel is native: server-side stats, empty-state button, confirm before cleanup', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-storage-qa');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  // 临时目录的统计放在 fixture 里，路由读写它 —— 清理按钮的禁用状态、删完的数字、
  // 删完那一次重读，才有东西可断。（真接口还会带一份 files 明细，这一页不用，夹具就不放。）
  let uploads = { count: 3, totalSize: 5242880, dir: '/tmp/x/uploads' };
  routes['GET /api/uploads/stats'] = () => json(uploads);
  routes['DELETE /api/uploads/cleanup'] = () => {
    const result = { deleted: uploads.count, freed: uploads.totalSize };
    uploads = { count: 0, totalSize: 0, dir: uploads.dir };
    return json(result);
  };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const calls = () => page.requests.filter(r => r.path.startsWith('/api/uploads')).map(r => `${r.method} ${r.path}`);
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    // 文案一律从页面上的 t() 取回来再比：i18n 合并前后都稳，也不用把中文字面量抄进测试。
    const label = key => page.evaluate(`t(${JSON.stringify(key)})`);
    const labelP = (key, params) => page.evaluate(`t(${JSON.stringify(key)}, ${JSON.stringify(params)})`);
    // 带参数的 t() 在 i18n 合并进来之前会退化成裸 key（'airStorageCount'），
    // 3 和 0 看着一模一样 —— 所以「等这一轮读完」这类时序断言不能挂在带参数的文案上，
    // 改挂两种 i18n 无关的信号：字面量（'5.0 MB' / '0 B'）和请求序列。
    const waitForCalls = async (wanted, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (calls().slice(-wanted.length).join('|') === wanted.join('|')) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    };

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 从设置中心第四组进去：原生面板，不嵌旧 manage 页 ────────────────
    await page.navigate('/air?dir=d1&view=settings');
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-setting-card').length > 0`), '先落在设置中心');
    const T = {
      settingsCenter: await label('airSettingsCenter'),
      storage: await label('airAdminStorage'),
      crumbSettings: await label('airCrumbSettings'),
      back: await label('airAdminBackToSettings'),
      refresh: await label('airAdminRefresh'),
      title: await label('airStorageTitle'),
      hint: await label('airStorageHint'),
      files: await label('airStorageFiles'),
      totalSize: await label('airStorageTotalSize'),
      location: await label('airStorageLocation'),
      count3: await labelP('airStorageCount', { n: 3 }),
      count0: await labelP('airStorageCount', { n: 0 }),
      cleanup: await label('airStorageCleanup'),
      empty: await label('airStorageEmpty'),
      // 问句是「标题 + 空行 + 后果」两段拼的，跟面板里写的是同一种拼法。
      confirm3: await page.evaluate(`t('airStorageCleanupTitle', {n:3}) + "\\n\\n" + t('airStorageCleanupBody')`),
      done: await labelP('airStorageCleanupDone', { deleted: 3, freed: '5.0 MB' }),
    };
    assert.equal(await text('#task-title'), T.settingsCenter);
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')]
      .find(card => card.querySelector('strong')?.textContent === ${JSON.stringify(T.storage)}).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(T.storage)}`), '点进去落在临时上传页');
    assert.equal(await text('#task-breadcrumb'), T.crumbSettings, '面包屑说的是设置中心这一类');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + T.back, '↻' + T.refresh], '工具条是面板自己的（返回设置中心 / 刷新），不是旧页面的');
    assert.equal(await text('.air-storage-panel h3'), T.title);
    assert.equal(await text('.air-storage-panel .admin-panel-note'), T.hint, '副标题说的是这一格是干什么的');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-storage-label')].map(node => node.textContent)`),
      [T.files, T.totalSize, T.location], '三行只读字段');

    // ── ② 数字来自服务端：打开面板只打一条统计，总大小断的是格式化后的文本 ──
    assert.deepEqual(calls(), ['GET /api/uploads/stats'], '打开面板只打一条统计请求');
    assert.ok(await page.waitFor(`document.getElementById('air-storage-size').textContent === '5.0 MB'`), '统计读回来了');
    assert.equal(await text('#air-storage-count'), T.count3);
    assert.equal(await text('#air-storage-size'), '5.0 MB', '5242880 字节要显示成 5.0 MB');
    assert.equal(await text('#air-storage-dir'), '/tmp/x/uploads');
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('air-storage-dir')).fontFamily.includes('mono')`), true,
      '目录是等宽字体（路径里的字符要能对齐着数）');
    assert.equal(await page.evaluate(`document.getElementById('air-storage-cleanup').disabled`), false, '有文件时清理按钮可点');
    assert.equal(await text('#air-storage-cleanup'), T.cleanup, '按钮上写的是「清理」');
    assert.equal(await page.evaluate(`document.getElementById('air-storage-cleanup').classList.contains('danger')`), true,
      '这是唯一一个按一下就真删的按钮，得是危险色');
    await page.screenshot('01-uploads-native-desktop');

    // ── ③ 空目录：按钮真的 disabled，并补一句为什么没得清 ────────────────
    uploads = { count: 0, totalSize: 0, dir: '/tmp/x/uploads' };
    await page.evaluate(`document.querySelectorAll('#admin-actions button')[1].click()`); // 工具条那颗「刷新」
    assert.ok(await page.waitFor(`document.getElementById('air-storage-size').textContent === '0 B'`), '刷新后读到 0');
    assert.deepEqual(calls().slice(-1), ['GET /api/uploads/stats'], '工具条的刷新就是重读统计');
    assert.equal(await text('#air-storage-count'), T.count0);
    assert.equal(await page.evaluate(`document.getElementById('air-storage-cleanup').disabled`), true, 'count:0 时清理按钮真的 disabled');
    assert.equal(await page.evaluate(`document.getElementById('air-storage-empty').className`), 'admin-empty', '空态用的是 admin-empty 那一档');
    assert.equal(await page.evaluate(`document.getElementById('air-storage-empty').checkVisibility()`), true, '空态那一句真的露出来了');
    assert.equal(await text('#air-storage-empty'), T.empty);
    assert.equal(await text('#air-storage-size'), '0 B', '空目录的总大小是 0 B');

    // ── ④ 清理：先问一句，答「否」不发请求，答「是」才删 ──────────────────
    uploads = { count: 3, totalSize: 5242880, dir: '/tmp/x/uploads' };
    await page.evaluate(`document.querySelectorAll('#admin-actions button')[1].click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-storage-size').textContent === '5.0 MB'`), '又有文件了');
    assert.equal(await page.evaluate(`document.getElementById('air-storage-cleanup').disabled`), false, '有文件时按钮又亮回来');
    await page.evaluate(`window.__realConfirm = window.confirm; window.confirm = text => { window.__asked = (window.__asked||[]).concat([text]); return false; }`);
    await page.evaluate(`document.getElementById('air-storage-cleanup').click()`);
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, 60))`); // 等一拍：答「否」也不该有请求在路上
    assert.equal(page.requests.some(r => r.method === 'DELETE'), false, '答「否」时不许发删除请求');
    assert.deepEqual(await page.evaluate(`window.__asked`), [T.confirm3], '清理前问的那句带着「几个文件」和后果');
    assert.equal(await text('#air-storage-status'), '', '答「否」时界面上什么都没发生');
    assert.equal(uploads.count, 3, '答「否」时文件一个都没少');
    await page.evaluate(`window.confirm = text => { window.__asked = (window.__asked||[]).concat([text]); return true; }`);
    await page.evaluate(`document.getElementById('air-storage-cleanup').click()`);
    assert.ok(await waitForCalls(['DELETE /api/uploads/cleanup', 'GET /api/uploads/stats']), '删完紧接着重新拉一次统计');
    assert.ok(await page.waitFor(`document.getElementById('air-storage-size').textContent === '0 B'`), '答「是」之后文件清空了');
    assert.equal(await text('#air-storage-count'), T.count0);
    assert.equal(await text('#air-storage-status'), T.done, '面板里显示删了几个、释放了多少');
    assert.equal(await page.evaluate(`document.getElementById('air-storage-cleanup').disabled`), true, '删空之后按钮跟着灰掉');
    await page.evaluate(`window.confirm = window.__realConfirm`);

    // ── ⑤ 窄屏：长目录可换行、不溢出；一个 G 以上进位到 GB ────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    uploads = { count: 2, totalSize: 2147483648, dir: '/var/folders/long/path/that/keeps/going/and/going/T/multicc_uploads_cache' };
    await page.navigate('/air?dir=d1&view=storage');
    assert.ok(await page.waitFor(`document.getElementById('air-storage-size').textContent !== '—'`), '窄屏上直接打开这一页照样渲染');
    assert.equal(await text('#air-storage-size'), '2.0 GB', '2147483648 字节要进位到 2.0 GB');
    assert.equal(await text('#air-storage-dir'), uploads.dir);
    const narrow = await page.evaluate(`(() => {
      const panel = document.querySelector('.air-storage-panel').getBoundingClientRect();
      const dir = document.getElementById('air-storage-dir');
      const row = dir.closest('.air-storage-row').getBoundingClientRect();
      return {
        dirRight: Math.round(dir.getBoundingClientRect().right),
        rowRight: Math.round(row.right),
        panelRight: Math.round(panel.right),
        dirHeight: Math.round(dir.getBoundingClientRect().height),
      };
    })()`);
    assert.ok(narrow.dirRight <= narrow.rowRight + 1, `目录不许溢出它那一行（${narrow.dirRight} vs ${narrow.rowRight}）`);
    assert.ok(narrow.rowRight <= narrow.panelRight + 1, `那一行也不许溢出面板（${narrow.rowRight} vs ${narrow.panelRight}）`);
    assert.ok(narrow.dirHeight > 14, '这么长的路径在窄屏上换了行，不是被裁掉');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '窄屏这条入口同样是原生面板');
    await page.screenshot('02-uploads-native-mobile');
  });
});
