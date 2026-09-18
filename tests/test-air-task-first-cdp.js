'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// The console panel slides in over a 300ms CSS transition. The test target is a
// background one — it never renders and never produces frames, so the document
// timeline does not advance and a bare wait leaves the panel parked at its start
// position. Capturing a frame is what pumps the timeline; wait the transition out
// between two captures and the panel has genuinely arrived.
const settleOverlay = async page => {
  await page.screenshot('overlay-frame');
  await page.evaluate(`new Promise(done => setTimeout(done, 400))`);
  await page.screenshot('overlay-frame');
};

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
  const configPatches = [], quickDispatches = [], quickCreates = [], syncRequests = [];
  let syncFailure = true;
  const directory = { id: 'd1', name: 'MultiCC', path: '/projects/multicc' };
  const otherDirectory = { id: 'd2', name: 'Design Lab', path: '/projects/design-lab' };
  const airTasks = [{ ...entry.task, dirId: 'd1', status: 'doing', updatedAt: Date.now(), resource: entry.resource },
    // 另一个目录里、这次会话从没打开过的一条：用来证明「pin 会把它拉到侧栏最
    // 上面」—— 它本来既不在最近记录里，也不在当前目录里。
    { id: 'tsk_far', dirId: 'd2', title: '远端目录里的任务', status: 'active', recordType: 'planned',
      workflowStage: 'doing', runState: null, updatedAt: Date.now() - 86400000, resource: { residency: 'resident', lease: 'idle' } }];
  let taskPins = [];
  const newEntry = { ...structuredClone(entry), task: { id: 'tsk_new', title: '从目录首页创建任务' }, sessionId: 'task-new', ownerShellId: 'shell-new', messages: [] };
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) routes['/shared/' + file] = {
    body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' },
  };
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/api/air'] = () => json({ ok: true, directories: [directory, otherDirectory], clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: airTasks, taskPins,
    sessions: [{ id: 'old-role', dirId: 'd1', kind: 'chat', label: 'FIXED_ROLE_MUST_NOT_SHOW' }, { id: 'term', dirId: 'd1', kind: 'terminal', label: '终端' }] });
  // Pin：页头顶上那排「齐刘海」。清单住在服务端（air-pins.json），Web 和 App 读
  // 的是同一份 —— 这里就按服务端那两条路由的行为来桩：单点 toggle、整份替换。
  const pinPosts = [];
  routes['POST /api/air/pins/toggle'] = ({ body }) => {
    const { taskId } = JSON.parse(body);
    pinPosts.push(taskId);
    taskPins = taskPins.includes(taskId) ? taskPins.filter(id => id !== taskId) : [...taskPins, taskId];
    return json({ ok: true, taskIds: taskPins });
  };
  routes['POST /api/air/pins'] = ({ body }) => { taskPins = JSON.parse(body).taskIds || []; return json({ ok: true, taskIds: taskPins }); };
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
  // AI Assistant(aux)控制台页的三个数据源:状态、配置、运行记录。
  const auxPosts = [];
  routes['/api/aux/status'] = () => json({ processing: false, queueDepth: 1, totalProcessed: 137, lastTaskTime: Date.now() - 64000, currentTask: null, health: { unhealthy: false } });
  routes['/api/aux/config'] = () => json({
    protocol: 'openai', providerId: 'codex-lab', model: 'gpt-5.5',
    protocols: [{ id: 'anthropic', name: 'Anthropic Messages' }, { id: 'openai', name: 'OpenAI Responses / Chat Completions' }],
    providersByProtocol: {
      anthropic: [],
      openai: [{ id: 'codex-lab', name: 'Lab Responses', wireApi: 'responses', modelOptions: ['gpt-5.5', 'gpt-5.6-sol'] }],
    },
  });
  routes['POST /api/aux/config'] = ({ body }) => { auxPosts.push(JSON.parse(body)); return json({ ok: true, protocol: 'openai', providerId: 'codex-lab', model: 'gpt-5.6-sol' }); };
  routes['/api/aux/history?limit=100'] = routes['/api/aux/history'] = () => json([
    { role: 'user', content: '判断任务意图\n把安装包归档', ts: Date.now() - 3600000, taskType: 'classify', meta: { sessionName: '整理下载目录' } },
    { role: 'assistant', content: 'organize', ts: Date.now() - 3599000, durationMs: 1000, enqueuedAt: Date.now() - 3600000, startedAt: Date.now() - 3599800, queueMs: 200 },
  ]);
  routes['POST /api/air/tasks'] = ({ body }) => {
    const value = JSON.parse(body);
    quickCreates.push(value);
    airTasks.push({ ...newEntry.task, dirId: value.dirId, status: 'active', updatedAt: Date.now(), resource: newEntry.resource });
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
  // 目录首页的 Git 状态卡：主检出的未推送提交与 worktree 之外的脏文件。
  routes['/api/git/directory-status'] = () => json({ branch: 'main', upstream: 'origin/main', baseBranch: 'main', ahead: 2, behind: 1,
    dirtyFiles: [{ status: 'M', path: 'README.md' }, { status: '??', path: 'notes/scratch.md' }] });
  routes['/api/git/log'] = () => json({ repoPath: '/projects/multicc', commits: [
    { hash: 'c2'.repeat(20), short: 'c2c2c2c', author: 'green', date: '2026-09-17T10:00:00+08:00', subject: 'Air 目录首页加 Git 状态', refs: 'HEAD -> main' },
    { hash: 'c1'.repeat(20), short: 'c1c1c1c', author: 'green', date: '2026-09-16T09:00:00+08:00', subject: '上一条提交', refs: '' },
  ] });
  routes['/api/git/commit-diff'] = () => json({ hash: 'c2'.repeat(20), stat: ' air.js | 2 ++', diff: '+新增一行', truncated: false, error: null });
  routes['POST /api/task-shell-tasks/tsk_a/messages'] = async ({ body }) => {
    syncRequests.push(JSON.parse(body));
    await new Promise(resolve => setTimeout(resolve, 100));
    return syncFailure ? { ...json({ ok: false, error: 'temporary failure' }), status: 503 }
      : json({ ok: true, decision: 'queued', sessionId: 'task-a', taskId: 'tsk_a' });
  };
  routes['/api/task-shells/shell-new/chat'] = () => json({ activeSessionId: 'task-new', taskId: 'tsk_new' });
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/air/tasks/tsk_a/roles'] = ({ body }) => { const value = JSON.parse(body); entry.roleBindings = { version: entry.roleBindings.version + 1, bindings: value.bindings }; return json({ ok: true, roleBindings: entry.roleBindings }); };
  routes['/api/air/tasks/tsk_new/roles'] = ({ body }) => { const value = JSON.parse(body); newEntry.roleBindings = { version: 1, bindings: value.bindings }; newEntry.messages = [...(newEntry.messages || []), { id: 'u-new', role: 'user', content: '从目录首页创建任务' }]; return json({ ok: true, roleBindings: newEntry.roleBindings }); };
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
    // ── Pin：页头顶上那排「齐刘海」 ─────────────────────────────────────
    // 占的是标题和工具之间那块空档，内容跟侧栏任务卡一样（状态、标题、目录、
    // 阶段），默认缩略、鼠标停上去才展开成完整的一张。最上面那条边贴着页头
    // 顶边（这就是「齐刘海」），所以它看起来是「挂」在页头下面的。
    assert.equal(await page.evaluate(`document.getElementById('task-pins').hidden`), true, '还没 pin 的时候这一排不占位');
    assert.equal(await page.evaluate(`document.getElementById('pin-task').hidden`), false, '打开着任务时才给这颗 📌');
    const settlePins = async name => {
      await page.screenshot(name);
      await page.evaluate(`new Promise(done => setTimeout(done, 400))`);
      await page.screenshot(name);
    };
    await page.evaluate(`document.getElementById('pin-task').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#task-pins .pin-tab').length===1`));
    assert.deepEqual(pinPosts, ['tsk_a'], '单点 toggle 打的是服务端那条路由');
    assert.equal(await page.evaluate(`document.getElementById('pin-task').getAttribute('aria-pressed')`), 'true');
    const pinCollapsed = await page.evaluate(`(()=>{const tab=document.querySelector('#task-pins .pin-tab'),r=tab.getBoundingClientRect(),h=document.getElementById('task-header').getBoundingClientRect(),p=document.getElementById('pin-task').getBoundingClientRect();
      const label=tab.querySelector('.pin-status .mc-status-label');
      return { task:tab.dataset.task, title:tab.querySelector('.pin-title').textContent,
        top:Math.round(r.top), bottom:Math.round(r.bottom), width:Math.round(r.width),
        headerTop:Math.round(h.top), headerRight:Math.round(h.right), pinLeft:Math.round(p.left),
        meta:getComputedStyle(tab.querySelector('.pin-meta')).display, label:getComputedStyle(label).display,
        cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2) };})()`);
    assert.equal(pinCollapsed.task, 'tsk_a');
    assert.equal(pinCollapsed.title, '完善任务协作体验');
    assert.equal(pinCollapsed.top, pinCollapsed.headerTop, '上边贴着页头最上面（齐刘海）');
    assert.equal(pinCollapsed.meta, 'none', '缩略态只有状态和标题，没有目录/阶段那一行');
    assert.equal(pinCollapsed.label, 'none', '缩略态的状态只留图标');
    assert.ok(pinCollapsed.width < 140 && pinCollapsed.width >= 46, '缩略态是一条窄标签：' + pinCollapsed.width);
    assert.ok(pinCollapsed.bottom > pinCollapsed.headerTop + 30, '它是从顶上垂下来的一张卡，不是一个点');
    assert.ok(pinCollapsed.width < pinCollapsed.pinLeft, '它排在工具条左边，占的正是标题后面那块空档');
    // 先留一张缩略态的图（默认长这样），再进 hover 展开。
    await settlePins('task-pins-collapsed');
    // 悬停展开：状态标签、目录、阶段一起出来，卡片变宽。
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pinCollapsed.cx, y: pinCollapsed.cy, buttons: 0 });
    await settlePins('task-pins-hover-probe');
    const pinOpen = await page.evaluate(`(()=>{const tab=document.querySelector('#task-pins .pin-tab');return { width:Math.round(tab.getBoundingClientRect().width),
      meta:tab.querySelector('.pin-meta').textContent, label:tab.querySelector('.pin-status .mc-status-label').textContent };})()`);
    assert.ok(pinOpen.width > pinCollapsed.width, `展开要比缩略宽（${pinCollapsed.width} → ${pinOpen.width}）`);
    assert.ok(pinOpen.meta.includes('MultiCC'), '展开里有目录：' + pinOpen.meta);
    assert.ok(pinOpen.meta.includes('进行中'), '展开里有阶段：' + pinOpen.meta);
    assert.ok(pinOpen.label.length > 0, '展开的状态带着中文标签');
    screenshots.push(await page.screenshot('task-pins-desktop'));
    // 点这张卡就是打开那条任务（这里已经打开着它，地址不变）。
    await page.evaluate(`document.querySelector('#task-pins .pin-open').click()`);
    assert.ok(await page.waitFor(`new URLSearchParams(location.search).get('task')==='tsk_a'`));
    // 取消 pin：× 是独立的一颗按钮（不能套在打开按钮里面 —— 那不是一个合法的按钮）。
    assert.equal(await page.evaluate(`document.querySelectorAll('#task-pins .pin-open .pin-x').length`), 0);
    await page.evaluate(`document.querySelector('#task-pins .pin-x').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-pins').hidden===true`));
    assert.deepEqual(pinPosts, ['tsk_a', 'tsk_a'], '取消 pin 走的是同一条 toggle');
    assert.equal(await page.evaluate(`document.getElementById('pin-task').getAttribute('aria-pressed')`), 'false');
    // 页头下面那条 #notice 是页面的状态行，pin 的回执在这儿说一句 —— 真机上 4 秒
    // 一次的轮询会把它擦掉，但这个后台 target 不产帧、轮询不跑。后面那些断言量的
    // 是「页头和对话之间什么都没有」，所以这里把它收干净。
    await page.evaluate(`document.getElementById('notice').textContent=''`);

    const frame = `document.getElementById('conversation').contentDocument`;
    // AI 配置 and 角色 live on the composer card inside the conversation frame;
    // the host page renders them there (air.js → renderComposerControls), so
    // these assertions read the frame, not the task header.
    const composerPill = id => `${frame}.getElementById('${id}')`;
    // The conversation's pills and the new-task form's pills are one control in
    // two places, so the guard compares what the two actually render — radius,
    // padding, font, fill, edge, and the ◆ prefix — rather than just checking a
    // class name is present. air.js builds the conversation's pair at runtime
    // and once built them without `mc-composer__pill`, which dropped them to the
    // browser's default button: square, unpadded, and missing the ◆, so the band
    // read as misaligned every time it appeared.
    const pillSkin = `(()=>{const d=${frame};
      const skin=(el,w)=>{const s=w.getComputedStyle(el);
        return {cls:el.className,radius:s.borderTopLeftRadius,pad:s.padding,font:s.fontSize,
          bg:s.backgroundColor,edge:s.borderTopWidth+' '+s.borderTopColor,
          mark:w.getComputedStyle(el,'::before').content};};
      return {chat:skin(d.getElementById('air-ai-pill'),d.defaultView),form:skin(document.getElementById('quick-ai-pill'),window),
        chatRole:skin(d.getElementById('air-role-pill'),d.defaultView),formRole:skin(document.getElementById('quick-role-pill'),window)};})()`;
    // The conversation is a frame of its own, so the header ↻ is a partial
    // reload of this page: the host keeps its state and the frame boots again
    // (air.js → reloadConversation). location.reload() is asynchronous, so the
    // OLD document keeps answering probes until the navigation commits — the
    // gate below marks that window and waits for a different one to finish
    // booting, rather than trusting a readiness check that the stale copy passes.
    const reloadedFrame = `${frame}?.readyState==='complete' && typeof ${frame}?.defaultView?.renderAuxClassify==='function' && ${frame}.defaultView.__reloadProbe===undefined && ${frame}.getElementById('worktree-bar')!==null`;
    const reloadConversation = async () => {
      const willReload = await page.evaluate(`(()=>{const f=document.getElementById('conversation');if(!f||f.hidden||!f.getAttribute('src'))return false;f.contentWindow.__reloadProbe='stale';return true})()`);
      await page.evaluate(`document.getElementById('refresh').click()`);
      if (willReload) assert.ok(await page.waitFor(reloadedFrame), 'the header ↻ rebuilt the conversation');
    };
    assert.ok(await page.waitFor(`${frame}?.URL.includes('session=task-a') && ${frame}.readyState==='complete'`));
    assert.ok(await page.waitFor(`${frame}?.body.classList.contains('air-chat') && ${frame}?.getElementById('input')`));
    assert.ok(await page.waitFor(`${frame}.getElementById('merge-btn').parentElement.id==='header-more-menu'`));
    assert.equal(await page.evaluate(`${frame}.getElementById('session-queue-dock')!==null && ${frame}.getElementById('aux-classify-bar')!==null`), true);
    assert.equal(await page.evaluate(`${frame}.getElementById('goal-btn')!==null && ${frame}.getElementById('merge-btn')!==null && ${frame}.getElementById('diff-modal')!==null`), true);
    assert.ok(await page.waitFor(`${frame}.getElementById('worktree-force-sync-btn')`), JSON.stringify({ requests: page.requests.filter(r=>/merge-status/.test(r.path)), state: await page.evaluate(`({url:${frame}.URL,errors:${frame}.defaultView.__errors,bar:${frame}.getElementById('worktree-bar').outerHTML})`) }));
    assert.equal(await page.evaluate(`${frame}.getElementById('worktree-sync-btn')!==null && ${frame}.getElementById('worktree-bar').offsetHeight>0`), true);
    assert.equal(await page.evaluate(`['header','worktree-bar','aux-classify-bar'].every(id=>${frame}.getElementById(id).parentElement.id==='chat-context-bar')`), true);
    const skin = await page.evaluate(pillSkin);
    const skinOf = p => [p.radius, p.pad, p.font, p.bg, p.edge, p.mark];
    assert.deepEqual(skinOf(skin.chat), skinOf(skin.form), `对话页 AI 胶囊与新任务表单不是同一颗：${JSON.stringify(skin)}`);
    assert.deepEqual(skinOf(skin.chatRole), skinOf(skin.formRole), `对话页角色胶囊与新任务表单不是同一颗：${JSON.stringify(skin)}`);
    assert.equal(skin.chat.mark, '"◆"', `AI 胶囊丢了 ◆：${JSON.stringify(skin.chat)}`);
    assert.equal(skin.chat.cls.trim(), 'mc-composer__pill mc-composer__pill--ai', JSON.stringify(skin.chat));
    assert.equal(skin.chatRole.cls.trim(), 'mc-composer__pill mc-composer__pill--role', JSON.stringify(skin.chatRole));
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
    // 聊天宽度 is the conversation's own control: the host no longer owns a
    // second copy, so the frame's header More menu is the only entry. 840 sits
    // under the Air reading-column cap, so the composer column follows it.
    await page.evaluate(`(()=>{const d=${frame};d.getElementById('header-more-btn').click();d.getElementById('chat-layout-btn').click();
      const q=s=>d.querySelector('.chat-layout-dialog '+s);
      q('[name=limited]').click();const range=q('[name=width]');range.value=840;range.dispatchEvent(new Event('input'));q('button[value=save]').click();})()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('messages').getBoundingClientRect().width===840`));
    assert.equal(await page.evaluate(`${frame}.getElementById('input-bar').getBoundingClientRect().width`), 840);
    await page.evaluate(`(()=>{const d=${frame};d.getElementById('chat-layout-btn').click();
      const q=s=>d.querySelector('.chat-layout-dialog '+s);
      q('[name=reset]').click();q('button[value=save]').click();})()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('messages').getBoundingClientRect().width>1200`), 'the frame width control is load-bearing, not decorative');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(()=>{const d=${frame},w=d.defaultView,v=w.MultiCCChatHistoryView.createHistoryView({document:d,messagesEl:d.getElementById('messages'),safeMarkdown:w.MultiCCSafeMarkdown});v.clearMessages();d.getElementById('messages').append(...${JSON.stringify(taskMessages)}.map(m=>v.renderMessage(m)));w.MultiCCChatSessionQueue.render([{entryId:'fifo-1',position:1,state:'pending',text:'继续检查移动端布局'}],{state:'running'},d);w.renderAuxClassify('完善 Air 对话体验','verifying','W')})()`);
    assert.equal(await page.evaluate(`${frame}.querySelector('.tool-card .tool-name').textContent`), 'Read');
    assert.ok(await page.evaluate(`${frame}.getElementById('chat-context-bar').getBoundingClientRect().height<=55`), 'desktop runtime controls fit one row even when disconnected');
    await page.evaluate(`${frame}.getElementById('messages').style.cssText='position:relative;z-index:99999';${frame}.getElementById('header-more-btn').click()`);
    assert.ok(await page.waitFor(`${frame}.getElementById('header-more-menu').matches(':popover-open')`));
    assert.equal(await page.evaluate(`(()=>{const d=${frame},m=d.getElementById('header-more-menu'),r=m.getBoundingClientRect();return m.contains(d.elementFromPoint(r.left+20,r.top+30))})()`), true, 'Air menu receives clicks above tool messages');
    // 浮层里每一行都是「图标 + 名字」两列，名字落在同一条竖线上（chat.html 的
    // 「页头动作的两种形状」）。Air 的任务页把这一整套动作挪进了这个浮层，所以
    // 它是这两列唯一的落点 —— 这里量的是它们真的排齐了，而不是「差不多」。
    const menuShape = await page.evaluate(`(()=>{const d=${frame},m=d.getElementById('header-more-menu'),w=d.defaultView;
      const ink=el=>{const r=d.createRange();r.selectNodeContents(el);return Math.round(r.getBoundingClientRect().left)};
      return [...m.children].filter(el=>el.dataset.hdrIcon).map(el=>({
        id:el.id,display:w.getComputedStyle(el).display,icon:w.getComputedStyle(el,'::before').content.replace(/"/g,''),
        inset:ink(el)-Math.round(el.getBoundingClientRect().left),text:el.textContent.trim()}));})()`);
    const shown = menuShape.filter(row => row.display !== 'none');
    assert.ok(shown.length >= 8, `Air 的浮层该留着一整套动作：${shown.length}`);
    for (const row of shown) {
      assert.equal(row.display, 'grid', `${row.id} 该是「图标 + 名字」两列`);
      assert.ok(row.icon && row.icon !== 'none', `${row.id} 该画出图标`);
      assert.ok(row.text, `${row.id} 该留着名字`);
      assert.ok(!row.text.startsWith(row.icon), `${row.id} 不能把图标印两遍：${row.text}`);
      assert.ok(row.inset >= 30 && row.inset <= 40, `${row.id} 的名字该落在第二列：${row.inset}`);
    }
    const insets = shown.map(row => row.inset);
    assert.ok(Math.max(...insets) - Math.min(...insets) <= 2, `名字该在同一条竖线上：${JSON.stringify(menuShape)}`);
    // 身份还没解析出来时那一行是空的（这个对话框走 ?task=，没有 ?session=），
    // 留着就只是一行孤零零的文件夹图标。
    const identity = menuShape.find(row => row.id === 'session-title');
    assert.ok(identity, '身份行在浮层里：Air 把页头那一行也收进来了');
    assert.equal(identity.display === 'none', !identity.text, `空的身份行该收起来：${JSON.stringify(identity)}`);
    await page.evaluate(`${frame}.getElementById('header-more-btn').click();${frame}.getElementById('messages').style.cssText=''`);
    assert.equal(await page.evaluate(`${frame}.getElementById('session-queue-count').textContent`), '1');
    assert.equal(await page.evaluate(`${frame}.getElementById('aux-classify-bar').classList.contains('show')`), true);
    await page.evaluate(`${frame}.defaultView.applyMergeStatus({branch:'multicc/task-a',baseBranch:'main',behind:2,conflict:true,conflictFiles:['example.js']})`);
    assert.equal(await page.evaluate(`${frame}.getElementById('worktree-conflict-bar').parentElement.id`), 'chat-context-bar');
    // The banner owns the parked-sync decisions and the retry, so a conflicted
    // worktree is never left without a way to request the sync again.
    assert.deepEqual(await page.evaluate(`[...${frame}.querySelectorAll('#worktree-conflict-bar button')].map(b=>b.textContent)`), ['如何解决', '继续', '放弃', '强制同步']);
    assert.equal(await page.evaluate(`${frame}.querySelectorAll('#worktree-force-sync-btn').length`), 1, 'the id stays on the always-present status row only');
    await page.evaluate(`${frame}.defaultView.refreshMergeStatus()`);
    assert.equal(await page.evaluate(`document.getElementById('task-state').textContent.includes('计划待执行')`), true);
    entry.messages = taskMessages; entry.execution = { busy: true, status: 'running' };
    await reloadConversation();
    assert.ok(await page.waitFor(`document.getElementById('task-state').textContent.includes('本轮 执行中')`));
    await page.evaluate(`${frame}.defaultView.renderAuxClassify('完善 Air 对话体验','implementing','P')`);
    screenshots.push(await page.screenshot('two-bars-desktop'));
    // 实现中 + API 异常 is the copy that used to float in the middle of the bar:
    // the goal label stretched to fill it and pushed both badges to the far end.
    // The cluster is one tight run now, inside its own box, off the left edge.
    await page.evaluate(`${frame}.defaultView.renderAuxClassify('完善 Air 对话体验','implementing','E','7K2M')`);
    assert.deepEqual(await page.evaluate(`[${frame}.getElementById('ac-state').textContent,${frame}.getElementById('ac-phase').textContent]`), ['❌API 异常', '实现中'], 'the E turn keeps its ❌ mark and its 实现中 phase');
    const classifyRow = await page.evaluate(`(()=>{const d=${frame},box=id=>d.getElementById(id).getBoundingClientRect(),icon=d.querySelector('.ac-icon').getBoundingClientRect();
      const bar=box('aux-classify-bar'),goal=box('ac-goal'),state=box('ac-state'),phase=box('ac-phase');
      const left=Math.min(...['ac-goal','ac-state','ac-phase'].map(id=>box(id).left));
      return {bar:[Math.round(bar.left),Math.round(bar.right)],goal:[Math.round(goal.left),Math.round(goal.right),Math.round(goal.width)],
        goalToState:Math.round(state.left-goal.right),stateToPhase:Math.round(phase.left-state.right),
        iconToGoal:Math.round(goal.left-icon.right),leftGap:Math.round(icon.left-bar.left),rightGap:Math.round(bar.right-phase.right),
        overflows:d.documentElement.scrollWidth>d.documentElement.clientWidth,
        belowHeader:bar.top>=d.getElementById('chat-context-bar').getBoundingClientRect().top};})()`);
    assert.ok(classifyRow.goalToState >= 0 && classifyRow.goalToState <= 12, `goal → state gap: ${JSON.stringify(classifyRow)}`);
    assert.ok(classifyRow.stateToPhase >= 0 && classifyRow.stateToPhase <= 12, `state → phase gap: ${JSON.stringify(classifyRow)}`);
    assert.ok(classifyRow.iconToGoal <= 8, `🎯 leads the run: ${JSON.stringify(classifyRow)}`);
    assert.ok(classifyRow.leftGap <= 14, `the run starts at the bar's left edge: ${JSON.stringify(classifyRow)}`);
    assert.ok(classifyRow.rightGap >= 0 && !classifyRow.overflows, JSON.stringify(classifyRow));
    assert.ok(classifyRow.goal[2] < classifyRow.bar[1] - classifyRow.bar[0], 'the goal label no longer eats the whole bar');
    screenshots.push(await page.screenshot('two-bars-api-error-desktop'));
    entry.execution = { busy: false, status: 'idle' };
    entry.messages = taskMessages; entry.attribution = successAttribution;
    await reloadConversation();
    assert.ok(await page.waitFor(`document.getElementById('delivery-card').innerText.includes('建议归入「任务体验收口」')`));
    assert.equal(await page.evaluate(`document.getElementById('delivery-card').innerText.includes('建议归入「任务体验收口」')`), true);
    assert.equal(await page.evaluate(`document.getElementById('delivery-destination').textContent.includes('完善任务协作体验')`), true);
    await page.evaluate(`document.getElementById('details-toggle').click()`);
    assert.equal(await page.evaluate(`document.getElementById('task-detail-groups').children.length`), 4);
    assert.equal(await page.evaluate(`document.getElementById('task-details').innerText.includes('把任务、目录与交付状态收口到同一个 Air 页面。') && document.getElementById('task-details').innerText.includes('首次打开即可看到计划内容。')`), true);
    await page.evaluate(`document.getElementById('details-close').click()`);
    entry.attribution = { steps: [
      { key: 'run', label: '本轮成功', status: 'done' }, { key: 'delivery', label: '代码交付', status: 'done' },
      { key: 'barrier', label: '源现场稳定', status: 'done' }, { key: 'attribution', label: '分离生效', status: 'done' },
    ], run: { outcome: 'succeeded', pendingInput: false, codeObserved: true }, barrier: { id: 'barrier-1' },
    application: { id: 'application-1', targetTaskId: 'tsk_b' },
    separation: { id: 'sep-1', state: 'separated', phase: 'applied', sourceTaskId: 'tsk_a', targetTaskId: 'tsk_b', targetTitle: '独立任务' }, blockers: [] };
    await reloadConversation();
    assert.ok(await page.waitFor(`document.getElementById('delivery-eyebrow').textContent==='MULTICC · 分离已生效'`));
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#delivery-steps span')].map(s=>[s.textContent,s.className])`), [
      ['本轮成功', 'done'], ['代码交付', 'done'], ['源现场稳定', 'done'], ['分离生效', 'done'],
    ]);
    assert.equal(await page.evaluate(`document.querySelector('[data-action="open-separated"]')?.textContent`), '打开独立任务');
    entry.attribution = { steps: [
      { key: 'run', label: '本轮成功', status: 'done' }, { key: 'delivery', label: '代码交付', status: 'done' },
      { key: 'barrier', label: '源现场稳定', status: 'blocked' }, { key: 'attribution', label: '分离生效', status: 'pending' },
    ], run: { outcome: 'succeeded', pendingInput: false, codeObserved: true },
    separation: { id: 'sep-1', state: 'pending', phase: 'blocked', sourceTaskId: 'tsk_a', targetTitle: '独立任务' },
    blockers: ['workspace_busy', 'separation_application_required'] };
    await reloadConversation();
    assert.ok(await page.waitFor(`document.getElementById('delivery-eyebrow').textContent==='MULTICC · 分离暂未生效'`));
    assert.equal(await page.evaluate(`document.querySelector('[data-step="barrier"]').classList.contains('blocked')`), true);
    await page.evaluate(`document.getElementById('details-toggle').click()`);
    assert.equal(await page.evaluate(`document.getElementById('task-details').innerText.includes('源工作目录仍有写入者')`), true);
    await page.evaluate(`document.getElementById('details-close').click()`);
    entry.attribution = successAttribution;
    await reloadConversation();
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
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]')?.value==='codex-lab'`));
    assert.equal(await page.evaluate(`document.querySelector('.air-cli-option.selected strong').textContent`), 'Codex');
    // Provider 是下拉（和 chat 的 AI 配置、App 的配置面板同一版），一行装完，
    // 不再是一墙卡片：默认线路 + Auto 池 + 三条 Provider。
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]').options.length`), 5);
    assert.equal(await page.evaluate(`(()=>{const s=document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]');const o=s.options[1];return o.value.startsWith('__auto__')&&o.textContent.includes('Auto')})()`), true);
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]').options[0].textContent`), '默认登录 / 官方账号');
    // 子任务尾巴就挂在 Provider 配置后面：线路 + 模型两个下拉，Codex 排掉官方账号
    // （它没有可调用的 HTTP 端点，服务端也会拒）。
    assert.deepEqual(await page.evaluate(`(()=>{const s=document.querySelector('.air-config-dialog[open] select[aria-label="子任务线路"]');return [s.options.length, s.options[0].textContent, [...s.options].some(o=>o.value==='codex-official')]})()`), [3, '随主', false]);
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] select[aria-label="子任务模型"]').options[0].textContent`), '不设置');
    await page.evaluate(String.raw`(()=>{const q=s=>document.querySelector('.air-config-dialog[open] '+s);
      const provider=q('select[aria-label="Provider"]'); provider.value='codex-backup'; provider.dispatchEvent(new Event('change',{bubbles:true}));
      const model=q('select[aria-label="模型"]'); model.value='gpt-5.6-sol';
      const line=q('select[aria-label="子任务线路"]'); line.value='codex-lab'; line.dispatchEvent(new Event('change',{bubbles:true}));
      q('select[aria-label="子任务模型"]').value='gpt-5.5';
      q('select[aria-label="推理强度"]').value='high';
      q('.air-config-form').requestSubmit()})()`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.equal(configPatches.length, 2);
    assert.deepEqual(configPatches[0], { provider: 'codex-backup', providerSelection: null });
    // 子任务跟着同一笔 PATCH 落库（模型为空就等于没设 → null，随主）。
    assert.deepEqual(configPatches[1], { model: 'gpt-5.6-sol', effort: 'high', subagent: { providerId: 'codex-lab', model: 'gpt-5.5' } });
    assert.ok(await page.waitFor(`${composerPill('air-ai-pill')}.textContent.includes('Backup Responses') && ${composerPill('air-ai-pill')}.textContent.includes('gpt-5.6-sol')`));
    // 待生效的那份配置由服务端补上 providerName（src/workspace/air-routes.js 从
    // provider store 解析）。药丸说的是下一轮真正要跑的那条线路，所以它必须写名字
    // 而不是 id —— 以前这里给的就是 id，屏幕上于是出现一串 UUID，刷新也不会变。
    entry.configuration.pendingConfiguration = { cli: 'codex', providerName: 'Lab Responses',
      profile: { provider: 'codex-lab', model: 'gpt-5.5', effort: 'low' } };
    await reloadConversation();
    assert.ok(await page.waitFor(`${composerPill('air-ai-pill')}.textContent.includes('下轮生效')`));
    assert.equal(await page.evaluate(`${composerPill('air-ai-pill')}.textContent.includes('gpt-5.5') && ${composerPill('air-ai-pill')}.textContent.includes('Lab Responses') && !${composerPill('air-ai-pill')}.textContent.includes('Backup Responses')`), true);
    // 线路名会比别的字段长，所以这颗胶囊有上限宽度，超出部分走跑马灯：文字待在一个
    // 不动的 ◆ / 边框里横向来回，而不是被切掉（切掉的名字等于没有名字）。
    entry.configuration.pendingConfiguration.providerName = 'Lab Responses via a very long relay account name that cannot fit';
    await reloadConversation();
    assert.ok(await page.waitFor(`${composerPill('air-ai-pill')}.classList.contains('is-marquee')`), '长线路名切成跑马灯');
    const marquee = await page.evaluate(`(()=>{const el=${composerPill('air-ai-pill')};const run=el.querySelector('.mc-composer__pill-text-run');const s=el.ownerDocument.defaultView.getComputedStyle(run);return {pill:el.getBoundingClientRect().width,shift:el.style.getPropertyValue('--mc-pill-marquee-shift'),animation:s.animationName,duration:s.animationDuration,mark:el.ownerDocument.defaultView.getComputedStyle(el,'::before').content};})()`);
    assert.ok(marquee.pill <= 321, `胶囊不超过上限宽度：${marquee.pill}`);
    assert.ok(parseFloat(marquee.shift) <= -2, `跑马灯位移来自真实溢出：${marquee.shift}`);
    assert.equal(marquee.animation, 'mc-pill-marquee');
    assert.equal(marquee.mark, '"◆"');
    // 跑马灯是视觉效果：断言只能证明类名、位移和上限宽度，形状得留一张图给人看。
    const bandBox = await page.evaluate(`(()=>{const f=document.getElementById('conversation');const r=${frame}.getElementById('air-composer-meta').getBoundingClientRect();const o=f.getBoundingClientRect();return {x:o.x+r.x-8,y:o.y+r.y-6,width:r.width+16,height:r.height+12};})()`);
    const bandShot = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...bandBox, scale: 2 }, captureBeyondViewport: false });
    fs.mkdirSync(screenshotDir, { recursive: true });
    const bandFile = path.join(screenshotDir, `composer-pill-marquee-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(bandFile, Buffer.from(bandShot.data, 'base64'));
    screenshots.push(bandFile);
    // 短名字不跑：量出来没溢出就不该有动画（否则每颗胶囊都在动）。
    entry.configuration.pendingConfiguration.providerName = 'Lab Responses';
    await reloadConversation();
    assert.ok(await page.waitFor(`${composerPill('air-ai-pill')}.textContent.includes('Lab Responses')`));
    assert.equal(await page.evaluate(`${composerPill('air-ai-pill')}.classList.contains('is-marquee')`), false);
    await page.evaluate(`${composerPill('air-ai-pill')}.click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]')?.value==='codex-lab'`));
    assert.equal(await page.evaluate(`document.querySelector('dialog[open] select[aria-label="推理强度"]').value`), 'low');
    // 存过的子任务线路要能读回来，否则再打开面板一次就会把它清掉。
    assert.equal(await page.evaluate(`document.querySelector('dialog[open] select[aria-label="子任务线路"]').value`), 'codex-lab');
    assert.equal(await page.evaluate(`document.querySelector('dialog[open] select[aria-label="子任务模型"]').value`), 'gpt-5.5');
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
    await reloadConversation();
    assert.ok(await page.waitFor(`document.getElementById('delivery-title').textContent==='任务保持进行中'`));
    assert.equal(await page.evaluate(`document.getElementById('delivery-card').hidden`), false);
    assert.equal(await page.evaluate(`document.getElementById('task-state').textContent.includes('本轮 失败')`), true);
    entry.execution.status = 'idle'; entry.attribution = successfulAttribution;
    await reloadConversation();
    assert.ok(await page.waitFor(`document.getElementById('delivery-title').textContent.includes('任务体验收口')`));
    await page.evaluate(`document.getElementById('schedules').click()`);
    assert.ok(await page.waitFor(`document.getElementById('schedule-center').hidden===false && document.querySelector('.schedule-fixed-task')`));
    // Every view paints one heading band — the shell header — so the page copy
    // moved out of the body and the view keeps only its actions.
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent==='定时任务' && document.getElementById('task-state').textContent.includes('写入同一任务')`), true);
    assert.equal(await page.evaluate(`document.querySelector('#schedule-center .schedule-hero')===null && document.querySelector('#task-header #schedule-create')!==null`), true);
    assert.equal(await page.evaluate(`document.querySelector('.schedule-fixed-task').innerText.includes('tsk_a')`), true);
    // 标题行：左边一组说明，右边一个尾巴（计数、✕）。这条曾经全仓没有基础规则，
    // 于是尾巴永远换行 —— 侧栏竖成「任务 / 最近任务 / 1」三条，目录页同样，
    // 每个弹窗的 ✕ 都独占一行。断言按几何量：尾巴要跟头一组有纵向重叠，并且
    // 落在它右边。只数有 client rect 的（关着的 `<dialog>` 是 display:none），
    // 并且要求至少两条，免得选择器失配时「零条都合格」蒙混过去。
    const headingRows = `(()=>[...document.querySelectorAll('.section-heading')]
      .filter(h=>h.getClientRects().length && h.children.length>=2)
      .map(h=>{const a=h.firstElementChild.getBoundingClientRect(),b=h.lastElementChild.getBoundingClientRect();
        return {name:h.className,ok:Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0&&b.left>=a.right-1,
          gap:Math.round(b.left-a.right),overlapY:Math.round(Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))}}))()`;
    await page.evaluate(`document.getElementById('schedule-create').click()`);
    assert.ok(await page.waitFor(`document.getElementById('schedule-dialog').open===true`));
    // 定时任务弹窗共用同一份标记，跟着一起被这条基础规则修好 —— 在它自己开着的
    // 时候量一次，别只靠「同一个类名」推断。
    const scheduleHeadings = await page.evaluate(headingRows);
    assert.ok(scheduleHeadings.length >= 2, '定时任务弹窗开着的时刻至少该量到侧栏和弹窗两条：' + JSON.stringify(scheduleHeadings));
    assert.equal(scheduleHeadings.every(r => r.ok), true, '标题行的尾巴必须跟标题并排，不能换行：' + JSON.stringify(scheduleHeadings));
    assert.equal(await page.evaluate(`document.getElementById('schedule-form').elements.cli.options.length`), 2);
    await page.evaluate(`document.getElementById('schedule-close').click()`);
    screenshots.push(await page.screenshot('scheduled-air-tasks-desktop'));
    await page.evaluate(`document.querySelector('.schedule-fixed-task').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='完善任务协作体验'`));
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`!document.getElementById('empty').hidden && document.querySelectorAll('.directory-stat').length===4`));
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent.includes('MultiCC') && document.getElementById('task-state').textContent.includes('/projects/multicc')`), true);
    assert.equal(await page.evaluate(`document.querySelectorAll('.directory-task-row').length`), 1);
    // Git 状态卡：未推送提交数、主检出的脏文件，提交列表与 diff 懒加载。
    assert.ok(await page.waitFor(`document.getElementById('directory-git').textContent.includes('2 个提交未推送')`));
    assert.equal(await page.evaluate(`document.getElementById('directory-git').textContent.includes('2 个未提交文件')`), true);
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-git-list .directory-git-commit').length`), 0, 'Git 记录默认折叠');
    await page.evaluate(`document.getElementById('directory-git').querySelector('.directory-git-actions button').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-git-list .directory-git-commit').length===2`));
    await page.evaluate(`document.querySelectorAll('#directory-git-list .directory-git-commit-head')[0].click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-git-list').textContent.includes('+新增一行')`));
    // 旧任务列表的跳转已删：侧栏不再渲染 TERMINAL 折叠组。
    assert.equal(await page.evaluate(`document.getElementById('legacy-sessions')===null`), true);
    // The new-task composer reuses the chat's two composers instead of growing
    // its own CLI/Provider selects: the AI 配置 pill opens the same dialog (with
    // 模型, which the old panel dropped) and hands the runtime back as a draft,
    // and the 角色 pill opens the same role editor.
    assert.ok(await page.waitFor(`document.getElementById('quick-ai-pill').textContent.includes('codex')`));
    // Nothing is resolved yet for a task that does not exist, so the pill names
    // the CLI default honestly instead of inventing a route.
    assert.equal(await page.evaluate(`document.getElementById('quick-ai-pill').textContent`), 'codex · 默认线路 · 默认模型');
    assert.equal(await page.evaluate(`document.querySelectorAll('#quick-task-form select').length`), 0, 'no second CLI/Provider copy on the panel');
    assert.equal(await page.evaluate(`document.getElementById('quick-role-pill').textContent`), '＋ 角色');
    assert.equal(await page.evaluate(`document.getElementById('quick-ai-pill').closest('.mc-composer')===document.getElementById('quick-task-form')`), true, 'both pills ride the composer card');
    screenshots.push(await page.screenshot('directory-composer-desktop'));
    const dirHeadings = await page.evaluate(headingRows);
    assert.ok(dirHeadings.length >= 2, '目录页该有侧栏和目录两块标题行：' + JSON.stringify(dirHeadings));
    assert.equal(dirHeadings.every(r => r.ok), true, '标题行的尾巴必须跟标题并排，不能换行：' + JSON.stringify(dirHeadings));
    await page.evaluate(`document.getElementById('quick-ai-pill').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]')`), JSON.stringify({ pill: await page.evaluate(`document.getElementById('quick-ai-pill').textContent`), selected: await page.evaluate(`document.querySelector('.air-cli-option.selected strong')?.textContent`), requests: page.requests.slice(-6).map(r => r.method + ' ' + r.path) }));
    screenshots.push(await page.screenshot('directory-composer-config-desktop'));
    assert.equal(await page.evaluate(`!!document.querySelector('.air-config-dialog[open] .air-config-field select[aria-label="模型"]')`), true, 'model selection survives on the panel');
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] select[aria-label="子任务线路"]').options.length`), 3, 'the tail rides the panel for a task that does not exist yet');
    await page.evaluate(String.raw`(()=>{const q=s=>document.querySelector('.air-config-dialog[open] '+s);
      const provider=q('select[aria-label="Provider"]'); provider.value='codex-backup'; provider.dispatchEvent(new Event('change',{bubbles:true}));
      const model=q('select[aria-label="模型"]'); model.value='gpt-5.6-sol';
      const line=q('select[aria-label="子任务线路"]'); line.value='codex-lab'; line.dispatchEvent(new Event('change',{bubbles:true}));
      q('select[aria-label="子任务模型"]').value='gpt-5.5';
      q('.air-config-form').requestSubmit()})()`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.equal(await page.evaluate(`document.getElementById('quick-ai-pill').textContent`), 'codex · Backup Responses · gpt-5.6-sol');
    assert.equal(configPatches.length, 2, 'a task that does not exist yet is never PATCHed');
    await page.evaluate(`document.getElementById('quick-role-pill').click()`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] select option[value=designer]')`));
    await page.evaluate(`const p=document.querySelector('dialog[open] select');p.value='designer';p.dispatchEvent(new Event('change'))`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] textarea')?.value==='关注清晰、轻盈的交互'`));
    await page.evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.getElementById('quick-role-pill').textContent==='1 个角色'`));
    // The two pills and the card have to survive the phone widths too: this is
    // the first thing a directory opens with. On a phone the card starts folded
    // (air-quick-fold.js) — it is sticky, so unfolded it owns the bottom third of
    // the screen for as long as you are reading the task list above it. The whole
    // composer is one tap away, and the tap has to land in the textarea.
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      // 后台 target 不产帧，resize 和媒体查询的 change 都不会自己跑（见本文件
      // 开头那段）：先抓一帧把渲染步推过去，折叠模块才有机会知道屏宽变了。
      // `getBoundingClientRect` 那种是惰性布局，按下就出结果，这里不是一回事。
      await page.screenshot('directory-composer-mobile-probe');
      assert.ok(await page.waitFor(`document.getElementById('quick-task-form').classList.contains('is-folded')`));
      const folded = await page.evaluate(`(()=>{const f=document.getElementById('quick-task-form').getBoundingClientRect();
        const b=document.getElementById('quick-task-expand').getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth<=innerWidth,form:[Math.round(f.left),Math.round(f.right),Math.round(f.height)],
          bar:[Math.round(b.left),Math.round(b.right)],pill:Math.round(document.getElementById('quick-ai-pill').getBoundingClientRect().height),
          hint:document.getElementById('quick-task-expand-hint').textContent};})()`);
      assert.equal(folded.overflow, true, JSON.stringify(folded));
      assert.ok(folded.form[0] >= 0 && folded.form[1] <= width, JSON.stringify(folded));
      assert.ok(folded.bar[0] >= 0 && folded.bar[1] <= width, JSON.stringify(folded));
      assert.ok(folded.form[2] < 70, '折起来是一条细杠，不是半个屏幕：' + JSON.stringify(folded));
      assert.equal(folded.pill, 0, '整张卡片都收起来了，配置胶囊也不例外');
      assert.equal(folded.hint, '描述要完成的任务…');
      if (width === 390) screenshots.push(await page.screenshot('directory-composer-mobile-folded'));
      // 点一下就回到整张卡片，光标已经落在输入框里 —— 折叠不能变成「多一道手续」。
      await page.evaluate(`document.getElementById('quick-task-expand').click()`);
      assert.ok(await page.waitFor(`!document.getElementById('quick-task-form').classList.contains('is-folded')`));
      assert.equal(await page.evaluate(`document.activeElement===document.getElementById('quick-task-input')`), true, '展开之后直接能打字');
      const open = await page.evaluate(`(()=>{const ai=document.getElementById('quick-ai-pill').getBoundingClientRect(),role=document.getElementById('quick-role-pill').getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth<=innerWidth,aiRight:Math.round(ai.right),roleRight:Math.round(role.right),
          formHeight:Math.round(document.getElementById('quick-task-form').getBoundingClientRect().height)};})()`);
      assert.equal(open.overflow, true, JSON.stringify(open));
      assert.ok(open.aiRight <= width && open.roleRight <= width, JSON.stringify(open));
      // 展开之后确实比那条细杠高得多 —— 否则「折叠」只是把字换了个位置。
      assert.ok(open.formHeight > folded.form[2] * 3, JSON.stringify({open, folded}));
      if (width === 390) screenshots.push(await page.screenshot('directory-composer-mobile'));
      // 空盒子按 Esc 折回去，焦点交还给那条杠 —— 「算了」这个手势要能一步到位。
      await page.evaluate(`document.getElementById('quick-task-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      assert.ok(await page.waitFor(`document.getElementById('quick-task-form').classList.contains('is-folded')`));
      assert.equal(await page.evaluate(`document.activeElement===document.getElementById('quick-task-expand')`), true);
      // 盒子里有东西时不折：那会把半句话藏进一条细杠里。起草中的任务比一屏
      // 任务列表值钱，这时候该让路的是列表，不是输入框。
      await page.evaluate(`(()=>{const i=document.getElementById('quick-task-input');i.value='写了一半';
        i.dispatchEvent(new Event('input',{bubbles:true}));
        document.getElementById('quick-task-expand').click();
        i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`);
      assert.equal(await page.evaluate(`document.getElementById('quick-task-form').classList.contains('is-folded')`), false, '有草稿就不折');
      await page.evaluate(`(()=>{const i=document.getElementById('quick-task-input');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    // ── Pin 的手机形态 ──────────────────────────────────────────────────
    // 页头那排 tab 整个不出现（手机页头一行都嫌贵），同一批任务置顶在侧栏的
    // 「最近任务」里。tsk_far 在另一个目录、这次会话也从没打开过 —— 它本来
    // 既不在最近记录里、也不在当前目录里，能排到第一条只可能是 pin。
    taskPins = ['tsk_far'];
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    await page.screenshot('task-pins-mobile-probe');
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-pins').hidden===true`), '手机上页头没有这一排');
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('task-pins')).display`), 'none');
    assert.ok(await page.waitFor(`document.querySelector('#tasks > button[data-task="tsk_far"]')`));
    const mobilePins = await page.evaluate(`(()=>{const rows=[...document.querySelectorAll('#tasks > button')];
      const first=rows[0];return { first: first && first.dataset.task, mark: first && first.querySelector('.task-pin') && first.querySelector('.task-pin').textContent,
        count: rows.length, overflow: document.documentElement.scrollWidth<=innerWidth };})()`);
    assert.equal(mobilePins.first, 'tsk_far', JSON.stringify(mobilePins));
    assert.equal(mobilePins.mark, '📌');
    assert.equal(mobilePins.overflow, true);
    // 抽屉打开着拍一张：置顶那一条、目录标签和 📌 都留在图里。
    await page.evaluate(`document.getElementById('mobile-nav').click()`);
    await page.screenshot('task-pins-mobile-drawer');
    screenshots.push(await page.screenshot('task-pins-mobile'));
    await page.evaluate(`document.getElementById('mobile-nav').click()`);
    taskPins = [];
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.getElementById('refresh').click()`);
    // 侧栏那颗「＋ 新任务」开的不是另一张表单，是把这**同一个**输入框模块搬进
    // #quick-task-dialog（air.js 的 openNewTaskComposer）。全站只有一份
    // #quick-task-form —— 下面那次创建仍然由它发出，所以这里顺带锁住了「搬到
    // 弹窗里也还是它在干活」，而不是先搬一份副本再让副本去建任务。
    assert.equal(await page.evaluate(`document.getElementById('new-task-dialog')===null && document.getElementById('new-task-form')===null`), true, '旧的自建表单整块删掉了');
    assert.equal(await page.evaluate(`document.getElementById('empty').contains(document.getElementById('quick-task-form'))`), true, '没开弹窗时它就在目录首页原位');
    await page.evaluate(`document.getElementById('create').click()`);
    assert.ok(await page.waitFor(`document.getElementById('quick-task-dialog').open===true`));
    assert.equal(await page.evaluate(`document.getElementById('quick-task-form').parentElement.id`), 'quick-task-slot');
    assert.equal(await page.evaluate(`document.querySelectorAll('#quick-task-form').length`), 1, '搬走就是搬走，不在原地留第二份');
    assert.equal(await page.evaluate(`document.getElementById('empty').contains(document.getElementById('quick-task-form'))`), false);
    assert.deepEqual(await page.evaluate(`(()=>{const s=document.getElementById('quick-task-dialog-directory');return {tag:s.tagName,value:s.value,options:[...s.options].map(o=>[o.value,o.textContent])}})()`), {
      tag: 'SELECT', value: 'd1', options: [['d1', 'MultiCC · /projects/multicc'], ['d2', 'Design Lab · /projects/design-lab']],
    }, '弹窗默认当前目录，同时允许改选');
    assert.equal(await page.evaluate(`document.getElementById('quick-ai-pill').closest('.mc-composer')===document.getElementById('quick-task-form')`), true, '三颗胶囊跟着一起搬');
    // 搬动的是同一个节点，不是重新造一个：上面挑好的线路和角色必须原样还在。
    assert.equal(await page.evaluate(`document.getElementById('quick-ai-pill').textContent`), 'codex · Backup Responses · gpt-5.6-sol');
    assert.equal(await page.evaluate(`document.getElementById('quick-role-pill').textContent`), '1 个角色');
    assert.equal(await page.evaluate(`document.activeElement===document.getElementById('quick-task-input')`), true, '弹窗就是让人写字的，光标直接落下');
    screenshots.push(await page.screenshot('new-task-dialog-desktop'));
    // 弹窗里那颗 ✕ 同理：它得坐在「NEW TASK / 新任务」右边，不是另起一行。
    const dialogHead = await page.evaluate(`(()=>{const h=document.querySelector('#quick-task-dialog .section-heading');
      const a=h.firstElementChild.getBoundingClientRect(),b=h.lastElementChild.getBoundingClientRect();
      return {ok:Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0&&b.left>=a.right-1,
        gap:Math.round(b.left-a.right),closeRight:Math.round(b.right),dialogRight:Math.round(h.getBoundingClientRect().right)}})()`);
    assert.equal(dialogHead.ok, true, '弹窗的 ✕ 要跟标题并排：' + JSON.stringify(dialogHead));
    await page.evaluate(`document.getElementById('quick-task-dialog-close').click()`);
    assert.equal(await page.evaluate(`document.getElementById('quick-task-dialog').open`), false);
    // 搬回原位那一步挂在 `close` 事件上，而 close 是**排队**跑的任务 —— 还是那个
    // 任务源：这个后台 target 不产帧就不轮到它（见本文件开头）。抓一帧，它才跑，
    // 所以这里等的是「搬回去了」这件事本身。
    screenshots.push(await page.screenshot('new-task-dialog-closed'));
    assert.ok(await page.waitFor(`document.getElementById('empty').contains(document.getElementById('quick-task-form'))`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#quick-task-form').length`), 1, '回原位也只有一份');
    // 手机上：平时是一条细杠，弹窗里必须是整张（那个弹窗存在的理由就是让人写字），
    // 关掉再收回细杠 —— 一次「算了」不该把半屏的卡片留在目录首页上。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    await page.screenshot('new-task-dialog-mobile-probe');
    assert.ok(await page.waitFor(`document.getElementById('quick-task-form').classList.contains('is-folded')`));
    await page.evaluate(`document.getElementById('create').click()`);
    assert.ok(await page.waitFor(`document.getElementById('quick-task-dialog').open===true`));
    assert.equal(await page.evaluate(`document.getElementById('quick-task-form').classList.contains('is-folded')`), false, '弹窗里是整张，不是一条细杠');
    screenshots.push(await page.screenshot('new-task-dialog-mobile'));
    await page.evaluate(`document.getElementById('quick-task-dialog-close').click()`);
    // 折回去同样挂在 close 事件上，同样要一帧（上面那条）。
    screenshots.push(await page.screenshot('new-task-dialog-mobile-closed'));
    assert.ok(await page.waitFor(`document.getElementById('quick-task-form').classList.contains('is-folded')`), '关掉就收回那条细杠');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.getElementById('create').click()`);
    assert.ok(await page.waitFor(`document.getElementById('quick-task-dialog').open===true`));
    await page.evaluate(`(()=>{const s=document.getElementById('quick-task-dialog-directory');s.value='d2';s.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('quick-task-input').value='从目录首页创建任务';document.getElementById('quick-task-goal').checked=true;document.getElementById('quick-task-form').requestSubmit()})()`);
    assert.ok(await page.waitFor(`location.search.includes('task=tsk_new')`));
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('dir')`), 'd2');
    assert.equal(quickDispatches.length, 1);
    assert.equal(quickDispatches[0].text, '从目录首页创建任务');
    assert.equal(quickDispatches[0].goal, true);
    // What the pills collected is what the task is created with — the runtime is
    // pinned at creation and the roles are bound before the first message runs.
    const createBody = page.requests.filter(r => r.method === 'POST' && r.path === '/api/air/tasks').map(r => JSON.parse(r.body)).pop();
    const roleBody = page.requests.filter(r => r.path === '/api/air/tasks/tsk_new/roles').map(r => JSON.parse(r.body)).pop();
    assert.equal(createBody.dirId, 'd2');
    assert.equal(createBody.title, '从目录首页创建任务');
    assert.equal(createBody.cli, 'codex');
    assert.equal(createBody.provider, 'codex-backup');
    assert.equal(createBody.model, 'gpt-5.6-sol', 'the panel no longer drops the model');
    // 草稿模式下尾巴交给调用方：它必须一路走到创建请求里，否则第一条消息执行时
    // 子任务又回落成随主。
    assert.deepEqual(createBody.subagent, { providerId: 'codex-lab', model: 'gpt-5.5' });
    assert.ok(createBody.clientMsgId, 'creation carries its receipt key');
    assert.deepEqual(roleBody.bindings, [{ name: '设计师', prompt: '关注清晰、轻盈的交互' }]);
    assert.equal(roleBody.expectedVersion, 0, 'a fresh task binds roles at version 0');
    const order = page.requests.map(r => r.method + ' ' + r.path);
    assert.ok(order.indexOf('POST /api/air/tasks/tsk_new/roles') < order.indexOf('POST /api/task-shell-tasks/tsk_new/messages'), 'roles are bound before the first message runs');
    // /air?view=overview 还进得去（/manage 就落在这儿），但它不再是「一个页面」：
    // 它把控制台面板从左滑出来，页头仍是当前目录，底下的任务不卸载。
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open') && document.querySelectorAll('#console-content .admin-stat').length===4`));
    await settleOverlay(page);
    assert.notEqual(await page.evaluate(`document.getElementById('task-title').textContent`), '控制台', '控制台没有顶掉页头');
    assert.equal(await page.evaluate(`Math.round(document.getElementById('console-panel').getBoundingClientRect().left)`), 0, '面板从左侧滑到位');
    assert.equal(await page.evaluate(`document.querySelectorAll('#console-content .admin-directory-row').length`), 2);
    assert.equal(await page.evaluate(`document.querySelector('#console-content .admin-directory-row').innerText.includes('MultiCC')`), true);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.air-legacy-frame')].filter(x=>x.offsetParent).length`), 0);
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    screenshots.push(await page.screenshot('air-console-desktop'));
    await page.evaluate(`document.querySelector('[data-air-view="docs"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='服务与文档' && document.querySelectorAll('.air-doc-card').length===2`));
    assert.equal(await page.evaluate(`document.getElementById('air-doc-summary').textContent.includes('2 条登记')`), true);
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-legacy-frame').length`), 0);
    await page.evaluate(`document.querySelector('[data-air-view="settings"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='设置中心' && document.querySelectorAll('.air-setting-card').length===14`));
    assert.deepEqual(await page.evaluate(`[...document.querySelector('.air-settings-feature-group').querySelectorAll('.air-setting-card strong')].map(el=>el.textContent)`),
      ['服务与文档', '记忆图谱', '任务图谱'], '重要功能固定在设置中心顶部');
    assert.equal(await page.evaluate(`document.body.innerText.includes('Provider 配置')`), true);
    // AI Assistant(aux):设置与运行记录在控制台有原生页,不再只能回 manage 弹窗。
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')].find(x=>x.innerText.includes('AI Assistant')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='AI Assistant' && document.querySelectorAll('#air-aux-records .air-aux-item').length===1`));
    assert.equal(await page.evaluate(`document.querySelector('#air-aux-status').innerText.includes('137 条')`), true, '状态格显示累计处理数');
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-aux-form select').length`), 3, '协议/Provider/模型三级联动');
    assert.equal(await page.evaluate(`document.querySelector('#air-aux-form select').value`), 'openai');
    await page.evaluate(`document.querySelectorAll('#air-aux-form select')[2].value='gpt-5.6-sol'`);
    await page.evaluate(`[...document.querySelectorAll('#air-aux-form button')].find(b=>b.textContent==='保存').click()`);
    // 保存成功后页面会重拉三份数据并重绘,等记录区重画完再断言提交内容。
    await page.waitFor(`document.querySelectorAll('#air-aux-records .air-aux-item').length===1 && ${JSON.stringify('x')}==='x'`);
    assert.deepEqual(auxPosts.at(-1), { protocol: 'openai', providerId: 'codex-lab', model: 'gpt-5.6-sol' }, '保存提交新模型');
    await page.evaluate(`document.querySelector('[data-air-view="settings"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='设置中心'`));
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')].find(x=>x.innerText.includes('Provider 配置')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='CLI 与 Provider' && document.querySelectorAll('.air-provider-card').length===3`));
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.air-legacy-frame')].filter(x=>x.offsetParent).length`), 0);
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-provider-defaults select').length`), 2);
    assert.equal(await page.evaluate(`document.getElementById('air-provider-count').textContent.includes('3 条线路')`), true);
    await page.evaluate(`document.querySelector('#admin-actions .primary').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-provider-dialog').open===true`));
    assert.equal(await page.evaluate(`document.getElementById('air-provider-form').elements.apiFormat.value`), 'anthropic');
    await page.evaluate(`document.getElementById('air-provider-close').click()`);
    // 移动端那一段要看到「本轮 … · 任务 …」两段都在：页头在手机上只显示前一段，
    // 没给任务状态的话那条断言就是空跑。
    entry.execution = { busy: true, status: 'running' }; entry.attribution = {}; entry.task.status = 'active';
    await page.navigate('/air?task=tsk_a&dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='完善任务协作体验'`));
    assert.ok(await page.waitFor(`${frame}?.URL.includes('session=task-a') && ${frame}.readyState==='complete'`));
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      assert.equal(await page.evaluate(`innerWidth`), width);
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      // 手机上页头是「标题区」不是导航：面包屑、标题、状态、按钮原来叠四行占 142px。
      // 面包屑（在哪个目录）收进侧栏抽屉；状态跟标题同一行读，放不下才落回第二行；
      // 工具（含 ↻）收进「⋯」打开的一层浮层，页头就只剩那一行 —— 浮层不占位。
      const mobileHeader = await page.evaluate(`(()=>{const g=id=>document.getElementById(id);const t=g('task-title'),s=g('task-state'),h=g('task-header');const tr=t.getBoundingClientRect(),sr=s.getBoundingClientRect();return {h:h.getBoundingClientRect().height,crumb:getComputedStyle(g('task-breadcrumb')).display,conv:g('conversation').getBoundingClientRect().top,sameLine:Math.abs(tr.top-sr.top)<12,titleClipped:t.scrollWidth>t.clientWidth+1,full:s.textContent,joined:[...s.children].map(c=>c.textContent).join(''),run:[...s.querySelectorAll('.ts-run')].map(e=>getComputedStyle(e).display),life:[...s.querySelectorAll('.ts-life')].map(e=>getComputedStyle(e).display),detail:getComputedStyle(g('details-toggle')).display,refreshParent:g('refresh').parentElement.className,options:getComputedStyle(g('task-options')).display,tools:getComputedStyle(g('task-tools')).display}})()`);
      // 390 上一行就够（45px）；320 上「⋯」拿走的那 34px 让状态回到第二行 —— 宁可
      // 多这一行，也不把状态压成省略号，那正是 titleClipped 这条断言在守的事。
      // 两个宽度都比收起来之前的 85 / 93px 矮，工具一件也没少。
      assert.ok(mobileHeader.h <= (width > 340 ? 52 : 64), JSON.stringify(mobileHeader));
      assert.equal(mobileHeader.options, 'block', JSON.stringify(mobileHeader));
      assert.equal(mobileHeader.tools, 'none', '工具不能自己占一行：收在浮层里', JSON.stringify(mobileHeader));
      assert.equal(mobileHeader.crumb, 'none', JSON.stringify(mobileHeader));
      assert.equal(mobileHeader.conv, mobileHeader.h, JSON.stringify(mobileHeader));
      // 320 上「⋯」拿走的 34px 在 macOS 字体度量下会把状态挤回第二行，但
      // docker 的 noto-cjk 更窄，一行可能仍然放得下 —— 那是更好的渲染，不是
      // 回归。这条守的真正不变量是「放不下时宁可换行也不裁标题」，标题不裁
      // 由下一条 titleClipped 断言守。
      if (width > 340) assert.equal(mobileHeader.sameLine, true, JSON.stringify(mobileHeader));
      else assert.ok(!mobileHeader.sameLine || !mobileHeader.titleClipped, JSON.stringify(mobileHeader));
      assert.equal(mobileHeader.titleClipped, false, JSON.stringify(mobileHeader));
      assert.equal(mobileHeader.full, '本轮 执行中 · 任务 进行中', JSON.stringify(mobileHeader));
      // 藏的是显示，不是文字：几段拼起来仍然等于整条文案，分隔符跟着段一起走。
      assert.equal(mobileHeader.joined, mobileHeader.full, JSON.stringify(mobileHeader));
      assert.deepEqual(mobileHeader.run.filter(d => d === 'none'), [], JSON.stringify(mobileHeader));
      assert.deepEqual(mobileHeader.life, ['none'], JSON.stringify(mobileHeader));
      // 详情按钮收起来：点状态那一条就是同一件事（两处都是 toggleDetails）。
      assert.equal(mobileHeader.detail, 'none', JSON.stringify(mobileHeader));
      assert.equal(mobileHeader.refreshParent, 'task-tools', JSON.stringify(mobileHeader));
      assert.equal(await page.evaluate(`${frame}.documentElement.scrollWidth<=${frame}.documentElement.clientWidth`), true);
      assert.ok(await page.waitFor(`${frame}.getElementById('worktree-force-sync-btn')`));
      assert.equal(await page.evaluate(`${frame}.getElementById('worktree-force-sync-btn').getBoundingClientRect().right<=${frame}.documentElement.clientWidth`), true);
      await page.evaluate(`${frame}.defaultView.renderAuxClassify('完善任务协作体验，保留所有同步与状态操作','implementing','P')`);
      // 手机上一行消息只值 23px，消息上方这几条得压成两行：分支/连接一行，
      // 药丸/目标一行。目标曾经独占一整行（flex-basis:100%），那就是 100px 起。
      const mobileBars = await page.evaluate(`(()=>{const d=${frame};const r=id=>d.getElementById(id).getBoundingClientRect();return {width:innerWidth,bar:r('chat-context-bar').toJSON(),aux:r('aux-classify-bar').toJSON(),goal:r('ac-goal').toJSON(),state:r('ac-state').toJSON(),groups:['chat-context-bar','header','worktree-bar','aux-classify-bar'].map(id=>({id,rect:r(id).toJSON()}))}})()`);
      assert.ok(mobileBars.bar.height <= 70, JSON.stringify(mobileBars));
      assert.ok(mobileBars.aux.height <= 26, JSON.stringify(mobileBars));
      assert.ok(Math.abs(mobileBars.goal.top - mobileBars.state.top) < 12, JSON.stringify(mobileBars));
      assert.equal(await page.evaluate(`${frame}.getElementById('ac-cancel-task').getBoundingClientRect().right<=${frame}.documentElement.clientWidth`), true);
      const mobileLayout = await page.evaluate(`(()=>{const s=document.getElementById('sidebar'),r=s.getBoundingClientRect();return {sidebarLeft:r.left,sidebarRight:r.right,sidebarWidth:r.width,transform:getComputedStyle(s).transform,position:getComputedStyle(s).position,bodyClass:document.body.className,media:matchMedia('(max-width:760px)').matches}})()`);
      assert.equal(mobileLayout.sidebarRight <= 0, true, JSON.stringify(mobileLayout));
      assert.equal(await page.evaluate(`getComputedStyle(${composerPill('air-ai-pill')}).display!=='none'`), true);
      assert.equal(await page.evaluate(`${composerPill('air-role-pill')}.getBoundingClientRect().right<=${frame}.documentElement.clientWidth`), true);
      if (width === 390) {
        await page.evaluate(`${composerPill('air-ai-pill')}.click()`);
        assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]')`));
        assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog').scrollWidth<=document.querySelector('.air-config-dialog').clientWidth`), true);
        await page.evaluate(`document.querySelector('.air-config-close').click()`);
      }
      screenshots.push(await page.screenshot('two-bars-mobile-' + width));
      if (width === 390) {
        // 「⋯」打开的那层浮层：工具一件不少，页头一行没高。每一行都是「图标 +
        // 名字」—— 桌面只有图标的（⎇）在这里带上名字，桌面只有文字的（详情、更多）
        // 在这里补上图标，图标站成同一列，名字都从同一条竖线开始。
        const closedHeight = await page.evaluate(`document.getElementById('task-header').getBoundingClientRect().height`);
        await page.evaluate(`document.getElementById('task-options').click()`);
        const panel = await page.evaluate(String.raw`(()=>{const g=id=>document.getElementById(id);
          const t=g('task-tools'), rows=[...t.querySelectorAll('button')].filter(b=>!b.hidden&&getComputedStyle(b).display!=='none');
          const r=t.getBoundingClientRect();
          const hit=document.elementFromPoint(r.left+20, r.top+30);
          // 一行里的图标是那个 span，名字是它后面那段文字（平时只有图标的按钮，名字
          // 收在 .air-tool-name 里）。名字从哪条竖线开始，用 Range 量文字自己的左边：
          // 「统一」这件事只有量得出左边才说得清。
          const textLeft=n=>{const box=document.createRange();box.selectNodeContents(n);return Math.round(box.getBoundingClientRect().left)};
          const cells=rows.map(b=>{const icon=b.querySelector('.air-tool-icon,.air-tool-icon-panel');
            const name=[...b.childNodes].find(n=>n.nodeType===3?!!n.textContent.trim():n.classList&&n.classList.contains('air-tool-name'));
            return {icon:icon?icon.textContent:'', name:name?name.textContent.trim():'',
              iconLeft:icon?Math.round(icon.getBoundingClientRect().left):null, nameLeft:name?textLeft(name):null}});
          return {h:g('task-header').getBoundingClientRect().height, expanded:g('task-options').getAttribute('aria-expanded'),
            hitInside:!!hit && t.contains(hit), hit:hit?(hit.id||hit.className||hit.tagName):'none',
            display:getComputedStyle(t).display, left:Math.round(r.left), right:Math.round(r.right), width:Math.round(r.width),
            icons:cells.map(c=>c.icon), names:cells.map(c=>c.name), cells:rows.length,
            iconLefts:[...new Set(cells.map(c=>c.iconLeft))], nameLefts:[...new Set(cells.map(c=>c.nameLeft))],
            rowWidths:[...new Set(rows.map(b=>Math.round(b.getBoundingClientRect().width)))],
            rowHeight:Math.round(rows[0].getBoundingClientRect().height)}})()`);
        assert.equal(panel.display, 'flex', JSON.stringify(panel));
        assert.equal(panel.expanded, 'true', JSON.stringify(panel));
        assert.equal(panel.h, closedHeight, '浮层不占位：开着的时候页头还是那一行高');
        // 右边跟「⋯」那件按钮对齐（页头内边距 10px），左边留在屏里。
        assert.ok(panel.left >= 0 && Math.abs(panel.right - (390 - 10)) <= 1, JSON.stringify(panel));
        // 📌 是 pin 的开关：桌面上它排在标题后面那排 tab 右边，手机上没有那排 tab，
        // 钉住/取消钉住就只剩这一处 —— 它必须在浮层里（名字跟着状态变，见 air.js 的
        // paintPinButton）。
        assert.deepEqual(panel.icons, ['⎇', '⇡', '↗', '📌', '⋯', '↻'], JSON.stringify(panel));
        assert.deepEqual(panel.names, ['合并回基分支', '自动提交', '分享此任务', 'Pin 到页顶', '更多', '刷新'], JSON.stringify(panel));
        // 图标一列、名字一列：每一行的名字都从同一条竖线开始，不会有的行有图标、
        // 有的行没有，也不会 ⎇ 宽 ↻ 窄把名字推得参差不齐。
        assert.equal(panel.iconLefts.length, 1, '图标都在同一列：' + JSON.stringify(panel));
        assert.equal(panel.nameLefts.length, 1, '名字都在同一条竖线上：' + JSON.stringify(panel));
        assert.ok(panel.nameLefts[0] > panel.iconLefts[0], JSON.stringify(panel));
        // 而且真的盖在对话上面：页头自己有 backdrop-filter，那就是一个层叠上下文，
        // 浮层在里面的 z-index 再大也只管这一层内部，整条页头仍然排在对话前面 ——
        // 少了页头自己的 z-index，浮层会看得见、点不着。
        assert.equal(panel.hitInside, true, '浮层要盖在对话上面：' + JSON.stringify(panel));
        assert.equal(panel.rowWidths.length, 1, '每一件工具都是一整行：' + JSON.stringify(panel));
        assert.ok(panel.rowHeight >= 34, JSON.stringify(panel));
        // 点过一件工具，浮层就收起 —— 那件工具已经做完了，浮层再晾着只会挡住它刚
        // 改的那一屏。「更多」是这条路径上最麻烦的一个：它自己的处理器会
        // stopPropagation，所以收起这件事挂在捕获阶段。
        await page.evaluate(`document.getElementById('chat-more').click()`);
        assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('task-tools')).display`), 'none', '点过一件工具，浮层就收起');
        assert.equal(await page.evaluate(`document.getElementById('task-options').getAttribute('aria-expanded')`), 'false');
        assert.equal(await page.evaluate(`document.getElementById('task-options').closest('#task-header').classList.contains('options-open')`), false);
        await page.evaluate(`document.getElementById('chat-more').click()`);
        // 再开一次，点页头的别处 / 点对话 / 按 Esc，都收起。
        for (const dismiss of [`document.getElementById('task-layout').click()`,
                               `${frame}.body.click()`,
                               `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`]) {
          await page.evaluate(`document.getElementById('task-options').click()`);
          assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('task-tools')).display`), 'flex');
          await page.evaluate(dismiss);
          assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('task-tools')).display`), 'none', dismiss);
        }
        // 抽屉打开时浮层要让开：遮罩压在它上面，点不着的浮层等于没开。
        await page.evaluate(`document.getElementById('task-options').click()`);
        await page.evaluate(`document.getElementById('mobile-nav').click()`);
        assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('task-tools')).display`), 'none', '导航抽屉打开时工具浮层要让开');
        await page.evaluate(`document.getElementById('nav-scrim').click()`);
      }
    }
    // 页头那条状态还有第三段：「归属待核验」（或卡住资源时的「等待执行名额」，那
    // 一种是「为什么现在没动」，留着）。手机上前者让位 —— 那一行还要装 ☰、标题、
    // 跑没跑（圈也在）和 ⋯，多这五个字正好把状态挤到第二行，页头就整条变两行；
    // 桌面横着放得下，照旧显示。藏的是显示不是文字：几段拼起来仍是整条。
    entry.attribution = successAttribution;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?task=tsk_a&dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('task-state').textContent.includes('归属待核验')`));
    await page.waitFor(`${frame}?.URL.includes('session=task-a') && ${frame}.readyState==='complete'`);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#task-state .ts-attr')).display!=='none'`), true, '桌面上「归属待核验」留着');
    for (const width of [390, 360, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      const attributed = await page.evaluate(`(()=>{const g=id=>document.getElementById(id);const s=g('task-state'),t=g('task-title'),h=g('task-header');
        return {h:Math.round(h.getBoundingClientRect().height), stateH:Math.round(s.getBoundingClientRect().height), cls:s.className, attr:[...s.querySelectorAll('.ts-attr')].map(e=>getComputedStyle(e).display),
          run:[...s.querySelectorAll('.ts-run')].map(e=>getComputedStyle(e).display),
          full:s.textContent, joined:[...s.children].map(c=>c.textContent).join(''),
          sameLine:Math.abs(t.getBoundingClientRect().top-s.getBoundingClientRect().top)<12}})()`);
      assert.deepEqual(attributed.attr, ['none'], '手机上「归属待核验」让位：' + JSON.stringify(attributed));
      assert.deepEqual(attributed.run.filter(d => d === 'none'), [], JSON.stringify(attributed));
      assert.equal(attributed.full, '本轮 执行中 · 任务 进行中 · 归属待核验', JSON.stringify(attributed));
      assert.equal(attributed.joined, attributed.full, JSON.stringify(attributed));
      // 让位之前这一条在 390 上会落到第二行（页头 60 出头），让位之后回到一行。
      assert.ok(attributed.h <= (width > 340 ? 52 : 64), JSON.stringify(attributed));
      screenshots.push(await page.screenshot('task-state-attributed-mobile-' + width));
      if (width === 390) {
        assert.equal(attributed.sameLine, true, '状态回到标题那一行：' + JSON.stringify(attributed));
        assert.ok(attributed.stateH <= 26, '状态自己就是一行：' + JSON.stringify(attributed));
        // 让位这件事要说得出来：把这一段放回去，状态那一行自己断成两行，页头跟着
        // 从 45px 涨到 68px —— 这条断言就是「为什么要有这条 CSS」的证据，不然它
        // 只是我量出来的一个数。留下的那一张「放回去」的截图也是同一份证据。
        const geometry = `(()=>{const g=id=>document.getElementById(id);return {height:Math.round(g('task-header').getBoundingClientRect().height),stateH:Math.round(g('task-state').getBoundingClientRect().height)}})()`;
        await page.evaluate(`document.querySelector('#task-state .ts-attr').style.display='block'`);
        const whenShown = await page.evaluate(geometry);
        screenshots.push(await page.screenshot('task-state-attributed-mobile-390-before'));
        await page.evaluate(`document.querySelector('#task-state .ts-attr').style.removeProperty('display')`);
        assert.ok(whenShown.height > attributed.h && whenShown.stateH > attributed.stateH,
          `放回去页头就从 ${attributed.h}px 涨到 ${whenShown.height}px：` + JSON.stringify(whenShown));
      }
    }
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      await page.navigate('/air?view=overview');
      assert.ok(await page.waitFor(`document.body.classList.contains('console-open') && document.querySelectorAll('#console-content .admin-stat').length===4`));
      await settleOverlay(page);
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      assert.equal(await page.evaluate(`document.getElementById('console-panel').getBoundingClientRect().right<=innerWidth`), true);
      screenshots.push(await page.screenshot('air-console-mobile-' + width));
    }
    await page.navigate('/air?view=provider');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='CLI 与 Provider' && document.querySelectorAll('.air-provider-card').length===3`));
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('air-provider-cards')).gridTemplateColumns.split(' ').length`), 1);
    // 设置类那几页的动作原来铺成页头第二行（↻ 还得靠两条 :has 例外钉在右上角），
    // 现在它们跟别的工具一样住在「⋯」里 —— 页头仍然只有那一行。
    await page.evaluate(`document.getElementById('task-options').click()`);
    const settingsTools = await page.evaluate(`(()=>{const t=document.getElementById('task-tools');
      return {h:Math.round(document.getElementById('task-header').getBoundingClientRect().height),
        rows:[...t.querySelectorAll('#admin-actions button')].map(b=>{const i=b.querySelector('.air-tool-icon,.air-tool-icon-panel');
          return (i?i.textContent:'')+' '+b.textContent.replace(i?i.textContent:'' ,'').trim()}),
        widths:[...new Set([...t.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>Math.round(b.getBoundingClientRect().width)))]}})()`);
    // 页面自己那几件动作也是「图标 + 名字」：图标说的是这件事是什么性质 ——
    // ← 回去、⇄ 借道、↻ 重新读、＋ 新增。
    assert.deepEqual(settingsTools.rows, ['← 返回设置中心', '⇄ 高级账号与借道', '↻ 刷新', '＋ 新增 Provider'], JSON.stringify(settingsTools));
    assert.equal(settingsTools.widths.length, 1, '设置页的工具也铺成一列：' + JSON.stringify(settingsTools));
    assert.ok(settingsTools.h <= 64, JSON.stringify(settingsTools));
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
