'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('Air task-first console, management views, roles, configuration, artifacts and mobile', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public'), screenshots = [];
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const taskMessages = [{ id: 'u1', role: 'user', content: '请整理本次任务的设计与实现结果。' }, { id: 'a1', role: 'assistant', content: '本任务的交付已整理，可从右侧产物栏打开设计预览与测试结果。',
    tools: [{ id: 'tool-1', name: 'Read', input: { file_path: '/projects/multicc/README.md' }, result: 'ok' }] }];
  const successAttribution = { candidate: { title: '任务体验收口', state: 'pending', blockers: ['integration_receipt_required', 'source_writer_barrier_required'] },
    run: { outcome: 'succeeded', pendingInput: false, codeObserved: true }, integration: null };
  const entry = { ok: true, task: { id: 'tsk_a', title: '完善任务协作体验', recordType: 'planned', workflowStage: 'doing',
    description: '把任务、目录与交付状态收口到同一个 Air 页面。', acceptanceCriteria: '首次打开即可看到计划内容。' }, sessionId: 'task-a', ownerShellId: 'shell-a', readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: { residency: 'planned', lease: 'idle' },
    attribution: {},
    configuration: { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
      model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' }, roleBindings: { version: 0, bindings: [] },
    messages: [] };
  const providerCatalog = { ok: true, available: true, defaults: { codex: 'codex-lab', claude: null }, providers: [
    { id: 'codex-official', appType: 'codex', name: 'Codex Official', apiFormat: 'openai_responses', compatibleClis: ['codex'], isOfficial: true, model: 'gpt-5.5', modelOptions: ['gpt-5.5'], hasToken: true },
    { id: 'codex-lab', appType: 'codex', name: 'Lab Responses', apiFormat: 'openai_responses', compatibleClis: ['codex'], model: 'gpt-5.5', modelOptions: ['gpt-5.5', 'gpt-5.6-sol'], hasToken: true },
    { id: 'codex-backup', appType: 'codex', name: 'Backup Responses', apiFormat: 'openai_responses', compatibleClis: ['codex'], model: 'gpt-5.6-sol', modelOptions: ['gpt-5.6-sol', 'gpt-5.5'], hasToken: true },
  ] };
  const configPatches = [], quickDispatches = [], syncRequests = [];
  let syncFailure = true;
  const directory = { id: 'd1', name: 'MultiCC', path: '/projects/multicc' };
  const airTasks = [{ ...entry.task, dirId: 'd1', status: 'doing', updatedAt: Date.now(), resource: entry.resource }];
  const newEntry = { ...structuredClone(entry), task: { id: 'tsk_new', title: '从目录首页创建任务' }, sessionId: 'task-new', ownerShellId: 'shell-new', messages: [] };
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) routes['/shared/' + file] = {
    body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' },
  };
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/api/air'] = () => json({ ok: true, directories: [directory], clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: airTasks,
    sessions: [{ id: 'old-role', dirId: 'd1', kind: 'chat', label: 'FIXED_ROLE_MUST_NOT_SHOW' }, { id: 'term', dirId: 'd1', kind: 'terminal', label: '终端' }] });
  routes['/api/cron'] = () => json([{ id: 'cron-a', name: '每日体验巡检', dirId: 'd1', dirName: 'MultiCC',
    cli: 'codex', provider: 'codex-lab', model: 'gpt-5.6-sol', prompt: '检查 Air 任务体验并记录结果。', cron: '0 9 * * *', enabled: true,
    taskId: 'tsk_a', taskTitle: entry.task.title, taskStatus: 'active', taskUrl: '/air?task=tsk_a&dir=d1',
    lastRunAt: Date.now() - 60000, lastStatus: 'ok', runCount: 4, nextRunAt: Date.now() + 3600000 }]);
  routes['/api/docs-registry'] = () => json([
    { id: 'service-a', kind: 'service', title: '本地预览服务', url: 'http://127.0.0.1:4173', status: 'down', startCmd: 'npm run preview', source: 'manual', pinned: true },
    { id: 'page-a', kind: 'page', title: 'Air 改造说明', url: '/docs/air.html', source: 'artifact' },
  ]);
  routes['/api/air/tasks/tsk_a'] = routes['/api/task-shell-tasks/tsk_a'] = () => json(entry);
  routes['/api/air/tasks/tsk_new'] = routes['/api/task-shell-tasks/tsk_new'] = () => json(newEntry);
  routes['POST /api/air/tasks'] = ({ body }) => {
    const value = JSON.parse(body);
    airTasks.push({ ...newEntry.task, dirId: 'd1', status: 'active', updatedAt: Date.now(), resource: newEntry.resource });
    return json({ ok: true, taskId: 'tsk_new', sessionId: 'task-new', shellId: 'shell-new' });
  };
  routes['POST /api/task-shell-tasks/tsk_new/messages'] = ({ body }) => { quickDispatches.push(JSON.parse(body)); return json({ ok: true, taskId: 'tsk_new', sessionId: 'task-new' }); };
  routes['POST /api/task-board/tasks/tsk_a/chat-session'] = () => json({ ok: true, sessionId: 'task-a' });
  routes['POST /api/task-board/tasks/tsk_new/chat-session'] = () => json({ ok: true, sessionId: 'task-new' });
  routes['POST /api/task-shells'] = ({ body }) => json({ id: JSON.parse(body).sessionId === 'task-new' ? 'shell-new' : 'shell-a' });
  routes['POST /api/task-shells/shell-a/tasks/resolve'] = () => json({ sessionId: 'task-a' });
  routes['POST /api/task-shells/shell-new/tasks/resolve'] = () => json({ sessionId: 'task-new' });
  routes['/api/task-shells/shell-a/chat'] = () => json({ activeSessionId: 'task-a', taskId: 'tsk_a' });
  routes['/api/sessions/task-a/merge-status'] = () => json({ branch: 'multicc/task-a', baseBranch: 'main', behind: 2 });
  routes['POST /api/task-shell-tasks/tsk_a/messages'] = async ({ body }) => {
    syncRequests.push(JSON.parse(body));
    await new Promise(resolve => setTimeout(resolve, 100));
    return syncFailure ? { ...json({ ok: false, error: 'temporary failure' }), status: 503 }
      : json({ ok: true, decision: 'queued', sessionId: 'task-a', taskId: 'tsk_a' });
  };
  routes['/api/task-shells/shell-new/chat'] = () => json({ activeSessionId: 'task-new', taskId: 'tsk_new' });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/air/tasks/tsk_a/roles'] = ({ body }) => { const value = JSON.parse(body); entry.roleBindings = { version: entry.roleBindings.version + 1, bindings: value.bindings }; return json({ ok: true, roleBindings: entry.roleBindings }); };
  routes['/api/agent-presets'] = () => json({ presets: [{ id: 'designer', name: '设计师' }] });
  routes['/api/agent-presets/designer'] = () => json({ name: '设计师', prompt: '关注清晰、轻盈的交互' });
  routes['/api/air/resolve'] = () => json({ ok: true, url: '/air?task=tsk_a&dir=d1' });
  routes['/api/providers'] = () => json(providerCatalog);
  routes['PATCH /api/sessions/task-a'] = ({ body }) => {
    const value = JSON.parse(body); configPatches.push(value); Object.assign(entry.configuration, value);
    if (Object.hasOwn(value, 'provider')) {
      const selected = providerCatalog.providers.find(provider => provider.id === value.provider);
      entry.configuration.providerName = selected?.name || null;
      entry.configuration.effectiveModel = selected?.model || null;
    }
    if (Object.hasOwn(value, 'model')) entry.configuration.effectiveModel = value.model;
    return json({ ok: true });
  };
  routes['/api/task-shell-tasks/tsk_a/artifacts'] = routes['/api/task-shells/shell-a/artifacts'] = () => json({ taskId: 'tsk_a', title: entry.task.title, items: [
    { url: '/artifacts/design/index.html', title: 'MultiCC Air · 任务设计', kind: 'page', available: true },
    { url: '/artifacts/qa/results.json', title: '任务验收结果', kind: 'file', available: true },
  ] });
  const screenshotDir = process.env.MULTICC_TASK_FIRST_QA_DIR || path.join(os.tmpdir(), 'multicc-task-first-qa');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason)))` });
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/task-entry.html?session=old-role');
    assert.ok(await page.waitFor(`location.pathname==='/air' && document.getElementById('task-title')?.textContent==='完善任务协作体验'`));
    assert.equal(await page.evaluate(`document.getElementById('sidebar').contains(document.getElementById('task-sidebar'))`), true);
    const frame = `document.getElementById('conversation').contentDocument`;
    // AI 配置 and 角色 live on the composer card inside the conversation frame;
    // the host page renders them there (air.js → renderComposerControls), so
    // these assertions read the frame, not the task header.
    const composerPill = id => `${frame}.getElementById('${id}')`;
    assert.ok(await page.waitFor(`${frame}?.URL.includes('session=task-a') && ${frame}.readyState==='complete'`));
    assert.ok(await page.waitFor(`${frame}?.body.classList.contains('air-chat') && ${frame}?.getElementById('input')`));
    assert.ok(await page.waitFor(`${frame}.getElementById('merge-btn').parentElement.id==='header-more-menu'`));
    assert.equal(await page.evaluate(`${frame}.getElementById('session-queue-dock')!==null && ${frame}.getElementById('aux-classify-bar')!==null`), true);
    assert.equal(await page.evaluate(`${frame}.getElementById('goal-btn')!==null && ${frame}.getElementById('merge-btn')!==null && ${frame}.getElementById('diff-modal')!==null`), true);
    assert.ok(await page.waitFor(`${frame}.getElementById('worktree-force-sync-btn')`), JSON.stringify({ requests: page.requests.filter(r=>/merge-status/.test(r.path)), state: await page.evaluate(`({url:${frame}.URL,errors:${frame}.defaultView.__errors,bar:${frame}.getElementById('worktree-bar').outerHTML})`) }));
    assert.equal(await page.evaluate(`${frame}.getElementById('worktree-sync-btn')!==null && ${frame}.getElementById('worktree-bar').offsetHeight>0`), true);
    assert.equal(await page.evaluate(`['header','worktree-bar','aux-classify-bar'].every(id=>${frame}.getElementById(id).parentElement.id==='chat-context-bar')`), true);
    assert.equal(await page.evaluate(`document.getElementById('delivery-card').closest('#task-details')!==null && document.getElementById('delivery-card').offsetHeight===0`), true, 'delivery details take no space above chat');
    assert.equal(await page.evaluate(`document.getElementById('conversation').getBoundingClientRect().top===document.getElementById('task-header').getBoundingClientRect().bottom`), true, 'two adjacent bands, no intervening delivery card');
    await page.evaluate(`document.getElementById('task-state').click()`);
    assert.equal(await page.evaluate(`document.getElementById('delivery-card').offsetHeight>0 && document.getElementById('task-state').getAttribute('aria-expanded')==='true'`), true);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.ok(await page.waitFor(`document.getElementById('task-details').hidden && document.getElementById('task-state').getAttribute('aria-expanded')==='false'`));
    await page.evaluate(`${frame}.getElementById('input').value='同步期间保留草稿';${frame}.getElementById('worktree-force-sync-btn').click();${frame}.getElementById('worktree-force-sync-btn').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('worktree-force-sync-btn').textContent==='重试同步指令'`));
    assert.equal(syncRequests.length, 1, 'double click does not duplicate requests');
    syncFailure = false;
    await page.evaluate(`${frame}.getElementById('worktree-force-sync-btn').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('messages').textContent.includes('同步指令已加入 FIFO')`));
    assert.equal(syncRequests.length, 2);
    assert.equal(syncRequests[0].clientMsgId, syncRequests[1].clientMsgId, 'ambiguous failure retries with same receipt key');
    assert.equal(syncRequests[1].intent, 'work');
    assert.match(syncRequests[1].text, /保留所有未提交/);
    assert.equal(await page.evaluate(`${frame}.getElementById('input').value`), '同步期间保留草稿');
    assert.equal(page.requests.some(r => r.method === 'POST' && /\/(sync|rebase|queue\/action)$/.test(r.path)), false);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.ok(await page.evaluate(`${frame}.getElementById('messages').getBoundingClientRect().width>1200`), 'actual Air chat fills wide viewport');
    await page.evaluate(`document.querySelector('[data-chat-layout]').click();document.querySelector('[name=limited]').click();const range=document.querySelector('[name=width]');range.value=1000;range.dispatchEvent(new Event('input'));document.querySelector('button[value=save]').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('messages').getBoundingClientRect().width===1000`));
    assert.equal(await page.evaluate(`${frame}.getElementById('input-bar').getBoundingClientRect().width`), 1000);
    await page.evaluate(`document.querySelector('[data-chat-layout]').click();document.querySelector('[name=reset]').click();document.querySelector('button[value=save]').click()`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(()=>{const d=${frame},w=d.defaultView,v=w.MultiCCChatHistoryView.createHistoryView({document:d,messagesEl:d.getElementById('messages'),safeMarkdown:w.MultiCCSafeMarkdown});v.clearMessages();d.getElementById('messages').append(...${JSON.stringify(taskMessages)}.map(m=>v.renderMessage(m)));w.MultiCCChatSessionQueue.render([{entryId:'fifo-1',position:1,state:'pending',text:'继续检查移动端布局'}],{state:'running'},d);w.renderAuxClassify('完善 Air 对话体验','verifying','W')})()`);
    assert.equal(await page.evaluate(`${frame}.querySelector('.tool-card .tool-name').textContent`), 'Read');
    assert.ok(await page.evaluate(`${frame}.getElementById('chat-context-bar').getBoundingClientRect().height<=55`), 'desktop runtime controls fit one row even when disconnected');
    await page.evaluate(`${frame}.getElementById('messages').style.cssText='position:relative;z-index:99999';${frame}.getElementById('header-more-btn').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('header-more-menu').matches(':popover-open')`));
    assert.equal(await page.evaluate(`(()=>{const d=${frame},m=d.getElementById('header-more-menu'),r=m.getBoundingClientRect();return m.contains(d.elementFromPoint(r.left+20,r.top+30))})()`), true, 'Air menu receives clicks above tool messages');
    await page.evaluate(`${frame}.getElementById('header-more-btn').click();${frame}.getElementById('messages').style.cssText=''`);
    assert.equal(await page.evaluate(`${frame}.getElementById('session-queue-count').textContent`), '1');
    assert.equal(await page.evaluate(`${frame}.getElementById('aux-classify-bar').classList.contains('show')`), true);
    await page.evaluate(`${frame}.defaultView.applyMergeStatus({branch:'multicc/task-a',baseBranch:'main',behind:2,conflict:true,conflictFiles:['example.js']})`);
    assert.equal(await page.evaluate(`${frame}.getElementById('worktree-conflict-bar').parentElement.id`), 'chat-context-bar');
    assert.equal(await page.evaluate(`${frame}.querySelectorAll('#worktree-conflict-bar button').length`), 3);
    await page.evaluate(`${frame}.defaultView.refreshMergeStatus()`);
    assert.equal(await page.evaluate(`document.getElementById('task-state').textContent.includes('计划待执行')`), true);
    entry.messages = taskMessages; entry.execution = { busy: true, status: 'running' };
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-state').textContent.includes('本轮 执行中')`));
    await page.evaluate(`${frame}.defaultView.renderAuxClassify('完善 Air 对话体验','implementing','P')`);
    screenshots.push(await page.screenshot('two-bars-desktop'));
    entry.execution = { busy: false, status: 'idle' };
    entry.messages = taskMessages; entry.attribution = successAttribution;
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('delivery-card').innerText.includes('建议归入「任务体验收口」')`));
    assert.equal(await page.evaluate(`document.getElementById('delivery-card').innerText.includes('建议归入「任务体验收口」')`), true);
    assert.equal(await page.evaluate(`document.getElementById('delivery-destination').textContent.includes('完善任务协作体验')`), true);
    await page.evaluate(`document.getElementById('details-toggle').click()`);
    assert.equal(await page.evaluate(`document.getElementById('task-detail-groups').children.length`), 4);
    assert.equal(await page.evaluate(`document.getElementById('task-details').innerText.includes('把任务、目录与交付状态收口到同一个 Air 页面。') && document.getElementById('task-details').innerText.includes('首次打开即可看到计划内容。')`), true);
    await page.evaluate(`document.getElementById('details-close').click()`);
    assert.equal(await page.evaluate(`document.body.innerText.includes('FIXED_ROLE_MUST_NOT_SHOW')`), false);
    assert.equal(await page.evaluate(`document.querySelectorAll('a[href*="chat.html"]').length`), 0);
    assert.ok(await page.waitFor(`${composerPill('air-role-pill')}?.textContent.length>0`), '角色 renders on the composer card');
    await page.evaluate(`${composerPill('air-role-pill')}.click()`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] select option[value=designer]')`));
    await page.evaluate(`const p=document.querySelector('dialog[open] select');p.value='designer';p.dispatchEvent(new Event('change'))`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] textarea')?.value==='关注清晰、轻盈的交互'`));
    await page.evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`!document.querySelector('dialog[open]')`));
    assert.equal(entry.roleBindings.bindings[0].name, '设计师');
    assert.equal(page.requests.some(r => /role-workers|\/sessions$/.test(r.path) && r.method !== 'GET'), false);
    assert.ok(await page.waitFor(`${composerPill('air-ai-pill')}?.textContent.includes('Lab Responses')`), 'AI 配置 renders on the composer card');
    await page.evaluate(`${composerPill('air-ai-pill')}.click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-provider-option[data-value="codex-lab"].selected')`));
    assert.equal(await page.evaluate(`document.querySelector('.air-cli-option.selected strong').textContent`), 'Codex');
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-provider-option').length`), 5);
    assert.equal(await page.evaluate(`document.querySelector('.air-provider-option[data-value^="__auto__"] .air-provider-copy strong').textContent.includes('Auto')`), true);
    await page.evaluate(`(()=>{const r=document.querySelector('.air-provider-option[data-value="codex-backup"] input');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}));const m=document.querySelector('.air-config-field select[aria-label="模型"]');m.value='gpt-5.6-sol';document.querySelector('select[aria-label="推理强度"]').value='high';document.querySelector('.air-config-form').requestSubmit()})()`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.equal(configPatches.length, 2);
    assert.deepEqual(configPatches[0], { provider: 'codex-backup', providerSelection: null });
    assert.deepEqual(configPatches[1], { model: 'gpt-5.6-sol', effort: 'high' });
    assert.ok(await page.waitFor(`${composerPill('air-ai-pill')}.textContent.includes('Backup Responses') && ${composerPill('air-ai-pill')}.textContent.includes('gpt-5.6-sol')`));
    entry.configuration.pendingConfiguration = { cli: 'codex', profile: { provider: 'codex-lab', model: 'gpt-5.5', effort: 'low' } };
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`${composerPill('air-ai-pill')}.textContent.includes('下轮生效')`));
    assert.equal(await page.evaluate(`${composerPill('air-ai-pill')}.textContent.includes('gpt-5.5') && !${composerPill('air-ai-pill')}.textContent.includes('Backup Responses')`), true);
    await page.evaluate(`${composerPill('air-ai-pill')}.click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-provider-option[data-value="codex-lab"].selected')`));
    assert.equal(await page.evaluate(`document.querySelector('dialog[open] select[aria-label="推理强度"]').value`), 'low');
    await page.evaluate(`document.querySelector('dialog[open] .air-config-close').click()`);
    entry.configuration.pendingConfiguration = null;
    await page.evaluate(`${frame}.defaultView.MultiCCTaskArtifacts.setScope({shellId:'shell-a'})`);
    assert.ok(await page.waitFor(`${frame}?.getElementById('task-artifacts-toggle')?.textContent==='产物 2'`));
    assert.equal(await page.evaluate(`${frame}.getElementById('task-artifacts-toggle').parentElement.id`), 'header-more-menu');
    await page.evaluate(`${frame}.getElementById('input').value='未发送的草稿';${frame}.getElementById('task-artifacts-toggle').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('task-artifacts-panel').hidden===false`));
    screenshots.push(await page.screenshot('task-only-desktop'));
    await page.evaluate(`${frame}.getElementById('task-artifacts-close').click()`);
    assert.equal(await page.evaluate(`${frame}.getElementById('input').value`), '未发送的草稿');
    const successfulAttribution = entry.attribution;
    entry.execution.status = 'error'; entry.attribution = {};
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('delivery-title').textContent==='任务保持进行中'`));
    assert.equal(await page.evaluate(`document.getElementById('delivery-card').hidden`), false);
    assert.equal(await page.evaluate(`document.getElementById('task-state').textContent.includes('本轮 失败')`), true);
    entry.execution.status = 'idle'; entry.attribution = successfulAttribution;
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('delivery-title').textContent.includes('任务体验收口')`));
    await page.evaluate(`document.getElementById('schedules').click()`);
    assert.ok(await page.waitFor(`document.getElementById('schedule-center').hidden===false && document.querySelector('.schedule-fixed-task')`));
    // Every view paints one heading band — the shell header — so the page copy
    // moved out of the body and the view keeps only its actions.
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent==='定时任务' && document.getElementById('task-state').textContent.includes('写入同一任务')`), true);
    assert.equal(await page.evaluate(`document.querySelector('#schedule-center .schedule-hero')===null && document.querySelector('#task-header #schedule-create')!==null`), true);
    assert.equal(await page.evaluate(`document.querySelector('.schedule-fixed-task').innerText.includes('tsk_a')`), true);
    await page.evaluate(`document.getElementById('schedule-create').click()`);
    assert.ok(await page.waitFor(`document.getElementById('schedule-dialog').open===true`));
    assert.equal(await page.evaluate(`document.getElementById('schedule-form').elements.cli.options.length`), 2);
    await page.evaluate(`document.getElementById('schedule-close').click()`);
    screenshots.push(await page.screenshot('scheduled-air-tasks-desktop'));
    await page.evaluate(`document.querySelector('.schedule-fixed-task').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='完善任务协作体验'`));
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`!document.getElementById('empty').hidden && document.querySelectorAll('.directory-stat').length===4`));
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent.includes('MultiCC') && document.getElementById('task-state').textContent.includes('/projects/multicc')`), true);
    assert.equal(await page.evaluate(`document.querySelectorAll('.directory-task-row').length`), 1);
    await page.evaluate(`document.getElementById('quick-task-input').value='从目录首页创建任务';document.getElementById('quick-task-goal').checked=true;document.getElementById('quick-task-form').requestSubmit()`);
    assert.ok(await page.waitFor(`location.search.includes('task=tsk_new')`));
    assert.equal(quickDispatches.length, 1);
    assert.equal(quickDispatches[0].text, '从目录首页创建任务');
    assert.equal(quickDispatches[0].goal, true);
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.getElementById('admin-center').hidden===false && document.querySelectorAll('.admin-stat').length===4`));
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), '控制台');
    assert.equal(await page.evaluate(`document.querySelectorAll('.admin-directory-row').length`), 1);
    assert.equal(await page.evaluate(`document.querySelector('.admin-directory-row').innerText.includes('MultiCC')`), true);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.air-legacy-frame')].filter(x=>x.offsetParent).length`), 0);
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    screenshots.push(await page.screenshot('air-console-desktop'));
    await page.evaluate(`document.querySelector('[data-air-view="docs"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='服务与文档' && document.querySelectorAll('.air-doc-card').length===2`));
    assert.equal(await page.evaluate(`document.getElementById('air-doc-summary').textContent.includes('2 条登记')`), true);
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-legacy-frame').length`), 0);
    await page.evaluate(`document.querySelector('[data-air-view="settings"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='设置中心' && document.querySelectorAll('.air-setting-card').length===10`));
    assert.equal(await page.evaluate(`document.body.innerText.includes('Provider 配置')`), true);
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')].find(x=>x.innerText.includes('Provider 配置')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='CLI 与 Provider' && document.querySelectorAll('.air-provider-card').length===3`));
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.air-legacy-frame')].filter(x=>x.offsetParent).length`), 0);
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-provider-defaults select').length`), 2);
    assert.equal(await page.evaluate(`document.getElementById('air-provider-count').textContent.includes('3 条线路')`), true);
    await page.evaluate(`document.querySelector('#admin-actions .primary').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-provider-dialog').open===true`));
    assert.equal(await page.evaluate(`document.getElementById('air-provider-form').elements.apiFormat.value`), 'anthropic');
    await page.evaluate(`document.getElementById('air-provider-close').click()`);
    entry.execution = { busy: true, status: 'running' }; entry.attribution = {};
    await page.navigate('/air?task=tsk_a&dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='完善任务协作体验'`));
    assert.ok(await page.waitFor(`${frame}?.URL.includes('session=task-a') && ${frame}.readyState==='complete'`));
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      assert.equal(await page.evaluate(`innerWidth`), width);
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      assert.equal(await page.evaluate(`${frame}.documentElement.scrollWidth<=${frame}.documentElement.clientWidth`), true);
      assert.ok(await page.waitFor(`${frame}.getElementById('worktree-force-sync-btn')`));
      assert.equal(await page.evaluate(`${frame}.getElementById('worktree-force-sync-btn').getBoundingClientRect().right<=${frame}.documentElement.clientWidth`), true);
      await page.evaluate(`${frame}.defaultView.renderAuxClassify('完善任务协作体验，保留所有同步与状态操作','implementing','P')`);
      assert.ok(await page.evaluate(`${frame}.getElementById('chat-context-bar').getBoundingClientRect().height<=105`), JSON.stringify(await page.evaluate(`({width:innerWidth,groups:['chat-context-bar','header','worktree-bar','aux-classify-bar'].map(id=>({id,rect:${frame}.getElementById(id).getBoundingClientRect().toJSON()}))})`)));
      assert.equal(await page.evaluate(`${frame}.getElementById('ac-cancel-task').getBoundingClientRect().right<=${frame}.documentElement.clientWidth`), true);
      const mobileLayout = await page.evaluate(`(()=>{const s=document.getElementById('sidebar'),r=s.getBoundingClientRect();return {sidebarLeft:r.left,sidebarRight:r.right,sidebarWidth:r.width,transform:getComputedStyle(s).transform,position:getComputedStyle(s).position,bodyClass:document.body.className,media:matchMedia('(max-width:760px)').matches}})()`);
      assert.equal(mobileLayout.sidebarRight <= 0, true, JSON.stringify(mobileLayout));
      assert.equal(await page.evaluate(`getComputedStyle(${composerPill('air-ai-pill')}).display!=='none'`), true);
      assert.equal(await page.evaluate(`${composerPill('air-role-pill')}.getBoundingClientRect().right<=${frame}.documentElement.clientWidth`), true);
      if (width === 390) {
        await page.evaluate(`${composerPill('air-ai-pill')}.click()`);
        assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] .air-provider-list')`));
        assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog').scrollWidth<=document.querySelector('.air-config-dialog').clientWidth`), true);
        await page.evaluate(`document.querySelector('.air-config-close').click()`);
      }
      screenshots.push(await page.screenshot('two-bars-mobile-' + width));
    }
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      await page.navigate('/air?view=overview');
      assert.ok(await page.waitFor(`document.getElementById('admin-center').hidden===false && document.querySelectorAll('.admin-stat').length===4`));
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      assert.equal(await page.evaluate(`document.getElementById('task-title').getBoundingClientRect().right<=innerWidth`), true);
      screenshots.push(await page.screenshot('air-console-mobile-' + width));
    }
    await page.navigate('/air?view=provider');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='CLI 与 Provider' && document.querySelectorAll('.air-provider-card').length===3`));
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('air-provider-cards')).gridTemplateColumns.split(' ').length`), 1);
    await page.evaluate(`document.querySelector('#admin-actions .primary').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-provider-dialog').open===true`));
    assert.equal(await page.evaluate(`document.getElementById('air-provider-dialog').scrollWidth<=document.getElementById('air-provider-dialog').clientWidth`), true);
    screenshots.push(await page.screenshot('air-provider-mobile-320'));
    await page.evaluate(`document.getElementById('air-provider-close').click()`);
    await page.evaluate(`document.getElementById('mobile-nav').click()`);
    assert.equal(await page.evaluate(`document.getElementById('sidebar').getBoundingClientRect().left>=0`), true);
    await page.evaluate(`document.getElementById('nav-scrim').click()`);
    assert.equal(await page.evaluate(`document.getElementById('sidebar').getBoundingClientRect().right<=0`), true);
    assert.deepEqual(await page.evaluate('window.__errors||[]'), []);
    assert.deepEqual(await page.evaluate(`document.getElementById('conversation').contentWindow.__errors||[]`), []);
  });
  fs.mkdirSync(screenshotDir, { recursive: true }); fs.writeFileSync(path.join(screenshotDir, 'screenshots.json'), JSON.stringify(screenshots, null, 2));
});
