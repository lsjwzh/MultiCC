'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 归档 / 恢复 / 移动 / 删除 四个操作在详情面板上只是几个按钮，但它们各自踩在
// task-board 的不同路由上（status / relocate / DELETE），而且成功文案必须在
// refresh() 之后写 —— refresh 自己会清空 #notice。单元测试盯后端编排，这里盯
// 真浏览器里的这一层：按钮在不在、载荷对不对、拒绝时说的是不是人话。

test('Air task detail archives, restores, moves with carry and deletes', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const directories = [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }, { id: 'd2', name: 'Sandbox', path: '/projects/sandbox' }];
  const entry = { ok: true, task: { id: 'tsk_a', title: '完善任务协作体验', status: 'active', recordType: 'execution' },
    sessionId: 'task-a', ownerShellId: 'shell-a', readOnly: false, status: 'active',
    execution: { busy: false, status: 'idle' }, resource: { residency: 'retained', lease: 'idle', path: '/projects/multicc/.worktrees/task-a', branch: 'multicc/task-a' },
    attribution: {}, configuration: { cli: 'codex', model: 'gpt-5.5', effectiveModel: 'gpt-5.5' }, roleBindings: null, messages: [] };
  const listed = () => [{ ...entry.task, dirId: entry.task.dirId || 'd1', updatedAt: Date.now(), resource: entry.resource }];
  const statusCalls = [], renameCalls = [], relocateCalls = [], deleteCalls = [];

  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: deleteCalls.length ? [] : listed(), sessions: [] });
  routes['/api/air/tasks/tsk_a'] = routes['/api/task-shell-tasks/tsk_a'] = () => json(entry);
  routes['/api/air/resolve'] = () => json({ ok: true, url: '/air?task=tsk_a&dir=d1' });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/providers'] = () => json({ ok: true, available: false, defaults: {}, providers: [] });
  routes['/api/task-shells/shell-a/chat'] = () => json({ activeSessionId: 'task-a', taskId: 'tsk_a' });
  routes['/api/sessions/task-a/merge-status'] = () => json({ branch: 'multicc/task-a', baseBranch: 'main', behind: 0 });
  routes['POST /api/task-board/tasks/tsk_a/status'] = ({ body }) => {
    const value = JSON.parse(body); statusCalls.push(value);
    entry.task.status = value.status; entry.status = value.status;
    return json({ ok: true, task: entry.task });
  };
  routes['POST /api/task-board/tasks/tsk_a/title'] = ({ body }) => {
    const value = JSON.parse(body); renameCalls.push(value);
    entry.task.title = value.title;
    return json({ ok: true, task: entry.task });
  };
  routes['POST /api/task-board/tasks/tsk_a/relocate'] = ({ body }) => {
    const value = JSON.parse(body); relocateCalls.push(value);
    entry.task.dirId = value.dirId;
    return json({ ok: true, dirId: value.dirId, cwd: '/projects/sandbox', planned: false,
      carried: { patchBytes: 232, files: 1, paths: ['notes/todo.txt'] }, task: entry.task });
  };
  routes['DELETE /api/task-board/tasks/tsk_a'] = () => { deleteCalls.push('tsk_a'); return json({ ok: true, deleted: true, taskIds: ['tsk_a'] }); };

  await withCdpHarness({ routes, screenshotDir: process.env.MULTICC_AIR_LIFECYCLE_QA_DIR || path.join(os.tmpdir(), 'multicc-air-lifecycle-qa') }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason)))` });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?task=tsk_a&dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('task-title')?.textContent==='完善任务协作体验'`), 'task opened');
    assert.equal(await page.evaluate(`document.getElementById('task-title').title`), '双击更改任务标题');
    await page.evaluate(`document.getElementById('task-title').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    assert.ok(await page.waitFor(`document.querySelector('.rename-task-dialog')?.open===true`), 'rename dialog opened');
    assert.equal(await page.evaluate(`document.querySelector('.rename-task-dialog input').value`), '完善任务协作体验');
    await page.evaluate(`(()=>{const input=document.querySelector('.rename-task-dialog input');input.value='手动命名的任务';input.form.requestSubmit();})()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title')?.textContent==='手动命名的任务'`), 'renamed title painted');
    assert.deepEqual(renameCalls, [{ title: '手动命名的任务' }]);
    assert.equal(await page.evaluate(`document.querySelector('#tasks button.selected strong')?.textContent`), '手动命名的任务', 'sidebar title updated too');
    // 后台 CDP 标签的 dialog close 事件需要推进一帧（下方移动弹窗同理）。
    await page.screenshot('rename-dialog-close-frame');
    assert.ok(await page.waitFor(`document.querySelectorAll('.rename-task-dialog').length===0`), 'rename dialog removed');
    assert.ok(await page.waitFor(`document.getElementById('conversation')?.contentDocument?.getElementById('air-delete-task-btn')?.hidden===false`),
      'the chat More menu receives the host-owned delete action');
    assert.equal(await page.evaluate(`(() => {
      const original=window.__multiccAirDeleteCurrentTask;let called=0;
      window.__multiccAirDeleteCurrentTask=()=>called++;
      document.getElementById('conversation').contentDocument.getElementById('air-delete-task-btn').click();
      window.__multiccAirDeleteCurrentTask=original;return called;
    })()`), 1, 'the frame menu delegates deletion to the Air host');
    await page.evaluate(`document.getElementById('details-toggle').click()`);
    const actionLabels = `[...document.querySelectorAll('#task-detail-groups .detail-actions button')].map(b=>b.textContent)`;
    assert.ok(await page.waitFor(`document.querySelector('[data-action="archive"]')!==null`), 'detail actions rendered');
    assert.deepEqual(await page.evaluate(actionLabels), ['归档任务', '移动到其他目录…', '删除任务…']);

    // 归档 → 详情面板换成「恢复任务」，而成功文案要在 refresh 之后还留着。
    await page.evaluate(`document.querySelector('[data-action="archive"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('任务已归档')`),
      'archive notice survives the refresh: ' + await page.evaluate(`document.getElementById('notice').textContent`));
    assert.deepEqual(statusCalls[0], { status: 'archived' });
    assert.ok(await page.waitFor(`document.querySelector('[data-action="restore"]')!==null`), 'archived task offers restore');

    await page.evaluate(`document.querySelector('[data-action="restore"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('任务已恢复')`), 'restore notice shown');
    assert.deepEqual(statusCalls[1], { status: 'active' });

    // 移动：对话框只列别的目录，没选中之前不能提交；被拒绝时对话框留着、说人话。
    await page.evaluate(`document.querySelector('[data-action="move"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.move-task-dialog')?.open===true`), 'move dialog opened');
    await page.screenshot('move-dialog-open');
    // 全局表单规则给所有 input 加了 width:100% 和白底描边；单选钮必须保持它自己的
    // 小方块，否则圆点会漂在卡片中间（这条断言就是为那个回归立的）。
    assert.deepEqual(await page.evaluate(`(()=>{const i=document.querySelector('.move-task-target input'),l=i.closest('label');
      const a=i.getBoundingClientRect(),b=l.getBoundingClientRect();return [Math.round(a.width),Math.round(a.height),a.left-b.left>=12&&a.left-b.left<=14]})()`),
      [16, 16, true], 'the radio keeps its own box at the card edge');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.move-task-target input')].map(i=>i.value)`), ['d2']);
    assert.equal(await page.evaluate(`document.querySelector('.move-task-target strong').textContent`), 'Sandbox');
    assert.equal(await page.evaluate(`document.querySelector('.move-task-footer button.primary').disabled`), true, 'no target, no move');

    await page.evaluate(`(()=>{const i=document.querySelector('.move-task-target input');i.checked=true;i.dispatchEvent(new Event('change'));})()`);
    assert.equal(await page.evaluate(`document.querySelector('.move-task-footer button.primary').disabled`), false);

    await page.evaluate(`document.querySelector('.move-task-footer button.primary').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('任务已移动到 Sandbox')`),
      'move notice: ' + await page.evaluate(`document.getElementById('notice').textContent`));
    assert.deepEqual(relocateCalls[0], { dirId: 'd2' });
    // 后台标签不产帧，`close` 事件排队不推进；截一帧把时间线泵起来（和其他 Air
    // CDP 测试同一手法），再等对话框真的从文档里消失。
    await page.screenshot('move-dialog-frame');
    assert.ok(await page.waitFor(`document.querySelectorAll('.move-task-dialog').length===0`), 'dialog removed after the move');
    assert.ok(await page.waitFor(`location.search.includes('dir=d2')`), 'the page followed the task to its new directory');

    // 删除：确认框要说清不可撤销，删完离开这条任务，列表里不再留影子。
    await page.evaluate(`window.__confirmed=[];window.confirm=text=>{window.__confirmed.push(text);return true}`);
    await page.evaluate(`document.querySelector('[data-action="delete"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('任务已删除')`),
      'delete notice: ' + await page.evaluate(`document.getElementById('notice').textContent`));
    assert.deepEqual(deleteCalls, ['tsk_a']);
    assert.equal(await page.evaluate(`window.__confirmed.length`), 1, 'delete asks once');
    assert.ok((await page.evaluate(`window.__confirmed[0]`)).includes('手动命名的任务'), 'the confirm names the task');
    assert.ok((await page.evaluate(`window.__confirmed[0]`)).includes('不可撤销'), 'the confirm says it cannot be undone');
    assert.equal(await page.evaluate(`location.search.includes('task=')`), false, 'the deleted task is no longer selected');
    assert.deepEqual(await page.evaluate(`(window.__errors||[]).filter(m=>!/Failed to load resource|net::/.test(m))`), []);
  });
});

test('a refused move keeps the dialog open and explains why in Chinese', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const entry = { ok: true, task: { id: 'tsk_b', title: '正在跑的任务', status: 'active', recordType: 'execution' },
    sessionId: 'task-b', ownerShellId: 'shell-b', readOnly: false, status: 'active',
    execution: { busy: true, status: 'running' }, resource: { residency: 'retained', lease: 'active' },
    attribution: {}, configuration: { cli: 'codex' }, roleBindings: null, messages: [] };
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }, { id: 'd2', name: 'Sandbox', path: '/projects/sandbox' }],
    clis: ['codex'], migration: { errors: [] }, tasks: [{ ...entry.task, dirId: 'd1', updatedAt: Date.now(), resource: entry.resource }], sessions: [] });
  routes['/api/air/tasks/tsk_b'] = routes['/api/task-shell-tasks/tsk_b'] = () => json(entry);
  routes['/api/air/resolve'] = () => json({ ok: true, url: '/air?task=tsk_b&dir=d1' });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/providers'] = () => json({ ok: true, available: false, defaults: {}, providers: [] });
  routes['/api/task-shells/shell-b/chat'] = () => json({ activeSessionId: 'task-b', taskId: 'tsk_b' });
  routes['POST /api/task-board/tasks/tsk_b/relocate'] = () => ({ ...json({ ok: false, error: 'task_busy' }), status: 409 });

  await withCdpHarness({ routes, screenshotDir: process.env.MULTICC_AIR_LIFECYCLE_QA_DIR || path.join(os.tmpdir(), 'multicc-air-lifecycle-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?task=tsk_b&dir=d1');
    assert.ok(await page.waitFor(`document.querySelector('[data-action="move"]')!==null || document.getElementById('details-toggle')`), 'task opened');
    await page.evaluate(`document.getElementById('details-toggle').click()`);
    assert.ok(await page.waitFor(`document.querySelector('[data-action="move"]')!==null`), 'move action rendered');
    await page.evaluate(`document.querySelector('[data-action="move"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.move-task-dialog')?.open===true`), 'dialog opened');
    await page.evaluate(`(()=>{const i=document.querySelector('.move-task-target input');i.checked=true;i.dispatchEvent(new Event('change'));})()`);
    await page.evaluate(`document.querySelector('.move-task-footer button.primary').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('任务正在执行或排队中')`),
      'refusal is translated: ' + await page.evaluate(`document.getElementById('notice').textContent`));
    assert.equal(await page.evaluate(`document.querySelector('.move-task-dialog')?.open`), true, 'a refused move keeps the dialog open');
    assert.equal(await page.evaluate(`document.querySelector('.move-task-footer button.primary').disabled`), false, 'the user can retry');
  });
});
