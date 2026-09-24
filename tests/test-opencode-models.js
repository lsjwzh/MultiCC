'use strict';

// GET /api/opencode/models — the configured providers lead the list, but they
// must not hide OpenCode's own preset providers. A user who configured the
// OpenCode Go plan (`opencodego`) in opencode.json used to lose every
// `opencode/*` (OpenCode Zen) model from the picker, because the config file
// short-circuited the CLI listing entirely.

const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeOpenCodeModels, parseOpenCodeStdout } = require('../src/routes/opencode-models.js');

const CLI = parseOpenCodeStdout([
  'opencode/big-pickle',
  'opencode/nemotron-3-ultra-free',
  'opencodego/glm-5.2',
  'opencodego/some-cli-only-model',
  'openrouter/~anthropic/claude-sonnet-latest',
  'deepseek/deepseek-chat',
].join('\n'));
const CONFIGURED = [{ provider: 'opencodego', model: 'glm-5.2', label: 'opencodego/glm-5.2 (GLM 5.2)' }];

test('OpenCode Zen presets are merged after the configured providers', () => {
  const labels = mergeOpenCodeModels(CONFIGURED, CLI).map(m => `${m.provider}/${m.model}`);
  assert.deepEqual(labels, ['opencodego/glm-5.2', 'opencode/big-pickle', 'opencode/nemotron-3-ultra-free']);
});

test('providers signed in through `opencode auth login` are kept too', () => {
  const labels = mergeOpenCodeModels(CONFIGURED, CLI, new Set(['deepseek'])).map(m => `${m.provider}/${m.model}`);
  assert.ok(labels.includes('deepseek/deepseek-chat'));
  assert.ok(!labels.some(label => label.startsWith('openrouter/')), 'unselected catalog providers stay out');
});

test('a configured provider keeps only its configured models', () => {
  const labels = mergeOpenCodeModels(CONFIGURED, CLI).map(m => `${m.provider}/${m.model}`);
  assert.ok(!labels.includes('opencodego/some-cli-only-model'));
});

test('without configured providers the full CLI listing is used', () => {
  assert.equal(mergeOpenCodeModels([], CLI).length, CLI.length);
});
