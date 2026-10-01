'use strict';
// 目录首页这一页的形状：git 与 worktree 合成一张卡、筛选常驻、清单一页一页翻、
// 底下的新任务输入框默认折成一条细杠。
//
// 这四件事原来是四个各自为政的小状态：worktree 是 git 旁边另一张平级的卡（同一件
// 事两条标题）、筛选藏在「查看全部」后面、清单要么只画最近十条要么展开成三百九十
// 像素高的窗口、输入框在桌面永远是整张（它 sticky，桌面一样压着清单的尾巴）。现在
// 是：一张卡上下两行、清单那张卡的高度按这一屏算（统计卡下面 → 输入框上面）、条数
// 交给分页、输入框哪儿都先折着。
//
// 45 条任务是故意的：一页 20 条，45 正好是「三页、最后一页只有 5 条」，第一页与
// 最后一页的行数必须不一样，否则「翻页真的换了内容」这件事就没被证明。
// 最后一段切到 1440x900 单独量一次：那一屏是用户报「清单被挤成一条」的尺寸，卡的
// 上下沿、一屏能读几行、滚到底时输入框有没有切掉「现在回收」，都在那里钉死。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the directory home shares one scroll layer, shows a compact sticky heading, paginates, and keeps its composer', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
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
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url` };

  const directories = [{
    id: 'd1', name: 'MultiCC', path: '/projects/multicc',
    worktreeCount: 7,
    // 本地 3（占磁盘）、睡下 3、计划 1 —— 三个数必须分开摆（air-worktrees.js 的
    // 全部意义就在这一格），所以 fixture 里刻意三个都不一样。
    worktreeLifecycle: { resident: 2, retained: 1, hibernated: 3, planned: 1, leased: 1, onDisk: 3, total: 7 },
  }];
  const tasks = Array.from({ length: 45 }, (_, i) => {
    const n = i + 1;
    // 前三条挂起：统计卡那档 quickFilter 要有东西可筛。
    const runState = n <= 3 ? 'waiting' : 'idle';
    return {
      id: `tsk-${String(n).padStart(2, '0')}`, dirId: 'd1', title: `目录任务 ${String(n).padStart(2, '0')}`,
      status: 'active', runState, updatedAt: 1000 + n, lastMessageAt: 2000 - n,
      resource: { residency: 'planned', lease: 'idle' },
    };
  });
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] },
    worktreePolicy: { idleMs: 24 * 3600 * 1000 }, tasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/git/directory-status'] = () => json({ branch: 'main', upstream: 'origin/main', baseBranch: 'main',
    ahead: 0, behind: 0, dirtyFiles: [] });
  routes['/api/git/log'] = () => json({ commits: [] });
  // 搜索那两条语料：本用例只关心「翻页被筛选重置」，命中排序不是这里的主题。
  routes['/api/task-board/search'] = () => json({ ok: true, hits: [] });
  routes['/api/search/messages'] = () => json({ ok: true, messageHits: [] });
  const reclaims = [];
  routes['POST /api/air/worktrees/reclaim'] = () => {
    reclaims.push(1);
    return json({ ok: true, hibernated: 2, considered: 3, skipped: 1 });
  };

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-directory-page-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);

    // ── 一张卡：git 那行 + worktree 那行 ──────────────────────────────────
    assert.ok(await page.waitFor(`document.getElementById('directory-worktree-body').children.length>0`));
    const merged = await page.evaluate(`(() => {
      const card = document.getElementById('directory-git');
      const wt = document.getElementById('directory-worktrees');
      return {
        cardHidden: card.hidden, wtHidden: wt.hidden,
        wtParent: wt.parentElement.id,
        wtInCard: card.contains(wt),
        // 卡自己的标题只有一条：worktree 那行是卡里的第二行，不是另一张平级的卡。
        cardHeadings: card.querySelectorAll(':scope > .section-heading').length,
        title: document.getElementById('directory-git-title').textContent,
        // 它不再是 #empty 那一列的兄弟 —— 那正是「两张卡」的旧形状。
        wtIsColumnChild: wt.parentElement.id === 'empty',
        wtSummary: document.getElementById('directory-worktree-summary').textContent,
        briefChips: card.querySelectorAll('.directory-git-chips .directory-git-chip').length,
        reclaim: !!card.querySelector('.worktree-reclaim'),
        manager: card.querySelector('.directory-git-actions button')?.textContent || '',
      }; })()`);
    assert.equal(merged.cardHidden, false, '有 git 状态就该露出来');
    assert.equal(merged.wtHidden, false, '这个目录有 worktree 生命周期数据');
    assert.equal(merged.wtParent, 'directory-git', 'worktree 那块必须长在 git 卡里面');
    assert.equal(merged.wtInCard, true);
    assert.equal(merged.wtIsColumnChild, false, '不能再是首页那一列的独立一张卡');
    assert.equal(merged.cardHeadings, 1, '一张卡一个抬头');
    assert.equal(merged.title, '代码与 Worktree');
    assert.ok(/本地 3/.test(merged.wtSummary) && /7/.test(merged.wtSummary), `worktree 摘要要分开摆：${merged.wtSummary}`);
    assert.ok(merged.briefChips >= 2, `git 那行要有分支与同步状态：${JSON.stringify(merged)}`);
    assert.equal(merged.reclaim, true, '「现在回收」还在（它跟着 worktree 那一行搬进了卡里）');
    assert.equal(merged.manager, '打开 Git 管理器', 'Git 管理器的入口还在');
    await page.screenshot('directory-merged-card.png');

    // 「现在回收」照旧打那条接口，并在回执里报结果（不是搬完就断了线）。
    await page.evaluate(`document.querySelector('.worktree-reclaim').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.length>0`));
    assert.equal(reclaims.length, 1, '回收只发一次（服务端说收了 2 个，够不着 force 那一步）');
    // Git 管理器照旧能开：按钮 → window.MultiCCGitManager.open（不是新写的另一条路）。
    await page.evaluate(`document.querySelector('.directory-git-actions button').click()`);
    assert.ok(await page.waitFor(`!!document.querySelector('dialog.git-manager[open]')`), '目录卡上那颗按钮还是开那个窗口');
    await page.evaluate(`document.querySelector('dialog.git-manager').close()`);

    // ── 筛选常驻 ─────────────────────────────────────────────────────────
    const controls = await page.evaluate(`(() => { const c=document.getElementById('directory-task-controls');
      return { hidden: c.hidden, visible: c.offsetParent!==null, panel: c.closest('.directory-task-panel')===document.querySelector('.directory-task-panel'),
        beforeList: !!(c.compareDocumentPosition(document.getElementById('directory-task-list')) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
    assert.equal(controls.hidden, false, '筛选不再等「查看全部」才出现');
    assert.equal(controls.visible, true);
    assert.equal(controls.beforeList, true, '筛选在清单上面');

    // ── 清单与整页同层滚动 + 一页一页翻 ───────────────────────────────────
    const page1 = await page.evaluate(`(() => {
      const panel = document.querySelector('.directory-task-panel'), list = document.getElementById('directory-task-list');
      const pager = document.getElementById('directory-task-pager');
      const p = panel.getBoundingClientRect(), l = list.getBoundingClientRect(), g = pager.getBoundingClientRect();
      return {
        rows: list.querySelectorAll('.directory-task-row').length,
        title: list.querySelector('.directory-task-row strong').textContent,
        panelH: Math.round(p.height), listH: Math.round(l.height),
        listBottom: Math.round(l.bottom), pagerTop: Math.round(g.top), pagerBottom: Math.round(g.bottom),
        panelBottom: Math.round(p.bottom), scrolls: list.scrollHeight > list.clientHeight,
        label: document.getElementById('directory-task-page').textContent,
        barHidden: document.getElementById('directory-task-pager').hidden,
        prevOff: document.getElementById('directory-task-prev').disabled,
        nextOff: document.getElementById('directory-task-next').disabled,
        count: document.getElementById('directory-overview-count').textContent,
      }; })()`);
    assert.equal(page1.rows, 20, '一页 20 条');
    assert.equal(page1.title, '目录任务 01', '默认按最后消息排');
    assert.equal(page1.barHidden, false, '45 条装不下，分页条要露面');
    assert.equal(page1.label, '第 1 / 3 页');
    assert.equal(page1.prevOff, true, '第一页没有上一页');
    assert.equal(page1.nextOff, false);
    assert.equal(page1.count, '45 / 45 个任务', '抬头数的是筛完的条数，不是这一页的条数');
    assert.ok(page1.listH > 0, `清单得看得见：${JSON.stringify(page1)}`);
    assert.ok(Math.abs(page1.listBottom - page1.pagerTop) <= 1 && Math.abs(page1.pagerBottom - page1.panelBottom) <= 1,
      `清单上下都贴着邻居，吃满中间那一段：${JSON.stringify(page1)}`);
    assert.equal(page1.scrolls, false, '清单本身不制造第二滚动口');
    assert.ok(page1.panelH > page1.listH, '面板随当前页内容自然撑开');

    // 表头滚出时精简副本出现；从任务行向上滚可回页首，不被内层滚动锁住。
    await page.evaluate(`(() => { const e=document.getElementById('empty'), h=document.getElementById('directory-task-real-heading');
      e.scrollTop += h.getBoundingClientRect().bottom-e.getBoundingClientRect().top+8; })()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-task-sticky-copy').classList.contains('is-visible')`));
    await page.evaluate(`document.getElementById('directory-mode-terminal').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('directory-task-sticky-copy').classList.contains('is-visible')`));
    await page.evaluate(`document.getElementById('directory-mode-chat').click()`);
    await page.evaluate(`(() => { const e=document.getElementById('empty'), h=document.getElementById('directory-task-real-heading');
      e.scrollTop += h.getBoundingClientRect().bottom-e.getBoundingClientRect().top+8; })()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-task-sticky-copy').classList.contains('is-visible')`));
    assert.equal(await page.evaluate(`document.getElementById('directory-task-sticky-count').textContent`), '45 / 45 个任务');
    await page.evaluate(`document.getElementById('empty').scrollTop=0`);
    assert.ok(await page.waitFor(`!document.getElementById('directory-task-sticky-copy').classList.contains('is-visible')`));
    assert.equal(await page.evaluate(`document.getElementById('empty').scrollTop`), 0, '从任务行可返回页首');

    // 先滚一段再翻页：新一页必须从第一行读起。
    await page.evaluate(`document.getElementById('empty').scrollTop = 200`);
    await page.evaluate(`document.getElementById('directory-task-next').click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-task-page').textContent==='第 2 / 3 页'`));
    assert.ok(await page.waitFor(`Math.abs(document.getElementById('directory-task-real-heading').getBoundingClientRect().top - document.getElementById('empty').getBoundingClientRect().top) <= 2`));
    const page2 = await page.evaluate(`(() => { const list=document.getElementById('directory-task-list');
      return { rows: list.querySelectorAll('.directory-task-row').length, first: list.querySelector('.directory-task-row strong').textContent,
        scrollTop: document.getElementById('empty').scrollTop,
        headingTop: document.getElementById('directory-task-real-heading').getBoundingClientRect().top,
        viewportTop: document.getElementById('empty').getBoundingClientRect().top,
        prevOff: document.getElementById('directory-task-prev').disabled }; })()`);
    assert.equal(page2.rows, 20);
    assert.notEqual(page2.first, page1.title, '第二页是另一批任务');
    assert.ok(Math.abs(page2.headingTop - page2.viewportTop) <= 2, '换页回到真实表头');
    assert.equal(page2.prevOff, false);
    await page.evaluate(`document.getElementById('directory-task-next').click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-task-page').textContent==='第 3 / 3 页'`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list .directory-task-row').length`), 5, '45 = 20 + 20 + 5');
    assert.equal(await page.evaluate(`document.getElementById('directory-task-next').disabled`), true, '最后一页没有下一页');
    assert.equal(await page.evaluate(`document.getElementById('directory-task-prev').disabled`), false, '还能退回去');
    await page.screenshot('directory-pagination.png');

    // 筛选一动就回第一页：停在第三页看到的是另一批任务，那不叫筛选。
    await page.evaluate(`(() => { const i=document.getElementById('directory-task-search'); i.value='目录任务'; i.dispatchEvent(new Event('input')); })()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-task-page').textContent==='第 1 / 3 页'`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list .directory-task-row').length`), 20);
    // 搜到只剩一页：分页条整条收起（一颗按不动的按钮不算信息）。
    await page.evaluate(`(() => { const i=document.getElementById('directory-task-search'); i.value='目录任务 07'; i.dispatchEvent(new Event('input')); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===1`));
    assert.equal(await page.evaluate(`document.getElementById('directory-task-pager').hidden`), true, '一页装得下就不摆分页条');
    // 剩一条时面板按内容收起，不能保留一整页的空白。
    const oneRow = await page.evaluate(`(() => { const panel=document.querySelector('.directory-task-panel'), list=document.getElementById('directory-task-list');
      return { panelH: Math.round(panel.getBoundingClientRect().height), listH: Math.round(list.getBoundingClientRect().height),
        bottom: Math.round(list.getBoundingClientRect().bottom), panelBottom: Math.round(panel.getBoundingClientRect().bottom) }; })()`);
    assert.ok(oneRow.panelH < page1.panelH, '面板随当前页条数收起');
    assert.ok(Math.abs(oneRow.bottom - oneRow.panelBottom) <= 1, '分页条收起后清单正好补上那块');
    assert.ok(oneRow.listH < page1.listH, '只剩一条时列表也缩小');
    await page.evaluate(`(() => { const i=document.getElementById('directory-task-search'); i.value=''; i.dispatchEvent(new Event('input')); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===20`));

    // 统计卡那档 quickFilter 照旧：点「等待回复」= 按 waiting 筛，且回到第一页。
    await page.evaluate(`document.getElementById('directory-task-next').click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-task-page').textContent==='第 2 / 3 页'`));
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[1].click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===3`));
    assert.equal(await page.evaluate(`document.getElementById('directory-task-status').value`), 'waiting', '卡片与状态那格同一份筛选');
    assert.equal(await page.evaluate(`document.getElementById('directory-task-page').textContent`), '第 1 / 1 页');
    // 收尾：退回「全部记录」，免得影响下面输入框那段。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='open'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===20`));

    // ── 输入框：桌面也先折着 ─────────────────────────────────────────────
    const collapsed = await page.evaluate(`(() => {
      const f=document.getElementById('quick-task-form'), i=document.getElementById('quick-task-input'),
        b=document.getElementById('quick-task-expand');
      return { folded: f.classList.contains('is-folded'), formH: Math.round(f.getBoundingClientRect().height),
        inputVisible: i.offsetParent!==null, barH: Math.round(b.getBoundingClientRect().height),
        hint: document.getElementById('quick-task-expand-hint').textContent }; })()`);
    assert.equal(collapsed.folded, true, '1200x900 的桌面同样先折着');
    assert.equal(collapsed.inputVisible, false, '折起来时那半屏的整张卡片整个收掉');
    assert.ok(collapsed.barH > 0 && collapsed.formH < 70, `只剩一条细杠：${JSON.stringify(collapsed)}`);
    assert.equal(collapsed.hint, '描述要完成的任务…', '细杠念的是输入框的占位文案');
    await page.screenshot('directory-composer-folded.png');
    await page.evaluate(`document.getElementById('quick-task-expand').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('quick-task-form').classList.contains('is-folded')`));
    assert.equal(await page.evaluate(`document.activeElement===document.getElementById('quick-task-input')`), true, '点开就能打字');
    const opened = await page.evaluate(`document.getElementById('quick-task-form').getBoundingClientRect().height`);
    assert.ok(opened > collapsed.formH * 3, '展开确实比细杠高得多');
    // 起草中不折：那会把半句话藏进一条细杠里。
    await page.evaluate(`(() => { const i=document.getElementById('quick-task-input'); i.value='写了一半';
      i.dispatchEvent(new Event('input',{bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})) })()`);
    assert.equal(await page.evaluate(`document.getElementById('quick-task-form').classList.contains('is-folded')`), false, '有草稿就不折');
    // 清空之后 Esc 一把折回去，焦点交给那条细杠。
    await page.evaluate(`(() => { const i=document.getElementById('quick-task-input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})) })()`);
    assert.ok(await page.waitFor(`document.getElementById('quick-task-form').classList.contains('is-folded')`));
    assert.equal(await page.evaluate(`document.activeElement===document.getElementById('quick-task-expand')`), true);

    // ── 1440x900：桌面同样只有 #empty 这一层滚动 ─────────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const band = await page.evaluate(`(() => {
      const box = e => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; };
      const panel = document.querySelector('.directory-task-panel');
      const list = document.getElementById('directory-task-list');
      const rows = [...list.querySelectorAll('.directory-task-row')];
      const form = document.getElementById('quick-task-form');
      const row = rows[0].getBoundingClientRect().height;
      return {
        panel: box(panel), list: box(list), form: box(form),
        statsBottom: box(document.getElementById('directory-stats')).bottom,
        rowH: Math.round(row), fullRows: Math.floor(list.clientHeight / row),
        scrolls: list.scrollHeight > list.clientHeight,
        pageScrolls: document.getElementById('empty').scrollHeight > document.getElementById('empty').clientHeight,
      }; })()`);
    assert.ok(band.panel.top >= band.statsBottom - 1, `面板从统计卡下面开始：${JSON.stringify(band)}`);
    assert.ok(band.list.h >= 200, `清单自己那一段得读得下几行：${JSON.stringify(band)}`);
    assert.equal(band.scrolls, false, '桌面也不嵌套任务列表滚动口');
    assert.equal(band.pageScrolls, true, '页级滚动覆盖所有内容');
    await page.screenshot('directory-list-1440x900.png');

    // 代码卡在面板下面（滚下去看），滚到底时最后那行「现在回收」必须整行露在输入框之上
    // —— 输入框是 sticky 的，这一条是「底部别再被它切一刀」的证明。
    await page.evaluate(`(() => { const e = document.getElementById('empty'); e.scrollTop = e.scrollHeight; })()`);
    assert.ok(await page.waitFor(`document.getElementById('empty').scrollTop > 0`));
    const tail = await page.evaluate(`(() => {
      const box = e => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
      const empty = document.getElementById('empty');
      return {
        reclaim: box(document.querySelector('.worktree-reclaim')),
        form: box(document.getElementById('quick-task-form')),
        git: box(document.getElementById('directory-git')),
        scrollTop: empty.scrollTop, maxScroll: empty.scrollHeight - empty.clientHeight,
      }; })()`);
    assert.ok(Math.abs(tail.scrollTop - tail.maxScroll) <= 1, `已经滚到底：${JSON.stringify(tail)}`);
    assert.ok(tail.git.top > 0 && tail.git.bottom < tail.form.top, `整张代码卡都在输入框上面：${JSON.stringify(tail)}`);
    assert.ok(tail.reclaim.bottom <= tail.form.top, `「现在回收」整行露在输入框之上：${JSON.stringify(tail)}`);
    await page.screenshot('directory-bottom-1440x900.png');
    await page.evaluate(`document.getElementById('empty').scrollTop = 0`);

    // 手机 390px：触摸任务行时也只滚 #empty，副本随真实表头进出视口。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.evaluate(`(() => { const e=document.getElementById('empty'), h=document.getElementById('directory-task-real-heading');
      e.scrollTop += h.getBoundingClientRect().bottom-e.getBoundingClientRect().top+8; })()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-task-sticky-copy').classList.contains('is-visible')`));
    assert.equal(await page.evaluate(`document.getElementById('directory-task-list').scrollHeight > document.getElementById('directory-task-list').clientHeight`), false);
    await page.evaluate(`document.getElementById('empty').scrollTop=0`);
    assert.ok(await page.waitFor(`!document.getElementById('directory-task-sticky-copy').classList.contains('is-visible')`));
    assert.equal(await page.evaluate(`document.getElementById('empty').scrollTop`), 0);

    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, '这一页不该横向溢出');
    assert.deepEqual(await page.evaluate('window.__errors'), []);
  });
});
