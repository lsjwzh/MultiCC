'use strict';

// 终端页（public/index.html + public/client.js）—— 真浏览器里跑。
//
// 这个页面此前一个测试都没有：它不在 Air 壳里，靠一条 WebSocket 活着，而 CDP 夹具
// 起的是静态 HTTP 服务（没有 WS 升级）。所以这一份不测「连上来以后」的链路，测的是
// 页面自己那层能力：查找、字号、快捷键，以及服务端消息怎么落到 xterm 上。
// 页面为此暴露了 window.MultiCCTerminal（和 Air 侧 window.MultiCCAirXxx 同一个办法）
// —— 测试直接调它喂消息，不必先起一个真 socket。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 夹具起的是静态站点（没有 WS 升级）：把 public/ 下真的那些文件按路径挂上去，
 *  终端页 = index.html，所以 `/` 也指向它。 */
function servePublicDir(routes = {}) {
  const publicDir = path.resolve(__dirname, '../public');
  const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml' };
  const serve = (rel, file) => {
    const type = types[file.slice(file.lastIndexOf('.') + 1)] || 'application/octet-stream';
    routes[rel] = { body: fs.readFileSync(file), headers: { 'content-type': `${type}; charset=utf-8` } };
  };
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html|svg)$/.test(name))) serve('/' + file, path.join(publicDir, file));
  const vendorDir = path.join(publicDir, 'vendor');
  for (const dir of fs.readdirSync(vendorDir)) {
    const full = path.join(vendorDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full).filter(name => /\.(js|css)$/.test(name))) serve(`/vendor/${dir}/${file}`, path.join(full, file));
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) serve('/shared/' + file, path.join(publicDir, 'shared', file));
  routes['/'] = routes['/index.html'];
  return routes;
}

// 页面自己不许有未捕获异常：每个用例都挂着这条，最后断言它是空的。
const ERROR_TRAP = `addEventListener('error',e=>(window.__errors||=[]).push(String(e.message)));`
  + `addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason&&e.reason.message||e.reason)))`;

test('终端页：查找、字号缩放、快捷键与服务端消息落地', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = servePublicDir();
  routes['/api/sessions/s1'] = () => json({ id: 's1', dirId: 'd1', cli: 'claude', kind: 'terminal', label: 'Multicc Test Terminal', cwd: '/projects/multicc' });
  routes['/api/sessions'] = () => json([{ id: 's1', dirId: 'd1', cli: 'claude', kind: 'terminal', label: 'Multicc Test Terminal' }]);
  routes['/api/directories'] = () => json([{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }]);
  routes['/api/settings/voice'] = () => json({ ok: true, enabled: false });
  routes['/api/auth/ws-ticket'] = () => json({ ok: true, ticket: 'fixture' });

  const screenshots = [];
  const screenshotDir = path.join(os.tmpdir(), 'multicc-terminal-page');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_TRAP });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/?id=s1');
    assert.ok(await page.waitFor(`!!window.MultiCCTerminal?.terminal`), '终端页要暴露 MultiCCTerminal');

    // ── 服务端消息 → xterm ────────────────────────────────────────────────
    await page.evaluate(`window.MultiCCTerminal.applyServerMessage({ type: 'output', data: 'alpha one\\r\\nbeta two\\r\\nalpha three\\r\\n' })`);
    // 页面把 output 批到 rAF 里再写（避免刷屏），所以要等内容真的落到 buffer，不能只等行数
    // —— 空 buffer 的行数本来就有 rows 那么多。
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)==='alpha one'`),
      '第一行就是服务端发来的内容：' + await page.evaluate(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)`),
    );

    // ── 查找：开关、命中计数、上下一个、区分大小写、Esc 关闭 ───────────────
    assert.equal(await page.evaluate(`window.MultiCCTerminal.findVisible()`), false, '查找条默认收起');
    // ⌘F / Ctrl+F 走的是页面自己拦的那条路（xterm 不该把 F 发给 PTY）。
    await page.evaluate(`window.MultiCCTerminal.terminal.focus()`);
    const metaKey = await page.evaluate(`window.MultiCCTerminal.isMac`) ? 4 : 2;
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: metaKey, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findVisible()===true`), '⌘F 要开查找条');
    assert.equal(await page.evaluate(`document.activeElement.id`), 'find-input', '开完焦点在输入框');
    await page.evaluate(`(() => { const i = document.getElementById('find-input'); i.value = 'alpha'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='1/2'`), '命中计数要出来：' + await page.evaluate(`window.MultiCCTerminal.findCount()`));
    screenshots.push(await page.screenshot('terminal-find-bar'));
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='2/2'`), 'Enter = 下一个：' + await page.evaluate(`window.MultiCCTerminal.findCount()`));
    await page.evaluate(`document.getElementById('find-prev').click()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='1/2'`), '↑ = 上一个');
    // 区分大小写：ALPHA 在大小写敏感下不该命中。
    await page.evaluate(`(() => { document.getElementById('find-case').click(); const i = document.getElementById('find-input'); i.value = 'ALPHA'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findCount()==='无匹配'`), '大小写敏感后 ALPHA 不该命中：' + await page.evaluate(`window.MultiCCTerminal.findCount()`));
    await page.evaluate(`document.getElementById('find-case').click(); document.getElementById('find-close').click()`);
    assert.ok(await page.waitFor(`window.MultiCCTerminal.findVisible()===false`), '✕ 关掉查找条');
    assert.equal(await page.evaluate(`window.MultiCCTerminal.findCount()`), '', '关掉要清掉计数');

    // ── 字号：按钮与 ⌘±，范围钳制，刷新后保持 ─────────────────────────────
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 14, '默认 14');
    await page.evaluate(`document.getElementById('font-up-btn').click()`);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 15);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.terminal.options.fontSize`), 15, '字号要真的落到 xterm 上');
    assert.equal(await page.evaluate(`localStorage.getItem(window.MultiCCTerminal.constants.FONT_KEY)`), '15', '字号要记住');
    await page.evaluate(`window.MultiCCTerminal.setFontPx(999)`);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 24, '上限 24');
    await page.evaluate(`window.MultiCCTerminal.setFontPx(1)`);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.fontPx()`), 10, '下限 10');
    await page.evaluate(`window.MultiCCTerminal.setFontPx(14)`);

    // ── 快捷键：清屏（⌘K / Ctrl+K）不该把 K 发给 PTY ────────────────────
    // 量「第一行还是不是那句话」而不是 buffer 行数：xterm 清屏清的是回看缓冲，
    // 视口那几行（rows）还在，行数本来就不会变小。
    assert.equal(
      await page.evaluate(`window.MultiCCTerminal.terminal.buffer.active.getLine(0).translateToString(true)`),
      'alpha one',
    );
    await page.evaluate(`window.MultiCCTerminal.terminal.focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: metaKey, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)===''`),
      '⌘K 之后第一行要空掉',
    );

    // ── 快照：重连时服务端补的那一屏是「替换」不是「追加」 ──────────────────
    // 放在最后：它会把上面查找/清屏依赖的那几行 alpha 冲掉。
    const dumpScreen = () => page.evaluate(
      `(()=>{const b=window.MultiCCTerminal.terminal.buffer.active;let s='';`
      + `for(let i=0;i<b.length;i++)s+=b.getLine(i).translateToString(true)+'\\n';return s;})()`,
    );
    await page.evaluate(`window.MultiCCTerminal.applyServerMessage({ type: 'output', data: 'stale line\\r\\n' })`);
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)==='stale line'`),
      '重连前的内容先落到屏上',
    );
    await page.evaluate(`window.MultiCCTerminal.applyServerMessage({ type: 'snapshot', data: 'fresh screen\\r\\n' })`);
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)==='fresh screen'`),
      '快照要顶到第一行：' + await page.evaluate(`window.MultiCCTerminal.terminal.buffer.active.getLine(0)?.translateToString(true)`),
    );
    assert.ok(!(await dumpScreen()).includes('stale line'),
      '快照是替换：刷新一次不该在屏上多留一份旧内容');

    assert.deepEqual(await page.evaluate(`window.__errors||[]`), [], '页面上不该有未捕获异常');
  });
  if (screenshots.length) console.log('screenshots:', screenshots.join(' '));
});

test('终端页信息条：cwd / worktree / 分支 / provider·model，与同目录终端切换', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = servePublicDir();
  const WORKTREE_CWD = '/projects/multicc/.multicc-worktrees/task-abc123';
  const mergeCalls = [];
  // 列表里混着四种**不该进切换器**的：aux（连 kind 都没有）、gateway、别的目录的终端、
  // 以及一条 chat。切换器只装「同目录的终端」，多装一条就会把人跳到别的上下文里去。
  routes['/api/sessions'] = () => json([
    { id: 'aux-1', type: 'aux', label: 'AI Assistant' },
    { id: 't1', dirId: 'd1', kind: 'terminal', cli: 'claude', label: '构建盒', cwd: WORKTREE_CWD,
      provider: 'anthropic', model: null, effectiveModel: 'claude-sonnet-4-5',
      createdAt: '2026-09-01T00:00:00.000Z', mergeState: { reason: 'loading' } },
    { id: 't2', dirId: 'd1', kind: 'terminal', cli: 'codex', label: '巡检', cwd: '/projects/multicc',
      createdAt: '2026-09-02T00:00:00.000Z', mergeState: { reason: 'no-worktree', mergeReady: false } },
    { id: 't3', dirId: 'd1', kind: 'terminal', type: 'gateway', cli: 'claude', label: '网关',
      createdAt: '2026-09-03T00:00:00.000Z' },
    { id: 't9', dirId: 'd2', kind: 'terminal', cli: 'claude', label: '别的目录',
      createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'c1', dirId: 'd1', kind: 'chat', cli: 'claude', label: '聊天',
      createdAt: '2026-09-01T00:00:00.000Z' },
  ]);
  // t1 缓存的那份 mergeState 只说了 reason:'loading'（还没算出来）—— 页面该补一次现算的，
  // 而且只补这一次（终端页长期挂着，不轮询）。t2/t9 都没有这条路由：多问一次就是 404。
  routes['/api/sessions/t1/merge-status'] = ({ url }) => {
    mergeCalls.push(url.search);
    return json({ mergeReady: false, dirty: true, ahead: 2, behind: 3, baseBranch: 'main',
      branch: 'multicc/task-abc123', baseCheckedOut: false, conflict: false });
  };
  routes['/api/directories'] = () => json([{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }]);
  routes['/api/settings/voice'] = () => json({ ok: true, enabled: false });
  routes['/api/auth/ws-ticket'] = () => json({ ok: true, ticket: 'fixture' });

  // 用户看见的就是这几颗芯片上的字；收起来的那颗读成 null（hidden 就是有话说不出）。
  const READ_BAR = `(() => {
    const read = id => { const el = document.getElementById(id); return el.hidden ? null : el.textContent; };
    return { cwd: read('term-info-cwd'), cwdWarn: document.getElementById('term-info-cwd').classList.contains('warn'),
      worktree: read('term-info-worktree'), worktreeWarn: document.getElementById('term-info-worktree').classList.contains('warn'),
      branch: read('term-info-branch'), model: read('term-info-model'),
      switcher: !document.getElementById('term-switch').hidden,
      pos: document.getElementById('term-switch-pos').textContent,
      prev: document.getElementById('term-prev').title, next: document.getElementById('term-next').title };
  })()`;

  const screenshots = [];
  const screenshotDir = path.join(os.tmpdir(), 'multicc-terminal-page');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_TRAP });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/?id=t1');
    assert.ok(await page.waitFor(`window.MultiCCTerminal?.infoBarVisible()===true`), '信息条要出来');

    // ── 事实本身 ───────────────────────────────────────────────────────────
    const ctx = await page.evaluate(`window.MultiCCTerminal.termContext()`);
    assert.equal(ctx.id, 't1');
    assert.equal(ctx.cwd, WORKTREE_CWD);
    assert.equal(ctx.worktree, 'task-abc123', 'worktree 名字从 cwd 里读出来');
    assert.equal(ctx.branch, 'multicc/task-abc123');
    assert.equal(ctx.baseBranch, 'main');
    assert.equal(ctx.behind, 3);
    assert.equal(ctx.ahead, 2);
    assert.equal(ctx.provider, 'anthropic');
    assert.equal(ctx.model, 'claude-sonnet-4-5', 'effectiveModel 优先于 model');
    assert.deepEqual(mergeCalls, ['?refresh=1'], '缓存那份只说了 loading，就补一次现算的（带 refresh=1）');

    // ── 芯片上的字 ─────────────────────────────────────────────────────────
    const bar = await page.evaluate(READ_BAR);
    assert.equal(bar.cwd, WORKTREE_CWD);
    assert.equal(bar.cwdWarn, false);
    assert.equal(bar.worktree, 'worktree task-abc123');
    assert.equal(bar.branch, '⎇ multicc/task-abc123 ↓3 ↑2', '落后/领先要写出来，不然光一个分支名没法判断该不该同步');
    assert.equal(bar.model, 'anthropic · claude-sonnet-4-5');
    assert.equal(bar.switcher, true);
    assert.equal(bar.pos, '1/2');
    assert.ok(bar.next.includes('巡检'), '下一颗的 title 要说清去哪一条：' + bar.next);
    assert.ok(bar.prev.includes('巡检'), '就两条，往回也是它：' + bar.prev);
    screenshots.push(await page.screenshot('terminal-info-bar'));

    // 切换器只装同目录的终端，顺序按创建时间（不是列表顺序），这样 ‹ › 走位是可预期的。
    assert.deepEqual(await page.evaluate(`window.MultiCCTerminal.siblingIds()`), ['t1', 't2']);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.siblingIndex()`), 0);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.siblingTarget(1)`), 't2');
    assert.equal(await page.evaluate(`window.MultiCCTerminal.siblingTarget(-1)`), 't2', '就两条：往回走也是它（环形）');

    // ── 点下一颗 = 真的换页（和 Air 目录里那行链接同一条路：/?id=<sibling>） ──
    await page.evaluate(`document.getElementById('term-next').click()`);
    assert.ok(
      await page.waitFor(`location.search === '?id=t2' && window.MultiCCTerminal?.termContext()?.id === 't2'`),
      '点下一颗要跳到同目录的另一条终端：' + await page.evaluate(`location.search`),
    );
    const second = await page.evaluate(READ_BAR);
    assert.equal(second.cwd, '/projects/multicc');
    assert.equal(second.worktree, '无 worktree', 't2 的 mergeState 说的就是它没有 worktree —— 照实说');
    assert.equal(second.worktreeWarn, true);
    assert.equal(second.branch, null, '没有分支可说就把那颗芯片收起来，不编一个');
    assert.equal(second.model, null, '没有 provider/model 也一样收起来');
    assert.equal(second.pos, '2/2');
    assert.equal(await page.evaluate(`window.MultiCCTerminal.siblingTarget(1)`), 't1', '在 t2 上再往前走就回到 t1');
    assert.deepEqual(mergeCalls, ['?refresh=1'], 't2 缓存那份已经说清了（no-worktree），不该再多问一次');

    // ── relocate 帧：cwd 立刻换，旧目录的分支不跟着走 ──────────────────────
    // 读芯片和喂帧放在同一次 evaluate 里：重连后 800ms 那次整份刷新会把 t2 的事实
    // 刷回来，分开读就是在和定时器赛跑。
    const relocated = await page.evaluate(`(() => {
      window.MultiCCTerminal.applyServerMessage({ type: 'relocate', cwd: '/projects/other/.multicc-worktrees/task-xyz' });
      const chip = id => { const el = document.getElementById(id); return el.hidden ? null : el.textContent; };
      return { cwd: chip('term-info-cwd'), worktree: chip('term-info-worktree'), branch: chip('term-info-branch'),
        switcher: !document.getElementById('term-switch').hidden, siblings: window.MultiCCTerminal.siblingIds() };
    })()`);
    assert.equal(relocated.cwd, '/projects/other/.multicc-worktrees/task-xyz', 'relocate 帧一到，cwd 立刻换成帧里带的');
    assert.equal(relocated.worktree, 'worktree task-xyz', 'worktree 名字跟着新路径重读');
    assert.equal(relocated.branch, null, '旧目录的分支是旧目录的事实，不跟着走');
    assert.equal(relocated.switcher, false, '同目录切换器也是旧目录的事实：搬走后 ‹/› 不能再跳进旧目录的终端');
    assert.deepEqual(relocated.siblings, ['t2']);
    assert.ok(
      await page.waitFor(`window.MultiCCTerminal.termContext()?.cwd === '/projects/multicc'`),
      '重连后整份刷新要把 t2 的真 cwd 刷回来',
    );

    // ── 只有一条终端的目录 + 服务端什么都没给：信息条照旧，切换器不出现 ──────
    // t9 连 cwd 和 mergeState 都没有，而 merge-status 那条路由夹具也没挂（404）：
    // 信息条不该因此空掉、更不该抛异常 —— 拿不到就不说，但要说出「不知道」。
    await page.navigate('/?id=t9');
    assert.ok(await page.waitFor(`window.MultiCCTerminal?.termContext()?.id === 't9'`), '信息条要为 t9 刷新');
    const third = await page.evaluate(READ_BAR);
    assert.equal(third.switcher, false, '只有一条终端：切换器不出现（切不出去的按钮是噪音）');
    assert.equal(third.cwd, '未知目录', 'cwd 拿不到就说不知道，不留一片空白');
    assert.equal(third.cwdWarn, true);
    assert.equal(third.branch, null);
    assert.deepEqual(await page.evaluate(`window.MultiCCTerminal.siblingIds()`), ['t9']);
    assert.equal(await page.evaluate(`window.MultiCCTerminal.siblingTarget(1)`), null);
    assert.deepEqual(mergeCalls, ['?refresh=1'], 't9 问了一次现算的（404）也该只有一次：不重试、不轮询');

    assert.deepEqual(await page.evaluate(`window.__errors||[]`), [], '页面上不该有未捕获异常');
  });
  if (screenshots.length) console.log('screenshots:', screenshots.join(' '));
});
