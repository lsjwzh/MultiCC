'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preprocessResponsesHistory, repairRejectedResponsesHistory, stripReasoningContent, stripUnresolvedItemReferences } = require('../src/model-history-converter');

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

test('stripReasoningContent empties third-party reasoning content the official backend rejects', () => {
  const body = { model: 'gpt-5.2', input: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text: 'third-party chain of thought' }] },
    { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'official shape' }] },
    { type: 'reasoning', id: 'rs_3', summary: [], content: [] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec', arguments: '{}' },
  ] };
  const original = structuredClone(body);
  const result = stripReasoningContent(body);
  assert.deepEqual(body, original, 'input body untouched');
  assert.equal(Object.hasOwn(result.body.input[1], 'content'), false);
  assert.deepEqual(result.body.input[2], body.input[2]);
  assert.deepEqual(result.body.input[3], body.input[3]);
  assert.deepEqual(result.body.input[0], body.input[0]);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0], { path: 'input[1].content', itemType: 'reasoning', action: 'omit', rule: 'reasoning_content_not_accepted' });
  assert.deepEqual(stripReasoningContent(result.body).changes, [], 'idempotent');
});

test('an encrypted-content verification rejection strips every reasoning blob at once', () => {
  const body = { input: [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: '944aa366-6fab-4f1e-8a03-3dfb22f964ef-0' },
    { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'gAAAAABqooA_IxjuReie' },
    { type: 'reasoning', id: 'rs_3', summary: [{ type: 'summary_text', text: 'kept' }], encrypted_content: '' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept' }], encrypted_content: 'not-reasoning' },
  ] };
  const original = structuredClone(body);
  const rejection = {
    message: 'The encrypted content 944a...ef-0 could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
  };
  const repaired = repairRejectedResponsesHistory(body, rejection);
  // Both third-party blobs go in one repair round, and each blob-less id the
  // strip leaves behind would draw a store:false item-not-found rejection on
  // the retry — so the same round drops those references too.
  assert.equal(repaired.changes.length, 5, 'blobs plus their dangling ids in one repair round');
  assert.equal(repaired.body.input.length, 2, 'blob-less empty-summary husks are dropped whole');
  assert.equal(Object.hasOwn(repaired.body.input[0], 'id'), false);
  assert.equal(repaired.body.input[0].summary.length, 1, 'the summary-only reasoning keeps its content, loses the id');
  assert.equal(repaired.body.input[0].encrypted_content, '', 'empty string blob is not a payload; untouched');
  assert.equal(repaired.body.input[1].encrypted_content, 'not-reasoning', 'non-reasoning items are opaque');
  assert.deepEqual(body, original, 'input body untouched');
  assert.equal(repairRejectedResponsesHistory(repaired.body, rejection), null, 'idempotent');
  // A rejection that is not about encrypted verification leaves history alone.
  assert.equal(repairRejectedResponsesHistory(body, { message: 'Account is suspended' }), null);
});

test('stripUnresolvedItemReferences removes every store:false-only reference shape', () => {
  const body = { model: 'gpt-5.3', previous_response_id: 'resp_foreign', input: [
    { type: 'item_reference', id: 'rs_ref' },
    { type: 'reasoning', id: 'rs_gone' }, // husk: content already stripped by an earlier pass
    { type: 'reasoning', id: 'rs_kept', encrypted_content: 'gAAAAA_official_verifiable' },
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'kept' }] },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'kept' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec', arguments: '{}' },
    'bare string items pass through',
  ] };
  const original = structuredClone(body);
  const result = stripUnresolvedItemReferences(body);
  assert.deepEqual(body, original, 'input body untouched');
  assert.equal(result.body.input.length, 5, 'reference, husk dropped; everything self-contained stays');
  assert.deepEqual(result.changes.map(change => change.path), [
    'previous_response_id', 'input[0]', 'input[1]', 'input[3].id',
  ]);
  assert.equal(result.body.input[0].id, 'rs_kept');
  assert.equal(result.body.input[1].summary.length, 1);
  assert.equal(Object.hasOwn(result.body.input[1], 'id'), false);
  assert.deepEqual(result.body.input[2], body.input[4]);
  assert.deepEqual(result.body.input[3], body.input[5]);
  assert.equal(result.body.input[4], 'bare string items pass through');
  assert.equal(result.body.previous_response_id, undefined);
  assert.deepEqual(stripUnresolvedItemReferences(result.body).changes, [], 'idempotent');
  // The id the upstream explicitly named is removed even from a substantive
  // item — its inline content stays.
  const named = stripUnresolvedItemReferences({ input: [
    { type: 'message', id: 'msg_named', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] }, ['msg_named']);
  assert.equal(Object.hasOwn(named.body.input[0], 'id'), false);
  assert.equal(named.body.input[0].content[0].text, 'hi');
});

test('inline third-party reasoning content survives both the id strip and a named-id repair', () => {
  const inline = { type: 'reasoning', id: 'rs_third', content: [{ type: 'reasoning_text', text: 'cot' }] };
  const stripped = stripUnresolvedItemReferences({ input: [inline, { type: 'message', id: 'msg_1' }] });
  assert.equal(Object.hasOwn(stripped.body.input[0], 'id'), false);
  assert.deepEqual(stripped.body.input[0].content, [{ type: 'reasoning_text', text: 'cot' }]);
  // The upstream named this exact id: the id and any blob go, but the inline
  // content is the only context the item carries, so the item must survive —
  // dropping it would silently delete a third-party chain of thought.
  const named = stripUnresolvedItemReferences({ input: [inline] }, ['rs_third']);
  assert.equal(named.body.input.length, 1);
  assert.equal(Object.hasOwn(named.body.input[0], 'id'), false);
  assert.deepEqual(named.body.input[0].content, [{ type: 'reasoning_text', text: 'cot' }]);
});

test('an item-not-found rejection repairs by removing the named id and the whole reference family', () => {
  const body = { previous_response_id: 'resp_old', input: [
    { type: 'reasoning', id: 'rs_foreign', summary: [{ type: 'summary_text', text: 'chain' }] },
    { type: 'item_reference', id: 'rs_other' },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'kept' }] },
  ] };
  const original = structuredClone(body);
  const rejection = {
    message: "Item with id 'rs_foreign' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true, or remove this item from your input.",
  };
  const repaired = repairRejectedResponsesHistory(body, rejection);
  assert.equal(repaired.changes.length, 3, 'named id, the item_reference, and previous_response_id in one round');
  assert.equal(Object.hasOwn(repaired.body.input[0], 'id'), false);
  assert.equal(repaired.body.input[0].summary.length, 1, 'targeted: only the id goes, the summary stays');
  assert.deepEqual(repaired.body.input[1], body.input[2], 'the reference entry is dropped, the message shifts up');
  assert.equal(repaired.body.previous_response_id, undefined);
  assert.deepEqual(body, original, 'input body untouched');
  assert.equal(repairRejectedResponsesHistory(repaired.body, rejection), null, 'idempotent');
  // A rejection that names no missing item is not this rule.
  assert.equal(repairRejectedResponsesHistory(body, { message: 'Account is suspended' }), null);
});

test('an array-too-long content rejection repairs by stripping every reasoning item at once', () => {
  const body = { input: [
    { type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text: 'one' }] },
    { type: 'reasoning', id: 'rs_2', summary: [], content: [{ type: 'reasoning_text', text: 'two' }] },
  ] };
  const rejection = {
    message: "Invalid 'input[0].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.",
  };
  const repaired = repairRejectedResponsesHistory(body, rejection);
  assert.equal(repaired.changes.length, 2, 'one repair round must fix every item, not just input[0]');
  assert.equal(Object.hasOwn(repaired.body.input[0], 'content'), false);
  assert.equal(Object.hasOwn(repaired.body.input[1], 'content'), false);
  assert.equal(repairRejectedResponsesHistory(repaired.body, rejection), null);
  // The same param with a non-length rejection (unknown parameter) is NOT this rule.
  assert.equal(repairRejectedResponsesHistory({ input: body.input }, { param: 'input[0].content', message: "Unknown parameter: 'input[0].content'." }), null);
  // A rejection that names no content field leaves reasoning untouched.
  assert.equal(repairRejectedResponsesHistory(body, { message: 'Account is suspended' }), null);
});
