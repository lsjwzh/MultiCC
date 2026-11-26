'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
function fixture() {
  const root = path.resolve(__dirname, '../public'), routes = {};
  for (const name of fs.readdirSync(root).filter(name => /\.(js|css|html)$/.test(name))) {
    routes['/' + name] = { body: fs.readFileSync(path.join(root, name)), headers: { 'content-type': (name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html') + '; charset=utf-8' } };
  }
  for (const name of fs.readdirSync(path.join(root, 'shared')).filter(name => name.endsWith('.js'))) {
    routes['/shared/' + name] = { body: fs.readFileSync(path.join(root, 'shared', name)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: 'window.multiccWsUrl=async url=>url' };
  const directories = [{ id: 'site', name: '官网', path: '/projects/site' }, { id: 'api', name: '后端服务', path: '/projects/api' }];
  const tasks = ['waiting', 'error', 'running', 'succeeded', 'idle', 'succeeded', 'idle'].map((state, i) => ({
    id: 'task-' + i, dirId: i % 2 ? 'api' : 'site', title: ['登录页改版', '每日数据报表', '接口文档补全', '订单导出改 CSV', '周报素材整理', 'README 补安装说明', '首页性能排查'][i],
    runState: state, status: state === 'succeeded' ? 'done' : 'active', updatedAt: Date.now() - i * 1000,
    resource: { residency: 'planned', lease: 'idle' },
  }));
  let configured = true;
  routes['/api/air'] = () => json({ ok: true, directories, tasks, clis: ['claude-exp', 'codex-exp'], migration: { errors: [] }, sessions: [] });
  routes['/api/fs/list'] = () => json({ base: '/projects', entries: [] });
  routes['POST /api/directories'] = req => { const input = JSON.parse(req.body); const value = { id: 'example', ...input }; directories.push(value); return json(value); };
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/aux/config'] = () => json({ providerId: configured ? 'p1' : '', cliAvailability: { claude: true, codex: true } });
  routes['/api/settings/power'] = () => json({ available: true, enabled: false, unlockPassword: { available: true, enabled: false, set: false } });
  routes['/api/providers'] = () => json({ available: true, defaults: {}, providers: [] });
  routes['/api/token-usage/global'] = () => json({ windows: { today: {}, week: {}, month: {}, all: {} }, byDay: {} });
  routes['/api/token-usage/by-role'] = () => json({});
  routes['/api/codex/accounts'] = routes['/api/claude/accounts'] = () => json({ accounts: [] });
  return { routes, directories, tasks, unconfigure: () => { configured = false; }, configure: () => { configured = true; } };
}
const shots = process.env.MULTICC_SESSION_ID
  ? path.join(os.homedir(), '.multicc/assist', process.env.MULTICC_SESSION_ID)
  : path.join(os.tmpdir(), 'multicc-navigation-qa');

test('Air preserves recent tasks and uses one settings home with browser-consistent return navigation', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const state = fixture();
  await withCdpHarness({ routes: state.routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air');
    await page.evaluate(`localStorage.setItem('air:recent-tasks', JSON.stringify(${JSON.stringify(state.tasks.map(task => task.id))})); location.reload()`);
    assert.ok(await page.waitFor(`document.querySelector('.console-priority-card') && document.querySelector('#tasks button')`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.console-priority-card').length`), 2);
    assert.equal(await page.evaluate(`document.querySelector('#task-title').textContent`), '控制台');
    // 控制台清单默认「最近任务」= 未归档（已完成的也在），不截条数。
    assert.ok(await page.waitFor(`document.querySelector('#console-task-list').children.length === 7`));
    assert.equal(await page.evaluate(`document.querySelector('#sidebar-resources').open`), false);
    t.diagnostic(await page.screenshot('implemented-console'));
    await page.evaluate(`document.querySelector('#recent-all').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#console-task-list').children.length`), 7);
    await page.evaluate(`document.querySelector('#side-more').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-settings-categories button').length`), 5);
    assert.equal(await page.evaluate(`document.querySelector('#task-sidebar').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('#more-panel')`), null);
    t.diagnostic(await page.screenshot('implemented-settings'));
    await page.evaluate(`document.querySelector('[data-air-card="provider"]').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 设置');
    assert.ok(await page.waitFor(`document.querySelector('.air-provider') || document.querySelector('#air-provider-defaults')`));
    t.diagnostic(await page.screenshot('implemented-provider'));
    await page.evaluate(`location.reload()`);
    assert.ok(await page.waitFor(`document.querySelector('#page-back')?.textContent === '‹ 设置'`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
    await page.evaluate('history.forward()');
    assert.ok(await page.waitFor(`location.search.includes('view=provider')`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
    await page.evaluate(`document.querySelector('[data-category="airSettingsComputer"]').click()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-lid-sleep').length`), 1);
    assert.ok(await page.waitFor(`!document.querySelector('#air-lid-sleep').hidden`));
    await page.evaluate(`document.querySelector('[data-air-card="global"]').click(); document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#admin-content #air-lid-sleep') !== null`));
    await page.evaluate(`document.querySelector('#library').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#library').getAttribute('aria-expanded')`), 'true');
    await page.evaluate(`const search = document.querySelector('#directory-flyout input'); search.value = '后端'; search.dispatchEvent(new Event('input'))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.directory-flyout-row:not([hidden])').length`), 1);
    await page.evaluate(`document.querySelector('.directory-flyout-row:not([hidden])').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#task-title').textContent === '后端服务'`));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.evaluate(`document.querySelector('#mobile-nav').click(); document.querySelector('#library').click()`);
    assert.equal(await page.evaluate(`(() => { const r = document.querySelector('#directory-flyout').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`), true);
    t.diagnostic(await page.screenshot('implemented-project-mobile'));
    await page.evaluate(`document.querySelector('.directory-flyout-action').click()`);
    assert.equal(await page.evaluate(`document.body.classList.contains('nav-open')`), false);
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    t.diagnostic(await page.screenshot('implemented-console-mobile'));
    await page.navigate('/air?view=provider');
    assert.ok(await page.waitFor(`document.querySelector('#page-back')?.textContent === '‹ 设置'`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
  });
});

test('the three-step guide can be resumed after dismissing and reflects real setup state', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const state = fixture(); state.tasks.length = 0; state.directories.length = 0; state.unconfigure();
  await withCdpHarness({ routes: state.routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air');
    assert.ok(await page.waitFor(`!document.querySelector('#setup-card').hidden`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.setup-step.current').length`), 1);
    assert.equal(await page.evaluate(`document.querySelector('#onboarding-progress').textContent`), '0 / 3');
    assert.equal(await page.evaluate(`document.querySelector('#setup-first-task').disabled`), true);
    await page.evaluate(`document.querySelector('#setup-dismiss').click(); document.querySelector('#side-more').click(); document.querySelector('#onboarding-entry').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#setup-card').hidden`), false);
    await page.evaluate(`document.querySelector('#setup-provider').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 控制台');
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`!document.querySelector('#console-center').hidden`));
    t.diagnostic(await page.screenshot('implemented-onboarding'));
    await page.evaluate(`document.querySelector('#setup-example').click()`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] input[placeholder]')?.value === '/projects/MultiCC-Example'`));
    assert.equal(page.requests.filter(request => request.path === '/api/directories' && request.method === 'POST').length, 0, 'example project waits for the save action');
    await page.evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.querySelector('#directory-name').textContent === '示例项目'`));
    await page.evaluate(`document.querySelector('#onboarding-entry').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#onboarding-progress').textContent`), '1 / 3');
    assert.equal(await page.evaluate(`document.querySelector('#setup-step-1').classList.contains('done')`), true);
    await page.evaluate(`document.querySelector('#setup-aux').click()`);
    state.configure();
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#onboarding-progress').textContent === '2 / 3'`), 'returning after saving rechecks configuration');
    await page.evaluate(`document.querySelector('#setup-first-task').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#quick-task-dialog').open`), true);


  });
});

test('手机底部导航三项：控制台（含不截条数的清单）/ 定时任务 / 项目，真实来路与项目筛选', async t => {
  if (!findChromeBinary()) return t.skip('需要浏览器');
  const state = fixture();
  await withCdpHarness({ routes: state.routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/air');
    await page.evaluate(`localStorage.removeItem('air:console-view')`);
    await page.navigate('/air');
    assert.ok(await page.waitFor(`document.querySelector('#air-mobile-create') && document.querySelector('#console-task-filters')`));
    assert.equal(await page.evaluate(`document.querySelector('#air-mobile-dock').hidden`), false);
    // 原来的「最近任务」一项并进了控制台；「项目」就是控制台的按目录看法。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[data-mobile-view]')].map(x=>x.dataset.mobileView)`), ['tasks', 'schedules', 'dirs']);
    assert.equal(await page.evaluate(`(() => {const tabs=[...document.querySelectorAll('[data-mobile-view]')].map(x=>x.getBoundingClientRect());return tabs.every(x=>Math.abs(x.top-tabs[0].top)<1) && tabs[2].right<=innerWidth;})()`), true);
    assert.equal(await page.evaluate(`document.querySelector('[data-mobile-view="tasks"]').classList.contains('active')`), true);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#console-view-switch')).display`), 'flex', '页内 tab 保留多电脑入口');
    assert.equal(await page.evaluate(`document.querySelector('#console-view-machines')?.textContent`), '多电脑');
    await page.evaluate(`document.querySelector('[data-mobile-view="dirs"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#console-home')?.dataset.view === 'dirs'`), '「项目」= 控制台目录看法');
    assert.equal(await page.evaluate(`document.querySelector('[data-mobile-view="dirs"]').classList.contains('active')`), true);
    await page.evaluate(`[...document.querySelectorAll('#console-directory-grid .directory-card button')].find(x => x.textContent.includes('${state.directories[0].name}')).click()`);
    assert.ok(await page.waitFor(`document.querySelector('#directory-mode') && !document.querySelector('#task-layout').hidden`), 'directory home reachable from 项目');
    assert.equal(await page.evaluate(`document.querySelector('[data-mobile-view="dirs"]').classList.contains('active')`), true, 'directory home highlights 项目');
    // 回控制台继续原有的控制台断言。
    await page.evaluate(`document.querySelector('[data-mobile-view="tasks"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#console-home')?.dataset.view === 'tasks'`), 'back to console');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#mobile-nav')).display`), 'none');
    t.diagnostic(await page.screenshot('mobile-implemented-home'));
    // 控制台不分目录：顶栏没有目录按钮，清单里两个项目的任务都在，而且是全部（不截条数）。
    assert.equal(await page.evaluate(`document.querySelector('#air-mobile-project').hidden`), true);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#console-task-filters button')].map(x=>x.dataset.filter)`),
      ['recent', 'needs', 'todo', 'today', 'running', 'error', 'all']);
    const rowIds = `[...document.querySelectorAll('#console-task-list .admin-recent-row')].map(x=>x.dataset.taskId)`;
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list .admin-recent-row').length === ${state.tasks.length}`));
    assert.deepEqual(new Set((await page.evaluate(rowIds)).map(id => state.tasks.find(task => task.id === id).dirId)), new Set(['site', 'api']));
    const expectToday = state.tasks.filter(task => task.status === 'done').map(task => task.id);
    assert.ok(expectToday.length >= 2);
    await page.evaluate(`document.querySelector('#console-task-filters [data-filter="today"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#console-task-filters [data-filter="today"]')?.getAttribute('aria-pressed') === 'true'`));
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list .admin-recent-row').length === ${expectToday.length}`));
    assert.deepEqual((await page.evaluate(rowIds)).sort(), [...expectToday].sort());
    assert.ok((await page.evaluate(`document.querySelector('#console-task-filters [data-filter="today"]').textContent`)).endsWith(`${expectToday.length}`));
    t.diagnostic(await page.screenshot('mobile-console-today-filter'));
    // 按项目筛（原来「最近任务」页顶栏那颗目录筛选）：留在控制台，只列这个项目的任务。
    const apiIds = state.tasks.filter(task => task.dirId === 'api').map(task => task.id).sort();
    await page.evaluate(`(() => { const s=document.getElementById('console-task-dir'); s.value='api'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list .admin-recent-row').length === ${expectToday.filter(id => apiIds.includes(id)).length}`));
    assert.deepEqual((await page.evaluate(rowIds)).sort(), expectToday.filter(id => apiIds.includes(id)).sort());
    await page.evaluate(`document.querySelector('#console-task-filters [data-filter="recent"]').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list .admin-recent-row').length === ${apiIds.length}`));
    assert.deepEqual((await page.evaluate(rowIds)).sort(), apiIds);
    t.diagnostic(await page.screenshot('mobile-console-directory-filter'));
    // 新任务默认建到清单正在看的那个项目。
    await page.evaluate(`document.querySelector('#air-mobile-create').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#quick-task-dialog').open`), true);
    assert.equal(await page.evaluate(`document.querySelector('#quick-task-dialog-directory').value`), 'api');
    await page.evaluate(`document.querySelector('#quick-task-dialog').close()`);
    await page.evaluate(`(() => { const s=document.getElementById('console-task-dir'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
    // 搜索走顶栏输入框。
    await page.evaluate(`const field=document.querySelector('#console-home-search'); field.value='登录';field.dispatchEvent(new Event('input'));`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-task-list .admin-recent-row').length === 1`));
    // 真实来路：设置 → 二级 → 返回两次回到控制台，搜索词还在。
    await page.evaluate(`document.querySelector('#air-mobile-settings').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 控制台');
    assert.equal(await page.evaluate(`document.querySelector('#air-mobile-dock').hidden`), true);
    await page.evaluate(`document.querySelector('[data-category="airSettingsMobile"]').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 设置');
    assert.equal(await page.evaluate(`document.querySelector('#task-title').textContent`), '手机与通知');
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`!new URLSearchParams(location.search).has('category') && document.querySelector('#task-title').textContent === '设置'`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=overview') && document.querySelector('#console-home-search')?.value === '登录'`));
    await page.evaluate(`document.querySelector('[data-mobile-view="schedules"]').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=schedules')`));
    assert.equal(await page.evaluate(`document.querySelector('[data-mobile-view="schedules"]').classList.contains('active')`), true);
    for (const width of [360, 390, 430]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `${width} 像素无横向溢出`);
      assert.equal(await page.evaluate(`document.querySelector('#air-mobile-dock').getBoundingClientRect().bottom <= innerHeight`), true);
    }
  });
});

test('Air desktop sidebar floats from the edge and remembers its mode across mobile and reload', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: fixture().routes }, async page => {
    const resize = width => page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    const move = (x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const wait = async condition => assert.ok(await page.waitFor(condition), condition);
    const reload = async () => {
      const origin = await page.evaluate('performance.timeOrigin');
      await page.send('Page.reload');
      await wait('performance.timeOrigin !== ' + origin + ' && document.readyState === "complete"');
    };
    const sidebar = 'document.querySelector("#sidebar")';
    const mainLeft = 'document.querySelector("main").getBoundingClientRect().left';
    await resize(1280);
    await page.navigate('/air');
    await wait(mainLeft + ' === 276');
    await page.evaluate('document.querySelector("#sidebar-mode").click()');
    await wait(sidebar + '.inert && ' + mainLeft + ' === 0');
    await move(1, 320);
    await wait(sidebar + '.getBoundingClientRect().left === 0 && !' + sidebar + '.inert');
    assert.equal(await page.evaluate(mainLeft), 0);

    // A popup anchored to the sidebar can extend past its right edge.
    await page.evaluate('document.querySelector("#library").click()');
    await move(330, 120);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await page.evaluate(sidebar + '.inert || document.querySelector("#directory-flyout").hidden'), false);
    await page.evaluate('document.querySelector("#library").click()');
    await wait(sidebar + '.inert');
    await reload();
    await wait(sidebar + '?.inert');

    await page.evaluate('document.querySelector("#sidebar-edge").focus()');
    const press = async (key, code) => {
      for (const type of ['keyDown', 'keyUp']) {
        await page.send('Input.dispatchKeyEvent', {
          type, key, code: key, windowsVirtualKeyCode: code,
          text: type === 'keyDown' && key === 'Enter' ? '\r' : '',
        });
      }
    };
    assert.equal(await page.evaluate('document.activeElement.id'), 'sidebar-edge');
    await press('Enter', 13);
    await wait('document.activeElement.id === "library" && !' + sidebar + '.inert');
    await press('Escape', 27);
    await wait('document.activeElement.id === "sidebar-edge" && ' + sidebar + '.inert');

    await resize(390);
    await wait('!' + sidebar + '.inert && !document.querySelector("#sidebar-edge").getClientRects().length');
    await page.evaluate('document.querySelector("#mobile-nav").click()');
    await wait('document.body.classList.contains("nav-open") && ' + sidebar + '.getBoundingClientRect().left === 0');
    await page.evaluate('document.querySelector("#nav-scrim").click()');
    await resize(960);
    await wait(sidebar + '.inert');
    await move(1, 320);
    await move(100, 320);
    await wait('!' + sidebar + '.inert && ' + sidebar + '.getBoundingClientRect().left === 0');
    await move(600, 320);
    await wait(sidebar + '.inert');
    await move(1, 320);
    await wait('!' + sidebar + '.inert');
    await page.evaluate('document.querySelector("#sidebar-mode").click()');
    await wait(mainLeft + ' === 240');
    await reload();
    await wait(mainLeft + ' === 240 && !' + sidebar + '.inert');
  });
});
