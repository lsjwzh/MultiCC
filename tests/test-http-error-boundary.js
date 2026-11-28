'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const current = require('../src/native/binding').httpErrors;
const { DOMAIN_KINDS, DomainError, InfrastructureError, HttpError, mapError, safeErrorHandler } = current;
const { presentError } = require('../src/http/error-presenter');

const REQUEST_CONTEXT = Object.freeze({
  requestId: 'req_http_boundary_1',
  correlationId: 'corr_http_boundary_1',
});

test('maps domain and infrastructure errors to stable HTTP contracts', () => {
  const cases = [
    [DOMAIN_KINDS.BAD_REQUEST, 400, 'invalid_request', 'invalid input'],
    [DOMAIN_KINDS.PAYLOAD_TOO_LARGE, 413, 'payload_too_large', 'payload too large'],
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
      conflicts: ['src/http-errors.js', '/Users/example/.env', '../escape'],
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
    conflicts: ['src/http-errors.js'],
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


const frozen = {
  ...require('./helpers/frozen-file-batch14/domain-error'),
  ...require('./helpers/frozen-file-batch13/http-error'),
  ...require('./helpers/frozen-file-batch13/error-map'),
};

function describeError(error, api, cause) {
  assert.ok(error instanceof api.HttpError && error instanceof Error);
  assert.equal(api.isHttpError(error), true);
  assert.equal(api.mapError(error), error);
  assert.equal(Object.isFrozen(error), true);
  const [brand] = Object.getOwnPropertySymbols(error);
  return {
    keys: Object.keys(error),
    message: error.message,
    fields: { ...error, cause: error.cause === cause },
    compatibilityFrozen: Object.isFrozen(error.compatibility),
    brand: [brand.description, Object.getOwnPropertyDescriptor(error, brand)],
  };
}

test('HTTP status, public fields, private brand and cause match the frozen constructor', () => {
  const cause = Symbol('cause');
  const compatibility = { blocked: true, reasons: ['busy', 'busy', 'invalid reason'] };
  for (const status of [undefined, null, 399, 400, 413, 499, 499.5, 500, 599, 600,
    NaN, Infinity, '409', 400n, Symbol('status'), Object(400)]) {
    assert.equal(current.trustedStatus(status), frozen.trustedStatus(status));
    for (const message of ['  busy\n now ', 'token=private', '\ud800', '']) {
      const options = { status, code: 'custom', message, compatibility, cause };
      assert.deepEqual(describeError(new current.HttpError(options), current, cause),
        describeError(new frozen.HttpError(options), frozen, cause));
    }
  }
  assert.deepEqual(current.DOMAIN_ERROR_MAP, frozen.DOMAIN_ERROR_MAP);
  assert.ok(Object.isFrozen(current.DOMAIN_ERROR_MAP));
  assert.ok(Object.values(current.DOMAIN_ERROR_MAP).every(Object.isFrozen));
});

test('frozen mapper agrees on branding, getter order, identity and thrown values', () => {
  const sentinel = new Error('getter failed');
  for (const make of [
    () => undefined, () => null, () => 0, () => Symbol('unknown'),
    () => ({ get status() { throw sentinel; } }),
    api => new api.InfrastructureError('private', { compatibility: { blocked: true } }),
    ...[...Object.values(DOMAIN_KINDS), 'unknown', 'constructor', '__proto__']
      .map(kind => api => new api.DomainError(kind, 'busy', { code: 'bad code' })),
    api => Object.defineProperty(new api.DomainError('conflict', 'busy'), 'publicMessage', {
      get() { throw sentinel; },
    }),
  ]) {
    function run(api) {
      const target = make(api);
      const reads = [];
      const error = target && typeof target === 'object' ? new Proxy(target, {
        get(obj, key, receiver) {
          reads.push(typeof key === 'symbol' ? key.description : key);
          return Reflect.get(obj, key, receiver);
        },
      }) : target;
      try { return { result: describeError(api.mapError(error), api, error), reads }; }
      catch (err) {
        assert.equal(err, sentinel);
        return { threw: true, reads };
      }
    }
    assert.deepEqual(run(current), run(frozen));
  }
});

test('domain constructors preserve field descriptors, brands and JS value identity', () => {
  const cause = new Error('cause');
  const code = Symbol('code');
  const compatibility = { blocked: true };
  const options = { cause, code, compatibility };
  function describe(api, kind, message, publicMessage, infrastructure) {
    const reads = [];
    const params = new Proxy({ ...options, publicMessage }, {
      get(target, key) { reads.push(key); return target[key]; },
    });
    const error = infrastructure ? new api.InfrastructureError(message, params)
      : new api.DomainError(kind, message, params);
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.equal(error.compatibility, compatibility);
    assert.equal(error.cause, cause);
    assert.equal(api.isDomainError(error), !infrastructure);
    assert.equal(api.isInfrastructureError(error), infrastructure);
    const [brand] = Object.getOwnPropertySymbols(error);
    return {
      reads, brand: brand.description, descriptor: Object.getOwnPropertyDescriptor(error, brand),
      keys: Object.keys(error), fields: { ...error }, message: error.message,
      frozen: Object.isFrozen(error),
    };
  }
  assert.deepEqual(current.DOMAIN_KINDS, frozen.DOMAIN_KINDS);
  assert.ok(Object.isFrozen(current.DOMAIN_KINDS));
  for (const kind of [null, 0, false, NaN, 7n, Symbol('kind'), 'conflict', '\ud800']) {
    for (const message of ['', '\udc00', null, false, Object('boxed')]) {
      for (const publicMessage of [undefined, null, false, cause]) {
        for (const infrastructure of [false, true]) {
          const args = [kind, message, publicMessage, infrastructure];
          assert.deepEqual(describe(current, ...args), describe(frozen, ...args));
        }
      }
    }
  }
});

test('domain constructors preserve setter order, coercion errors and optional cause', () => {
  for (const api of [current, frozen]) {
    const trace = [];
    const sentinel = new Error('coercion');
    const kind = { [Symbol.toPrimitive](hint) { trace.push(hint); throw sentinel; } };
    class Observed extends api.DomainError {
      set name(value) { trace.push(value); }
    }
    const opts = new Proxy({}, { get(_, key) { trace.push(key); } });
    assert.throws(() => new Observed(kind, null, opts), error => error === sentinel);
    assert.deepEqual(trace, ['code', 'publicMessage', 'compatibility', 'cause', 'DomainError', 'string']);
    for (const error of [new api.DomainError(), new api.InfrastructureError()]) {
      assert.equal(Object.hasOwn(error, 'cause'), false);
    }
    assert.throws(() => new api.DomainError('conflict', '', null), TypeError);
  }
});

const frozenPublicSafety = require('./helpers/frozen-file-batch19/public-safety');
const currentPublicSafety = require('../src/native/binding').getPublicSafety();

test('public error cleaning matches frozen UTF-16, whitespace and pattern boundaries', () => {
  const values = [undefined, null, false, 0, NaN, Infinity, 12n, Symbol('safe'), {},
    '', 'okay', 'okay\n', 'okay\r\n', 'okay\u2028', '\ufeff safe \ufeff', '\u0085safe\u0085',
    '\ud800', '\udc00', 'x'.repeat(239) + '😀', 'x'.repeat(241), 'line\u0000\t break',
    'Bearer credential', 'token is private', 'upstream error', '/Users/fixture/private/file',
    'C:\\Users\\fixture\\file', 'sk-abcdefghijk', 'src/file.js'];
  const fallback = { identity: true };
  assert.deepEqual(Object.keys(currentPublicSafety), Object.keys(frozenPublicSafety));
  assert.equal(String(currentPublicSafety.CODE_PATTERN), String(frozenPublicSafety.CODE_PATTERN));
  assert.equal(String(currentPublicSafety.ID_PATTERN), String(frozenPublicSafety.ID_PATTERN));
  for (const value of values) {
    for (const method of ['validCode', 'validId', 'containsSensitiveText']) {
      assert.deepEqual(currentPublicSafety[method](value), frozenPublicSafety[method](value));
    }
    assert.equal(currentPublicSafety.safeCode(value, fallback), frozenPublicSafety.safeCode(value, fallback));
    for (const other of [undefined, null, '', '\ufeff ', '\ud800', 'x'.repeat(239) + '😀']) {
      assert.equal(currentPublicSafety.sanitizePublicText(value, other), frozenPublicSafety.sanitizePublicText(value, other));
    }
  }
});

test('compatibility cleaning preserves lazy reads, field order and frozen projections', () => {
  const sentinel = new Error('getter');
  function observe(api, throwing) {
    const reads = [];
    const raw = {
      blocked: true,
      reasons: ['busy', 'busy', 'not valid', 'okay\n'],
      conflicts: ['src/file.js', 'src\\file.js', '../outside', '\ud800.md', 'token=fixture'],
      operationId: 'operation:1', field: 'field', currentStatus: 'ready',
      queueDepth: -0, retryAfter: NaN, retryAfterSec: Infinity, retryAfterMs: 4,
      sessions: ['session_1', 'session_1', 'invalid space'], sessionIds: ['session_2'],
    };
    const input = new Proxy(raw, {
      get(target, key) {
        reads.push(key);
        if (throwing && key === 'conflicts') throw sentinel;
        return target[key];
      },
    });
    try {
      const value = api.sanitizeCompatibility(input);
      assert.ok(Object.isFrozen(value));
      for (const field of ['reasons', 'conflicts', 'sessions', 'sessionIds']) assert.ok(Object.isFrozen(value[field]));
      assert.ok(Object.is(value.queueDepth, -0));
      return { reads, keys: Object.keys(value), value };
    } catch (error) {
      assert.equal(error, sentinel);
      return { reads, threw: true };
    }
  }
  for (const throwing of [false, true]) assert.deepEqual(observe(currentPublicSafety, throwing), observe(frozenPublicSafety, throwing));
  for (const value of [null, false, 1, [], () => {}, Symbol()]) {
    assert.deepEqual(currentPublicSafety.sanitizeCompatibility(value), frozenPublicSafety.sanitizeCompatibility(value));
  }
});

test('public code checks retain the exported regex and coercion exceptions', () => {
  const sentinel = new Error('conversion');
  for (const api of [currentPublicSafety, frozenPublicSafety]) {
    const value = { [Symbol.toPrimitive](hint) { assert.equal(hint, 'string'); throw sentinel; } };
    assert.throws(() => api.containsSensitiveText(value), error => error === sentinel);
    api.CODE_PATTERN.exec = () => null;
    try { assert.equal(api.validCode('okay'), false); }
    finally { delete api.CODE_PATTERN.exec; }
  }
});
