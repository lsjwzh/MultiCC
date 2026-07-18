'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const ORIGINAL_ENV = Object.freeze({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CODEX_HOME: process.env.CODEX_HOME,
});
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-test-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.CODEX_HOME = path.join(TEST_HOME, '.codex');

const TEST_SECRETS = Object.freeze([
  'codex-test-global-access-token',
  'codex-test-stale-import-token',
  'codex-test-custom-api-key',
  'codex-test-main-provider-key',
  'codex-test-sub-provider-key',
  'codex-test-local-proxy-key',
]);

function restoreTestEnvironment() {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
}

function redactFailure(error) {
  let message = String(error && (error.stack || error.message) || error);
  for (const secret of TEST_SECRETS) message = message.split(secret).join('[REDACTED]');
  return message
    .replace(/(Bearer\s+)[^\s'"`,]+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|OPENAI_API_KEY|authorization)\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
}

const {
  DEFAULT_CODEX_AGENT_ROLES,
  DEFAULT_CODEX_SUBAGENT_PROVIDER,
  LEGACY_CODEX_SUBAGENT_PROVIDER,
  mountCodexProxy,
  normalizeResponsesUsage,
} = require('cli-provider-router');
const {
  materializeCodexAuth,
  materializeCodexRoutingHome,
} = require('../src/providers');

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
    console.error(`    ${redactFailure(error)}`);
  }
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request({ port, path: pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        authorization: 'Bearer codex-test-local-proxy-key',
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function provider({ name, baseUrl, apiKey, model, wireApi = 'responses' }) {
  return {
    name,
    settingsConfig: {
      auth: { OPENAI_API_KEY: apiKey },
      config: [
        'model_provider = "custom"',
        `model = "${model}"`,
        '[model_providers.custom]',
        `name = "${name}"`,
        `base_url = "${baseUrl}"`,
        `wire_api = "${wireApi}"`,
        'requires_openai_auth = true',
        '',
      ].join('\n'),
    },
  };
}

function responsesSse(text, usage) {
  const response = {
    id: 'resp_mock', object: 'response', status: 'completed', model: 'main-model',
    output: [{
      type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    usage,
  };
  return [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
  ].join('');
}

async function main() {
  console.log('\nCodex subagent provider routing tests');

  await test('test process isolates CODEX_HOME and redacts credential failures', () => {
    assert.strictEqual(process.env.CODEX_HOME, path.join(TEST_HOME, '.codex'));
    assert.strictEqual(os.homedir(), TEST_HOME);
    const failure = redactFailure(new Error(
      `access_token=${TEST_SECRETS[0]} authorization=Bearer ${TEST_SECRETS[4]}`
    ));
    for (const secret of TEST_SECRETS) assert.doesNotMatch(failure, new RegExp(secret));
    assert.match(failure, /\[REDACTED\]/);
  });

  await test('Responses usage separates fresh input from cached input', () => {
    assert.deepStrictEqual(normalizeResponsesUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 7,
    }), {
      inputTokens: 60,
      outputTokens: 7,
      cacheWrite: 0,
      cacheRead: 40,
    });
  });

  await test('official Codex provider follows the current global OAuth login', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-auth-'));
    const home = path.join(root, 'home');
    const globalAuth = path.join(process.env.CODEX_HOME, 'auth.json');
    fs.mkdirSync(home);
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(globalAuth, JSON.stringify({ tokens: { access_token: TEST_SECRETS[0] } }));
    try {
      const source = materializeCodexAuth(home, {
        auth: { tokens: { access_token: TEST_SECRETS[1] } },
        config: 'model = "gpt-5.5"\n',
      });
      assert.strictEqual(source, 'global');
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(home, 'auth.json'))).tokens.access_token,
        TEST_SECRETS[0]
      );

      const custom = materializeCodexAuth(home, {
        auth: { OPENAI_API_KEY: TEST_SECRETS[2] },
        config: 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.example/v1"\n',
      });
      assert.strictEqual(custom, 'provider');
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(home, 'auth.json'))).OPENAI_API_KEY,
        TEST_SECRETS[2]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('Codex routing home overrides all built-in subagent roles', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-routing-home-'));
    try {
      fs.writeFileSync(path.join(home, 'config.toml'), [
        'model_provider = "custom"',
        'model = "main-model"',
        '[model_providers.custom]',
        'name = "custom"',
        'base_url = "https://main.example/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
      ].join('\n'));

      materializeCodexRoutingHome(home, {
        mainProviderId: 'main-provider',
        mainProxyable: true,
        sessionId: 'session-1',
        subProviderId: 'sub-provider',
        subModel: 'sub-model',
        port: 3456,
      });

      const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      const subagentProviderHeader = `[model_providers.${DEFAULT_CODEX_SUBAGENT_PROVIDER}]`;
      const subagentProviderStart = config.indexOf(subagentProviderHeader);
      assert.notStrictEqual(subagentProviderStart, -1, `missing ${subagentProviderHeader}`);
      const nextSectionStart = config.indexOf('\n[', subagentProviderStart + subagentProviderHeader.length);
      const subagentProviderConfig = config.slice(
        subagentProviderStart,
        nextSectionStart === -1 ? config.length : nextSectionStart
      );
      assert.match(config, /http:\/\/127\.0\.0\.1:3456\/codex-proxy\/main-provider\/session-1\/main/);
      assert.match(subagentProviderConfig, /base_url = "http:\/\/127\.0\.0\.1:3456\/codex-proxy\/sub-provider\/session-1\/sub"/);
      assert.match(subagentProviderConfig, /wire_api = "responses"/);
      assert.match(subagentProviderConfig, /requires_openai_auth = true/);
      assert.notStrictEqual(DEFAULT_CODEX_SUBAGENT_PROVIDER, LEGACY_CODEX_SUBAGENT_PROVIDER);
      assert.doesNotMatch(config, new RegExp(`\\[model_providers\\.${LEGACY_CODEX_SUBAGENT_PROVIDER}\\]`));
      for (const role of Object.keys(DEFAULT_CODEX_AGENT_ROLES)) {
        const agent = fs.readFileSync(path.join(home, 'agents', `${role}.toml`), 'utf8');
        assert.match(agent, new RegExp(`name = "${role}"`));
        const providerReference = agent.match(/^model_provider = "([^"]+)"$/m);
        assert.ok(providerReference, `${role} must declare model_provider`);
        assert.strictEqual(providerReference[1], DEFAULT_CODEX_SUBAGENT_PROVIDER);
        assert.ok(config.includes(`[model_providers.${providerReference[1]}]`));
        assert.match(agent, /model = "sub-model"/);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await test('official main provider stays direct while its child uses the proxy', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-official-home-'));
    try {
      fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-main"\n');
      materializeCodexRoutingHome(home, {
        mainProviderId: 'official-main',
        mainProxyable: false,
        sessionId: 'session-2',
        subProviderId: 'sub-provider',
        subModel: 'sub-model',
        port: 3456,
      });
      const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      assert.doesNotMatch(config, /official-main\/session-2\/main/);
      assert.match(config, /sub-provider\/session-2\/sub/);
      assert.match(config, /model = "gpt-main"/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  const mainRequests = [];
  const subRequests = [];
  const mainUsage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 7,
    total_tokens: 107,
  };

  const mainUpstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      mainRequests.push({ req, body: Buffer.concat(chunks).toString('utf8') });
      const sse = responsesSse('MAIN_OK', mainUsage);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse.slice(0, 31));
      res.end(sse.slice(31));
    });
  });
  const subUpstream = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      subRequests.push({ req, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        id: 'chat-1', model: 'sub-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'SUB_' }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'chat-1', model: 'sub-model',
        choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'chat-1', model: 'sub-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
      })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });

  const providers = {
    main: provider({
      name: 'Main Responses', baseUrl: `${mainUpstream.url}/v1`, apiKey: TEST_SECRETS[3],
      model: 'main-model', wireApi: 'responses',
    }),
    sub: provider({
      name: 'Sub Chat', baseUrl: `${subUpstream.url}/v1`, apiKey: TEST_SECRETS[4],
      model: 'sub-model', wireApi: 'chat',
    }),
  };
  const usageEvents = [];
  const app = express();
  app.use(express.json());
  mountCodexProxy(app, {
    getProvider: (_appType, id) => providers[id] || null,
    getPort: () => 0,
    onUsage: info => usageEvents.push(info),
  });
  const proxy = await listen(app);

  try {
    await test('main Responses route preserves the stream and attributes usage', async () => {
      const response = await request({
        port: proxy.port,
        path: '/codex-proxy/main/session-1/main/responses',
        body: { model: 'main-model', input: [], stream: true },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, responsesSse('MAIN_OK', mainUsage));
      assert.strictEqual(mainRequests[0].req.url, '/v1/responses');
      assert.strictEqual(mainRequests[0].req.headers.authorization, `Bearer ${TEST_SECRETS[3]}`);
      assert.strictEqual(JSON.parse(mainRequests[0].body).model, 'main-model');
      assert.deepStrictEqual(usageEvents[0], {
        sessionId: 'session-1', role: 'main', providerId: 'main',
        providerName: 'Main Responses', model: 'main-model', isStream: true,
        usage: { inputTokens: 60, outputTokens: 7, cacheWrite: 0, cacheRead: 40 },
      });
    });

    await test('subagent route converts Chat SSE and attributes it to the sub provider', async () => {
      const response = await request({
        port: proxy.port,
        path: '/codex-proxy/sub/session-1/sub/responses',
        body: { model: 'sub-model', input: [], stream: true },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(response.status, 200);
      assert.match(response.body, /response\.completed/);
      const completedLine = response.body.split('\n').find(line => line.startsWith('data: ') && line.includes('response.completed'));
      const completed = JSON.parse(completedLine.slice(6));
      assert.strictEqual(completed.response.output[0].content[0].text, 'SUB_OK');
      assert.strictEqual(subRequests[0].req.url, '/v1/chat/completions');
      assert.strictEqual(subRequests[0].req.headers.authorization, `Bearer ${TEST_SECRETS[4]}`);
      assert.strictEqual(JSON.parse(subRequests[0].body).model, 'sub-model');
      assert.deepStrictEqual(usageEvents[1], {
        sessionId: 'session-1', role: 'sub', providerId: 'sub',
        providerName: 'Sub Chat', model: 'sub-model', isStream: true,
        usage: { inputTokens: 21, outputTokens: 5, cacheWrite: 0, cacheRead: 0 },
      });
    });

    await test('invalid role and unknown provider fail before upstream routing', async () => {
      const badRole = await request({
        port: proxy.port,
        path: '/codex-proxy/main/session-1/aux/responses',
        body: { model: 'main-model', input: [] },
      });
      assert.strictEqual(badRole.status, 400);
      const missing = await request({
        port: proxy.port,
        path: '/codex-proxy/missing/session-1/sub/responses',
        body: { model: 'x', input: [] },
      });
      assert.strictEqual(missing.status, 404);
      assert.strictEqual(mainRequests.length, 1);
      assert.strictEqual(subRequests.length, 1);
    });
  } finally {
    await close(proxy.server);
    await close(mainUpstream.server);
    await close(subUpstream.server);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(redactFailure(error));
  process.exitCode = 1;
}).finally(() => {
  restoreTestEnvironment();
});
