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

test('the route redaction marker is unchanged', () => {
  assert.equal(observability.redactProviderRouteCapability('pr1.a.b'), legacy.PROVIDER_ROUTE_REDACTION);
});

// Secrets that overlap, nest, repeat or share prefixes, plus capability-shaped
// ones and ones with surrogate units, so the earliest/longest choice and the
// withheld-suffix rule are both exercised.
function secretSet(g) {
  const pool = ['SECRET', 'SEC', 'CRET', 'ECRE', 'aa', 'aaa', 'abab', 'ab', 'pr1.AAA.BBB', 'proxy-route-x1',
    'pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0', 'cHJveHktcm91dGUtc2VjcmV0', '😀x', '\ud800z', 'é　', '', 'x'];
  const count = g.int(4);
  const secrets = [];
  for (let i = 0; i < count; i++) secrets.push(g.pick(pool));
  return g.int(6) === 0 ? g.pick(['SECRET', '', undefined, null, 0, ['SECRET', null, 7]]) : secrets;
}

function streamText(g, secrets) {
  const words = ['SE', 'CRET', 'SECRET', 'a', 'b', 'ab', 'pr1.', 'AAA', '.BBB', 'proxy-route-', 'x1', ' ', '\n',
    '😀', '\ud83d', '\ude00', '\ud800', 'z', 'é', '　', 'cHJveHkt', 'cm91dGUtc2VjcmV0',
    // A withheld secret prefix can itself look like a route capability.
    '.B', 'x'];
  let out = '';
  for (let i = 0; i < 1 + g.int(14); i++) {
    out += g.int(4) === 0 && Array.isArray(secrets) && secrets.length ? String(g.pick(secrets) || '') : g.pick(words);
  }
  return out;
}

test('redactExactSecretFragments matches Node on split, nested and repeated secrets', () => {
  for (let seed = 1; seed <= 6000; seed++) {
    const g = generator(seed);
    const secrets = secretSet(g);
    const text = streamText(g, secrets);
    // Cut the text into parts at random UTF-16 positions (surrogate pairs too).
    const parts = [];
    let rest = text;
    while (rest && parts.length < 8) {
      const cut = g.int(rest.length + 1);
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    const values = g.int(10) === 0 ? g.pick(['plain SECRET', null, undefined, 5]) : parts;
    assert.deepEqual(observability.redactExactSecretFragments(values, secrets),
      legacy.redactExactSecretFragments(values, secrets), `${seed} ${JSON.stringify({ values, secrets })}`);
  }
  assert.deepEqual(observability.redactExactSecretFragments(['a', 'b']), ['a', 'b']);
});

test('the exact-secret stream redactor matches Node chunk by chunk', () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const g = generator(seed);
    const secrets = secretSet(g);
    const ours = observability.createExactSecretStreamRedactor(secrets);
    const theirs = legacy.createExactSecretStreamRedactor(secrets);
    assert.ok(Object.isFrozen(ours));
    const trace = [];
    for (let step = 0; step < 1 + g.int(10); step++) {
      const op = g.int(12);
      if (op === 0) {
        trace.push(['flush', ours.flush(), theirs.flush()]);
      } else if (op === 1) {
        ours.discard(); theirs.discard();
        trace.push(['discard']);
      } else if (op === 2) {
        const next = secretSet(g);
        ours.setSecrets(next); theirs.setSecrets(next);
        trace.push(['setSecrets', JSON.stringify(next)]);
      } else {
        const chunk = g.int(15) === 0 ? g.pick([undefined, null, 0, 42]) : streamText(g, secrets);
        trace.push(['push', ours.push(chunk), theirs.push(chunk)]);
      }
      trace.push(['pending', ours.pendingLength(), theirs.pendingLength()]);
    }
    for (const entry of trace) {
      if (entry.length === 3) assert.equal(entry[1], entry[2], `${seed} ${JSON.stringify(trace)}`);
    }
  }
  // A withheld secret prefix that is itself a route capability or token is
  // still redacted when an explicit boundary releases it.
  for (const [secret, text] of [['pr1.AAA.BBB', 'see pr1.AAA.B'], ['proxy-route-x1', 'at proxy-route-x']]) {
    const ours = observability.createExactSecretStreamRedactor([secret]);
    const theirs = legacy.createExactSecretStreamRedactor([secret]);
    assert.equal(ours.push(text), theirs.push(text));
    assert.equal(ours.pendingLength(), theirs.pendingLength());
    const released = ours.flush();
    assert.equal(released, theirs.flush());
    assert.equal(released, legacy.PROVIDER_ROUTE_REDACTION);
  }
});
