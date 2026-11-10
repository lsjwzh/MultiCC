'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 会话中的无人值守面板（public/chat-unattended.js）：
//   GET/POST /api/sessions/:id/unattended、POST /api/goal/precheck。
// 这里跑真实 chat.html：面板由 chat.js 在启动时 create，GET 一次校准；点开之后
// 做预检、启动、停止、继续，并量一次手机上图标不压发送键。
// v2 追加：active 锁输入 + banner（暂停并接管/继续无人值守）、判定中 spinner、
// 标记消息与 UI-only 轨迹的渲染、待答问题卡的锁定。
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
      evaluating: false, pausedBy: null,
      lastVerdict: { verdict: 'continue', reason: '还需要构建', nextInstruction: '继续构建', humanReason: '', at: Date.now() },
    };
  } else if (value.action === 'stop') {
    if (unattended) unattended = { ...unattended, status: 'stopped', pausedBy: 'user', evaluating: false, updatedAt: Date.now() };
  } else if (value.action === 'resume') {
    if (unattended) unattended = { ...unattended, status: 'active', pausedBy: null, evaluating: false, updatedAt: Date.now() };
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

test('chat unattended panel: precheck, start/stop/resume, input lock and a non-overlapping icon', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = null;
  unattendedPosts.length = 0;
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
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-locked')`), false);

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

    // v2：active 锁死输入区，banner 就在输入栏上方，按钮是「暂停并接管」。
    const locked = await page.evaluate(INPUT_LOCK);
    assert.equal(locked.input, true, 'active 时 textarea 必须锁定');
    assert.equal(locked.send, true, 'active 时发送键必须锁定');
    assert.equal(locked.attach, true, 'active 时附件入口必须锁定');
    assert.equal(locked.mic, true, 'active 时语音入口必须锁定');
    assert.equal(locked.placeholder, await page.evaluate(`t('unattendedInputLockedPlaceholder')`));
    assert.equal(locked.bannerHidden, false);
    assert.equal(locked.bannerText, await page.evaluate(`t('unattendedBannerActive', { round: 0, max: 12 })`));
    assert.equal(locked.bannerLabel, await page.evaluate(`t('unattendedPauseTakeover')`));
    assert.equal(locked.bannerAction, 'stop');
    // 取消键仍可用：锁不解掉正在跑的这一轮的停止控制。
    assert.equal(await page.evaluate(`document.getElementById('cancel-btn').disabled`), false);

    // banner 的「暂停并接管」= POST stop，并立即解锁。
    await page.evaluate(`document.querySelector('.unat-banner-btn').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-stopped')`));
    assert.equal(unattendedPosts.length, 2);
    assert.equal(unattendedPosts[1].action, 'stop');
    const unlocked = await page.evaluate(INPUT_LOCK);
    assert.equal(unlocked.input, true, '夹具无 WS：输入框只因未连接而禁用，解锁不强行打开');
    assert.equal(unlocked.attach, false);
    assert.equal(unlocked.mic, false);
    assert.equal(unlocked.placeholder, 'Type a message… or paste files here', '解锁恢复原 placeholder');
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-locked')`), false);
    assert.equal(unlocked.bannerText, await page.evaluate(`t('unattendedStatusStopped')`));
    assert.equal(unlocked.bannerReason, await page.evaluate(`t('unattendedPausedByUser')`));
    assert.equal(unlocked.bannerLabel, await page.evaluate(`t('unattendedBannerResume')`));
    assert.equal(unlocked.bannerAction, 'resume');
    assert.equal(await page.evaluate(`document.querySelector('.unat-paused').hidden`), false, '面板状态块显示 pausedBy');
    assert.equal(await page.evaluate(`document.querySelector('.unat-paused').textContent === t('unattendedPausedByUser')`), true);

    // banner 的「继续无人值守」= POST resume，再次上锁。
    await page.evaluate(`document.querySelector('.unat-banner-btn').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts.length, 3);
    assert.equal(unattendedPosts[2].action, 'resume');
    assert.equal((await page.evaluate(INPUT_LOCK)).input, true, 'resume 后重新锁定');

    // 面板自己的 Stop / Resume 仍然工作（与 banner 共用同一份状态）。
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').hidden`), true, 'active 时交给 Update/Stop，不重复 Start');
    await page.evaluate(`document.querySelector('.unat-actions [data-action="stop"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-stopped')`));
    assert.equal(unattendedPosts[3].action, 'stop');
    assert.equal(await page.evaluate(`document.querySelector('.unat-actions [data-action="start"]').hidden`), false, '终态可以用新目标重新 Start');
    assert.equal(await page.evaluate(`(() => { const b = document.querySelector('.unat-actions [data-action="resume"]'); return !!b && !b.hidden; })()`), true);
    await page.evaluate(`document.querySelector('.unat-actions [data-action="resume"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.equal(unattendedPosts[4].action, 'resume');

    // 关掉面板，浮动图标仍在，且状态色继续跟随。
    await page.evaluate(`document.querySelector('.unat-close').click()`);
    assert.equal(await page.evaluate(`document.getElementById('unattended-panel').hidden`), true);
    await page.screenshot('unattended-active-mobile-390');
  });
});

test('initial/replayed state locks the composer and shows 判定中 while evaluating', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  unattended = {
    status: 'active', goal: '把上线走完', criteria: ['构建通过'], maxRounds: 10, rounds: 3,
    history: [], evaluating: true, pausedBy: null,
    lastVerdict: { verdict: 'continue', reason: '还没构建', nextInstruction: '继续构建', humanReason: '', at: Date.now() },
  };
  unattendedPosts.length = 0;
  await withCdpHarness({ routes, screenshotDir: qaDir() }, async page => {
    await page.navigate('/chat.html?session=s1');
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab')`));
    // GET 在创建时校准：这就是刷新/重连重放拿到的同一份状态。
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-active')`));
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-evaluating')`));
    const locked = await page.evaluate(INPUT_LOCK);
    assert.equal(locked.input, true, '重连重放 active 也必须锁输入');
    assert.equal(locked.bannerHidden, false);
    assert.equal(locked.bannerText, await page.evaluate(`t('unattendedBannerActive', { round: 3, max: 10 })`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner .unat-spinner').hidden`), false, 'banner 转「判定中」');

    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-panel').hidden === false`));
    assert.ok(await page.waitFor(`document.querySelector('.unat-evaluating').hidden === false`));
    assert.equal(await page.evaluate(`document.querySelector('.unat-evaluating').textContent === t('unattendedJudging')`), true);
    await page.evaluate(`document.querySelector('.unat-close').click()`);

    // 服务端转入终态：下一次校准（WS 帧走同一个 applyState）立刻解锁。
    unattended = { ...unattended, status: 'stopped', pausedBy: 'cancel', evaluating: false };
    await page.evaluate(`document.getElementById('unattended-fab').click()`);
    assert.ok(await page.waitFor(`document.getElementById('unattended-fab').classList.contains('unat-state-stopped')`));
    // 夹具没有 WS，输入框仍因未连接而禁用；锁定是否解除看 composer 类与占位符
    // （applyInputLock(false) 会立刻复原它们）。
    assert.equal(await page.evaluate(`document.getElementById('input-bar').classList.contains('unattended-locked')`), false);
    assert.equal(await page.evaluate(`document.getElementById('input').placeholder`), 'Type a message… or paste files here');
    assert.equal(await page.evaluate(`document.querySelector('.unat-fab').classList.contains('unat-evaluating')`), false, '终态清掉判定中');
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-reason').textContent === t('unattendedPausedByCancel')`), true);
  });
});

// 状态帧语义不依赖 WS：把模块挂在一个最小 fixture 上，直接 applyState（服务端
// 重放与实时帧走的就是这一个入口），并顺带验待答问题卡的锁定。
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
      window.__locks = [];
      window.__u = MultiCCChatUnattended.create({
        document, window, translate: t,
        getSessionId: () => '',
        request: async () => ({ ok: true, unattended: null }),
        applyInputLock: locked => window.__locks.push(locked),
      });
      window.__card = MultiCCChatUserInputCard.createController({
        document, translate: t,
        isConnected: () => true,
        submitAnswer: () => true,
      });
    </script>
  </body></html>`,
};

test('applyState locks/unlocks immediately and a pending question card is disabled', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/unattended-fixture.html');
    assert.ok(await page.waitFor(`window.__u && window.__card`));
    assert.equal(await page.evaluate(`document.getElementById('unattended-banner').hidden`), true);

    await page.evaluate(`window.__u.applyState({
      status: 'active', rounds: 2, maxRounds: 5, evaluating: true, pausedBy: null, goal: 'x',
    })`);
    assert.deepEqual(await page.evaluate(`window.__locks`), [true]);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-text').textContent === t('unattendedBannerActive', { round: 2, max: 5 })`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner .unat-spinner').hidden`), false);
    assert.equal(await page.evaluate(`document.getElementById('unattended-fab').classList.contains('unat-evaluating')`), true);

    // 同一帧的 pausedBy 显示在面板状态块。
    await page.evaluate(`window.__u.applyState({ status: 'stopped', pausedBy: 'input', goal: 'x' })`);
    assert.deepEqual(await page.evaluate(`window.__locks`), [true, false], '非 active 帧立刻解锁');
    assert.equal(await page.evaluate(`document.querySelector('.unat-banner-reason').textContent === t('unattendedPausedByInput')`), true);
    assert.equal(await page.evaluate(`document.querySelector('.unat-paused').textContent === t('unattendedPausedByInput')`), true);

    // active 帧再次上锁，而且只在布尔真的翻转时通知宿主。
    await page.evaluate(`window.__u.applyState({ status: 'active', rounds: 2, maxRounds: 5, evaluating: false, pausedBy: null, goal: 'x' })`);
    await page.evaluate(`window.__u.applyState({ status: 'active', rounds: 3, maxRounds: 5, evaluating: false, pausedBy: null, goal: 'x' })`);
    assert.deepEqual(await page.evaluate(`window.__locks`), [true, false, true]);

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
