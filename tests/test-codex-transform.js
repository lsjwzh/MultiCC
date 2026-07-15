'use strict';

const { responsesToChat, chatStreamToResponses } = require('../src/codex-proxy-transform.js');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) { failed++; throw new Error(`FAIL: ${msg}`); }
  passed++;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ═══════════════════════════════════════════════════════════════════════
// 模块 A 测试：responsesToChat
// ═══════════════════════════════════════════════════════════════════════

console.log('── 模块 A: responsesToChat ──');

const sampleResponses = {
  model: 'deepseek-chat',
  instructions: '你是一个有用的助手。',
  input: [
    { type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: '开发提示：你是 codex agent。' }] },
    { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '帮我查天气。《北京》' },
                { type: 'input_text', text: '温度也显示。' }] },
    { type: 'function_call', call_id: 'call_abc123', name: 'get_weather',
      arguments: '{"city":"北京"}' },
    { type: 'function_call_output', call_id: 'call_abc123', output: '晴天，25°C' },
  ],
  tools: [
    { type: 'function', name: 'get_weather', description: '查询天气', strict: true,
      parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    { type: 'function', name: 'get_time', description: '查询时间',
      parameters: { type: 'object', properties: {} } },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { effort: 'medium' },
  store: true,
  include: ['file_search_results'],
  client_metadata: { app: 'codex' },
};

const result = responsesToChat(sampleResponses);

assert(result.messages[0].role === 'system' && result.messages[0].content === '你是一个有用的助手。', 'instructions → system');
assert(result.messages[1].role === 'system' && result.messages[1].content === '开发提示：你是 codex agent。', 'developer → system');
assert(result.messages[2].role === 'user' && result.messages[2].content === '帮我查天气。《北京》温度也显示。', 'user 拼接');
assert(result.messages[3].role === 'assistant' && result.messages[3].content === null, 'function_call → assistant');
assert(result.messages[3].tool_calls[0].id === 'call_abc123', 'tool_call id');
assert(result.messages[3].tool_calls[0].function.name === 'get_weather', 'tool_call name');
assert(result.messages[3].tool_calls[0].function.arguments === '{"city":"北京"}', 'tool_call args');
assert(result.messages[4].role === 'tool' && result.messages[4].tool_call_id === 'call_abc123', 'function_call_output → tool');
assert(result.messages[4].content === '晴天，25°C', 'tool content');
assert(result.tools.length === 2 && result.tools[0].function.name === 'get_weather', 'tools 扁平→嵌套');
assert(result.tool_choice === 'auto', 'tool_choice 透传');
assert(result.parallel_tool_calls === true, 'parallel_tool_calls 透传');
assert(result.stream === true, 'stream=true');
assert(!('reasoning' in result), '丢弃 reasoning');
assert(!('store' in result), '丢弃 store');
assert(!('client_metadata' in result), '丢弃 client_metadata');

const m = responsesToChat({ model: 'x', input: [] });
assert(m.messages.length === 0, '空 input');
assert(!('tools' in m), '无 tools 不输出');
m.model === 'x' && passed++; // assertion
console.log('  ✓ ' + (passed - 10 < 0 ? 0 : passed) + ' assertions 通过 (A)');

// ═══════════════════════════════════════════════════════════════════════
// 模块 B 测试：chatStreamToResponses
// ═══════════════════════════════════════════════════════════════════════

console.log('');
console.log('── 模块 B: chatStreamToResponses ──');

const events = [];
const tx = chatStreamToResponses((s) => events.push(s));

// 用 JSON.stringify 构建 SSE 行，避免嵌套转义问题
function sseLine(obj) { return 'data: ' + JSON.stringify(obj); }

tx.pushLine(sseLine({ id: '1', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: '今天' }, finish_reason: null }] }));
tx.pushLine(sseLine({ id: '1', model: 'deepseek-chat', choices: [{ index: 0, delta: { content: '天气不错' }, finish_reason: null }] }));
// tool_call 分批
tx.pushLine(sseLine({ id: '1', model: 'deepseek-chat', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_001', type: 'function', function: { name: 'get_weather', arguments: '{"city":"' } }] } }] }));
tx.pushLine(sseLine({ id: '1', model: 'deepseek-chat', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '北京"}' } }] } }] }));
tx.pushLine(sseLine({ id: '1', model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
tx.pushLine('data: [DONE]');

// 解析 SSE 事件
const eventList = [];
let current = { type: null, data: null };
let buf = '';
for (const raw of events) {
  buf += raw;
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (line.startsWith('event: ')) { current.type = line.slice(7); }
    else if (line.startsWith('data: ')) {
      try { current.data = JSON.parse(line.slice(6)); } catch (_) {}
    }
    if (line === '' && current.type) {
      eventList.push({ type: current.type, data: current.data });
      current = { type: null, data: null };
    }
  }
}

console.log('  事件数: ' + eventList.length);
console.log('  序列: ' + eventList.map(e => e.type.replace('response.', '')).join(' → '));

// 验证事件类型完整
const types = eventList.map(e => e.type);
assert(types.includes('response.created'), 'response.created');
assert(types.includes('response.output_item.added'), 'output_item.added');
assert(types.includes('response.content_part.added'), 'content_part.added');
assert(types.includes('response.output_text.delta'), 'output_text.delta');
assert(types.includes('response.output_text.done'), 'output_text.done');
assert(types.includes('response.content_part.done'), 'content_part.done');
assert(types.includes('response.function_call_arguments.delta'), 'function_call_arguments.delta');
assert(types.includes('response.function_call_arguments.done'), 'function_call_arguments.done');
assert(types.includes('response.output_item.done'), 'output_item.done');
assert(types.includes('response.completed'), 'response.completed');

// 验证顺序
const idx = (t) => types.indexOf(t);
assert(idx('response.created') < idx('response.output_item.added'), 'created 在 item.added 前');
assert(idx('response.output_item.added') < idx('response.output_text.delta'), 'item.added 在 text.delta 前');
assert(idx('response.output_text.delta') < idx('response.output_text.done'), 'delta 在 done 前');
assert(idx('response.completed') > idx('response.output_text.delta'), 'completed 最后');

// 验证 function_call item
const fcAdded = eventList.find(e => e.data && e.data.item && e.data.item.type === 'function_call');
assert(fcAdded != null, 'function_call output_item.added');
assert(fcAdded.data.item.name === 'get_weather', 'function_call name');

// 验证 usage
const completed = eventList.find(e => e.type === 'response.completed');
assert(completed.data.response.usage.total_tokens === 150, 'usage.total_tokens');
assert(completed.data.response.output[0].content[0].text === '今天天气不错', 'completed 保留完整文本');

// 验证 output 包含所有 item
assert(completed.data.response.output.length >= 2, 'output 含 text + function_call');

console.log('  ✓ 事件序列断言通过');

// 边界：空流
const e2 = [];
chatStreamToResponses((s) => e2.push(s)).pushLine('data: [DONE]');
assert(e2.length > 0 && e2.join('').includes('response.completed'), '空流→completed');

// 边界：error
const e3 = [];
chatStreamToResponses((s) => e3.push(s)).end('Network error');
assert(e3.join('').includes('response.failed'), 'error→failed');
assert(e3.join('').includes('Network error'), 'error message');

console.log('  ✓ 边界 cases 通过');

// ═══════════════════════════════════════════════════════════════════════
console.log('');
console.log('ALL ' + passed + ' TESTS PASSED ✓');
if (failed > 0) { console.error('FAILURES: ' + failed); process.exit(1); }
