'use strict';

// The Air sidebar's task band with a list longer than the band, in a real
// browser. Found by measuring rather than by reading: the band is a flex column
// with a definite height, so a #tasks box left at its default flex shrink
// collapsed to its 52px min-height floor and the band's own overflow-y never
// engaged — 29 tasks rendered, one visible, no scrollbar anywhere. A DOM shim
// cannot see this; it is a pure layout disagreement between the markup and the
// stylesheet.
//
// The page's own scripts are stripped so the list is the only variable: air.js
// would boot a console from a directory API this test does not own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const CONTENT_TYPE = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };

// Enough rows that the band cannot possibly fit them, whatever the viewport.
const ROWS = 29;

test('the Air task band scrolls instead of hiding the tasks that overflow it', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
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

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-task-band-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    await page.evaluate(`(() => {
      const list = document.getElementById('tasks');
      for (let i = 1; i <= ${ROWS}; i += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '任务 ' + i;
        list.append(button);
      }
    })()`);

    const band = await page.evaluate(`(() => {
      const list = document.getElementById('tasks');
      const sidebar = document.getElementById('task-sidebar');
      return {
        rows: list.querySelectorAll('button').length,
        listHeight: Math.round(list.getBoundingClientRect().height),
        contentHeight: Math.round(list.scrollHeight),
        bandScrollHeight: Math.round(sidebar.scrollHeight),
        bandClientHeight: Math.round(sidebar.clientHeight),
        bandScrollable: sidebar.scrollHeight > sidebar.clientHeight + 1,
        // One row is roughly 40px; a collapsed band shows about one of them.
        visibleRows: Math.round(list.getBoundingClientRect().height / 40),
      };
    })()`);

    assert.equal(band.rows, ROWS, 'all the sample tasks rendered');
    // The list is not a window onto itself: it is as tall as what it holds, so
    // nothing is clipped inside it.
    assert.ok(
      Math.abs(band.listHeight - band.contentHeight) <= 2,
      `list box should be as tall as its rows, got ${band.listHeight} vs ${band.contentHeight}`,
    );
    // The overflow has to go somewhere, and the band is where it belongs.
    assert.ok(
      band.bandScrollable,
      `band should scroll: ${band.bandScrollHeight} of content in ${band.bandClientHeight}`,
    );
    assert.ok(
      band.visibleRows > 1,
      `more than one task should be on screen at a time, got about ${band.visibleRows}`,
    );

    // The last task is reachable by scrolling the band — the whole point.
    const reachable = await page.evaluate(`(() => {
      const sidebar = document.getElementById('task-sidebar');
      sidebar.scrollTop = sidebar.scrollHeight;
      const last = document.querySelectorAll('#tasks button')[${ROWS - 1}];
      const box = last.getBoundingClientRect();
      const band = sidebar.getBoundingClientRect();
      return box.top >= band.top - 1 && box.bottom <= band.bottom + 1 && box.height > 0;
    })()`);
    assert.ok(reachable, 'the last task must scroll into view');

    await page.screenshot('01-task-band');
  });
});
