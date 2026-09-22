'use strict';
// 「Agent 资源」这一格原来嵌的是旧 manage 页的 resources view，现在改成了 Air 原生页
// （air-resources.js）。它不是一次外观调整 —— 这一页上有一排会删磁盘目录的按钮
// （~/.claude/projects 下的历史会话），所以每一条都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只打两条列表接口（技能 / 历史各一次），筛选是纯本地的，不发请求；
//   ③ 清单逐条对得上：技能的名字/描述/路径、历史的 id/时间/大小与抬头三个数；
//   ④ 删除必须先问一句 —— 答「否」时不许发请求；linked 的那条连问都不问（按钮禁用，
//      点下去既没有请求也不该多出一句问话）；
//   ⑤ 路径编码：project 与 id 两段都进 URL，任一段漏编都会打偏（这条用带 % 的目录名
//      钉住 —— 没编码的 % 会原样留在请求路径里，编码过的才是 %25）；
//   ⑥ 批量清理按下拉里那个档位打（older than 180 days → olderThanDays=180），删完把
//      「删了几条 / 释放了多少」写进面板状态行。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air agent-resources panel is native: skill list, history list, guarded deletes', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-resources-qa');
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

  // ── 夹具 ───────────────────────────────────────────────────────────────
  // 技能名/描述/路径全是磁盘上的字符串，这里按真实形状给（名字里带 - 、路径是绝对路径）。
  const SKILLS = [
    { provider: 'claude', source: 'agents', name: 'code-review', description: '审查代码改动', path: '/Users/me/.agents/skills/code-review' },
    { provider: 'claude', source: 'plugin', name: 'doc-writer', description: '', path: '/Users/me/.claude/plugins/doc-writer' },
    { provider: 'codex', source: 'agents', name: 'prompt-tuner', description: '调提示词', path: '/Users/me/.agents/skills/prompt-tuner' },
  ];
  // 会话夹具：一条 linked（受保护，不许删）、一条可删。
  // project 是 cwd 的 basename、id 是 ~/.claude/projects/<project>/<id>.jsonl 的文件名，
  // 两段都进 URL，所以两段都得编码。这里两段各带一个 %（真实的项目目录名里带 % 会发生；
  // id 真实形状是 UUID，这里带上是为了让「漏编码」真的看得出来 —— 空格会被浏览器的
  // URL 规范化顺手编成 %20，只有 % 会原样留在请求路径里：编码过的是 %25，没编码的是 %）。
  const UPDATED = Date.UTC(2026, 8, 20, 6, 30, 0);
  const FREE_PROJECT = '-Users me-50% off';
  const FREE_ID = '0f0a%b1';
  const LINKED_ID = 'a1b2-linked';
  const FREE_SIZE = 2048, LINKED_SIZE = 4096;
  let sessions = [
    { id: LINKED_ID, title: '受保护的会话', preview: 'linked to a multicc task', cwd: '/projects/linked', project: 'projects-demo', updatedAt: UPDATED - 86400000, size: LINKED_SIZE, linked: true },
    { id: FREE_ID, title: '可删的会话', preview: 'hello world', cwd: '/projects/free', project: FREE_PROJECT, updatedAt: UPDATED, size: FREE_SIZE, linked: false },
  ];
  const sessionWire = session => ({ ...session });
  const summaryOf = list => ({
    sessions: list.map(sessionWire),
    count: list.length,
    totalSize: list.reduce((sum, session) => sum + session.size, 0),
    protectedCount: list.filter(session => session.linked).length,
  });
  routes['GET /api/agent-resources/skills'] = () => json({
    skills: SKILLS,
    counts: { claude: SKILLS.filter(s => s.provider === 'claude').length, codex: SKILLS.filter(s => s.provider === 'codex').length },
  });
  routes['GET /api/agent-resources/claude-sessions'] = () => json(summaryOf(sessions));
  const deleteOnePath = `/api/agent-resources/claude-sessions/${encodeURIComponent(FREE_PROJECT)}/${encodeURIComponent(FREE_ID)}`;
  routes['DELETE ' + deleteOnePath] = () => {
    sessions = sessions.filter(session => session.id !== FREE_ID);
    return json({ ok: true, freed: FREE_SIZE });
  };
  const cleanQueries = [];
  routes['DELETE /api/agent-resources/claude-sessions'] = ({ url }) => {
    cleanQueries.push(url.searchParams.get('olderThanDays'));
    return json({ ok: true, deleted: 3, freed: 1048576 });
  };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const i18n = (key, params) => page.evaluate(`t(${JSON.stringify(key)}${params ? ', ' + JSON.stringify(params) : ''})`);
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const listText = selector => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(el => el.textContent)`);
    const calls = () => page.requests.filter(r => r.path.startsWith('/api/agent-resources')).map(r => `${r.method} ${r.path}`);
    const deletes = () => page.requests.filter(r => r.method === 'DELETE');
    // 会话行按 id 找：列表顺序是接口给的，测试不该依赖它。
    const sessionRowAction = id => `[...document.querySelectorAll('#air-resources-history-list .air-resources-row')]
      .find(row => row.querySelector('.air-resources-meta').textContent.includes(${JSON.stringify(id)}))
      .querySelector('.air-resources-danger')`;

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 从设置中心「资源与存储」那一组进去 ───────────────────────────────
    await page.navigate('/air?dir=d1&view=settings');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent===t('airSettingsCenter')`), '先落在设置中心');
    const base = calls().length;
    await page.evaluate(`(() => {
      const label = t('airAdminPanelResources');
      const card = [...document.querySelectorAll('.air-setting-card')].find(node => node.querySelector('strong').textContent === label);
      if (!card) throw new Error('设置中心里没有 Agent 资源那一格');
      card.click();
    })()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent===t('airAdminResources')`), '点进去落在 Agent 资源页');
    assert.equal(await page.evaluate(`document.getElementById('task-breadcrumb').textContent`), await i18n('airCrumbSettings'),
      '面包屑说的是设置中心这一类（页头别再露出 resources 这个 mode 名）');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + await i18n('airAdminBackToSettings'), '↻' + await i18n('airAdminRefresh')], '工具条是面板自己的（返回设置中心 / 刷新）');
    await page.screenshot('01-resources-native-desktop');

    // ── ② 打开只打两条列表：技能一次、会话一次 ─────────────────────────────
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-resources-skills-list .air-resources-row').length===3`), '技能列表画出来了');
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-resources-history-list .air-resources-row').length===2`), '会话列表画出来了');
    assert.deepEqual(calls().slice(base),
      ['GET /api/agent-resources/skills', 'GET /api/agent-resources/claude-sessions'],
      '打开面板就这两条列表请求');

    // ── ③ 技能清单：名字 / 描述 / source · path，抬头是安装量 ──────────────
    assert.deepEqual(await listText('#air-resources-skills-list .air-resources-title'),
      ['code-review', 'doc-writer', 'prompt-tuner']);
    assert.deepEqual(await listText('#air-resources-skills-list .air-resources-desc'),
      ['审查代码改动', '调提示词'], '没有描述的那条不画一行空描述');
    assert.deepEqual(await listText('#air-resources-skills-list .air-resources-meta'),
      ['agents · /Users/me/.agents/skills/code-review', 'plugin · /Users/me/.claude/plugins/doc-writer', 'agents · /Users/me/.agents/skills/prompt-tuner'],
      '每行都标出「哪来的 · 装在哪」');
    assert.deepEqual(await listText('#air-resources-skills-list .air-resources-badge'), ['claude', 'claude', 'codex']);
    assert.equal(await text('#air-resources-skills-count'), await i18n('airResourcesSkillsCount', { claude: 2, codex: 1 }));
    assert.equal(await page.evaluate(`document.getElementById('air-resources-skills-filter').placeholder`),
      await i18n('airResourcesSkillsFilter'), '过滤框的问法是 i18n 的，不是写死的英文');

    // ── ④ 过滤是本地过滤：数字和请求都不变 ────────────────────────────────
    const filterSkills = async value => page.evaluate(`(() => {
      const input = document.getElementById('air-resources-skills-filter');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await filterSkills('codex');
    assert.deepEqual(await listText('#air-resources-skills-list .air-resources-title'), ['prompt-tuner'],
      '按 provider 也能筛（provider 是过滤字段之一）');
    await filterSkills('/plugins/doc-writer');
    assert.deepEqual(await listText('#air-resources-skills-list .air-resources-title'), ['doc-writer'], '按 path 筛得动');
    await filterSkills('zzz-nothing');
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-resources-skills-list .air-resources-row').length`), 0, '没有命中就没有行');
    assert.equal(await text('#air-resources-skills-list .admin-empty'), await i18n('airResourcesSkillsEmpty'), '没有命中时是空态');
    assert.equal(await text('#air-resources-skills-count'), await i18n('airResourcesSkillsCount', { claude: 2, codex: 1 }),
      '抬头说的是装了多少，不是筛出多少');
    assert.deepEqual(calls().slice(base),
      ['GET /api/agent-resources/skills', 'GET /api/agent-resources/claude-sessions'], '过滤全程零请求');
    await filterSkills('');
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-resources-skills-list .air-resources-row').length`), 3);

    // ── ⑤ 历史清单：抬头三个数、每行的时间与大小、linked 那条删不动 ────────
    assert.equal(await text('#air-resources-history-count'),
      await i18n('airResourcesHistorySummary', { n: 2, size: '6.0 KB', protected: 1 }),
      '抬头是「几个会话 · 多大 · 几个受保护」');
    const whenFree = await page.evaluate(`new Date(${UPDATED}).toLocaleString(getLocale())`);
    const whenLinked = await page.evaluate(`new Date(${UPDATED - 86400000}).toLocaleString(getLocale())`);
    assert.deepEqual(await listText('#air-resources-history-list .air-resources-meta'),
      [`${LINKED_ID} · ${whenLinked} · 4.0 KB`, `${FREE_ID} · ${whenFree} · 2.0 KB`],
      '每行是「id · 本地时间 · 大小」');
    assert.deepEqual(await listText('#air-resources-history-list .air-resources-title'), ['受保护的会话', '可删的会话']);
    assert.equal(await text('#air-resources-history-status'), await i18n('airResourcesProtectedHint'), '状态行默认在说「关联的删不掉」');
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-resources-history-list .air-resources-danger').length`), 2, '每条历史都有自己的 Delete');
    assert.equal(await page.evaluate(`${sessionRowAction(LINKED_ID)}.disabled`), true, 'linked 那条的 Delete 真的禁用');
    assert.equal(await page.evaluate(`${sessionRowAction(LINKED_ID)}.title`), await i18n('airResourcesLinked'), '禁用的原因挂在 title 上');
    assert.equal(await page.evaluate(`${sessionRowAction(FREE_ID)}.disabled`), false, '没关联的那条能删');
    // 「清理早于」的档位：四个值，默认 30，label 是 i18n 的。
    assert.deepEqual(await page.evaluate(`[...document.getElementById('air-resources-history-age').options].map(o => o.value)`),
      ['7', '30', '90', '180']);
    assert.deepEqual(await listText('#air-resources-history-age option'),
      [await i18n('airResourcesOlderThanDays', { n: 7 }), await i18n('airResourcesOlderThanDays', { n: 30 }),
        await i18n('airResourcesOlderThanDays', { n: 90 }), await i18n('airResourcesOlderThanDays', { n: 180 })]);
    assert.equal(await page.evaluate(`document.getElementById('air-resources-history-age').value`), '30', '默认档位是 30 天');

    // ── ⑥ 删除：先问一句；答「否」不发请求；linked 那条连问都不问 ──────────
    const asked = [];
    await page.evaluate(`window.__realConfirm = window.confirm; window.__asked = [];
      window.confirm = text => { window.__asked.push(text); return false; }`);
    await page.evaluate(`${sessionRowAction(LINKED_ID)}.click()`);
    assert.equal(await page.evaluate(`window.__asked.length`), 0, 'linked 那条连问都不问（按钮是禁用的，点了什么也不该发生）');
    assert.equal(deletes().length, 0, 'linked 那条点下去不许发请求');
    await page.evaluate(`${sessionRowAction(FREE_ID)}.click()`);
    assert.equal(deletes().length, 0, '答「否」时不许发删除请求');
    assert.deepEqual(await page.evaluate(`window.__asked`),
      [`${await i18n('airResourcesDeleteTitle', { id: FREE_ID })}\n\n${await i18n('airResourcesDeleteBody')}`],
      '问的那句带着会话 id 和「不可撤销」');

    await page.evaluate(`window.confirm = text => { window.__asked.push(text); return true; }`);
    await page.evaluate(`${sessionRowAction(FREE_ID)}.click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-resources-history-list .air-resources-row').length===1`), '答「是」之后列表少一条');
    const deleted = deletes();
    assert.equal(deleted.length, 1, '只发了这一条删除');
    assert.equal(deleted[0].path, deleteOnePath, 'project 与 id 两段都进了路径且都编码过（原样的 % 会变成 %25）');
    assert.equal(deleted[0].path.includes(FREE_PROJECT), false, '目录名不是原样拼进去的');
    assert.deepEqual(calls().slice(-3),
      ['DELETE ' + deleteOnePath, 'GET /api/agent-resources/skills', 'GET /api/agent-resources/claude-sessions'],
      '删完重新拉一遍两份列表');
    assert.equal(await text('#air-resources-history-status'), await i18n('airResourcesDeletedOne', { id: FREE_ID, size: '2.0 KB' }),
      '状态行说清删了哪条、释放了多少');
    assert.equal(await text('#notice'), await i18n('airResourcesDeletedOne', { id: FREE_ID, size: '2.0 KB' }), '右下角同样说一声');
    assert.equal(await text('#air-resources-history-count'), await i18n('airResourcesHistorySummary', { n: 1, size: '4.0 KB', protected: 1 }),
      '抬头跟着新列表走');
    await page.screenshot('02-resources-after-delete');

    // ── ⑦ Clean Old：按选中的档位打，删完把条数与释放量写进状态行 ───────────
    await page.evaluate(`(() => {
      const age = document.getElementById('air-resources-history-age');
      age.value = '180';
      age.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.evaluate(`window.__asked = []`);
    await page.evaluate(`document.getElementById('air-resources-history-clean').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-resources-history-status').textContent === ${JSON.stringify(await i18n('airResourcesCleanDone', { n: 3, size: '1.00 MB' }))}`),
      '清理完把「删了几条 / 释放了多少」写进状态行');
    const bulk = deletes().filter(r => r.path === '/api/agent-resources/claude-sessions');
    assert.equal(bulk.length, 1, '批量清理打的是不带 project/id 的那条删除');
    assert.equal(bulk[0].url.includes('olderThanDays=180'), true, '档位跟着下拉走（不是写死的 30）');
    assert.deepEqual(cleanQueries, ['180'], '服务端收到的是 180');
    assert.deepEqual(await page.evaluate(`window.__asked`),
      [`${await i18n('airResourcesCleanTitle', { days: 180 })}\n\n${await i18n('airResourcesDeleteBody')}`],
      '批量清理也先问一句，问句里带着档位');
    await page.evaluate(`window.confirm = window.__realConfirm`);

    // ── ⑧ 窄屏：一行放不下就换行，别把删除键挤出卡片 ──────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=resources');
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-resources-skills-list .air-resources-row').length===3`), '窄屏上列表照样渲染');
    const narrow = await page.evaluate(`(() => {
      const row = document.querySelector('#air-resources-skills-list .air-resources-row');
      const box = row.getBoundingClientRect();
      const toolbar = document.querySelector('#air-resources-history-list').previousElementSibling.getBoundingClientRect();
      const button = document.querySelector('#air-resources-history-clean').getBoundingClientRect();
      return { wrap: getComputedStyle(row).flexWrap, cardRight: Math.round(box.right), toolbarRight: Math.round(toolbar.right), buttonRight: Math.round(button.right) };
    })()`);
    assert.equal(narrow.wrap, 'wrap', '窄屏上每行允许换行');
    assert.ok(narrow.buttonRight <= narrow.toolbarRight + 1, `工具条里的按钮不许溢出（${narrow.buttonRight} vs ${narrow.toolbarRight}）`);
    await page.screenshot('03-resources-native-mobile');
  });
});
