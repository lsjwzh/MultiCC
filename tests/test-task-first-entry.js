'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const { createStaticAssetsRoutes } = require('../src/routes/static-assets');
const { mountAir } = require('./helpers/air-host');

test('public conversation bookmarks resolve through tasks; Air owns the only chat entry', async t => {
  const app = express();
  createStaticAssetsRoutes({ express, fs, path, publicDir: path.resolve(__dirname, '../public') }).mountRoutes(app);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // `/manage`、`/dashboard` 与 `/air?view=planner` 的重定向已由 Rust 前门独占
  // （native/core/src/static_assets_routes.rs；Node 侧注册已删除）。这里只断言
  // Node 不再用 302 认领它们，剩下的 versioned-HTML 入口仍在 Node 上。
  for (const url of ['/manage', '/dashboard', '/air?view=planner']) {
    const response = await fetch(base + url, { redirect: 'manual' });
    assert.notEqual(response.status, 302, `${url} 归 Rust 前门，Node 不再重定向`);
    assert.equal(response.headers.get('location'), null, url);
  }
  for (const url of ['/manage-task-planner.js', '/manage-task-planner.css']) {
    assert.equal((await fetch(base + url)).status, 404, url);
  }
  const air = await (await fetch(base + '/air')).text();
  assert.doesNotMatch(air, /view=planner|directory-open-planner/);
  // 旧管理台整页已删：它那张兼容皮肤（manage-air-embed.css）连同 planner
  // 资源一起 404；书签语义只在前门（/manage → /air?view=…）。
  assert.equal((await fetch(base + '/manage-air-embed.css')).status, 404);
  assert.equal((await fetch(base + '/manage.js')).status, 404);
  for (const url of ['/chat?session=a', '/chat.html?session=a', '/task-shell?shell=s', '/task-shell.html?task=t&board=1', '/task-shell.html?air=1', '/task-shell.html?air=1&board=1&shell=s']) {
    const response = await fetch(base + url), html = await response.text();
    assert.equal(response.status, 200, url); assert.match(html, /task-entry.js/);
    assert.doesNotMatch(html, /id="messages"/); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  for (const url of ['/chat.html?air=1&task=t', '/chat?air=1&session=a']) {
    const response = await fetch(base + url), html = await response.text();
    assert.equal(response.status, 200, url); assert.match(html, /id="messages"/);
    assert.match(html, /chat-air\.css/); assert.doesNotMatch(html, /task-entry\.js/);
  }
  // 独立的任务壳页面已退役：连它那条 board=1 渲染器书签也走同一个任务入口
  // （task-entry.html → /api/air/resolve → /air?task=…），不再有第二份渲染器。
  const embedded = await fetch(base + '/task-shell.html?air=1&board=1&task=t');
  const embeddedHtml = await embedded.text();
  assert.equal(embedded.status, 200);
  assert.match(embeddedHtml, /task-entry\.js/);
  assert.doesNotMatch(embeddedHtml, /task-board-entry\.js/);
});

test('legacy bookmark resolution retains explicit task identity and its directory', async () => {
  let migrations = 0;
  // 前门（Rust）负责把 {taskId, dirId} 拼成 /air?task=…&dir=…；宿主只回答「定位到哪」。
  const air = mountAir({
    records: new Map([['s', { id: 's', dirId: 'd1' }]]), shell: {
      migrateTaskSessions: async () => { migrations++; },
      stateTarget: () => ({ taskId: 't-current' }), artifactTaskId: () => 't-owned',
      chatScope: () => ({ taskId: 't-shell' }), taskEntry: async id => ({ sessionId: 's', task: { id } }),
    },
  });
  for (const [input, id] of [[{ task: 't-explicit', session: 's' }, 't-explicit'], [{ session: 's' }, 't-current'], [{ shell: 'sh' }, 't-shell']]) {
    const data = await air.ok({ op: 'resolve', ...input });
    assert.deepEqual(data, { taskId: id, dirId: 'd1' });
  }
  assert.equal(migrations, 3);
});
