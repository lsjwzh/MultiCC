'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  createClaudeHandler: createHandler,
  decodeClaudeRoutedModel: decodeCcfwModel,
  parseClaudeProxyUrl: parseProxyUrl,
} = require('cli-provider-router');
const { createRoleTokenTracker } = require('../src/role-token-tracker');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  not ok - ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request({ port, method = 'POST', path, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body == null
      ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, method, path,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeProvider(name, baseUrl, env) {
  return {
    name,
    settingsConfig: {
      env: { ANTHROPIC_BASE_URL: baseUrl, ...env },
    },
  };
}

function sseBody(usage) {
  return [
    'event: message_start\n',
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: {
      input_tokens: usage.input,
      cache_creation_input_tokens: usage.cacheWrite,
      cache_read_input_tokens: usage.cacheRead,
    } } })}\n\n`,
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
    'event: message_delta\n',
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: usage.output } })}\n\n`,
    'event: message_stop\n',
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');
}

async function main() {
  console.log('\nClaude subagent provider routing tests');

  await test('ccfw decoder rejects incomplete route keys', () => {
    assert.deepStrictEqual(decodeCcfwModel('ccfw:sub:model:variant'), {
      providerId: 'sub', realModel: 'model:variant',
    });
    assert.strictEqual(decodeCcfwModel('ordinary-model'), null);
    assert.strictEqual(decodeCcfwModel('ccfw::model'), null);
    assert.strictEqual(decodeCcfwModel('ccfw:sub:'), null);
  });

  await test('proxy URL keeps session, API path, and query separate', () => {
    assert.deepStrictEqual(
      parseProxyUrl('/claude-proxy/main-provider/session-1/v1/messages?beta=true'),
      {
        providerId: 'main-provider',
        sessionId: 'session-1',
        apiPath: '/v1/messages',
        query: '?beta=true',
      }
    );
  });

  await test('role token tracker keeps main and each sub-provider separate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-role-token-'));
    const filePath = path.join(dir, 'token_by_role.json');
    try {
      const tracker = createRoleTokenTracker({
        filePath,
        now: () => new Date(2026, 6, 16, 12, 0, 0),
      });
      assert.strictEqual(tracker.accumulate({
        sessionId: 'session-a', role: 'main', providerId: 'main-provider',
        providerName: 'Main', model: 'main-model',
        usage: { inputTokens: 2, outputTokens: 3, cacheWrite: 5, cacheRead: 7 },
      }), true);
      assert.strictEqual(tracker.accumulate({
        sessionId: 'session-a', role: 'sub', providerId: 'sub-one',
        providerName: 'Sub One', model: 'sub-model-a',
        usage: { inputTokens: 11, outputTokens: 13, cacheWrite: 17, cacheRead: 19 },
      }), true);
      tracker.accumulate({
        sessionId: 'session-a', role: 'sub', providerId: 'sub-one',
        providerName: 'Sub One', model: 'sub-model-a',
        usage: { inputTokens: 23, outputTokens: 29, cacheWrite: 31, cacheRead: 37 },
      });
      tracker.accumulate({
        sessionId: 'session-a', role: 'sub', providerId: 'sub-two',
        providerName: 'Sub Two', model: 'sub-model-b',
        usage: { inputTokens: 41, outputTokens: 43, cacheWrite: 47, cacheRead: 53 },
      });
      tracker.accumulate({
        sessionId: 'aux', role: 'aux', providerId: 'main-provider',
        providerName: 'Main', model: 'aux-model',
        usage: { inputTokens: 59, outputTokens: 61, cacheWrite: 67, cacheRead: 71 },
      });
      assert.strictEqual(tracker.accumulate({
        sessionId: 'session-a', role: 'sub', providerId: 'ignored', usage: {},
      }), false);

      assert.deepStrictEqual(tracker.snapshot('session-a'), {
        main: { inputTokens: 2, outputTokens: 3, cacheWrite: 5, cacheRead: 7 },
        sub: { inputTokens: 75, outputTokens: 85, cacheWrite: 95, cacheRead: 109 },
        subByProvider: [
          {
            providerId: 'sub-one', name: 'Sub One', model: 'sub-model-a',
            inputTokens: 34, outputTokens: 42, cacheWrite: 48, cacheRead: 56,
          },
          {
            providerId: 'sub-two', name: 'Sub Two', model: 'sub-model-b',
            inputTokens: 41, outputTokens: 43, cacheWrite: 47, cacheRead: 53,
          },
        ],
      });

      const ledger = tracker.readLedger()['2026-07-16'];
      assert.deepStrictEqual(ledger.main['main-provider'], {
        name: 'Main', inputTokens: 2, outputTokens: 3,
        cacheWrite: 5, cacheRead: 7, turns: 1,
      });
      assert.deepStrictEqual(ledger.sub['sub-one'], {
        name: 'Sub One', inputTokens: 34, outputTokens: 42,
        cacheWrite: 48, cacheRead: 56, turns: 2,
      });
      assert.deepStrictEqual(ledger.sub['sub-two'], {
        name: 'Sub Two', inputTokens: 41, outputTokens: 43,
        cacheWrite: 47, cacheRead: 53, turns: 1,
      });
      assert.deepStrictEqual(ledger.aux['main-provider'], {
        name: 'Main', inputTokens: 59, outputTokens: 61,
        cacheWrite: 67, cacheRead: 71, turns: 1,
      });
      assert.strictEqual(tracker.snapshot('aux'), null);

      tracker.reset('session-a');
      assert.strictEqual(tracker.snapshot('session-a'), null);
      assert.deepStrictEqual(tracker.readLedger()['2026-07-16'], ledger);
      assert.deepStrictEqual(
        fs.readdirSync(dir).filter(name => name.endsWith('.tmp')),
        []
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const mainRequests = [];
  const subRequests = [];
  const mainSse = sseBody({ input: 11, output: 7, cacheWrite: 13, cacheRead: 17 });
  const subSse = sseBody({ input: 19, output: 23, cacheWrite: 29, cacheRead: 31 });

  const mainUpstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      mainRequests.push({ req, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(mainSse.slice(0, 37));
      res.end(mainSse.slice(37));
    });
  });
  const subUpstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      subRequests.push({ req, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url.includes('json=true')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 37,
            output_tokens: 41,
            cache_creation_input_tokens: 43,
            cache_read_input_tokens: 47,
          },
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(subSse.slice(0, 29));
      res.write(subSse.slice(29, 113));
      res.end(subSse.slice(113));
    });
  });

  const providers = {
    main: makeProvider('Main Provider', `${mainUpstream.url}/main-base`, {
      ANTHROPIC_API_KEY: 'main-secret',
    }),
    sub: makeProvider('Sub Provider', `${subUpstream.url}/sub-base`, {
      ANTHROPIC_AUTH_TOKEN: 'sub-secret',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sub-wire-model[1M]',
    }),
  };
  const usageEvents = [];
  const proxy = await listen(createHandler({
    getProvider: (_appType, id) => providers[id] || null,
    onUsage: info => usageEvents.push(info),
  }));

  try {
    await test('HEAD connectivity probe does not hit an upstream', async () => {
      const response = await request({
        port: proxy.port,
        method: 'HEAD',
        path: '/claude-proxy/main/session-1/',
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(mainRequests.length, 0);
      assert.strictEqual(subRequests.length, 0);
    });

    await test('main request stays on the main provider and preserves SSE bytes', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages?beta=true',
        headers: {
          authorization: 'Bearer multicc-session-1',
          'x-api-key': 'virtual-key',
          'accept-encoding': 'gzip, br',
        },
        body: { model: 'main-wire-model', stream: true, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, mainSse);
      assert.strictEqual(mainRequests.length, 1);
      assert.strictEqual(subRequests.length, 0);
      const seen = mainRequests[0];
      assert.strictEqual(seen.req.url, '/main-base/v1/messages?beta=true');
      assert.strictEqual(seen.req.headers['x-api-key'], 'main-secret');
      assert.strictEqual(seen.req.headers.authorization, undefined);
      assert.strictEqual(seen.req.headers['accept-encoding'], undefined);
      assert.strictEqual(JSON.parse(seen.body).model, 'main-wire-model');
      assert.strictEqual(Number(seen.req.headers['content-length']), Buffer.byteLength(seen.body));
      assert.deepStrictEqual(usageEvents[0], {
        sessionId: 'session-1',
        role: 'main',
        providerId: 'main',
        providerName: 'Main Provider',
        model: 'main-wire-model',
        isStream: true,
        usage: { inputTokens: 11, outputTokens: 7, cacheWrite: 13, cacheRead: 17 },
      });
    });

    await test('subagent request switches provider, auth, and tier-mapped wire model', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-1/v1/messages',
        body: { model: 'ccfw:sub:sonnet', stream: true, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, subSse);
      assert.strictEqual(mainRequests.length, 1);
      assert.strictEqual(subRequests.length, 1);
      const seen = subRequests[0];
      assert.strictEqual(seen.req.url, '/sub-base/v1/messages');
      assert.strictEqual(seen.req.headers.authorization, 'Bearer sub-secret');
      assert.strictEqual(seen.req.headers['x-api-key'], undefined);
      assert.strictEqual(JSON.parse(seen.body).model, 'sub-wire-model');
      assert.strictEqual(Number(seen.req.headers['content-length']), Buffer.byteLength(seen.body));
      assert.deepStrictEqual(usageEvents[1], {
        sessionId: 'session-1',
        role: 'sub',
        providerId: 'sub',
        providerName: 'Sub Provider',
        model: 'sub-wire-model',
        isStream: true,
        usage: { inputTokens: 19, outputTokens: 23, cacheWrite: 29, cacheRead: 31 },
      });
    });

    await test('non-stream subagent usage is attributed independently', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-2/v1/messages?json=true',
        body: { model: 'ccfw:sub:custom:model', stream: false, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(JSON.parse(subRequests[1].body).model, 'custom:model');
      assert.deepStrictEqual(usageEvents[2], {
        sessionId: 'session-2',
        role: 'sub',
        providerId: 'sub',
        providerName: 'Sub Provider',
        model: 'custom:model',
        isStream: false,
        usage: { inputTokens: 37, outputTokens: 41, cacheWrite: 43, cacheRead: 47 },
      });
    });

    await test('Aux proxy usage does not pollute the main role', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/aux/v1/messages',
        body: { model: 'main-wire-model', stream: true, messages: [] },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, mainSse);
      assert.deepStrictEqual(usageEvents[3], {
        sessionId: 'aux',
        role: 'aux',
        providerId: 'main',
        providerName: 'Main Provider',
        model: 'main-wire-model',
        isStream: true,
        usage: { inputTokens: 11, outputTokens: 7, cacheWrite: 13, cacheRead: 17 },
      });
    });

    await test('unknown routed provider fails closed', async () => {
      const response = await request({
        port: proxy.port,
        path: '/claude-proxy/main/session-3/v1/messages',
        body: { model: 'ccfw:missing:sonnet', stream: true, messages: [] },
      });
      assert.strictEqual(response.status, 502);
      assert.match(response.body, /provider 'missing' has no baseUrl/);
    });
  } finally {
    await close(proxy.server);
    await close(mainUpstream.server);
    await close(subUpstream.server);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
