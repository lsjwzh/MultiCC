'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { managedRoute, createRouteRelay } = require('../src/chat/claude-sdk-route');

test('relay accepts only local CPR routes and authenticated Messages requests', async t => {
  for (const url of ['https://127.0.0.1/claude-proxy/p/s', 'http://example.org/claude-proxy/p/s',
    'http://user:pass@127.0.0.1/claude-proxy/p/s', 'http://127.0.0.1/claude-proxy/p/s?x=y']) {
    assert.equal(managedRoute({ ANTHROPIC_BASE_URL: url }), null);
  }
  const relay = await createRouteRelay();
  t.after(() => relay.close());
  assert.equal((await fetch(`${relay.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST' })).status, 401);
  const headers = { authorization: `Bearer ${relay.env.ANTHROPIC_AUTH_TOKEN}` };
  for (const [method, path] of [['GET', '/v1/messages'], ['POST', '/api/internal'], ['POST', '/v1/messages/../../admin']]) {
    assert.equal((await fetch(relay.env.ANTHROPIC_BASE_URL + path, { method, headers })).status, 404);
  }
});

test('relay pins active requests, replaces auth and preserves SSE bytes and backpressure', async t => {
  const received = [];
  let release, requested;
  const ready = new Promise(resolve => { requested = resolve; });
  const tail = Buffer.from('\ndata: {"type":"message_stop"}\n\n');
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-test-response': 'preserved' });
    res.write(Buffer.from('data: 中文\n'));
    release = () => res.end(tail);
    requested();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const relay = await createRouteRelay();
  t.after(() => relay.close());
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}/claude-proxy/provider/old`,
    ANTHROPIC_AUTH_TOKEN: 'old-capability' };
  relay.bind(env);
  const response = fetch(relay.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
    method: 'POST', headers: { authorization: `Bearer ${relay.env.ANTHROPIC_AUTH_TOKEN}`,
      'x-api-key': 'must-not-pass', 'content-type': 'application/json' }, body: '{"stream":true}',
  });
  await ready;
  assert.throws(() => relay.bind({ ...env, ANTHROPIC_AUTH_TOKEN: 'new' }), { code: 'SDK_ROUTE_BUSY' });
  const res = await response;
  release();
  assert.equal(await res.text(), 'data: 中文\n' + tail.toString());
  assert.equal(res.headers.get('x-test-response'), 'preserved');
  await relay.drain();
  assert.equal(received[0].url, '/claude-proxy/provider/old/v1/messages?beta=true');
  assert.equal(received[0].headers.authorization, 'Bearer old-capability');
  assert.equal(received[0].headers['x-api-key'], undefined);
  assert.equal(received[0].body, '{"stream":true}');
  relay.bind({ ...env, ANTHROPIC_AUTH_TOKEN: 'new' });
});

test('closing a relay aborts an unfinished upstream and closes its listener', async t => {
  let started, ended;
  const ready = new Promise(resolve => { started = resolve; });
  const disconnected = new Promise(resolve => { ended = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume(); res.once('close', ended); started();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const relay = await createRouteRelay();
  t.after(() => relay.close());
  relay.bind({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}/claude-proxy/p/s`, ANTHROPIC_AUTH_TOKEN: 'route' });
  const request = fetch(relay.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST',
    headers: { authorization: `Bearer ${relay.env.ANTHROPIC_AUTH_TOKEN}` }, body: '{}' });
  const failed = assert.rejects(request);
  await ready;
  await assert.rejects(relay.drain(10), { code: 'SDK_ROUTE_BUSY' });
  await relay.close();
  await Promise.all([failed, disconnected]);
  await assert.rejects(fetch(relay.env.ANTHROPIC_BASE_URL));
});
