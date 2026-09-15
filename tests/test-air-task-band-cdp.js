'use strict';

// The Air sidebar's task band, in a real browser. Two things are measured here
// that reading the stylesheet cannot settle: who owns the scrolling, and what
// happens to the height nobody is using.
//
// The band is a flex column with a definite height. It used to be the scroller
// (`flex: 0 0 auto` on the list, `overflow-y: auto` on the band), which meant a
// list of eight tasks sat at its natural height and the leftover height — the
// part of the sidebar that is *for* tasks — stayed empty. The list owns the
// scrolling now: it takes the leftover and scrolls inside itself, and the band
// keeps `overflow-y: auto` only as the fallback for a window too short to hold
// even its `min-height`. Both halves of that are asserted below, because a
// stylesheet can be edited back to the old arrangement without anything else
// noticing.
//
// A DOM shim cannot see any of this; it is a pure layout disagreement between
// the markup and the stylesheet. The page's own scripts are stripped so the
// list is the only variable: air.js would boot a console from a directory API
// this test does not own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const CONTENT_TYPE = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };

// Enough rows that the band cannot possibly fit them, whatever the viewport.
const ROWS = 29;

function buildRoutes() {
  const publicDir = path.resolve(__dirname, '../public');
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(css|svg)$/.test(name))) {
    const extension = file.slice(file.lastIndexOf('.') + 1);
    routes[`/${file}`] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': CONTENT_TYPE[extension] || 'application/octet-stream' },
    };
  }
  const html = fs.readFileSync(path.join(publicDir, 'air.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  routes['/'] = { body: html, headers: { 'content-type': 'text/html; charset=utf-8' } };
  return routes;
}

// 标题得真会折行。侧栏的行宽 236px 上下，真实任务的名字常常是两三行（用户侧栏里
// 就有「运行 TikTok 库存同步脚本（xlwms→TikTok 每小时同步）」这种），而一行标题的
// min-content 差不多就是它自己的高度 —— 压也压不出多少来，下面那几条「行内容不出框」
// 的断言会退化成永远为真的摆设。第一条按真实长度折成三行并挂上 `.long-title`（行会
// 被重排，所以量的是这条带标记的，不是「第一条」），压矮一点就看得出来。
const LONG_TITLE = '运行 TikTok 库存同步脚本（xlwms→TikTok 每小时同步），并把当天的 GMV Max 广告数据落进本地库';
const fillRows = `(() => {
  const list = document.getElementById('tasks');
  const long = ${JSON.stringify(LONG_TITLE)};
  for (let i = 1; i <= ${ROWS}; i += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = i === 1 ? 'selected long-title' : '';
    const title = document.createElement('strong');
    title.textContent = i === 1 ? long : '任务 ' + i;
    const meta = document.createElement('small');
    meta.textContent = '计划 · 进行中 · MultiCC 主仓';
    button.append(title, meta);
    list.append(button);
  }
})()`;

// 行还是按内容的高度排的。容器的空间是给滚用的，不是给压行用的：`nav` 是
// flex 列，清单一旦有了确定高度，行默认 `flex-shrink:1`，会被挤成一半高，
// 标题和状态行叠在一起 —— 这条量的是那件事，光看 scrollHeight 看不出来。
// 每一屏都量一次（加载后一次、切换任务后再一次），因为「切换任务时特别容易
// 错乱」是用户的原始说法：切换会重排这份清单，那是第二次布局。
const rowGeometry = `(() => {
  const boxes = [...document.querySelectorAll('#tasks button')];
  const rects = boxes.map(box => box.getBoundingClientRect());
  const box = row => ({ height: Math.round(row.getBoundingClientRect().height), content: row.scrollHeight });
  return {
    clipped: boxes.filter(row => row.scrollHeight > row.clientHeight + 1).length,
    overlaps: rects.filter((rect, i) => i > 0 && rect.top < rects[i - 1].bottom - 1).length,
    long: box(document.querySelector('#tasks button.long-title')),
    selected: box(document.querySelector('#tasks button.selected')),
  };
})()`;

// 切换任务时 render() 干的事就是 `$('tasks').replaceChildren(…)`：整份清单重排，
// 选中标记换到点进去的那条。这里照着做一遍 —— 行是新的、顺序是新的、标中的是新的
// 一条，再量一次几何。
// 切换任务时 render() 干的事就是 `$('tasks').replaceChildren(…)`：整份清单重排，
// 选中标记换到点进去的那条（「最近任务」按打开顺序排，点进去的那条会到最前面）。
// 这里照着做一遍 —— 行是新的顺序、标中的是另一条，然后重新量几何。
const switchRows = `(() => {
  const list = document.getElementById('tasks');
  const rows = [...list.children];
  const picked = rows[1];
  for (const row of rows) row.classList.toggle('selected', row === picked);
  list.replaceChildren(picked, ...rows.filter(row => row !== picked));
})()`;

async function assertRowsKeepTheirContent(page, when) {
  const rows = await page.evaluate(rowGeometry);
  assert.equal(rows.clipped, 0, `${when}：每一行都要装得下自己的内容`);
  assert.equal(rows.overlaps, 0, `${when}：行与行不许叠在一起`);
  // 「行高 ≥ 内容高」在折行的行上才有牙齿：一条标题折成三行，压矮一点就露馅。
  assert.ok(
    rows.long.content >= 60,
    `${when}：长标题那条的内容高只有 ${rows.long.content}，标题没折行 —— fixture 变软了，量不到压行`,
  );
  assert.ok(
    rows.long.height >= rows.long.content,
    `${when}：折行那条的行高 ${rows.long.height} 不该小于内容高 ${rows.long.content}`,
  );
  assert.ok(
    rows.selected.height >= rows.selected.content,
    `${when}：标中那条的行高 ${rows.selected.height} 不该小于内容高 ${rows.selected.content}`,
  );
  return rows;
}

test('the Air task list fills the band and scrolls inside it', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-air-task-band-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    await page.evaluate(fillRows);

    const band = await page.evaluate(`(() => {
      const list = document.getElementById('tasks');
      const sidebar = document.getElementById('task-sidebar');
      const listBox = list.getBoundingClientRect();
      const bandBox = sidebar.getBoundingClientRect();
      return {
        rows: list.querySelectorAll('button').length,
        listHeight: Math.round(listBox.height),
        contentHeight: Math.round(list.scrollHeight),
        // 清单自己滚得动 —— 溢出的那些藏在这里，不是藏没了。
        listScrollable: list.scrollHeight > list.clientHeight + 1,
        // 任务带本身不再是滚动者：它是一副固定的框。
        bandScrollable: sidebar.scrollHeight > sidebar.clientHeight + 1,
        // 清单底下只剩它自己那 4px 外边距，也就是它吃到了这条带的剩余高度。
        gapUnderList: Math.round(bandBox.bottom - listBox.bottom),
        visibleRows: Math.round(listBox.height / 40),
      };
    })()`);

    assert.equal(band.rows, ROWS, 'all the sample tasks rendered');
    // 空白变成了行：清单长到把带子剩下的高度吃掉。
    assert.ok(
      band.listHeight > band.contentHeight - 2 || band.listScrollable,
      `list should absorb the leftover height, got ${band.listHeight} of ${band.contentHeight}`,
    );
    assert.ok(
      band.listScrollable,
      `list should scroll: ${band.contentHeight} of content in ${band.listHeight}`,
    );
    assert.ok(
      band.gapUnderList <= 6,
      `list should run down to the foot of the band, ${band.gapUnderList}px of it left empty`,
    );
    assert.equal(band.bandScrollable, false, 'the band is a fixed frame, not a second scroller');
    assert.ok(
      band.visibleRows > 1,
      `more than one task should be on screen at a time, got about ${band.visibleRows}`,
    );

    // 行不许被压矮（断言在 assertRowsKeepTheirContent 里）。量两次：刚打开一次，
    // 切换任务 —— 清单整份重排之后 —— 再一次。用户报的就是「切换任务的时候特别
    // 容易错乱」，那是清单的第二次布局。
    await assertRowsKeepTheirContent(page, '刚打开');
    await page.evaluate(switchRows);
    await assertRowsKeepTheirContent(page, '切换任务后');

    // 最后一条靠滚清单就能到 —— 整件事的重点。同时抬头不许跟着走。
    const scrolled = await page.evaluate(`(() => {
      const list = document.getElementById('tasks');
      const heading = document.querySelector('.task-heading');
      const before = Math.round(heading.getBoundingClientRect().top);
      list.scrollTop = list.scrollHeight;
      const last = document.querySelectorAll('#tasks button')[${ROWS - 1}];
      const box = last.getBoundingClientRect();
      const view = list.getBoundingClientRect();
      return {
        reachable: box.top >= view.top - 1 && box.bottom <= view.bottom + 1 && box.height > 0,
        headingMoved: Math.round(heading.getBoundingClientRect().top) - before,
      };
    })()`);
    assert.ok(scrolled.reachable, 'the last task must scroll into view');
    assert.equal(scrolled.headingMoved, 0, 'rolling the list must not take its own heading off screen');

    await page.screenshot('01-task-band');
  });
});

// 行高是两层防线各自独立保证的：清单不是 flex 列（行是块级子项，没有 flex-shrink
// 这条路），以及万一它又变成 flex 容器时 `#tasks > * { flex: 0 0 auto }` 接管。
// 用户报过一次「行被压成 38px、状态行叠到下一行标题上」：那是第一层还没上、第二层
// 又没生效的样式表（`#tasks > *` 是子选择器 —— 一旦行外面套了包装元素就失效）。
// 所以两条各断言一次，再合起来断言一次「两条都没有时确实会坏」—— 免得上面两条
// 变成永远为真的摆设。
const killBlockLayout = `(() => {
  const s = document.createElement('style');
  s.id = 'kill-block-layout';
  s.textContent = '#tasks { display: flex; flex-direction: column; } #tasks > * + * { margin-top: 0; }';
  document.head.append(s);
})()`;
const killFlexGuard = `(() => {
  const s = document.createElement('style');
  s.id = 'kill-flex-guard';
  s.textContent = '#tasks > * { flex: 1 1 auto !important; }';
  document.head.append(s);
})()`;

test('the task rows survive either defence being taken away', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-air-task-band-guards-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    await page.evaluate(fillRows);

    const list = await page.evaluate(`(() => {
      const el = document.getElementById('tasks');
      const style = getComputedStyle(el);
      const second = el.querySelectorAll('button')[1];
      return { display: style.display, rowMargin: getComputedStyle(second).marginTop };
    })()`);
    assert.equal(list.display, 'block', '清单是块级列表：行是块级子项，行高没有「被 flex 压缩」这条路');
    assert.equal(list.rowMargin, '4px', '行距由 margin-top 给（不再是 nav 的 gap）');
    await assertRowsKeepTheirContent(page, '块级列表');

    // 第一层按掉：清单被强行变回 flex 列，第二层（flex: 0 0 auto）得自己扛住。
    await page.evaluate(killBlockLayout);
    await assertRowsKeepTheirContent(page, '清单被强制回 flex 列之后');

    // 第二层按掉（第一层还按着）：两层都没有的时候，行确实会被压扁 —— 上面两条断言
    // 因此不是永远为真的摆设。
    await page.evaluate(killFlexGuard);
    const broken = await page.evaluate(rowGeometry);
    assert.ok(
      broken.clipped > 0,
      '两层都拿掉之后行应该被压扁（内容溢出框）—— 没坏说明 fixture 量不到这件事了',
    );
  });
});

test('a window too short for three bands scrolls the whole sidebar instead', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: path.join(os.tmpdir(), 'multicc-air-task-band-short-qa') }, async page => {
    // 横屏手机那么矮：固定内容（目录卡、导航、脚注）加起来就超过屏幕，分给任务带
    // 的只剩十几像素。这时必须退回「整条侧栏一起滚」—— 把清单留在一个 12px 的窗口
    // 里，等于用一个自己也要滚的清单塞住那条缝，两头都看不全。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 420, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    await page.evaluate(fillRows);

    const short = await page.evaluate(`(() => {
      const sidebar = document.getElementById('sidebar');
      const list = document.getElementById('tasks');
      const view = sidebar.getBoundingClientRect();
      sidebar.scrollTop = sidebar.scrollHeight;
      const box = document.querySelectorAll('#tasks button')[${ROWS - 1}].getBoundingClientRect();
      return {
        // 一圈滚动的只有侧栏本身：清单不再自己开第二层。
        sidebarScrollable: sidebar.scrollHeight > sidebar.clientHeight + 1,
        listScrollsItself: list.scrollHeight > list.clientHeight + 1,
        lastInView: box.height > 0 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
      };
    })()`);
    assert.ok(short.sidebarScrollable, 'a sidebar too short for its own bands has to scroll');
    assert.equal(short.listScrollsItself, false, 'the list hands its scrolling back to the sidebar');
    assert.ok(short.lastInView, 'and the tail of the list stays reachable that way');
  });
});
