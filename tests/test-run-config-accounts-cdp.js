'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 运行配置里的「账户」行（Command Code / OpenCode 的 API Key 账户）在真 Chrome 里走一遍：
// 只在这两条车道出现、读回会话现值、内联添加（key 只进 POST /api/cli-accounts）、
// 保存时 PATCH 只写动过的那条车道、删除后回到本机登录、换到别的 CLI 就收起来。
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
// 运行配置由 Air 宿主页加载；用相同依赖顺序测试账户功能，不依赖聊天帧里的旧副本。
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
routes['GET /api/commandcode/auth/status'] = () => json({ ok: true, credentialSaved: false, userName: '', environmentKey: false });

const NEW_ID = 'aaaaaaaaaaaaaaaa';
const OLD_ID = 'bbbbbbbbbbbbbbbb';
const qaDir = () => process.env.MULTICC_RUN_CONFIG_ACCOUNTS_QA_DIR || path.join(os.tmpdir(), 'multicc-run-config-accounts-qa');
const optionTexts = `[...document.querySelectorAll('.air-config-dialog[open] .rc-account option')].map(o => o.value + '=' + o.textContent)`;
// 只认当前打开的那个对话框：关掉的旧对话框要等 close 事件派发完才从 DOM 摘掉。
const visible = selector => `(() => { const el = document.querySelector(${JSON.stringify('.air-config-dialog[open] ' + selector)}); return !!el && !el.closest('[hidden]') && el.getBoundingClientRect().height > 0; })()`;

test('Provider 管理浮层关闭后保留自定义模型草稿，并重新加载新增线路', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  let added = false;
  const line = id => ({ id, name: id, appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude-exp'], model: 'm', modelOptions: ['m'] });
  const fixture = { ...routes,
    '/api/providers': () => json({ providers: added ? [line('existing'), line('added')] : [line('existing')], defaults: {} }),
    '/air': { headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>Provider fixture</title><p>Provider manager</p>' },
  };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig'));
    await page.evaluate(`window.MultiCCRunConfig.open({ configuration: { cli: 'claude-exp', provider: 'existing', model: 'my-draft-model' } }, ['claude-exp'], () => {})`);
    assert.ok(await page.waitFor(`document.querySelector('.rc-model-custom')?.value === 'my-draft-model'`));
    await page.evaluate(`document.querySelector('.rc-line-field .rc-manage-providers').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.provider-manager-dialog[open] iframe')?.src.includes('view=provider')`));
    assert.ok(await page.evaluate(`document.querySelector('.provider-manager-dialog').getBoundingClientRect().width <= 390`));
    added = true;
    await page.evaluate(`document.querySelector('.provider-manager-dialog button').click()`);
    assert.ok(await page.waitFor(`!document.querySelector('.provider-manager-dialog') && document.querySelector('.rc-line option[value="added"]')`));
    assert.equal(await page.evaluate(`document.querySelector('.rc-line').value`), 'existing');
    assert.equal(await page.evaluate(`document.querySelector('.rc-model-custom').value`), 'my-draft-model');
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog').open`), true);
  });
});

test('官方账号登录：移动端打开终端、刷新身份，保留已有 API Key 选择并提供弹窗拦截后的入口', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  let saved = false;
  let logins = 0;
  const fixture = { ...routes,
    'GET /api/cli-accounts/commandcode': () => json({ accounts: [{ id: OLD_ID, label: '独立密钥', keyHint: '…test' }] }),
    'GET /api/commandcode/auth/status': () => json({ ok: true, credentialSaved: saved, userName: saved ? '官方测试用户' : '', environmentKey: false }),
    'POST /api/commandcode/auth/login': () => { logins++; saved = true; return json({ ok: true, sessionId: 'commandcode-login' }); },
  };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));
    await page.evaluate(`window.open = () => ({ opener: null, location: { replace: url => { window.loginPopupUrl = url; } } });
      window.MultiCCRunConfig.open({ configuration: { cli: 'commandcode', cliAccounts: { commandcode: '${OLD_ID}' } } }, ['commandcode', 'opencode'], () => {})`);
    assert.ok(await page.waitFor(`document.querySelector('.rc-account-login-row [role="status"]')?.textContent.includes('尚未保存')`));
    assert.equal(await page.evaluate(visible('.rc-account-login')), true);
    await page.evaluate(`document.querySelector('.rc-account-login').click()`);
    assert.ok(await page.waitFor(`window.loginPopupUrl === '/?id=commandcode-login'`));
    assert.equal(logins, 1);
    assert.equal(await page.evaluate(`document.querySelector('.rc-account').value`), OLD_ID);
    assert.match(await page.evaluate(`document.querySelector('.rc-account-login-row [role="status"]').textContent`), /完成浏览器授权/);
    await page.evaluate(`document.querySelector('.rc-account-login-refresh').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.rc-account-login-row [role="status"]')?.textContent.includes('官方测试用户')`));
    assert.equal(await page.evaluate(`document.querySelector('.rc-account').value`), OLD_ID);
    // 浏览器拦截窗口时，仍能通过链接打开登录终端。
    await page.evaluate(`window.open = () => null; document.querySelector('.rc-account-login').click()`);
    assert.ok(await page.waitFor(`!document.querySelector('.rc-account-login').disabled`));
    assert.equal(logins, 2);
    assert.equal(await page.evaluate(visible('.rc-account-login-link')), true);
    assert.equal(await page.evaluate(`document.querySelector('.rc-account-login-link').getAttribute('href')`), '/?id=commandcode-login');
    await page.evaluate(`document.querySelector('.rc-account-login').scrollIntoView({ block: 'center' })`);
    console.log('官方账号登录界面截图：', await page.screenshot('commandcode-official-login'));
    await page.evaluate(`document.querySelector('.rc-cli-card[data-cli="opencode"]').click()`);
    assert.ok(await page.waitFor(`!${visible('.rc-account-login-row')}`));
  });
});

test('Command Code: add an account inline, save the pick, delete it back to the local login', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const accounts = [];
  const posts = [];
  const patches = [];
  const fixture = { ...routes,
    'GET /api/cli-accounts/commandcode': () => json({ ok: true, cli: 'commandcode', accounts }),
    'POST /api/cli-accounts/commandcode': ({ body }) => {
      const input = JSON.parse(body);
      posts.push(input);
      const account = { id: NEW_ID, label: input.label, keyHint: `…${input.apiKey.slice(-4)}`, createdAt: 1 };
      accounts.push(account);
      return json({ ok: true, account }, 201);
    },
    [`DELETE /api/cli-accounts/commandcode/${NEW_ID}`]: () => { accounts.length = 0; return json({ ok: true, releasedSessions: 1 }); },
    'GET /api/sessions/acct': () => json({ id: 'acct', cli: 'commandcode', cliAccounts: null }),
    'PATCH /api/sessions/acct': ({ body }) => { patches.push(JSON.parse(body)); return json({ ok: true, cli: 'commandcode' }); },
  };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));
    await page.evaluate(`window.MultiCCRunConfig.open({ sessionId: 'acct', configuration: { cli: 'commandcode', model: 'deepseek/deepseek-v4-flash' } }, ['commandcode', 'claude-exp'], () => {})`);
    assert.ok(await page.waitFor(`${visible('.rc-account')} && !document.querySelector('.air-config-dialog[open] .rc-account').disabled`), 'account row shows for Command Code');
    assert.deepEqual(await page.evaluate(optionTexts), ['=本机 CLI 登录（默认）', '__add_account__=＋ 添加账户…']);
    assert.equal(await page.evaluate(visible('.rc-account-delete')), false, 'nothing to delete on the local login');

    await page.evaluate(`const s = document.querySelector('.air-config-dialog[open] .rc-account'); s.value = '__add_account__'; s.dispatchEvent(new Event('change'));`);
    assert.ok(await page.waitFor(visible('.rc-account-form')));
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account').value`), '', 'picking "add" does not change the pick');
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account-key').type`), 'password');
    // Enter in the key box saves the account, never the whole run config.
    await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account-name').value = '工作号';
      const key = document.querySelector('.air-config-dialog[open] .rc-account-key'); key.value = 'user_cdp_fixture_key_9876';
      key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] .rc-account').value === '${NEW_ID}'`));
    assert.deepEqual(posts, [{ label: '工作号', apiKey: 'user_cdp_fixture_key_9876' }]);
    assert.equal(patches.length, 0, 'adding an account must not submit the dialog');
    assert.equal(await page.evaluate(visible('.rc-account-form')), false);
    assert.match(await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account option[value="${NEW_ID}"]').textContent`), /工作号 · …9876/);
    assert.match(await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-fixed .air-config-status').textContent`), /工作号/);
    assert.equal(await page.evaluate(visible('.rc-account-delete')), true);
    console.log('Account added screenshot:', await page.screenshot('run-config-account-added'));

    await page.evaluate(`document.querySelector('.air-config-dialog[open] .air-config-form').requestSubmit()`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].cliAccounts, { commandcode: NEW_ID });
    assert.equal(JSON.stringify(patches).includes('user_cdp_fixture_key'), false, 'the key never rides the session PATCH');

    // Reopen with the pick stored server-side, then delete the account.
    fixture['GET /api/sessions/acct'] = () => json({ id: 'acct', cli: 'commandcode', cliAccounts: { commandcode: NEW_ID } });
    await page.evaluate(`window.confirm = () => true;
      window.MultiCCRunConfig.open({ sessionId: 'acct', configuration: { cli: 'commandcode' } }, ['commandcode', 'claude-exp'], () => {})`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] .rc-account')?.value === '${NEW_ID}'`), 'the stored pick is read back');
    await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account-delete').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] .rc-account').value === '' && !document.querySelector('.air-config-dialog[open] .rc-account option[value="${NEW_ID}"]')`));
    assert.ok(page.requests.some(req => req.method === 'DELETE' && req.path === `/api/cli-accounts/commandcode/${NEW_ID}`));

    // Switching to a lane without key accounts hides the row and sends nothing for it.
    await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-cli-card[data-cli="claude-exp"]').click()`);
    assert.ok(await page.waitFor(`!${visible('.rc-account-field')}`));
  });
});

test('OpenCode: a stored pick is shown, hidden on a MultiCC line; a vanished one is cleared on save; untouched lanes are not written', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const patches = [];
  const fixture = { ...routes,
    'GET /api/cli-accounts/opencode': () => json({ ok: true, cli: 'opencode', accounts: [{ id: OLD_ID, label: '个人', keyHint: '…abcd', createdAt: 1 }] }),
    'GET /api/opencode/models': () => json({ models: ['opencodego/deepseek-v4-flash'], source: 'cache' }),
    // 一条 MultiCC 托管线路：opencode.ai 的 key 对它不起作用，账户行要收起来。
    '/api/providers': () => json({ providers: [{ id: 'relay', name: 'Relay', appType: 'claude', apiFormat: 'anthropic',
      compatibleClis: ['opencode'], model: 'glm-5', modelOptions: ['glm-5'] }], defaults: {} }),
    'GET /api/sessions/oc': () => json({ id: 'oc', cli: 'opencode', cliAccounts: { opencode: OLD_ID } }),
    'GET /api/sessions/gone': () => json({ id: 'gone', cli: 'opencode', cliAccounts: { opencode: 'cccccccccccccccc' } }),
    'PATCH /api/sessions/oc': ({ body }) => { patches.push(['oc', JSON.parse(body)]); return json({ ok: true, cli: 'opencode' }); },
    'PATCH /api/sessions/gone': ({ body }) => { patches.push(['gone', JSON.parse(body)]); return json({ ok: true, cli: 'opencode' }); },
  };
  await withCdpHarness({ routes: fixture, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.MultiCCChatAiConfig'));
    await page.evaluate(`window.MultiCCRunConfig.open({ sessionId: 'oc', configuration: { cli: 'opencode', model: 'opencodego/deepseek-v4-flash' } }, ['opencode'], () => {})`);
    assert.ok(await page.waitFor(`document.querySelector('.air-config-dialog[open] .rc-account')?.value === '${OLD_ID}'`));
    assert.match(await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account-field .rc-note').textContent`), /Zen 与 Go 共用/);
    console.log('OpenCode account (390×844) screenshot:', await page.screenshot('run-config-account-opencode-phone'));
    const lineBefore = await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-line').value`);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.air-config-dialog[open] .rc-line option')].some(o => o.value === 'relay')`), true);
    await page.evaluate(`{ const l = document.querySelector('.air-config-dialog[open] .rc-line'); l.value = 'relay'; l.dispatchEvent(new Event('change')); }`);
    assert.equal(await page.evaluate(visible('.rc-account-field')), false, 'a MultiCC line hides the account row');
    await page.evaluate(`{ const l = document.querySelector('.air-config-dialog[open] .rc-line'); l.value = ${JSON.stringify(lineBefore)}; l.dispatchEvent(new Event('change')); }`);
    assert.equal(await page.evaluate(visible('.rc-account-field')), true, 'back on the opencode.ai line the row returns');
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account').value`), OLD_ID);
    await page.evaluate(`document.querySelector('.air-config-dialog[open] .air-config-form').requestSubmit()`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.equal('cliAccounts' in patches[0][1], false, 'an untouched pick is not rewritten');

    await page.evaluate(`window.MultiCCRunConfig.open({ sessionId: 'gone', configuration: { cli: 'opencode', model: 'opencodego/deepseek-v4-flash' } }, ['opencode'], () => {})`);
    assert.ok(await page.waitFor(`/已不存在/.test(document.querySelector('.air-config-dialog[open] .rc-account-field .rc-note')?.textContent || '')`));
    assert.equal(await page.evaluate(`document.querySelector('.air-config-dialog[open] .rc-account').value`), '');
    await page.evaluate(`document.querySelector('.air-config-dialog[open] .air-config-form').requestSubmit()`);
    assert.ok(await page.waitFor(`!document.querySelector('.air-config-dialog[open]')`));
    assert.deepEqual(patches[1], ['gone', patches[1][1]]);
    assert.deepEqual(patches[1][1].cliAccounts, { opencode: null }, 'a vanished pick heals back to the local login');
  });
});
