'use strict';
// 语音那一格（旧 manage 页 voice）这次从「嵌旧 manage 页的 iframe」改成 Air 原生面板
// （air-voice.js）。这一格是四块拼的，所以每块都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，这条能证明它没被悄悄嵌回来）；
//   ② 全局语音那一块是**复用**旧页模块的（manage-qwen-audio.js 纯 id 驱动）—— 输入框
//      按同一批 id 画出来、那行状态被它画进 #qwen-audio-global、「保存语音配置」那颗
//      按钮真的落到它的 saveQwenAudioSettings() 上；
//   ③ 精修 / Whisper / ASR 三块自己重写了 —— 值逐栏对上，密钥栏 value 必须为空、
//      placeholder 说「已配置」，提交的 body 里不能有打码值；
//   ④ ASR 那九栏不再住弹窗里 —— 收在卡片里，抬头一行摘要说清默认哪家 / 已配哪几家；
//   ⑤ 接口报错时页面上出现的是失败，不是「已保存」。
//
// 文案断言不写死中文：先 await page.evaluate("t('airVoiceXxx')") 取回来再比。唯一的
// 例外是 manage-qwen-audio.js 自己渲染的那几处（硬编码中文）—— 那份模块同时挂在旧
// manage 页上，不能为 Air 改词，所以那里直接比中文字面量，并在注释里标明出处。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air voice panel is native: qwen block reuses the legacy module, refine/whisper/asr write through the real API', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-voice-qa');
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

  // ── fixture：一份完整的 /api/settings/voice 状态 ─────────────────────────
  // 密钥一律是编的字符串（形状像 key 而已），真密钥永不进测试夹具。GET 回来的是**打码**
  // 值 —— 面板只该拿它当「有没有」的证据。
  const MASK = {
    openrouter: 'sk-or-v1****cafe',
    whisper: 'gsk_fixt****1234',
    qwen: 'sk-fixt****abcd',
  };
  const VOICE = {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: MASK.openrouter,
    hasKey: true,
    model: 'google/gemini-2.0-flash-001',
    whisperBaseUrl: 'https://whisper.example.test/v1',
    whisperApiKey: MASK.whisper,
    hasWhisperKey: true,
    whisperModel: 'whisper-large-v3-turbo',
    whisperLanguage: 'zh',
    whisperPrompt: 'React, useState, TypeScript',
    qwenAudio: {
      hasApiKey: true,
      apiKey: MASK.qwen,
      baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
      model: 'qwen-audio-3.0-realtime-plus',
      voice: 'longanqian',
    },
    // 三家徽标故意不重样：OpenAI 就绪、火山差一个 token（AppID 有、token 没有，
    // ready 判定是「两个都有」）、FunASR 没配 —— 三种状态一次覆盖到。
    asr: {
      provider: 'volcano',
      hasOpenaiKey: true,
      openaiUrl: 'wss://api.openai.com/v1/realtime',
      openaiModel: 'gpt-4o-transcribe',
      hasVolcAppId: true,
      hasVolcToken: false,
      volcResourceId: 'volc.bigasr.sauc.duration',
      volcUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
      funasrUrl: '',
      funasrMode: '2pass',
      status: { openai: { ready: true }, volcano: { ready: false }, funasr: { ready: false } },
    },
  };
  const posts = [];
  // 保存成功后服务端会回显成为唯一真相，所以 POST 要真的改到 fixture 状态上 ——
  // 否则「存完重读一次」这条就断不出来。
  const applyPost = body => {
    for (const key of ['baseUrl', 'model', 'whisperBaseUrl', 'whisperModel', 'whisperLanguage', 'whisperPrompt']) {
      if (body[key] !== undefined) VOICE[key] = body[key];
    }
    if (body.apiKey) { VOICE.hasKey = true; VOICE.apiKey = 'sk-or-v1****' + body.apiKey.slice(-4); }
    if (body.whisperApiKey) { VOICE.hasWhisperKey = true; VOICE.whisperApiKey = 'gsk_fixt****' + body.whisperApiKey.slice(-4); }
    const asr = body.asr;
    if (asr) {
      if (asr.provider) VOICE.asr.provider = asr.provider;
      if (asr.openaiApiKey) VOICE.asr.hasOpenaiKey = true;
      if (asr.openaiUrl !== undefined) VOICE.asr.openaiUrl = asr.openaiUrl;
      if (asr.openaiModel !== undefined) VOICE.asr.openaiModel = asr.openaiModel;
      if (asr.volcAppId) VOICE.asr.hasVolcAppId = true;
      if (asr.volcAccessToken) VOICE.asr.hasVolcToken = true;
      if (asr.volcResourceId !== undefined) VOICE.asr.volcResourceId = asr.volcResourceId;
      if (asr.volcUrl !== undefined) VOICE.asr.volcUrl = asr.volcUrl;
      if (asr.funasrUrl !== undefined) VOICE.asr.funasrUrl = asr.funasrUrl;
      if (asr.funasrMode !== undefined) VOICE.asr.funasrMode = asr.funasrMode;
      if (asr.funasrUrl) VOICE.asr.status.funasr = { ready: true };
      VOICE.asr.status.volcano = { ready: !!(VOICE.asr.hasVolcAppId && VOICE.asr.hasVolcToken) };
    }
    const qwen = body.qwenAudio;
    if (qwen) {
      if (qwen.apiKey) VOICE.qwenAudio.hasApiKey = true;
      for (const key of ['baseUrl', 'model', 'voice']) if (qwen[key] !== undefined) VOICE.qwenAudio[key] = qwen[key];
    }
  };
  // 出错那一段用它把 POST 掰成 500 + {ok:false,message}。
  let postFailure = null;
  routes['GET /api/settings/voice'] = () => json(VOICE);
  routes['POST /api/settings/voice'] = req => {
    if (postFailure) return { status: postFailure.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, message: postFailure.message }) };
    const body = JSON.parse(req.body);
    posts.push(body);
    applyPost(body);
    return json({ ok: true });
  };
  // 复用模块（manage-qwen-audio.js）自己要拉的三条，以及「安装运行时 / 安装并启用」
  // 会打的两条。它们真的发出去，所以必须 mock 掉。
  const gatewayPuts = [];
  routes['/api/v1/voice-runtime'] = () => json({ ok: true, runtime: { state: 'ready', installed: true, package: { version: '1.2.3-fixture' } } });
  routes['/api/v1/voice-gateway'] = () => json({ ok: true, gateway: { enabled: true, provider: 'qwen-audio-agent' }, legacy: [] });
  routes['/api/v1/voice-gateway/runtime'] = () => json({ ok: true, runtime: { state: 'running' } });
  routes['POST /api/v1/voice-runtime/install'] = () => json({ ok: true });
  routes['PUT /api/v1/voice-gateway'] = req => { gatewayPuts.push(JSON.parse(req.body)); return json({ ok: true }); };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const calls = () => page.requests.filter(r => r.path === '/api/settings/voice').map(r => `${r.method} ${r.path}`);
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const value = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
    const placeholder = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.placeholder ?? null`);
    // 文案一律先在页面里取回 t(key)，再跟页面文本比 —— 词表改动不该弄红这个用例。
    const label = key => page.evaluate(`t(${JSON.stringify(key)})`);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 从设置中心进去：原生面板，不嵌旧 manage 页 ───────────────────────
    await page.navigate('/air?dir=d1&view=settings');
    const voiceCardName = await label('airAdminPanelVoice');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(await label('airSettingsCenter'))}`), '先落在设置中心');
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')]
      .find(card => card.querySelector('strong').textContent === ${JSON.stringify(voiceCardName)}).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(await label('airAdminVoice'))}`), '点进去落在语音设置页');
    assert.equal(await text('#task-breadcrumb'), await label('airCrumbSettings'), '面包屑说的是设置中心这一类');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←返回设置中心', '↻刷新'], '工具条是面板自己的（返回设置中心 / 刷新）');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-voice-card').length`), 4, '四块都在：全局语音 / ASR / 精修 / Whisper');
    assert.ok(calls().some(call => call === 'GET /api/settings/voice'), '打开面板打了 GET /api/settings/voice');
    await page.screenshot('00-voice-native-desktop');

    // ── ② 全局语音那一块：复用旧模块，输入框按同一批 id 画 ─────────────────
    assert.ok(await page.waitFor(`document.getElementById('qwen-audio-global')?.children.length > 0`), '复用模块把状态行画进了 #qwen-audio-global');
    assert.equal(await value('#qwen-audio-url'), VOICE.qwenAudio.baseUrl);
    assert.equal(await value('#qwen-audio-model'), VOICE.qwenAudio.model);
    assert.equal(await value('#qwen-audio-voice'), VOICE.qwenAudio.voice);
    // 下面这几处是 manage-qwen-audio.js 自己写的硬编码中文（它同时挂在旧 manage 页上，
    // 不能为 Air 改词）——所以这里直接比中文字面量，不走 t()。
    assert.equal(await value('#qwen-audio-key'), '', '打码 key 不进 value');
    assert.equal(await placeholder('#qwen-audio-key'), '已配置（留空不修改）');
    assert.equal(await text('#qwen-audio-install'), '运行时 1.2.3-fixture 已安装', '安装按钮的文案由复用模块按 runtime 状态写');
    assert.equal(await text('#qwen-audio-status'), '已安装 · Key 已配置', '状态行也是复用模块写的');
    // 三个按钮真的落到复用模块挂在 window 上的那三个函数：点「保存语音配置」应当打出
    // qwenAudio 那一段 body（key 栏空着就不带 apiKey）。
    await page.evaluate(`document.getElementById('qwen-audio-save').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent === 'Qwen Audio 配置已保存'`), '保存按钮落到复用模块的 saveQwenAudioSettings');
    assert.deepEqual(posts.at(-1), { qwenAudio: { model: VOICE.qwenAudio.model, voice: VOICE.qwenAudio.voice, baseUrl: VOICE.qwenAudio.baseUrl } },
      'body 就是复用模块自己那一段（没填 key 就不带 key）');
    // 另外两颗按钮同样落在复用模块的 installQwenAudioRuntime / enableQwenAudioGlobal 上：
    // 打的是它那两条接口，不是我在 Air 里另接的一套。文案仍然是它的硬编码中文。
    const waitForRequest = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const hit = page.requests.find(predicate);
        if (hit) return hit;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return null;
    };
    await page.evaluate(`document.getElementById('qwen-audio-install').click()`);
    assert.ok(await waitForRequest(r => r.method === 'POST' && r.path === '/api/v1/voice-runtime/install'), '安装按钮落到复用模块的 installQwenAudioRuntime');
    await page.evaluate(`document.getElementById('qwen-audio-enable').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent === '全局实时语音已启用'`), '启用按钮落到复用模块的 enableQwenAudioGlobal');
    assert.ok(await waitForRequest(r => r.method === 'PUT' && r.path === '/api/v1/voice-gateway'), '启用走的是它那条 PUT /api/v1/voice-gateway');
    assert.deepEqual(gatewayPuts, [{ enabled: true, provider: 'qwen-audio-agent', autoInstall: true }], 'PUT 的 body 由复用模块给');

    // ── ③ 精修三栏 + Whisper 五栏：值逐项对上，密钥栏留空 ─────────────────
    assert.equal(await value('#vs-base-url'), VOICE.baseUrl);
    assert.equal(await value('#vs-model'), VOICE.model);
    assert.equal(await value('#ws-base-url'), VOICE.whisperBaseUrl);
    assert.equal(await value('#ws-model'), VOICE.whisperModel);
    assert.equal(await value('#ws-language'), VOICE.whisperLanguage);
    assert.equal(await value('#ws-prompt'), VOICE.whisperPrompt);
    const configuredHint = await label('airVoiceKeyConfiguredHint');
    for (const selector of ['#vs-api-key', '#ws-api-key']) {
      assert.equal(await value(selector), '', `打码值绝不写进 value：${selector}`);
      assert.equal(await placeholder(selector), configuredHint, `${selector} 的 placeholder 说「已配置（留空不修改）」`);
    }
    // 打码串一个都不许出现在页面上（它只配当「有没有」的证据）。
    const panelText = await page.evaluate(`document.getElementById('admin-content').innerText`);
    for (const masked of Object.values(MASK)) {
      assert.equal(panelText.includes(masked), false, '页面上不该出现打码值：' + masked);
    }
    assert.equal(await text('#vs-status'), '', '刚打开时没有状态文案');

    // ── ④ ASR：不弹窗，收在卡片里；抬头一行摘要，展开才有九栏 ───────────────
    assert.equal(await page.evaluate(`document.getElementById('air-voice-asr-body').hidden`), true, '默认收起');
    assert.equal(await text('#air-voice-asr-toggle'), await label('airVoiceAsrExpand'));
    const asrName = { openai: await label('airVoiceAsrNameOpenai'), volcano: await label('airVoiceAsrNameVolcano'), funasr: await label('airVoiceAsrNameFunasr') };
    const asrShort = { openai: await label('airVoiceAsrShortOpenai'), volcano: await label('airVoiceAsrShortVolcano'), funasr: await label('airVoiceAsrShortFunasr') };
    // 摘要行的拼装口径跟模块里那三句一样：前半句点默认那家，后半句点已配置的几家
    // （只有 ready 的算；火山只配了 AppID、没有 token，所以不算）。
    const summaryFmt = await label('airVoiceAsrSummary');
    const summaryReadyFmt = await label('airVoiceAsrSummaryReady');
    const summaryNoneFmt = await label('airVoiceAsrSummaryNone');
    const listSep = await label('airVoiceAsrListSep');
    const expectedSummary = (provider, ready) => summaryFmt.replace('{provider}', provider)
      + (ready.length ? summaryReadyFmt.replace('{list}', ready.join(listSep)) : summaryNoneFmt);
    assert.equal(await text('#asr-summary'), expectedSummary(asrName.volcano, [asrShort.openai]),
      '摘要行：默认火山引擎 + 已配置 OpenAI（只有它 ready）');
    await page.evaluate(`document.getElementById('air-voice-asr-toggle').click()`);
    assert.equal(await page.evaluate(`document.getElementById('air-voice-asr-body').hidden`), false, '点一下展开');
    assert.equal(await text('#air-voice-asr-toggle'), await label('airVoiceAsrCollapse'));
    assert.equal(await page.evaluate(`document.querySelectorAll('#asr-modal').length`), 0, '不再造一个嵌套弹窗');
    assert.deepEqual(await page.evaluate(`[...document.getElementById('asr-provider').options].map(o => o.value)`), ['openai', 'volcano', 'funasr']);
    assert.equal(await value('#asr-provider'), VOICE.asr.provider, '默认提供商按服务端回显');
    // 三家徽标：就绪 / 未配置 / 未配置（火山差一个 token，ready 判定是两个都有）。
    assert.deepEqual(await page.evaluate(`['asr-openai-badge','asr-volc-badge','asr-funasr-badge'].map(id => document.getElementById(id).textContent)`),
      [await label('airVoiceAsrReady'), await label('airVoiceAsrNotConfigured'), await label('airVoiceAsrNotConfigured')]);
    assert.deepEqual(await page.evaluate(`['asr-openai-url','asr-openai-model','asr-volc-resource','asr-volc-url','asr-funasr-url','asr-funasr-mode'].map(id => document.getElementById(id).value)`),
      [VOICE.asr.openaiUrl, VOICE.asr.openaiModel, VOICE.asr.volcResourceId, VOICE.asr.volcUrl, VOICE.asr.funasrUrl, VOICE.asr.funasrMode],
      '非密钥栏全部按服务端回显');
    // 密钥栏：有值的（openai key / volc AppID）只写 placeholder；没值的（volc token）
    // 退回示例文案。
    assert.equal(await value('#asr-openai-key'), '');
    assert.equal(await placeholder('#asr-openai-key'), configuredHint);
    assert.equal(await value('#asr-volc-appid'), '');
    assert.equal(await placeholder('#asr-volc-appid'), configuredHint);
    assert.equal(await value('#asr-volc-token'), '');
    assert.equal(await placeholder('#asr-volc-token'), await label('airVoicePhVolcToken'), 'AppID 的兄弟（token）没配，placeholder 退回示例');
    await page.screenshot('01-voice-asr-expanded');

    // ── ⑤ Whisper 保存：body 逐字段，language/prompt 无条件带上 ────────────
    await page.evaluate(`(() => {
      document.getElementById('ws-language').value = 'en';
      document.getElementById('ws-prompt').value = 'Kubernetes, Helm, kubectl';
      document.getElementById('ws-save').click();
    })()`);
    const savedText = await label('saved');
    assert.ok(await page.waitFor(`document.getElementById('ws-status').textContent === ${JSON.stringify(savedText)}`), '保存成功');
    assert.equal(await text('#vs-status'), savedText, '两张卡共用一条保存路径，状态一起变（跟旧页一样）');
    assert.equal(await text('#notice'), await label('airVoiceSavedNotice'));
    assert.deepEqual(posts.at(-1), {
      baseUrl: VOICE.baseUrl,
      model: VOICE.model,
      whisperBaseUrl: VOICE.whisperBaseUrl,
      whisperModel: VOICE.whisperModel,
      // 这两项旧页就是无条件覆盖（清空 = 改成空），所以永远在 body 里。
      whisperLanguage: 'en',
      whisperPrompt: 'Kubernetes, Helm, kubectl',
    }, 'body 里只有填了值的键：两个密钥栏空着就不出现');
    // 存完重新读一次：服务端回显是唯一真相（fixture 也真的改了状态）。
    assert.equal(await calls().at(-1), 'GET /api/settings/voice', '保存后重新 load 一次');
    assert.equal(await value('#ws-language'), 'en', '回显的就是刚存进去的值');
    await page.screenshot('02-voice-whisper-saved');

    // ── ⑥ ASR 保存：provider 永远带上，没改的密钥不出现在 body ─────────────
    await page.evaluate(`document.getElementById('asr-save').click()`);
    assert.ok(await page.waitFor(`document.getElementById('asr-status').textContent === ${JSON.stringify(savedText)}`), 'ASR 保存成功');
    assert.equal(await text('#notice'), await label('airVoiceAsrSavedNotice'));
    assert.deepEqual(posts.at(-1), {
      asr: {
        provider: 'volcano',
        openaiUrl: VOICE.asr.openaiUrl,
        openaiModel: VOICE.asr.openaiModel,
        volcResourceId: VOICE.asr.volcResourceId,
        volcUrl: VOICE.asr.volcUrl,
        funasrMode: VOICE.asr.funasrMode,
      },
    }, 'provider 永远带上；funasrUrl 空着、三个密钥栏空着就都不出现');
    // 换一家 + 真填一个 key：provider 跟着变，填了的 key 才进 body。
    await page.evaluate(`(() => {
      document.getElementById('asr-provider').value = 'funasr';
      document.getElementById('asr-openai-key').value = 'sk-openai-fixture-typed';
      document.getElementById('asr-save').click();
    })()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent === ${JSON.stringify(await label('airVoiceAsrSavedNotice'))}`));
    assert.equal(posts.at(-1).asr.provider, 'funasr', 'provider 跟着选择走');
    assert.equal(posts.at(-1).asr.openaiApiKey, 'sk-openai-fixture-typed', '用户新填的 key 才进 body');
    assert.equal('volcAppId' in posts.at(-1).asr, false, '没动过的打码字段（AppID）不进 body');
    assert.equal('volcAccessToken' in posts.at(-1).asr, false);
    assert.ok(await page.waitFor(`document.getElementById('asr-summary').textContent === ${JSON.stringify(expectedSummary(asrName.funasr, [asrShort.openai]))}`),
      '存完重读：摘要跟着变成默认 FunASR · 已配置 OpenAI（火山仍然缺 token）');

    // ── ⑦ 接口报错：页面上出现失败，而不是「已保存」 ──────────────────────
    postFailure = { status: 500, message: '写入失败：settings 文件只读' };
    const failedText = (await label('saveFailed')).replace('{error}', postFailure.message);
    await page.evaluate(`document.getElementById('vs-save').click()`);
    assert.ok(await page.waitFor(`document.getElementById('vs-status').textContent === ${JSON.stringify(failedText)}`), '精修/Whisper 保存失败时状态行说的是失败');
    assert.equal(await text('#ws-status'), failedText, '两张卡一起报失败');
    assert.notEqual(await text('#notice'), await label('airVoiceSavedNotice'), '不该出现成功提示');
    await page.evaluate(`document.getElementById('asr-save').click()`);
    assert.ok(await page.waitFor(`document.getElementById('asr-status').textContent === ${JSON.stringify(failedText)}`), 'ASR 保存失败同样落到状态行');
    await page.screenshot('03-voice-save-failed');

    // 读接口挂了也要在页面上说一声（而不是静默留一屏空输入框）。
    postFailure = null;
    routes['GET /api/settings/voice'] = () => ({ status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, message: '设置服务不可用' }) });
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('刷新')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-voice-error').hidden === false`), '读失败要在面板上露出来');
    assert.equal(await text('#air-voice-error'), (await label('airAdminLoadFailed')).replace('{message}', '设置服务不可用'));
    routes['GET /api/settings/voice'] = () => json(VOICE);

    // ── ⑧ 窄屏：左标签右控件那一行要能落成上下两行，不许横向溢出 ────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=voice');
    assert.ok(await page.waitFor(`document.querySelectorAll('#admin-content .air-voice-card').length === 4`), '窄屏上四块照样渲染');
    const narrow = await page.evaluate(`(() => {
      const panel = document.querySelector('#admin-content .air-voice');
      const row = document.querySelector('.air-voice-row');
      const labelBox = row.querySelector('label').getBoundingClientRect();
      const cell = row.querySelector('.air-voice-cell').getBoundingClientRect();
      return {
        columns: getComputedStyle(row).gridTemplateColumns.split(' ').length,
        labelBottom: Math.round(labelBox.bottom), cellTop: Math.round(cell.top),
        overflow: panel.scrollWidth - panel.clientWidth,
        rowRight: Math.round(cell.right), panelRight: Math.round(panel.getBoundingClientRect().right),
      };
    })()`);
    assert.equal(narrow.columns, 1, '窄屏上标签与控件各占一行');
    assert.ok(narrow.labelBottom <= narrow.cellTop + 1, `标签在控件上面（${narrow.labelBottom} vs ${narrow.cellTop}）`);
    assert.ok(narrow.overflow <= 1, `面板不许横向溢出（${narrow.overflow}px）`);
    assert.ok(narrow.rowRight <= narrow.panelRight + 1, '控件不越出面板');
    await page.screenshot('04-voice-native-mobile');
  });
});
