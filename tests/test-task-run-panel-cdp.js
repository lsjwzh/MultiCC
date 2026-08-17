'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  findChromeBinary,
  withCdpHarness,
} = require('./helpers/cdp-harness');

const ROOT = path.join(__dirname, '..');
const FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'task-run-panel.html'),
  'utf8',
);
const TASK_BOARD_UI = fs.readFileSync(
  path.join(ROOT, 'public', 'task-board-ui.js'),
  'utf8',
);

test('real Chrome renders durable TaskRun usage without exposing its internal slot', async t => {
  if (!findChromeBinary()) {
    t.skip('Chrome/Chromium is not installed; set MULTICC_CHROME_BIN to run this lane');
    return;
  }

  let harnessRoot = null;
  await withCdpHarness({
    screenshotDir: path.join(os.tmpdir(), 'multicc-cdp-failures'),
    routes: {
      '/task-run-panel.html': {
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: FIXTURE_HTML,
      },
      '/task-board-ui.js': {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
        body: TASK_BOARD_UI,
      },
      'POST /api/task-board/tasks/task-waiting/answer': {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ ok: true, taskId: 'task-waiting', taskRunId: 'run-waiting' }),
      },
    },
  }, async page => {
    harnessRoot = page.rootDir;
    await page.screenshotOnFailure('task-run-panel', async () => {
      await page.navigate('/task-run-panel.html');
      const rendered = await page.waitFor(
        'document.querySelectorAll(`[data-testid="task-run-summary"]`).length === 4',
      );
      assert.equal(rendered, true, 'the fixture must execute the production task-board-ui.js');

      const snapshot = await page.evaluate(`(() => {
        const byRun = id => document.querySelector('[data-run-id="' + id + '"]');
        const observed = byRun('run-observed');
        const unknown = byRun('run-unobservable');
        const cleanup = byRun('run-cleanup-error');
        return {
          observed: {
            state: observed && observed.dataset.state,
            total: observed && observed.querySelector('[data-testid="task-run-token-total"]')?.textContent.trim(),
            providerId: observed && observed.querySelector('[data-testid="task-run-provider"]')?.dataset.providerId,
            providerText: observed && observed.querySelector('[data-testid="task-run-provider"]')?.textContent,
            unknownDimensionText: observed && observed.querySelector('[data-provider-id="provider-main-unknown"]')?.textContent,
          },
          unknown: {
            state: unknown && unknown.dataset.state,
            total: unknown && unknown.querySelector('[data-testid="task-run-token-total"]')?.textContent.trim(),
            providerId: unknown && unknown.querySelector('[data-testid="task-run-provider"]')?.dataset.providerId,
            text: unknown && unknown.textContent,
          },
          cleanup: {
            state: cleanup && cleanup.dataset.state,
            cleanupState: cleanup && cleanup.dataset.cleanupState,
            text: cleanup && cleanup.querySelector('[data-testid="task-run-cleanup"]')?.textContent.trim(),
          },
          pendingQuestion: {
            count: document.querySelectorAll('[data-testid="task-run-pending-question"]').length,
            text: byRun('run-waiting')?.querySelector('.tb-run-question-text')?.textContent.trim(),
            options: [...document.querySelectorAll('[data-testid="task-run-answer-option"]')]
              .map(element => element.textContent.trim()),
          },
          chatLinks: document.querySelectorAll('a[href*="chat.html"], a[href*="session="]').length,
          panelHtml: document.getElementById('task-run-panel').innerHTML,
        };
      })()`);

      assert.deepEqual(snapshot.observed, {
        state: 'succeeded',
        total: '37 tokens',
        providerId: 'provider-a',
        providerText: snapshot.observed.providerText,
        unknownDimensionText: snapshot.observed.unknownDimensionText,
      });
      assert.match(snapshot.observed.providerText, /Provider A/);
      assert.match(snapshot.observed.providerText, /输入 10/);
      assert.match(snapshot.observed.providerText, /输出 4/);
      assert.match(snapshot.observed.unknownDimensionText, /Main Provider/);
      assert.match(snapshot.observed.unknownDimensionText, /未观测/);
      assert.doesNotMatch(snapshot.observed.unknownDimensionText, /输入\s*0|输出\s*0/);

      assert.equal(snapshot.unknown.state, 'failed');
      assert.equal(snapshot.unknown.total, '未观测');
      assert.equal(snapshot.unknown.providerId, 'provider-unknown');
      assert.match(snapshot.unknown.text, /Provider Unknown/);
      assert.match(snapshot.unknown.text, /opaque-model/);
      assert.doesNotMatch(snapshot.unknown.text, /\b0 tokens\b|输入\s*0/);

      assert.deepEqual(snapshot.cleanup, {
        state: 'succeeded', cleanupState: 'error', text: '待清理',
      });
      assert.deepEqual(snapshot.pendingQuestion, {
        count: 1, text: '请选择部署环境', options: ['生产', '预发'],
      });
      assert.equal(snapshot.chatLinks, 0);
      assert.doesNotMatch(snapshot.panelHtml,
        /internal-slot-must-stay-hidden|native-thread-must-stay-hidden|internal-answer-slot-must-stay-hidden|leaseEpoch/);

      await page.evaluate(`document.querySelector('[data-testid="task-run-answer-option"]').click()`);
      const resolved = await page.waitFor(
        'document.querySelector(`[data-testid="task-run-pending-question"]`)?.dataset.resolved === "1"',
      );
      assert.equal(resolved, true, 'clicking a single option must complete the task-scoped answer POST');
      const answerRequest = page.requests.find(request =>
        request.method === 'POST' && request.path === '/api/task-board/tasks/task-waiting/answer');
      assert.ok(answerRequest);
      const answerBody = JSON.parse(answerRequest.body);
      assert.equal(answerBody.requestId, 'usrq-cdp-1');
      assert.equal(answerBody.text, '生产');
      assert.match(answerBody.clientMsgId, /^tb-answer-/);
      assert.deepEqual(Object.keys(answerBody).sort(), ['clientMsgId', 'requestId', 'text']);

      assert.ok(page.requests.some(request => request.path === '/task-run-panel.html'));
      assert.ok(page.requests.some(request => request.path === '/task-board-ui.js'),
        'the page must fetch the real production helper rather than an inline copy');
    });
  });

  assert.ok(harnessRoot);
  assert.equal(fs.existsSync(harnessRoot), false,
    'the Chrome profile and fixture server scratch root are removed in finally');
});
