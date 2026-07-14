'use strict';

const assert = require('assert');
const { buildAuxHttpRequest } = require('../src/aux-http');

const common = { model: 'model-1', prompt: 'hello', systemPrompt: 'be concise' };

const messages = buildAuxHttpRequest(
  { wireApi: 'messages', apiKey: 'key' },
  common,
);
assert.strictEqual(messages.body.system, 'be concise');
assert.deepStrictEqual(messages.body.messages, [{ role: 'user', content: 'hello' }]);
assert.strictEqual(messages.headers['anthropic-version'], '2023-06-01');
assert.strictEqual(messages.headers['x-api-key'], 'key');
assert.strictEqual(messages.parse({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a b');

const responses = buildAuxHttpRequest(
  { wireApi: 'responses', apiKey: 'key' },
  common,
);
assert.deepStrictEqual(responses.body, {
  model: 'model-1', input: 'hello', instructions: 'be concise',
});
assert.strictEqual(responses.parse({ output_text: 'direct' }), 'direct');
assert.strictEqual(responses.parse({
  output: [{ content: [{ type: 'output_text', text: 'nested' }] }],
}), 'nested');

const chat = buildAuxHttpRequest(
  { wireApi: 'chat_completions', apiKey: 'key' },
  common,
);
assert.deepStrictEqual(chat.body.messages, [
  { role: 'system', content: 'be concise' },
  { role: 'user', content: 'hello' },
]);
assert.strictEqual(chat.parse({ choices: [{ message: { content: 'chat' } }] }), 'chat');

assert.throws(
  () => buildAuxHttpRequest({ wireApi: 'unknown', apiKey: 'key' }, common),
  /wire API/,
);

console.log('Aux HTTP codec tests passed');
