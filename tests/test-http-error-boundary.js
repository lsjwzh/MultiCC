'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAIN_KINDS,
  DomainError,
  InfrastructureError,
  HttpError,
  asyncRoute,
  mapError,
  presentDiagnosticResult,
  presentError,
} = require('../src/http');
const { safeErrorHandler } = require('../src/http-errors');

const REQUEST_CONTEXT = Object.freeze({
  requestId: 'req_http_boundary_1',
  correlationId: 'corr_http_boundary_1',
});

test('maps domain and infrastructure errors to stable HTTP contracts', () => {
  const cases = [
    [DOMAIN_KINDS.BAD_REQUEST, 400, 'invalid_request', 'invalid input'],
    [DOMAIN_KINDS.NOT_FOUND, 404, 'not_found', 'session not found'],
    [DOMAIN_KINDS.CONFLICT, 409, 'conflict', 'session is active'],
    [DOMAIN_KINDS.RATE_LIMITED, 429, 'rate_limited', 'try again later'],
  ];

  for (const [kind, status, code, message] of cases) {
    const presented = presentError(new DomainError(kind, message), REQUEST_CONTEXT);
    assert.equal(presented.status, status);
    assert.deepEqual(presented.body, {
      ok: false,
      error: message,
      code,
      apiVersion: 'v1',
      requestId: REQUEST_CONTEXT.requestId,
      correlationId: REQUEST_CONTEXT.correlationId,
    });
  }

  for (const error of [
    new DomainError(DOMAIN_KINDS.INTERNAL, 'database credentials leaked'),
    new InfrastructureError('spawn stderr contained a token'),
  ]) {
    const presented = presentError(error, REQUEST_CONTEXT);
    assert.equal(presented.status, 500);
    assert.equal(presented.body.code, 'internal_error');
    assert.equal(presented.body.error, 'internal_error');
  }
});

test('unknown errors and forged status fields remain internal errors', () => {
  const forged = Object.assign(new Error('pretend this is safe'), {
    status: 404,
    statusCode: 409,
    safe: true,
    code: 'not_found',
    compatibility: { blocked: true },
  });

  for (const error of [forged, new Error('plain failure'), { statusCode: 400 }]) {
    const mapped = mapError(error);
    assert.ok(mapped instanceof HttpError);
    assert.equal(mapped.status, 500);
    assert.equal(mapped.code, 'internal_error');

    const presented = presentError(error, REQUEST_CONTEXT, { compatibility: true });
    assert.deepEqual(presented.body, {
      ok: false,
      error: 'internal_error',
      code: 'internal_error',
      apiVersion: 'v1',
      requestId: REQUEST_CONTEXT.requestId,
      correlationId: REQUEST_CONTEXT.correlationId,
    });
  }

  const invalidCode = presentError(new DomainError(DOMAIN_KINDS.CONFLICT, 'busy', {
    code: 'not a safe code',
  }), REQUEST_CONTEXT);
  assert.equal(invalidCode.body.code, 'conflict');
});

test('presenter exposes only explicit compatibility fields', () => {
  const error = new DomainError(DOMAIN_KINDS.CONFLICT, 'worktree is active', {
    code: 'worktree_conflict',
    compatibility: {
      blocked: true,
      reasons: ['active', 'leased', 'token=hidden'],
      conflicts: ['src/http/error-map.js', '/Users/example/.env', '../escape'],
      operationId: 'merge_17',
      field: 'worktree',
      currentStatus: 'active',
      queueDepth: 2,
      retryAfterSec: 5,
      sessions: ['session_1', 'invalid session'],
      stack: 'Error at /Users/example/private.js',
      stderr: 'provider token=hidden',
      token: 'hidden',
      secret: 'hidden',
      upstream: 'raw provider response',
      arbitrary: 'not public',
    },
  });

  const strict = presentError(error, REQUEST_CONTEXT);
  assert.equal(strict.body.blocked, undefined);

  const compatible = presentError(error, REQUEST_CONTEXT, { compatibility: true });
  assert.deepEqual(compatible.body, {
    ok: false,
    error: 'worktree is active',
    code: 'worktree_conflict',
    apiVersion: 'v1',
    requestId: REQUEST_CONTEXT.requestId,
    correlationId: REQUEST_CONTEXT.correlationId,
    blocked: true,
    reasons: ['active', 'leased'],
    conflicts: ['src/http/error-map.js'],
    operationId: 'merge_17',
    field: 'worktree',
    currentStatus: 'active',
    queueDepth: 2,
    retryAfterSec: 5,
    sessions: ['session_1'],
  });

  const serialized = JSON.stringify(compatible.body);
  for (const forbidden of ['hidden', '/Users/', 'stderr', 'stack', 'upstream', 'arbitrary']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('sensitive public text falls back to the stable legacy error', () => {
  const sensitive = [
    'Bearer abcdef123456 failed',
    'token=top-secret',
    'stderr=/Users/example/private.log',
    'upstream response was raw',
  ].join(' ');
  const presented = presentError(
    new DomainError(DOMAIN_KINDS.CONFLICT, sensitive, { code: 'worktree_conflict' }),
    REQUEST_CONTEXT,
  );

  assert.equal(presented.status, 409);
  assert.equal(presented.body.error, 'conflict');
  assert.equal(presented.body.code, 'worktree_conflict');
  assert.equal(JSON.stringify(presented.body).includes('top-secret'), false);
  assert.equal(JSON.stringify(presented.body).includes('/Users/'), false);
});

test('mapped errors remain compatible with the existing safeErrorHandler', () => {
  const mapped = mapError(new DomainError(DOMAIN_KINDS.NOT_FOUND, 'session not found', {
    code: 'session_not_found',
  }));
  const request = {
    id: REQUEST_CONTEXT.requestId,
    correlationId: REQUEST_CONTEXT.correlationId,
    method: 'GET',
    path: '/api/sessions/missing',
  };
  const response = {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const logger = { error() {} };

  safeErrorHandler(logger)(mapped, request, response, () => {});

  assert.equal(mapped.safe, true);
  assert.throws(() => { mapped.message = 'token=mutated'; }, TypeError);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'session not found',
    code: 'session_not_found',
    apiVersion: 'v1',
    requestId: REQUEST_CONTEXT.requestId,
    correlationId: REQUEST_CONTEXT.correlationId,
  });
});

test('asyncRoute maps asynchronous rejections before forwarding them', async () => {
  const conflict = asyncRoute(async () => {
    throw new DomainError(DOMAIN_KINDS.CONFLICT, 'already running');
  });
  const forged = asyncRoute(async () => {
    throw Object.assign(new Error('forged'), { statusCode: 404, safe: true });
  });

  const invoke = (route) => new Promise((resolve, reject) => {
    route({}, {}, (error) => {
      if (!error) reject(new Error('expected an error'));
      else resolve(error);
    });
  });

  const conflictError = await invoke(conflict);
  assert.ok(conflictError instanceof HttpError);
  assert.equal(conflictError.status, 409);

  const forgedError = await invoke(forged);
  assert.ok(forgedError instanceof HttpError);
  assert.equal(forgedError.status, 500);
});

test('diagnostic results preserve HTTP success while sanitizing legacy ok:false bodies', () => {
  const diagnostic = presentDiagnosticResult({
    ok: false,
    code: 'provider_probe_failed',
    error: 'upstream token=top-secret at /Users/example/provider.log',
    blocked: true,
    reasons: ['unhealthy', 'secret=hidden'],
    operationId: 'probe_7',
    retryAfterMs: 250,
    status: 404,
    statusCode: 429,
    stderr: 'token=top-secret',
    token: 'top-secret',
  }, REQUEST_CONTEXT, { kind: DOMAIN_KINDS.CONFLICT });

  assert.equal(diagnostic.status, 200);
  assert.deepEqual(diagnostic.body, {
    ok: false,
    error: 'conflict',
    code: 'provider_probe_failed',
    apiVersion: 'v1',
    requestId: REQUEST_CONTEXT.requestId,
    correlationId: REQUEST_CONTEXT.correlationId,
    blocked: true,
    reasons: ['unhealthy'],
    operationId: 'probe_7',
    retryAfterMs: 250,
  });
  assert.equal(JSON.stringify(diagnostic.body).includes('top-secret'), false);

  assert.throws(
    () => presentDiagnosticResult({ ok: true }, REQUEST_CONTEXT),
    /requires a legacy \{ ok:false \} result/,
  );
});
