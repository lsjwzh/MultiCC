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
//
// 第四件是同一轮里更小的一处：聊天里「工具在跑」的省略号原本是逐帧改 content 的
// 关键帧动画，每个字都是重排 + 重绘，而且只在工具运行期间出现 —— 那正是用户在看的
// 时候。它现在是静态的省略号。

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
const CHAT_HTML = read('chat.html');
const STATUS_PRESENTATION = read('status-presentation.js');
const COMPOSER_CSS = read('composer.css');

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
  // 调色板只有一份，住在 status-presentation.js —— Air 的圈和老看板卡片的描边是
  // 同一条规则的两个壳，同一件东西在两页上不该是两个颜色。
  const palette = STATUS_PRESENTATION.match(/const RING_TINTS = Object\.freeze\(\[([^\]]+)\]/);
  assert.ok(palette, 'status-presentation.js 里找不到 RING_TINTS');
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
  assert.ok(/function ringTint\(seed\)/.test(STATUS_PRESENTATION), 'ringTint 应该由 seed 决定颜色');
  const hashBody = STATUS_PRESENTATION.slice(STATUS_PRESENTATION.indexOf('function ringTint(seed)'));
  assert.equal(/Math\.random\(/.test(hashBody.slice(0, hashBody.indexOf('\n  }'))), false,
    'ringTint 里不该出现 Math.random：同一个任务必须每次都是同一个颜色');

  // 消费者得走这一份，不许自己留个数组抄一遍。（旧看板 manage-dashboard.js 是
  // 另一个消费者，随 /manage.html 一起删了。）
  assert.ok(/registry\(\)[\s\S]{0,40}?\.ringTint\(seed\)/.test(AIR_ADMIN), 'air-admin.js 应该向 registry 要颜色');
  assert.equal(/RING_TINTS = \[/.test(AIR_ADMIN), false, 'air-admin.js 不该再自带一份调色板');

  // 每一个调用点都得把 id 传下去，否则那条线的颜色会退回主题色 —— 圈还在，但
  // 「哪条和哪条不一样」这件事就没了，而它正是这次替代动画的东西。
  for (const [file, source] of [['air.js', AIR], ['air-admin.js', AIR_ADMIN]]) {
    for (const call of source.matchAll(/applyRing\(([^()]*)\)/g)) {
      const args = call[1].split(',').map(s => s.trim()).filter(Boolean);
      assert.ok(args.length >= 3, `${file} 里有个 applyRing 少了 seed：applyRing(${call[1]})`);
    }
  }
});

test('聊天里的「工具在跑」不再逐帧改文字', () => {
  // content 是关键帧里少数会触发布局的值：每换一个点，那一行就要重新排版一次。
  const keyframes = [...CHAT_HTML.matchAll(/@keyframes\s+tool-dots\s*\{([^}]*\})?\}?/g)];
  assert.deepEqual(keyframes.map(m => m[0]), [], 'tool-dots 那套逐帧改 content 的关键帧不该回来');
  assert.equal(/animation:\s*tool-dots/.test(CHAT_HTML), false, '别再把 tool-dots 挂到 .tool-desc::after 上');

  // 运行状态还得看得见：图标继续闪，省略号改成静态的留在行尾。
  assert.ok(/\.tool-card\.tool-running\s+\.tool-icon\s*\{[^}]*animation:\s*blink/.test(CHAT_HTML),
    '工具在跑的图标闪烁要留着，它是这一行唯一的运行信号');
  const still = /\.tool-card\.tool-running\s+\.tool-desc::after\s*\{([^}]*)\}/.exec(CHAT_HTML);
  assert.ok(still, '.tool-desc::after 的静态省略号不见了');
  assert.equal(/animation\s*:/.test(still[1]), false, '静态省略号上不该挂动画');
  assert.ok(/content:\s*['"]\\?2026['"]/.test(still[1]) || /content:\s*['"]…['"]/.test(still[1]),
    `省略号应该是一个静态的 …：${still[1]}`);
});

// ── 第二组：界面上不许有「一直动」的东西 ──────────────────────────────────────
//
// 第一组管的是「一帧要花多少」（毛玻璃）。这一组管的是「帧会不会停」：软件光栅下
// 合成器只要还在出帧，每一帧都要把整屏重新合成一遍，所以屏幕上永远有个东西在动
// 就等于永远不归零。规则因此是两条：
//   · 会一直存在的装饰（跑着的任务、等待中的角标、卡片上的光晕）必须是静态的；
//   · 只允许「过程中才出现」的动画活着（工具在转、正在输入、正在录音、diff 正在
//     加载），而且它们只能碰 transform / opacity —— 那两样由合成器接管，不重排版。

test('Air 的壳上一条 animation 都没有', () => {
  // 例外的只有 composer.css 的跑马灯（下面单独钉），其余一律不许出现 —— 壳是常驻
  // 在屏幕上的那几层，它们动一下就是整屏一直在动。
  for (const file of SHELL_CSS.concat(['status-badge.css'])) {
    const css = read(file);
    const decls = [...css.matchAll(/^\s*animation:\s*([^;}]+)/gm)].map(m => m[1].trim());
    assert.deepEqual(decls, [], `${file} 又出现了动画：${decls.join(' / ')}`);
    assert.equal(/@keyframes/.test(css), false, `${file} 不该再有关键帧`);
  }
});

test('跑马灯默认不动，指上去才走', () => {
  // 长名字还是要能看全（切掉的名字等于没有名字），但「屏幕上一直有个东西在来回走」
  // 正是要拿掉的那件事，所以改成 hover / 键盘焦点时才走。
  assert.ok(/animation-play-state:\s*paused/.test(COMPOSER_CSS), '跑马灯默认应该是暂停的');
  const running = COMPOSER_CSS.slice(COMPOSER_CSS.indexOf('animation-play-state: running'));
  const before = COMPOSER_CSS.slice(COMPOSER_CSS.indexOf('Hovering'), COMPOSER_CSS.indexOf('animation-play-state: running'));
  assert.ok(/is-marquee:hover/.test(before) && /focus/.test(before),
    '只有指上去或键盘聚焦时才该开始走');
  assert.ok(running, '跑马灯得有个能走起来的开关');
});

test('所有「一直动」的动画只碰 transform / opacity', () => {
  // 逐帧改 box-shadow / border-color / background-position / 宽高 会重排或重绘；
  // 唯一还能留下的永续动画都得是合成器能接管的属性。
  const PAINT_ONLY = /^(box-shadow|border(-[a-z]+)?-color|border|background(-[a-z]+)?|color|content|width|height|top|left|right|bottom|filter|backdrop-filter|margin|padding|font-size)\s*:/;
  const files = fs.readdirSync(path.join(ROOT, 'public')).filter(f => /\.(css|html)$/.test(f));
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    // 一个文件里可能既有 <style> 又有内联 style，这里按整份文本处理：@keyframes 的
    // 定义和引用都在同一份文本里。
    const infinite = new Set();
    for (const m of source.matchAll(/animation:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      if (!/\binfinite\b/.test(value)) continue;
      const name = value.split(/\s+/).find(tok => /^[A-Za-z][\w-]*$/.test(tok)
        && !/^(infinite|alternate|both|forwards|backwards|none|linear|ease|ease-in|ease-out|ease-in-out|paused|running|normal|reverse|step-start|step-end)$/.test(tok));
      if (name) infinite.add(name);
    }
    for (const name of infinite) {
      const start = source.search(new RegExp(`@keyframes\\s+${name}[\\s{]`));
      if (start < 0) continue;
      const open = source.indexOf('{', start);
      let depth = 0, end = open;
      for (; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') { depth -= 1; if (!depth) break; }
      }
      const body = source.slice(open, end);
      for (const decl of body.split(/[;{]/)) {
        if (PAINT_ONLY.test(decl.trim())) offenders.push(`${file} @keyframes ${name}: ${decl.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `这些永续动画每帧都要重排/重绘：\n${offenders.join('\n')}`);
});

test('running 的标记不再旋转', () => {
  const css = read('status-badge.css');
  assert.ok(css.includes('.mc-status.st-spin .mc-status-ico'), 'running 的标记还得在（只有 running 有）');
  assert.equal(/@keyframes/.test(css), false, '这个文件不该再有关键帧');
  assert.equal(/rotate\(/.test(css), false, '不该再旋转');
});
