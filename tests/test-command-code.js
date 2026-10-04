'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configure, deepseekConfig } = require('../scripts/configure-command-code');
const { createCommandCodeAdapter } = require('../src/cli-adapters/command-code');

test('DeepSeek 配置只保存环境变量引用，保留其他 Provider，重复执行幂等', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'command-code-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.commandcode'));
  const file = path.join(home, '.commandcode/providers.json');
  fs.writeFileSync(file, JSON.stringify({ provider: { existing: { apiKey: '$EXISTING_KEY' } }, other: true }));
  const env = { DEEPSEEK_API_KEY: '不得写入文件的测试值' };
  const result = configure({ home, env });
  const first = fs.readFileSync(file, 'utf8');
  configure({ home, env });
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.ok(!first.includes(env.DEEPSEEK_API_KEY));
  const config = JSON.parse(first);
  assert.equal(config.provider.existing.apiKey, '$EXISTING_KEY');
  assert.equal(config.provider.deepseek.apiKey, '$DEEPSEEK_API_KEY');
  assert.equal(config.provider.deepseek.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(result.model, 'deepseek/deepseek-flash');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => configure({ home, env }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('端点和模型覆盖有效，拒绝 URL 内嵌凭据', () => {
  const config = deepseekConfig({ DEEPSEEK_BASE_URL: 'http://localhost:1234/v1/', DEEPSEEK_FLASH_MODEL: 'custom-flash' });
  assert.equal(config.baseURL, 'http://localhost:1234/v1');
  assert.ok(config.models['custom-flash']);
  for (const url of ['https://user:secret@host/v1', 'https://host/?token=secret', 'file:///tmp/config']) {
    assert.throws(() => deepseekConfig({ DEEPSEEK_BASE_URL: url }));
  }
});

test('ACP 接入携带默认或显式模型与恢复 ID，认证失败不会变成成功', () => {
  const adapter = createCommandCodeAdapter({ cmd: '/opt/bin/command-code', env: {} });
  const envelope = { contextLayers: [], userText: '测试', suffix: '', rolePrompt: '' };
  // 与实际 envelope 一样保留 historyHandle 和 spawnOpts。
  envelope.historyHandle = { isFirstTurn: false, cliSessionId: 'native-id' };
  envelope.spawnOpts = { rawModel: null };
  const invocation = adapter.buildInvocation(envelope);
  assert.ok(invocation.args.includes('acp'));
  assert.ok(invocation.args.includes('deepseek/deepseek-flash'));
  assert.ok(invocation.args.includes('native-id'));
  envelope.spawnOpts.rawModel = 'deepseek/custom';
  assert.ok(adapter.buildInvocation(envelope).args.includes('deepseek/custom'));
  const events = adapter.decodeEvent({ method: 'multicc/error', params: { phase: 'session', message: 'Authentication required' } });
  assert.equal(events[0].type, 'error');
  assert.ok(!events.some(event => event.type === 'complete'));
  const { decideApiErrorPolicy } = require('../src/chat/api-error-policy');
  const verdict = decideApiErrorPolicy(events[0].error, { phase: 'before_first_token' });
  assert.equal(verdict.action, 'fail_fast');
  assert.equal(verdict.error.category, 'authentication_permission');
});

test('网页配置给出 DeepSeek 原生模型，不混入 Claude 候选', () => {
  const ai = require('../public/chat-ai-config');
  assert.deepEqual(ai.buildModelChoices('', { cli: 'commandcode', providers: [] }), ['', 'deepseek/deepseek-flash', '__custom__']);
  assert.deepEqual(ai.effortOptions('commandcode'), []);
});
