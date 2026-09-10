'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const { createStaticAssetsRoutes } = require('../src/routes/static-assets');
const { mountAirRoutes } = require('../src/workspace/air-routes');

test('public conversation bookmarks resolve through tasks; Air owns the only chat entry', async t => {
  const app = express();
  createStaticAssetsRoutes({ express, fs, path, publicDir: path.resolve(__dirname, '../public') }).mountRoutes(app);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(base, { redirect: 'manual' }); assert.equal(root.headers.get('location'), '/air');
  for (const url of ['/chat?session=a', '/chat.html?session=a', '/task-shell?shell=s', '/task-shell.html?task=t&board=1', '/task-shell.html?air=1', '/task-shell.html?air=1&board=1&shell=s']) {
    const response = await fetch(base + url), html = await response.text();
    assert.equal(response.status, 200, url); assert.match(html, /task-entry.js/);
    assert.doesNotMatch(html, /id="messages"/); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  const embedded = await fetch(base + '/task-shell.html?air=1&board=1&task=t');
  assert.match(await embedded.text(), /task-board-entry.js/);
});

test('legacy bookmark resolution retains explicit task identity and encodes its destination', async () => {
  const handlers = new Map(); let migrations = 0;
  mountAirRoutes({ get: (url, h) => handlers.set(url, h), post() {} }, {
    records: new Map([['s', { id: 's', dirId: 'd1' }]]), shell: {
      migrateTaskSessions: async () => { migrations++; },
      stateTarget: () => ({ taskId: 't-current' }), artifactTaskId: () => 't-owned',
      chatScope: () => ({ taskId: 't-shell' }), taskEntry: async id => ({ sessionId: 's', task: { id } }),
    },
  });
  for (const [query, id] of [[{ task: 't-explicit', session: 's' }, 't-explicit'], [{ session: 's' }, 't-current'], [{ shell: 'sh' }, 't-shell']]) {
    let data; await handlers.get('/api/air/resolve')({ query }, { json: x => { data = x; } });
    assert.equal(data.taskId, id); assert.equal(data.url, `/air?task=${id}&dir=d1`);
  }
  assert.equal(migrations, 3);
});
