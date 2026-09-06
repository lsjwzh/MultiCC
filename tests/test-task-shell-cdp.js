'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./helpers/task-shell');
const { findChromeBinary, withCdpHarness } = require('./helpers/cdp-harness');

test('task shell browser: busy fork, immutable answer target, response loss replay and mobile layout', async t => {
  if (!findChromeBinary()) return t.skip('Chrome is required');
  const f = fixture(t), routes = {};
  const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  for (const file of ['task-shell.html', 'task-shell.js', 'task-shell-client.js', 'task-shell.css', 'safe-markdown.js', 'i18n.js', 'i18n-catalog.js', 'vendor/dompurify/purify.min.js']) {
    routes['/' + file] = { body: fs.readFileSync(path.join(__dirname, '..', 'public', file)), headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  routes['/auth-client.js'] = { body: '', headers: { 'content-type': 'text/javascript' } };
  routes['POST /api/task-shells'] = () => json(f.a);
  routes[`/api/task-shells/${f.a.id}`] = () => json(f.runtime.view(f.a.id));
  let lose = false;
  routes[`POST /api/task-shells/${f.a.id}/messages`] = async ({ body }) => {
    try {
      const result = await f.runtime.send(f.a.id, JSON.parse(body));
      routes[`/api/task-shells/${f.a.id}/tasks/${result.taskId}`] = async () => json(await f.runtime.detail(f.a.id, result.taskId));
      if (lose) { lose = false; return json({ code: 'lost_response' }, 503); }
      return json(result);
    } catch (error) { return json({ code: error.code, message: error.message, receiptId: error.receiptId }, error.status || 500); }
  };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-task-shell-screenshots') }, async page => {
    await page.screenshotOnFailure('task-shell', async () => {
      await page.navigate('/task-shell.html?session=a');
      await page.send('Page.bringToFront');
      assert.ok(await page.waitFor('location.search.includes("shell=") && !document.getElementById("send").disabled'));
      const submit = text => page.evaluate(`document.getElementById('message').value=${JSON.stringify(text)}; document.getElementById('composer').requestSubmit()`);
      await submit('Implement A');
      assert.ok(await page.waitFor('document.getElementById("tasks").options.length === 2 && !document.getElementById("send").disabled'));
      const original = f.store.list('task')[0];
      await submit('Independent B');
      assert.ok(await page.waitFor('document.getElementById("tasks").options.length === 3 && !document.getElementById("send").disabled'));
      assert.equal(f.store.list('task').length, 2); assert.equal(f.sends.length, 2);
      f.statuses.set(original.sessionId, { busy: true, turnId: 't1', pending: { taskId: original.id, requestId: 'q1', turnId: 't1', question: 'Choose original', options: ['yes', 'no'] } });
      await page.evaluate(`document.getElementById('tasks').value=${JSON.stringify(original.id)}; document.getElementById('tasks').dispatchEvent(new Event('change'))`);
      assert.ok(await page.waitFor('document.getElementById("question-text").textContent === "Choose original"'));
      await page.evaluate('document.getElementById("answer").click()');
      f.statuses.set(original.sessionId, { busy: true, turnId: 't2', pending: { taskId: original.id, requestId: 'q2', turnId: 't2', question: 'New question' } });
      await submit('answer to old question');
      assert.ok(await page.waitFor('document.getElementById("notice").textContent.includes("another turn")'));
      assert.equal(f.sends.length, 2, 'stale answer must not start any execution');
      assert.ok(await page.waitFor('document.getElementById("question-text").textContent === "New question"'));
      await page.evaluate('document.getElementById("answer").click()');
      lose = true; await submit('answer to new question');
      assert.ok(await page.waitFor('!document.getElementById("retry").hidden && !document.getElementById("retry").disabled'));
      const before = f.sends.length;
      await page.evaluate('document.getElementById("retry").click()');
      assert.ok(await page.waitFor('document.getElementById("retry").hidden && !document.getElementById("send").disabled'));
      assert.equal(f.sends.length, before, 'response loss retry must not send again');
      f.histories.set(original.sessionId, [{ id: 'safe', role: 'assistant', content: '<img src=x onerror="window.pwned=true">', tools: [{ result: '<script>window.pwned=true</script>' }] }]);
      assert.ok(await page.waitFor('document.getElementById("history").textContent.includes("onerror") || document.querySelector("#history article img")'));
      assert.equal(await page.evaluate('window.pwned === true'), false);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= 390'), true);
      console.log('Task shell mobile screenshot:', await page.screenshot('task-shell-mobile'));
    });
  });
});
