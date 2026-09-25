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
// 一个 Air 窗口里有**两份**文档，本文件两份都扫：
//   ① Air 壳：下面第一组断言把对话帧（#conversation）换成一个空壳 —— 帧自己那堆
//      请求不混进来，只管壳上的字；
//   ② 对话帧：第二组断言反过来，把真的 chat.html 嵌进来，扫帧自己那份文档，连
//      Air 通过 air.js 写进帧里的那几颗药丸（#air-ai-pill 上的线路名）一起管。
// 还剩一类 iframe 属于别的文档、不在判据内 —— 说清楚，免得把「本文件全绿」读成
// 「屏幕上没有中文」：air-admin.js 的 .air-legacy-frame（/manage.html?view=…&embed=air）
// 是面板模块没挂上时的退路，那份中文属于 manage.html 自己的存量，不在本次「Air 壳」
// 的范围内。侧栏那十几格已经全部搬成原生 DOM，所以下面逐格扫描时不允许它出现
// （见那一组的 .air-legacy-frame 断言）—— 这里留的只是「万一退了回去，也别把
// manage.html 的存量当成 Air 漏翻」这条读法。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 内置官方供应商的名字不是前端字面量，是服务端写进记录的数据（见
// src/providers/official-catalog.js）—— 所以任何一处漏翻都只能靠扫出来，改不到源头。
const OFFICIAL_NAME_ZH = 'Codex 官方';
const OFFICIAL_CONFIGURATION = Object.freeze({ cli: 'codex', provider: 'codex-official', providerName: OFFICIAL_NAME_ZH,
  providerSelection: null, model: '', effectiveModel: '', effort: 'medium' });

// public/ 顶层那些 js/css/html/svg：Air 壳和对话帧共用同一份，两个测试都从这里取。
function assetRoutes(publicDir) {
  const routes = {};
  const types = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', html: 'text/html' };
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html|svg)$/.test(name))) {
    const type = types[file.slice(file.lastIndexOf('.') + 1)];
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': `${type}; charset=utf-8` } };
  }
  // 帧里的对话页会带 shared/ 下的公共模块（chat.html 自己的 script 标签），真服务端
  // 是当静态文件发的；夹具少发一个，帧里那几个渲染器取数字时就会拿到 null。
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript; charset=utf-8' } };
  }
  return routes;
}

// 任务 fixture：Air 快照和任务详情都用这个形状，两组断言共用。
function airTask(id, dirId, title, status, runState, updatedAt, configuration) {
  return { id, dirId, title, recordType: 'planned', workflowStage: 'doing',
    status, runState, updatedAt, resource: { residency: 'planned', lease: 'idle' }, configuration };
}

// 对话帧开机的那两支接口：任务详情（带会话 id）＋ 建会话。会话 id 由服务端给，
// 前端只是照着读 —— 所以 chat.js 只会去找它，不会自己造一个。
function taskFrameRoutes(routes, list) {
  const entry = item => ({ ok: true, task: item, sessionId: `session-${item.id}`, ownerShellId: 'shell-a',
    readOnly: false, execution: { busy: false, status: 'idle' }, resource: item.resource, attribution: {},
    roleBindings: { version: 0, bindings: [] }, messages: [] });
  for (const item of list) {
    routes[`/api/task-shell-tasks/${item.id}`] = () => json(entry(item));
    // 服务端把「这条任务现在跑在哪条线路上」放在详情顶层的 configuration 上
    // （providerName 就是 provider store 里存的那份名字，见 src/workspace/air-routes.js
    // 的 taskDetail），composer 上那颗药丸读的正是这一段。fixture 少了它药丸就是空的，
    // 那条断言也就成了空跑 —— 所以下面断它「等于词典里那串」，而不是「不含汉字」。
    routes[`/api/air/tasks/${item.id}`] = () => json({
      ...entry(item), configuration: { pendingConfiguration: null, ...item.configuration },
    });
    // 用户实测看到的那条带子（composer 上那颗线路药丸）读的是「打开任务」这条轻量
    // 路由：air.js 的 renderComposerControls 先认 entry，再认 air-task-entry.js 写下的
    // window.__multiccAirTaskOpen（src/workspace/air-routes.js 的 /api/air/tasks/:id/open）。
    // fixture 少了它，药丸就永远 hidden + 空文案 —— 帧里那条断言于是成了空跑，
    // 就算带子被写坏也照绿。会话 id / 只读位 / 线路配置都按真路由的形状给。
    routes[`/api/air/tasks/${item.id}/open`] = () => json({
      ...entry(item), taskId: item.id,
      sourceSessionId: null,
      configuration: { pendingConfiguration: null, ...item.configuration },
      session: { id: `session-${item.id}`, kind: 'chat', dirId: item.dirId, label: item.title,
        cli: item.configuration?.cli || 'codex', cwd: '/projects/multicc', createdAt: 1,
        taskBoundTaskId: item.id, autoCommit: true },
    });
    routes[`POST /api/task-board/tasks/${item.id}/chat-session`] = () => json({ ok: true, sessionId: `session-${item.id}` });
  }
}

// 扫「这一页里还有没有中文」。排除 iframe（另一个文档）和 script/style（不是界面文案）。
// 全角符号（＋ 之类）是图标，先剔除再判 —— 判据是「汉字」，不是「非 ASCII」。
// 语言按钮是唯一的例外：它必须两种语言都写出来（中文界面上写 EN/中、英文界面上写
// 中/EN），否则用户不知道点了会变成什么 —— 那半个「中」是它的本意。按钮的 id 在
// Air 壳里是 air-lang-btn、在对话帧里是 lang-btn，所以例外按 id 传进来。
// 第二个参数是要扫的文档：Air 壳扫 document；嵌进来的对话帧是另一个文档，读它的
// contentDocument（同源，读得到）—— 同一个 Air 窗口里两份文档都得干净。
const scanSource = (skipIds = [], docExpr = 'document') => `(() => {
  const doc = ${docExpr};
  const SKIP_IDS = new Set(${JSON.stringify(skipIds)});
  const HAN = /[\\u3400-\\u9fff\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65]/;
  const ICON = /[＋－×÷←↑→↓⤢]/g;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);
  const label = el => {
    if (el === doc.body) return 'body';
    const id = el.id ? '#' + el.id : (el.classList.length ? '.' + el.classList[0] : '');
    return label(el.parentElement) + '>' + el.tagName.toLowerCase() + id;
  };
  const dirty = value => value && HAN.test(String(value).replace(ICON, ''));
  const out = [];
  for (const el of doc.querySelectorAll('body *')) {
    if (SKIP.has(el.tagName) || SKIP_IDS.has(el.id)) continue;
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (dirty(value)) out.push(label(el) + ' @' + attr + ' = ' + value);
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && dirty(node.nodeValue)) out.push(label(el) + ' = ' + node.nodeValue.trim().slice(0, 70));
    }
  }
  if (dirty(doc.title)) out.push('document.title = ' + doc.title);
  return out;
})()`;
const SCAN = scanSource(['air-lang-btn']);
// 对话帧（#conversation 里的 chat.html）是同一个 Air 窗口里的第二份文档。
const FRAME_SCAN = scanSource(['lang-btn'], 'document.getElementById("conversation").contentDocument');

test('the Air shell renders English end to end and the sidebar toggle persists the choice', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public');
  const routes = assetRoutes(publicDir);
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
  const task = (id, dirId, title, status, runState, updatedAt, config) =>
    airTask(id, dirId, title, status, runState, updatedAt, config || configuration);
  const airTasks = [
    task('tsk_here', 'd1', 'Round the billing totals correctly', 'active', 'idle', 5000),
    task('tsk_wait', 'd2', 'Empty-state copy on the sign-in page', 'active', 'waiting', 9000),
    task('tsk_done', 'd1', 'Retry the failed export', 'done', 'succeeded', 1000),
    // 内置官方供应商那条线：名字是数据（'Codex 官方'），英文模式下药丸上必须是英文。
    task('tsk_official', 'd1', 'Wire the payments webhook', 'active', 'idle', 7000, OFFICIAL_CONFIGURATION),
  ];
  const directories = [
    { id: 'd1', name: 'MultiCC main repo', path: '/projects/multicc' },
    { id: 'd2', name: 'North storefront', path: '/projects/storefront' },
  ];
  // lastRuntime 是「新建任务」那条带子的默认线路（服务端存的上次用它那套）。
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex', 'claude'], migration: { errors: [] },
    lastRuntime: { ...OFFICIAL_CONFIGURATION }, tasks: airTasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  taskFrameRoutes(routes, airTasks);
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
  // 工作区那一格（air-workspaces.js）：空回包只会画出四句「还没有…」，那等于没扫。
  // 所以这里把四块卡都喂满 —— 超预算标记、待建/迁移中两个可选计数、孤儿的删与留、
  // 审计里的目录条目与截断标记，每一条都对应面板里一句只在该分支出现的文案。
  routes['/api/workspaces/overview'] = () => json({
    status: { awakeLimit: 2, idleMs: 5_400_000, scheduled: true, stopped: false, sweeping: false },
    totals: { awake: 3, hibernated: 4 },
    directories: [{ id: 'd1', path: '/projects/multicc', awake: 3, hibernated: 4, planned: 1, transitioning: 1, total: 9 }],
    removedIgnoredAudit: [{ sessionId: 's1', title: 'Fix login redirect', at: '2026-09-20T04:05:00.000Z',
      entries: [{ path: '.env.local', bytes: 2048 }, { path: 'node_modules', files: 120, truncated: true }] }],
    orphans: { at: '2026-09-20T03:00:00.000Z', total: 2, removed: 1, deleteOrphans: true, orphans: [
      { path: '/projects/multicc/.wt/a', branch: 'multicc/task-a', ahead: 0, dirty: false, removed: true },
      { path: '/projects/multicc/.wt/b', branch: null, ahead: 3, dirty: true, removed: false }] },
  });

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
    const bottomTools = await page.evaluate(`(() => {
      const version = document.getElementById('air-ver-row').getBoundingClientRect();
      const lang = document.getElementById('air-lang-btn').getBoundingClientRect();
      return { centerGap: Math.abs(version.top + version.height / 2 - lang.top - lang.height / 2),
        langWidth: lang.width, sameParent: version.parentElement === lang.parentElement };
    })()`);
    assert.equal(bottomTools.sameParent, true, '语言与版本检查应在同一行容器');
    assert.ok(bottomTools.centerGap <= 2, JSON.stringify(bottomTools));
    assert.ok(bottomTools.langWidth < 64, '中/EN 只占一颗短按钮：' + JSON.stringify(bottomTools));
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
        // 目录首页顶部那道 Chat / Terminal 切换（air-directory-mode.js）：Chat /
        // Terminal 两个词本身中英同形（不在这条 notEqual 断言里），但终端那一块的
        // 文案是翻出来的 —— 连同空态一起钉住（fixture 的 sessions 是空的）。
        one('#directory-terminals [data-i18n="airTerminalsHeading"]', 'airTerminalsHeading'),
        one('#directory-terminal-new [data-i18n="airNewTerminal"]', 'airNewTerminal'),
        one('#directory-terminal-list .directory-terminal-empty', 'airTerminalsEmpty'),
        // 新建终端那层「用哪个 CLI」的弹窗：标题和说明也要是英文（它藏在关着的
        // dialog 里，扫描器照样看得到 —— 只钉那几条可见文案不够）。
        one('#terminal-cli-title', 'airTerminalPickTitle'),
        one('#terminal-cli-dialog [data-i18n="airTerminalPickHint"]', 'airTerminalPickHint'),
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

    // ── 内置官方供应商：名字是数据，不是词典里的字面量 ────────────────────
    // 'Codex 官方' 是启动时/建记录时写进 provider 记录的那个 name（official-catalog.js
    // 造它，*-accounts.js 写过 'Codex 官方 · <label>'），前端只是渲染它。所以它不是
    // 「漏翻一条词典」，而是「渲染点得按身份翻译」——徽标和选择器都走
    // providerDisplayName。这一条单独断：整页扫描扫不到「本该是英文但显示成中文的数据」，
    // 只有当那个渲染点确实画在这页上时才会现形。
    const quickRoute = await page.evaluate(`(() => {
      const pill = document.getElementById('quick-ai-pill');
      return {
        label: pill.textContent.trim(), title: pill.title,
        codex: window.t('providerOfficialCodex'), model: window.t('airQuickDefaultModel'),
        zhCodex: window.I18N.zh.providerOfficialCodex,
      };
    })()`);
    assert.equal(quickRoute.zhCodex, OFFICIAL_NAME_ZH, 'the catalog still holds the server-side name in Chinese');
    assert.equal(quickRoute.label, ['codex', quickRoute.codex, quickRoute.model].join(' · '),
      'the new-task band names the official route in English, not in the stored Chinese');
    assert.ok(!/[㐀-鿿]/.test(quickRoute.label), `the official route still renders Chinese: ${quickRoute.label}`);

    // 同一个身份会以四种形状到达渲染点：服务端 id、带 builtinOfficial 的对象、
    // normalizeProvider 洗过之后只剩 name 的对象（它会把 builtinOfficial 丢掉）、
    // 以及直接一个字符串。四条都得认出来，否则某一条路径上就漏回中文。
    const identity = await page.evaluate(`(() => {
      const api = window.MultiCCProviderCatalog;
      const cases = [
        [{ id: 'codex-official', name: '${OFFICIAL_NAME_ZH}' }, 'providerOfficialCodex'],
        [{ id: 'p1', builtinOfficial: true, appType: 'codex', name: '${OFFICIAL_NAME_ZH}' }, 'providerOfficialCodex'],
        [{ id: 'p1', name: '${OFFICIAL_NAME_ZH}' }, 'providerOfficialCodex'],
        [{ id: 'claude-official', name: 'Claude 官方' }, 'providerOfficialClaude'],
      ];
      return cases.map(([value, key]) => ({
        shown: api.providerDisplayName(value), expected: window.t(key), zh: window.I18N.zh[key],
      }));
    })()`);
    for (const entry of identity) {
      assert.equal(entry.shown, entry.expected, `the builtin official provider must be translated: ${JSON.stringify(entry)}`);
      assert.notEqual(entry.expected, entry.zh, 'a translated name must not be the Chinese original');
    }
    // 历史记录的 '官方 · <账号 label>'：后缀是数据（用户的账号名），前缀照翻。
    assert.equal(await page.evaluate(`window.MultiCCProviderCatalog.providerDisplayName('${OFFICIAL_NAME_ZH} · work')`),
      `${quickRoute.codex} · work`, 'the legacy "官方 · <label>" records keep their label and translate the prefix');

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
    //
    // 旧管理台那十格搬成原生之后，这里不再有「嵌进来的旧 iframe 扫不到」这条豁免：
    // 每一格除了扫中文，还要证明它画的是原生 DOM（没有 .air-legacy-frame）。少了这条，
    // 面板模块一旦没挂上就会静默退回 iframe，而 iframe 里的中文恰好是扫不到的 ——
    // 那样这道关会绿着放走一整格没搬完的页面。
    const ADMIN_VIEWS = [
      'docs', 'secrets', 'memory', 'taskgraph', 'workspaces', 'voice', 'goal', 'provider',
      'global', 'push', 'tunnel', 'bridges', 'resources', 'skillsync', 'storage',
    ];
    // 先把「谁没挂上」说清楚：下面每格失败时报的是「还在嵌旧页面」，而根因往往是某个
    // 模块的 <script> 没加载（或者加载时抛了错）—— 那一行直接把名字给出来。
    t.diagnostic('missing panel modules: ' + await page.evaluate(`JSON.stringify([
      'MultiCCAirMemory', 'MultiCCAirTaskgraph', 'MultiCCAirVoice', 'MultiCCAirGoal',
      'MultiCCAirGlobal', 'MultiCCAirPush', 'MultiCCAirBridges', 'MultiCCAirResources',
      'MultiCCAirSkillsync', 'MultiCCAirStorage', 'MultiCCAirProvider', 'MultiCCAirTunnel',
      'MultiCCAirWorkspaces', 'MultiCCAirProviderAdvanced',
    ].filter(name => !window[name]))`));
    for (const view of [...ADMIN_VIEWS, 'settings']) {
      // 除设置中心自己，每一格在设置中心都有一张卡片（legacyPanels 是卡片文案的来源），
      // 点卡片进去和用户走的是同一条路。设置中心本身走侧栏按钮。
      const via = await page.evaluate(`(() => {
        document.querySelector('[data-air-view="settings"]').click();
        const card = document.querySelector('[data-air-card="${view}"]');
        if (card) { card.click(); return 'card'; }
        const button = document.querySelector('[data-air-view="${view}"]');
        button.click();
        return 'sidebar';
      })()`);
      assert.ok(await page.waitFor(`(() => {
        const panel = document.getElementById('admin-content');
        return !!panel && panel.textContent.trim().length > 0;
      })()`), `the "${view}" panel must render something to scan`);
      // 旧 manage 页已经删了，所以这条不再有任何豁免：哪一格的正文里出现指向它的
      // iframe，都只可能是搬迁退回去了（而 iframe 里的中文恰好是扫不到的）。
      assert.deepEqual(
        await page.evaluate(`(() => [...document.querySelectorAll('#admin-content iframe')]
          .map(frame => frame.getAttribute('src') || '')
          .filter(src => src.includes('/manage.html')))()`),
        [],
        `the "${view}" panel (entered via ${via}) still loads the old manage page as its body`,
      );
      const leaked = await page.evaluate(SCAN);
      assert.deepEqual(leaked, [], `Chinese left in the Air "${view}" panel:\n  ${leaked.join('\n  ')}`);
      // 记一下每格画出多少字：空面板扫出来当然干净，那不算数。
      t.diagnostic(`${view} panel (${via}): ${await page.evaluate(`document.getElementById('admin-content').textContent.trim().length`)} chars`);
    }

    // Provider 页的「高级」默认折叠，上面那一圈只扫到它的外壳。官方多账号 / 借道 /
    // ZCode / Kimi 四块正文是展开时才画的（air-provider-advanced.js），所以单独展开一次
    // 再扫：这四块以前藏在旧 manage 页的 iframe 里，正是这道关扫不到的地方。
    await page.evaluate(`(() => {
      document.querySelector('[data-air-card="provider"]')?.click();
      window.MultiCCAirProvider.toggleAdvanced();
    })()`);
    assert.ok(await page.waitFor(`(() => {
      const host = document.getElementById('air-provider-advanced-body');
      return !!host && host.childElementCount > 0;
    })()`), 'the Provider panel must draw the advanced block when it is expanded');
    const advancedLeaked = await page.evaluate(SCAN);
    assert.deepEqual(advancedLeaked, [], `Chinese left in the Provider advanced block:\n  ${advancedLeaked.join('\n  ')}`);
    t.diagnostic('provider advanced block: ' + await page.evaluate(`document.getElementById('air-provider-advanced-body').textContent.trim().length`) + ' chars');

    // ── 硬要求：整个 Air 文档里不再有中文 ─────────────────────────────────
    // 浮层、对话框、详情抽屉都留在 DOM 里（只是没显示），所以这一次扫描已经把它们
    // 一起覆盖了：漏翻的节点不管藏得多深都会在这里现形。Auto 候选池刚挂上去，也在里面。
    const dirty = await page.evaluate(SCAN);
    assert.deepEqual(dirty, [], `Chinese left in the English Air shell:\n  ${dirty.join('\n  ')}`);
    // 出这一张是在把每一格都点过一遍之后：整页都不该再有中文了。
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
    // 反过来：同一条官方线路在中文下必须是中文。否则上面那条「英文无汉字」可能只是
    // 把名字擦掉了，而不是翻译了。
    const quickZh = await page.evaluate(`(() => ({
      label: document.getElementById('quick-ai-pill').textContent.trim(),
      codex: window.I18N.zh.providerOfficialCodex, model: window.I18N.zh.airQuickDefaultModel,
    }))()`);
    assert.equal(quickZh.label, ['codex', quickZh.codex, quickZh.model].join(' · '),
      'the official route is Chinese again — the mapping translates the name, it does not scrub it');
    assert.equal(quickZh.codex, OFFICIAL_NAME_ZH, 'Chinese mode still shows the stored name');
    assert.ok((await page.evaluate(SCAN)).length > 5, 'the Chinese shell must be back');
    // 同一个候选池，中文模式下必须是中文：否则上面那条「英文模式无汉字」可能只是
    // 因为这块面板压根没画出文案来。
    const autoZh = await page.evaluate(probe);
    assert.ok(/[㐀-鿿]/.test(autoZh), `the Auto candidate pool must be Chinese again: ${JSON.stringify(autoZh)}`);
    t.diagnostic('zh again: ' + await page.screenshot('air-i18n-zh'));
  });
});

// 同一个窗口里的另一份文档：嵌在 Air 里的对话帧。用户实测在这里数出两行可见中文
// （'开始连接' / '连接已建立'）和八个 title/aria-label —— 那些字面量和运行期赋值都在
// public/chat.html / chat.js 里，上面那组扫描（把帧换成空壳）看不见。
//
// 这一组把真的 chat.html 嵌进来跑，一次覆盖三处：帧自己的文档、Air 壳、以及 air.js
// 写进帧里的那条药丸。帧是个独立文档，所以扫描要走进它的 contentDocument（同源）。
test('the embedded chat document is English too, including the composer band Air writes into it', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = assetRoutes(path.resolve(__dirname, '../public'));
  routes['/air'] = routes['/air.html'];
  // 帧里的对话页要真的连上（它开机时会打 ws-ticket）：给个假 ticket，别真去连。
  routes['/auth-client.js'] = {
    headers: { 'content-type': 'text/javascript' },
    body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
  };
  const airTasks = [airTask('tsk_official', 'd1', 'Wire the payments webhook', 'active', 'idle', 7000, OFFICIAL_CONFIGURATION)];
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC main repo', path: '/projects/multicc' }],
    clis: ['codex', 'claude'], migration: { errors: [] }, lastRuntime: { ...OFFICIAL_CONFIGURATION },
    tasks: airTasks, sessions: [] });
  taskFrameRoutes(routes, airTasks);
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/providers'] = () => json({ providers: [], defaults: {} });
  routes['/api/provider-defaults'] = () => json({ defaults: {} });
  routes['/api/settings/power'] = () => json({ available: true, enabled: false });
  routes['/api/version-check'] = () => json({ current: '2.40.0', channel: 'dev', latestVersion: '2.40.0', updateAvailable: false });
  routes['/api/server-info'] = () => json({ url: 'http://192.168.1.9:3000', uptimeMs: 3600_000 });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-i18n-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const FRAME = 'document.getElementById("conversation").contentDocument';
    // 「帧开机了」= 它自己的输入框在了、文档加载完了。空壳帧过不了这一关。
    const booted = () => page.waitFor(`(() => {
      const doc = ${FRAME};
      return !!doc && !!doc.getElementById('input-bar') && doc.readyState === 'complete';
    })()`, { timeoutMs: 30_000 });

    // ── 先跑中文那一遍：同一条扫描在中文下必须找得到中文 ─────────────────
    await page.navigate('/air?dir=d1&task=tsk_official');
    assert.ok(await booted(), 'the embedded chat frame must boot in the fixture');
    const zhLeaks = await page.evaluate(FRAME_SCAN);
    assert.ok(zhLeaks.length > 5, `the scanner must find Chinese in the frame in Chinese mode, got ${JSON.stringify(zhLeaks)}`);
    t.diagnostic('zh frame scan: ' + zhLeaks.length + ' nodes');
    // 用户实测看到的那行 'page loaded — 开始连接' 是调试台画的。中文下它必须正好是
    // 词典里那条 —— 断「等于词典值」而不是「含汉字」，才既证明走的是词典，又不会
    // 在把某条文案改成英文时误报。
    const zhDbgLine = await page.evaluate(`(() => {
      const doc = ${FRAME};
      const lines = [...doc.querySelectorAll('#dbg-log .dbg-line')].map(el => el.textContent.trim());
      return { lines, expected: window.I18N.zh.dbgPageLoadedTask, zhWs: window.I18N.zh.dbgWsOpen };
    })()`);
    assert.ok(zhDbgLine.lines.some(line => line.includes(zhDbgLine.expected)),
      `the debug log draws its line from the dictionary: ${JSON.stringify(zhDbgLine)}`);

    // ── 切到 en ──────────────────────────────────────────────────────────
    await page.evaluate(`localStorage.setItem('multicc_lang', 'en')`);
    await page.navigate('/air?dir=d1&task=tsk_official');
    assert.ok(await booted(), 'the embedded chat frame must boot in English');
    assert.equal(await page.evaluate(`${FRAME}.documentElement.lang`), 'en', 'the frame follows the language the shell stores');

    // 帧里的语言按钮和壳里那颗一样，是唯一有意保留的例外（两种语言都得写出来）。
    assert.equal(await page.evaluate(`${FRAME}.getElementById("lang-btn").textContent`), 'EN/中',
      'the frame toggle stays bilingual');
    assert.equal(await page.evaluate(`${FRAME}.getElementById("lang-btn").title`), 'Switch language: 中文 / English');

    // 可见文本 + title / aria-label / placeholder，一个汉字都不许剩 —— 浮层、抽屉、
    // 调试台这些没显示出来的也在 DOM 里，一并算进去。
    const leaks = await page.evaluate(FRAME_SCAN);
    assert.deepEqual(leaks, [], `Chinese left in the English chat frame:\n  ${leaks.join('\n  ')}`);
    const shellLeaks = await page.evaluate(SCAN);
    assert.deepEqual(shellLeaks, [], `Chinese left in the English Air shell around the frame:\n  ${shellLeaks.join('\n  ')}`);
    t.diagnostic('en: ' + await page.screenshot('air-i18n-frame-en'));

    // 带子上那颗药丸是**壳画进帧里的**（air.js 的 renderComposerControls），帧自己
    // 扫不到它的来历 —— 用户实测报的就是这一行 'codex · Codex 官方 · Default model'。
    assert.ok(await page.waitFor(`(() => {
      const doc = ${FRAME};
      return !!doc && !!(doc.getElementById('air-ai-pill') || {}).textContent?.trim();
    })()`, { timeoutMs: 20_000 }), 'Air must write the composer band into the frame');
    const band = await page.evaluate(`(() => {
      const doc = ${FRAME};
      const pill = doc.getElementById('air-ai-pill');
      return { hidden: pill.hidden, text: pill.textContent.trim(), title: pill.title,
        codex: window.t('providerOfficialCodex'), model: window.t('airQuickDefaultModel'),
        aiTitle: window.t('airTaskAiTitle') };
    })()`);
    assert.equal(band.hidden, false, 'the band must be showing — a hidden pill would make the next assertion vacuous');
    assert.equal(band.text, ['codex', band.codex, band.model].join(' · '),
      'the official route in the composer band must be the English name');
    assert.ok(!/[㐀-鿿]/.test(band.text), `the composer band still renders Chinese: ${band.text}`);
    assert.equal(band.title, band.aiTitle, 'the pill talks through the dictionary too');
    assert.equal(band.codex, 'Codex Official', 'the catalog holds the English name for the builtin official route');
  });
});
