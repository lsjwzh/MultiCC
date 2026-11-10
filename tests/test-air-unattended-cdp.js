'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// Air 新建任务的无人值守字段（public/air-unattended.js）：
// 开关显隐、collect 的缺省/裁剪/夹取规则、AI 补全判断标准、reset。
// 页面用一个最小 fixture（真 air.html 的整页启动链太长，而这里的每条断言都只
// 关心这个模块自己的契约）；air.js 的接线（把 unattended 放进第一条消息体）
// 由 test-air-task-first-cdp.js 覆盖。
const publicDir = path.resolve(__dirname, '../public');
const routes = {};
for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css)$/.test(f))) {
  routes['/' + file] = {
    body: fs.readFileSync(path.join(publicDir, file)),
    headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' },
  };
}
routes['/fixture.html'] = {
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <textarea id="quick-task-input"></textarea>
    <label><input id="quick-task-unattended" type="checkbox"></label>
    <div id="quick-unattended" hidden>
      <label><span></span><textarea id="quick-unattended-goal"></textarea></label>
      <label><span></span><textarea id="quick-unattended-criteria"></textarea></label>
      <div>
        <label><input id="quick-unattended-duration" type="number" value="2" min="1" step="1">
          <select id="quick-unattended-duration-unit">
            <option value="h" selected>小时</option>
            <option value="m">分钟</option>
          </select></label>
        <button id="quick-unattended-draft" type="button"></button>
      </div>
      <p id="quick-unattended-status"></p>
    </div>
    <script src="/i18n-catalog.js"></script>
    <script src="/i18n.js"></script>
    <script src="/air-unattended.js"></script>
    <script>
      window.MultiCCAirUnattended.bind({
        document, t,
        request: (url, body) => fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }).then(response => response.json()),
      });
      window.__collect = text => window.MultiCCAirUnattended.collect(text);
    </script>
  </body></html>`,
};
const prechecks = [];
routes['POST /api/goal/precheck'] = ({ body }) => {
  prechecks.push(JSON.parse(body));
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, verdict: 'ok', score: 88, issues: [], criteria: ['构建通过', '测试通过'] }),
  };
};

const duration = async (page, value, unit) => page.evaluate(`(() => {
  const input = document.getElementById('quick-unattended-duration');
  input.value = ${JSON.stringify(String(value))};
  const select = document.getElementById('quick-unattended-duration-unit');
  select.value = ${JSON.stringify(unit)};
})()`);

test('air unattended fields collect a safe payload and draft criteria via precheck', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes }, async page => {
    await page.navigate('/fixture.html');
    assert.ok(await page.waitFor(`window.MultiCCAirUnattended && document.getElementById('quick-unattended')`));
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended').hidden`), true);
    assert.equal(await page.evaluate(`window.__collect('任务正文')`), null, '开关关着不产生 unattended');
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-duration').value`), '2');
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-duration-unit').value`), 'h');
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-rounds') === null`), true, '轮次输入已退场');

    await page.evaluate(`(() => { const t = document.getElementById('quick-task-unattended'); t.checked = true; t.dispatchEvent(new Event('change')); })()`);
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended').hidden`), false);
    assert.deepEqual(await page.evaluate(`window.__collect('任务正文')`),
      { goal: '任务正文', maxDurationMinutes: 120 }, '目标留空时用任务正文，标准为空就不传；默认 2 小时');

    await page.evaluate(`(() => {
      document.getElementById('quick-unattended-goal').value = '  把上线走完  ';
      document.getElementById('quick-unattended-criteria').value = '  构建通过\\n\\n测试通过  \\n验收截图 ';
    })()`);
    // 分钟单位：45 分钟原样带出；1 分钟夹到下限 5；999 小时夹到上限 1440。
    await duration(page, 45, 'm');
    assert.deepEqual(await page.evaluate(`window.__collect('任务正文')`),
      { goal: '把上线走完', criteria: ['构建通过', '测试通过', '验收截图'], maxDurationMinutes: 45 },
      '标准逐行 trim、去空行，分钟单位按分钟带出');
    await duration(page, 1, 'm');
    assert.equal((await page.evaluate(`window.__collect('任务正文')`)).maxDurationMinutes, 5, '下限 5 分钟');
    await duration(page, 999, 'h');
    assert.equal((await page.evaluate(`window.__collect('任务正文')`)).maxDurationMinutes, 1440, '上限 24 小时');
    await duration(page, 6, 'h');
    assert.equal((await page.evaluate(`window.__collect('任务正文')`)).maxDurationMinutes, 360);

    // 先清空标准，否则 includes('构建通过') 会被上面的旧内容满足，测不出补全。
    await page.evaluate(`document.getElementById('quick-unattended-criteria').value = ''`);
    await page.evaluate(`document.getElementById('quick-unattended-draft').click()`);
    assert.ok(await page.waitFor(`document.getElementById('quick-unattended-criteria').value === '构建通过\\n测试通过'`));
    assert.deepEqual(prechecks, [{ task: '把上线走完' }]);
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-criteria').value`), '构建通过\n测试通过');
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-status').className.includes('ok')`), true);

    await page.evaluate(`window.MultiCCAirUnattended.reset()`);
    assert.equal(await page.evaluate(`document.getElementById('quick-task-unattended').checked`), false);
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended').hidden`), true);
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-goal').value`), '');
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-duration').value`), '2');
    assert.equal(await page.evaluate(`document.getElementById('quick-unattended-duration-unit').value`), 'h');
    assert.equal(await page.evaluate(`window.__collect('任务正文')`), null);
  });
});
