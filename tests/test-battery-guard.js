'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBatteryGuardRuntime } = require('../src/battery-guard');
const { parseBatteryStatus } = require('../plugins/utils/macos-power');

function fakeMacosPower(overrides = {}) {
  const calls = { sleepNow: 0 };
  const state = {
    battery: { available: true, source: 'battery', percent: 80 },
    lid: { available: true, enabled: false },
    sleepResult: { ok: true, method: 'pmset' },
  };
  return {
    calls,
    state,
    async readBattery() { return { ...state.battery }; },
    async getLidSleepPrevention() { return { ...state.lid }; },
    async sleepNow() { calls.sleepNow += 1; return { ...state.sleepResult }; },
    ...overrides,
  };
}

test('parseBatteryStatus reads pmset -g batt output', () => {
  assert.deepStrictEqual(parseBatteryStatus(`
Now drawing from 'AC Power'
 -InternalBattery-0 (id=51652173)\t100%; charged; 0:00 remaining present: true
`), { source: 'ac', percent: 100 });

  assert.deepStrictEqual(parseBatteryStatus(`
Now drawing from 'Battery Power'
 -InternalBattery-0 (id=51652173)\t4%; discharging; 0:12 remaining present: true
`), { source: 'battery', percent: 4 });

  assert.deepStrictEqual(parseBatteryStatus('no battery output'), { source: null, percent: null });
});

test('battery guard requires macosPower service methods', () => {
  assert.throws(() => createBatteryGuardRuntime({}), /dependency missing/);
  assert.throws(
    () => createBatteryGuardRuntime({ macosPower: { readBattery() {} } }),
    /macosPower\.getLidSleepPrevention/,
  );
});

test('battery guard requires rearm above trigger', () => {
  assert.throws(
    () => createBatteryGuardRuntime({ macosPower: fakeMacosPower(), thresholds: { trigger: 8, rearm: 5 } }),
    /rearm > trigger/,
  );
});

test('battery guard stays idle while sleep prevention is off', async () => {
  const power = fakeMacosPower();
  const guard = createBatteryGuardRuntime({ macosPower: power });
  power.state.battery.percent = 3;
  const status = await guard.check();
  assert.equal(status.sleepPrevention, false);
  assert.equal(status.latched, false);
  assert.equal(power.calls.sleepNow, 0);
});

test('battery guard triggers at threshold on battery with sleep prevention on', async () => {
  const power = fakeMacosPower();
  const guard = createBatteryGuardRuntime({ macosPower: power });
  power.state.lid.enabled = true;
  power.state.battery.percent = 5;
  let status = await guard.check();
  assert.equal(status.latched, true);
  assert.equal(status.triggerCount, 1);
  assert.equal(power.calls.sleepNow, 1);
  assert.equal(status.lastSleepResult.method, 'pmset');

  // 闩锁：电量仍低也不再重复触发。
  status = await guard.check();
  assert.equal(status.triggerCount, 1);
  assert.equal(power.calls.sleepNow, 1);

  // 回升到 rearm 以下、trigger 以上：不触发，也还不复位。
  power.state.battery.percent = 6;
  status = await guard.check();
  assert.equal(status.latched, true);
  assert.equal(power.calls.sleepNow, 1);

  // 回升到 rearm：复位，可重新武装（但 6% > 5% 不触发）。
  power.state.battery.percent = 8;
  status = await guard.check();
  assert.equal(status.latched, false);
  assert.equal(power.calls.sleepNow, 1);

  // 再次跌破：触发第二次。
  power.state.battery.percent = 4;
  status = await guard.check();
  assert.equal(status.triggerCount, 2);
  assert.equal(power.calls.sleepNow, 2);
});

test('battery guard unlatches on AC power even below rearm', async () => {
  const power = fakeMacosPower();
  const guard = createBatteryGuardRuntime({ macosPower: power });
  power.state.lid.enabled = true;
  power.state.battery.percent = 3;
  await guard.check();
  assert.equal(power.calls.sleepNow, 1);

  power.state.battery.source = 'ac';
  power.state.battery.percent = 4;
  let status = await guard.check();
  assert.equal(status.latched, false);
  // 插电状态下即使电量低也不触发。
  status = await guard.check();
  assert.equal(power.calls.sleepNow, 1);
});

test('battery guard does not sleep on AC even at low percent', async () => {
  const power = fakeMacosPower();
  const guard = createBatteryGuardRuntime({ macosPower: power });
  power.state.lid.enabled = true;
  power.state.battery.source = 'ac';
  power.state.battery.percent = 2;
  const status = await guard.check();
  assert.equal(power.calls.sleepNow, 0);
  assert.equal(status.latched, false);
});

test('battery guard records failed sleep attempts and keeps polling', async () => {
  const power = fakeMacosPower();
  const guard = createBatteryGuardRuntime({ macosPower: power });
  power.state.lid.enabled = true;
  power.state.battery.percent = 4;
  power.state.sleepResult = { ok: false, errors: ['pmset: not root'] };
  const status = await guard.check();
  assert.equal(status.latched, true);
  assert.equal(status.lastSleepResult.ok, false);
  // 闩锁仍然生效：失败不重试轰炸。
  await guard.check();
  assert.equal(power.calls.sleepNow, 1);
});

test('battery guard survives battery read errors', async () => {
  const power = fakeMacosPower();
  let fail = true;
  const guard = createBatteryGuardRuntime({
    macosPower: {
      ...power,
      async readBattery() { if (fail) throw new Error('pmset timeout'); return power.readBattery(); },
    },
  });
  power.state.lid.enabled = true;
  power.state.battery.percent = 3;
  let status = await guard.check();
  assert.match(status.error, /pmset timeout/);
  assert.equal(power.calls.sleepNow, 0);
  fail = false;
  status = await guard.check();
  assert.equal(status.error, null);
  assert.equal(power.calls.sleepNow, 1);
});

test('battery guard start/stop drives the interval', async () => {
  const power = fakeMacosPower();
  const timers = [];
  const guard = createBatteryGuardRuntime({
    macosPower: power,
    intervalMs: 1000,
    setIntervalFn: fn => { timers.push(fn); return timers.length; },
    clearIntervalFn: () => { timers.pop(); },
  });
  guard.start();
  assert.equal(timers.length, 1);
  assert.equal(guard.getStatus().running, true);
  guard.stop();
  assert.equal(timers.length, 0);
  assert.equal(guard.getStatus().running, false);
});
