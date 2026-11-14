'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 会话中的无人值守面板（public/chat-unattended.js）：
//   GET/POST /api/sessions/:id/unattended、POST /api/goal/precheck。
// 这里跑真实 chat.html：面板由 chat.js 在启动时 create，GET 一次校准；点开之后
// 启动前预检（目标不清 → 可编辑建议卡；预检挂了 → 仍然启动/取消）、启动、停止、
// 继续，并量一次手机上图标不压发送键。
// v3 把「轮次上限」换成「最长值守时间」：请求体只发 maxDurationMinutes，banner 与
// 状态块显示剩余时间（30 秒定时器只在该刷新时刷新）。
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
const limits = { maxDurationMinutesDefault: 120, maxDurationMinutesMin: 5, maxDurationMinutesMax: 1440 };
// precheckMode: warn（默认，有疑点）/ ok（直接启动）/ error（预检不可用）。
let precheckMode = 'warn';
let precheckDelayMs = 0;
routes['/api/sessions/s1/unattended'] = () => json({ ok: true, unattended, limits });
routes['POST /api/sessions/s1/unattended'] = ({ body }) => {
  const value = JSON.parse(body);
  unattendedPosts.push(value);
  if (value.action === 'start') {
    // 夹具的 deadlineAt 多留 30 秒，让「剩余 90 分」在渲染瞬间向下取整后仍是
    // 1小时30分（刚好 = now + 90min 时会因为几毫秒误差变成 1小时29分）。
    const startedAt = Date.now();
    const minutes = Number(value.maxDurationMinutes) || limits.maxDurationMinutesDefault;
    unattended = {
      status: 'active', goal: value.goal, criteria: value.criteria || [],
      maxDurationMinutes: minutes, rounds: 0, startedAt,
      deadlineAt: startedAt + minutes * 60000 + 30000,
      history: [], evaluating: false, pausedBy: null,
      lastVerdict: { verdict: 'continue', reason: '还需要构建', nextInstruction: '继续构建', humanReason: '', at: Date.now() },
    };
  } else if (value.action === 'stop') {
    if (unattended) unattended = { ...unattended, status: 'stopped', pausedBy: 'user', evaluating: false, updatedAt: Date.now() };
  } else if (value.action === 'resume') {
    if (unattended) unattended = { ...unattended, status: 'active', pausedBy: null, evaluating: false, updatedAt: Date.now() };
  } else if (value.action === 'update') {
    if (unattended) {
      unattended = {
        ...unattended,
        goal: value.goal != null ? value.goal : unattended.goal,
        criteria: value.criteria != null ? value.criteria : unattended.criteria,
        maxDurationMinutes: value.maxDurationMinutes != null ? value.maxDurationMinutes : unattended.maxDurationMinutes,
        updatedAt: Date.now(),
      };
    }
  } else if (value.action === 'clear') {
    unattended = null;
  }
  return json({ ok: true, unattended, limits });
};
routes['POST /api/goal/precheck'] = async ({ body }) => {
  prechecks.push(JSON.parse(body));
  if (precheckDelayMs) await new Promise(resolve => setTimeout(resolve, precheckDelayMs));
  if (precheckMode === 'error') return json({ ok: false, code: 'AUX_FAILED', error: '辅助模型不可用' });
  if (precheckMode === 'ok') {
    return json({
      ok: true, verdict: 'ok', score: 92, issues: [], questions: [],
      criteria: ['构建通过'], revised: '',
    });
  }
  return json({
    ok: true, verdict: 'warn', score: 62, issues: ['缺少可验证的验收标准'], questions: [],
    criteria: ['构建通过', '测试通过'], revised: '把目标改成可验收的版本',
  });
};

const qaDir = () => process.env.MULTICC_UNATTENDED_QA_DIR || path.join(os.tmpdir(), 'multicc-unattended-qa');

const INPUT_LOCK = `(() => ({
  input: document.getElementById('input').disabled,
  send: document.getElementById('send-btn').disabled,
  attach: document.getElementById('attach-btn').disabled,
  mic: document.getElementById('mic-btn').disabled,
  placeholder: document.getElementById('input').placeholder,
  bannerHidden: document.getElementById('unattended-banner').hidden,
  bannerText: document.querySelector('.unat-banner-text').textContent,
  bannerAction: document.querySelector('.unat-banner-btn').dataset.action || '',
  bannerLabel: document.querySelector('.unat-banner-btn').textContent,
  bannerReason: (() => { const r = document.querySelector('.unat-banner-reason'); return r.hidden ? '' : r.textContent; })(),
}))()`;

const expectedRemaining = page => page.evaluate(
  `t('unattendedRemainingHourMinute', { hours: 1, minutes: 30 })`);

test('chat unattended panel: duration, precheck-on-start card, start/stop/resume/update', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = null;
  unattendedPosts.length = 0;
  prechecks.length = 0;
  precheckMode = 'warn';
  precheckDelayMs = 0;
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab') && document.getElementById('unattended-panel')`));
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-idle')`));
    assert.equal(await page.evaluate(`document.getElementById('unattended-panel').hidden`), true);
    // 未启用：banner 不占位，附件/语音可用。（夹具里没有 WS，输入框与发送键
    // 因「未连接」本来就是禁用的 —— 锁定与否由 placeholder 与 #input-bar 类区分。）
    const idle = await page.evaluate(INPUT_LOCK);
    assert.equal(idle.attach, false);
    assert.equal(idle.mic, false);
    assert.equal(idle.bannerHidden, true);
    assert.equal(idle.placeholder, 'Type a message… or paste files here');
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-queued')`), false);

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

    // 浅色主题 + 390px：面板（含新增的时长行与预检卡样式）不能横向溢出。
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const light = await page.evaluate(`(() => {
      const panel = document.getElementById('unattended-panel').getBoundingClientRect();
      return { viewport: innerWidth, left: panel.left, right: panel.right,
               overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    })()`);
    assert.equal(light.overflow, false, '浅色 390px 下不能横向滚动：' + JSON.stringify(light));
    assert.ok(light.left >= -1 && light.right <= light.viewport + 1, '面板要落在视口内：' + JSON.stringify(light));
    await page.screenshot('unattended-panel-light-390');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

    // 最长值守时间：默认 2 小时，单位可切；旧的轮次输入已不存在。
    assert.equal(await page.evaluate(`document.querySelector('.unat-duration').value`), '2');
    assert.equal(await page.evaluate(`document.querySelector('.unat-duration-unit').value`), 'h');
    assert.equal(await page.evaluate(`document.querySelector('.unat-rounds') === null`), true, '轮次输入已退场');

    // 空目标：本地先拦下，不发预检也不发 start。
    await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-error').hidden === false`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-error').textContent === t('unattendedGoalRequired')`), true);
    assert.equal(unattendedPosts.length, 0, '空目标不发请求');
    assert.equal(prechecks.length, 0, '空目标不做预检');

    // 手动预检 → 标准被填进各行 → 改写版可一键采用。
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

    // 把值守时间改成 90 分钟（分钟单位），启动时只发 maxDurationMinutes。
    await page.evaluate(`(() => {
      const unit = document.querySelector('.unat-duration-unit');
      unit.value = 'm';
      unit.dispatchEvent(new Event('change', { bubbles: true }));
      const duration = document.querySelector('.unat-duration');
      duration.value = '90';
      duration.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    // 启动先自动预检：warn 不启动，给可编辑的建议卡。
    await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-precheck-title')`));
    assert.equal(unattendedPosts.length, 0, '预检有疑点时不启动');
    assert.equal(await page.evaluate(`document.querySelector('.unat-precheck-title').textContent === t('unattendedPrecheckTitle')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-revised-goal').value`), '把目标改成可验收的版本');
    assert.equal(await page.evaluate(`document.querySelector('.unat-revised-criteria').value`), '构建通过\n测试通过');
    const issuesText = await page.evaluate(`document.querySelector('.unat-precheck-issues').textContent`);
    assert.ok(issuesText.includes('缺少可验证的验收标准'), issuesText);

    // 编辑建议字段后，主按钮用的是编辑后的文本。
    await page.evaluate(`(() => {
      document.querySelector('.unat-revised-goal').value = '编辑后的目标';
      document.querySelector('.unat-revised-criteria').value = '构建通过\\n测试通过\\n验收截图';
      document.querySelector('.unat-precheck-adopt').click();
    })()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts.length, 1);
    assert.deepEqual(unattendedPosts[0], {
      action: 'start', goal: '编辑后的目标',
      criteria: ['构建通过', '测试通过', '验收截图'], maxDurationMinutes: 90, evaluateNow: true,
    });
    assert.equal('maxRounds' in unattendedPosts[0], false, '不再发送 maxRounds');
    assert.equal(await page.evaluate(`document.querySelector('.unat-status-label').className.includes('unat-status-active')`), true);

    // 剩余时间来自 deadlineAt（夹具 = startedAt + 90min + 30s → 1小时30分）。
    const remaining = await expectedRemaining(page);
    assert.equal(await page.evaluate(`document.querySelector('.unat-round').textContent`),
      await page.evaluate(`t('unattendedStatusMeta', { rounds: 0, remaining: ${JSON.stringify(remaining)} })`));
    assert.equal((await page.evaluate(INPUT_LOCK)).bannerText,
      await page.evaluate(`t('unattendedBannerActive', { remaining: ${JSON.stringify(remaining)} })`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-deadline').hidden`), false);
    assert.ok((await page.evaluate(`document.querySelector('.unat-deadline').textContent`)).startsWith('截止 '));
    assert.equal(await page.evaluate(`chatUnattended.isTicking()`), true, 'active 时倒计时表在跑');

    // active 不再锁输入：只把占位提示换成「发送会排队」，banner 在输入栏上方，
    // 按钮是「暂停并接管」。
    const locked = await page.evaluate(INPUT_LOCK);
    assert.equal(locked.input, true, '夹具无 WS：输入框只因未连接而禁用');
    assert.equal(locked.attach, false, 'active 时附件入口仍可用');
    assert.equal(locked.mic, false, 'active 时语音入口仍可用');
    assert.equal(locked.placeholder, await page.evaluate(`t('unattendedInputQueuedPlaceholder')`));
    assert.equal(locked.bannerHidden, false);
    assert.equal(locked.bannerLabel, await page.evaluate(`t('unattendedPauseTakeover')`));
    assert.equal(locked.bannerAction, 'stop');
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-queued')`), true);
    // 取消键仍可用：不清掉正在跑的这一轮的停止控制。
    assert.equal(await page.evaluate(`document.getElementById('cancel-btn').disabled`), false);

    // banner 的「暂停并接管」= POST stop，并立即解锁、清掉倒计时表。
    await page.evaluate(`document.querySelector('.unat-banner-btn').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-stopped')`));
    assert.equal(unattendedPosts.length, 2);
    assert.equal(unattendedPosts[1].action, 'stop');
    assert.equal(await page.evaluate(`chatUnattended.isTicking()`), false, '终态清掉倒计时表');
    const unlocked = await page.evaluate(INPUT_LOCK);
    assert.equal(unlocked.input, true, '夹具无 WS：输入框只因未连接而禁用，解锁不强行打开');
    assert.equal(unlocked.attach, false);
    assert.equal(unlocked.mic, false);
    assert.equal(unlocked.placeholder, 'Type a message… or paste files here', '暂停后恢复原 placeholder');
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-queued')`), false);
    assert.equal(unlocked.bannerText, await page.evaluate(`t('unattendedStatusStopped')`));
    assert.equal(unlocked.bannerReason, await page.evaluate(`t('unattendedPausedByUser')`));
    assert.equal(unlocked.bannerLabel, await page.evaluate(`t('unattendedBannerResume')`));
    assert.equal(unlocked.bannerAction, 'resume');
    assert.equal(await page.evaluate(`document.querySelector('.unat-paused').hidden`), false, '面板状态块显示 pausedBy');
    assert.equal(await page.evaluate(`document.querySelector('.unat-paused').textContent === t('unattendedPausedByUser')`), true);

    // banner 的「继续无人值守」= POST resume，再次上锁；resume 不预检。
    const prechecksBeforeResume = prechecks.length;
    await page.evaluate(`document.querySelector('.unat-banner-btn').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts.length, 3);
    assert.equal(unattendedPosts[2].action, 'resume');
    assert.equal(prechecks.length, prechecksBeforeResume, 'resume 不调用 /api/goal/precheck');
    assert.equal((await page.evaluate(INPUT_LOCK)).input, true, 'resume 后重新锁定');

    // 面板自己的 Stop 仍然工作（与 banner 共用同一份状态）。
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').hidden`), true, 'active 时交给 Update/Stop，不重复 Start');
    await page.evaluate(`document.querySelector('.unat-actions [data-action="stop"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-stopped')`));
    assert.equal(unattendedPosts[3].action, 'stop');
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').hidden`), false, '终态可以用新目标重新 Start');
    assert.equal(await page.evaluate(`(() => { const b = document.querySelector('.unat-actions [data-action="resume"]'); return !!b && !b.hidden; })()`), true);
    await page.evaluate(`document.querySelector('.unat-actions [data-action="resume"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts[4].action, 'resume');

    // Update 换目标/时长：不发 maxRounds，也不预检。
    const prechecksBeforeUpdate = prechecks.length;
    await page.evaluate(`(() => {
      const goal = document.querySelector('.unat-goal');
      goal.value = '更新后的目标';
      goal.dispatchEvent(new Event('input', { bubbles: true }));
      const unit = document.querySelector('.unat-duration-unit');
      unit.value = 'm';
      unit.dispatchEvent(new Event('change', { bubbles: true }));
      const duration = document.querySelector('.unat-duration');
      duration.value = '30';
      duration.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.unat-actions [data-action="update"]').click();
    })()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-goal').value === '更新后的目标'`));
    assert.equal(unattendedPosts[5].action, 'update');
    assert.deepEqual(unattendedPosts[5], {
      action: 'update', goal: '更新后的目标', criteria: ['构建通过', '测试通过', '验收截图'], maxDurationMinutes: 30,
    });
    assert.equal(prechecks.length, prechecksBeforeUpdate, 'update 不调用 /api/goal/precheck');

    // 关掉面板，浮动图标仍在，且状态色继续跟随。
    await page.evaluate(`document.querySelector('.unat-close').click()`);
    assert.equal(await page.evaluate(`document.getElementById('unattended-panel').hidden`), true);
    await page.screenshot('unattended-active-mobile-390');
  });
});

test('precheck-on-start: clear goal + criteria starts immediately', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = null;
  unattendedPosts.length = 0;
  prechecks.length = 0;
  precheckMode = 'ok';
  precheckDelayMs = 0;
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab') && document.getElementById('unattended-panel')`));
    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel').hidden === false`));
    await page.evaluate(`(() => {
      const goal = document.querySelector('.unat-goal');
      goal.value = '把上线走完';
      goal.dispatchEvent(new Event('input', { bubbles: true }));
      const criterion = document.querySelector('.unat-criterion input[data-criterion]');
      criterion.value = '构建通过';
      criterion.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.unat-actions [data-action="start"]').click();
    })()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(prechecks.length, 1);
    assert.deepEqual(prechecks[0], { task: '把上线走完' });
    assert.equal(unattendedPosts.length, 1);
    assert.deepEqual(unattendedPosts[0], {
      action: 'start', goal: '把上线走完', criteria: ['构建通过'],
      maxDurationMinutes: 120, evaluateNow: true,
    });
    assert.equal(await page.evaluate(`document.querySelector('.unat-precheck-title') === null`), true, '直接启动，不弹建议卡');
  });
});

test('precheck-on-start: a second click during precheck is ignored', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = null;
  unattendedPosts.length = 0;
  prechecks.length = 0;
  precheckMode = 'ok';
  precheckDelayMs = 250;
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel')`));
    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel').hidden === false`));
    await page.evaluate(`(() => {
      const goal = document.querySelector('.unat-goal');
      goal.value = '走完上线';
      goal.dispatchEvent(new Event('input', { bubbles: true }));
      const criterion = document.querySelector('.unat-criterion input[data-criterion]');
      criterion.value = '构建通过';
      criterion.dispatchEvent(new Event('input', { bubbles: true }));
      const button = document.querySelector('.unat-actions [data-action="start"]');
      const fire = () => button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fire();
      // 第二下发生在预检挂起期间；即使按钮的 disabled 被绕过，也必须被 busy 守卫拦住。
      button.disabled = false;
      fire();
    })()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`, { timeout: 5000 }));
    assert.equal(prechecks.length, 1, '预检只发一次');
    assert.equal(unattendedPosts.length, 1, '只启动一次');
  });
});

test('precheck card: cancel and start-as-written both work', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = null;
  unattendedPosts.length = 0;
  prechecks.length = 0;
  precheckMode = 'warn';
  precheckDelayMs = 0;
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel')`));
    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel').hidden === false`));
    // 没有判断标准 → 必然走建议卡（即使服务端 verdict=ok）。
    await page.evaluate(`(() => {
      const goal = document.querySelector('.unat-goal');
      goal.value = '原样目标';
      goal.dispatchEvent(new Event('input', { bubbles: true }));
      const unit = document.querySelector('.unat-duration-unit');
      unit.value = 'h';
      unit.dispatchEvent(new Event('change', { bubbles: true }));
      const duration = document.querySelector('.unat-duration');
      duration.value = '1';
      duration.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.unat-actions [data-action="start"]').click();
    })()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-precheck-title')`));
    assert.equal(unattendedPosts.length, 0);
    const issues = await page.evaluate(`document.querySelector('.unat-precheck-issues').textContent`);
    assert.ok(issues.includes(await page.evaluate(`t('unattendedMissingCriteria')`)), issues);

    // 取消：卡片收起，不启动。
    await page.evaluate(`document.querySelector('.unat-precheck-cancel').click()`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-precheck-title') === null`), true);
    assert.equal(unattendedPosts.length, 0, '取消不启动');

    // 再点启动 → 卡片再出现 → 按我的原样启动（原目标、空标准、60 分钟）。
    await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-precheck-original')`));
    await page.evaluate(`document.querySelector('.unat-precheck-original').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts.length, 1);
    assert.deepEqual(unattendedPosts[0], {
      action: 'start', goal: '原样目标', criteria: [], maxDurationMinutes: 60, evaluateNow: true,
    });
  });
});

test('precheck unavailable: still-start and cancel, never a silent start', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = null;
  unattendedPosts.length = 0;
  prechecks.length = 0;
  precheckMode = 'error';
  precheckDelayMs = 0;
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel')`));
    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel').hidden === false`));
    await page.evaluate(`(() => {
      const goal = document.querySelector('.unat-goal');
      goal.value = '预检挂了也要能启动';
      goal.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.unat-actions [data-action="start"]').click();
    })()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-precheck-cancel')`));
    assert.equal(unattendedPosts.length, 0, '预检不可用时绝不静默启动');
    assert.equal(await page.evaluate(`document.querySelector('.unat-precheck-verdict').textContent === t('unattendedPrecheckUnavailable')`), true);

    await page.evaluate(`document.querySelector('.unat-precheck-cancel').click()`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-precheck-cancel') === null`), true);
    assert.equal(unattendedPosts.length, 0);

    // 再试一次，这回「仍然启动」。
    await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.unat-precheck-adopt')`));
    await page.evaluate(`document.querySelector('.unat-precheck-adopt').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts.length, 1);
    assert.deepEqual(unattendedPosts[0], {
      action: 'start', goal: '预检挂了也要能启动', criteria: [], maxDurationMinutes: 120, evaluateNow: true,
    });
  });
});

// 状态帧语义不依赖 WS：把模块挂在一个最小 fixture 上，直接 applyState（服务端
// 重放与实时帧走的就是这一个入口），验剩余时间、到点终态与待答问题卡的锁定。
routes['/unattended-fixture.html'] = {
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div id="input-bar">
      <button id="mic-btn"></button><button id="attach-btn"></button>
      <textarea id="input"></textarea>
      <button id="send-btn"></button><button id="cancel-btn"></button>
    </div>
    <section id="pending-user-input-card" hidden>
      <div id="pending-user-input-question"></div>
      <div id="pending-user-input-reason"></div>
      <div id="pending-user-input-options"></div>
      <textarea id="pending-user-input-text"></textarea>
      <button id="pending-user-input-submit"></button>
      <button id="pending-user-input-dismiss"></button>
    </section>
    <script src="/i18n-catalog.js"></script>
    <script src="/i18n.js"></script>
    <script src="/chat-unattended.js"></script>
    <script src="/chat-user-input-card.js"></script>
    <script>
      // 让剩余时间可被测试驱动：30 秒定时器（这里缩成 25ms）每跳一次都会读到伪 now。
      let fakeNow = Date.now();
      Date.now = () => fakeNow;
      window.__setNow = value => { fakeNow = value; };
      window.__locks = [];
      // 重试帧的用例要单独验「到 retryAt 立刻重画」：?tickMs=60000 把 30 秒表调慢，
      // 这样 2 秒内的翻转只可能来自按 retryAt 挂的那只一次性表。
      const fixtureTickMs = Number(new URLSearchParams(location.search).get('tickMs')) || 25;
      window.__u = MultiCCChatUnattended.create({
        document, window, translate: t,
        getSessionId: () => '',
        request: async () => ({ ok: true, unattended: null }),
        applyInputState: active => window.__locks.push(active),
        tickMs: fixtureTickMs,
      });
      window.__card = MultiCCChatUserInputCard.createController({
        document, translate: t,
        isConnected: () => true,
        submitAnswer: () => true,
      });
    </script>
  </body></html>`,
};

test('applyState shows remaining time, expires at the deadline, and switches the queue hint immediately', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/unattended-fixture.html');
    assert.ok(await page.waitFor(`window.__u && window.__card`));
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').hidden`), true);

    const base = await page.evaluate(`Date.now()`);
    // 80 分 30 秒 → 显示 1小时20分。
    const deadlineAt = base + 80 * 60000 + 30000;
    await page.evaluate(`window.__u.applyState({
      status: 'active', rounds: 2, maxDurationMinutes: 120, startedAt: ${base},
      deadlineAt: ${deadlineAt}, evaluating: true, pausedBy: null, goal: 'x',
    })`);
    assert.deepEqual(await page.evaluate(`window.__locks`), [true]);
    const expected80 = await page.evaluate(`t('unattendedRemainingHourMinute', { hours: 1, minutes: 20 })`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent`),
      await page.evaluate(`t('unattendedBannerActive', { remaining: ${JSON.stringify(expected80)} })`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-round').textContent`),
      await page.evaluate(`t('unattendedStatusMeta', { rounds: 2, remaining: ${JSON.stringify(expected80)} })`));
    const expectedClock = await page.evaluate(`(() => {
      const d = new Date(${deadlineAt});
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    })()`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-deadline').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('.unat-deadline').textContent`),
      await page.evaluate(`t('unattendedDeadline', { time: ${JSON.stringify(expectedClock)} })`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner .unat-spinner').hidden`), false);
    assert.equal(await page.evaluate(`document.getElementById('unattended-fab').classList.contains('unat-evaluating')`), true);
    assert.equal(await page.evaluate(`window.__u.isTicking()`), true);

    // 30 秒定时器（夹具 25ms）：时间推进 35 分钟后，banner 自己变成 45分。
    await page.evaluate(`window.__setNow(${base} + 35 * 60000)`);
    const expected45 = await page.evaluate(`t('unattendedRemainingMinute', { minutes: 45 })`);
    assert.ok(await page.waitFor(
      `document.querySelector('.unat-banner-text').textContent === t('unattendedBannerActive', { remaining: ${JSON.stringify(expected45)} })`));

    // 到点：服务端写 exhausted + human reason；banner 说明原因，倒计时表停掉。
    await page.evaluate(`window.__u.applyState({
      status: 'exhausted', rounds: 2, maxDurationMinutes: 120, deadlineAt: ${deadlineAt},
      evaluating: false, pausedBy: null, goal: 'x',
      lastVerdict: { verdict: 'needs_human', reason: '已到时间', humanReason: '已达到最长值守时间', at: ${base} },
    })`);
    assert.deepEqual(await page.evaluate(`window.__locks`), [true, false], '非 active 帧立刻解锁');
    assert.equal(await page.evaluate(`document.getElementById('unattended-fab').classList.contains('unat-state-exhausted')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent === t('unattendedStatusExhausted')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-reason').textContent === t('unattendedMaxDurationReached')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-human').textContent === t('unattendedMaxDurationReached')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-verdict').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('.unat-deadline').hidden`), true, '终态不再显示剩余时间');
    assert.equal(await page.evaluate(`window.__u.isTicking()`), false, '终态停表');

    // 停表后继续推进时间：banner 不再变化。
    await page.evaluate(`window.__setNow(${base} + 300 * 60000)`);
    await page.waitFor(`new Promise(resolve => setTimeout(resolve, 80))`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent === t('unattendedStatusExhausted')`), true);

    // active 帧再次上锁，而且只在布尔真的翻转时通知宿主。
    await page.evaluate(`window.__u.applyState({ status: 'active', rounds: 4, maxDurationMinutes: 120, deadlineAt: ${deadlineAt}, evaluating: false, pausedBy: null, goal: 'x' })`);
    await page.evaluate(`window.__u.applyState({ status: 'active', rounds: 5, maxDurationMinutes: 120, deadlineAt: ${deadlineAt}, evaluating: false, pausedBy: null, goal: 'x' })`);
    assert.deepEqual(await page.evaluate(`window.__locks`), [true, false, true]);

    // pausedBy 显示在面板状态块。
    await page.evaluate(`window.__u.applyState({ status: 'stopped', pausedBy: 'input', goal: 'x' })`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-reason').textContent === t('unattendedPausedByInput')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-paused').textContent === t('unattendedPausedByInput')`), true);

    // 待答问题卡：锁定时选项/输入/提交全禁用，并出现「AI 会自己回答」提示。
    await page.evaluate(`window.__card.render({ requestId: 'usrq-1', question: '部署？', options: ['是', '否'] })`);
    await page.evaluate(`window.__card.setUnattendedLock(true)`);
    const card = await page.evaluate(`(() => {
      const root = document.getElementById('pending-user-input-card');
      const options = [...document.querySelectorAll('#pending-user-input-options button')];
      const hint = root.querySelector('.pending-input-unattended-hint');
      return {
        lock: root.dataset.unattendedLock,
        options: options.map(button => button.disabled),
        text: document.getElementById('pending-user-input-text').disabled,
        submit: document.getElementById('pending-user-input-submit').disabled,
        hint: hint ? { hidden: hint.hidden, text: hint.textContent } : null,
      };
    })()`);
    assert.equal(card.lock, '1');
    assert.deepEqual(card.options, [true, true]);
    assert.equal(card.text, true);
    assert.equal(card.submit, true);
    assert.equal(card.hint.hidden, false);
    assert.equal(card.hint.text, await page.evaluate(`t('pendingInputUnattendedHint')`));
    assert.equal(await page.evaluate(`window.__card.submit('是')`), false, '锁定时程序化提交也无效');

    await page.evaluate(`window.__card.setUnattendedLock(false)`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#pending-user-input-options button')].map(b => b.disabled)`), [false, false]);
    assert.equal(await page.evaluate(`document.querySelector('.pending-input-unattended-hint').hidden`), true);
    assert.equal(await page.evaluate(`document.getElementById('pending-user-input-card').dataset.unattendedLock`), '');
  });
});

// 标记消息与 UI-only 轨迹行：历史回放与实时广播共用 view 的同一批渲染函数。
routes['/unattended-marks-fixture.html'] = {
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div id="messages"></div>
    <script src="/i18n-catalog.js"></script>
    <script src="/i18n.js"></script>
    <script src="/shared/format.js"></script>
    <script src="/chat-history-view.js"></script>
    <script>
      window.__view = MultiCCChatHistoryView.createHistoryView({
        document, messagesEl: document.getElementById('messages'), translate: t,
      });
      window.__view.commitMessage({
        id: 'u1', role: 'user', content: '🔇[无人值守 Unattended] 继续推进构建',
      }, {});
      window.__view.commitMessage({
        id: 't1', role: 'system', kind: 'unattended_trace',
        content: '[无人值守 Unattended] 判定：继续 · 还需要构建 · 下一步：继续构建',
      }, {});
      // 同一 id 的实时广播 + 第二次无 id 的同文本广播都不能画第二遍。
      window.__view.appendUnattendedTrace({
        id: 't1', content: '[无人值守 Unattended] 判定：继续 · 还需要构建 · 下一步：继续构建',
      });
    </script>
  </body></html>`,
};

// 回归：未启用（null）以及任何非 active 状态，已连接的会话输入框必须可用。夹具里没有
// WS，别的用例里输入框因「未连接」本来就是灰的，看不出「默认被锁」这种回归；这里给
// 页面一个 OPEN 的假套接字，让 updateUI() 走「已连接」分支再断言。
test('connected session is never locked by the supervisor', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = null;
  unattendedPosts.length = 0;
  const connectedRoutes = { ...routes, 'POST /api/task-shells': {
    status: 400, ...json({ code: 'unsupported_source' }),
  } };
  await withCdpHarness({ routes: connectedRoutes, screenshotDir: qaDir() }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__sent = [];
      window.WebSocket = class {
        static OPEN = 1;
        constructor() {
          this.readyState = 0;
          setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
        }
        send(raw) { window.__sent.push(JSON.parse(raw)); }
        close() { this.readyState = 3; }
      };
    ` });
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-idle')`));
    assert.ok(await page.waitFor(`ws?.readyState === WebSocket.OPEN && !inputEl.disabled`));
    const open = () => page.evaluate(`({
      input: document.getElementById('input').disabled,
      send: document.getElementById('send-btn').disabled,
      attach: document.getElementById('attach-btn').disabled,
      mic: document.getElementById('mic-btn').disabled,
      barLocked: document.getElementById('input-bar').classList.contains('unattended-queued'),
      placeholder: document.getElementById('input').placeholder,
    })`);
    // 真正的「被挡住」：未启用时没有任何东西盖在输入区上 —— 遮罩必须是隐藏的，输入框、
    // 发送键、附件键的中心点命中的必须是它们自己（而不是全屏遮罩）。
    assert.equal(await page.evaluate(`document.querySelector('.unat-scrim').hidden`), true, '遮罩初始必须隐藏');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.unat-scrim')).display`), 'none');
    const hits = await page.evaluate(`['input', 'send-btn', 'attach-btn', 'mic-btn'].map(id => {
      const node = document.getElementById(id);
      const rect = node.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { id, hit: !!top && (top === node || node.contains(top)), top: top && (top.id || top.className) };
    })`);
    for (const item of hits) assert.equal(item.hit, true, item.id + ' 被 ' + item.top + ' 盖住了');
    const none = await open();
    assert.deepEqual([none.input, none.send, none.attach, none.mic, none.barLocked], [false, false, false, false, false],
      '未启用：已连接的输入区必须全部可用');
    assert.equal(none.placeholder, 'Type a message… or paste files here');

    // 任何状态都不锁输入；状态走 WS 帧同一个入口。
    for (const status of ['stopped', 'achieved', 'needs_human', 'exhausted', 'error']) {
      const state = {
        status, goal: 'g', criteria: [], maxDurationMinutes: 120, rounds: 1, history: [],
        evaluating: false, pausedBy: status === 'stopped' ? 'user' : null, lastVerdict: null,
      };
      await page.evaluate(`chatUnattended.applyState(${JSON.stringify(state)})`);
      const snap = await open();
      assert.deepEqual([snap.input, snap.send, snap.attach, snap.mic, snap.barLocked], [false, false, false, false, false],
        status + '：非 active 不能锁输入');
    }
    // active 帧也只切换提示，不锁任何入口；回到 null（会话被清空）恢复默认。
    await page.evaluate(`chatUnattended.applyState(${JSON.stringify({
      status: 'active', goal: 'g', criteria: [], maxDurationMinutes: 120, rounds: 1, history: [],
      evaluating: false, pausedBy: null, lastVerdict: null,
    })})`);
    const active = await open();
    assert.deepEqual([active.input, active.send, active.attach, active.mic, active.barLocked],
      [false, false, false, false, true], 'active：全部入口可用，只带排队提示');
    assert.equal(active.placeholder, await page.evaluate(`t('unattendedInputQueuedPlaceholder')`));
    // 待答期间的普通输入不能冒充无人值守的回答，也不能取消当前回合。
    await page.evaluate(`(() => {
      window.__sent.length = 0;
      isStreaming = true;
      chatEventState.pendingUserInputRequestId = 'pending-while-unattended';
      for (const text of ['排队第一条', '排队第二条']) {
        inputEl.value = text;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        chatComposer.send();
      }
    })()`);
    const sent = await page.evaluate(`window.__sent.filter(frame => frame.type === 'user_message')`);
    assert.equal(sent.length, 2);
    assert.equal(await page.evaluate(`window.__sent.some(frame => frame.type === 'cancel')`), false);
    assert.deepEqual(sent.map(frame => frame.type), ['user_message', 'user_message']);
    assert.deepEqual(sent.map(frame => frame.text), ['排队第一条', '排队第二条']);
    assert.ok(sent.every(frame => !frame.userInputRequestId));
    assert.equal(await page.evaluate(`chatEventState.pendingUserInputRequestId`), 'pending-while-unattended');
    assert.equal(await page.evaluate(`chatUnattended.isActive()`), true);
    await page.evaluate(`chatUnattended.applyState(null)`);
    const cleared = await open();
    assert.deepEqual([cleared.input, cleared.send, cleared.attach, cleared.mic, cleared.barLocked], [false, false, false, false, false]);
    assert.equal(cleared.placeholder, 'Type a message… or paste files here');
    await page.evaluate(`inputEl.value = '人工接管后的回答'; chatComposer.send()`);
    assert.equal((await page.evaluate(`window.__sent.at(-1)`)).userInputRequestId, 'pending-while-unattended');

    await page.evaluate(`applyUnattendedInputState(true)`);
    const hinted = await open();
    assert.deepEqual([hinted.input, hinted.send, hinted.attach, hinted.mic, hinted.barLocked], [false, false, false, false, true]);
    await page.evaluate(`applyUnattendedInputState(false)`);
    const freed = await open();
    assert.deepEqual([freed.input, freed.send, freed.attach, freed.mic, freed.barLocked], [false, false, false, false, false]);
  });
});

test('marked unattended messages and trace lines render with a badge', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/unattended-marks-fixture.html');
    assert.ok(await page.waitFor(`window.__view && document.querySelector('.unattended-mark')`));

    const mark = await page.evaluate(`(() => {
      const node = document.querySelector('.unattended-mark');
      return {
        user: node.classList.contains('user'),
        inject: node.classList.contains('system-inject'),
        badge: node.querySelector('.unat-badge').textContent,
        text: node.querySelector('.unat-mark-text').textContent,
        raw: node.textContent,
      };
    })()`);
    assert.equal(mark.user, true, '标记消息沿用 user 节点，去重/锚点逻辑不变');
    assert.equal(mark.inject, true, '标记消息是系统注入，不是一次真实用户发言');
    assert.equal(mark.badge, await page.evaluate(`t('unattendedBadge')`));
    assert.equal(mark.text, '继续推进构建');
    assert.equal(mark.raw.includes('🔇'), false);
    assert.equal(mark.raw.includes('[无人值守 Unattended]'), false);

    const traces = await page.evaluate(`[...document.querySelectorAll('.unattended-trace')].map(node => ({
      id: node.dataset.msgId || '',
      badge: node.querySelector('.unat-badge').textContent,
      text: node.querySelector('.unat-mark-text').textContent,
    }))`);
    assert.equal(traces.length, 1, '同 id 的实时广播不能与历史回放叠加成两条');
    assert.equal(traces[0].id, 't1');
    assert.equal(traces[0].badge, await page.evaluate(`t('unattendedBadge')`));
    assert.equal(traces[0].text, '判定：继续 · 还需要构建 · 下一步：继续构建');

    // 无 id 的重复轨迹按文本去重。
    await page.evaluate(`window.__view.appendUnattendedTrace({ content: '[无人值守 Unattended] 已暂停（用户接管）' })`);
    await page.evaluate(`window.__view.appendUnattendedTrace({ content: '[无人值守 Unattended] 已暂停（用户接管）' })`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.unattended-trace').length`), 2);
  });
});

// ── 故障恢复退避：retryAt / retryCategory ─────────────────────────────────────
// 上游额度或线路暂不可用时监督器不再 3 次即放弃，而是退避后自动重试。active 且
// retryAt 在未来时，banner 与面板状态块要说清「何时、第几次重试」。字段缺失
// （老服务端）时行为不变，所以这些用例只覆盖显式给出 retryAt 的帧。
test('retry banner: capacity/fault copy, soon branch, panel line, and flip back', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/unattended-fixture.html');
    assert.ok(await page.waitFor(`window.__u`));
    const base = await page.evaluate(`Date.now()`);
    const deadlineAt = base + 90 * 60000;
    const retryAt = base + 5 * 60000;
    const remaining90 = await page.evaluate(`t('unattendedRemainingHourMinute', { hours: 1, minutes: 30 })`);
    const clock = await page.evaluate(`(() => {
      const d = new Date(${retryAt});
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    })()`);
    const frame = (category, n, at) => `window.__u.applyState({
      status: 'active', rounds: 1, maxDurationMinutes: 120, startedAt: ${base}, deadlineAt: ${deadlineAt},
      evaluating: false, pausedBy: null, goal: 'x', retryAt: ${at}, retryCategory: ${JSON.stringify(category)},
      stall: { consecutiveFaults: ${n} },
    })`;

    // capacity（额度/线路暂不可用）：banner + 面板状态块说同一句，锁继续生效。
    await page.evaluate(frame('capacity', 2, retryAt));
    const capacityText = await page.evaluate(`t('unattendedRetryCapacity', { time: ${JSON.stringify(clock)}, n: 2 })
      + ' · ' + t('unattendedRemaining', { remaining: ${JSON.stringify(remaining90)} })`);
    assert.deepEqual(await page.evaluate(`window.__locks`), [true], 'active 时输入收到排队提示');
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent`), capacityText);
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').classList.contains('unat-banner-retry')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-retry').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('.unat-retry').textContent`), capacityText,
      '面板状态块显示同一句重试说明');
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-btn').dataset.action`), 'stop',
      '重试期间仍可暂停并接管');
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-btn').textContent === t('unattendedPauseTakeover')`), true);

    // fault（其它故障）：换成「故障恢复中」，第 n 次取自 stall.consecutiveFaults。
    await page.evaluate(frame('fault', 3, retryAt));
    const faultText = await page.evaluate(`t('unattendedRetryFault', { time: ${JSON.stringify(clock)}, n: 3 })
      + ' · ' + t('unattendedRemaining', { remaining: ${JSON.stringify(remaining90)} })`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent`), faultText);
    assert.equal(await page.evaluate(`document.querySelector('.unat-retry').textContent`), faultText);
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').classList.contains('unat-banner-retry')`), true);

    // 距 retryAt 不足 60 秒：不再报具体时刻，改说「即将自动重试」（不再重复动词）。
    await page.evaluate(frame('capacity', 4, base + 30 * 1000));
    const soonText = await page.evaluate(`(() => {
      const soon = t('unattendedRetrySoon');
      const line = t('unattendedRetryCapacity', { time: soon, n: 4 })
        .split(soon + ' 自动重试').join(soon)
        .split('retrying at ' + soon).join(soon);
      return line + ' · ' + t('unattendedRemaining', { remaining: ${JSON.stringify(remaining90)} });
    })()`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent`), soonText);
    const soonPhrase = await page.evaluate(`t('unattendedRetrySoon')`);
    assert.ok(soonText.includes(soonPhrase), soonText);
    assert.ok(!soonText.includes(soonPhrase + ' 自动重试'), '不能说成「即将自动重试 自动重试」：' + soonText);
    assert.ok(!soonText.includes('retrying at ' + soonPhrase), '英文不能出现 retrying at retrying shortly：' + soonText);

    // retryAt 过去（伪时钟推进）：恢复成原来的「进行中 · 剩余」，琥珀色撤掉。
    await page.evaluate(`window.__setNow(${base + 10 * 60000})`);
    const remaining80 = await page.evaluate(`t('unattendedRemainingHourMinute', { hours: 1, minutes: 20 })`);
    const normalText = await page.evaluate(`t('unattendedBannerActive', { remaining: ${JSON.stringify(remaining80)} })`);
    assert.ok(await page.waitFor(
      `document.querySelector('.unat-banner-text').textContent === ${JSON.stringify(normalText)}`));
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').classList.contains('unat-banner-retry')`), false);
    assert.equal(await page.evaluate(`document.querySelector('.unat-retry').hidden`), true);
  });
});

test('retryAt timer repaints without waiting for the 30s tick', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes }, async page => {
    // 30 秒表被调成 60 秒：2 秒内能翻转只可能来自按 retryAt 挂的一次性表。
    await page.navigate('/unattended-fixture.html?tickMs=60000');
    assert.ok(await page.waitFor(`window.__u`));
    const base = await page.evaluate(`Date.now()`);
    const deadlineAt = base + 90 * 60000;
    await page.evaluate(`window.__u.applyState({
      status: 'active', rounds: 1, maxDurationMinutes: 120, startedAt: ${base}, deadlineAt: ${deadlineAt},
      evaluating: false, pausedBy: null, goal: 'x', retryAt: ${base + 400}, retryCategory: 'fault',
      stall: { consecutiveFaults: 1 },
    })`);
    const soonText = await page.evaluate(`(() => {
      const soon = t('unattendedRetrySoon');
      const line = t('unattendedRetryFault', { time: soon, n: 1 })
        .split(soon + ' 自动重试').join(soon)
        .split('retrying at ' + soon).join(soon);
      return line + ' · ' + t('unattendedRemaining', {
        remaining: t('unattendedRemainingHourMinute', { hours: 1, minutes: 30 }),
      });
    })()`);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent`), soonText);
    assert.ok(soonText.includes(await page.evaluate(`t('unattendedRetrySoon')`)));

    // 拨过 retryAt 后不再动它：只有那只一次性表会把 banner 换回正常文案。
    await page.evaluate(`window.__setNow(${base + 60000})`);
    const remaining89 = await page.evaluate(`t('unattendedRemainingHourMinute', { hours: 1, minutes: 29 })`);
    const normalText = await page.evaluate(`t('unattendedBannerActive', { remaining: ${JSON.stringify(remaining89)} })`);
    assert.ok(await page.waitFor(
      `document.querySelector('.unat-banner-text').textContent === ${JSON.stringify(normalText)}`,
      { timeout: 3000 }), '到 retryAt 应立刻重画，不等 30 秒表');
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').classList.contains('unat-banner-retry')`), false);
  });
});

test('retry state keeps the queue hint and pause-and-takeover works', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const now = Date.now();
  unattendedPosts.length = 0;
  prechecks.length = 0;
  // 服务端状态直接带 retryAt：GET 校准就该画出琥珀色重试条。
  unattended = {
    status: 'active', goal: 'g', criteria: [], maxDurationMinutes: 120, rounds: 1,
    startedAt: now, deadlineAt: now + 120 * 60000 + 30000, history: [],
    evaluating: false, pausedBy: null, lastVerdict: null,
    retryAt: now + 5 * 60000, retryCategory: 'capacity', stall: { consecutiveFaults: 2 },
  };
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    const clock = await page.evaluate(`(() => {
      const d = new Date(${unattended.retryAt});
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    })()`);
    const remaining = await page.evaluate(`t('unattendedRemainingHour', { hours: 2 })`);
    const expected = await page.evaluate(`t('unattendedRetryCapacity', { time: ${JSON.stringify(clock)}, n: 2 })
      + ' · ' + t('unattendedRemaining', { remaining: ${JSON.stringify(remaining)} })`);
    const locked = await page.evaluate(INPUT_LOCK);
    assert.equal(locked.bannerHidden, false);
    assert.equal(locked.bannerText, expected);
    assert.equal(locked.bannerAction, 'stop');
    assert.equal(locked.bannerLabel, await page.evaluate(`t('unattendedPauseTakeover')`));
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').classList.contains('unat-banner-retry')`), true);
    assert.equal(locked.attach, false, '重试期间附件入口仍可用');
    assert.equal(locked.mic, false, '重试期间语音入口仍可用');
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-queued')`), true);

    // 「暂停并接管」照常工作：POST stop，立刻解锁、撤掉琥珀色。
    await page.evaluate(`document.querySelector('.unat-banner-btn').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-stopped')`));
    assert.equal(unattendedPosts.length, 1);
    assert.equal(unattendedPosts[0].action, 'stop');
    const unlocked = await page.evaluate(INPUT_LOCK);
    assert.equal(unlocked.attach, false);
    assert.equal(unlocked.mic, false);
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-queued')`), false);
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').classList.contains('unat-banner-retry')`), false, '暂停后不再是重试态');
  });
});

// 终态无人值守可以被用户「结束」：banner 与面板都要有那个安静的次要按钮，
// 点击发 clear，服务端删掉状态后 banner 消失、输入保持可用，表单保留草稿。
test('paused banner: 结束无人值守 clears the run, hides the banner and keeps the draft', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const startedAt = Date.now() - 60_000;
  unattended = {
    status: 'stopped', goal: '把上线走完', criteria: ['构建通过'], maxDurationMinutes: 60,
    rounds: 1, startedAt, deadlineAt: startedAt + 60 * 60000, updatedAt: Date.now(),
    history: [], evaluating: false, pausedBy: 'user', lastVerdict: null,
  };
  unattendedPosts.length = 0;
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-banner') && !document.getElementById('unattended-banner').hidden`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-clear').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-clear').textContent`),
      await page.evaluate(`t('unattendedClear')`));
    // The fixture has no live WS, so the composer may be disabled for its own
    // reasons; what must be false is the unattended input lock.
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-queued')`), false, '终态不锁输入');

    await page.evaluate(`document.querySelector('.unat-banner-clear').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-banner').hidden`));
    assert.deepEqual(unattendedPosts.map(post => post.action), ['clear']);
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-queued')`), false, 'clear 后输入仍解锁');

    // 面板回到「未启用」：Start 可见，Clear 隐藏，表单保留刚才的草稿。
    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('unattended-panel').hidden`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions .unat-clear').hidden`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-goal').value`), '把上线走完');
  });
});

test('active banner does NOT offer 结束无人值守 (pause first)', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const startedAt = Date.now();
  unattended = {
    status: 'active', goal: '把上线走完', criteria: [], maxDurationMinutes: 60,
    rounds: 0, startedAt, deadlineAt: startedAt + 60 * 60000, updatedAt: startedAt,
    history: [], evaluating: false, pausedBy: null, lastVerdict: null,
  };
  unattendedPosts.length = 0;
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-banner') && !document.getElementById('unattended-banner').hidden`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-btn').dataset.action`), 'stop');
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-clear').hidden`), true);
    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('unattended-panel').hidden`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions .unat-clear').hidden`), true);
    assert.equal(unattendedPosts.length, 0, 'no action was posted');
  });
});
