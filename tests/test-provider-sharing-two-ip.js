'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const providerRouter = require('cli-provider-router');
const { assertTestDir } = require('../src/paths');
const { createProviderRelayShareStore } = require('../src/providers/relay-share-store');
const { findLanIPv4, listen, listenHttp, closeServer, serverOrigin, loadRelayUiModule,
  providerFacade, createInstance, postJson, requestJson, ACCESS_TOKEN, RELAY_TOKEN,
  UPSTREAM_TOKEN, CLIENT_TOKEN, MODEL } = require('./helpers/provider-sharing');

const relayCases = [
  { sourceBackend: 'node', targetBackend: 'node' },
  { sourceBackend: 'rust', targetBackend: 'node' },
  { sourceBackend: 'node', targetBackend: 'rust' },
  { sourceBackend: 'rust', targetBackend: 'rust' },
  { self: true }, // No backend override: prove that both self-relay hops default to Rust.
];
const streamText = 'SHARED_PROVIDER_STREAM_你好🌏';
const sse = obj => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
const streamBody = sse({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 2 } } })
  + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: streamText } })
  + sse({ type: 'message_delta', usage: { output_tokens: 4 } }) + sse({ type: 'message_stop' });

for (const scenario of relayCases) {
test(`Claude LAN sharing ${scenario.self ? 'self → self (default Rust)' : `${scenario.targetBackend} → ${scenario.sourceBackend}`}`,
  { timeout: 20000 }, async t => {
  const lanIp = findLanIPv4();
  if (!lanIp) {
    t.skip('requires an active RFC1918 LAN IPv4 address (or MULTICC_TEST_LAN_IP)');
    return;
  }

  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-provider-two-ip-')));
  const sourceStore = providerRouter.createStore({
    dataFile: path.join(root, 'source', 'providers.json'),
    ccSwitchDb: path.join(root, 'missing-source-cc-switch.db'),
  });
  const targetStore = scenario.self ? sourceStore : providerRouter.createStore({
    dataFile: path.join(root, 'target', 'providers.json'),
    ccSwitchDb: path.join(root, 'missing-target-cc-switch.db'),
  });
  const sourceProviders = providerFacade(sourceStore);
  const targetProviders = providerFacade(targetStore);
  const sourceRelayShares = createProviderRelayShareStore({
    file: path.join(root, 'source', 'provider-relay-shares.json'),
  });
  const targetRelayShares = createProviderRelayShareStore({
    file: path.join(root, 'target', 'provider-relay-shares.json'),
  });
  const upstreamRequests = [];
  const sourceActivity = [];
  const targetActivity = [];
  let source, target, upstreamServer;
  let sourceServer;
  let targetServer;

  t.after(async () => {
    await target?.close();
    if (source !== target) await source?.close();
    await closeServer(targetServer);
    await closeServer(sourceServer);
    await closeServer(upstreamServer);
    assertTestDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  upstreamServer = await listenHttp((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      upstreamRequests.push({ url: request.url, headers: request.headers, body });
      const stream = JSON.parse(body).stream === true;
      response.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.25',
        'anthropic-ratelimit-unified-7d-utilization': '0.6',
        'anthropic-ratelimit-unified-7d-reset': '1900000000' });
      if (stream) {
        // Split in the middle of a UTF-8 character and send the tail later.
        const bytes = Buffer.from(streamBody), split = bytes.indexOf(Buffer.from('你')) + 1;
        response.write(bytes.subarray(0, split));
        setTimeout(() => response.end(bytes.subarray(split)), 40);
        return;
      }
      response.end(JSON.stringify({
        id: 'msg_shared_two_ip',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: 'SHARED_PROVIDER_TWO_IP_OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2 },
      }));
    });
  }, '127.0.0.1');

  sourceStore.saveStore([{
    id: 'source-provider',
    appType: 'claude',
    name: 'LAN Source Claude',
    source: 'local',
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: serverOrigin(upstreamServer),
        ANTHROPIC_AUTH_TOKEN: UPSTREAM_TOKEN,
        ANTHROPIC_MODEL: MODEL,
      },
      modelCatalog: { models: [{ model: MODEL }, { model: `${MODEL}-fallback` }] },
    },
  }]);

  source = createInstance({
    providers: sourceProviders,
    providerRelayShares: sourceRelayShares,
    defaultsFile: path.join(root, 'source', 'provider-defaults.json'),
    activity: sourceActivity,
    backend: scenario.sourceBackend,
  });
  target = scenario.self ? source : createInstance({
    providers: targetProviders,
    providerRelayShares: targetRelayShares,
    defaultsFile: path.join(root, 'target', 'provider-defaults.json'),
    activity: targetActivity,
    backend: scenario.targetBackend,
  });
  sourceServer = await listen(source.app, scenario.self ? '0.0.0.0' : lanIp);
  targetServer = scenario.self ? sourceServer : await listen(target.app, '127.0.0.1');
  const sourceOrigin = `http://${lanIp}:${sourceServer.address().port}`;
  const targetOrigin = scenario.self ? `http://127.0.0.1:${sourceServer.address().port}` : serverOrigin(targetServer);

  assert.equal(sourceServer.address().address, scenario.self ? '0.0.0.0' : lanIp);
  assert.equal(targetServer.address().address, scenario.self ? '0.0.0.0' : '127.0.0.1');
  assert.equal(source.runtime.proxyBackend, scenario.sourceBackend || 'rust');
  assert.equal(target.runtime.proxyBackend, scenario.targetBackend || 'rust');

  const shared = await postJson(
    `${sourceOrigin}/api/providers/claude/source-provider/relay-share`,
    { publicBaseUrl: sourceOrigin, token: RELAY_TOKEN, label: 'two IP test' },
    { 'x-access-token': ACCESS_TOKEN },
  );
  assert.equal(shared.response.status, 200);
  assert.equal(shared.body.ok, true);
  assert.equal(new URL(shared.body.baseUrl).hostname, lanIp,
    'the shared Provider advertises the real LAN address');
  assert.equal(JSON.stringify(shared.body).includes(UPSTREAM_TOKEN), false,
    'the share response never exposes the upstream credential');

  const relayUi = loadRelayUiModule();
  const parsed = relayUi.parseRelayShareCode(shared.body.code);
  assert.equal(parsed.error, undefined);
  const payload = JSON.parse(JSON.stringify(parsed.payload));
  assert.equal(payload.baseUrl, `${sourceOrigin}/claude-proxy/source-provider/remote`);
  assert.match(payload.authToken, /^mcr1\.[A-Za-z0-9_-]{16}\./);
  assert.notEqual(payload.authToken, RELAY_TOKEN);
  assert.equal(payload.model, MODEL);
  assert.deepEqual(payload.models, [MODEL, `${MODEL}-fallback`]);
  const providerInput = JSON.parse(JSON.stringify(relayUi.relayProviderInput(parsed.payload)));

  const imported = await postJson(`${targetOrigin}/api/providers`, providerInput, { 'x-access-token': ACCESS_TOKEN });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.ok, true);
  const importedSummary = targetStore.getProviderSummary('claude', imported.body.id);
  assert.equal(importedSummary.baseUrl, payload.baseUrl);
  assert.equal(importedSummary.model, MODEL);
  assert.deepEqual(importedSummary.modelOptions, [MODEL, `${MODEL}-fallback`]);

  const prompt = {
    model: MODEL,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'verify shared provider over two IPs' }],
  };
  const wrongToken = await postJson(`${shared.body.baseUrl}/v1/messages`, prompt, {
    'x-api-key': `mcr1.${shared.body.share.id}.wrong-relay-secret`,
    'anthropic-version': '2023-06-01',
  });
  assert.equal(wrongToken.response.status, 403);
  assert.equal(upstreamRequests.length, 0, 'a bad share token never reaches the upstream');

  const fenced = await postJson(
    `${sourceOrigin}/claude-proxy/source-provider/not-an-attempt/v1/messages`,
    prompt,
    { 'x-access-token': ACCESS_TOKEN, 'anthropic-version': '2023-06-01' },
  );
  assert.equal(fenced.response.status, 409,
    'an unknown session bucket cannot bypass the attempt guard');
  assert.equal(upstreamRequests.length, 0, 'a rejected attempt route never reaches upstream');

  const escalated = await requestJson(`${sourceOrigin}/api/provider-defaults`, {
    headers: { 'x-api-key': payload.authToken, accept: 'application/json' },
  });
  assert.equal(escalated.response.status, 403,
    'the relay token cannot open non-CPR API routes');

  const relayed = await postJson(
    `${targetOrigin}/claude-proxy/${encodeURIComponent(imported.body.id)}/aux/v1/messages`,
    prompt,
    {
      'x-api-key': CLIENT_TOKEN,
      'anthropic-version': '2023-06-01',
    },
  );
  assert.equal(relayed.response.status, 200);
  assert.equal(relayed.body.content[0].text, 'SHARED_PROVIDER_TWO_IP_OK');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  const upstream = upstreamRequests[0];
  assert.equal(upstream.url, '/v1/messages');
  assert.equal(upstream.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
  assert.equal(upstream.headers['x-api-key'], undefined);
  assert.equal(upstream.headers['x-access-token'], undefined);
  assert.equal(JSON.stringify(upstream.headers).includes(RELAY_TOKEN), false);
  assert.equal(JSON.stringify(upstream.headers).includes(CLIENT_TOKEN), false);
  assert.equal(JSON.parse(upstream.body).model, MODEL);
  assert.ok(source.metrics.includes('multicc_auth_proxy_relay_total'));
  assert.ok(source.metrics.includes('multicc_auth_provider_relay_share_total'));
  const relayRecord = sourceRelayShares.list()[0];
  assert.equal(relayRecord.accessCount, 1);
  assert.ok(relayRecord.lastUsedAt);
  assert.ok((scenario.self ? sourceActivity : targetActivity).some(event => event.role === 'aux'
    && event.providerId === imported.body.id));
  assert.ok(sourceActivity.some(event => event.role === 'main'
    && event.providerId === 'source-provider'));

  const streamed = await fetch(`${targetOrigin}/claude-proxy/${imported.body.id}/aux/v1/messages`, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', 'x-api-key': CLIENT_TOKEN },
    body: JSON.stringify({ ...prompt, stream: true }),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  assert.equal(streamed.headers.get('anthropic-ratelimit-unified-7d-utilization'), '0.6');
  const reader = streamed.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(!Buffer.from(first.value).includes(Buffer.from('message_stop')), 'SSE arrives before completion');
  const chunks = [first.value];
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); }
  assert.equal(Buffer.concat(chunks).toString('utf8'), streamBody);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstreamRequests.length, 2, 'self relay terminates at the source rather than looping');
  assert.equal(sourceRelayShares.list()[0].accessCount, 2);
  for (const [instance, id] of [[source, 'source-provider'], [target, imported.body.id]]) {
    const events = instance.usage.filter(event => event.providerId === id);
    assert.equal(events.length, 2, 'one usage event per hop and request');
    assert.ok(events.every(event => event.status === 'success'));
    assert.deepEqual(events.map(event => event.tokens), Array(2).fill({ input: 3, output: 4, cacheRead: 2, cacheWrite: 0, total: 7 }));
    assert.ok(instance.rates.filter(event => event.providerId === id).every(event =>
      event.rateLimitInfo.windows.some(window => window.window === '1wk' && window.usedPercent === 60)));
    assert.equal(instance.rates.filter(event => event.providerId === id).length, 2);
  }

  console.log(`provider sharing LAN integration: ${target.runtime.proxyBackend} ${targetOrigin} → ${source.runtime.proxyBackend} ${sourceOrigin}; self=${!!scenario.self}; JSON/SSE/usage/quota/auth checked`);
});

test(`Codex LAN sharing ${scenario.self ? 'self → self (default Rust)' : `${scenario.targetBackend} → ${scenario.sourceBackend}`}`,
  { timeout: 20000 }, async t => {
  const lanIp = findLanIPv4();
  if (!lanIp) return t.skip('requires an active RFC1918 LAN IPv4 address');
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-two-ip-')));
  const requests = [], instances = [], servers = [];
  t.after(async () => {
    await Promise.all(instances.map(instance => instance.close()));
    await Promise.all(servers.map(server => closeServer(server)));
    fs.rmSync(assertTestDir(root), { recursive: true, force: true });
  });
  const jsonBody = { id: 'resp_lan', object: 'response', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: streamText }] }],
    usage: { input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } };
  const codexStream = sse({ type: 'response.output_text.delta', delta: streamText })
    + sse({ type: 'response.completed', response: jsonBody });
  const upstream = await listenHttp((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': JSON.parse(body).stream ? 'text/event-stream' : 'application/json' });
      res.end(JSON.parse(body).stream ? codexStream : JSON.stringify(jsonBody));
    });
  }, '127.0.0.1');
  servers.push(upstream);
  const store = name => providerRouter.createStore({ dataFile: path.join(root, name, 'providers.json'),
    ccSwitchDb: path.join(root, 'missing.db') });
  const sourceStore = store('source'), targetStore = scenario.self ? sourceStore : store('target');
  sourceStore.saveStore([{ id: 'source-codex', appType: 'codex', name: 'LAN Source Codex', source: 'local',
    settingsConfig: { auth: { OPENAI_API_KEY: UPSTREAM_TOKEN }, config: `model = "${MODEL}"\nmodel_provider = "fixture"\n[model_providers.fixture]\nbase_url = "${serverOrigin(upstream)}/v1"\nwire_api = "responses"\n` } }]);
  const make = (store, name, backend) => {
    const instance = createInstance({ providers: providerFacade(store),
      providerRelayShares: createProviderRelayShareStore({ file: path.join(root, name, 'shares.json') }),
      defaultsFile: path.join(root, name, 'defaults.json'), activity: [], backend,
      authorizeProxyRequest: route => ({ ok: route.sessionId === 'fixture', code: 'no-active-attempt' }) });
    instances.push(instance); return instance;
  };
  const source = make(sourceStore, 'source', scenario.sourceBackend);
  const target = scenario.self ? source : make(targetStore, 'target', scenario.targetBackend);
  const sourceServer = await listen(source.app, scenario.self ? '0.0.0.0' : lanIp);
  servers.push(sourceServer);
  const targetServer = scenario.self ? sourceServer : await listen(target.app, '127.0.0.1');
  if (!scenario.self) servers.push(targetServer);
  const sourceOrigin = `http://${lanIp}:${sourceServer.address().port}`;
  const targetOrigin = `http://127.0.0.1:${targetServer.address().port}`;
  assert.equal(source.runtime.proxyBackend, scenario.sourceBackend || 'rust');
  assert.equal(target.runtime.proxyBackend, scenario.targetBackend || 'rust');
  const shared = await postJson(`${sourceOrigin}/api/providers/codex/source-codex/relay-share`,
    { publicBaseUrl: sourceOrigin, token: RELAY_TOKEN }, { 'x-access-token': ACCESS_TOKEN });
  assert.equal(shared.response.status, 200);
  const ui = loadRelayUiModule(), parsed = ui.parseRelayShareCode(shared.body.code);
  assert.equal(parsed.payload.baseUrl, `${sourceOrigin}/codex-proxy/source-codex`);
  const imported = await postJson(`${targetOrigin}/api/providers`, JSON.parse(JSON.stringify(ui.relayProviderInput(parsed.payload))));
  assert.equal(imported.response.status, 200);
  const prompt = { model: MODEL, input: 'verify shared Codex over LAN', stream: false };
  const denied = await postJson(`${shared.body.baseUrl}/responses`, prompt, { authorization: 'Bearer wrong-relay-secret' });
  assert.equal(denied.response.status, 403); assert.equal(requests.length, 0);
  for (const stream of [false, true]) {
    const response = await fetch(`${targetOrigin}/codex-proxy/${imported.body.id}/fixture/main/responses`, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_TOKEN}` },
      body: JSON.stringify({ ...prompt, stream }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), stream ? codexStream : JSON.stringify(jsonBody));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
    assert.equal(request.body.model, MODEL);
    assert.equal(request.headers['x-api-key'], undefined);
  }
  const events = target.usage.filter(event => event.providerId === imported.body.id);
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.status === 'success'));
  // Responses input_tokens includes cached tokens; normalized input excludes them.
  assert.deepEqual(events.map(event => event.tokens), Array(2).fill({ input: 1, output: 4, cacheRead: 2, cacheWrite: 0, total: 5 }));
  console.log(`Codex sharing LAN integration: ${target.runtime.proxyBackend} ${targetOrigin} → ${source.runtime.proxyBackend} ${sourceOrigin}; self=${!!scenario.self}; JSON/SSE/usage/auth checked`);
});
}
