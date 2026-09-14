'use strict';

// Air 的「用量统计」在真浏览器里长什么样。
//
// 单测拿 DOM 替身盯的是它算得对不对；替身看不见的是三件事，而这三件恰好是这次
// 回归的现场：① 它到底有没有被挂到 Provider 页上（用户打开 ?view=provider 看不到
// 任何 token 统计）；② 它和 air.css 见面之后是不是还留在一块浅色卡上；③ 窄屏会不会
// 把表格撑破外壳。所以这里起真的 Air 控制台，走 ?view=provider，量像素。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const GLOBAL_USAGE = {
  generatedAt: '2026-09-14T09:30:00.000Z',
  responses: 12,
  windows: {
    today: { 'claude-opus-5': { inputTokens: 7, outputTokens: 3, cacheWrite: 0, cacheRead: 0, msgs: 1 } },
    week: {},
    month: {
      'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheWrite: 5, cacheRead: 500, msgs: 3 },
      'deepseek-chat': { inputTokens: 200, outputTokens: 40, cacheWrite: 0, cacheRead: 0, msgs: 2 },
    },
    all: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheWrite: 5, cacheRead: 500, msgs: 3 } },
  },
  byDay: { '2026-09-14': { 'claude-opus-5': 625 } },
  byDayFresh: { '2026-09-14': { 'claude-opus-5': 120 } },
};

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('Air 的 Provider 页真的带着完整用量统计，且是一块浅色、窄屏不破的卡', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {};
  const publicDir = path.resolve(__dirname, '../public');
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html)$/.test(name))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes[`/${file}`] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) {
    routes[`/shared/${file}`] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  const directories = [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }];
  const task = { id: 'tsk_here', dirId: 'd1', title: '看用量', recordType: 'planned', workflowStage: 'doing', status: 'active',
    runState: 'idle', updatedAt: 5000, resource: { residency: 'planned', lease: 'idle' },
    configuration: { cli: 'claude', provider: null, model: 'claude-opus-5' } };
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['claude', 'codex'], migration: { errors: [] }, tasks: [task], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/air/tasks/tsk_here'] = routes['/api/task-shell-tasks/tsk_here'] = () => json({ ok: true, task, sessionId: 'task-here',
    ownerShellId: 'shell-a', readOnly: false, execution: { busy: false, status: 'idle' }, resource: task.resource,
    attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
  routes['POST /api/task-board/tasks/tsk_here/chat-session'] = () => json({ ok: true, sessionId: 'task-here' });
  routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });

  // 线路卡要有东西可画，否则 Provider 页自己就空了，用量那块是不是挂上去也看不出来。
  routes['/api/providers'] = () => json({ available: true, ccSwitchAvailable: false,
    ccSwitchStatus: { available: false, message: '未找到 cc-switch' }, defaults: { claude: 'p1', codex: '' },
    providers: [{ id: 'p1', appType: 'claude', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.2', apiFormat: 'anthropic', hasToken: true, isOfficial: false, modelOptions: ['glm-5.2'], compatibleClis: ['claude'] }],
    stats: [] });

  // 两个用量的路径分开计数，并记下 query：普通打开不该重扫转录文件。
  const usageHits = { global: [], role: 0 };
  routes['/api/token-usage/global'] = ({ url }) => { usageHits.global.push(url.search); return json(GLOBAL_USAGE); };
  routes['/api/token-usage/by-role'] = () => { usageHits.role += 1;
    return json({ [dayKey(new Date())]: { main: { inputTokens: 9999, outputTokens: 9999, cacheWrite: 0, cacheRead: 0 },
      sub: { p2: { inputTokens: 10, outputTokens: 5, cacheWrite: 0, cacheRead: 0 } } } }); };

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-usage-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?view=provider&dir=d1');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);

    // ── 它挂上去了：这就是用户看不到的那块 ────────────────────────────────
    assert.ok(await page.waitFor(`document.querySelector('#admin-content .air-usage table.air-usage-table') !== null`),
      'Provider 页必须画出用量统计表；没有它就等于这一次回归没修');
    assert.equal(await page.evaluate(`document.getElementById('admin-center').hidden`), false);
    // 不是被塞在默认折叠的「高级连接」里：那块要展开才加载。
    assert.equal(await page.evaluate(`document.getElementById('air-provider-advanced').hidden`), true);
    assert.equal(await page.evaluate(`document.querySelector('#admin-content .air-usage').closest('#air-provider-advanced') === null`), true,
      '用量统计必须在「高级连接」之外：折起来就看不见等于没加回来');

    // ── 表格按模型明细，数值与接口一致 ────────────────────────────────────
    const readTable = `(() => {
      const table = document.querySelector('#admin-content .air-usage-table');
      const text = row => [...row.children].map(cell => cell.textContent);
      return { head: text(table.querySelector('thead tr')), body: [...table.querySelectorAll('tbody tr')].map(text),
        foot: text(table.querySelector('tfoot tr')),
        official: [...table.querySelectorAll('tbody tr td:first-child')].map(cell => cell.className) };
    })()`;
    let view = await page.evaluate(readTable);
    assert.deepEqual(view.head, ['模型', '新鲜输入', '输出', '缓存写', '缓存读', '新鲜总计']);
    // 新鲜口径下 deepseek 的 240 反超 claude 的 120（那 500 是缓存读）—— 行序跟着
    // 口径走，和旧页排的是同一个 total。
    assert.deepEqual(view.body, [
      ['deepseek-chat', '200', '40', '0', '0', '240'],
      ['claude-opus-5', '100', '20', '5', '500', '120'],
    ]);
    assert.deepEqual(view.foot, ['合计', '300', '60', '5', '500', '360']);
    assert.match(view.official[0], /other/, 'deepseek-chat 不是官方模型');
    assert.match(view.official[1], /official/, 'Claude 官方模型要挑出来标色');
    assert.match(await page.evaluate(`document.getElementById('air-usage-global').textContent`), /新鲜：360 · 含缓存：865/);
    t.diagnostic('default: ' + await page.screenshot('air-usage-default'));

    // ── 口径与窗口都真的重算，不是只换了标签 ──────────────────────────────
    await page.evaluate(`[...document.querySelectorAll('.air-usage-tab')].find(el => el.textContent === '含缓存 Token').click()`);
    view = await page.evaluate(readTable);
    assert.equal(view.head.at(-1), '含缓存总计');
    assert.deepEqual(view.body.map(row => row.at(-1)), ['625', '240']);
    assert.equal(view.foot.at(-1), '865');

    await page.evaluate(`[...document.querySelectorAll('.air-usage-tab')].find(el => el.textContent === '今天').click()`);
    view = await page.evaluate(readTable);
    assert.deepEqual(view.body, [['claude-opus-5', '7', '3', '0', '0', '10']]);

    // 趋势与「省主模型 Token」也都在（旧页那两块，一个都不能少）。
    assert.match(await page.evaluate(`document.getElementById('air-usage-global').textContent`), /近 \d+ 个有活动的日子/);
    const tiles = await page.evaluate(`[...document.querySelectorAll('#air-usage-role .air-usage-role-tile')]
      .map(tile => [tile.children[0].textContent, tile.children[1].textContent])`);
    assert.deepEqual(tiles, [['今天', '15'], ['本周', '15'], ['本月', '15'], ['全部', '15']],
      '省主模型 Token 只算子任务那部分，main 的 9999 不掺进来');
    t.diagnostic('desktop: ' + await page.screenshot('air-usage-desktop'));

    // ── 重新扫描走强制重扫；顶栏刷新走缓存 ────────────────────────────────
    assert.deepEqual(usageHits.global, [''], '打开页面时不许顺手重扫转录文件');
    // 切回默认的「本月 + 新鲜」，下面按这一次回归的原始数字继续量。
    await page.evaluate(`[...document.querySelectorAll('.air-usage-tab')].find(el => el.textContent === '新鲜 Token').click()`);
    await page.evaluate(`[...document.querySelectorAll('.air-usage-tab')].find(el => el.textContent === '本月').click()`);
    assert.match(await page.evaluate(`document.getElementById('air-usage-global').textContent`), /新鲜：360/);
    await page.evaluate(`[...document.querySelectorAll('.air-usage-action')].find(el => el.textContent === '重新扫描').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-usage-global').textContent.includes('新鲜：360')`));
    assert.deepEqual(usageHits.global, ['', '?refresh=1']);
    const rolesBefore = usageHits.role;
    // 顶栏刷新会整块重建 Provider 页（`render(mode, context, true)`），所以先在
    // 旧的那块上做个记号：等它消失，才算真的重来过一次 —— 光看文字没变会被旧的
    // DOM 骗过去（同一段文案在重画前后是一样的）。
    await page.evaluate(`document.getElementById('air-usage-global').dataset.generation = 'before'`);
    await page.evaluate(`document.getElementById('refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-usage-global').dataset.generation !== 'before'`),
      '顶栏刷新要重建用量块');
    assert.ok(await page.waitFor(`document.getElementById('air-usage-global').textContent.includes('新鲜：360')`));
    assert.equal(usageHits.role, rolesBefore + 1, '顶栏刷新要把用量一起带上，只刷线路会让人以为没生效');

    // ── 浅色外壳：深色组件漏进来正是单测看不见的那种事 ────────────────────
    const inspect = async selectors => page.evaluate(`(() => {
      const rgb = s => { const a = String(s).match(/[\\d.]+/g)?.map(Number) || [0, 0, 0, 0]; return [a[0], a[1], a[2], a[3] ?? 1]; };
      const blend = (a, b) => a.slice(0, 3).map((c, i) => c * a[3] + b[i] * (1 - a[3]));
      const lum = a => a.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      function bg(el) { return el ? blend(rgb(getComputedStyle(el).backgroundColor), bg(el.parentElement)) : [255, 255, 255]; }
      return ${JSON.stringify(selectors)}.flatMap(selector => {
        const elements = [...document.querySelectorAll(selector)];
        if (!elements.length) return [{ selector, missing: true }];
        return elements.map(el => {
          const style = getComputedStyle(el), background = bg(el), fg = blend(rgb(style.color), background);
          const a = lum(fg), b = lum(background);
          return { selector, text: (el.textContent || '').trim().slice(0, 24), lightness: b, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
      });
    })()`);
    for (const check of await inspect(['#admin-content .air-usage-card', '#air-usage-global', '.air-usage-role-tile', '.air-usage-trend-fill'])) {
      assert.ok(!check.missing, `missing ${check.selector}`);
      assert.ok(check.lightness > .75, `深色面漏进浅色外壳：${JSON.stringify(check)}`);
    }
    for (const check of await inspect(['.air-usage-tab.active', '.air-usage-table td.official', '.air-usage-role-tile strong'])) {
      assert.ok(check.contrast >= 3.7, `对比度 ${check.contrast.toFixed(2)}：${JSON.stringify(check)}`);
    }

    // ── 表格比外壳窄的时候不许把卡撑破 ────────────────────────────────────
    const fits = () => page.evaluate(`(() => {
      const card = document.querySelector('#admin-content .air-usage-card');
      const body = document.getElementById('air-usage-global');
      return { outside: card.getBoundingClientRect().right <= innerWidth + 1,
        // 装不下时允许卡内横向滚动，但不许把外壳顶宽。
        scrollable: body.scrollWidth <= body.clientWidth + 1 || getComputedStyle(body).overflowX === 'auto',
        doc: document.documentElement.scrollWidth <= innerWidth + 1 };
    })()`);
    assert.ok(Object.values(await fits()).every(Boolean), `1440px 下表格撑破了卡：${JSON.stringify(await fits())}`);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    assert.ok(Object.values(await fits()).every(Boolean), `390px 下表格撑破了卡：${JSON.stringify(await fits())}`);
    // 窄屏时用量块在首屏之下，截图前先把它滚进来（截图是留给以后看的证据，
    // 一张只有线路卡的图证明不了这块在手机上长什么样）。
    await page.evaluate(`document.querySelector('.air-usage').scrollIntoView({ block: 'start' })`);
    await page.screenshot('settle');
    t.diagnostic('mobile: ' + await page.screenshot('air-usage-mobile-390'));

    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
    assert.ok(Object.values(await fits()).every(Boolean), `320px 下表格撑破了卡：${JSON.stringify(await fits())}`);
    await page.evaluate(`document.querySelector('.air-usage').scrollIntoView({ block: 'start' })`);
    await page.screenshot('settle');
    t.diagnostic('mobile320: ' + await page.screenshot('air-usage-mobile-320'));

    assert.deepEqual(await page.evaluate('__errors'), []);
  });
});
