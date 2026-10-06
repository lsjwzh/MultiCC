'use strict';

// 主机电量：pmset 解析、缓存/并发合并、路由、Web 侧栏接线。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parsePmset, createBatteryReader } = require('../src/host-battery');
const { createBatteryHandler } = require('../src/routes/host-read');

const BATT = `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=6488163)\t7%; discharging; 0:21 remaining present: true\n\tBattery Warning: Early\n`;
const CHARGING = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t83%; charging; 0:40 remaining present: true\n`;
const DESKTOP = `Now drawing from 'AC Power'\n`;

(async () => {
  assert.deepStrictEqual(parsePmset(BATT), { available: true, percent: 7, charging: false, pluggedIn: false, remainingMinutes: 21 });
  const c = parsePmset(CHARGING);
  assert.strictEqual(c.charging, true);
  assert.strictEqual(c.pluggedIn, true);
  assert.deepStrictEqual(parsePmset(DESKTOP), { available: false }, '台式机没有电池行，是「没有」不是错误');
  assert.deepStrictEqual(parsePmset(' -InternalBattery-0 (id=1)\t(no estimate) present: true'), { available: false });

  // 5 秒内多端同时问只探一次；过期后重探；探测失败降级为 unavailable 而不是抛。
  let calls = 0; let clock = 1000; let out = BATT;
  const read = createBatteryReader({ platform: 'darwin', now: () => clock, run: async () => { calls += 1; return out; } });
  const [a, b] = await Promise.all([read(), read()]);
  assert.strictEqual(a.percent, 7); assert.strictEqual(b.percent, 7); assert.strictEqual(calls, 1);
  clock += 1000; await read(); assert.strictEqual(calls, 1);
  clock += 5000; out = CHARGING; assert.strictEqual((await read()).percent, 83); assert.strictEqual(calls, 2);
  const broken = createBatteryReader({ platform: 'darwin', run: async () => { throw new Error('boom'); } });
  assert.deepStrictEqual(await broken(), { available: false });
  assert.deepStrictEqual(await createBatteryReader({ platform: 'win32' })(), { available: false });

  const linux = createBatteryReader({ platform: 'linux', readFile: async file => (file.endsWith('capacity') ? '64\n' : 'Discharging\n') });
  assert.deepStrictEqual(await linux(), { available: true, percent: 64, charging: false, pluggedIn: false, remainingMinutes: null });

  // 路由：把读数原样回给客户端；异常交给 next。
  let body = null;
  await createBatteryHandler({ readBattery: async () => ({ available: true, percent: 7 }) })({}, { json: v => { body = v; } }, assert.ifError);
  assert.deepStrictEqual(body, { available: true, percent: 7 });
  let err = null;
  await createBatteryHandler({ readBattery: async () => { throw new Error('x'); } })({}, {}, e => { err = e; });
  assert.ok(err);

  // Web：模块在 air.html 里加载，且电量行在 .side-bottom 内；低电量/充电/不可用三态。
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'air.html'), 'utf8');
  assert.ok(html.includes('<script src="air-battery.js"></script>'));
  const bottom = html.slice(html.indexOf('class="side-bottom"'), html.indexOf('</aside>'));
  assert.ok(bottom.includes('id="air-battery"'), '电量行必须在侧栏底部 .side-bottom 里');
  const nodes = {};
  const mk = id => (nodes[id] = { id, hidden: true, textContent: '', title: '', classList: { toggle(n, on) { (this.set ||= new Set())[on ? 'add' : 'delete'](n); } } });
  ['air-battery', 'air-battery-icon', 'air-battery-text'].forEach(mk);
  const win = { document: { getElementById: id => nodes[id] }, fetch: async () => ({ ok: true, json: async () => ({ available: false }) }), setInterval: () => 0 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'air-battery.js'), 'utf8'), { window: win, globalThis: win });
  const mod = win.MultiCCAirBattery;
  mod.paint({ available: true, percent: 7, charging: false });
  assert.strictEqual(nodes['air-battery'].hidden, false);
  assert.strictEqual(nodes['air-battery-text'].textContent, '7%');
  assert.strictEqual(nodes['air-battery-icon'].textContent, '🪫');
  assert.ok(nodes['air-battery'].classList.set.has('low'));
  mod.paint({ available: true, percent: 7, charging: true });
  assert.strictEqual(nodes['air-battery-icon'].textContent, '⚡');
  assert.ok(!nodes['air-battery'].classList.set.has('low'), '充电中不算低电量');
  mod.paint({ available: false });
  assert.strictEqual(nodes['air-battery'].hidden, true);
  console.log('host battery: ok');
})().catch(error => { console.error(error); process.exit(1); });
