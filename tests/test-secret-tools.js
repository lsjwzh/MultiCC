'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('os');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-secret-tools-test-'));
process.env.MULTICC_DATA_DIR = auditDir;
test.after(() => fs.rmSync(auditDir, { recursive: true, force: true }));
const {
  createSecretTools, createRedactor, createCollector, SecretToolError,
} = require('../src/secret-tools');

const KEY = 'sk-live-Zx9Qm4Tt7Rk2Vn8Ab3Cd';
const OTHER = 'other-secret-value-1234';

function fakeVault(entries = { ARK_API_KEY: KEY, OTHER_KEY: OTHER }) {
  return {
    reveal: name => (Object.prototype.hasOwnProperty.call(entries, name)
      ? { entry: { name, value: entries[name] } }
      : { error: 'entry not found', status: 404 }),
  };
}

function tools(overrides = {}) {
  return createSecretTools({
    vault: fakeVault(),
    resolveSessionCwd: () => os.tmpdir(),
    baseEnv: () => ({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'route-cap', MULTICC_TOKEN: 'host-token', KEEP_ME: 'yes' }),
    logger: { log() {} },
    ...overrides,
  });
}

const ctx = { sessionId: 'sess-1' };

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof SecretToolError, `expected SecretToolError, got ${error}`);
    assert.equal(error.code, code);
    assert.ok(!String(error.message).includes(KEY), 'error message must not carry the value');
    return true;
  });
}

// ── run_with_secrets ─────────────────────────────────────────────────────────

test('run_with_secrets injects the named entry and redacts it (plain, base64, url-encoded) in stdout and stderr', async () => {
  const b64 = Buffer.from(KEY).toString('base64');
  const result = await tools().runWithSecrets(ctx, {
    secrets: ['ARK_API_KEY'],
    command: `echo "plain=$ARK_API_KEY"; echo "b64=${b64}" ; echo "err=$ARK_API_KEY" 1>&2; echo "len=\${#ARK_API_KEY}"`,
  });
  assert.equal(result.exit_code, 0);
  assert.equal(result.timed_out, false);
  assert.ok(result.stdout.includes('plain=[REDACTED:ARK_API_KEY]'));
  assert.ok(result.stdout.includes('b64=[REDACTED:ARK_API_KEY]'));
  assert.ok(result.stderr.includes('err=[REDACTED:ARK_API_KEY]'));
  // The command really received the value: the length is the real one.
  assert.ok(result.stdout.includes(`len=${KEY.length}`));
  for (const text of [result.stdout, result.stderr]) {
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes(b64));
  }
  assert.deepEqual(result.secrets_used, ['ARK_API_KEY']);
});

test('run_with_secrets injects only the listed entries and strips host routing env', async () => {
  const result = await tools().runWithSecrets(ctx, {
    secrets: ['ARK_API_KEY'],
    command: 'echo "other=${OTHER_KEY:-unset} anth=${ANTHROPIC_API_KEY:-unset} mc=${MULTICC_TOKEN:-unset} keep=${KEEP_ME:-unset}"',
  });
  assert.equal(result.stdout.trim(), 'other=unset anth=unset mc=unset keep=yes');
});

test('run_with_secrets reports a failing command without raising', async () => {
  const result = await tools().runWithSecrets(ctx, { secrets: ['ARK_API_KEY'], command: 'echo boom 1>&2; exit 7' });
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 7);
  assert.equal(result.stderr.trim(), 'boom');
});

test('run_with_secrets rejects unknown / illegal names and bad arguments without leaking', async () => {
  const t = tools();
  await expectCode(t.runWithSecrets(ctx, { secrets: ['NOPE'], command: 'true' }), 'unknown_secret');
  await expectCode(t.runWithSecrets(ctx, { secrets: ['bad-name'], command: 'true' }), 'invalid_arguments');
  await expectCode(t.runWithSecrets(ctx, { secrets: [], command: 'true' }), 'invalid_arguments');
  await expectCode(t.runWithSecrets(ctx, { secrets: ['ARK_API_KEY'], command: '  ' }), 'invalid_arguments');
  await expectCode(t.runWithSecrets(ctx, { secrets: ['ARK_API_KEY'], command: 'true', timeout_seconds: 9999 }), 'invalid_arguments');
  await expectCode(t.runWithSecrets(ctx, { secrets: ['ARK_API_KEY'], command: 'true', value: KEY }), 'invalid_arguments');
});

test('run_with_secrets needs a resolvable working directory', async () => {
  const t = tools({ resolveSessionCwd: () => null });
  await expectCode(t.runWithSecrets(ctx, { secrets: ['ARK_API_KEY'], command: 'true' }), 'cwd_unavailable');
});

test('run_with_secrets kills a command (and its children) at the timeout', async () => {
  const started = Date.now();
  const result = await tools().runWithSecrets(ctx, {
    secrets: ['ARK_API_KEY'], command: 'sleep 30 & sleep 30', timeout_seconds: 1,
  });
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - started < 8000, 'must not wait for the full sleep');
});

test('run_with_secrets aborts on the caller signal', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await tools().runWithSecrets(ctx, {
    secrets: ['ARK_API_KEY'], command: 'sleep 30',
  }, { signal: controller.signal });
  assert.equal(result.aborted, true);
});

test('the collector drops a possible secret prefix when its hard cap cuts the text', () => {
  const redactor = createRedactor([{ name: 'K', value: KEY }]);
  const collector = createCollector(20);
  collector.push('a'.repeat(17) + KEY); // the cap lands 3 chars into the value
  const { text, capped } = collector.finish(redactor);
  assert.equal(capped, true);
  assert.ok(!text.includes('sk-'), 'a partial prefix of the value survived the cut');
  // Not capped: nothing is dropped.
  const whole = createCollector(1000);
  whole.push('x' + KEY);
  assert.equal(whole.finish(redactor).text, 'x[REDACTED:K]');
});

test('run_with_secrets keeps the value out of output that exceeds the collection cap', async () => {
  // 2 MiB cap: put the secret straddling the cut.
  const cap = 2 * 1024 * 1024;
  const result = await tools().runWithSecrets(ctx, {
    secrets: ['ARK_API_KEY'],
    command: `head -c ${cap - 6} /dev/zero | tr '\\0' a; printf %s "$ARK_API_KEY"; head -c 2000 /dev/zero | tr '\\0' b`,
  });
  assert.equal(result.truncated.stdout, true);
  assert.ok(!result.stdout.includes('sk-li'), 'a partial prefix of the value escaped');
  assert.ok(!result.stdout.includes(KEY));
});

test('run_with_secrets clips very long output after redaction', async () => {
  const result = await tools().runWithSecrets(ctx, {
    secrets: ['ARK_API_KEY'], command: "head -c 300000 /dev/zero | tr '\\0' x",
  });
  assert.equal(result.stdout.length, 128 * 1024);
  assert.equal(result.truncated.stdout, true);
});

// ── http_request_with_secret ─────────────────────────────────────────────────

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { calls, fetchImpl };
}

function jsonResponse(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' }, ...init,
  });
}

test('http_request_with_secret substitutes placeholders, never follows redirects, and scrubs the reply', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(
    { echoed: `Bearer ${KEY}`, ok: true },
    { headers: { 'content-type': 'application/json', 'x-echo': KEY } },
  ));
  const result = await tools({ fetchImpl }).httpRequestWithSecret(ctx, {
    method: 'POST',
    url: 'https://ark.example.com/v1/tasks?key={{secret:ARK_API_KEY}}&a=1',
    headers: { Authorization: 'Bearer {{secret:ARK_API_KEY}}' },
    json: { model: 'm', note: 'k={{secret:ARK_API_KEY}}' },
  });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `https://ark.example.com/v1/tasks?key=${encodeURIComponent(KEY)}&a=1`);
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(init.body).note, `k=${KEY}`);
  // The reply is scrubbed.
  assert.equal(result.status, 200);
  assert.ok(result.body.includes('Bearer [REDACTED:ARK_API_KEY]'));
  assert.equal(result.headers['x-echo'], '[REDACTED:ARK_API_KEY]');
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.deepEqual(result.secrets_used, ['ARK_API_KEY']);
  assert.equal(result.host, 'ark.example.com');
});

test('http_request_with_secret refuses to run without a placeholder or with an unsafe target', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}));
  const t = tools({ fetchImpl });
  const h = { Authorization: 'Bearer {{secret:ARK_API_KEY}}' };
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'https://a.example.com/' }), 'no_secret_placeholder');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'https://{{secret:ARK_API_KEY}}.example.com/', headers: h }), 'invalid_arguments');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'http://a.example.com/', headers: h }), 'invalid_arguments');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'ftp://a.example.com/', headers: h }), 'invalid_arguments');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'https://u:p@a.example.com/', headers: h }), 'invalid_arguments');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'https://a.example.com/', headers: { Host: 'evil', ...h } }), 'invalid_arguments');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'https://a.example.com/', headers: h, body: 'x' }), 'invalid_arguments');
  await expectCode(t.httpRequestWithSecret(ctx, { method: 'POST', url: 'https://a.example.com/', headers: h, body: 'x', json: {} }), 'invalid_arguments');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'https://a.example.com/', headers: { A: '{{secret:NOPE}}' } }), 'unknown_secret');
  await expectCode(t.httpRequestWithSecret(ctx, { url: 'https://a.example.com/', headers: h, extra: 1 }), 'invalid_arguments');
  assert.equal(calls.length, 0, 'nothing may be sent when validation fails');
});

test('http_request_with_secret blocks header injection through a secret value', async () => {
  const vault = fakeVault({ ARK_API_KEY: 'abc\r\nX-Evil: 1' });
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}));
  const t = tools({ vault, fetchImpl });
  await assert.rejects(
    t.httpRequestWithSecret(ctx, { url: 'https://a.example.com/', headers: { Authorization: '{{secret:ARK_API_KEY}}' } }),
    error => error.code === 'invalid_arguments',
  );
  assert.equal(calls.length, 0);
});

test('http_request_with_secret reports redirects without following them, and omits binary bodies', async () => {
  const h = { Authorization: 'Bearer {{secret:ARK_API_KEY}}' };
  const redirect = tools({
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://other.example.com/x' } }),
  });
  const r = await redirect.httpRequestWithSecret(ctx, { url: 'https://a.example.com/', headers: h });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://other.example.com/x');
  assert.match(r.note, /not followed/);

  const binary = tools({
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp4' } }),
  });
  const b = await binary.httpRequestWithSecret(ctx, { url: 'https://a.example.com/v', headers: h });
  assert.equal(b.body, '');
  assert.match(b.body_omitted, /video\/mp4/);
});

test('http_request_with_secret scrubs the value out of network errors', async () => {
  const t = tools({
    fetchImpl: async url => { throw new Error(`connect failed for ${url}`); },
  });
  await assert.rejects(
    t.httpRequestWithSecret(ctx, { url: 'https://a.example.com/?k={{secret:ARK_API_KEY}}' }),
    error => {
      assert.equal(error.code, 'http_request_failed');
      assert.ok(!error.message.includes(KEY));
      assert.ok(!error.message.includes(encodeURIComponent(KEY)) || error.message.includes('REDACTED'));
      return true;
    },
  );
});

test('http_request_with_secret end-to-end against a real loopback server', async t => {
  let seen = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen = { auth: req.headers.authorization, body: raw, method: req.method };
      // A hostile/echoing API that returns the credential it just received.
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ you_sent: req.headers.authorization, raw }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const result = await createSecretTools({
    vault: fakeVault(), resolveSessionCwd: () => os.tmpdir(), logger: { log() {} },
  }).httpRequestWithSecret(ctx, {
    method: 'POST',
    url: `http://127.0.0.1:${port}/echo`,
    headers: { Authorization: 'Bearer {{secret:ARK_API_KEY}}' },
    json: { k: '{{secret:ARK_API_KEY}}' },
  });
  assert.equal(seen.auth, `Bearer ${KEY}`, 'the server must have received the real credential');
  assert.equal(JSON.parse(seen.body).k, KEY);
  assert.equal(result.status, 200);
  assert.ok(!JSON.stringify(result).includes(KEY), 'the reply handed to the model must be scrubbed');
  assert.ok(result.body.includes('[REDACTED:ARK_API_KEY]'));
});

test('createSecretTools requires a vault', () => {
  assert.throws(() => createSecretTools({}), TypeError);
});
