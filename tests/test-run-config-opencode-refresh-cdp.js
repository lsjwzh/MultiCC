'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 「刷新模型」按钮：opencode 的模型 id 跟着上游走，页面却按 1 小时缓存画下拉。
// 上游改名后旧 id 会一直留在列表里，而这个按钮必须做到两件事 ——
// 跳过浏览器 localStorage（旧列表就在那儿），并要求服务端跳过它自己的缓存
// （`?refresh=1`），然后把新列表画回来、保留用户当前选中的模型。
const publicDir = path.resolve(__dirname, '../public');
const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

const routes = {};
for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
  routes['/' + file] = {
    body: fs.readFileSync(path.join(publicDir, file)),
    headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' },
  };
}
for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
  routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
}
routes['/auth-client.js'] = {
  headers: { 'content-type': 'text/javascript' },
  body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
};
routes['/run-config-host.html'] = {
  headers: { 'content-type': 'text/html' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/run-config.css"><body>
${['auth-client.js', 'i18n-catalog.js', 'i18n.js', 'shared/dom-helpers.js', 'shared/format.js', 'api-client.js',
  'provider-catalog.js', 'auto-provider-editor.js', 'shared/models.js', 'chat-ai-config.js', 'run-config.js']
  .map(src => `<script src="/${src}"></script>`).join('')}</body>`,
};
routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
routes['/api/providers'] = () => json({ providers: [], defaults: {} });

const CACHE_KEY = 'multicc.opencode.models.v2';
// 上游改名前的旧列表：deepseek-v4-flash 已被 deepseek-v4.1-flash 取代。
const STALE = [
  { provider: 'opencode', model: 'deepseek-v4-flash', label: 'opencode/deepseek-v4-flash (OpenCode Zen)' },
  { provider: 'opencode', model: 'big-pickle', label: 'opencode/big-pickle (OpenCode Zen)' },
];
const LIVE = [
  { provider: 'opencode', model: 'deepseek-v4.1-flash', label: 'opencode/deepseek-v4.1-flash (OpenCode Zen)' },
  { provider: 'opencode', model: 'big-pickle', label: 'opencode/big-pickle (OpenCode Zen)' },
  { provider: 'opencode', model: 'flint-40b-free', label: 'opencode/flint-40b-free (OpenCode Zen)' },
];

const qaDir = () => process.env.MULTICC_OPENCODE_REFRESH_QA_DIR || path.join(os.tmpdir(), 'multicc-opencode-refresh-qa');
const D = '.air-config-dialog[open] ';
const optionValues = `[...document.querySelectorAll(${JSON.stringify(D + '.rc-model option')})].map(o => o.value)`;
const visible = selector => `(() => { const el = document.querySelector(${JSON.stringify(D + selector)}); return !!el && !el.hidden && !el.closest('[hidden]'); })()`;

test('opencode model picker: 刷新模型 bypasses both caches and repaints live ids', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const fixture = { ...routes, 'GET /api/opencode/models': () => json({ models: LIVE, source: 'cli' }) };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));

    // 预置一份「还没过期」的浏览器缓存：面板必须照它画旧 id，且不访问网络。
    await page.evaluate(`localStorage.setItem(${JSON.stringify(CACHE_KEY)}, ${JSON.stringify(JSON.stringify({ at: Date.now(), models: STALE }))})`);
    await page.evaluate(`window.MultiCCRunConfig.open({ configuration: { cli: 'opencode' } }, ['opencode'], () => {})`);
    assert.ok(await page.waitFor(`${optionValues}.includes('opencode/deepseek-v4-flash')`), 'stale cached ids paint first');
    assert.equal(await page.evaluate(visible('.rc-model-refresh')), true, 'opencode shows the refresh button');
    assert.equal(
      page.requests.filter(r => r.path === '/api/opencode/models').length, 0,
      'a warm browser cache must not hit the server before the button is pressed',
    );
    const before = await page.evaluate(`${optionValues}.filter(Boolean).length`);

    await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-refresh')}).click()`);
    assert.ok(await page.waitFor(`${optionValues}.includes('opencode/deepseek-v4.1-flash')`), 'live list replaces the cached one');
    assert.equal(await page.evaluate(`${optionValues}.includes('opencode/deepseek-v4-flash')`), false, 'the retired id is gone');
    assert.ok(await page.evaluate(`${optionValues}.filter(Boolean).length`) > before, 'the new model shows up');

    const calls = page.requests.filter(r => r.path === '/api/opencode/models');
    assert.equal(calls.length, 1, 'exactly one refetch');
    assert.match(calls[0].url, /refresh=1/, 'the server cache is bypassed too');
    assert.match(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-status')}).textContent`), /刷新|refreshed/i, 'the result is reported');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-refresh')}).disabled`), false, 'button is usable again');
    console.log('OpenCode refresh screenshot:', await page.screenshot('run-config-opencode-refresh'));
  });
});

// OpenCode Go 的线路 id 会在手写的 `opencodego` 与内置的 `opencode-go` 之间迁移
// （配置改写只改 provider 名，模型不变）。刷新拿到新 id 时，线路和选中的模型都要
// 跟着对齐；否则旧 id 过滤不到任何模型，下拉看起来像被清空，只能重开面板才恢复。
test('opencode model picker: 刷新模型 remaps a legacy opencodego line to the live opencode-go id', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const LEGACY = [
    { provider: 'opencodego', model: 'deepseek-v4-pro', label: 'opencodego/deepseek-v4-pro' },
  ];
  const RENAMED = [
    { provider: 'opencode-go', model: 'deepseek-v4-pro', label: 'opencode-go/deepseek-v4-pro' },
    { provider: 'opencode-go', model: 'glm-5.2', label: 'opencode-go/glm-5.2' },
  ];
  const fixture = { ...routes, 'GET /api/opencode/models': () => json({ models: RENAMED, source: 'cli' }) };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));
    await page.evaluate(`localStorage.setItem(${JSON.stringify(CACHE_KEY)}, ${JSON.stringify(JSON.stringify({ at: Date.now(), models: LEGACY }))})`);
    await page.evaluate(`window.testDialog=MultiCCRunConfig.open({ configuration: { cli: 'opencode' } }, ['opencode'], () => {})`);
    assert.ok(await page.waitFor(`${optionValues}.length > 1`));
    // 选中旧别名线路（手写 opencodego 时代留下的值）。
    await page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(D + '.rc-line')}); s.value = 'opencode-native:opencodego'; s.onchange(); })()`);
    assert.ok(await page.waitFor(`${optionValues}.includes('opencodego/deepseek-v4-pro')`), 'the legacy line paints its cached models first');

    await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-refresh')}).click()`);
    assert.ok(await page.waitFor(`${optionValues}.includes('opencode-go/glm-5.2')`),
      'the renamed live ids paint without reopening the dialog');
    assert.deepEqual(await page.evaluate(optionValues), ['opencode-go/deepseek-v4-pro', 'opencode-go/glm-5.2', '__custom__'],
      'the model dropdown is never left empty by the rename');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-line')}).value`),
      'opencode-native:opencode-go', 'the selected line follows the renamed provider id');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model')}).value`),
      'opencode-go/deepseek-v4-pro', 'the selected model keeps its id under the new prefix');
    console.log('OpenCode rename screenshot:', await page.screenshot('run-config-opencode-rename'));
  });
});

// 花名册：模型下拉由 /api/<cli>/models 这类实时目录喂的 CLI 才显示「刷新模型」。
// dsh / gemini / zcode / kimi / pi 的清单是内置表或 provider 目录，没有可刷的东西。
const ROSTER = ['opencode', 'qoder', 'codebuddy', 'commandcode', 'grok',
  'claude', 'claude-exp', 'codex', 'codex-exp'];
const STATIC_CLIS = ['dsh', 'gemini', 'zcode', 'kimi', 'pi'];
const liveRoutes = () => {
  const fixture = { ...routes };
  for (const cli of ROSTER) fixture[`GET /api/${cli}/models`] = () => json({ models: LIVE, source: 'cli' });
  return fixture;
};

test('model picker: every dynamic-catalog CLI shows the refresh button', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: liveRoutes(), screenshotDir: qaDir() }, async page => {
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig'));
    for (const cli of ROSTER) {
      await page.evaluate(`window.testDialog=MultiCCRunConfig.open({ configuration: { cli: ${JSON.stringify(cli)} } }, [${JSON.stringify(cli)}], () => {})`);
      // boot() 先画骨架再等 /api/providers；模型字段就绪后按钮状态才是终态。
      assert.ok(await page.waitFor(`${optionValues}.length > 1`));
      assert.equal(await page.evaluate(visible('.rc-model-refresh')), true, `${cli} has a live model table`);
      await page.evaluate('window.testDialog.close()');
    }
  });
});

test('model picker: static-list CLIs keep the button hidden', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: liveRoutes(), screenshotDir: qaDir() }, async page => {
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig'));
    for (const cli of STATIC_CLIS) {
      await page.evaluate(`window.testDialog=MultiCCRunConfig.open({ configuration: { cli: ${JSON.stringify(cli)} } }, [${JSON.stringify(cli)}], () => {})`);
      assert.ok(await page.waitFor(`${optionValues}.length > 1`));
      assert.equal(await page.evaluate(visible('.rc-model-refresh')), false, `${cli} has no live catalog to refresh`);
      await page.evaluate('window.testDialog.close()');
    }
  });
});

test('qoder model picker: 刷新模型 bypasses both caches and repaints live ids', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const QODER_KEY = 'multicc.qoder.models.v1';
  const STALE_QODER = [{ model: 'Qwen3.7-Max', label: 'Qwen3.7-Max' }];
  const LIVE_QODER = [{ model: 'Qwen3.8-Max', label: 'Qwen3.8-Max' }, { model: 'GLM-5.2', label: 'GLM-5.2' }];
  const fixture = { ...liveRoutes(), 'GET /api/qoder/models': () => json({ models: LIVE_QODER, source: 'cli' }) };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));
    await page.evaluate(`localStorage.setItem(${JSON.stringify(QODER_KEY)}, ${JSON.stringify(JSON.stringify({ at: Date.now(), models: STALE_QODER }))})`);
    await page.evaluate(`window.testDialog=MultiCCRunConfig.open({ configuration: { cli: 'qoder' } }, ['qoder'], () => {})`);
    assert.ok(await page.waitFor(`${optionValues}.includes('Qwen3.7-Max')`), 'stale cached ids paint first');
    assert.equal(
      page.requests.filter(r => r.path === '/api/qoder/models').length, 0,
      'a warm browser cache must not hit the server before the button is pressed',
    );

    await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-refresh')}).click()`);
    assert.ok(await page.waitFor(`${optionValues}.includes('Qwen3.8-Max')`), 'live list replaces the cached one');
    assert.equal(await page.evaluate(`${optionValues}.includes('Qwen3.7-Max')`), false, 'the retired id is gone');
    const calls = page.requests.filter(r => r.path === '/api/qoder/models');
    assert.equal(calls.length, 1, 'exactly one refetch');
    assert.match(calls[0].url, /refresh=1/, 'the server cache is bypassed too');
    assert.match(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-status')}).textContent`), /刷新|refreshed/i, 'the result is reported');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-refresh')}).disabled`), false, 'button is usable again');
    await page.evaluate('window.testDialog.close()');
  });
});

// 空目录是一个完整结果；添加线路不能因它不断发请求、替换搜索框和点击目标。
const pickerProviders = Array.from({ length: 18 }, (_, i) => ({
  id: `picker-${i}`, name: `测试线路 ${i}`, appType: 'claude', apiFormat: 'anthropic',
  compatibleClis: ['claude-exp'], model: 'model-a', modelOptions: ['model-a'],
}));
const pickerFixture = modelRoute => ({ ...routes,
  'GET /api/providers': () => json({ providers: pickerProviders, defaults: {} }),
  'GET /api/opencode/models': modelRoute,
});
async function openAutoPicker(page) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate('/run-config-host.html');
  await page.evaluate(`window.testDialog=MultiCCRunConfig.open({configuration:{cli:'claude-exp'}},['claude-exp','opencode'],()=>{})`);
  assert.ok(await page.waitFor(`document.querySelectorAll('${D}.rc-line option').length > 2`));
  await page.evaluate(`document.querySelector('${D}.rc-mode-auto').click();document.querySelector('${D}.rc-add').click()`);
  assert.ok(await page.waitFor(`document.querySelectorAll('${D}.rc-picker-item').length >= 18`));
}
async function holdPickerTarget(page) {
  await page.evaluate(`(() => {
    window.pickerSearch=document.querySelector('${D}.rc-search');
    pickerSearch.value='测试线路';pickerSearch.dispatchEvent(new Event('input',{bubbles:true}));
    window.pickerTarget=[...document.querySelectorAll('${D}.rc-picker-item')]
      .find(n=>n.querySelector('.rc-picker-name').textContent==='测试线路 9');
    pickerTarget.scrollIntoView({block:'center'});pickerTarget.focus({preventScroll:true});
    window.pickerScroll=document.querySelector('${D}.rc-picker-list').scrollTop;
    window.pickerPoolSize=document.querySelectorAll('${D}.rc-row').length;
    window.pickerPressed=false;pickerTarget.onmousedown=()=>{pickerPressed=true;};
  })()`);
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  return page.evaluate(`(() => {const r=pickerTarget.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
}
async function assertStablePicker(page) {
  assert.deepEqual(await page.evaluate(`({
    search:pickerSearch===document.querySelector('${D}.rc-search'),
    target:pickerTarget.isConnected, focus:document.activeElement===pickerTarget,
    text:document.querySelector('${D}.rc-search').value,
    scroll:Math.abs(document.querySelector('${D}.rc-picker-list').scrollTop-pickerScroll)<1
  })`), { search: true, target: true, focus: true, text: '测试线路', scroll: true });
}

for (const status of [200, 503]) test(`自动切换添加线路：OpenCode ${status === 200 ? '空目录' : '读取失败'}不循环刷新，鼠标按下后仍能添加`, async t => {
  if (!findChromeBinary()) return t.skip('需要 Chrome');
  await withCdpHarness({ routes: pickerFixture(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return json({ models: [] }, status);
  }), screenshotDir: qaDir() }, async page => {
    await openAutoPicker(page);
    const point = await holdPickerTarget(page);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    assert.ok(await page.waitFor('pickerPressed'), '鼠标按下确实落在目标线路按钮上');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(page.requests.filter(r => r.path === '/api/opencode/models').length, 1,
      '一次打开只加载一次，空结果与失败都必须结束这次加载');
    await assertStablePicker(page);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    assert.ok(await page.waitFor(`!!document.querySelector('${D}.rc-row[data-provider-id="picker-9"]')`));
    assert.equal(await page.evaluate(`document.querySelectorAll('${D}.rc-row').length-pickerPoolSize`), 1);
    assert.ok(await page.evaluate(`!!document.querySelector('${D}.rc-row[data-provider-id="picker-9"]')`));
    await page.evaluate('testDialog.close()');
  });
});

test('自动切换添加线路：慢目录返回只更新 OpenCode 分组，其他线路可继续选择', async t => {
  if (!findChromeBinary()) return t.skip('需要 Chrome');
  let release;
  const response = new Promise(resolve => { release = resolve; });
  await withCdpHarness({ routes: pickerFixture(async () => { await response; return json({ models: LIVE }); }),
    screenshotDir: qaDir() }, async page => {
    try {
      await openAutoPicker(page);
      const point = await holdPickerTarget(page);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      assert.ok(await page.waitFor('pickerPressed'), '慢响应之前按住目标线路');
      release();
      assert.ok(await page.waitFor('MultiCCChatAiConfig.openCodeNativeProviders().length > 0'));
      await new Promise(resolve => setTimeout(resolve, 100));
      await assertStablePicker(page);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      assert.ok(await page.waitFor(`!!document.querySelector('${D}.rc-row[data-provider-id="picker-9"]')`));
      assert.equal(await page.evaluate(`document.querySelectorAll('${D}.rc-row').length-pickerPoolSize`), 1);
      await page.evaluate(`pickerSearch.value='';pickerSearch.dispatchEvent(new Event('input',{bubbles:true}));`);
      assert.ok(await page.waitFor(`[...document.querySelectorAll('${D}.rc-picker-name')].some(n=>n.textContent==='OpenCode Zen')`));
      await page.evaluate(`[...document.querySelectorAll('${D}.rc-picker-item')].find(n=>n.querySelector('.rc-picker-name').textContent==='OpenCode Zen').click()`);
      assert.ok(await page.evaluate(`!!document.querySelector('${D}.rc-row[data-provider-id="opencode-native:opencode"]')`));
      console.log('添加线路稳定性截图：',await page.screenshot('auto-provider-picker-stable'));
      await page.evaluate('testDialog.close()');
    } finally { release(); }
  });
});

for (const wholeDialog of [false, true]) test(`自动切换添加线路：${wholeDialog ? '关闭弹窗' : '收起列表'}后忽略迟到响应，重新打开可读取新目录`, async t => {
  if (!findChromeBinary()) return t.skip('需要 Chrome');
  let release;
  const response = new Promise(resolve => { release = resolve; });
  await withCdpHarness({ routes: pickerFixture(async () => { await response; return json({ models: LIVE }); }),
    screenshotDir: qaDir() }, async page => {
    try {
      await openAutoPicker(page);
      assert.ok(await page.waitFor(`window.MultiCCRunConfig && !!document.querySelector('${D}.rc-search')`));
      // 保留旧宿主，验证迟到回调也没有修改已经脱离文档的 DOM。
      await page.evaluate(`window.oldPicker=document.querySelector('${D}.rc-picker-host');`);
      if (wholeDialog) {
        // close 事件是异步派发的；主动延迟处理器，覆盖关闭后响应先到的窗口。
        await page.evaluate(`const finishClose=testDialog.onclose;testDialog.onclose=()=>setTimeout(finishClose,200);
          testDialog.close();window.outsideInput=document.createElement('input');document.body.append(outsideInput);outsideInput.focus();`);
      } else {
        await page.evaluate(`document.querySelector('${D}.rc-add').click();document.querySelector('${D}.rc-add').focus();`);
      }
      await page.evaluate(`window.oldPickerContents=oldPicker.innerHTML;window.focusBeforeReply=document.activeElement;`);
      release();
      assert.ok(await page.waitFor('MultiCCChatAiConfig.openCodeNativeProviders().length > 0'));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(await page.evaluate(`({contents:oldPicker.innerHTML===oldPickerContents,
        focus:document.activeElement===focusBeforeReply, active:document.activeElement.tagName})`),
      {contents:true, focus:true, active:wholeDialog ? 'INPUT' : 'BUTTON'});
      if (wholeDialog) {
        assert.ok(await page.waitFor('!testDialog.isConnected'));
        await page.evaluate(`window.testDialog=MultiCCRunConfig.open({configuration:{cli:'claude-exp'}},['claude-exp','opencode'],()=>{})`);
        assert.ok(await page.waitFor(`document.querySelectorAll('${D}.rc-line option').length > 2`));
        await page.evaluate(`document.querySelector('${D}.rc-mode-auto').click()`);
      }
      await page.evaluate(`document.querySelector('${D}.rc-add').click()`);
      assert.ok(await page.waitFor(`[...document.querySelectorAll('${D}.rc-picker-name')].some(n=>n.textContent==='OpenCode Zen')`));
      assert.equal(page.requests.filter(r => r.path === '/api/opencode/models').length, 1);
      await page.evaluate('testDialog.close()');
    } finally { release(); }
  });
});
