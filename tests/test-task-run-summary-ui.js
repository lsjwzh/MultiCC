'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const taskBoardUi = require('../public/task-board-ui');

function observedRun(overrides = {}) {
  return {
    runId: 'run-observed',
    executionStatus: 'succeeded',
    usageStatus: 'sealed',
    cleanupState: 'done',
    slotId: 'slot-internal-1',
    usage: {
      coverage: 'observed',
      hasKnownUsage: true,
      tokens: {
        freshInput: 10,
        cacheRead: 20,
        cacheWrite: 3,
        consumedInput: 33,
        output: 4,
        reasoning: 2,
        total: 37,
      },
      dimensions: [{
        providerId: 'provider-a',
        providerName: 'Provider A',
        model: 'model-a',
        roleKind: 'main',
        routeName: 'main',
        observedEvents: 1,
        unobservableEvents: 0,
        freshInput: 10,
        cacheRead: 20,
        cacheWrite: 3,
        output: 4,
        reasoning: 2,
      }],
    },
    ...overrides,
  };
}

test('renderTaskRunSummary renders exact observed usage with stable data hooks', () => {
  const html = taskBoardUi.renderTaskRunSummary(observedRun());
  assert.match(html, /data-testid="task-run-summary"/);
  assert.match(html, /data-run-id="run-observed"/);
  assert.match(html, /data-state="succeeded"/);
  assert.match(html, /data-testid="task-run-token-total"[^>]*>37 tokens</);
  assert.match(html, /data-testid="task-run-provider"/);
  assert.match(html, /data-provider-id="provider-a"/);
  assert.match(html, /Provider A/);
  assert.match(html, /model-a/);
  assert.match(html, /输入 10/);
  assert.match(html, /缓存读 20/);
  assert.match(html, /缓存写 3/);
  assert.match(html, /输出 4/);
  assert.match(html, /推理 2/);
});

test('renderTaskRunSummary renders unobservable usage as unknown instead of zero', () => {
  const html = taskBoardUi.renderTaskRunSummary(observedRun({
    runId: 'run-unknown',
    executionStatus: 'failed',
    usageStatus: 'unobservable',
    usage: {
      coverage: 'unobservable',
      hasKnownUsage: false,
      tokens: null,
      dimensions: [{
        providerId: 'provider-unknown',
        providerName: 'Provider Unknown',
        model: 'opaque-model',
      }],
    },
  }));
  assert.match(html, /data-run-id="run-unknown"/);
  assert.match(html, /data-usage-status="unobservable"/);
  assert.match(html, /data-testid="task-run-token-total"[^>]*>未观测</);
  assert.match(html, /data-provider-id="provider-unknown"/);
  assert.match(html, /Provider Unknown/);
  assert.match(html, /opaque-model/);
  assert.doesNotMatch(html, />\s*0 tokens</);
  assert.doesNotMatch(html, /输入 0/);
});

test('renderTaskRunSummary keeps an unobservable dimension unknown inside a partially observed run', () => {
  const html = taskBoardUi.renderTaskRunSummary(observedRun({
    usage: {
      coverage: 'partial',
      hasKnownUsage: true,
      tokens: { freshInput: 7, cacheRead: 0, cacheWrite: 0, output: 2, total: 9 },
      dimensions: [
        {
          providerId: 'provider-sub', providerName: 'Sub Provider', model: 'sub-model',
          observedEvents: 1, unobservableEvents: 0, freshInput: 7, output: 2,
        },
        {
          providerId: 'provider-main-unknown', providerName: 'Main Provider', model: 'main-model',
          observedEvents: 0, unobservableEvents: 1,
          freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
        },
      ],
    },
  }));
  const main = html.match(/<div class="tb-run-provider"[^>]*data-provider-id="provider-main-unknown"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(main, /Main Provider/);
  assert.match(main, /未观测/);
  assert.doesNotMatch(main, /输入 0|输出 0/);
});

test('renderTaskRunSummary exposes cleanup errors as pending cleanup', () => {
  const html = taskBoardUi.renderTaskRunSummary(observedRun({
    runId: 'run-cleanup-error',
    cleanupState: 'error',
  }));
  assert.match(html, /data-cleanup-state="error"/);
  assert.match(html, /data-testid="task-run-cleanup"[^>]*>待清理</);
});

test('renderTaskRunSummary renders a safe answer form without an execution-slot link', () => {
  const html = taskBoardUi.renderTaskRunSummary(observedRun({
    runId: 'run-waiting',
    executionStatus: 'running',
    slotId: '/chat.html?session=internal-answer-slot',
    leaseEpoch: 77,
    pendingQuestion: {
      requestId: 'usrq-1',
      question: '发布到 <生产> 还是预发？',
      reason: '<img src=x onerror=alert(1)>',
      options: ['生产', '预发"><script>alert(1)</script>'],
      allowMultiple: false,
      createdAt: 10,
      slotId: 'nested-internal-slot',
    },
  }));
  assert.match(html, /data-testid="task-run-pending-question"/);
  assert.match(html, /data-request-id="usrq-1"/);
  assert.match(html, /发布到 &lt;生产&gt; 还是预发？/);
  assert.match(html, /data-testid="task-run-answer-option"/);
  assert.match(html, /data-testid="task-run-answer-text"/);
  assert.match(html, /data-testid="task-run-answer-submit"/);
  assert.doesNotMatch(html, /<script|<img|internal-answer-slot|nested-internal-slot|leaseEpoch/i);
  assert.doesNotMatch(html, /<a\b|chat\.html/i);
  assert.equal(typeof taskBoardUi.bindPendingQuestionAnswers, 'function');
});

test('renderTaskRunSummary escapes provider and run fields and never links an internal slot', () => {
  const html = taskBoardUi.renderTaskRunSummary(observedRun({
    runId: 'run"><img src=x onerror=alert(1)>',
    slotId: '/chat.html?session=secret-slot',
    nativeSessionId: 'secret-native-thread',
    usage: {
      coverage: 'observed',
      hasKnownUsage: true,
      tokens: { freshInput: 1, cacheRead: 0, cacheWrite: 0, output: 1, total: 2 },
      dimensions: [{
        providerId: 'provider"><script>alert(1)</script>',
        providerName: '<img src=x onerror=alert(1)>',
        model: 'model&danger',
        observedEvents: 1,
        freshInput: 1,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        reasoning: 0,
      }],
    },
  }));
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /model&amp;danger/);
  assert.doesNotMatch(html, /<a\b|\/chat\.html|secret-slot|secret-native-thread/i);
});

test('recentTaskRuns accepts rolling-upgrade aliases, sorts newest first and caps at five', () => {
  const runs = Array.from({ length: 7 }, (_, index) => ({
    runId: `run-${index + 1}`,
    startedAt: index + 1,
  }));
  assert.deepEqual(
    taskBoardUi.recentTaskRuns({ recentRuns: runs }).map(run => run.runId),
    ['run-7', 'run-6', 'run-5', 'run-4', 'run-3'],
  );
  assert.deepEqual(
    taskBoardUi.recentTaskRuns({ taskRuns: runs.slice(0, 2) }).map(run => run.runId),
    ['run-2', 'run-1'],
  );
  assert.deepEqual(taskBoardUi.recentTaskRuns({}), []);
});

test('manage task detail embeds at most five durable runs without exposing execution slots', () => {
  const content = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const context = vm.createContext({
    console,
    window: {
      MultiCCTaskBoardUi: taskBoardUi,
      MultiCCStatusPresentation: require('../public/status-presentation.js'),
    },
    document: {
      getElementById: id => id === 'tb-detail-content' ? content : null,
      createElement: () => ({}),
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
    },
    fetch: async () => ({ json: async () => ({ ok: false }) }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'manage-taskboard.js'), 'utf8'),
    context,
  );
  const runs = Array.from({ length: 7 }, (_, index) => ({
    runId: `run-${index + 1}`,
    startedAt: index + 1,
    executionStatus: index === 6 ? 'succeeded' : 'failed',
    usageStatus: index === 5 ? 'unobservable' : 'sealed',
    cleanupState: index === 4 ? 'error' : 'done',
    taskExecutionSlot: `/chat.html?session=internal-slot-${index + 1}`,
    usage: index === 5 ? {
      coverage: 'unobservable', hasKnownUsage: false, tokens: null, dimensions: [],
    } : {
      coverage: 'observed', hasKnownUsage: true,
      tokens: { freshInput: index + 1, output: 1, total: index + 2 },
      dimensions: [{
        providerId: `provider-${index + 1}`,
        providerName: `Provider ${index + 1}`,
        model: `model-${index + 1}`,
        observedEvents: 1,
        freshInput: index + 1,
        output: 1,
      }],
    },
  }));
  context.detail = {
    task: {
      id: 'task-runs', moduleId: 'mod-1', title: '执行历史', status: 'active',
      runState: 'succeeded', sessionIds: [], areas: [], refCount: 1,
    },
    items: [{
      sessionId: null,
      sessionLabel: '临时执行',
      taskRunId: 'run-7',
      messageId: 'task-run-message-1',
      role: 'assistant',
      ts: 8,
      text: 'durable result',
    }],
    recentRuns: runs,
  };
  vm.runInContext('renderTaskBoardDetail(detail)', context);

  assert.equal((content.innerHTML.match(/data-testid="task-run-summary"/g) || []).length, 5);
  assert.match(content.innerHTML, /data-run-id="run-7"/);
  assert.match(content.innerHTML, /data-run-id="run-3"/);
  assert.doesNotMatch(content.innerHTML, /data-run-id="run-[12]"/);
  assert.ok(content.innerHTML.indexOf('run-7') < content.innerHTML.indexOf('run-6'));
  assert.match(content.innerHTML, />未观测</);
  assert.match(content.innerHTML, /data-cleanup-state="error"[\s\S]*?>待清理</);
  assert.match(content.innerHTML, /临时执行/);
  assert.doesNotMatch(content.innerHTML, /internal-slot|\/chat\.html|<a\b/i);

  context.detail = { ...context.detail, recentRuns: undefined };
  vm.runInContext('renderTaskBoardDetail(detail)', context);
  assert.doesNotMatch(content.innerHTML, /data-testid="task-run-history"/);
});

test('both web task panels bind the task-scoped answer endpoint', () => {
  for (const file of ['public/manage-taskboard.js', 'public/meta.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /bindPendingQuestionAnswers/);
    assert.match(source,
      /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(t\.id\)\}\/answer/);
    assert.doesNotMatch(source,
      /pendingQuestion[\s\S]{0,300}(?:chat\.html|sessionChatUrl)/,
      'TaskRun questions answer in place and never navigate to an internal chat',
    );
  }
});
