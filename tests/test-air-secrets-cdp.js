'use strict';
// 敏感信息面板这次从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-secrets.js）。
// 这不是一次外观调整，面板里放的是明文密钥，所以每一条都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 列表只拿元数据 —— 打开面板只打 GET /api/secrets 一条，值不在列表响应里，
//      也不在 DOM 里；
//   ③ 值只在「显示」那一下读回 —— 单独一条 GET /api/secrets/:name/value，写进 DOM
//      的是文本节点；再点一次「隐藏」连节点一起收掉，刷新后也不会自己冒出来；
//   ④ 写入与删除打的是真接口 —— POST 的 body 逐字段断言（顺手验明文值不进 URL），
//      DELETE 之前必须先问一句、答「否」时不许发请求；
//   ⑤ 入口本身在控制台顶栏常驻、也在设置中心第一组第一格，两边点进去都落在原生面板上。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air vault panel is native: metadata-only list, per-name reveal, real write and delete', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-secrets-qa');
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

  // 保险箱状态放在 fixture 里，路由读写它 —— 面板刷不刷新、列表跟不跟着改，才有东西可断。
  // 值是编的字符串（形状像 key 即可），真密钥永远不进测试夹具。
  let vault = [
    { name: 'OPENAI_API_KEY', description: 'Codex 上游', source: 'user', updatedAt: 1700000000000 },
    { name: 'GITHUB_TOKEN', description: '', source: 'agent', updatedAt: 1700000001000 },
  ];
  const VALUES = { OPENAI_API_KEY: 'sk-fixture-not-a-real-key', GITHUB_TOKEN: 'gh-fixture-not-a-real-token' };
  const meta = entry => ({ name: entry.name, description: entry.description, source: entry.source, updatedAt: entry.updatedAt });
  const posts = [];
  routes['GET /api/secrets'] = () => json(vault.map(meta));
  routes['POST /api/secrets'] = req => {
    posts.push(JSON.parse(req.body));
    const { name } = posts[posts.length - 1];
    vault = vault.filter(entry => entry.name !== name).concat([{ ...posts[posts.length - 1], source: 'user', updatedAt: Date.now() }]);
    return json({ ok: true, entry: meta(vault[vault.length - 1]) });
  };
  for (const name of Object.keys(VALUES)) {
    routes[`/api/secrets/${name}/value`] = json({ ok: true, name, value: VALUES[name] });
    routes[`DELETE /api/secrets/${name}`] = () => {
      vault = vault.filter(entry => entry.name !== name);
      return json({ ok: true });
    };
  }
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const calls = () => page.requests.filter(r => r.path.startsWith('/api/secrets')).map(r => `${r.method} ${r.path}`);
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ⓪ 控制台顶栏上那颗常驻入口：打开控制台就在，不用滚到工具格 ────────
    await page.navigate('/air?dir=d1&view=overview');
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`), '控制台打开');
    const topBar = await page.evaluate(`(() => {
      const head = document.getElementById('console-head');
      const button = document.getElementById('console-secrets');
      if (!button) return null;
      const b = button.getBoundingClientRect();
      return { inHead: head.contains(button), text: button.textContent.replace(/\\s+/g,''), visible: button.checkVisibility() };
    })()`);
    assert.deepEqual(topBar, { inHead: true, text: '🔐敏感信息', visible: true }, '保险箱入口钉在控制台顶栏上');
    // 顶栏那颗现在就是唯一的控制台入口 —— 工具格里不该再留一张同样的卡。
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.admin-tool-card')].some(card => card.textContent.includes('敏感信息'))`), false,
      '工具格里不再重复一张保险箱卡');
    await page.screenshot('00-console-topbar');
    await page.evaluate(`document.getElementById('console-secrets').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='敏感信息'`), '顶栏那颗一键到保险箱整页');
    assert.equal(await page.evaluate(`document.body.classList.contains('console-open')`), false, '进整页时控制台让开');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0);

    // ⓪ 已经打过一次列表接口（顶栏那颗真的把面板渲染过一遍），所以下面几段
    // 比的是「这一轮从零开始打了什么」，锚点先记下来。
    const base = calls().length;

    // ── ① 从设置中心第一格进去：原生面板，不嵌旧 manage 页 ────────────────
    await page.navigate('/air?dir=d1&view=settings');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='设置中心'`), '先落在设置中心');
    assert.equal(await page.evaluate(`document.querySelector('.air-settings-feature-group .air-setting-card strong').textContent`), '敏感信息',
      '保险箱是设置中心第一组的第一格');
    await page.evaluate(`document.querySelector('.air-settings-feature-group .air-setting-card').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='敏感信息'`), '点进去落在保险箱页');
    assert.equal(await page.evaluate(`document.getElementById('task-breadcrumb').textContent`), 'MultiCC Air › 设置中心',
      '面包屑说的是设置中心这一类（页头别再露出 secrets 这个 mode 名）');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    // 图标是一个单独的 span，textContent 拼起来没有空格 —— 比的是「哪几个动作」，
    // 所以按去空白后的文本断，别把排版细节写进断言。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←返回设置中心', '↻刷新'], '工具条是面板自己的（返回设置中心 / 刷新），不是旧页面的');
    await page.screenshot('01-vault-native-desktop');

    // ── ② 列表只拿元数据：值既不在响应里，也不在 DOM 里 ───────────────────
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-secret-list .air-secret-card').length===2`), '两条条目都画出来了');
    assert.deepEqual(calls().slice(base), ['GET /api/secrets'], '打开面板只打一条列表请求');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-secret-list .air-secret-name')].map(el => el.textContent)`),
      ['OPENAI_API_KEY', 'GITHUB_TOKEN']);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-secret-list .air-secret-tag')].map(el => el.textContent)`),
      ['手动添加', 'agent 填写'], '来源标出「谁填的」');
    assert.equal(await page.evaluate(`document.querySelector('#air-secret-list .air-secret-copy small').textContent.includes('Codex 上游')`), true,
      '描述跟在名字后面');
    assert.equal(await text('#air-secret-count'), '2 条');
    const bodyText = await page.evaluate(`document.getElementById('air-secret-list').innerText`);
    for (const value of Object.values(VALUES)) {
      assert.equal(bodyText.includes(value), false, '列表里不该出现任何明文值：' + value);
    }
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-secret-list .air-secret-value').length`), 0, '没人点「显示」时根本没有画值的节点');

    // ── ③ 值只在点「显示」那一下单条读回，再点一次连节点一起收掉 ──────────
    await page.evaluate(`[...document.querySelectorAll('#air-secret-list .air-secret-actions button')].find(b => b.textContent==='显示').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-secret-list .air-secret-value').length===1`), '点「显示」后值才出现');
    assert.deepEqual(calls().slice(base + 1), ['GET /api/secrets/OPENAI_API_KEY/value'], '读值走单独那条按名字取值的接口，且只读点开的那一条');
    assert.equal(await text('#air-secret-list .air-secret-value'), VALUES.OPENAI_API_KEY);
    assert.equal(await page.evaluate(`document.querySelector('#air-secret-list .air-secret-card .air-secret-actions button').textContent`), '隐藏',
      '点开之后按钮换成「隐藏」');
    await page.evaluate(`document.querySelector('#air-secret-list .air-secret-card .air-secret-actions button').click()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-secret-list .air-secret-value').length`), 0, '收起来时值的节点被拿掉');
    assert.equal(await page.evaluate(`document.getElementById('air-secret-list').innerText.includes(${JSON.stringify(VALUES.OPENAI_API_KEY)})`), false,
      '收起后 DOM 里不该还留着那段明文');
    // 刷新一下：显示状态不跨刷新（值不该比那一次点击活得更久）。
    await page.evaluate(`[...document.querySelectorAll('#air-secret-list .air-secret-actions button')].find(b => b.textContent==='显示').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-secret-list .air-secret-value').length===1`));
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('刷新')).click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-secret-list .air-secret-value').length===0`), '刷新后值重新收起');

    // ── ④ 写入：本地先挡一道，通过后打真接口，body 逐字段断言 ─────────────
    // 名称不合规时不该发请求 —— 格式校验在本地就该挡住，值没必要为它跑一趟网络。
    await page.evaluate(`(() => { const n=document.getElementById('air-secret-name'); n.value='bad name!';
      document.getElementById('air-secret-value').value='x'; document.getElementById('air-secret-save').click(); })()`);
    assert.equal(await text('#air-secret-status'), '名称仅限字母数字与 _ . -（1-64 位）');
    assert.equal(posts.length, 0, '格式不对时不发写入请求');
    // 值不能被明文提交进 URL（POST body 才是它该待的地方）—— 这条靠下面 body 断言兜底。
    await page.evaluate(`(() => { document.getElementById('air-secret-name').value='ANTHROPIC_BASE_URL_FIXTURE';
      document.getElementById('air-secret-value').value=''; document.getElementById('air-secret-save').click(); })()`);
    assert.equal(await text('#air-secret-status'), '值不能为空', '空值也挡在本地');
    assert.equal(posts.length, 0);
    await page.evaluate(`(() => { document.getElementById('air-secret-name').value='ANTHROPIC_BASE_URL_FIXTURE';
      document.getElementById('air-secret-value').value='${VALUES.GITHUB_TOKEN}';
      document.getElementById('air-secret-desc').value='测试上游'; document.getElementById('air-secret-save').click(); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-secret-list .air-secret-card').length===3`), '保存后列表多一条');
    assert.deepEqual(posts, [{ name: 'ANTHROPIC_BASE_URL_FIXTURE', value: VALUES.GITHUB_TOKEN, description: '测试上游', source: 'user' }],
      '写的是真接口，body 就这四项');
    assert.equal(await text('#notice'), '已保存 ANTHROPIC_BASE_URL_FIXTURE');
    assert.deepEqual(await page.evaluate(`['air-secret-name','air-secret-value','air-secret-desc'].map(id => document.getElementById(id).value)`),
      ['', '', ''], '保存成功立刻清空表单：明文值不在 DOM 里多待一秒');
    assert.equal(await text('#air-secret-count'), '3 条', '条数跟着刷新');
    await page.screenshot('02-vault-after-save');

    // ── ⑤ 删除：先问一句，答「否」不发请求，答「是」才删 ─────────────────
    const asked = [];
    await page.evaluate(`window.__realConfirm = window.confirm; window.confirm = text => { window.__asked = (window.__asked||[]).concat([text]); return false; }`);
    await page.evaluate(`[...document.querySelectorAll('#air-secret-list .air-secret-card')]
      .find(card => card.querySelector('.air-secret-name').textContent==='GITHUB_TOKEN')
      .querySelector('.air-secret-actions .danger').click()`);
    assert.equal(page.requests.some(r => r.method === 'DELETE'), false, '答「否」时不许发删除请求');
    await page.evaluate(`window.confirm = text => { window.__asked = (window.__asked||[]).concat([text]); return true; }`);
    await page.evaluate(`[...document.querySelectorAll('#air-secret-list .air-secret-card')]
      .find(card => card.querySelector('.air-secret-name').textContent==='GITHUB_TOKEN')
      .querySelector('.air-secret-actions .danger').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-secret-list .air-secret-card').length===2`), '答「是」之后列表少一条');
    assert.deepEqual(await page.evaluate(`window.__asked`),
      ['删除 GITHUB_TOKEN？\n\n删除后以该名称注入的环境变量也会消失（下一轮生效）。',
       '删除 GITHUB_TOKEN？\n\n删除后以该名称注入的环境变量也会消失（下一轮生效）。'],
      '删除前问的这句带着条目名和后果（两次都问了，只差一个答案）');
    assert.equal(await text('#notice'), '已删除 GITHUB_TOKEN');
    assert.deepEqual(calls().slice(-2), ['DELETE /api/secrets/GITHUB_TOKEN', 'GET /api/secrets'], '删完重新拉列表');
    await page.evaluate(`window.confirm = window.__realConfirm`);

    // ── ⑥ 窄屏：一张卡在手机宽度下要能换行，操作不挤成一条缝 ───────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=secrets');
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-secret-list .air-secret-card').length===2`), '窄屏上列表照样渲染');
    const narrow = await page.evaluate(`(() => {
      const card = document.querySelector('#air-secret-list .air-secret-card');
      const actions = card.querySelector('.air-secret-actions');
      const box = card.getBoundingClientRect(), act = actions.getBoundingClientRect();
      return { columns: getComputedStyle(card).flexWrap, actRight: Math.round(act.right), cardRight: Math.round(box.right), sameRow: Math.abs(act.top - box.top) < 6 };
    })()`);
    assert.equal(narrow.columns, 'wrap', '窄屏上卡片允许换行');
    assert.ok(narrow.actRight <= narrow.cardRight + 1, `操作按钮不许溢出卡片（${narrow.actRight} vs ${narrow.cardRight}）`);
    assert.equal(narrow.sameRow, false, '窄屏上操作换到自己那一行，不去挤名字');
    await page.screenshot('03-vault-native-mobile');
  });
});
