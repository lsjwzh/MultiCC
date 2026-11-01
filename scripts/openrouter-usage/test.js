'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { capture, readChart } = require('./browser-source');
const { repairSources } = require('./apply-fix');

function simulate(stages) {
  let elapsed = 0;
  const calls = [];
  const browser = async args => {
    calls.push(args);
    if (args[0] === 'open') return { targetId: 'owned-tab', newTab: true };
    if (args[0] === 'close') return {};
    const stage = stages.filter(stage => stage.at <= elapsed).at(-1);
    const page = {
      App: { data: { 'c:148532': { info: {}, series: [stage.points.map((value, i) => ['2026-10-' + (28 + i), value])] } } },
      URL, location: { href: 'https://en.macromicro.me/charts/148532/test', origin: 'https://en.macromicro.me' },
      performance: { getEntriesByType: () => stage.completed ? [{
        name: stage.url || 'https://en.macromicro.me/charts/data/148532', responseEnd: 100,
      }] : [] },
    };
    return { value: vm.runInNewContext(args[1], page) };
  };
  const options = { now: () => elapsed, pause: async ms => { elapsed += ms; } };
  return { browser, options, calls };
}

test('waits past the initial preview for stable native history and closes only its own tab', async () => {
  const fixture = simulate([
    { at: 0, points: [30, 31], completed: false },
    { at: 1500, points: [28, 29, 30, 31], completed: true },
  ]);
  const result = JSON.parse(await capture(fixture.browser, fixture.options));
  assert.equal(result.historyCoverage, 'history');
  assert.equal(result.data['c:148532'].series[0].length, 4);
  assert.ok(fixture.calls[0].includes('--new-tab'));
  assert.deepEqual(fixture.calls.at(-1), ['close', 'owned-tab']);
});

test('labels a completed preview without disabling daily incremental updates', async () => {
  const fixture = simulate([{ at: 0, points: [30, 31], completed: true }]);
  const result = JSON.parse(await capture(fixture.browser, fixture.options));
  assert.equal(result.historyCoverage, 'latest-two');
  assert.equal(result.data['c:148532'].series[0].length, 2);
});

test('an unrelated request cannot satisfy readiness; timeout still closes the owned tab', async () => {
  const fixture = simulate([{
    at: 0, points: [28, 29, 30, 31], completed: true,
    url: 'https://en.macromicro.me/charts/data/999',
  }]);
  await assert.rejects(capture(fixture.browser, fixture.options), /超时/);
  assert.deepEqual(fixture.calls.at(-1), ['close', 'owned-tab']);
});

test('does not accept preview data before the native request completes', () => {
  const value = vm.runInNewContext('(' + readChart.toString() + ')()', {
    App: { data: { 'c:148532': { series: [[1, 2]] } } },
    performance: { getEntriesByType: () => [] },
  });
  assert.equal(value, null);
});

test('never closes an existing tab if the browser fails to create an owned source tab', async () => {
  const calls = [];
  await assert.rejects(capture(async args => {
    calls.push(args);
    return { targetId: 'user-tab', newTab: false };
  }), /没有创建独立/);
  assert.equal(calls.length, 1);
});

test('survives the new tab navigating between open and the first read', async () => {
  const fixture = simulate([{ at: 0, points: [28, 29, 30, 31], completed: true }]);
  let firstRead = true;
  const result = await capture(async args => {
    if (args[0] === 'eval' && firstRead) {
      firstRead = false;
      throw new Error('Execution context was destroyed because of a navigation');
    }
    return fixture.browser(args);
  }, fixture.options);
  assert.equal(JSON.parse(result).historyCoverage, 'history');
  assert.deepEqual(fixture.calls.at(-1), ['close', 'owned-tab']);
});

test('repair forces manual fetches and displays upstream coverage without treating provider lag as a failed save', () => {
  const sources = {
    fetch: "const pid = findMainChrome();\n" +
      "execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, 'chrome-page.jxa.js'), pid, 'refresh'],\n" +
      '// 主 Chrome 页面取数失败或超时，请检查目标图表页面与浏览器脚本权限\n' +
      "const result = JSON.parse(raw);\nif (!status.ok) throw new Error('接口已读取，但数据日期检查未通过：' + status.problems.join('；'));",
    index: '从 MacroMicro 重新抓取最新数据（6 小时内重复点击会直接用缓存）\n' +
      "fetch('refresh', { method: 'POST' })\n" +
      "if (!j.ok) throw new Error((j.log || []).join(' ') || '抓取失败');\n" +
      '  // Top8 按最新值排序；其余归并为「其他」\n' +
      "' 以下仍展示上次成功抓取的数据，请检查每日刷新任务。';",
  };
  const repaired = repairSources(sources);
  assert.match(repaired.index, /refresh\?force=1/);
  assert.match(repaired.index, /sessionStorage\.getItem\('openrouterRefreshNotice'\)/);
  const reporting = repaired.fetch.slice(repaired.fetch.indexOf('const result = JSON.parse(raw);'));
  const warnings = [];
  vm.runInNewContext(reporting, { raw: '{"historyCoverage":"latest-two"}', status: { ok: false, problems: ['provider lag'] },
    console: { warn: message => warnings.push(message) } });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /无法自动回补历史缺口/);
  assert.match(warnings[1], /provider lag/);
  assert.deepEqual(repairSources(repaired), repaired);
  assert.throws(() => repairSources({ ...sources, fetch: 'unsupported version' }), /Unsupported service version/);
});
