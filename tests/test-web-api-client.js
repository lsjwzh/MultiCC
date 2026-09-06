'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const errorEnvelope = require('../public/error-envelope');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'api-client.js'), 'utf8');

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness(fetchImpl, authReady = Promise.resolve()) {
  const calls = [];
  const window = {
    location: {
      href: 'https://multicc.test/manage.html',
      origin: 'https://multicc.test',
    },
    URL,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
    multiccAuthReady: authReady,
    MultiCCErrorEnvelope: errorEnvelope,
    async fetch(url, options) {
      calls.push({ url, options });
      return fetchImpl(url, options);
    },
  };
  vm.runInNewContext(SOURCE, {
    window,
    URL,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: 'api-client.js' });
  return { api: window.MultiCCApi, calls };
}

test('same-origin JSON waits for auth bootstrap and keeps credentials same-origin', async () => {
  const ready = deferred();
  const h = createHarness(async () => response(200, '{"providers":[]}'), ready.promise);
  const pending = h.api.json('/api/providers');
  await Promise.resolve();
  assert.equal(h.calls.length, 0, 'request escaped before auth bootstrap completed');
  ready.resolve();

  assert.equal(JSON.stringify(await pending), '{"providers":[]}');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://multicc.test/api/providers');
  assert.equal(h.calls[0].options.credentials, 'same-origin');
});

test('cross-origin is opt-in and explicit external requests discard authentication', async () => {
  const h = createHarness(async () => response(200, '{"ok":true}'));

  await assert.rejects(
    h.api.json('https://outside.test/status'),
    error => error.code === 'CROSS_ORIGIN_FORBIDDEN',
  );
  assert.equal(h.calls.length, 0);

  const data = await h.api.json('https://outside.test/status', {
    allowExternal: true,
    headers: {
      Authorization: 'Bearer must-not-leak',
      'X-Access-Token': 'must-not-leak',
      'X-Trace': 'safe',
    },
  });
  assert.equal(JSON.stringify(data), '{"ok":true}');
  const headers = Object.fromEntries(h.calls[0].options.headers.entries());
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-access-token'], undefined);
  assert.equal(headers['x-trace'], 'safe');
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal(h.calls[0].options.referrerPolicy, 'no-referrer');
});

test('URL credentials and token query parameters fail before fetch', async () => {
  const h = createHarness(async () => response(200, '{}'));
  for (const url of [
    '/api/providers?token=super-secret',
    '/api/providers?access_token=super-secret',
    'https://user:password@multicc.test/api/providers',
  ]) {
    await assert.rejects(
      h.api.json(url),
      error => error.code === 'URL_AUTH_FORBIDDEN' && !error.message.includes('super-secret'),
    );
  }
  assert.equal(h.calls.length, 0);
});

test('timeout and caller AbortSignal have stable error codes', async () => {
  const never = () => new Promise(() => {});
  const timed = createHarness(never);
  await assert.rejects(
    timed.api.json('/api/providers', { timeoutMs: 5 }),
    error => error.code === 'API_TIMEOUT' && error.message === 'Request timed out',
  );

  const aborted = createHarness(never);
  const controller = new AbortController();
  const pending = aborted.api.json('/api/providers', { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'API_ABORTED');

  const alreadyAborted = createHarness(never);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(
    alreadyAborted.api.json('/api/providers', { signal: stopped.signal }),
    error => error.code === 'API_ABORTED',
  );
  assert.equal(alreadyAborted.calls.length, 0);
});

test('non-JSON HTTP failures are opaque while request IDs are retained', async () => {
  const h = createHarness(async () => response(503, '<html>private stack and token</html>', {
    'x-multicc-request-id': 'req-header',
    'x-correlation-id': 'corr-header',
  }));

  await assert.rejects(h.api.json('/api/providers'), (error) => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 503);
    assert.equal(error.message, 'HTTP 503');
    assert.equal(error.requestId, 'req-header');
    assert.equal(error.correlationId, 'corr-header');
    assert.equal(error.details, null);
    assert.equal(JSON.stringify(error).includes('private stack'), false);
    return true;
  });
});

test('safe JSON errors retain IDs and provider references but discard credentials', async () => {
  const h = createHarness(async () => response(409, JSON.stringify({
    error: 'provider is still referenced',
    code: 'PROVIDER_IN_USE',
    requestId: 'req-body',
    correlationId: 'corr-body',
    authToken: 'must-not-survive',
    references: [{ kind: 'main', sessionId: 's1', sessionName: 'Primary' }],
  })));

  await assert.rejects(h.api.json('/api/providers/claude/p1'), (error) => {
    assert.equal(error.code, 'PROVIDER_IN_USE');
    assert.equal(error.requestId, 'req-body');
    assert.equal(error.correlationId, 'corr-body');
    assert.equal(error.details.authToken, undefined);
    assert.equal(JSON.stringify(error.details.references[0]), JSON.stringify({
      kind: 'main', sessionId: 's1', sessionName: 'Primary',
    }));
    assert.equal(error.envelope.family, 'route');
    assert.equal(h.api.errorDisplay(error).displayMessage,
      '[PROVIDER_IN_USE] provider is still referenced');
    return true;
  });
});

test('nested coded errors expose the original provider message after value-level redaction', async () => {
  const h = createHarness(async () => response(502, JSON.stringify({
    error: {
      code: 'UPSTREAM_TLS_FAILED',
      message: 'TLS handshake failed token=provider-secret',
      category: 'network',
    },
    requestId: 'req-nested',
  })));

  await assert.rejects(h.api.json('/api/providers/claude/p1/probe'), (error) => {
    assert.equal(error.code, 'UPSTREAM_TLS_FAILED');
    assert.equal(error.message, 'TLS handshake failed token=[redacted]');
    assert.equal(error.family, 'network');
    assert.equal(error.requestId, 'req-nested');
    assert.doesNotMatch(JSON.stringify(error.details), /provider-secret/);
    return true;
  });
});

test('shared presentation helpers retain coded payloads for legacy page call sites', () => {
  const h = createHarness(async () => response(200, '{}'));
  const failure = h.api.errorFromPayload({
    code: 'RUNTIME_SPAWN_FAILED',
    error: 'spawn codex ENOENT',
    requestId: 'req-runtime',
    correlationId: 'corr-runtime',
  }, { status: 500 });

  assert.equal(failure.code, 'RUNTIME_SPAWN_FAILED');
  assert.equal(failure.message, 'spawn codex ENOENT');
  assert.equal(h.api.errorText(failure),
    '[RUNTIME_SPAWN_FAILED] spawn codex ENOENT · HTTP 500 · request req-runtime · correlation corr-runtime');
});

test('JSON success rejects non-JSON bodies and request() exposes response metadata', async () => {
  const invalid = createHarness(async () => response(200, 'not json', { 'x-request-id': 'req-invalid' }));
  await assert.rejects(invalid.api.json('/api/providers'), (error) => {
    assert.equal(error.code, 'INVALID_JSON');
    assert.equal(error.requestId, 'req-invalid');
    return true;
  });

  const valid = createHarness(async () => response(200, '{"ok":true}', {
    'x-request-id': 'req-ok',
    'x-correlation-id': 'corr-ok',
  }));
  const result = await valid.api.request('/api/providers');
  assert.equal(JSON.stringify(result.data), '{"ok":true}');
  assert.equal(result.requestId, 'req-ok');
  assert.equal(result.correlationId, 'corr-ok');
});
