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

const fillRows = `(() => {
  const list = document.getElementById('tasks');
  for (let i = 1; i <= ${ROWS}; i += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '任务 ' + i;
    list.append(button);
  }
})()`;

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
