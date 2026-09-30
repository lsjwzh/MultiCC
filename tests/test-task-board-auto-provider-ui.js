'use strict';

// 旧管理台任务板那个合成器（public/manage-taskboard.js）随 /manage.html 一起删了，
// 它的 DOM 沙箱 harness 和挂在上面的八条用例也一并退场。这里留下的是与那块 DOM
// 无关的两条：Auto 候选的默认与提交顺序，被测对象是 public/auto-provider-editor.js。
// 合成器本体的行为覆盖现在归 Air 那一侧（tests/test-auto-provider-editor.js 与
// tests/test-chat-ai-config.js，它们测的是同一个共享编辑器）。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('task board Auto provider defaults to the first two managed routes', () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'official', name: 'Official', protocol: 'anthropic', isOfficial: true },
    { id: 'managed-a', name: 'Managed A', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', name: 'Managed B', protocol: 'anthropic', model: 'model-b' },
    { id: 'managed-c', name: 'Managed C', protocol: 'anthropic', model: 'model-c' },
    { id: 'chat-only', name: 'Chat', protocol: 'openai_chat', model: 'chat-model' },
  ];

  assert.deepEqual(editor.defaultSelection(providers, 'anthropic'), {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true },
      { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: true },
    ],
    maxAttempts: 2,
    sticky: true,
    allowCrossTrust: false,
  });
  assert.equal(editor.defaultSelection([
    providers[0], providers[1], providers[4],
  ], 'anthropic'), null, 'Official is visible in the editor but never silently fills the managed default');
});

test('task board Auto provider preserves the committed enabled order and models', () => {
  const editor = require('../public/auto-provider-editor');
  const providers = [
    { id: 'managed-a', protocol: 'anthropic', model: 'model-a' },
    { id: 'managed-b', protocol: 'anthropic', model: 'model-b' },
    { id: 'managed-c', protocol: 'anthropic', model: 'model-c' },
  ];
  const result = editor.serializeDraft({
    protocol: 'anthropic',
    providers,
    candidates: [
      { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: false },
      { providerId: 'managed-b', model: 'model-b-override', priority: 20, enabled: true },
      { providerId: 'managed-c', model: null, priority: 5, enabled: true },
    ],
    maxAttempts: 4,
    sticky: true,
    crossTrustConfirmed: false,
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'managed-c', model: null, priority: 5, enabled: true },
      { providerId: 'managed-b', model: 'model-b-override', priority: 20, enabled: true },
    ],
    maxAttempts: 2,
    sticky: true,
    allowCrossTrust: false,
  });

  const tooSmall = editor.serializeDraft({
    protocol: 'anthropic',
    providers,
    candidates: [
      { providerId: 'managed-a', model: 'model-a', priority: 1, enabled: true },
      { providerId: 'managed-b', model: 'model-b', priority: 2, enabled: false },
    ],
  });
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.code, 'insufficient_candidates');
});

test('Air loads the shared Auto provider editor before the surfaces that mount it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'air.html'), 'utf8');
  const editor = html.indexOf('<script src="auto-provider-editor.js"></script>');
  const settings = html.indexOf('<script src="air-task-settings.js"></script>');
  const aiConfig = html.indexOf('<script src="chat-ai-config.js"></script>');
  assert.ok(editor > 0 && editor < settings, 'the editor must load before air-task-settings.js');
  assert.ok(editor < aiConfig, 'the editor must load before chat-ai-config.js');
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+auto-provider-editor/i);
  // The production picker path mounts the shared editor rather than keeping a
  // surface-local copy of the candidate UI.
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'air-task-settings.js'), 'utf8');
  assert.match(settingsSrc, /MultiCCAutoProviderEditor/);
});
