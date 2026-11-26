'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createCodexAppStream } = require('../src/chat/codex-app-stream');

// 显式运行的原生契约验证：隔离 HOME、CODEX_HOME，模型响应全部来自本地测试上游。
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-real-child-progress-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
const calls = new Map();
const events = [];
const stream = createCodexAppStream();
let sequence = 0;
let finishChildren;
const allChildren = new Promise(resolve => { finishChildren = resolve; });

function sse(res, output) {
  const response = {
    id: `resp_${++sequence}`, object: 'response', status: 'completed', model: 'gpt-5.5', output,
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  output.forEach((item, output_index) => {
    emit('response.output_item.added', { output_index, item });
    emit('response.output_item.done', { output_index, item });
  });
  emit('response.completed', { response });
  res.end();
}

function message(text) {
  return [{ type: 'message', id: `msg_${sequence}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }];
}

function respond(body, res) {
  const user = (body.input || []).filter(item => item.role === 'user').at(-1);
  const userText = Array.isArray(user?.content)
    ? user.content.map(item => item.text || '').join('') : String(user?.content || '');
  const key = /子任务 [12]：运行本地进度验证/.test(userText) ? userText : 'main';
  const call = (calls.get(key) || 0) + 1;
  calls.set(key, call);
  if (key === 'main' && call === 1) {
    return sse(res, [{ type: 'tool_search_call', id: 'search-item', call_id: 'search-call',
      execution: 'client', arguments: { query: 'spawn_agent', limit: 1 }, status: 'completed' }]);
  }
  if (key === 'main' && call === 2) {
    const tools = (body.input || []).filter(item => item.type === 'tool_search_output')
      .flatMap(item => item.tools || []);
    const namespace = tools.find(tool => tool.tools?.some(item => item.name === 'spawn_agent'));
    assert.ok(namespace, '应找到原生创建子 Agent 的工具');
    return sse(res, [1, 2].map(index => ({ type: 'function_call', id: `spawn-item-${index}`,
      call_id: `spawn-call-${index}`, name: 'spawn_agent', namespace: namespace.name,
      arguments: JSON.stringify({ message: `子任务 ${index}：运行本地进度验证` }) })));
  }
  if (key !== 'main' && call === 1) {
    return sse(res, [{ type: 'function_call', id: 'exec-item', call_id: 'exec-call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: "node -e 'setTimeout(()=>console.log(123),1600)'", yield_time_ms: 10000 }) }]);
  }
  return sse(res, message(key === 'main' ? '主线程验证完成' : '子线程验证完成'));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try { respond(JSON.parse(Buffer.concat(chunks)), res); }
    catch (_) { res.writeHead(500); res.end('本地验证上游失败'); }
  });
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const configs = [
    'model="gpt-5.5"', 'model_provider="mock"', 'model_providers.mock.name="本地验证"',
    `model_providers.mock.base_url="http://127.0.0.1:${port}/v1"`,
    'model_providers.mock.wire_api="responses"', 'model_providers.mock.requires_openai_auth=false',
    'features.multi_agent=true',
  ];
  stream.ensure('real-probe', {
    cmd: require('../src/native/binding').gatewayPath(), cwd: root, streamBackend: 'app-server',
    baseArgs: ['codex-app-bridge', '--codex-bin', 'codex',
      '--resident', ...configs.flatMap(config => ['--config', config])],
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home },
    onBackgroundEvent(event) {
      events.push(event);
      if (events.filter(item => item.subtype === 'codex_task_done' && item.kind === 'agent').length >= 2) finishChildren();
    },
  });
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('原生子任务验证超时')), 25000);
  });
  try {
    const mainEvents = [];
    await Promise.race([stream.send('real-probe', '验证两个并行子任务的执行进度', event => mainEvents.push(event)), deadline]);
    assert.equal(stream.status('real-probe').backgroundActive, true, '主回合结束后，子任务应继续存活');
    const mainId = stream.status('real-probe').threadId;
    await Promise.race([allChildren, deadline]);
    const starts = events.filter(event => event.subtype === 'codex_task_started' && event.kind === 'agent');
    assert.equal(new Set(starts.map(event => event.task_id)).size, 2);
    assert.ok(events.some(event => event.subtype === 'codex_task_progress' && /执行命令/.test(event.description)));
    assert.ok(events.filter(event => event.subtype === 'codex_task_done' && event.kind === 'agent')
      .every(event => event.status === 'completed'));
    assert.equal(stream.status('real-probe').threadId, mainId);
    assert.equal(mainEvents.filter(event => event.method === 'turn/completed').length, 1);
    console.log('原生并行验证通过：两个真实子线程、内部命令进度、独立完成、主线程身份保持。');
  } finally {
    clearTimeout(timeout);
    await stream.closeAndWait('real-probe');
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(`原生验证失败：${error.message}`); process.exitCode = 1; });
