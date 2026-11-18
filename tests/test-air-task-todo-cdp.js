'use strict';
// 两套口径 + 一颗按钮：
//   「等我处理」（needs）= 等待用户输入、出错、执行成功但需要交互、手动标记的汇总，
//     排除归档与被忽略的；
//   「待办」（todo）= 只列用户手动标记的。
// 行尾/页头/首页卡片同一位置只放一颗按钮，随状态换：忽略异常 / 忽略等待 / 标记达成 /
// 取消忽略（并显示「已忽略」小标）/ 取消待办 / 标记为待办。优先级：
// 已忽略 > 手动待办 > 随状态的动作 > 标记为待办。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

function fixtureRoutes() {
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url` };
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  return routes;
}

const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const failure = (status, code) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, code }) });

test('needs-me and manual-to-do stay separate, and one state-driven action replaces ignore+todo', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = fixtureRoutes();
  const directories = [{ id: 'd1', name: 'Gapasea', path: '/projects/gapasea' }];
  const now = Date.now();
  const task = (id, title, extra) => ({ id, dirId: 'd1', title, status: 'active',
    updatedAt: now - id.length, lastMessageAt: now - id.length,
    resource: { residency: 'planned', lease: 'idle' }, ...extra });
  const tasks = [
    task('tsk-run', '正在跑的活', { runState: 'running' }),
    task('tsk-wait', '等人回答的活', { runState: 'waiting' }),
    task('tsk-err', '炸了的活', { runState: 'error' }),
    task('tsk-interact', '跑完要我确认的活', { runState: 'succeeded', goalState: 'interact' }),
    task('tsk-interact2', '另一个要确认的活', { runState: 'succeeded', goalState: 'interact' }),
    task('tsk-achieved', '达成目标的活', { runState: 'succeeded', goalState: 'achieved' }),
    task('tsk-marked', '手动标的活', { runState: 'idle' }),
    task('tsk-manual-err', '手动标的出错活', { runState: 'error' }),
    task('tsk-idle', '空闲的活', { runState: 'idle' }),
    task('tsk-archived', '归档了的等待', { status: 'archived', runState: 'waiting' }),
  ];
  let todos = ['tsk-marked', 'tsk-manual-err'];
  let ignores = [];
  const toggles = [], ignoreCalls = [], achievedCalls = [];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [],
    taskTodos: todos, taskTodoIgnored: ignores });
  routes['/api/air/todos/toggle'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    toggles.push(taskId);
    todos = todos.includes(taskId) ? todos.filter(id => id !== taskId) : [...todos, taskId];
    return json({ ok: true, taskIds: todos });
  };
  // 忽略与手动待办互不排斥：忽略只改 taskTodoIgnored，不动 todos。
  routes['POST /api/air/todos/ignore'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    ignoreCalls.push(taskId);
    if (taskId === 'tsk-idle') return failure(400, 'todo_ignore_not_applicable');
    const on = !ignores.includes(taskId);
    ignores = on ? [...ignores, taskId] : ignores.filter(id => id !== taskId);
    return json({ ok: true, ignored: on, kind: on ? 'error' : null, taskIds: ignores, todos });
  };
  routes['POST /api/air/tasks/mark-achieved'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    achievedCalls.push(taskId);
    const target = tasks.find(entry => entry.id === taskId);
    if (!target || target.goalState !== 'interact') return failure(409, 'mark_achieved_not_applicable');
    target.goalState = 'achieved';
    return json({ ok: true, taskId, goalState: 'achieved' });
  };

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-todo-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    // 每次整页导航都会换掉 window，错误钩子要跟着重装，离开前先查一遍。
    const watchErrors = () => page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    const noErrors = async () => assert.deepEqual(await page.evaluate('window.__errors'), []);
    await page.navigate('/air?dir=d1');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length > 0`));
    const titles = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent).sort()`);
    const ordered = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent)`);
    const pick = value => page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value=${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
    const rowAction = title => page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === ${JSON.stringify(title)});
      return row ? row.querySelector('.task-todo').textContent : null;
    })()`);
    const clickRowAction = title => page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === ${JSON.stringify(title)});
      row.querySelector('.task-todo').click();
    })()`);
    const rowState = title => page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === ${JSON.stringify(title)});
      return { action: row.querySelector('.task-todo').textContent,
        badge: row.querySelector('.task-ignored-badge')?.textContent || '' };
    })()`);

    // ── 下拉：等我处理、待办并列；「已忽略」不再是一档 ────────────────────
    const options = await page.evaluate(`[...document.getElementById('directory-task-status').options].map(o => [o.value, o.textContent])`);
    assert.deepEqual(options.slice(0, 2), [['needs', '等我处理'], ['todo', '待办']]);
    assert.equal(options.some(([value]) => value === 'ignored'), false, '已忽略不再单独一档');
    assert.equal(options.some(([value]) => value === 'waiting'), false, '等待回复仍并入等我处理');

    // ── 全部记录：每行只有一颗按钮，名字随状态 ───────────────────────────
    await pick('all');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===10`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list .directory-task-row .task-todo').length`), 10,
      '每行一颗动词按钮');
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list .task-ignore').length`), 0, '旧的第二颗忽略按钮已退场');
    assert.deepEqual(await Promise.all([
      rowAction('正在跑的活'), rowAction('等人回答的活'), rowAction('炸了的活'), rowAction('跑完要我确认的活'),
      rowAction('达成目标的活'), rowAction('手动标的活'), rowAction('手动标的出错活'), rowAction('空闲的活'),
    ]), ['标记为待办', '忽略等待', '忽略异常', '标记达成', '标记为待办', '取消待办', '取消待办', '标记为待办'],
    '状态决定唯一那颗按钮；手动待办优先于出错状态');

    // ── 「等我处理」= 汇总口径：系统三类 + 手动标记，排除归档与在跑 ─────
    await pick('needs');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===6`));
    assert.deepEqual(await ordered(), ['手动标的出错活', '另一个要确认的活', '跑完要我确认的活', '手动标的活', '等人回答的活', '炸了的活'],
      '等我处理默认按最早的消息排在前面');
    assert.equal((await titles()).includes('归档了的等待'), false, '归档的不算');
    assert.equal((await titles()).includes('正在跑的活'), false, '在跑的不算');

    // ── 「待办」= 只有手动标记的，不含系统判出来的 ──────────────────────
    await pick('todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));
    assert.deepEqual(await titles(), ['手动标的出错活', '手动标的活'], '待办只含手动清单');

    // 在「全部记录」里标记空闲任务：只进待办，不改变「等我处理」之外的判定。
    await pick('all');
    await clickRowAction('空闲的活');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .task-todo[aria-pressed="true"]').length===3`));
    assert.deepEqual(toggles, ['tsk-idle']);
    await pick('todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===3`));
    assert.ok(await page.waitFor(`document.querySelector('#directory-task-list')?.textContent.includes('空闲的活')`));
    assert.ok((await titles()).includes('空闲的活'));
    await pick('all');
    await clickRowAction('空闲的活');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .task-todo[aria-pressed="true"]').length===2`));
    assert.deepEqual(toggles, ['tsk-idle', 'tsk-idle']);
    await pick('todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));

    // ── 不适用的动作走统一的错误文案 ────────────────────────────────────
    await page.evaluate(`window.MultiCCAirTaskTodo.toggleIgnore('tsk-idle')`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('当前状态下不能执行这个操作')`),
      '非 error/waiting 的忽略返回 todo_ignore_not_applicable 文案');
    await page.evaluate(`window.MultiCCAirTaskTodo.markAchieved('tsk-idle')`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('当前状态下不能执行这个操作')`),
      '不适用标记达成返回 mark_achieved_not_applicable 文案');

    // ── 忽略异常：退出等我处理，但仍留在异常清单里（带「已忽略」小标）────
    await pick('needs');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===6`));
    await clickRowAction('炸了的活');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===5`));
    assert.deepEqual(ignoreCalls.slice(-1), ['tsk-err']);
    assert.deepEqual(ignores, ['tsk-err']);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('已忽略')`), '忽略提示不被刷新清掉');
    assert.equal((await titles()).includes('炸了的活'), false, '被忽略的不在等我处理里');
    await pick('error');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));
    assert.deepEqual(await titles(), ['手动标的出错活', '炸了的活']);
    assert.deepEqual(await rowState('炸了的活'), { action: '取消忽略', badge: '已忽略' }, '被忽略的异常仍可取消忽略');
    assert.deepEqual(await rowState('手动标的出错活'), { action: '取消待办', badge: '' }, '手动待办优先于出错状态');
    await page.screenshot('directory-ignored-error.png');
    // 就地取消忽略：异常计数不变，它重新回到等我处理。
    await clickRowAction('炸了的活');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('已取消忽略')`));
    assert.deepEqual(ignores, []);
    await pick('needs');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===6 && [...document.querySelectorAll('#directory-task-list .directory-task-row strong')].some(el => el.textContent === '炸了的活')`));
    assert.ok((await titles()).includes('炸了的活'), '取消忽略后回到等我处理');

    // ── 忽略等待 + 从全部记录里取回 ─────────────────────────────────────
    await clickRowAction('等人回答的活');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===5`));
    assert.deepEqual(ignoreCalls.slice(-1), ['tsk-wait']);
    await pick('all');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===10`));
    assert.equal(await rowAction('等人回答的活'), '取消忽略');
    await clickRowAction('等人回答的活');
    assert.ok(await page.waitFor(`window.MultiCCAirTaskTodo.isIgnored('tsk-wait')===false`));
    assert.deepEqual(ignores, []);

    // ── 标记达成：任务自动离开等我处理 ──────────────────────────────────
    await pick('needs');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===6`));
    await clickRowAction('跑完要我确认的活');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===5`));
    assert.deepEqual(achievedCalls.slice(-1), ['tsk-interact']);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('已标记为达成目标')`));
    assert.equal((await titles()).includes('跑完要我确认的活'), false, '标记达成后离开等我处理');
    await pick('all');
    assert.equal(await rowAction('跑完要我确认的活'), '标记为待办', '达成之后的按钮回到普通待办开关');

    // ── 任务详情页头：同一颗按钮，随任务状态换 ──────────────────────────
    await noErrors();
    await page.navigate('/air?dir=d1&task=tsk-idle');
    await watchErrors();
    const header = () => page.evaluate(`(() => { const b=document.getElementById('todo-task');
      return [b.hidden, b.querySelector('.air-tool-name').textContent, b.querySelector('.air-tool-icon').textContent,
        b.getAttribute('aria-pressed'), document.getElementById('ignore-task')===null]; })()`);
    assert.ok(await page.waitFor(`document.getElementById('todo-task') && !document.getElementById('todo-task').hidden`));
    assert.deepEqual(await header(), [false, '标记为待办', '🚩', 'false', true], '页头也只有一颗按钮');
    await page.evaluate(`document.getElementById('todo-task').click()`);
    assert.ok(await page.waitFor(`document.getElementById('todo-task').getAttribute('aria-pressed')==='true'`));
    assert.deepEqual((await header()).slice(1, 4), ['取消待办', '🚩', 'true']);
    await page.evaluate(`document.getElementById('todo-task').click()`);
    assert.ok(await page.waitFor(`document.getElementById('todo-task').getAttribute('aria-pressed')==='false'`));

    await page.navigate('/air?dir=d1&task=tsk-err');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelector('#todo-task .air-tool-name')?.textContent==='忽略异常'`));
    await page.evaluate(`document.getElementById('todo-task').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#todo-task .air-tool-name')?.textContent==='取消忽略'`));
    assert.equal(await page.evaluate(`document.getElementById('todo-task').getAttribute('aria-pressed')`), 'true');
    await page.evaluate(`document.getElementById('todo-task').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#todo-task .air-tool-name')?.textContent==='忽略异常'`));

    await page.navigate('/air?dir=d1&task=tsk-wait');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelector('#todo-task .air-tool-name')?.textContent==='忽略等待'`));

    await page.navigate('/air?dir=d1&task=tsk-manual-err');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelector('#todo-task .air-tool-name')?.textContent==='取消待办'`));

    await page.navigate('/air?dir=d1&task=tsk-interact2');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelector('#todo-task .air-tool-name')?.textContent==='标记达成'`));
    await page.evaluate(`document.getElementById('todo-task').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#todo-task .air-tool-name')?.textContent==='标记为待办'`));
    assert.deepEqual(achievedCalls.slice(-2), ['tsk-interact', 'tsk-interact2']);
    assert.equal(await page.evaluate(`window.MultiCCAirTaskTodo.needsMe(${JSON.stringify(tasks.find(entry => entry.id === 'tsk-interact2'))})`), false,
      '标记达成后不再算等我处理');

    // ── 手机：两格并列，「等我处理」是汇总数，「待办」是手动数 ───────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await noErrors();
    await page.navigate('/air');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelector('#console-task-filters [data-filter="needs"]')`));
    assert.equal(await page.evaluate(`(() => { const b=document.querySelector('#console-task-filters [data-filter="needs"]').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; })()`), true);
    assert.ok((await page.evaluate(`document.querySelector('#console-task-filters [data-filter="needs"]').textContent`)).endsWith('4'));
    assert.ok((await page.evaluate(`document.querySelector('#console-task-filters [data-filter="todo"]').textContent`)).endsWith('2'));
    assert.equal(await page.evaluate(`document.querySelector('#console-task-filters [data-filter="ignored"]')`), null);
    await page.screenshot('mobile-needs-todo.png');

    await noErrors();
  });
});

// 目录概览的「等我处理」卡与 needsMe 同源；「异常」独立于忽略开关：
// 被手动忽略的出错任务退出等我处理，但仍留在异常计数与异常清单里（行上仍能取消忽略）。
// 旧的 waiting 档位已删除，遗留值必须回落到同一份 needsMe。
test('the directory needs-me card matches needsMe and ignored errors stay in the error list', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = fixtureRoutes();
  const directories = [{ id: 'd1', name: 'Gapasea', path: '/projects/gapasea' }];
  const now = Date.now();
  const task = (id, title, extra) => ({ id, dirId: 'd1', title, status: 'active', updatedAt: now - id.length, lastMessageAt: now - id.length,
    resource: { residency: 'planned', lease: 'idle' }, ...extra });
  const tasks = [
    task('tsk-wait', '等人回答的活', { runState: 'waiting' }),
    task('tsk-err', '炸了的活', { runState: 'error' }),
    task('tsk-err-ignored', '忽略掉的出错', { runState: 'error' }),
    task('tsk-idle', '空闲的活', { runState: 'idle' }),
    task('tsk-archived', '归档了的等待', { status: 'archived', runState: 'waiting' }),
  ];
  let ignores = ['tsk-err-ignored'];
  const ignoreCalls = [];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [],
    taskTodos: ['tsk-idle'], taskTodoIgnored: ignores });
  routes['POST /api/air/todos/ignore'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    ignoreCalls.push(taskId);
    const on = !ignores.includes(taskId);
    ignores = on ? [...ignores, taskId] : ignores.filter(id => id !== taskId);
    return json({ ok: true, ignored: on, kind: on ? 'error' : null, taskIds: ignores, todos: ['tsk-idle'] });
  };

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-todo-overview-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-stats .directory-stat').length===5`));
    const cards = () => page.evaluate(`[...document.querySelectorAll('#directory-stats .directory-stat')]
      .map(el => [el.querySelector('span').textContent, el.querySelector('strong').textContent])`);
    const titles = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent).sort()`);
    // 「等我处理」= 等回答 + 未忽略的出错 + 手动待办；被忽略的出错不在里面。异常仍算两条。
    assert.deepEqual(await cards(), [
      ['进行中', '0'], ['等我处理', '3'], ['异常', '2'], ['今日完成', '0'], ['全部', '5'],
    ]);
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-status option[value="waiting"]')`), null,
      '「等待回复」档已并入等我处理');

    // 点「等我处理」卡：卡片数字与筛选列表同源，被忽略的出错不出现。
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[1].click()`);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-status').value`), 'needs');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===3`),
      '等我处理卡的数字与列表条数一致');
    assert.deepEqual(await titles(), ['等人回答的活', '炸了的活', '空闲的活'].sort());
    assert.equal((await titles()).includes('忽略掉的出错'), false, '被忽略的出错不在等我处理里');
    await page.screenshot('directory-overview-needs.png');

    // 「待办」= 只有手动标记的那一条。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='todo'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===1`));
    assert.deepEqual(await titles(), ['空闲的活'], '待办只列手动清单');

    // 遗留的 waiting 值回落到同一份 needsMe。
    const fallback = await page.evaluate(`(() => {
      const tasks = ${JSON.stringify(tasks)};
      return window.MultiCCAirAdmin.filterTasks(tasks, { status: 'waiting' }).map(task => task.id).sort();
    })()`);
    assert.deepEqual(fallback, ['tsk-err', 'tsk-idle', 'tsk-wait'], '旧 waiting 值 = 等我处理口径（含手动、排除忽略）');

    // 点「异常」卡：被忽略过的出错仍在计数和列表里，行上仍是「取消忽略」+ 小标。
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[2].click()`);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-status').value`), 'error');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));
    assert.deepEqual(await titles(), ['忽略掉的出错', '炸了的活'].sort());
    const ignoredRow = await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === '忽略掉的出错');
      const button = row.querySelector('.task-todo');
      return [button.textContent, button.getAttribute('aria-pressed'), row.querySelector('.task-ignored-badge')?.textContent || ''];
    })()`);
    assert.deepEqual(ignoredRow, ['取消忽略', 'true', '已忽略'], '被忽略的异常行仍可取消忽略，并带小标');
    await page.screenshot('directory-overview-error.png');

    // 手机端同一份口径：等我处理不算被忽略的，异常仍算它；待办只数手动的。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-stats .directory-stat').length===5`));
    await page.screenshot('mobile-directory-overview.png');
    await page.navigate('/air');
    assert.ok(await page.waitFor(`document.querySelector('#console-task-filters [data-filter="error"]')`));
    assert.equal((await page.evaluate(`document.querySelector('#console-task-filters [data-filter="needs"]').textContent`)).endsWith('3'), true);
    assert.equal((await page.evaluate(`document.querySelector('#console-task-filters [data-filter="todo"]').textContent`)).endsWith('1'), true,
      '手机端待办只数手动标记的');
    assert.equal((await page.evaluate(`document.querySelector('#console-task-filters [data-filter="error"]').textContent`)).endsWith('2'), true,
      '手机端异常计数也含被忽略的出错任务');
    assert.equal(await page.evaluate(`document.querySelector('#console-task-filters [data-filter="waiting"]')`), null,
      '手机端不再有单独的「等待回复」格');
    await page.screenshot('mobile-overview-filters.png');

    // 回到桌面目录页，就地取消忽略：异常计数不变，但它重新回到等我处理。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    // 整页导航换了 window，错误钩子要跟着重装（同上面那条测试）。
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[2].click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === '忽略掉的出错');
      row.querySelector('.task-todo').click();
    })()`);
    assert.ok(await page.waitFor(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === '忽略掉的出错');
      const button = row && row.querySelector('.task-todo');
      return button && button.textContent === '忽略异常' && button.getAttribute('aria-pressed') === 'false';
    })()`));
    assert.deepEqual(ignores, []);
    assert.deepEqual(ignoreCalls, ['tsk-err-ignored']);
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list .directory-task-row').length`), 2,
      '取消忽略后异常清单仍是两条');
    // 它重新回到等我处理：等回答 + 两条出错 + 手动待办 = 4。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='needs'; s.dispatchEvent(new Event('change')); })()`);
    const restoredTitles = await page.waitFor(`(() => {
      const names = [...document.querySelectorAll('#directory-task-list .directory-task-row strong')].map(el => el.textContent).sort();
      return document.getElementById('directory-task-status').value === 'needs'
        && JSON.stringify(names) === ${JSON.stringify(JSON.stringify(['忽略掉的出错', '炸了的活', '空闲的活', '等人回答的活'].sort()))} ? names : null;
    })()`);
    assert.deepEqual(restoredTitles, ['忽略掉的出错', '炸了的活', '空闲的活', '等人回答的活'].sort(), '取消忽略后完整列表与等我处理一致');
    assert.deepEqual(await page.evaluate('window.__errors'), []);
  });
});
