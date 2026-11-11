'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const html = fs.readFileSync(path.join(__dirname, '../plugins/chrome-proxy-launcher/ui/index.html'), 'utf8');
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const profile = () => ({
  id: 'existing-account', name: 'account@example.com', note: 'Keep this account note',
  egressType: 'subscription', subscription: { id: 'sub', node: 'Original node' },
  chromePath: '/fixture/chrome', running: false,
});

async function editor(t, operation) {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const state = {
    profiles: [profile()],
    subscriptions: [{ id: 'sub', name: 'Fixture subscription', nodes: ['Original node', 'Replacement node'] }],
    saves: [], probes: [], failSave: false,
  };
  const routes = {
    '/': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: html },
    'POST /api/plugins/chrome-proxy-launcher/run': ({ body }) => {
      const { command, input } = JSON.parse(body);
      if (command === 'list') return json(state);
      if (command === 'detect') return json({ core: '/fixture/meow', browser: '/fixture/chrome' });
      if (command === 'launch') return json(state.launchResult);
      if (command === 'probe') {
        state.probes.push(input);
        return json({ exitIp: '192.0.2.1', latencyMs: 5 });
      }
      if (command === 'save') {
        state.saves.push(input);
        if (state.failSave) return { status: 400, ...json({ error: 'Fixture: save failed' }) };
        const saved = { ...state.profiles[0], ...input };
        state.profiles = [saved];
        return json({ profile: saved });
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  await withCdpHarness({ routes }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    assert.ok(await page.waitFor(`document.querySelectorAll('#list li').length === 1`));
    await operation(page, state);
  });
}

test('launch warns persistently when the exit timezone is not applied', async t => {
  await editor(t, async (page, state) => {
    state.launchResult = { geo: { applied: false, reason: '出口地理服务未返回有效时区，浏览器时区未调整' } };
    await page.evaluate(`[...document.querySelectorAll('#list button')].find(b => b.textContent === '启动浏览器').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('时区未调整')`));
    assert.equal(await page.evaluate(`document.getElementById('notice').className`), 'bad');
  });
});

const clickEdit = async page => {
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('#list button')].find(b => b.textContent === '编辑');
    button.scrollIntoView({ block: 'center', behavior: 'instant' });
  })()`);
  assert.equal(await page.evaluate(`document.getElementById('f-name').getBoundingClientRect().bottom < 0`), true);
  await page.evaluate(`[...document.querySelectorAll('#list button')].find(b => b.textContent === '编辑').click()`);
};

test('editing an existing identity brings its populated form into view and can be cancelled', async t => {
  await editor(t, async (page, state) => {
    await clickEdit(page);
    assert.ok(await page.waitFor(`(() => {
      const rect = document.getElementById('f-name').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight && document.activeElement.id === 'f-name';
    })()`, { timeoutMs: 2000 }), 'Edit must reveal and focus the form above the identity list');
    assert.equal(await page.evaluate(`document.getElementById('f-name').value`), state.profiles[0].name);
    assert.equal(await page.evaluate(`document.getElementById('f-node').value`), 'Original node');
    assert.match(await page.evaluate(`document.getElementById('profile-editor-title').textContent`), /account@example.com/);
    assert.equal(await page.evaluate(`document.getElementById('btn-profile-cancel').hidden`), false);
    await page.evaluate(`document.getElementById('btn-profile-cancel').click()`);
    assert.deepEqual(await page.evaluate(`[
      document.getElementById('f-name').value,
      document.getElementById('btn-save').dataset.editing,
      document.getElementById('btn-profile-cancel').hidden,
      document.querySelectorAll('#list li.editing').length
    ]`), ['', '', true, 0]);
    assert.deepEqual(state.saves, []);
  });
});

test('edited egress is probed from the draft and saved to the same identity without losing metadata', async t => {
  await editor(t, async (page, state) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
    await clickEdit(page);
    await page.evaluate(`
      document.getElementById('f-name').value = 'Renamed account';
      document.getElementById('f-node').value = 'Replacement node';
      document.getElementById('f-via-on').checked = true;
      document.getElementById('f-via-on').dispatchEvent(new Event('change'));
      document.getElementById('f-via-host').value = 'proxy.example.com';
      document.getElementById('f-via-port').value = '8080';
      document.getElementById('f-via-user').value = 'fixture-user';
      document.getElementById('f-via-pass').value = 'fixture-password';
      document.getElementById('btn-test').click();
    `);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('192.0.2.1')`));
    assert.equal(state.probes.length, 1);
    assert.equal(state.saves.length, 0, 'testing an unsaved egress must not save it');
    await page.evaluate(`document.getElementById('btn-save').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#list .p-name').textContent === 'Renamed account'`));
    assert.deepEqual(state.saves, [{
      id: 'existing-account', name: 'Renamed account', egressType: 'subscription',
      note: 'Keep this account note', chromePath: '/fixture/chrome',
      subscription: { id: 'sub', node: 'Replacement node', via: {
        scheme: 'http', host: 'proxy.example.com', port: 8080, username: 'fixture-user', password: 'fixture-password',
      } },
    }]);
    assert.deepEqual(state.probes[0], { subscription: state.saves[0].subscription });
    assert.equal(await page.evaluate(`document.getElementById('btn-save').dataset.editing`), '');
    assert.equal(await page.evaluate(`document.getElementById('btn-profile-cancel').hidden`), true);
  });
});

test('failed saves keep the edited fields and explain the running-browser restriction', async t => {
  await editor(t, async (page, state) => {
    state.profiles[0].running = true;
    state.failSave = true;
    await page.evaluate('refresh()');
    await clickEdit(page);
    assert.match(await page.evaluate(`document.getElementById('profile-editor-hint').textContent`), /修改出口前.*停止/);
    assert.equal(await page.evaluate(`document.getElementById('btn-save').disabled`), false);
    await page.evaluate(`
      document.getElementById('f-name').value = 'Keep my draft';
      document.getElementById('f-node').value = 'Replacement node';
      document.getElementById('btn-save').click();
    `);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent === 'Fixture: save failed' && !document.getElementById('btn-save').disabled`));
    assert.deepEqual(await page.evaluate(`[
      document.getElementById('f-name').value,
      document.getElementById('f-node').value,
      document.getElementById('btn-save').dataset.editing,
      document.getElementById('btn-profile-cancel').hidden,
      document.querySelectorAll('#list li.editing').length
    ]`), ['Keep my draft', 'Replacement node', 'existing-account', false, 1]);
  });
});

test('a missing saved node stays visible until the user selects its replacement', async t => {
  await editor(t, async (page, state) => {
    state.subscriptions[0].nodes = ['Replacement node'];
    await page.evaluate('refresh()');
    await clickEdit(page);
    assert.equal(await page.evaluate(`document.getElementById('f-node').value`), 'Original node');
    assert.match(await page.evaluate(`document.getElementById('f-node').selectedOptions[0].textContent`), /原节点已失效/);
    await page.evaluate(`document.getElementById('btn-save').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('请重新选择可用节点') && !document.getElementById('btn-save').disabled`));
    assert.deepEqual(state.saves, [], 'an invalid selection must not fall back to the first node');
    assert.equal(await page.evaluate(`document.getElementById('f-node').value`), 'Original node');
    await page.evaluate(`
      document.getElementById('f-node').value = 'Replacement node';
      document.getElementById('btn-save').click();
    `);
    assert.ok(await page.waitFor(`document.getElementById('btn-save').dataset.editing === ''`));
    assert.equal(state.saves[0].subscription.node, 'Replacement node');
  });
});
