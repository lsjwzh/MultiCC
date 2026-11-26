'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPiAdapter, PI_THINKING_LEVELS } = require('../src/cli-adapters/pi');
const { processSpawnArgs } = require('../src/native/binding');
const adapter = createPiAdapter({ cmd: '/bin/pi', routerMcpNode: process.execPath, routerMcpScript: '/router.js' });
const envelope = overrides => ({ contextLayers: [], userText: 'Hello', suffix: '', systemPrompt: 'Role and image instructions',
  spawnOpts: { rawModel: 'openai/test', rawEffort: 'high' }, historyHandle: { isFirstTurn: true }, ...overrides });
const assistant = (stopReason = 'stop', usage = {}) => ({ role: 'assistant', stopReason, usage });

test('Pi JSON invocation resumes only its explicit native session and preserves literal prompts', () => {
  const first = adapter.buildInvocation(envelope());
  assert.deepEqual(first.args.slice(0, 3), ['--mode', 'json', '--print']);
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'openai/test');
  assert.equal(first.args[first.args.indexOf('--append-system-prompt') + 1], 'Role and image instructions');
  assert.ok(first.args.includes('--extension'));
  assert.ok(first.args.includes('--multicc-router-node'));
  assert.ok(!first.args.includes('--session'));
  const resumed = adapter.buildInvocation(envelope({ historyHandle: { isFirstTurn: false, cliSessionId: 'uuid' } }));
  assert.equal(resumed.args[resumed.args.indexOf('--session') + 1], 'uuid');
  const missing = adapter.buildInvocation(envelope({ historyHandle: { isFirstTurn: false } }));
  assert.ok(!missing.args.includes('--continue'));
  for (const prompt of ['--help', '@private.txt', '-p']) {
    const invocation = adapter.buildInvocation(envelope({ userText: prompt }));
    assert.equal(processSpawnArgs(invocation).at(-1), `\n${prompt}`);
  }
  for (const effort of PI_THINKING_LEVELS) {
    const invocation = adapter.buildInvocation(envelope({ spawnOpts: { rawEffort: effort } }));
    assert.equal(invocation.args[invocation.args.indexOf('--thinking') + 1], effort);
  }
});

test('Pi decodes session, streaming text, thinking snapshots, and tool results without duplicate text', () => {
  assert.deepEqual(adapter.decodeEvent({ type: 'session', id: 'native-id' }), [{ type: 'session_started', sessionId: 'native-id' }]);
  assert.deepEqual(adapter.decodeEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
    [{ type: 'assistant_text', text: 'hello', delta: true }]);
  assert.deepEqual(adapter.decodeEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }), []);
  const thinking = adapter.decodeEvent({ type: 'message_update', message: { timestamp: 123, content: [{ type: 'thinking', thinking: 'Full thought' }] },
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 } })[0];
  assert.equal(thinking.text, 'Full thought');
  assert.equal(thinking.snapshot, true);
  assert.equal(thinking.completed, true);
  assert.equal(adapter.decodeEvent({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: '/a' } })[0].input.path, '/a');
  assert.deepEqual(adapter.decodeEvent({ type: 'tool_execution_end', toolCallId: 't1', isError: true, result: { content: [{ type: 'text', text: 'missing' }] } }),
    [{ type: 'tool_result', id: 't1', content: 'missing', isError: true }]);
});

test('Pi totals all assistant calls in an agent turn including cache usage', () => {
  const decoded = adapter.decodeEvent({ type: 'agent_end', messages: [
    assistant('toolUse', { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, cost: { total: 0.1 } }),
    { role: 'toolResult' }, assistant('stop', { input: 20, output: 4, cost: { total: 0.2 } }),
  ] })[0];
  assert.deepEqual(decoded.usage, { input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });
  assert.ok(Math.abs(decoded.cost - 0.3) < 1e-9);
});

test('Pi exposes final error details without treating a scheduled retry or cancellation as a provider failure', () => {
  const message = { ...assistant('error'), errorMessage: 'HTTP 429: rate limit exceeded' };
  for (const willRetry of [true, undefined]) {
    assert.equal(adapter.decodeEvent({ type: 'agent_end', messages: [message], willRetry }).some(event => event.type === 'error'), false);
  }
  const failure = adapter.decodeEvent({ type: 'agent_end', messages: [message], willRetry: false });
  assert.equal(failure[0].type, 'error');
  assert.match(failure[0].message, /rate limit/);
  assert.equal(failure[0].error.source, 'pi_event');
  assert.equal(failure[0].error.httpStatus, 429);
  assert.equal(failure.at(-1).type, 'complete');
  assert.match(adapter.decodeEvent({ type: 'agent_end', messages: [assistant('length')], willRetry: false })[0].message, /长度限制/);
  assert.deepEqual(adapter.decodeEvent({ type: 'agent_end', messages: [assistant('aborted')], willRetry: false }).map(event => event.type), ['complete']);
  const retryError = adapter.decodeEvent({ type: 'auto_retry_end', success: false, finalError: 'No API key configured' })[0];
  assert.equal(retryError.error.source, 'pi_event');
  assert.equal(retryError.message, 'No API key configured');
});

test('Pi completion requires native stop plus clean exit; retries can recover, budgets and abort cannot pass', () => {
  for (const [reason, expected] of [['stop', 'completed'], ['error', 'failed'], ['length', 'failed'], ['aborted', 'cancelled'], ['toolUse', 'failed']]) {
    const tracker = adapter.createCompletionTracker();
    tracker.observe({ type: 'agent_end', messages: [assistant(reason)] });
    assert.equal(tracker.finish({ kind: 'process', code: 0 }).state, expected);
  }
  const retry = adapter.createCompletionTracker();
  retry.observe({ type: 'agent_end', messages: [assistant('error')] });
  retry.observe({ type: 'auto_retry_start' });
  retry.observe({ type: 'agent_end', messages: [assistant()] });
  assert.equal(retry.finish({ kind: 'process', code: 0 }).state, 'completed');
  const missing = adapter.createCompletionTracker();
  assert.equal(missing.finish({ kind: 'process', code: 0 }).state, 'unknown');
  const killed = adapter.createCompletionTracker();
  killed.observe({ type: 'agent_end', messages: [assistant()] });
  assert.equal(killed.finish({ kind: 'process', code: 0, killReason: 'user_stop' }).state, 'cancelled');
  const failed = adapter.createCompletionTracker();
  failed.observe({ type: 'agent_end', messages: [assistant()] });
  assert.equal(failed.finish({ kind: 'process', code: 1 }).state, 'failed');
  const unfinished = adapter.createCompletionTracker();
  unfinished.observe({ type: 'tool_execution_start' }, [{ type: 'tool_start', id: 'pending' }]);
  unfinished.observe({ type: 'agent_end', messages: [assistant()] });
  assert.equal(unfinished.finish({ kind: 'process', code: 0 }).reason, 'pi_pending_tools');
  const exhausted = adapter.createCompletionTracker();
  exhausted.observe({ type: 'agent_end', messages: [assistant('error')] });
  exhausted.observe({ type: 'auto_retry_end', success: false });
  assert.equal(exhausted.finish({ kind: 'process', code: 0 }).reason, 'pi_retry_exhausted');
});

test('Pi router cancellation and timeout notify MCP; shutdown rejects requests and reaps a stubborn child', async t => {
  const { createRouterClient } = await import(pathToFileURL(path.resolve(__dirname, '../src/cli-adapters/pi-router-extension.mjs')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-pi-cancel-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'router.cjs');
  fs.writeFileSync(fake, `const rl=require('readline').createInterface({input:process.stdin});
const cancelled=[];process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='notifications/cancelled')cancelled.push(m.params);
if(m.method==='inspect')process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid,cancelled}})+'\\n');
});`);
  const client = createRouterClient(process.execPath, fake, { timeoutMs: 1000, shutdownGraceMs: 30 });
  t.after(() => client.close());
  const { pid } = await client.request('inspect', {});
  const abort = new AbortController();
  const pending = client.request('hang', {}, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(client.request('hang', {}, { timeout: 10 }), /timed out/);
  const inspection = await client.request('inspect', {});
  assert.deepEqual(inspection.cancelled.map(item => item.reason), ['MultiCC tool cancelled', 'MultiCC router request timed out']);
  assert.equal(new Set(inspection.cancelled.map(item => item.requestId)).size, 2);
  await assert.rejects(client.request('hang', {}, { signal: abort.signal }), /cancelled/);
  const closing = client.request('hang', {});
  client.close();
  client.close();
  await assert.rejects(closing, /closed/);
  await assert.rejects(client.request('inspect', {}), /closed/);
  let alive = true;
  for (let i = 0; alive && i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  }
  assert.equal(alive, false, 'router child must exit after shutdown grace');
});

test('Pi router reports spawn failure and clears pending requests', async () => {
  const { createRouterClient } = await import(pathToFileURL(path.resolve(__dirname, '../src/cli-adapters/pi-router-extension.mjs')).href);
  const client = createRouterClient(path.join(os.tmpdir(), 'multicc-pi-nonexistent-command'), '/missing.js');
  try { await assert.rejects(client.initialize(), /could not start/); }
  finally { client.close(); }
});

test('Pi router extension registers real JSON schemas and forwards calls, tool errors, and cancellation', async t => {
  const module = await import(pathToFileURL(path.resolve(__dirname, '../src/cli-adapters/pi-router-extension.mjs')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-pi-router-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'router.cjs');
  fs.writeFileSync(fake, `const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line); const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
if(m.method==='initialize') reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}});
if(m.method==='tools/list') reply({tools:[{name:'wait_for_user_answer',description:'Ask user',inputSchema:{type:'object',required:['question'],properties:{question:{type:'string'}}}}]});
if(m.method==='tools/call' && m.params.arguments.question!=='hang') reply({content:[{type:'text',text:m.params.arguments.question}],isError:m.params.arguments.question==='fail'});
});`);
  const hooks = {};
  const tools = [];
  const oldUrl = process.env.MULTICC_BASE_URL;
  const oldCapability = process.env.MULTICC_ROUTER_CAPABILITY;
  process.env.MULTICC_BASE_URL = 'http://localhost/test';
  process.env.MULTICC_ROUTER_CAPABILITY = 'test-only';
  t.after(() => {
    if (oldUrl === undefined) delete process.env.MULTICC_BASE_URL; else process.env.MULTICC_BASE_URL = oldUrl;
    if (oldCapability === undefined) delete process.env.MULTICC_ROUTER_CAPABILITY; else process.env.MULTICC_ROUTER_CAPABILITY = oldCapability;
    hooks.session_shutdown?.();
  });
  module.default({ registerFlag() {}, getFlag(name) { return name.endsWith('node') ? process.execPath : fake; },
    on(name, handler) { hooks[name] = handler; }, registerTool(tool) { tools.push(tool); } });
  await hooks.session_start();
  assert.equal(tools[0].name, 'mcp__multicc_router__wait_for_user_answer');
  assert.deepEqual(tools[0].parameters.required, ['question']);
  assert.equal((await tools[0].execute('t', { question: 'hello' })).content[0].text, 'hello');
  await assert.rejects(tools[0].execute('t', { question: 'fail' }), /fail/);
  const abort = new AbortController();
  const pending = tools[0].execute('t', { question: 'hang' }, abort.signal);
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  await hooks.session_shutdown();
});
