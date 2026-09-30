'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { executeAuxHttp, parseResponsesStream } = require('../src/aux-http');
const { mountAuxGoalRoutes } = require('../src/routes/aux-goal');
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

// The pool is only real if the transport actually carries several requests at
// once. Everything above stubs `executeAuxHttp`; this one drives the real
// Messages codec against a real socket and counts simultaneous in-flight
// requests on the server side.
test('the Aux pool drives five concurrent real HTTP requests and drains the rest in order', async t => {
  const started = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const base = await serve(t, async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    const prompt = JSON.parse(data).messages[0].content;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started.push(prompt);
    await new Promise(resolve => setTimeout(resolve, 25));
    inFlight -= 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: `echo:${prompt}` }] }));
  });

  const routes = new Map();
  const runtime = mountAuxGoalRoutes({
    get: (routePath, handler) => routes.set(`GET ${routePath}`, handler),
    post: (routePath, handler) => routes.set(`POST ${routePath}`, handler),
  }, {
    fs: { readFileSync() { throw new Error('ENOENT'); } },
    crypto: { randomUUID: () => `pool-${routes.size}-${Math.random().toString(16).slice(2)}` },
    rootDir: '/repo',
    auxConfigFile: '/tmp/aux-config.json',
    goalConfigFile: '/tmp/goal-config.json',
    atomicWriteJson() {},
    persistedSessions: new Map(),
    savePersistedSessionsBestEffort() {},
    isShuttingDown: () => false,
    recordApiError() {},
    recordApiSuccess() {},
    appendChatMessage() {},
    loadChatHistory: () => [],
    providers: {
      listProviders: () => [],
      resolveAuxHttpTarget: () => ({
        available: true,
        wireApi: 'messages',
        url: `${base}/v1/messages`,
        apiKey: 'test',
        model: 'test-model',
      }),
    },
    getPort: () => 1,
    getClaudeOfficialViaProxy: () => false,
    executeAuxHttp,
    broadcast() {},
    providerLimitCache: null,
    limitCacheStaleMs: 1000,
    env: { AUX_TIMEOUT_MS: '5000', MULTICC_AUX_CONCURRENCY: '5' },
    logger: { log() {}, warn() {}, error() {} },
  });
  runtime.auxQueue.init();

  const tasks = [];
  for (let index = 0; index < 7; index += 1) {
    tasks.push(runtime.auxQueue.enqueue({
      type: 'intent_classify', prompt: `p${index}`, meta: { sessionName: `s${index}` },
    }));
  }
  // Seven tasks, five slots: the first five are on the wire, two still wait.
  assert.equal(runtime.auxQueue.getStatus().active, 5);
  assert.equal(runtime.auxQueue.getStatus().queueDepth, 2);
  const results = await Promise.all(tasks);
  assert.equal(maxInFlight, 5);
  assert.deepEqual(started.slice(0, 5), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(results.map(result => result.text), [
    'echo:p0', 'echo:p1', 'echo:p2', 'echo:p3', 'echo:p4', 'echo:p5', 'echo:p6',
  ]);
  assert.equal(runtime.auxQueue.getStatus().active, 0);
  assert.equal(runtime.auxQueue.getStatus().queueDepth, 0);
});
