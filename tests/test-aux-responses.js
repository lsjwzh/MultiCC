'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { executeAuxHttp, parseResponsesStream } = require('../src/aux-http');
const { createCodexOfficialRelayHandler } = require('../src/codex/official-relay');
const { createOfficialCatalog } = require('../src/providers/official-catalog');

const done = text => `event: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] } })}\r\n\r\n`;
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Aux invokes its own official provider through the relay and follows global account switching', async t => {
  let selection = { codex: 'aaaaaaaaaaaaaaaa' };
  const catalog = createOfficialCatalog({ readRecords: () => [], readSelection: () => selection, writeSelection: value => { selection = value; } });
  const observed = [];
  const relay = createCodexOfficialRelayHandler({
    getProvider: catalog.get,
    readCredential: ({ provider }) => ({ ok: true, accessToken: `test-token-${provider.settingsConfig.officialAccount.id}`, accountId: 'test-account' }),
    fetch: async (_, init) => {
      observed.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response(done('自己的模型摘要'), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const base = await serve(t, async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    req.body = JSON.parse(data);
    req.params = { providerId: 'codex-official' };
    await relay(req, res, () => { throw new Error('must use official relay'); });
  });
  const target = { url: `${base}/codex-proxy/codex-official/responses`, apiKey: 'multicc-aux', wireApi: 'responses' };
  const input = { target, model: 'my-model', prompt: '请摘要', systemPrompt: '简短', timeoutMs: 1000 };
  assert.equal(await executeAuxHttp(input), '自己的模型摘要');
  catalog.select('codex', 'bbbbbbbbbbbbbbbb');
  assert.equal(await executeAuxHttp(input), '自己的模型摘要');
  assert.equal(observed[0].body.model, 'my-model');
  assert.equal(observed[0].body.input[0].content[0].text, '请摘要');
  assert.equal(observed[0].body.stream, true);
  assert.equal(observed[0].body.store, false);
  assert.match(observed[0].headers.Authorization || observed[0].headers.authorization, /aaaaaaaaaaaaaaaa/);
  assert.match(observed[1].headers.Authorization || observed[1].headers.authorization, /bbbbbbbbbbbbbbbb/);
});

test('Responses SSE requires completed output and reports failure instead of returning partial summaries', () => {
  assert.equal(parseResponsesStream(done('ok')).status, 'completed');
  assert.throws(() => parseResponsesStream('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: [DONE]\n\n'), /before completion/);
  assert.throws(() => parseResponsesStream('data: {"type":"response.failed","response":{"error":{"message":"quota exceeded"}}}\n\n'), /quota exceeded/);
  assert.throws(() => parseResponsesStream('data: {"type":"response.incomplete"}\n\n'), /incomplete/);
});

test('Responses transport still accepts JSON and bounds streaming requests by total timeout', async t => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ output_text: 'JSON summary' })); }
    else { res.setHeader('content-type', 'text/event-stream'); res.write(': waiting\n\n'); }
  });
  const target = { url: `${base}/json`, apiKey: 'test', wireApi: 'responses' };
  assert.equal(await executeAuxHttp({ target, model: 'm', prompt: 'p', timeoutMs: 1000 }), 'JSON summary');
  await assert.rejects(executeAuxHttp({ target: { ...target, url: `${base}/hang` }, model: 'm', prompt: 'p', timeoutMs: 50 }), /timeout/);
});
