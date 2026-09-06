'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractUpstreamError, publicUpstreamError, publicTransportError, readUpstreamError } = require('../src/upstream-error');

const cause = {
  message: "Invalid 'input[6].id': 'tool_a'. Expected an ID that begins with 'fc'.",
  type: 'invalid_request_error', code: 'invalid_value', param: 'input[6].id',
};

test('unwraps actual CLI HTTP envelope and retains the deepest original fields', () => {
  const wrapped = `unexpected status 400 Bad Request: ${JSON.stringify({ error: cause, code: 'CODEX_OFFICIAL_OAUTH_UPSTREAM_REJECTED', upstreamStatus: 400 })}, url: http://localhost/codex-proxy/route`;
  assert.deepEqual(extractUpstreamError(wrapped), { ...cause, httpStatus: 400 });
  assert.equal(extractUpstreamError({ error: { message: wrapped } }).message, cause.message);
  assert.equal(extractUpstreamError('connect failed').message, 'connect failed');
  assert.equal(extractUpstreamError('HTTP 400 {"ordinary":"json"}').message, 'HTTP 400 {"ordinary":"json"}');
});

test('balanced error extraction handles quoted braces and escaped quotes', () => {
  const error = { message: 'bad JSON: {"foo": "}"}', code: 'invalid_value' };
  const value = `HTTP 400: ${JSON.stringify({ error })}, appended text`;
  assert.deepEqual(extractUpstreamError(value), error);
});

test('returns original diagnostic fields while removing echoed credentials and unrelated body data', () => {
  const value = { error: { ...cause, message: `${cause.message} Bearer top-secret account-123 api_key=other-secret`, param: 'input[6].id' }, auth: 'unrelated-secret', debug: { request: 'must-not-copy' } };
  const safe = publicUpstreamError(value, { secrets: ['top-secret', 'account-123'] });
  assert.match(safe.message, /input\[6\]\.id/);
  assert.match(safe.message, /begins with 'fc'/);
  assert.equal(safe.param, 'input[6].id');
  assert.equal(safe.code, 'invalid_value');
  assert.doesNotMatch(JSON.stringify(safe), /top-secret|account-123|other-secret|unrelated-secret|must-not-copy/);
});

test('preserves a transport cause rather than replacing fetch failed with another wrapper', () => {
  const error = new Error('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9090'), { code: 'ECONNREFUSED' }) });
  const detail = publicTransportError(error);
  assert.match(detail.message, /ECONNREFUSED/);
  assert.equal(detail.code, 'ECONNREFUSED');
});

test('reads JSON and plain-text error responses, bounded against enormous or stalled bodies', async () => {
  const parsed = await readUpstreamError(new Response(JSON.stringify({ error: cause }), { status: 400 }));
  assert.deepEqual(parsed, cause);
  assert.equal((await readUpstreamError(new Response('upstream maintenance', { status: 503 }))).message, 'upstream maintenance');
  const big = await readUpstreamError(new Response('x'.repeat(100000), { status: 502 }));
  assert.ok(big.message.length <= 65536);
  assert.ok(publicUpstreamError(big).message.length <= 2048);
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 400 });
  const start = Date.now();
  await readUpstreamError(stalled, { timeoutMs: 20 });
  assert.equal(cancelled, true);
  assert.ok(Date.now() - start < 1000);
});

test('cyclic error objects do not recurse forever', () => {
  const error = { message: 'socket closed' };
  error.error = error;
  assert.equal(extractUpstreamError(error).message, 'socket closed');
});
