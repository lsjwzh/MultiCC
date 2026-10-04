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

test('原生 JSON 接入携带默认或显式模型与恢复 ID，认证失败不会变成成功', () => {
  const adapter = createCommandCodeAdapter({ cmd: '/opt/bin/command-code', env: {} });
  const envelope = { contextLayers: [], userText: '测试', suffix: '', rolePrompt: '' };
  // 与实际 envelope 一样保留 historyHandle 和 spawnOpts。
  envelope.historyHandle = { isFirstTurn: false, cliSessionId: 'native-id' };
  envelope.spawnOpts = { rawModel: null };
  const invocation = adapter.buildInvocation(envelope);
  assert.equal(invocation.cmd, '/opt/bin/command-code');
  assert.ok(invocation.args.includes('-p'));
  assert.ok(invocation.args.includes('deepseek/deepseek-flash'));
  assert.ok(invocation.args.includes('native-id'));
  envelope.spawnOpts.rawModel = 'deepseek/custom';
  assert.ok(adapter.buildInvocation(envelope).args.includes('deepseek/custom'));
  const events = adapter.decodeEvent({ type: 'error', message: 'Authentication required' });
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

test('真实事件形状：工具完成、增量不重复、终态不可由退出码伪造', () => {
  const a = createCommandCodeAdapter({ cmd: 'command-code', env: {} });
  const wrap = event => ({ type: 'event', event });
  assert.deepEqual(a.decodeEvent(wrap({ type: 'text_delta', delta: 'ok' })), [{type:'assistant_text',text:'ok',delta:true}]);
  assert.deepEqual(a.decodeEvent(wrap({ type: 'message_end', content: [{type:'text',text:'ok'}] })), []);
  assert.equal(a.decodeEvent(wrap({ type: 'tool_completed', toolCallId: 't', toolName: 'read_file', result: [] }))[0].completed, true);
  const tracker = a.createCompletionTracker();
  const raw = {type:'result',subtype:'success',stopReason:'end_turn',usage:{inputTokens:12,outputTokens:2}};
  tracker.observe(raw, a.decodeEvent(raw));
  assert.equal(tracker.finish({kind:'process',code:0}).state, 'completed');
  assert.equal(a.createCompletionTracker().finish({kind:'process',code:0}).state, 'unknown');
  const failed = a.createCompletionTracker();
  failed.observe({type:'error',message:'failed'});
  failed.observe(raw);
  assert.equal(failed.finish({kind:'process',code:0}).state,'failed');
});

test('思考按完成块记录一次，工具拒绝也必须结束日志卡', () => {
 const a=createCommandCodeAdapter({cmd:'command-code',env:{}});
 assert.deepEqual(a.decodeEvent({type:'event',event:{type:'thinking_delta',delta:'x'}}),[]);
 const thought=a.decodeEvent({type:'event',event:{type:'message_end',content:[{type:'thinking',thinking:'完整思考'}]}});
 assert.equal(thought.length,1);assert.equal(thought[0].completed,true);
 for(const type of ['tool_denied','tool_errored']) { const t=a.decodeEvent({type:'event',event:{type,toolCallId:'t',toolName:'shell_command'}})[0];assert.equal(t.completed,true);assert.equal(t.isError,true); }
});
