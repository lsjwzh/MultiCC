'use strict';

// 目录首页那颗「定时任务」入口，和它弹出的那一层（public/air-dir-schedules.js），在
// 真浏览器里跑一遍。三件事只有真跑才看得见：
//   ① 它是**页内弹层**（`<dialog>.showModal()`，进 top layer），不是新页面；
//   ② 它列的是「这个目录自己的规则」—— 只是按地址栏里的 ?dir= 过滤 GET /api/cron，
//      所以核心断言是「d2 那条不许出现」，而不是列表长度；
//   ③ 新建 / 编辑借的是 air.js 那个唯一编辑器（#schedule-dialog）：隐藏 id 有值就
//      PATCH、空着就 POST —— 这一层自己不拼第二个表单、也不自己发第二次请求。
//
// 排版那半（手机上从底部升起、工具条三颗入口换行平分）在同文件第二篇 test 里量，
// 因为那要换视口重开一次页面。
//
// 默认语言是 zh（i18n.js 的 getLang() 取 localStorage 里的 multicc_lang，缺省 'zh'），
// 所以这里断言的是界面上的中文 —— 顺带把「文案真的接上了 i18n」也钉住。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const DIRECTORIES = [
  { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' },
  { id: 'd2', name: '库存同步', path: '/projects/stock' },
  { id: 'd3', name: '空目录', path: '/projects/empty' },
];

const rule = over => ({
  id: 'c1', name: '每日投放数据', dirId: 'd1', dirName: 'MultiCC 主仓',
  cli: 'claude', model: 'claude-sonnet-5', effort: 'high',
  cron: '0 9 * * *', prompt: '整理昨天的投放数据并归档。', enabled: true,
  nextRunAt: '2026-09-28T01:00:00.000Z', lastRunAt: '2026-09-27T01:00:00.000Z',
  lastStatus: 'ok', lastError: '', runCount: 3,
  taskId: 't1', taskTitle: '每日投放数据', taskBindingError: '',
  recentRuns: [{ at: '2026-09-27T01:00:00.000Z', reason: 'schedule', status: 'ok', error: '' }],
  ...over,
});

// 一份够用的小服务端：GET /api/cron 是这一层唯一的取数口，PATCH / DELETE / run 都
// 改这份数组，于是「点完之后列表自己刷新成什么」也是真刷出来的。
function buildRoutes() {
  const routes = {}, root = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const folder of ['', 'shared']) {
    for (const file of fs.readdirSync(path.join(root, folder)).filter(f => /\.(js|css|html)$/.test(f))) {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      routes['/' + (folder ? folder + '/' : '') + file] = { body: fs.readFileSync(path.join(root, folder, file)), headers: { 'content-type': type } };
    }
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  // clis 是服务端的 SUPPORTED_CHAT_CLIS（src/cli-switch.js）：既有 chat 车道
  // （claude-exp / codex-exp），也有那两条 offered:false 的一次性车道。定时规则跑的是
  // chat，所以新建时的线路选择按共享 CLI 目录筛过之后剩下的正是前两条。
  routes['/api/air'] = () => json({ ok: true, directories: DIRECTORIES, clis: ['claude', 'claude-exp', 'codex', 'codex-exp'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/providers'] = () => json({ available: false, providers: [], defaults: {} });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/aux/config'] = () => json({ providerId: 'configured' });
  routes['/api/docs-registry'] = () => json([]);

  const rules = [
    rule({}),
    rule({ id: 'c2', name: '每周复盘', dirId: 'd2', dirName: '库存同步', cron: '0 9 * * 1', taskId: 't2', taskTitle: '每周复盘' }),
    // 绑定坏了（固定任务被归档）：卡片上该多一颗「重新绑定」，且默认是停用态。
    rule({ id: 'c3', name: '坏掉的规则', cron: '*/30 * * * *', enabled: false, taskId: null, taskTitle: '', taskBindingError: '固定任务已被归档', lastStatus: 'error', lastError: '固定任务已被归档', runCount: 0, recentRuns: [] }),
  ];
  routes['/api/cron'] = () => json(rules);
  routes['POST /api/cron'] = ({ body }) => {
    const draft = JSON.parse(body);
    const created = rule({ ...draft, id: 'c9', name: draft.name, cron: draft.cron, prompt: draft.prompt, enabled: draft.enabled, dirName: 'MultiCC 主仓', taskId: 't9', taskTitle: draft.name, runCount: 0, recentRuns: [] });
    rules.push(created);
    return json(created);
  };
  routes['PATCH /api/cron/c1'] = ({ body }) => {
    Object.assign(rules[0], JSON.parse(body));
    return json(rules[0]);
  };
  routes['POST /api/cron/c1/run'] = () => json({ ok: true, decision: 'sent' });
  routes['POST /api/cron/c3/rebind'] = () => json({ ok: true, taskId: 't9' });
  routes['DELETE /api/cron/c3'] = () => { rules.splice(2, 1); return json({ ok: true }); };
  return { routes, rules };
}

// 点一颗元素：先滚进视野（弹层里的清单自己是滚动的），再在正中按一下真鼠标 ——
// 弹层在 top layer 上，程序化 .click() 不验证「按得到」，鼠标事件才验证。
const aim = expr => `(() => {
  const el = ${expr};
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;
async function click(page, expr) {
  const point = await page.evaluate(aim(expr));
  assert.ok(point, `找不到可点的元素：${expr}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}
const card = index => `[...document.querySelectorAll('#dir-schedule-list .schedule-card')][${index}]`;
// 按文案找按钮，不按下标：绑定坏掉的卡片会多一颗「重新绑定」，下标会跟着变。
const cardAction = (index, label) => `[...${card(index)}.querySelectorAll('.schedule-actions button')].find(b => b.textContent.includes(${JSON.stringify(label)}))`;
const cardsInfo = `[...document.querySelectorAll('#dir-schedule-list .schedule-card')].map(row => ({
  name: row.querySelector('h3').textContent,
  badge: row.querySelector('.schedule-badge').textContent,
  cron: row.querySelector('.schedule-timing code').textContent,
  broken: row.querySelector('.schedule-fixed-task').classList.contains('broken'),
  fixed: row.querySelector('.schedule-fixed-task small:last-child').textContent,
  actions: [...row.querySelectorAll('.schedule-actions button')].map(b => b.textContent),
  state: row.querySelector('.schedule-state span').textContent,
}))`;
const requestsOf = (page, method, path) => page.requests.filter(r => r.method === method && r.path === path);

test('the directory home opens its own scheduled rules in an in-page sheet', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const { routes } = buildRoutes();
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-dir-schedules') }, async page => {
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-schedules')?.hidden === false`));

    // 入口在工具条最右、紧挨着「本目录产物」，说的清自己是干什么的。
    assert.deepEqual(await page.evaluate(`(() => {
      const entry = document.getElementById('directory-schedules');
      const previous = entry.previousElementSibling;
      const bar = document.querySelector('.directory-toolbar').getBoundingClientRect();
      return { afterArtifacts: previous?.id === 'directory-artifacts', label: entry.textContent.trim(),
        title: entry.title, right: Math.round(bar.right - entry.getBoundingClientRect().right) };
    })()`), { afterArtifacts: true, label: '⏰ 定时任务', title: '查看本目录的定时任务', right: 0 },
    '入口接在「本目录产物」后面，贴住工具条右边界');

    // 点开就是页内弹层：真 modal（top layer），标题带目录名。
    await click(page, `document.getElementById('directory-schedules')`);
    assert.ok(await page.waitFor(`document.getElementById('dir-schedule-dialog')?.open === true`));
    assert.equal(await page.evaluate(`document.getElementById('dir-schedule-dialog').matches(':modal')`), true, '是 top layer 上的 modal，不是普通浮层');
    // 它不开新页：地址原地不动，air.js 那套中心也不在屏幕上。
    assert.equal(await page.evaluate(`location.pathname + location.search`), '/air?dir=d1');
    assert.equal(await page.evaluate(`document.getElementById('schedule-center').hidden`), true, '这不是定时任务中心那页');
    await page.screenshot('sheet-open.png');

    // 只列 d1 的规则：d2 那条连名字都不许出现（服务端照旧把整张表发回来）。
    assert.ok(await page.waitFor(`document.querySelectorAll('#dir-schedule-list .schedule-card').length === 2`),
      JSON.stringify({ body: await page.evaluate(`document.querySelector('#dir-schedule-list')?.innerText?.slice(0, 300)`) }));
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.dir-schedule-head h2')].map(h => h.textContent)`), ['MultiCC 主仓 的定时任务']);
    const cards = await page.evaluate(cardsInfo);
    assert.deepEqual(cards.map(row => row.name), ['每日投放数据', '坏掉的规则'], '服务端给的顺序照搬，且只有本目录的');
    assert.equal(await page.evaluate(`document.getElementById('dir-schedule-list').textContent.includes('每周复盘')`), false, '别的目录的规则不进这一层');
    assert.deepEqual(cards.map(row => row.badge), ['已启用', '已停用']);
    assert.deepEqual(cards.map(row => row.cron), ['0 9 * * *', '*/30 * * * *']);
    assert.equal(cards[0].broken, false, '绑定好的规则不是坏的那张脸');
    assert.equal(cards[1].broken, true, '绑定坏掉的规则是坏的那张脸');
    // 固定任务那行的小字：任务 id + 运行配置，车道名走共享 CLI 目录（规则里存的是
    // `claude`，屏幕上叫 Claude）。
    assert.equal(cards[0].fixed, 't1 · Claude · claude-sonnet-5 · high');
    assert.deepEqual(cards[0].actions, ['▶ 立即运行', '暂停', '编辑规则', '删除规则'], '绑定好的规则不给「重新绑定」');
    assert.ok(cards[1].actions.includes('⛑ 重新绑定固定任务') && cards[1].actions.includes('启用'), JSON.stringify(cards[1].actions));
    assert.equal(cards[0].state, '最近一次已接收');
    assert.equal(cards[1].state, '固定任务已被归档', '失败原因直接摆出来，不吞成一句「失败」');
    // 统计口径与 air.js 的 renderSchedules 同源：条数 / 启用 / 需要处理。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#dir-schedule-summary span')].map(s => s.textContent)`),
      ['2 条规则', '1 条启用', '1 条需处理']);

    // ▶ 立即运行：POST 那条 run，然后把结果说出来（刷新不能把这句话刷掉）。
    // 先等界面把话说出来，再数请求 —— 请求是在测试进程里同步收到的，界面等得到、立刻
    // 数请求数不到（那是这场比赛，不是产品行为）。
    await click(page, cardAction(0, '立即运行'));
    assert.ok(await page.waitFor(`document.getElementById('dir-schedule-status').textContent === '执行指令已经送入固定 Air 任务。'`),
      JSON.stringify({ status: await page.evaluate(`document.getElementById('dir-schedule-status').textContent`) }));
    assert.ok(await page.waitFor(`document.getElementById('dir-schedule-status').className.includes('ok')`));
    assert.equal(requestsOf(page, 'POST', '/api/cron/c1/run').length, 1);

    // 暂停：PATCH 只带 enabled，刷新后徽标与那颗按钮都跟着翻面。
    await click(page, cardAction(0, '暂停'));
    assert.ok(await page.waitFor(`document.querySelectorAll('#dir-schedule-list .schedule-card')[0].querySelector('.schedule-badge').textContent === '已停用'`));
    const patch = requestsOf(page, 'PATCH', '/api/cron/c1');
    assert.equal(patch.length, 1);
    assert.deepEqual(JSON.parse(patch[0].body), { enabled: false }, '暂停只发 enabled 一个字段');
    assert.ok((await page.evaluate(cardsInfo))[0].actions.includes('启用'), '停用之后那颗按钮变成「启用」');
    await page.screenshot('sheet-actions.png');

    // 编辑规则：借 air.js 那个唯一编辑器 —— 表单里带着这条规则的 id（保存时会 PATCH），
    // 目录与 CLI 归固定任务所有，所以是灰的。
    await click(page, cardAction(0, '编辑规则'));
    assert.ok(await page.waitFor(`document.getElementById('schedule-dialog')?.open === true`), 'air.js 的编辑器被叫起来了');
    assert.deepEqual(await page.evaluate(`(() => { const form = document.getElementById('schedule-form');
      return { id: form.elements.id.value, name: form.elements.name.value, cron: form.elements.cron.value,
        prompt: form.elements.prompt.value, enabled: form.elements.enabled.checked,
        dirId: form.elements.dirId.value, dirLocked: form.elements.dirId.disabled, cliLocked: form.elements.cli.disabled,
        note: !document.getElementById('schedule-fixed-note').hidden,
        title: document.getElementById('schedule-dialog-title').textContent, save: document.getElementById('schedule-save').textContent }; })()`),
    { id: 'c1', name: '每日投放数据', cron: '0 9 * * *', prompt: '整理昨天的投放数据并归档。', enabled: false,
      dirId: 'd1', dirLocked: true, cliLocked: true, note: true, title: '编辑定时规则', save: '保存规则' },
    '编辑态：字段摆的是这条规则自己的值，目录/CLI 归固定任务所以锁住');
    await page.evaluate(`(() => { const form = document.getElementById('schedule-form');
      form.elements.name.value = '每日投放数据 v2'; form.elements.cron.value = '0 10 * * *'; })()`);
    await page.evaluate(`document.getElementById('schedule-save').click()`);
    assert.ok(await page.waitFor(`document.getElementById('schedule-dialog').open === false`));
    const edits = requestsOf(page, 'PATCH', '/api/cron/c1');
    assert.equal(edits.length, 2, '编辑走的是同一颗 PATCH，不再是 POST');
    // kind 跟着一起发（大模型任务 ↔ 脚本任务是可以改的），其余照旧：dirId / cli 属于那个
    // 固定任务，改规则时不发。
    assert.deepEqual(JSON.parse(edits[1].body), { name: '每日投放数据 v2', cron: '0 10 * * *', prompt: '整理昨天的投放数据并归档。', enabled: false, kind: 'agent' },
      '改规则时 PATCH 不带 dirId / cli（那属于固定任务）');
    assert.equal(requestsOf(page, 'POST', '/api/cron').length, 0, '编辑没有顺手 POST 一条新的');
    // 编辑器一关，这一层自己重读：新名字直接出现在卡片上。
    assert.ok(await page.waitFor(`document.querySelectorAll('#dir-schedule-list .schedule-card')[0].querySelector('h3').textContent === '每日投放数据 v2'`));
    await page.screenshot('editor-from-sheet.png');

    // 新建：同一条编辑器，空 id 就是新建态，目录预选当前目录（POST 带上 dirId）。
    await click(page, `document.getElementById('dir-schedule-create')`);
    assert.ok(await page.waitFor(`document.getElementById('schedule-dialog')?.open === true`));
    assert.deepEqual(await page.evaluate(`(() => { const form = document.getElementById('schedule-form');
      return { id: form.elements.id.value, dirId: form.elements.dirId.value, title: document.getElementById('schedule-dialog-title').textContent,
        save: document.getElementById('schedule-save').textContent }; })()`),
    { id: '', dirId: 'd1', title: '新建定时任务', save: '创建并绑定任务' }, '新建态：id 空着，目录预选当前目录');
    await page.evaluate(`(() => { const form = document.getElementById('schedule-form');
      form.elements.name.value = '早间巡检'; form.elements.cron.value = '0 7 * * *'; form.elements.prompt.value = '看一眼夜里跑失败的活。'; })()`);
    await page.evaluate(`document.getElementById('schedule-save').click()`);
    assert.ok(await page.waitFor(`document.getElementById('schedule-dialog').open === false`), JSON.stringify({
      error: await page.evaluate(`document.getElementById('schedule-error').textContent`),
      invalid: await page.evaluate(`(() => { const f = document.getElementById('schedule-form');
        return [...f.elements].filter(e => e.willValidate && !e.checkValidity()).map(e => e.name); })()`),
      cron: page.requests.filter(r => r.path.startsWith('/api/cron')).map(r => `${r.method} ${r.path}`),
    }));
    const created = requestsOf(page, 'POST', '/api/cron');
    assert.equal(created.length, 1);
    const draft = JSON.parse(created[0].body);
    assert.equal(draft.dirId, 'd1', '新建落在当前目录');
    assert.ok(['claude-exp', 'codex-exp'].includes(draft.cli), `新建只给 chat 车道，默认第一条：${JSON.stringify(draft)}`);
    assert.ok(draft.cron === '0 7 * * *' && draft.name === '早间巡检' && draft.enabled === true, JSON.stringify(draft));
    assert.ok(await page.waitFor(`document.querySelectorAll('#dir-schedule-list .schedule-card').length === 3`), '新建的规则出现在这一层（它自己重读）');
    await page.screenshot('sheet-after-create.png');

    // 「全部定时任务 ›」= 点侧栏那一行，不复刻它的逻辑：地址切到 view=schedules，目录留着。
    await click(page, `document.getElementById('dir-schedule-center')`);
    assert.ok(await page.waitFor(`new URLSearchParams(location.search).get('view') === 'schedules'`));
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('dir')`), 'd1', '去中心也带着目录');
    assert.equal(await page.evaluate(`document.getElementById('schedule-center').hidden`), false, '落在定时任务中心上');
    assert.equal(await page.evaluate(`document.getElementById('dir-schedule-dialog').open`), false, '切走时弹层自己收起');

    // 卡片上的「固定 Air 任务」照样能跳进那条任务（地址与 air.js 自己那条路一致）。
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-schedules')?.hidden === false`));
    await click(page, `document.getElementById('directory-schedules')`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#dir-schedule-list .schedule-card').length === 3`));
    await click(page, `${card(0)}.querySelector('.schedule-fixed-task')`);
    assert.ok(await page.waitFor(`new URLSearchParams(location.search).get('task') === 't1'`), '进那条固定任务');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('dir')`), 'd1');
    assert.equal(await page.evaluate(`document.getElementById('dir-schedule-dialog').open`), false, '跳走时弹层收起');

    // 空目录：一句话，不留白（入口仍在，因为目录还在）。
    await page.navigate('/air?dir=d3');
    assert.ok(await page.waitFor(`document.getElementById('directory-schedules')?.hidden === false`));
    await click(page, `document.getElementById('directory-schedules')`);
    assert.ok(await page.waitFor(`document.querySelector('#dir-schedule-list .schedule-empty') !== null`));
    assert.equal(await page.evaluate(`document.querySelector('#dir-schedule-list .schedule-empty strong').textContent`), '这个目录还没有定时任务');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#dir-schedule-summary span')].map(s => s.textContent)`), ['0 条规则', '0 条启用', '固定任务均正常']);
    await page.screenshot('sheet-empty.png');

    // 可见性跟着「备忘」走：目录库（不是某个目录的首页）那一页没有这颗入口，弹层也不
    // 能留在屏幕上 —— 它的入口已经不在那儿了。这里用后退切过去（同一个目录再点一次
    // 「工作目录」是 navigate 回本页，不换视图）：那是用户真会走的一步，也是唯一会在
    // 不重载页面的情况下把它收起来的一步。
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-schedules')?.hidden === false`));
    await click(page, `document.getElementById('directory-schedules')`);
    assert.ok(await page.waitFor(`document.getElementById('dir-schedule-dialog')?.open === true`));
    await page.evaluate(`(() => { history.pushState({}, '', '/air?view=directories'); dispatchEvent(new PopStateEvent('popstate')); })()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-schedules').hidden === true`), '目录库那一页没有这颗入口');
    assert.equal(await page.evaluate(`document.getElementById('dir-schedule-dialog').open`), false, '入口一收，弹层跟着关');
    // 首次就落在目录库那一页时，挂载那一刻它就该是收着的（不是等谁来推一把）。
    await page.navigate('/air?view=directories');
    assert.ok(await page.waitFor(`document.getElementById('directory-schedules')?.hidden === true`), '直接落在目录库时同样不显示');
  });
});

test('on a phone the sheet rises from the bottom and the toolbar wraps', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const { routes } = buildRoutes();
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-dir-schedules-mobile') }, async page => {
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-schedules')?.hidden === false`));

    // 工具条换行：切换器独占一行，三颗入口在第二行平分，谁都不越出容器（也不横滚）。
    const bar = await page.evaluate(`(() => {
      const bar = document.querySelector('.directory-toolbar');
      const box = bar.getBoundingClientRect();
      const of = id => document.getElementById(id).getBoundingClientRect();
      const mode = document.getElementById('directory-mode').getBoundingClientRect();
      const rows = ['directory-memo', 'directory-artifacts', 'directory-schedules'].map(of);
      const widths = rows.map(r => r.width);
      return { overflow: Math.round(document.documentElement.scrollWidth - window.innerWidth),
        wrapped: mode.bottom <= rows[0].top + 1,
        width: Math.round(bar.scrollWidth - bar.clientWidth),
        inside: rows.every(r => r.left >= box.left - 1 && r.right <= box.right + 1),
        equal: Math.max(...widths) - Math.min(...widths) <= 1,
        thirds: widths.every(w => Math.abs(w - (box.width - 16) / 3) <= 2),
        h: Math.round(rows[0].height), barW: Math.round(box.width) };
    })()`);
    assert.equal(bar.overflow, 0, `页面不横滚：${JSON.stringify(bar)}`);
    assert.equal(bar.width, 0, `工具条自己不横滚：${JSON.stringify(bar)}`);
    assert.equal(bar.wrapped, true, `切换器独占一行：${JSON.stringify(bar)}`);
    assert.equal(bar.inside, true, `三颗入口都在工具条里：${JSON.stringify(bar)}`);
    assert.equal(bar.equal, true, `三颗一样宽：${JSON.stringify(bar)}`);
    assert.equal(bar.thirds, true, `每颗各占这一行的三分之一（两个 gap 之外）：${JSON.stringify(bar)}`);
    await page.screenshot('mobile-entry.png');

    // 弹层从底部升起：左右贴边、贴着屏幕下沿、上面两角圆、个头不超过 88dvh。
    await click(page, `document.getElementById('directory-schedules')`);
    assert.ok(await page.waitFor(`document.getElementById('dir-schedule-dialog')?.open === true`));
    await page.evaluate(`new Promise(done => setTimeout(done, 60))`);
    const sheet = await page.evaluate(`(() => {
      const el = document.getElementById('dir-schedule-dialog');
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const head = document.querySelector('.dir-schedule-head').getBoundingClientRect();
      const foot = document.querySelector('.dir-schedule-foot').getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width), bottom: Math.round(window.innerHeight - r.bottom),
        top: Math.round(r.top), radius: style.borderTopLeftRadius + ' ' + style.borderBottomLeftRadius,
        vh: Math.round(window.innerHeight), headInside: head.left >= r.left - 1 && head.right <= r.right + 1,
        footInside: foot.left >= r.left - 1 && foot.right <= r.right + 1,
        scrolls: document.getElementById('dir-schedule-list').scrollHeight > document.getElementById('dir-schedule-list').clientHeight };
    })()`);
    assert.deepEqual([sheet.left, sheet.bottom], [0, 0], `左右贴边、贴住下沿：${JSON.stringify(sheet)}`);
    assert.equal(sheet.width, 390, `占满宽度：${JSON.stringify(sheet)}`);
    assert.ok(sheet.top > sheet.vh * 0.1, `确实是一条从底部升起来的层，不是盖满屏：${JSON.stringify(sheet)}`);
    assert.match(sheet.radius, /^22px 0px$/, `只留上面两角：${JSON.stringify(sheet)}`);
    assert.equal(sheet.headInside && sheet.footInside, true, `头尾都不出框：${JSON.stringify(sheet)}`);
    assert.equal(sheet.scrolls, true, '手机上清单自己滚（底部那两颗按钮始终够得着）');
    await page.screenshot('mobile-sheet.png');
  });
});
