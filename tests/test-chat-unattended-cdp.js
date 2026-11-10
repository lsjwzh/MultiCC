'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 会话中的无人值守面板（public/chat-unattended.js）：
//   GET/POST /api/sessions/:id/unattended、POST /api/goal/precheck。
// 这里跑真实 chat.html：面板由 chat.js 在启动时 create，GET 一次校准；点开之后
// 做预检、启动、停止、继续，并量一次手机上图标不压发送键。
const publicDir = path.resolve(__dirname, '../public');
const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

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
routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
routes['/api/sessions/s1'] = () => json({ ok: true, session: { id: 's1', name: 's1' } });
routes['/api/settings/goal'] = () => json({ ok: true, precheckWaitMs: 30000, dimensions: {}, minScore: 60 });

let unattended = null;
const unattendedPosts = [];
const prechecks = [];
const limits = { maxRoundsDefault: 30, maxRoundsMax: 200 };
routes['/api/sessions/s1/unattended'] = () => json({ ok: true, unattended, limits });
routes['POST /api/sessions/s1/unattended'] = ({ body }) => {
  const value = JSON.parse(body);
  unattendedPosts.push(value);
  if (value.action === 'start') {
    unattended = {
      status: 'active', goal: value.goal, criteria: value.criteria || [],
      maxRounds: value.maxRounds || 30, rounds: 0, history: [],
      lastVerdict: { verdict: 'continue', reason: '还需要构建', nextInstruction: '继续构建', humanReason: '', at: Date.now() },
    };
  } else if (value.action === 'stop') {
    if (unattended) unattended = { ...unattended, status: 'stopped', updatedAt: Date.now() };
  } else if (value.action === 'resume') {
    if (unattended) unattended = { ...unattended, status: 'active', updatedAt: Date.now() };
  } else if (value.action === 'update') {
    if (unattended) unattended = { ...unattended, ...value, action: undefined, updatedAt: Date.now() };
  }
  return json({ ok: true, unattended, limits });
};
routes['POST /api/goal/precheck'] = ({ body }) => {
  prechecks.push(JSON.parse(body));
  return json({
    ok: true, verdict: 'warn', score: 62, issues: ['缺少可验证的验收标准'], questions: [],
    criteria: ['构建通过', '测试通过'], revised: '把目标改成可验收的版本',
  });
};

const qaDir = () => process.env.MULTICC_UNATTENDED_QA_DIR || path.join(os.tmpdir(), 'multicc-unattended-qa');

test('chat unattended panel: precheck, start, stop, resume and a non-overlapping floating icon', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab') && document.getElementById('unattended-panel')`));
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-idle')`));
    assert.equal(await page.evaluate(`document.getElementById('unattended-panel').hidden`), true);

    // 浮动图标必须整个落在发送键上方，不能挡住拇指的目标。
    const geometry = await page.evaluate(`(() => {
      const fab = document.getElementById('unattended-fab').getBoundingClientRect();
      const send = document.getElementById('send-btn').getBoundingClientRect();
      return { fab: { top: fab.top, bottom: fab.bottom, left: fab.left, right: fab.right },
               send: { top: send.top, bottom: send.bottom, left: send.left, right: send.right } };
    })()`);
    assert.ok(geometry.fab.bottom <= geometry.send.top + 1,
      `图标不应压住发送键：${JSON.stringify(geometry)}`);
    await page.screenshot('unattended-fab-mobile-390');

    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel').hidden === false`));
    assert.equal(await page.evaluate(`document.getElementById('unattended-panel').getAttribute('aria-labelledby')`), 'unattended-panel-title');

    // 空目标：本地先拦下，不发 start。
    await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-error').hidden === false`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-error').textContent === t('unattendedGoalRequired')`), true);
    assert.equal(unattendedPosts.length, 0, '空目标不发请求');

    // 预检 → 标准被填进各行 → 改写版可一键采用。
    await page.evaluate(`(() => {
      const goal = document.querySelector('.unat-goal');
      goal.value = '把上线流程走完';
      goal.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.unat-draft').click();
    })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.unat-criterion input[data-criterion]').length === 2`));
    assert.deepEqual(prechecks, [{ task: '把上线流程走完' }]);
    assert.equal(await page.evaluate(`document.querySelectorAll('.unat-criterion input[data-criterion]')[0].value`), '构建通过');
    assert.ok(await page.waitFor(`document.querySelector('.unat-use-revised')`));
    await page.evaluate(`document.querySelector('.unat-use-revised').click()`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-goal').value`), '把目标改成可验收的版本');

    await page.evaluate(`(() => {
      const rounds = document.querySelector('.unat-rounds');
      rounds.value = '12';
      rounds.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.unat-actions [data-action="start"]').click();
    })()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts.length, 1);
    assert.deepEqual(unattendedPosts[0], {
      action: 'start', goal: '把目标改成可验收的版本',
      criteria: ['构建通过', '测试通过'], maxRounds: 12, evaluateNow: true,
    });
    assert.equal(await page.evaluate(`document.querySelector('.unat-status-label').className.includes('unat-status-active')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-round').textContent === t('unattendedRoundProgress', { round: 0, max: 12 })`), true);

    // 停止 → 继续。按钮组随状态切换。
    await page.evaluate(`document.querySelector('.unat-actions [data-action="stop"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-stopped')`));
    assert.equal(unattendedPosts[1].action, 'stop');
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').hidden`), false, '终态可以用新目标重新 Start');
    assert.equal(await page.evaluate(`(() => { const b = document.querySelector('.unat-actions [data-action="resume"]'); return !!b && !b.hidden; })()`), true);
    await page.evaluate(`document.querySelector('.unat-actions [data-action="resume"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').hidden`), true, 'active 时交给 Update/Stop，不重复 Start');
    assert.equal(unattendedPosts[2].action, 'resume');

    // 关掉面板，浮动图标仍在，且状态色继续跟随。
    await page.evaluate(`document.querySelector('.unat-close').click()`);
    assert.equal(await page.evaluate(`document.getElementById('unattended-panel').hidden`), true);
    await page.screenshot('unattended-active-mobile-390');
  });
});
