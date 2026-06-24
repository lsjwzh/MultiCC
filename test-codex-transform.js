'use strict';

const { responsesToChat, chatStreamToResponses } = require('./src/codex-proxy-transform.js');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) { failed++; throw new Error(`FAIL: ${msg}`); }
  passed++;
}

function deepEqual(a, b, path) {
  if (a === b) return true;
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;

  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) return false;
  for (const k of aKeys) {
    if (!deepEqual(a[k], b[k], path ? `${path}.${k}` : k)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// 模块 A 测试：responsesToChat
// ═══════════════════════════════════════════════════════════════════════

console.log('── 模块 A: responsesToChat ──');

// 构造一个完整的 Responses API 样例
const sampleResponses = {
  model: 'deepseek-chat',
  instructions: '你是一个有用的助手。',
  input: [
    // developer 消息 → 应变成 system
    { type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: '开发提示：你是 codex agent。' }] },
    // user 消息
    { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '帮我查天气。《北京》' },
                { type: 'input_text', text: '温度也显示。' }] },
    // assistant tool_call (function_call)
    { type: 'function_call',
      call_id: 'call_abc123',
      name: 'get_weather',
      arguments: '{"city":"北京"}' },
    // function_call_output
    { type: 'function_call_output',
      call_id: 'call_abc123',
      output: '晴天，25°C' },
  ],
  tools: [
    { type: 'function', name: 'get_weather', description: '查询天气',
      strict: true,
      parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    { type: 'function', name: 'get_time', description: '查询时间',
      parameters: { type: 'object', properties: {} } },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { effort: 'medium', summary: 'auto' },
  store: true,
  include: ['file_search_results'],
  prompt_cache_key: 'cache-xxx',
  client_metadata: { app: 'codex' },
};

const result = responsesToChat(sampleResponses);

// 1. instructions → system 消息首条
assert(result.messages.length > 0, 'messages 非空');
assert(result.messages[0].role === 'system', '首条 message.role === system');
assert(result.messages[0].content === '你是一个有用的助手。', 'instructions 内容正确');

// 2. developer → system
assert(result.messages[1].role === 'system', 'developer → system role 映射');
assert(result.messages[1].content === '开发提示：你是 codex agent。', 'developer 内容');

// 3. user 消息拼接
assert(result.messages[2].role === 'user', 'user role');
assert(result.messages[2].content === '帮我查天气。《北京》温度也显示。', '多条 input_text 拼接');

// 4. function_call → assistant + tool_calls
assert(result.messages[3].role === 'assistant', 'function_call → assistant');
assert(result.messages[3].content === null, 'function_call content=null');
assert(result.messages[3].tool_calls.length === 1, 'tool_calls 有 1 个');
assert(result.messages[3].tool_calls[0].id === 'call_abc123', 'tool_call id');
assert(result.messages[3].tool_calls[0].function.name === 'get_weather', 'tool_call name');
assert(result.messages[3].tool_calls[0].function.arguments === '{"city":"北京"}', 'tool_call args');

// 5. function_call_output → tool
assert(result.messages[4].role === 'tool', 'function_call_output → tool role');
assert(result.messages[4].tool_call_id === 'call_abc123', 'tool_call_id');
assert(result.messages[4].content === '晴天，25°C', 'tool content');

// 6. tools 转换：扁平 → 嵌套
assert(result.tools.length === 2, 'tools 数量');
assert(result.tools[0].type === 'function', 'tool.type');
assert(result.tools[0].function.name === 'get_weather', '嵌套 function.name');
assert(result.tools[0].function.description === '查询天气', '嵌套 function.description');
assert(deepEqual(result.tools[0].function.parameters,
  { type: 'object', properties: { city: { type: 'string' } } }), '嵌套 parameters');

// 7. 透传字段
assert(result.model === 'deepseek-chat', 'model 透传');
assert(result.tool_choice === 'auto', 'tool_choice 透传');
assert(result.parallel_tool_calls === true, 'parallel_tool_calls 透传');
assert(result.stream === true, 'stream=true');

// 8. 丢弃字段
assert(!('reasoning' in result), 'reasoning 丢弃');
assert(!('store' in result), 'store 丢弃');
assert(!('include' in result), 'include 丢弃');
assert(!('client_metadata' in result), 'client_metadata 丢弃');

console.log('  ✓ 全部 assertions 通过');

// 边界：空 input
const minimal = responsesToChat({ model: 'test', input: [] });
assert(minimal.messages.length === 0, '空 input→空 messages');
assert(minimal.model === 'test', 'model 透传');
assert(minimal.stream === true, 'stream 默认 true');

// 边界：无 instructions
const noInst = responsesToChat({ model: 'x', input: [ { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } ] });
assert(noInst.messages.length === 1, '无 instructions 时 messages 数量');
assert(noInst.messages[0].role === 'user', '无 instructions 时第一条是 user');

// 边界：无 tools
const noTools = responsesToChat({ model: 'x', input: [] });
assert(!('tools' in noTools), '无 tools 时 tools 字段不存在');

// 边界：function_call_output 无 output
const noOutput = responsesToChat({
  model: 'x', input: [ { type: 'function_call_output', call_id: 'c1', output: '' } ]
});
assert(noOutput.messages[0].role === 'tool', '无 output 时也有 tool 消息');
assert(noOutput.messages[0].content === '', '无 output 时 content 为空字符串');

console.log('  ✓ 边界 cases 通过');

// ═══════════════════════════════════════════════════════════════════════
// 模块 B 测试：chatStreamToResponses
// ═══════════════════════════════════════════════════════════════════════

console.log('');
console.log('── 模块 B: chatStreamToResponses ──');

const events = [];
function emit(sseText) {
  events.push(sseText);
}

const tx = chatStreamToResponses(emit);

// 模拟 DeepSeek Chat SSE 流
// 先发 model + 首 delta
tx.pushLine('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"今天"},"finish_reason":null}]}');
// 第二个 content delta
tx.pushLine('data: {"id":"chatcmpl-1","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"天气不错"},"finish_reason":null}]}');
// tool_call delta（DeepSeek 可能一次性给出完整 tool_call）
tx.pushLine('data: {"id":"chatcmpl-1","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_001","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\""}}]}}]}}');
tx.pushLine('data: {"id":"chatcmpl-1","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\":\\"北京\\"}"}}]}}]}}');
// 结束帧（含 usage）
tx.pushLine('data: {"id":"chatcmpl-1","model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}');
tx.pushLine('data: [DONE]');

// 解析事件
function parseEvents() {
  const parsed = [];
  let current = { type: null, data: null };
  let buf = '';

  for (const raw of events) {
    buf += raw;
    const lines = buf.split('\n');
    // 保留最后一个可能不完整的行
    buf = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        current.type = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try { current.data = JSON.parse(line.slice(6)); }
        catch (_) { current.data = line.slice(6); }
      }
      // 空行 = 事件结束
      if (line === '' && current.type) {
        parsed.push({ type: current.type, data: current.data });
        current = { type: null, data: null };
      }
    }
  }
  return parsed;
}

const parsed = parseEvents();

console.log(`  收到 ${parsed.length} 个 SSE 事件`);

// 验证事件序列
const eventTypes = parsed.map(e => e.type);
console.log('  事件序列:', eventTypes.join(' → '));

// 1. response.created 最先
assert(eventTypes[0] === 'response.created', '第一个事件是 response.created');
assert(parsed[0].data.type === 'response.created', 'data.type');
assert(parsed[0].data.response.status === 'in_progress', 'status=in_progress');

// 2. 文本 output_item.added
assert(eventTypes[1] === 'response.output_item.added', 'output_item.added');
assert(parsed[1].data.item.type === 'message', 'item.type=message');
assert(parsed[1].data.item.role === 'assistant', 'item.role=assistant');

// 3. content_part.added
assert(eventTypes[2] === 'response.content_part.added', 'content_part.added');
assert(parsed[2].data.part.type === 'output_text', 'part.type=output_text');

// 4-5. 两个 output_text.delta
assert(eventTypes[3] === 'response.output_text.delta', '第一个 text delta');
assert(parsed[3].data.delta === '今天', 'delta 内容 1');
assert(eventTypes[4] === 'response.output_text.delta', '第二个 text delta');
assert(parsed[4].data.delta === '天气不错', 'delta 内容 2');

// 6. tool_call → output_item.added (function_call)
const toolAddedIdx = eventTypes.indexOf('response.output_item.added', 4); // skip first
assert(toolAddedIdx !== -1, 'tool_call output_item.added 存在');
const toolAdded = parsed[toolAddedIdx];
assert(toolAdded.data.item.type === 'function_call', 'item.type=function_call');
assert(toolAdded.data.item.name === 'get_weather', 'function_call name');

// 7. function_call_arguments.delta
const argDeltaIdx = eventTypes.indexOf('response.function_call_arguments.delta');
assert(argDeltaIdx !== -1, 'function_call_arguments.delta 存在');

// 8. function_call_arguments.done
const argDoneIdx = eventTypes.indexOf('response.function_call_arguments.done');
assert(argDoneIdx !== -1, 'function_call_arguments.done 存在');

// 9. output_item.done (text)
const textDoneIdx = eventTypes.indexOf('response.output_item.done');
assert(textDoneIdx !== -1, 'output_item.done 存在');

// 10. response.completed
const completedIdx = eventTypes.lastIndexOf('response.completed');
assert(completedIdx !== -1, 'response.completed 存在');
assert(parsed[completedIdx].data.response.status === 'completed', 'completed status');
assert(parsed[completedIdx].data.response.usage.total_tokens === 150, 'usage.total_tokens');

console.log('  ✓ 全部事件序列断言通过');

// 边界：空流
{
  const ev2 = [];
  const tx2 = chatStreamToResponses((s) => ev2.push(s));
  const tx3 = chatStreamToResponses((s) => ev2.push(s));
  tx3.pushLine('data: [DONE]');
  // 空流只有 [DONE] → response.created + response.completed
  assert(ev2.length > 0, '空流也有事件');
}
console.log('  ✓ 空流边界通过');

// 边界：error
{
  const ev3 = [];
  const txErr = chatStreamToResponses((s) => ev3.push(s));
  txErr.end('Network error');
  // 应该有 response.failed
  const ev3Text = ev3.join('');
  assert(ev3Text.includes('response.failed'), 'error → response.failed');
  assert(ev3Text.includes('Network error'), 'error message 传递');
}
console.log('  ✓ error 边界通过');

// ═══════════════════════════════════════════════════════════════════════
console.log('');
console.log(`ALL ${passed} TESTS PASSED ✓`);
if (failed > 0) { console.error(`FAILURES: ${failed}`); process.exit(1); }
