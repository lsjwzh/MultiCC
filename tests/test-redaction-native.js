'use strict';

// Text redaction and the provider rejection contract moved to Rust
// (native/core/src/redaction.rs, native/addon/src/api_error_text.rs). Each
// public JS entry point is compared with the frozen Node implementation
// (tests/helpers/legacy-api-error-text.js) on generated adversarial input:
// lone surrogates, JS-only whitespace, non-ASCII case folding, word
// boundaries next to non-ASCII letters, and argument coercion with getters,
// Proxies and throwing conversions.

const assert = require('node:assert/strict');
const test = require('node:test');
const legacy = require('./helpers/legacy-api-error-text');
const observability = require('../src/observability');
const { sanitizeMessage, normalizeRejection } = require('../src/chat/api-error-policy');

function generator(seed) {
  let n = seed >>> 0;
  const next = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n; };
  const pick = list => list[(next() >>> 16) % list.length];
  return { pick, int: max => (next() >>> 16) % max };
}

// Fragments that sit on or next to a rule boundary.
const FRAGMENTS = [
  'token', 'TOKEN', 'Token', 'secret', 'password', 'authorization', 'Authorization', 'cookie',
  'api_key', 'api-key', 'apikey', 'API_KEY', 'access_token', 'Bearer', 'bearer', 'BEARER',
  'sk', 'sess', 'key', 'auth', 'pr1.', 'proxy-route', 'proxy_route', 'proxy-route-',
  '=', ':', ': ', ' = ', '"', "'", '?', '&', '#', ',', ';', '}', '{', '.', '-', '_', '+', '/', '\\', '~', '@',
  ' ', '  ', '\t', '\n', '\r\n', '\u00a0', '\u2028', '\u3000', '\ufeff', '\u0085', '\u180e', '\v', '\f',
  'abc', 'XYZ', '0123456789', 'deadbeef', 'DEADBEEF', 'abcdef0123456789abcdef01', 'a'.repeat(31), 'b'.repeat(40),
  '/Users/me/x', '/home/u/.cfg', '/var/log', '/tmp/a b', '/usr/bin', 'C:\\Temp\\f', 'c:\\x', 'Z:\\',
  'me@example.com', 'a.b+c@d-e.io', '@x.yz', 'user@host', 'x@y.c',
  'é', 'É', 'ſ', '\u212a', 'ı', 'İ', 'ß', '中文', '😀', '\ud800', '\udfff', '\ud83d', '\ude00',
  '[REDACTED]', '[ID]', '%20', '==', '=*', 'AAAA', 'BBBB', 'Zz9_-',
  // Keywords that only match under Unicode case folding, which JS without
  // the u flag does not do (U+017F long s, U+212A Kelvin sign).
  'to\u212aen=abc', '\u017fecret: v', 'pa\u017f\u017fword=x', 'coo\u212aie=1', 'api_\u212aey=2',
  '\u212aey-abcdefgh', '\u017fk-abcdefgh12', '\u017fe\u017f\u017fion1234567', 'Bearer\u212a', '?to\u212aen=q',
];

function randomText(g, length = 1 + g.int(18)) {
  let out = '';
  for (let i = 0; i < length; i++) out += g.pick(FRAGMENTS);
  return out;
}

function outcome(fn) {
  try {
    const value = fn();
    return { value, frozen: value !== null && typeof value === 'object' ? Object.isFrozen(value) : null,
      keys: value !== null && typeof value === 'object' ? Reflect.ownKeys(value).map(String) : null };
  } catch (error) {
    return { threw: error && error.constructor && error.constructor.name };
  }
}

test('redact and redactProviderRouteCapability match the Node rules on strings', () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const text = randomText(generator(seed));
    assert.equal(observability.redact(text), legacy.redact(text), JSON.stringify(text));
    assert.equal(observability.redactProviderRouteCapability(text),
      legacy.redactProviderRouteCapability(text), JSON.stringify(text));
    assert.equal(observability.redact(text, text), legacy.redact(text, text), `key ${JSON.stringify(text)}`);
  }
  // Long capability segments: the {1,344} bound counts UTF-16 units.
  for (const length of [343, 344, 345, 700]) {
    const text = `x pr1.${'A'.repeat(length)}.${'B'.repeat(length)} proxy-route-${'C'.repeat(length)}😀`;
    assert.equal(observability.redact(text), legacy.redact(text));
  }
});

test('redact keeps the object walk: secret keys, nested values and collision-safe keys', () => {
  for (let seed = 1; seed <= 600; seed++) {
    const g = generator(seed);
    const build = depth => {
      const value = {};
      for (let i = 0; i < 1 + g.int(4); i++) {
        const key = g.pick(['token', 'apiKey', 'name', 'Cookie', 'msg', `pr1.${'k'.repeat(3)}.x`, 'proxy-route_a',
          '[REDACTED_PROVIDER_ROUTE]', 'pass', '', randomText(g, 2)]);
        value[key] = depth > 0 && g.int(3) === 0 ? build(depth - 1)
          : g.pick([randomText(g), 5, null, true, [randomText(g), 7], undefined]);
      }
      return value;
    };
    const input = build(2);
    assert.deepEqual(observability.redact(input), legacy.redact(input), JSON.stringify(input));
    assert.deepEqual(observability.redactProviderRouteCapability(input),
      legacy.redactProviderRouteCapability(input), JSON.stringify(input));
  }
});

test('sanitizeMessage matches Node, including coercion, fallback and length', () => {
  const values = () => [undefined, null, '', 0, -0, false, NaN, 12345, 1e21, true,
    { toString: () => 'obj token=abc' }, ['a', 'sk-12345678901'], Symbol('sym'), 10n,
    Object.create(null), { toString() { throw new RangeError('boom'); } }];
  const fallbacks = [undefined, '', 'fallback text', 'x'.repeat(300), null, 5, { slice: () => 'custom' },
    ['l', 'i', 's', 't']];
  const lengths = [undefined, 0, 1, 7, 240, -5, 3.7, '10', NaN, Infinity, -Infinity, null, true, 2n,
    { valueOf: () => 4 }];
  for (let seed = 1; seed <= 3000; seed++) {
    const text = randomText(generator(seed), 1 + (seed % 30));
    assert.deepEqual(outcome(() => sanitizeMessage(text)), outcome(() => legacy.sanitizeMessage(text)),
      JSON.stringify(text));
  }
  for (const value of values()) {
    for (const fallback of fallbacks) {
      for (const length of lengths) {
        const label = `${typeof value} ${String(fallback)} ${typeof length === 'bigint' ? `${length}n` : String(length)}`;
        assert.deepEqual(outcome(() => sanitizeMessage(value, fallback, length)),
          outcome(() => legacy.sanitizeMessage(value, fallback, length)), label);
      }
    }
  }
  // An emptied message with a nullish fallback is a TypeError on both sides.
  assert.deepEqual(outcome(() => sanitizeMessage('', null)), { threw: 'TypeError' });
});

test('normalizeRejection matches Node, with the same reads in the same order', () => {
  const field = g => g.pick([undefined, null, '', 0, 1, true, Symbol('s'), 7n, ' Window ', 'TRANSIENT',
    'window', 'entitlement', 'billing', 'transient ', '\ufeffbilling\u3000', 'request', 'MODEL', ' account',
    '5h', '1D', '1wk', '1w\u212a', '1m', 'headers', 'code', 'text', 'status', 'x'.repeat(100),
    '  ' + 'y'.repeat(90) + '  ', '\ud800', randomText(g, 2), { toString: () => 'window' }, ['billing']]);
  const reset = g => g.pick([undefined, null, '', 0, -1, 1, 0.4, 0.49999999999999994, 0.5, 2.5, 1.5e3, '12',
    '0x10', ' 7 ', 1e15, 9007199254740991, 9007199254740992, Infinity, NaN, 5n, true, [3], { valueOf: () => 9 }]);
  const run = (normalize, raw, mode) => {
    const reads = [];
    let target = raw;
    if (mode === 'proxy' && raw && typeof raw === 'object') {
      target = new Proxy(raw, { get(object, key, receiver) {
        reads.push(String(key));
        return Reflect.get(object, key, receiver);
      } });
    }
    return { result: outcome(() => normalize(target)), reads };
  };
  for (let seed = 1; seed <= 5000; seed++) {
    const g = generator(seed);
    const raw = g.pick([null, undefined, 0, 'window', [], () => {}, {}, {}, {}, {}, {}]);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const key of ['kind', 'scope', 'window', 'source', 'resetMs', 'code', 'model']) {
        if (g.int(5) !== 0) raw[key] = key === 'resetMs' ? reset(g) : field(g);
      }
      if (g.int(3)) raw.kind = g.pick(['window', 'transient', 'Billing', 'entitlement']);
    }
    const mode = g.pick(['plain', 'proxy']);
    assert.deepEqual(run(normalizeRejection, raw, mode), run(legacy.normalizeRejection, raw, mode),
      `${seed} ${JSON.stringify(raw, (_, v) => (typeof v === 'bigint' || typeof v === 'symbol' ? String(v) : v))}`);
  }
  // A getter that throws, and one that changes between the two `window` reads.
  let reads = 0;
  const flaky = { kind: 'window', get window() { reads += 1; return reads === 1 ? 'x' : '5H'; } };
  reads = 0;
  const left = normalizeRejection(flaky);
  reads = 0;
  assert.deepEqual(left, legacy.normalizeRejection(flaky));
  assert.equal(left.window, '5h');
  const throwing = { kind: 'billing', get scope() { throw new SyntaxError('host'); } };
  assert.deepEqual(outcome(() => normalizeRejection(throwing)), { threw: 'SyntaxError' });
  assert.deepEqual(outcome(() => legacy.normalizeRejection(throwing)), { threw: 'SyntaxError' });
});

test('the stream redactor marker equals the Rust redaction marker', () => {
  assert.equal(observability.redactProviderRouteCapability('pr1.a.b'), legacy.PROVIDER_ROUTE_REDACTION);
});
