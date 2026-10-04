'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 页头那一批动作有两种形状（chat.html 的「页头动作的两种形状」）：
//   展开态（桌面）—— 只剩图标，名字挂在 title 上（没有悬浮说明就成了猜谜）；
//   收进「更多」（手机 / Air）—— 图标占一列、名字占一列，两列对齐。
// 这批按钮的名字是脚本随时改写的（记忆/角色带 ✓、自动提交带状态、CLI 换成当前
// CLI），所以图标不能用节点，只能由 data-hdr-icon 画出来。
const publicDir = path.resolve(__dirname, '../public');
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

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
routes['/api/sessions'] = () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, sessions: [], directories: [] }) });

// 展开态量的是每个按钮自己：字号收到 0、图标由 ::before 画出来、名字进 title。
const expandedProbe = `[...document.querySelectorAll('#header .hdr-btn[data-hdr-icon]')]
  .filter(b => b.getBoundingClientRect().width > 0)
  .map(b => ({ id: b.id, icon: getComputedStyle(b, '::before').content.replace(/"/g, ''),
    font: getComputedStyle(b).fontSize, title: b.title.trim(), name: b.textContent.trim() }))`;

// 浮层里每行量三件事：图标有没有画、名字落在第几列（名字左边 − 行左边）、名字本身。
const menuProbe = `(() => {
  const m = document.getElementById('header-more-menu');
  if (!m) return [];
  const ink = el => { const r = document.createRange(); r.selectNodeContents(el); return Math.round(r.getBoundingClientRect().left); };
  return [...m.children].filter(el => el.dataset.hdrIcon && getComputedStyle(el).display !== 'none').map(el => ({
    id: el.id, display: getComputedStyle(el).display, icon: getComputedStyle(el, '::before').content.replace(/"/g, ''),
    inset: ink(el) - Math.round(el.getBoundingClientRect().left), text: el.textContent.trim() }));
})()`;

const qaDir = () => process.env.MULTICC_HEADER_SHAPES_QA_DIR || path.join(os.tmpdir(), 'multicc-header-shapes-qa');
const openMenuOnPhone = async page => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.navigate('/chat.html?session=shapes');
  assert.ok(await page.waitFor(`document.getElementById('header') && document.getElementById('lang-btn')`));
  await page.evaluate(`document.getElementById('header-more-btn').click()`);
  assert.ok(await page.waitFor(`document.getElementById('header-more-menu')?.matches(':popover-open')`));
};

test('desktop header row: every action is icon + hover tooltip, state via a badge', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/chat.html?session=shapes');
    assert.ok(await page.waitFor(`document.getElementById('header') && document.getElementById('lang-btn')`));
    const shapes = await page.evaluate(expandedProbe);
    assert.ok(shapes.length >= 10, `页头展开态该有一排动作：${shapes.length}`);
    for (const item of shapes) {
      assert.equal(item.font, '0px', `${item.id} 的名字该收起来（字号仍是 ${item.font}）`);
      assert.ok(item.icon && item.icon !== 'none', `${item.id} 该画出图标`);
      assert.ok(item.title, `${item.id} 只剩图标，必须留一条悬浮说明`);
      assert.ok(!emoji.test(item.name), `${item.id} 的图标只画一遍，名字里不该再有 emoji：${item.name}`);
    }
    // 名字收起来之后，记忆/角色/自动提交的 ✓ 也跟着看不见了 —— 状态改挂
    // data-state，由 ::after 补一个角标接回来。这里把两种状态直接摆上，量的是
    // 那条 CSS 契约本身。
    await page.evaluate(`document.getElementById('role-btn').dataset.state = 'set'`);
    await page.evaluate(`document.getElementById('auto-commit-btn').dataset.state = 'on'`);
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('role-btn'), '::after').content.replace(/"/g, '')`), '✓');
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('auto-commit-btn'), '::after').content.replace(/"/g, '')`), '✓');
    // 关掉的自动提交只有一个 ✕ 状态、没有角标：角度是给「开着」补的。
    await page.evaluate(`document.getElementById('auto-commit-btn').dataset.state = 'off'`);
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('auto-commit-btn'), '::after').content`), 'none');
    await page.screenshot('shapes-1-desktop-expanded');
  });
});

test('More menu: every row is an icon column plus a name column, names share one line', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await openMenuOnPhone(page);
    const rows = await page.evaluate(menuProbe);
    assert.ok(rows.length >= 10, `手机上这批动作都在浮层里：${rows.length}`);
    assert.equal(rows.some(row => row.id === 'lang-btn'), false,
      '语言切换是页面级入口，不应在对话更多菜单里重复出现');
    for (const row of rows) {
      assert.equal(row.display, 'grid', `${row.id} 该是「图标 + 名字」两列`);
      assert.ok(row.icon && row.icon !== 'none', `${row.id} 该画出图标`);
      assert.ok(row.text, `${row.id} 该留着名字`);
      assert.ok(!row.text.startsWith(row.icon), `${row.id} 不能把图标印两遍：${row.text}`);
      assert.ok(row.inset >= 30 && row.inset <= 40, `${row.id} 的名字该落在第二列：${row.inset}`);
    }
    const insets = rows.map(row => row.inset);
    assert.ok(Math.max(...insets) - Math.min(...insets) <= 2, `名字该在同一条竖线上：${JSON.stringify(rows)}`);
    // 名字里带着状态的几行（记忆✓ / 角色✓ / 自动提交✓）在浮层里看得见名字，就
    // 不该再加一个角标 —— 角标是给展开态（只剩图标、名字看不见）补的。
    for (const id of ['memory-btn', 'role-btn', 'auto-commit-btn']) {
      assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('${id}'), '::after').content`), 'none', `${id} 在浮层里已经带着 ✓，不该再画一个角标`);
    }
    await page.screenshot('shapes-2-mobile-menu');
  });
});

test('standalone Chat opens shared runtime settings and preserves pending subagent settings on save', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const provider = { id: 'relay', name: 'Test Relay', protocol: 'anthropic', appType: 'claude',
    compatibleClis: ['claude-exp'], hasToken: true, baseUrl: 'https://fixture.invalid',
    model: 'claude-sonnet-4-6', modelOptions: ['claude-sonnet-4-6', 'claude-opus-4-8'] };
  const info = { cli: 'claude-exp', provider: 'relay', model: 'claude-sonnet-4-6',
    cliAvailability: { 'claude-exp': { available: true }, 'codex-exp': { available: true } },
    pendingConfiguration: { cli: 'claude-exp', profile: { provider: 'relay', model: 'claude-opus-4-8',
      subagent: { providerId: 'relay', model: 'claude-sonnet-4-6' } } } };
  const pendingProfile = info.pendingConfiguration.profile;
  const fixture = { ...routes,
    '/api/sessions/runtime': ({ req, body }) => {
      if (req.method === 'PATCH') Object.assign(pendingProfile, JSON.parse(body));
      return json(info);
    },
    '/api/providers': () => json({ providers: [provider], defaults: { claude: 'relay' } }),
  };
  const screenshots = process.env.MULTICC_RUNTIME_QA_DIR || qaDir();
  await withCdpHarness({ routes: fixture, screenshotDir: screenshots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/chat.html?session=runtime');
    assert.ok(await page.waitFor(`document.getElementById('model-btn')?.textContent.includes('claude-opus-4-8')`));
    const header = await page.evaluate(`({ pill: document.getElementById('model-btn').getBoundingClientRect().toJSON(),
      legacy: ['cli-btn','provider-btn','effort-btn'].map(id => getComputedStyle(document.getElementById(id)).display) })`);
    assert.ok(header.pill.width > 0 && header.pill.right <= 390, JSON.stringify(header));
    assert.deepEqual(header.legacy, ['none', 'none', 'none']);
    await page.evaluate(`document.getElementById('model-btn').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] .rc-model')?.value === 'claude-opus-4-8'`));
    assert.equal(await page.evaluate(`document.querySelector('.rc-sub-provider').value`), 'relay');
    const metrics = await page.send('Page.getLayoutMetrics');
    assert.equal(metrics.cssLayoutViewport.clientWidth, 390);
    console.log('Runtime settings screenshot (390×844 CSS pixels):', await page.screenshot('chat-runtime-config-open'));
    await page.evaluate(`document.querySelector('.rc-model').value = 'claude-sonnet-4-6';
      document.querySelector('.rc-model').dispatchEvent(new Event('change'));
      document.querySelector('.air-config-form').requestSubmit()`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.equal(pendingProfile.model, 'claude-sonnet-4-6');
    assert.deepEqual(pendingProfile.subagent, { providerId: 'relay', model: 'claude-sonnet-4-6' });
    assert.ok(page.requests.some(req => req.method === 'PATCH' && req.path === '/api/sessions/runtime'));
    assert.match(await page.evaluate(`document.getElementById('model-btn').textContent`), /下轮生效/);
    console.log('Runtime save screenshot (390×844 CSS pixels):', await page.screenshot('chat-runtime-config-saved'));
  });
});

test('switching from DeepSeek to Codex official drops the old model from the actual saved patch', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const pool = [
    { id: 'ds', name: 'DeepSeek', appType: 'codex', apiFormat: 'openai_responses',
      compatibleClis: ['codex', 'codex-exp'], model: 'deepseek-flash', modelOptions: ['deepseek-flash'] },
    { id: 'codex-official', name: 'Codex official', appType: 'codex', apiFormat: 'openai_responses',
      compatibleClis: ['codex', 'codex-exp'], isOfficial: true, builtinOfficial: true,
      model: '', modelOptions: ['gpt-5.4', 'gpt-5.4-mini'] },
  ];
  let saved;
  let patches = 0;
  const fixture = { ...routes,
    '/api/providers': () => json({ providers: pool, defaults: {} }),
    '/api/sessions/switch-test': ({ req, body }) => {
      if (req.method === 'PATCH') { patches++; saved = JSON.parse(body); }
      return json({ ok: true, cli: 'codex', ...saved });
    },
  };
  await withCdpHarness({ routes: fixture, artifactsDir: path.join(os.tmpdir(), 'multicc-codex-switch-cdp') }, async page => {
    await page.navigate('/chat.html?session=switch-test');
    await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig');
    await page.evaluate(`window.MultiCCRunConfig.open({ sessionId: 'switch-test', configuration: {
      cli: 'codex', provider: 'ds', model: 'deepseek-flash' } }, ['codex'], () => {});`);
    assert.ok(await page.waitFor(`document.querySelector('.rc-model')?.value === 'deepseek-flash'`));
    await page.evaluate(`document.querySelector('.rc-line').value = 'codex-official';
      document.querySelector('.rc-line').dispatchEvent(new Event('change'));`);
    assert.equal(await page.evaluate(`document.querySelector('.rc-model').value`), 'gpt-5.4');
    assert.equal(await page.evaluate(`document.querySelector('.rc-model-custom').value`), '');
    // A second switch must also forget a custom model typed in the draft.
    await page.evaluate(`document.querySelector('.rc-model').value = '__custom__';
      document.querySelector('.rc-model').dispatchEvent(new Event('change'));
      document.querySelector('.rc-model-custom').value = 'gpt-hidden';
      document.querySelector('.rc-model-custom').dispatchEvent(new Event('input'));
      document.querySelector('.rc-line').value = 'ds';
      document.querySelector('.rc-line').dispatchEvent(new Event('change'));`);
    assert.equal(await page.evaluate(`document.querySelector('.rc-model').value`), 'deepseek-flash');
    await page.evaluate(`document.querySelector('.rc-line').value = 'codex-official';
      document.querySelector('.rc-line').dispatchEvent(new Event('change'));
      document.querySelector('.air-config-form').requestSubmit();`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.equal(patches, 1, 'provider and model must be saved atomically');
    assert.equal(saved.provider, 'codex-official');
    assert.equal(saved.model, 'gpt-5.4');
  });
});
