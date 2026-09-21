'use strict';
// Air 是唯一的产品主界面（/ 、/manage、/chat.html、/task-shell.html 都 302 到它），
// 所以「整个产品 UI 能在中文/English 之间切换」这句话最终就落在这一页上。这组断言
// 盯两件事：
//   ① 语言切到 en 之后，Air 壳里不能再有任何中文 —— 文本节点、title / aria-label /
//      placeholder 都算，只放过装饰性的全角符号（＋ 这种图标不是文案）；
//   ② 侧栏那颗切换按钮真的走通「写 localStorage + reload」，并且默认还是中文。
// 断言的是「扫出来的清单为空」，而不是几个采样点：漏一个节点就是漏一句中文。
//
// 刻意不用「innerText 里有汉字吗」：innerText 看不到 title / aria-label / 屏读文案，
// 也看不到藏起来的浮层 —— 而那几处正好是历史漏点最多的地方。
//
// fixture 里的目录名和任务标题一律用英文：中文 fixture 会把「界面漏翻」和「用户数据
// 本来就是中文」混在一起，而后者是必须原样显示的（不能翻译用户自己的标题）。
//
// 对话帧（#conversation）在 Air 文档之外，扫不到也不该扫：它是个独立文档，本测试
// 把它换成一个空壳，免得它自己那堆请求混进来。
//
// 这份断言管的是**Air 自己的文档**。同一个 Air 窗口里还有两类 iframe 属于别的文档，
// 它们的中文不在这里的判据内 —— 但得说清楚，免得把「本文件全绿」读成「屏幕上没有中文」：
//   ① 对话帧（chat.html / task-shell.html）：它自己的文案走同一份词典，本轮修的是
//      它嵌在 Air 时露出来的那几条（上下文 / 详情 / 入 / 出 之类）；
//   ② 侧栏几格里「暂用兼容实现」的旧管理台（air-admin.js 的 .air-legacy-frame →
//      /manage.html?view=…&embed=air，如消息桥接）。那些页面的文案是 manage.html
//      自己的存量，不在本次「Air 壳」的范围内，英文模式下仍会露出中文。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 扫「这一页里还有没有中文」。排除 iframe（另一个文档）和 script/style（不是界面文案）。
// 全角符号（＋ 之类）是图标，先剔除再判 —— 判据是「汉字」，不是「非 ASCII」。
// 语言按钮是唯一的例外：它必须两种语言都写出来（中文界面上写 EN/中、英文界面上写
// 中/EN），否则用户不知道点了会变成什么 —— 那半个「中」是它的本意。
const SCAN = `(() => {
  const HAN = /[\\u3400-\\u9fff\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65]/;
  const ICON = /[＋－×÷←↑→↓⤢]/g;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);
  const label = el => {
    if (el === document.body) return 'body';
    const id = el.id ? '#' + el.id : (el.classList.length ? '.' + el.classList[0] : '');
    return label(el.parentElement) + '>' + el.tagName.toLowerCase() + id;
  };
  const dirty = value => value && HAN.test(String(value).replace(ICON, ''));
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (SKIP.has(el.tagName) || el.id === 'air-lang-btn') continue;
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (dirty(value)) out.push(label(el) + ' @' + attr + ' = ' + value);
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && dirty(node.nodeValue)) out.push(label(el) + ' = ' + node.nodeValue.trim().slice(0, 70));
    }
  }
  if (dirty(document.title)) out.push('document.title = ' + document.title);
  return out;
})()`;

test('the Air shell renders English end to end and the sidebar toggle persists the choice', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public');
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html|svg)$/.test(name))) {
    const type = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', html: 'text/html' }[file.slice(file.lastIndexOf('.') + 1)];
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': `${type}; charset=utf-8` } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = {
    headers: { 'content-type': 'text/javascript' },
    body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
  };
  // 对话帧是另一个文档，本测试只断 Air 自己那一页：给个空壳，省掉一堆无关请求。
  routes['/chat.html'] = { body: '<!doctype html><meta charset="utf-8"><title>frame</title>', headers: { 'content-type': 'text/html; charset=utf-8' } };
  routes['/task-shell.html'] = routes['/chat.html'];

  const configuration = { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
    model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' };
  const task = (id, dirId, title, status, runState, updatedAt) => ({ id, dirId, title, recordType: 'planned', workflowStage: 'doing',
    status, runState, updatedAt, resource: { residency: 'planned', lease: 'idle' }, configuration });
  const airTasks = [
    task('tsk_here', 'd1', 'Round the billing totals correctly', 'active', 'idle', 5000),
    task('tsk_wait', 'd2', 'Empty-state copy on the sign-in page', 'active', 'waiting', 9000),
    task('tsk_done', 'd1', 'Retry the failed export', 'done', 'succeeded', 1000),
  ];
  const directories = [
    { id: 'd1', name: 'MultiCC main repo', path: '/projects/multicc' },
    { id: 'd2', name: 'North storefront', path: '/projects/storefront' },
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: airTasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  for (const id of ['tsk_here', 'tsk_wait', 'tsk_done']) {
    const item = airTasks.find(entry => entry.id === id);
    routes[`/api/air/tasks/${id}`] = routes[`/api/task-shell-tasks/${id}`] = () => json({ ok: true,
      task: item, sessionId: `session-${id}`, ownerShellId: 'shell-a', readOnly: false,
      execution: { busy: false, status: 'idle' }, resource: item.resource, attribution: {},
      roleBindings: { version: 0, bindings: [] }, messages: [] });
    routes[`POST /api/task-board/tasks/${id}/chat-session`] = () => json({ ok: true, sessionId: `session-${id}` });
  }
  routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });
  routes['/api/settings/power'] = () => json({ available: true, enabled: false });
  routes['/api/version-check'] = () => json({ current: '2.40.0', channel: 'dev', latestVersion: '2.40.0', updateAvailable: false });
  routes['/api/server-info'] = () => json({ url: 'http://192.168.1.9:3000', uptimeMs: 3600_000 });
  routes['/api/apk-info'] = () => json({ exists: false });
  routes['/api/ios-ota-info'] = () => json({ exists: false });
  // 侧栏那几格（Provider / 隧道 / 文档 / 记忆…）点开才画，各自的接口都得有回声，
  // 否则面板停在「读取中」或错误态 —— 那样扫出来的「没有中文」是假的。
  routes['/api/providers'] = () => json({ providers: [], defaults: {} });
  routes['/api/provider-defaults'] = () => json({ defaults: {} });
  routes['/api/settings/tunnel'] = () => json({});
  routes['/api/settings/access-token'] = () => json({ configured: false });
  routes['/api/tunnel/sakurafrp'] = () => json({ installed: false, bound: false });
  routes['/api/tunnel/funnel'] = () => json({ enabled: false });
  routes['/api/tunnel/ipv6'] = () => json({ enabled: false });
  routes['/api/aux/config'] = () => json({});
  routes['/api/aux/status'] = () => json({});
  routes['/api/aux/history'] = () => json({ runs: [] });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-i18n-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const booted = () => page.waitFor('document.getElementById("task-title").textContent === "Round the billing totals correctly"');
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await booted(), 'Air must boot in the fixture');

    // ── 默认仍然是中文：老用户打开 Air 不会被换掉语言 ──────────────────────
    assert.equal(await page.evaluate('localStorage.getItem("multicc_lang")'), null, 'a fresh install stores no language');
    assert.equal(await page.evaluate('document.documentElement.lang'), 'zh', 'the shell boots in Chinese');
    assert.equal(await page.evaluate('document.getElementById("task-list-title").textContent'), '最近任务');
    assert.equal(await page.evaluate('document.getElementById("air-lang-btn").textContent'), '中/EN');
    const zhDirty = await page.evaluate(SCAN);
    assert.ok(zhDirty.length > 5, `the scanner must actually find Chinese in Chinese mode, got ${JSON.stringify(zhDirty)}`);
    t.diagnostic('zh scan: ' + zhDirty.length + ' nodes');

    // ── 切到 en（就是切按钮会做的事：写 localStorage + reload）─────────────
    await page.evaluate(`localStorage.setItem('multicc_lang', 'en')`);
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await booted(), 'Air must boot in English');

    assert.equal(await page.evaluate('document.documentElement.lang'), 'en', 'applyI18n must sync <html lang>');
    assert.equal(await page.evaluate('document.getElementById("air-lang-btn").textContent'), 'EN/中',
      'the toggle label is the one thing that stays bilingual');
    assert.equal(await page.evaluate('document.getElementById("air-lang-btn").title'), 'Switch language: 中文 / English');

    // 侧栏、页头、任务清单：几个采样的锚点，钉住「确实换成了英文」这件事本身，
    // 再谈「没有中文残留」。断言的是「这个节点显示的就是词典里 en 那一条」——
    // 而不是把英文原文抄进测试（抄一遍就成了第二份词典，改文案要改两处）。
    const spots = await page.evaluate(`(() => {
      const read = el => el ? (el.textContent || '').trim() : null;
      const one = (selector, key) => {
        const el = document.querySelector(selector);
        return { selector, key, shown: read(el), expected: window.t(key), zh: window.I18N.zh[key] };
      };
      const many = (selector, keys) => [...document.querySelectorAll(selector)].map((el, index) => ({
        selector: selector + '[' + index + ']', key: keys[index], shown: read(el),
        expected: window.t(keys[index]), zh: window.I18N.zh[keys[index]],
      }));
      return [
        one('.space-shortcuts span', 'airWorkspace'),
        one('#create [data-i18n]', 'airNewTask'),
        one('#task-list-title', 'airRecentTasks'),
        one('.side-bottom > small', 'airTagline'),
        one('#refresh .air-tool-name', 'airRefresh'),
        one('#details-toggle [data-i18n]', 'airDetails'),
        one('#palette-note', 'airPaletteSearchHint'),
        one('#schedule-dialog-title', 'airNewScheduledTask'),
        one('#schedule-save', 'airScheduleCreateAndBind'),
        one('#console-close', 'airBackToTask'),
        ...many('#sidebar .nav-row [data-i18n]', ['airConsole', 'airScheduledTasks']),
        ...many('#delivery-steps span', ['airStepTurnSucceeded', 'airStepCodeDelivered', 'airStepSourceStable', 'airStepAttribution']),
      ];
    })()`);
    for (const spot of spots) {
      assert.equal(spot.shown, spot.expected, `${spot.selector} must show the catalog string for ${spot.key}`);
      assert.notEqual(spot.expected, spot.zh, `${spot.key} is not translated yet — its en value is still the Chinese one`);
    }
    assert.equal(await page.evaluate('document.getElementById("task-title").textContent'),
      'Round the billing totals correctly', 'the user\'s own title is data: it is shown as-is, never translated');
    // 交付卡的 eyebrow 是个随状态走的标签（airAttrEyebrow*），钉不到某一条 key 上：
    // 断它「等于 en 里某个 eyebrow 文案」——是英文那套，而不是中文那套。
    assert.ok(await page.evaluate(`(() => {
      const shown = document.getElementById('delivery-eyebrow').textContent;
      return Object.entries(window.I18N.en).filter(([key]) => key.startsWith('airAttrEyebrow'))
        .some(([, value]) => value === shown);
    })()`), 'the delivery eyebrow must be one of the English state labels');

    // 任务配置弹窗里的 Auto 候选池同样是共享模块（auto-provider-editor.js）现画的，
    // 静态 DOM 里一个字都没有 —— 但它确实渲染在 Air 里（选 ⚡ Auto 线路时才挂上来）。
    // 所以直接把它挂进页面，让下面那次整页扫描连它一起覆盖；摘出来的字数用来证明
    // 「真的挂上了东西」，不然挂个空壳也能让扫描空过。
    const probe = `(() => {
      const host = document.createElement('div');
      host.id = 'i18n-auto-probe';
      document.body.append(host);
      window.MultiCCAutoProviderEditor.mount({
        document, container: host, protocol: 'openai_responses',
        providers: [
          { id: 'p1', name: 'Lab', apiFormat: 'openai_responses' },
          { id: 'p2', name: 'Bench', apiFormat: 'openai_responses' },
        ],
      });
      return host.innerText.trim();
    })()`;
    const autoShown = await page.evaluate(probe);
    assert.ok(autoShown.length > 20, `the Auto candidate pool must render its copy: ${JSON.stringify(autoShown)}`);
    assert.ok(!/[㐀-鿿]/.test(autoShown), `the Auto candidate pool still renders Chinese: ${autoShown}`);

    // 侧栏那几格是同一个壳里换面板，内容全由 air-*.js 现画 —— 首屏扫描看不到它们。
    // 「整个产品 UI 能在中文/English 之间切换」包括这些格子里的一字一句，所以逐格点开，
    // 每开一格扫一次（失败了直接说是哪一格，不用在一整页里找）。
    // bridges / provider 这类格子的正文是嵌进来的旧管理台 iframe（.air-legacy-frame），
    // 那份中文属于 manage.html，扫不到 —— 见文件头那条边界说明。
    for (const view of ['docs', 'memory', 'settings', 'provider', 'tunnel', 'bridges']) {
      await page.evaluate(`document.querySelector('[data-air-view="${view}"]').click()`);
      assert.ok(await page.waitFor(`(() => {
        const panel = document.getElementById('admin-content');
        return !!panel && panel.textContent.trim().length > 0;
      })()`), `the "${view}" panel must render something to scan`);
      const leaked = await page.evaluate(SCAN);
      assert.deepEqual(leaked, [], `Chinese left in the Air "${view}" panel:\n  ${leaked.join('\n  ')}`);
      // 记一下每格画出多少字：空面板扫出来当然干净，那不算数。
      t.diagnostic(`${view} panel: ${await page.evaluate(`document.getElementById('admin-content').textContent.trim().length`)} chars`);
    }

    // ── 硬要求：整个 Air 文档里不再有中文 ─────────────────────────────────
    // 浮层、对话框、详情抽屉都留在 DOM 里（只是没显示），所以这一次扫描已经把它们
    // 一起覆盖了：漏翻的节点不管藏得多深都会在这里现形。Auto 候选池刚挂上去，也在里面。
    const dirty = await page.evaluate(SCAN);
    assert.deepEqual(dirty, [], `Chinese left in the English Air shell:\n  ${dirty.join('\n  ')}`);
    // 出这一张是在扫过六个面板之后 —— 壳上的英文是重点，下半屏那两格嵌进来的
    // 旧管理台（iframe）说明的是上面那条边界，不是这次没过关。
    t.diagnostic('en: ' + await page.screenshot('air-i18n-en'));

    // 任务 AI 配置抽屉里的标签不是静态 DOM，是共享模块（chat-ai-config.js）现算的，
    // 上面那次扫描看不见它们 —— 但它们确实渲染在 Air 里（模型 / 线路下拉）。所以直接
    // 问模块要一遍：Air 用的就是这几个入口，英文模式下不许有汉字。
    const labels = await page.evaluate(`(() => {
      const api = window.MultiCCChatAiConfig;
      // Air 传给模块的 translator 只认识自己那两条 key，别的原样退回 —— 复刻它，
      // 才能测到「退回之后还得有英文」这条路。
      const state = { cli: 'codex', translate: key => ({ default: 'Default', custom: 'Custom…' })[key] || key };
      const provider = { id: 'p1', name: 'Lab', baseUrl: 'https://api.example.com', apiFormat: 'openai_responses', model: 'gpt-5.5' };
      return {
        codexDefault: api.modelChoiceLabel('', 'p1', state),
        qoderAuto: api.modelChoiceLabel('auto', 'p1', { ...state, cli: 'qoder' }),
        workBuddyTier: api.modelChoiceLabel('fast-model', 'p1', { ...state, cli: 'codebuddy' }),
        official: api.providerLabel({ ...provider, isOfficial: true }, true),
        limitFailed: api.providerLimitLabel({ name: 'Lab', limit: { summaryText: '5h 12%', lastError: 'boom' } }, window.t, Date.now()),
      };
    })()`);
    for (const [name, text] of Object.entries(labels)) {
      assert.ok(!/[㐀-鿿]/.test(text), `${name} still renders Chinese in English mode: ${text}`);
    }
    assert.equal(labels.codexDefault, await page.evaluate(`window.I18N.en.aiConfigDefaultFollowProvider`));
    // 线路名、协议标记、模型 id 都是数据，只有「· 订阅」这句是文案。
    assert.equal(labels.official, 'Lab [Responses] · Subscription · gpt-5.5', 'the provider label keeps its data intact');
    assert.match(labels.limitFailed, /fetch failed$/, 'the limit tail asks for its labels through t()');

    // ── 侧栏那颗按钮：点一下要真的写进 localStorage，并 reload 回中文 ─────
    await page.evaluate('document.getElementById("air-lang-btn").click()');
    // reload 之后 DOMContentLoaded 会重跑 applyI18n，documentElement.lang 随之变回 zh。
    assert.ok(await page.waitFor('document.documentElement.lang === "zh"'), 'clicking the toggle must reload the shell in Chinese');
    assert.equal(await page.evaluate('localStorage.getItem("multicc_lang")'), 'zh', 'the toggle persists the choice');
    assert.equal(await page.evaluate('document.getElementById("task-list-title").textContent'), '最近任务');
    assert.equal(await page.evaluate(`window.MultiCCChatAiConfig.modelChoiceLabel('', 'p1', { cli: 'codex', translate: key => key })`),
      '默认（跟随 Provider）', 'the same label follows the language back');
    assert.ok((await page.evaluate(SCAN)).length > 5, 'the Chinese shell must be back');
    // 同一个候选池，中文模式下必须是中文：否则上面那条「英文模式无汉字」可能只是
    // 因为这块面板压根没画出文案来。
    const autoZh = await page.evaluate(probe);
    assert.ok(/[㐀-鿿]/.test(autoZh), `the Auto candidate pool must be Chinese again: ${JSON.stringify(autoZh)}`);
    t.diagnostic('zh again: ' + await page.screenshot('air-i18n-zh'));
  });
});
