'use strict';
// 目录首页里的 Terminal：顶部 Chat / Terminal 切换，以及「＋ 新终端」先问用哪个 CLI。
// 在真浏览器里跑（air.html + air-directory-mode.js 就是最终产物，桩只打接口）。
//
// 三件事：
//   ① 两类互相让位 —— 一次只显示一种，默认 chat（不是排成一列）；
//   ② 终端那份清单只认当前目录、且只认 terminal-kind（chat-kind 的会话不进来）；
//   ③ 新建终端是个**选择**：弹窗列出快照里的 CLI（实验车道除外），取消什么都不建，
//      选哪个就用哪个 POST，然后进那个终端页。此前是拿「最近用过的那套」直接建，
//      用户明确否掉过 —— 这一条就是那个行为的守卫。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('目录里的 Chat / Terminal 切换与「新建终端」选 CLI', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public');
  const routes = {};
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml' };
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html|svg)$/.test(name))) {
    const type = types[file.slice(file.lastIndexOf('.') + 1)];
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': `${type}; charset=utf-8` } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = {
    headers: { 'content-type': 'text/javascript' },
    body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
  };
  // 对话帧是另一个文档，这一份只管 Air 壳：给个空壳，省掉一堆无关请求。
  routes['/chat.html'] = { body: '<!doctype html><meta charset="utf-8"><title>frame</title>', headers: { 'content-type': 'text/html; charset=utf-8' } };
  routes['/task-shell.html'] = routes['/chat.html'];
  routes['/api/air'] = () => json({
    ok: true,
    directories: [
      { id: 'd1', name: 'MultiCC', path: '/projects/multicc' },
      { id: 'd2', name: 'Design Lab', path: '/projects/design-lab' },
    ],
    tasks: [],
    taskPins: [],
    migration: { errors: [] },
    // 最近用过的那套（新任务输入框的默认）是 codex —— 新建终端的配置对话框就从它
    // 打开，好让下面直接量到 codex 的线路。
    lastRuntime: { cli: 'codex', provider: null, providerName: null, providerSelection: null, model: null, effort: null, subagent: null },
    // 实验车道跟着快照一起给：断的是界面不把它们当常规终端选项。
    clis: ['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'gemini'],
    sessions: [
      { id: 'term-a', dirId: 'd1', kind: 'terminal', label: 'MultiCC terminal', cli: 'claude' },
      { id: 'term-b', dirId: 'd1', kind: 'terminal', label: 'MultiCC codex terminal', cli: 'codex' },
      { id: 'term-other', dirId: 'd2', kind: 'terminal', label: 'Design terminal', cli: 'codex' },
      // chat-kind 的会话曾经在侧栏那一组里被二次防御滤掉，这里同样不能出现在终端清单。
      { id: 'role-a', dirId: 'd1', kind: 'chat', label: 'CHAT_KIND_MUST_NOT_SHOW' },
    ],
  });
  const creates = [];
  routes['POST /api/directories/d1/sessions'] = ({ body }) => {
    const value = JSON.parse(body);
    creates.push(value);
    return json({ id: 'term-new', dirId: 'd1', kind: 'terminal', cli: value.cli, label: value.label });
  };
  // 配置对话框的线路池（和 chat 那份同一个接口、同一份形状）。
  routes['/api/providers'] = () => json({ ok: true, available: true, defaults: { codex: 'codex-lab', claude: null }, providers: [
    { id: 'codex-official', appType: 'codex', name: 'Codex Official', apiFormat: 'openai_responses', compatibleClis: ['codex'], isOfficial: true, model: 'gpt-5.5', modelOptions: ['gpt-5.5'], hasToken: true },
    { id: 'codex-lab', appType: 'codex', name: 'Lab Responses', apiFormat: 'openai_responses', compatibleClis: ['codex'], model: 'gpt-5.5', modelOptions: ['gpt-5.5', 'gpt-5.6-sol'], hasToken: true },
  ] });

  const screenshots = [];
  const screenshotDir = path.join(os.tmpdir(), 'multicc-air-directory-terminal');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason)))`,
    });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('.directory-stat').length===4`));

    // ① 默认 chat：终端那一块不显示，Chat 的内容在。
    assert.equal(await page.evaluate(`document.getElementById('empty').classList.contains('is-terminal-mode')`), false, '默认是 chat');
    assert.equal(await page.evaluate(`document.getElementById('directory-mode-chat').getAttribute('aria-selected')`), 'true');
    assert.equal(await page.evaluate(`document.getElementById('directory-terminals').offsetParent===null`), true, 'chat 模式下终端块不显示');
    assert.ok(await page.evaluate(`document.getElementById('directory-stats').offsetParent!==null`), 'chat 模式的统计卡在');

    // ② 切到 Terminal：Chat 那一整块让位（不是排在终端下面）。
    await page.evaluate(`document.getElementById('directory-mode-terminal').click()`);
    assert.ok(await page.waitFor(`document.getElementById('empty').classList.contains('is-terminal-mode')`));
    for (const id of ['directory-stats', 'directory-git', 'quick-task-form']) {
      assert.equal(await page.evaluate(`document.getElementById('${id}').offsetParent===null`), true, `${id} 在终端模式下该让位`);
    }
    const rows = await page.evaluate(`[...document.querySelectorAll('#directory-terminal-list .directory-terminal-row')].map(a=>[a.textContent,a.getAttribute('href')])`);
    assert.deepEqual(rows.map(row => row[1]), ['/?id=term-a', '/?id=term-b'], '只列当前目录的终端：' + JSON.stringify(rows));
    assert.equal(await page.evaluate(`document.getElementById('directory-terminal-list').textContent.includes('Design terminal')`), false, '别的目录的终端不进来');
    assert.equal(await page.evaluate(`document.getElementById('directory-terminal-list').textContent.includes('CHAT_KIND_MUST_NOT_SHOW')`), false, 'chat-kind 的会话不属于终端');
    assert.equal(await page.evaluate(`document.getElementById('directory-terminal-count').textContent`), '2 个终端');
    screenshots.push(await page.screenshot('directory-terminal-mode-down'));

    // ③ 新建终端：开的是 **chat 那套配置对话框**（CLI / Provider / 模型），不是只列
    // 一个 CLI 的小列表 —— 用户明确要求「要和 chat 一样，可以选终端和 provider」。
    await page.evaluate(`document.getElementById('directory-terminal-new').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]')`), '新建终端要先开配置对话框');
    // 同一层对话框，但说的是终端（不把「新任务」那套抬头照搬过来）。
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] h2').textContent`), '终端 AI 配置');
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] .eyebrow').textContent`), 'TERMINAL ROUTING');
    // 可选 CLI = 快照里去掉实验车道那两条；默认落在最近用过的那套（codex）。
    const choices = await page.evaluate(`[...document.querySelectorAll('.air-config-dialog[open] .air-cli-option')].map(b=>b.dataset.cli).sort()`);
    assert.deepEqual(choices, ['claude', 'codex', 'gemini', 'opencode'], '实验车道不是常规终端选项：' + JSON.stringify(choices));
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] .air-cli-option.selected').dataset.cli`), 'codex', '默认落在最近用过的那套');
    assert.ok(await page.evaluate(`document.querySelector('.air-config-dialog[open] select[aria-label="模型"]').options.length > 1`), '模型也跟着这条线路给出来');
    screenshots.push(await page.screenshot('directory-terminal-config-dialog'));

    // 取消 = 什么都没建（不是「取消也照建」）。
    await page.evaluate(`document.querySelector('.air-config-dialog[open] .air-config-footer button').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open]')===null`));
    assert.deepEqual(creates, [], '取消不建终端');

    // 选一条线路 + 模型（不是「最近用过的那套」的默认值）：建出来的必须就是它们。
    await page.evaluate(`document.getElementById('directory-terminal-new').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]')`));
    // 对话框的线路池是异步拉的：等选项真的到了再挑 —— 在空 select 上赋 value 会静默
    // 变成「没选」，提交那一侧就会以「没有可用线路」拒绝，看起来像是没建。
    assert.ok(await page.waitFor(`[...document.querySelector('.air-config-dialog[open] select[aria-label="Provider"]').options].some(o=>o.value==='codex-lab')`), '线路池要加载完');
    await page.evaluate(String.raw`(()=>{const q=s=>document.querySelector('.air-config-dialog[open] '+s);
      const provider=q('select[aria-label="Provider"]'); provider.value='codex-lab'; provider.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    assert.ok(await page.waitFor(`[...document.querySelector('.air-config-dialog[open] select[aria-label="模型"]').options].some(o=>o.value==='gpt-5.6-sol')`), '模型列表要跟着线路刷新');
    await page.evaluate(String.raw`(()=>{const q=s=>document.querySelector('.air-config-dialog[open] '+s);
      q('select[aria-label="模型"]').value='gpt-5.6-sol';
      q('.air-config-form').requestSubmit()})()`);
    // 先等这一跳真的发生（POST 是异步的，落在 fixture 侧），再断建出来的东西 ——
    // 顺序反了会在 POST 到位之前读到一个空数组。
    assert.ok(await page.waitFor(`location.pathname==='/' && location.search.includes('id=term-new')`), '建好直接进那个终端页');
    assert.equal(creates.length, 1, '只建一个终端：' + JSON.stringify(creates));
    assert.equal(creates[0].cli, 'codex', '建的就是选中的 CLI：' + JSON.stringify(creates));
    assert.equal(creates[0].kind, 'terminal');
    assert.equal(creates[0].provider, 'codex-lab', '选中的线路要落到创建请求里：' + JSON.stringify(creates));
    assert.equal(creates[0].model, 'gpt-5.6-sol', '选中的模型也一起带上：' + JSON.stringify(creates));
    // 终端行的名字把 CLI 与模型写进去，列表里一眼看得出这一条是拿什么起的。
    assert.equal(creates[0].label, 'codex · gpt-5.6-sol');
    assert.deepEqual(await page.evaluate(`window.__errors||[]`), [], '页面上不该有未捕获的异常');
  });
  if (screenshots.length) console.log('screenshots:', screenshots.join(' '));
});
