'use strict';
// 通知渠道插件在 MultiCC 页面里的三处（public/plugin-channels.js、hook-editor.js、
// air-trigger-center.js；docs/notification-channel-plugin-design.md 10.3/10.4 与 13 节第三阶段）：
//   ① 推送设置「插件渠道」一栏：按插件列出接收人；勾类别、开关打的是 POST 订阅的真接口，
//      body 逐字段断言；接收人已删的订阅标红并给删除；只开了插件渠道时提示后果；
//      没装渠道插件时这一栏不出现，也不去读订阅。
//   ② 钩子编辑器「发到渠道」：只在装了渠道插件时给选；保存的 action 逐字段断言；规则里的
//      接收人已删时编辑器写明，触发器卡片整张标红。
//   ③ Air 顶部横幅：未恢复的告警出横幅，关掉后同一组问题不再出现。
// 文案一律用页面里的 t() 取回来比，不写死中文。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const PUBLIC = path.resolve(__dirname, '../public');
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function staticRoutes() {
  const routes = {};
  for (const folder of ['', 'shared']) {
    for (const file of fs.readdirSync(path.join(PUBLIC, folder)).filter(f => /\.(js|css|html)$/.test(f))) {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      routes['/' + (folder ? folder + '/' : '') + file] = { body: fs.readFileSync(path.join(PUBLIC, folder, file)), headers: { 'content-type': type } };
    }
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(PUBLIC, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: '主仓', path: '/p' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/providers'] = () => json({ available: false, providers: [], defaults: {} });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/aux/config'] = () => json({ providerId: 'configured' });
  routes['/api/secrets'] = () => json([]);
  routes['/api/directories'] = () => json([{ id: 'd1', name: '主仓' }]);
  routes['/api/events/catalog'] = () => json({ events: [], aliases: {}, actions: [], clis: ['codex'] });
  routes['GET /api/push/health'] = () => json({ global: { lastPushTime: 0, totalSuccess: 0, totalFail: 0, totalSent: 0 }, subscriptionCount: 0, subscriptions: [] });
  routes['GET /api/settings/notify'] = () => json({ hasBark: false, barkUrl: '', webhookUrl: '' });
  return routes;
}

const WECHAT = {
  id: 'wechat-desktop-notify', name: '微信桌面提醒', nameEn: 'WeChat Desktop Alerts', version: '0.2.1',
  channel: { label: '微信', labelEn: 'WeChat', platforms: ['darwin'] }, ui: '/plugins/wechat-desktop-notify/ui/index.html',
  running: true, ready: true, alerts: [], inUse: true, subscriptions: 1,
};
const TARGETS = [
  { id: 't-me', name: '小韩', status: 'active' },
  { id: 't-ops', name: '运营群', status: 'testing' },
];

function channelRoutes(state) {
  const routes = staticRoutes();
  routes['GET /api/channels'] = () => json({ available: true, plugins: state.plugins });
  routes['GET /api/channels/targets'] = () => json({ channels: state.plugins.map(p => ({ plugin: p.id, name: p.name, label: p.channel.label, labelEn: p.channel.labelEn, ready: p.ready, targets: state.targets })) });
  const payload = () => json({ subscriptions: state.subs, categories: ['done', 'question', 'background', 'error'], defaults: ['error', 'question'], otherChannels: state.other });
  routes['GET /api/push/channel-subscriptions'] = payload;
  routes['POST /api/push/channel-subscriptions'] = ({ body }) => {
    const draft = JSON.parse(body);
    const hit = state.subs.find(s => s.plugin === draft.plugin && s.target === draft.target);
    if (hit) Object.assign(hit, draft); else state.subs.push({ id: `chs_${state.subs.length + 1}`, ...draft });
    return payload();
  };
  routes['DELETE /api/push/channel-subscriptions/chs_gone'] = () => { state.subs = state.subs.filter(s => s.id !== 'chs_gone'); return payload(); };
  routes['POST /api/push/test-channel'] = () => json({ ok: true, receipt: { deliveryId: 42, queued: true } });
  routes['/api/event-triggers'] = () => json({ items: state.items });
  routes['POST /api/event-rules'] = ({ body }) => json({ id: 'r9', ...JSON.parse(body) });
  return routes;
}

const until = async predicate => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
};

async function openPush(page) {
  const tr = key => page.evaluate(`t(${JSON.stringify(key)})`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate('/air?dir=d1&view=settings');
  assert.ok(await page.waitFor(`document.querySelectorAll('.air-setting-card').length > 0`), '先落在设置中心');
  await page.evaluate(`[...document.querySelectorAll('.air-setting-card')].find(card => card.querySelector('strong').textContent === ${JSON.stringify(await tr('airAdminPanelPush'))}).click()`);
  assert.ok(await page.waitFor(`document.querySelector('#admin-content .air-push-page') !== null`), '点进去落在推送面板上');
  return tr;
}

test('push settings list plugin-channel recipients and write subscriptions through the real API', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const state = {
    plugins: [WECHAT], targets: TARGETS, other: { webPush: 0, fcm: 0, bark: false, webhook: false, any: false },
    subs: [{ id: 'chs_gone', plugin: WECHAT.id, target: 't-deleted', categories: ['error'], enabled: true }], items: [],
  };
  await withCdpHarness({ routes: channelRoutes(state), screenshotDir: path.join(os.tmpdir(), 'multicc-plugin-channels') }, async page => {
    const tr = await openPush(page);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-plugin-channels .pc-row').length === 3`), '两个接收人 + 一条接收人已删的订阅');
    const rows = await page.evaluate(`[...document.querySelectorAll('#air-plugin-channels .pc-row')].map(r => ({
      target: r.dataset.target, bad: r.classList.contains('bad'), state: r.querySelector('.pc-target-state').textContent,
      checked: [...r.querySelectorAll('.pc-cats input:checked')].map(i => i.value), on: r.querySelector('.pc-row-actions input').checked,
      buttons: [...r.querySelectorAll('button')].map(b => [b.textContent, b.disabled]) }))`);
    assert.deepEqual(rows[0], { target: 't-me', bad: false, state: await tr('pcTargetActive'), checked: ['question', 'error'], on: false,
      buttons: [[await tr('pcTest'), false]] }, '没订阅的接收人：默认勾「在等你回答」「出错了」，开关是关的');
    assert.equal(rows[1].state, await tr('pcTargetTesting'));
    assert.deepEqual(rows[1].buttons, [[await tr('pcTest'), true]], '没启用的接收人不能测试');
    assert.equal(rows[2].bad, true, '接收人已删的订阅标红');
    assert.equal(rows[2].state, await tr('pcTargetGone'));
    assert.deepEqual(rows[2].buttons.map(([label]) => label), [await tr('pcRemove')]);
    assert.equal(await page.evaluate(`document.querySelector('#air-plugin-channels .pc-warn')?.textContent`), await tr('pcOnlyChannel'),
      '只开了插件渠道：提示插件自身故障只能在页面上看到');
    assert.equal(await page.evaluate(`document.querySelector('#air-plugin-channels .pc-group-head a').getAttribute('href')`), WECHAT.ui);

    // 打开「接收」：POST 订阅，body 带插件、接收人、默认两类。
    await page.evaluate(`document.querySelector('#air-plugin-channels .pc-row[data-target="t-me"] .pc-row-actions input').click()`);
    const posts = () => page.requests.filter(r => r.method === 'POST' && r.path === '/api/push/channel-subscriptions').map(r => JSON.parse(r.body));
    assert.ok(await until(() => posts().length === 1));
    assert.deepEqual(posts()[0], { plugin: WECHAT.id, target: 't-me', categories: ['question', 'error'], enabled: true });
    // 再勾「完成」：类别按固定顺序提交，开关保持开着。
    assert.ok(await page.waitFor(`document.querySelector('#air-plugin-channels .pc-row[data-target="t-me"] .pc-row-actions input').checked === true`));
    await page.evaluate(`document.querySelector('#air-plugin-channels .pc-row[data-target="t-me"] .pc-cats input[value=done]').click()`);
    assert.ok(await until(() => posts().length === 2));
    assert.deepEqual(posts()[1], { plugin: WECHAT.id, target: 't-me', categories: ['done', 'question', 'error'], enabled: true });

    // 测试：回执里的投递编号写出来。
    await page.evaluate(`document.querySelector('#air-plugin-channels .pc-row[data-target="t-me"] button').click()`);
    const queued = (await tr('pcTestQueued')).replace('{id}', '42');
    assert.ok(await page.waitFor(`document.querySelector('#air-plugin-channels .pc-row[data-target="t-me"] small').textContent === ${JSON.stringify(queued)}`));
    assert.deepEqual(JSON.parse(page.requests.find(r => r.path === '/api/push/test-channel').body), { plugin: WECHAT.id, target: 't-me' });

    // 删除接收人已不存在的那条订阅。
    await page.evaluate(`document.querySelector('#air-plugin-channels .pc-row.bad button.danger').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-plugin-channels .pc-row.bad').length === 0`));
    await page.evaluate(`document.getElementById('air-plugin-channels').scrollIntoView({ block: 'center' })`);
    await page.screenshot('push-plugin-channels.png');
  });
});

test('without a channel plugin the push panel shows no plugin-channel section and reads no subscriptions', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const state = { plugins: [], targets: [], other: { any: true }, subs: [], items: [] };
  await withCdpHarness({ routes: channelRoutes(state) }, async page => {
    await openPush(page);
    assert.ok(await page.waitFor(`document.getElementById('air-plugin-channels') !== null`));
    assert.ok(await until(() => page.requests.some(r => r.path === '/api/channels')));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await page.evaluate(`document.getElementById('air-plugin-channels').hidden`), true);
    assert.equal(page.requests.filter(r => r.path === '/api/push/channel-subscriptions').length, 0);
  });
});

test('hooks: 「发到渠道」 saves plugin + recipient, a rule pointing at a deleted recipient is marked; the alert banner shows once', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const alerting = { ...WECHAT, alerts: [{ key: 'wechat-logged-out', level: 'critical', title: '微信退出登录了', at: 1 }] };
  const state = {
    plugins: [alerting], targets: TARGETS, other: { any: true }, subs: [],
    items: [{ scope: 'global', sessionId: null, sessionLabel: null, lastRun: null, rule: {
      id: 'r1', type: 'event', name: '发给旧群', enabled: true, on: ['task.failed'], filter: {}, cooldownMs: 0,
      action: { kind: 'channel', plugin: WECHAT.id, target: 't-deleted', message: '' } } }],
  };
  await withCdpHarness({ routes: channelRoutes(state), screenshotDir: path.join(os.tmpdir(), 'multicc-plugin-channels') }, async page => {
    const tr = key => page.evaluate(`t(${JSON.stringify(key)})`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?view=schedules');

    // ③ 横幅：插件有未恢复的告警。
    assert.ok(await page.waitFor(`document.querySelector('.pc-banner')?.hidden === false`), '告警出横幅');
    assert.match(await page.evaluate(`document.querySelector('.pc-banner').textContent`), /微信退出登录了/);
    assert.equal(await page.evaluate(`document.querySelector('.pc-banner').classList.contains('critical')`), true);
    await page.evaluate(`document.querySelector('.pc-banner button').click()`);
    assert.equal(await page.evaluate(`document.querySelector('.pc-banner').hidden`), true, '关掉了');

    // ② 触发器卡片：接收人已删，整张标红。
    await page.evaluate(`[...document.querySelectorAll('[data-schedule-tab]')].find(b => b.dataset.scheduleTab === 'hooks').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#hook-list .schedule-card').length === 1`));
    assert.ok(await page.waitFor(`document.querySelector('#hook-list .schedule-card').classList.contains('hook-channel-broken')`), '引用了已删除接收人的钩子标红');
    assert.match(await page.evaluate(`document.querySelector('#hook-list .hook-flow').textContent`), new RegExp(await tr('hookActChannel')));

    // 编辑它：接收人下拉保留旧编号并写明「接收人已不存在」。
    await page.evaluate(`[...document.querySelectorAll('#hook-list .schedule-actions button')].find(b => b.textContent === ${JSON.stringify(await tr('airScheduleEdit'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    assert.equal(await page.evaluate(`document.querySelector('.hook-dialog form').elements.channelTarget.value`), 't-deleted');
    assert.equal(await page.evaluate(`document.getElementById('hook-channel-problem').textContent`), await tr('hookChannelMissing'));
    await page.evaluate(`document.querySelector('.hook-dialog').close()`);

    // 新建：选「发到渠道」+ 接收人 + 文案，保存的 action 逐字段对上。
    await page.evaluate(`document.getElementById('schedule-create').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    assert.equal(await page.evaluate(`document.querySelector('.hook-dialog form').elements.kind.querySelector('option[value=channel]').hidden`), false,
      '装了渠道插件才给选');
    await page.evaluate(`(() => { const f = document.querySelector('.hook-dialog form');
      f.querySelectorAll('input[name=ev]').forEach(b => { b.checked = b.value === 'task.waiting_user'; });
      f.elements.kind.value = 'channel'; f.elements.kind.onchange();
      f.elements.channelTarget.value = 't-me'; f.elements.channelTarget.onchange();
      f.elements.channelMessage.value = '这个项目在等你'; })()`);
    assert.equal(await page.evaluate(`document.querySelector('.hook-dialog [data-kind=channel]').hidden`), false);
    assert.equal(await page.evaluate(`document.getElementById('hook-channel-problem').textContent`), '');
    await page.screenshot('editor-channel.png');
    await page.evaluate(`document.getElementById('hook-save').click()`);
    assert.ok(await until(() => page.requests.some(r => r.method === 'POST' && r.path === '/api/event-rules')));
    const body = JSON.parse(page.requests.find(r => r.method === 'POST' && r.path === '/api/event-rules').body);
    assert.deepEqual(body.on, ['task.waiting_user']);
    assert.deepEqual(body.action, { kind: 'channel', plugin: WECHAT.id, target: 't-me', message: '这个项目在等你' });
  });
});
