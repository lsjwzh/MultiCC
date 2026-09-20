'use strict';

// Air 的「画面预算」。这一组守的不是长相，是**合成器能不能闲下来**。
//
// 起因（2026-09-20，用户报「切到 MultiCC 页面 Chrome GPU 进程 100%」）：
// 现场那台 Chrome 的「使用图形加速」是关的（GPU 进程带 --use-gl=disabled，软件
// 光栅）。在这种机器上量同一个任务页（软件光栅，各 3 轮取中位数，单位=核）：
//     Air 原样                     0.96  ← GPU 进程常驻一个核，页面主线程只忙 3%
//     去掉全部 backdrop-filter     0.26
//     再去掉全部动画               0.12
//     有 GPU 的机器，Air 原样      0.19
// 也就是说：毛玻璃是软件光栅下的主犯（约 73%），而「屏幕上永远有个东西在动」是
// 它一直不归零的原因 —— 合成器只要还在出帧，每一帧都要把这些模糊重算一遍。
// 结论写在代码里：Air 的壳不再有常驻毛玻璃，圈也不再逐帧动画。这一组用例就是
// 那两句话的执行体：谁把它们加回来，就会在这里看到为什么。
//
// 三件事分别对应上面三段：
//   1. 壳（air.css / chat-layout.css / chat-dispatch-activity.css）里没有 backdrop-filter；
//   2. 圈没有被动画 —— 它是静态描边，颜色靠 air.js 写在节点上的 --ring-tint；
//   3. 那个调色板的每一档都过得了 test-air-console-cdp.js 的像素门槛。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');

const SHELL_CSS = ['air.css', 'chat-layout.css', 'chat-dispatch-activity.css'];
const AIR_CSS = read('air.css');
const AIR_ADMIN = read('air-admin.js');
const AIR = read('air.js');

test('Air 的壳不再常驻毛玻璃：每一层 backdrop-filter 都是 none', () => {
  // 这几层的底色本来就是 .82–.98 的不透明/近不透明填充（sidebar 是 .96/.92 的
  // 渐变，chat-layer 是 .94，task-details 是 .98），模糊在视觉上几乎看不出来，
  // 在软件光栅下却要每出一帧就把 1.5M 像素的背景重刷一遍。所以规则是「一律不许
  // 有」，而不是「少一点」—— 半留半删的量级差异实测只有 0.05 核，不值得再讨论。
  for (const file of SHELL_CSS) {
    const css = read(file);
    const uses = [...css.matchAll(/backdrop-filter:\s*([^;}]+)/g)].map(m => m[1].trim());
    const painted = uses.filter(value => value !== 'none');
    assert.deepEqual(painted, [], `${file} 又出现了会真的画画儿的 backdrop-filter：${painted.join(' / ')}`);
  }
});

test('圈是静态描边，不是会动的彩虹', () => {
  // 「跑着的任务一直转」这件事本身要留（它是这条任务在跑的唯一信号），去掉的是
  // 「一直动」：静态的 3px 描边 + 按 id 挑的颜色，屏幕上没有逐帧动画。
  assert.equal(/@keyframes\s+air-rainbow-hue/.test(AIR_CSS), false, 'hue-rotate 那套关键帧不该回来');
  const block = AIR_CSS.slice(AIR_CSS.indexOf('.ring-running::before {'));
  const rule = block.slice(0, block.indexOf('}'));
  assert.equal(/animation\s*:/.test(rule), false, '圈上不该挂任何 animation');
  assert.equal(/hue-rotate/.test(rule), false, '圈上不该再有滤镜动画');
  // 颜色必须带兜底：少一个变量就整条消失，等于把「这条在跑」说没了。
  assert.ok(/box-shadow:\s*inset[^;]*var\(--ring-tint,\s*var\(--accent\)\)/.test(rule),
    '圈的颜色要写成 var(--ring-tint, var(--accent))：量不到变量时退回主题强调色');
});

test('圈的调色板：每一档都过得了像素门槛，而且是按 id 挑的', () => {
  const palette = AIR_ADMIN.match(/const RING_TINTS = \[([^\]]+)\]/);
  assert.ok(palette, 'air-admin.js 里找不到 RING_TINTS');
  const tints = palette[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.ok(tints.length >= 4, `调色板太小，随机感会退化成条纹：${tints.join(' ')}`);
  // test-air-console-cdp.js 的 ringEdges 从边框里侧向内扫 7px，取最饱和的像素，
  // 要求 max-min ≥ 60；饱和度就是 max-min（tests/helpers/png-pixels.js）。
  for (const tint of tints) {
    const rgb = /^#([0-9a-f]{6})$/i.exec(tint);
    assert.ok(rgb, `${tint} 不是 6 位十六进制颜色`);
    const [r, g, b] = [0, 2, 4].map(i => parseInt(rgb[1].slice(i, i + 2), 16));
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(saturation >= 60, `${tint} 太淡了（max-min=${saturation} < 60）：像素断言会在这一档上失败`);
  }
  // 颜色靠 id 定，不靠随机数：列表每 4 秒随快照重画一次，随机会让同一行一直换色。
  assert.ok(/function ringTint\(seed\)/.test(AIR_ADMIN), 'ringTint 应该由 seed 决定颜色');
  assert.equal(/Math\.random\(/.test(AIR_ADMIN.slice(AIR_ADMIN.indexOf('RING_TINTS'))), false,
    'ringTint 里不该出现 Math.random：同一个任务必须每次都是同一个颜色');

  // 每一个调用点都得把 id 传下去，否则那条线的颜色会退回主题色 —— 圈还在，但
  // 「哪条和哪条不一样」这件事就没了，而它正是这次替代动画的东西。
  for (const [file, source] of [['air.js', AIR], ['air-admin.js', AIR_ADMIN]]) {
    for (const call of source.matchAll(/applyRing\(([^()]*)\)/g)) {
      const args = call[1].split(',').map(s => s.trim()).filter(Boolean);
      assert.ok(args.length >= 3, `${file} 里有个 applyRing 少了 seed：applyRing(${call[1]})`);
    }
  }
});
