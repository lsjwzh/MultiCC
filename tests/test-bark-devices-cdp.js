'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('phone setup adds without replacement, tests only selected phone, and shows failure honestly', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const root = path.resolve(__dirname, '../public');
  const routes = {};
  for (const file of ['air-bark-devices.js', 'i18n-catalog.js']) {
    routes['/' + file] = { body: fs.readFileSync(path.join(root, file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/'] = { headers: { 'content-type': 'text/html' }, body: `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px/1.65 system-ui;margin:20px;max-width:760px;color:#243242}input{box-sizing:border-box;display:block;width:100%;padding:12px;margin:8px 0}button{padding:10px;margin:4px}.air-push-actions{display:flex;flex-wrap:wrap}summary{cursor:pointer}p{overflow-wrap:anywhere}.error{color:#b33}</style><main id="phones"></main><script src="/i18n-catalog.js"></script><script src="/air-bark-devices.js"></script><script>
  window.devices = [{id:'old',name:'原有手机',enabled:true}]; window.calls=[]; window.failTest=false;
  window.confirm=()=>true;
  const t=k=>MULTICC_I18N_CATALOG.zh[k]||k;
  const api=async (url,body)=>{
    calls.push(body);
    if(body.action==='add') { devices.push({id:'new',name:body.name,enabled:true}); return {id:'new',devices}; }
    if(body.action==='test') {if(failTest)throw Error('bark_test_failed');return {ok:true};}
    if(body.action==='update') devices=devices.map(d=>d.id===body.id?{...d,...body}:d);
    if(body.action==='remove') devices=devices.filter(d=>d.id!==body.id);
    return {devices};
  };
  MultiCCBarkDevices.render(document.getElementById('phones'),{api,t,devices});
  </script></html>` };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-bark-setup-qa') }, async page => {
    await page.navigate('/');
    assert.ok(await page.waitFor(`document.querySelector('[data-device-id="old"]') !== null`));
    await page.evaluate(`document.querySelector('summary').click();document.getElementById('bark-device-name').value='我的 iPhone';document.getElementById('bark-device-address').value='https://api.day.app/FIXTURE';[...document.querySelectorAll('button')].find(b=>b.textContent==='添加并测试').click()`);
    assert.ok(await page.waitFor(`document.getElementById('bark-device-status').textContent.includes('Bark 已接受')`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-bark-phone').length`), 2);
    assert.equal(await page.evaluate(`document.getElementById('bark-device-address').value`), '');
    assert.deepEqual(await page.evaluate(`calls.map(c=>[c.action,c.id||''])`), [['add',''], ['test','new']]);
    await page.evaluate(`document.querySelector('[data-device-id="old"] button:nth-child(2)').click()`);
    assert.ok(await page.waitFor(`document.querySelector('[data-device-id="old"]').textContent.includes('已暂停')`));
    await page.evaluate(`failTest=true;document.querySelector('[data-device-id="new"] button').click()`);
    assert.ok(await page.waitFor(`document.getElementById('bark-device-status').textContent.includes('测试未成功')`));
    await page.evaluate(`document.querySelector('[data-device-id="old"] button:last-child').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-bark-phone').length===1`));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.evaluate(`document.querySelector('details').open=true`);
    assert.ok(await page.evaluate(`document.documentElement.scrollWidth<=390`));
    await page.screenshot('bark-setup-mobile');
  });
});
