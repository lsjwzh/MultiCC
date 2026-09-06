'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preprocessResponsesHistory, repairRejectedResponsesHistory } = require('../src/model-history-converter');

test('all observed history types survive preprocessing and valid IDs remain unchanged', () => {
  const body = { input: [
    { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working' }] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [], internal_chat_message_metadata_passthrough: { a: 1 } },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', namespace: 'functions', arguments: '{ "cmd": "pwd" }' },
    { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok' },
    { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_2', name: 'exec', status: 'completed', input: 'text("ok")' },
    { type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_2', output: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }] },
    { type: 'agent_message', id: 'amsg_1', author: 'worker', recipient: 'root', content: 'done' },
    { type: 'future_tool_call', id: 'foreign_unknown', input: 'unknown definition' },
    { type: '__proto__', id: 'opaque', content: 'unknown' },
    { type: 'constructor', id: 'opaque', content: 'unknown' },
  ] };
  assert.equal(preprocessResponsesHistory(body).body, body);
  assert.deepEqual(preprocessResponsesHistory(body).changes, []);
});

test('converts foreign record IDs first, preserves call IDs, content and references, and is idempotent', () => {
  const body = { input: [
    { type: 'function_call', id: 'tool_1', call_id: 'tool_1', name: 'exec_command', arguments: '{ "cmd": "pwd" }' },
    { type: 'function_call_output', id: 'foreign_output', call_id: 'tool_1', output: 'ok' },
    { type: 'item_reference', id: 'tool_1' },
    { type: 'custom_tool_call', id: 'toolu_2', call_id: 'toolu_2', name: 'exec', input: 'return 1' },
    { type: 'custom_tool_call_output', id: 'call_2', call_id: 'toolu_2', output: '1' },
  ] };
  const original = structuredClone(body);
  const result = preprocessResponsesHistory(body);
  assert.match(result.body.input[0].id, /^fc_[a-f0-9]{32}$/);
  assert.match(result.body.input[1].id, /^fco_/);
  assert.equal(result.body.input[2].id, result.body.input[0].id);
  assert.match(result.body.input[3].id, /^ctc_/);
  assert.match(result.body.input[4].id, /^ctco_/);
  for (const index of [0, 1, 3, 4]) {
    const { id, ...rest } = result.body.input[index];
    const { id: oldId, ...before } = original.input[index];
    assert.deepEqual(rest, before);
  }
  assert.deepEqual(body, original);
  assert.equal(preprocessResponsesHistory(result.body).body, result.body);
  assert.deepEqual(preprocessResponsesHistory(body).body, result.body, 'same input gets same IDs');
});

test('normalizes object arguments without parsing strings or rewriting free-form tools', () => {
  const body = { input: [
    { type: 'function_call', arguments: { cmd: 'echo "中文"', nested: [1, 2] } },
    { type: 'function_call', arguments: '{broken json' },
    { type: 'custom_tool_call', input: 'arbitrary non-JSON code' },
  ] };
  const result = preprocessResponsesHistory(body);
  assert.deepEqual(JSON.parse(result.body.input[0].arguments), body.input[0].arguments);
  assert.equal(result.body.input[1], body.input[1]);
  assert.equal(result.body.input[2], body.input[2]);
});

test('duplicate foreign record IDs stay distinct unless a reference is ambiguous', () => {
  const input = [1, 2].map(n => ({ type: 'function_call', id: 'tool_same', call_id: `call_${n}`, arguments: '{}' }));
  const converted = preprocessResponsesHistory({ input });
  assert.notEqual(converted.body.input[0].id, converted.body.input[1].id);
  const ambiguous = { input: [...input, { type: 'item_reference', id: 'tool_same' }] };
  assert.equal(preprocessResponsesHistory(ambiguous).body, ambiguous);
});

test('only a precise upstream rejection enables omission of an optional field', () => {
  const body = { input: [{ type: 'function_call', id: 'fc_a', call_id: 'tool_a', name: 'exec', arguments: '{}', status: 'alien' }] };
  const error = { param: 'input[0].status', message: "Unknown parameter: 'input[0].status'." };
  const repaired = repairRejectedResponsesHistory(body, error);
  assert.deepEqual(repaired.body.input[0], { type: 'function_call', id: 'fc_a', call_id: 'tool_a', name: 'exec', arguments: '{}' });
  assert.equal(body.input[0].status, 'alien');
  assert.equal(repaired.changes[0].action, 'omit');
  assert.equal(repairRejectedResponsesHistory(repaired.body, error), null);
  const idError = { message: "Invalid 'input[0].id': 'fc_a'. Expected an ID that begins with 'other'." };
  assert.equal(Object.hasOwn(repairRejectedResponsesHistory(body, idError).body.input[0], 'id'), false);
  assert.equal(repairRejectedResponsesHistory({ input: [...body.input, { type: 'item_reference', id: 'fc_a' }] }, idError), null);
  const invalidType = repairRejectedResponsesHistory({ input: [{ ...body.input[0], id: null }] }, {
    param: 'input[0].id', code: 'invalid_type', message: "Invalid type for 'input[0].id': expected a string, got null.",
  });
  assert.equal(Object.hasOwn(invalidType.body.input[0], 'id'), false);
});

test('never guesses or drops semantic history, reasoning, tool schemas or unknown definitions', () => {
  const body = { input: [
    { type: 'function_call', id: 'fc_a', name: 'exec', call_id: 'call_a', arguments: '{}', content: 'hello' },
    { type: 'reasoning', id: 'bad', encrypted_content: 'opaque' },
  ], tools: [{ type: 'function', name: 'exec', parameters: { type: 'object' }, strict: true }] };
  for (const param of ['input[0]', 'input[0].call_id', 'input[0].arguments', 'input[0].name', 'input[0].content', 'input[1].id', 'input[1].encrypted_content', 'tools[0]', 'tools[0].parameters', 'input[0].__proto__', 'input[999].id']) {
    assert.equal(repairRejectedResponsesHistory(body, { param, message: `Unknown parameter: '${param}'.` }), null, param);
  }
  assert.equal(repairRejectedResponsesHistory(body, { param: 'input[0].id', message: 'Account is suspended' }), null);
  const repaired = repairRejectedResponsesHistory(body, { param: 'tools[0].strict', message: "Unsupported parameter: 'tools[0].strict'." });
  assert.deepEqual(repaired.body.tools[0], { type: 'function', name: 'exec', parameters: { type: 'object' } });
  assert.equal(body.tools[0].strict, true);
});

test('unrelated protocol histories are not implicitly transplanted', () => {
  for (const body of [undefined, { input: 'hello' }, { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1' }] }] }]) {
    assert.equal(preprocessResponsesHistory(body).body, body);
  }
});
