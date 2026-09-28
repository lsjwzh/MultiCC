'use strict';
// 回归守卫：合盖熄屏 / 开盖点亮。
// 背景：SleepDisabled=1（「关盖运行」）掐掉「合盖 → 睡」之后，macOS 不会顺手关内屏 ——
// 盖合着屏还亮着，白烧整块屏。守卫只做两件事（合盖熄屏、开盖唤醒），但有两处很容易
// 改坏：① 决策必须只在**变化**时发一次，否则外接显示器合盖当主机用时会被每 5 秒熄一次；
// ② 屏亮状态只能信 powerd 的断言，AppleARMBacklight 的亮度值熄屏前后一个字节都不变。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createLidDisplayGuard, decide, intervalFor, clamshellClosed, displayOn,
} = require('../src/lid-display-guard');

const CLOSED = '"AppleClamshellState" = Yes\n';
const OPEN = '"AppleClamshellState" = No\n';
const DISPLAY_ON = 'Assertion status:\n   Prevent sleep while display is on\n';
const DISPLAY_OFF = 'Assertion status:\n   PreventUserIdleDisplaySleep 1\n';

// 注入 execFile：记录调用，答案由回调给（方便逐轮改状态，也方便造失败）。
function harness(answer) {
  const calls = [];
  const run = (file, args, options, cb) => {
    const line = [path.basename(file), ...args].join(' ');
    calls.push(line);
    const result = answer(line) || {};
    setImmediate(() => {
      if (result.error) cb(new Error(result.error), '', result.error);
      else cb(null, result.stdout || '', '');
    });
  };
  return {
    run,
    calls,
    count: (needle) => calls.filter((line) => line.includes(needle)).length,
  };
}

function guardWith(state, extra = {}) {
  const h = harness((line) => {
    if (line.startsWith('ioreg')) {
      if (state.lidError) return { error: 'ioreg failed' };
      return { stdout: state.closed ? CLOSED : OPEN };
    }
    if (line.includes('-g assertions')) {
      if (state.assertionsError) return { error: 'pmset failed' };
      return { stdout: state.displayOn ? DISPLAY_ON : DISPLAY_OFF };
    }
    if (line.includes('displaysleepnow')) {
      return state.sleepFails ? { error: 'not permitted' } : { stdout: '' };
    }
    return { stdout: '' };
  });
  const guard = createLidDisplayGuard({ platform: 'darwin', run: h.run, ...extra });
  return { guard, h };
}

test('决策表：合盖熄屏、开盖唤醒，其余不动', () => {
  assert.equal(decide(true, true, false), 'off', '合盖且屏亮 -> 熄');
  assert.equal(decide(true, false, false), 'none', '合盖但屏已灭 -> 不动');
  assert.equal(decide(true, true, true), 'off', '合盖期间被唤醒又亮起来 -> 再熄');
  assert.equal(decide(false, true, true), 'wake', '刚开盖 -> 补一次唤醒');
  assert.equal(decide(false, true, false), 'none', '开着盖、有人在用 -> 不动');
  assert.equal(decide(false, false, true), 'wake', '刚开盖但屏还没亮 -> 照样补唤醒');
  assert.equal(decide(false, false, false), 'none', '开着盖屏也灭着（用户自己熄的）-> 不动');
});

test('轮询两档：合盖快、开盖慢（合盖期间要秒级发现开盖）', () => {
  assert.equal(intervalFor(true), 5000);
  assert.equal(intervalFor(false), 60000);
  assert.equal(intervalFor(true, { closedMs: 1, openMs: 2 }), 1);
  assert.equal(intervalFor(false, { closedMs: 1, openMs: 2 }), 2);
});

test('解析：只看 AppleClamshellState 与 powerd 断言', () => {
  assert.equal(clamshellClosed(CLOSED), true);
  assert.equal(clamshellClosed(OPEN), false);
  assert.equal(clamshellClosed('"AppleClamshellState" = No\n'), false);
  assert.equal(displayOn(DISPLAY_ON), true);
  // 亮度值熄屏前后不变，绝不能拿来判屏亮：这行文本不该被当成「屏亮着」。
  assert.equal(displayOn('AppleARMBacklight brightness 3558\n'), false);
});

test('合盖且屏亮 -> 熄屏一次；决策没变就不再发', async (t) => {
  const state = { closed: true, displayOn: true };
  const { guard, h } = guardWith(state);
  t.after(() => guard.stop());

  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 1, '合盖且屏亮就该熄一次');
  assert.equal(guard.getStatus().lastAction, 'off');
  assert.equal(guard.getStatus().closed, true);
  assert.equal(guard.getStatus().displayOn, true);

  // 外接显示器合盖当主机：屏本来就该亮，连跑三轮都不许再熄 —— 每 5 秒熄一次就是抢屏。
  await guard.tick();
  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 1, '决策没变就不许重复熄屏');
});

test('屏灭之后被外设唤醒 -> 再熄一次（决策从 none 变回 off）', async (t) => {
  const state = { closed: true, displayOn: true };
  const { guard, h } = guardWith(state);
  t.after(() => guard.stop());

  await guard.tick();
  state.displayOn = false;
  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 1, '屏已灭，不重复发');
  state.displayOn = true; // 合盖期间被外设点亮
  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 2, '被唤醒的屏要再熄掉');
});

test('刚开盖 -> 补一次唤醒，之后就停手', async (t) => {
  const state = { closed: true, displayOn: false };
  const { guard, h } = guardWith(state);
  t.after(() => guard.stop());

  await guard.tick(); // 合盖、屏灭：什么都不做
  assert.equal(h.count('caffeinate'), 0);

  state.closed = false;
  await guard.tick();
  assert.equal(h.count('caffeinate'), 1, '开盖要补一次唤醒');
  assert.deepEqual(h.calls.filter((c) => c.startsWith('caffeinate')), ['caffeinate -u -t 1']);

  await guard.tick();
  await guard.tick();
  assert.equal(h.count('caffeinate'), 1, '开盖之后的每一轮都不该再唤醒');
});

test('开盖时不查 pmset：屏的实况是「不知道」，不是「灭着」', async (t) => {
  const state = { closed: false, displayOn: true };
  const { guard, h } = guardWith(state);
  t.after(() => guard.stop());

  await guard.tick();
  assert.equal(h.count('pmset -g assertions'), 0, '开盖时屏亮状态用不上，不该花这 7.6ms');
  assert.equal(guard.getStatus().displayOn, null, '没查就是不知道');
  assert.equal(guard.getStatus().closed, false);
});

test('熄屏命令失败 -> 下一轮重试，不会把这次失败当成已完成', async (t) => {
  const state = { closed: true, displayOn: true, sleepFails: true };
  const { guard, h } = guardWith(state);
  t.after(() => guard.stop());

  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 1);
  assert.match(guard.getStatus().error || '', /displaysleepnow failed/);

  state.sleepFails = false;
  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 2, '上一轮失败，这一轮必须再来一次');
  assert.equal(guard.getStatus().error, null);
  assert.equal(guard.getStatus().lastAction, 'off');
});

test('读不到屏的状态就不动手：宁可什么都不做，也不猜', async (t) => {
  const state = { closed: true, displayOn: true, assertionsError: true };
  const { guard, h } = guardWith(state);
  t.after(() => guard.stop());

  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 0, 'pmset 读失败时不许猜屏是亮的');
  assert.match(guard.getStatus().error || '', /pmset failed/);
});

test('ioreg 读失败只记错误，不熄屏也不唤醒', async (t) => {
  const state = { closed: true, displayOn: true, lidError: true };
  const { guard, h } = guardWith(state);
  t.after(() => guard.stop());

  await guard.tick();
  assert.equal(h.count('displaysleepnow'), 0);
  assert.equal(h.count('caffeinate'), 0);
  assert.match(guard.getStatus().error || '', /ioreg failed/);
});

test('非 macOS：不启动、不探测', async () => {
  const h = harness(() => ({ stdout: CLOSED }));
  const guard = createLidDisplayGuard({ platform: 'linux', run: h.run });

  assert.equal(guard.isAvailable(), false);
  assert.equal(guard.sync(true).enabled, false, '非 macOS 上不能假装守起来了');
  assert.equal(guard.start().enabled, false);
  await guard.tick();
  assert.deepEqual(h.calls, [], '非 macOS 上不该调任何命令');
});

test('sync 幂等：跟着「关盖运行」的实况开关', async (t) => {
  const state = { closed: false, displayOn: false };
  const { guard } = guardWith(state);
  t.after(() => guard.stop());

  assert.equal(guard.getStatus().enabled, false);
  assert.equal(guard.sync(true).enabled, true);
  assert.equal(guard.sync(true).enabled, true, '已经守着就不要再起一个');
  assert.equal(guard.sync(false).enabled, false);
  assert.equal(guard.getStatus().closed, null, '停手后不再保留状态');
});
