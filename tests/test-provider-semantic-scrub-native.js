'use strict';

// Semantic-structure scrubbing and the route-capability object walk moved to
// Rust (native/addon/src/provider_scrub.rs). Every native call is compared
// with the frozen Node implementation (tests/helpers/
// legacy-provider-semantic-scrub.js) on generated events of every provider
// event type plus seeded adversarial shapes: secrets split over values and
// keys, colliding keys, shared and cyclic sub-objects, `__proto__` keys,
// numeric-like keys, arrays with holes, NaN, Dates, Buffers and lone
// surrogates. Besides deep equality the test pins own-key order, property
// descriptor flags and identity preservation (the event itself and unchanged
// sub-trees).

const assert = require('node:assert/strict');
const test = require('node:test');
const util = require('node:util');
const { getNative } = require('../src/native/runtime');
const observability = require('../src/observability');
const legacyText = require('./helpers/legacy-api-error-text');
const { scrubProviderSemanticStructure: legacyScrub } = require('./helpers/legacy-provider-semantic-scrub');

const nativeScrub = () => getNative().providerScrubSemanticStructure;
const nativeRoute = () => getNative().redactionRouteCapabilityValue;

function show(value) {
  return util.inspect(value, { depth: 6, breakLength: 120, maxArrayLength: 20 });
}

// `object[key] = value` with a plain data property, so `__proto__` stays an
// own key instead of mutating the prototype.
function put(object, key, value) {
  Object.defineProperty(object, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function generator(seed) {
  let n = seed >>> 0;
  const next = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n; };
  return {
    next,
    pick: list => list[(next() >>> 16) % list.length],
    int: max => (next() >>> 16) % max,
    chance: perMille => (next() >>> 16) % 1000 < perMille,
  };
}

const SECRET_POOL = [
  'pr1.AAAA.BBBB', 'pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0', 'proxy-route-x1',
  'SECRET', 'abab', '😀x', '\ud800z', 'é中', 'a', 'Zz9_-',
];

function secretList(g) {
  if (g.chance(30)) return g.pick([[], undefined, ['SECRET', '', null, 7]]);
  const count = g.int(4);
  const secrets = [];
  for (let i = 0; i < count; i += 1) {
    secrets.push(g.chance(200) ? `${g.pick(SECRET_POOL)}${g.pick(SECRET_POOL)}` : g.pick(SECRET_POOL));
  }
  return secrets;
}

function textValue(g, secrets) {
  const choice = g.int(8);
  if (choice <= 1 && Array.isArray(secrets) && secrets.length) {
    const secret = String(g.pick(secrets) ?? '');
    const cut = g.int(secret.length + 1);
    return choice === 0 ? secret.slice(0, cut) : secret.slice(cut);
  }
  return g.pick([
    'hello', 'ordinary text', 'pr1.AAAA.BBBB', 'proxy-route-x1', 'prefix proxy-route-',
    'é中😀', '\ud800z', '\udfff\ud83d', '', 'x'.repeat(5), '[REDACTED_PROVIDER_ROUTE]',
  ]);
}

const NUMBER_POOL = [0, -0, 1, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 32, 1e21];
const KEY_POOL = [
  'plain', 'text', 'thinking', 'input', 'content', 'type', 'id', 'name', 'role',
  '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'length',
  '1', '2', '01', '-1', '4294967295', '',
];

function keyValue(g, secrets) {
  const choice = g.int(4);
  if (choice === 0 && Array.isArray(secrets) && secrets.length) {
    const secret = String(g.pick(secrets) ?? '');
    const cut = g.int(secret.length + 1);
    return g.chance(500) ? secret.slice(0, cut) : secret.slice(cut);
  }
  return g.pick(KEY_POOL);
}

// `allowCycle` is only passed where the legacy walker guards recursion with a
// WeakSet; `collectToolResultContent` has no guard, so tool-result content is
// always a finite tree.
function buildValue(g, depth, options) {
  const { secrets, allowCycle, shared } = options;
  if (shared && shared.length && g.chance(120)) return g.pick(shared);
  const choice = g.int(depth > 0 ? 12 : 7);
  let value;
  if (choice <= 2) value = textValue(g, secrets);
  else if (choice === 3) value = g.pick(NUMBER_POOL);
  else if (choice === 4) value = g.pick([null, true, false, undefined]);
  else if (choice === 5) value = g.pick([new Date(0), new Date(NaN)]);
  else if (choice === 6) value = Buffer.from(g.pick(['abc', 'pr1.AAAA.BBBB', '']));
  else if (choice <= 8) {
    value = [];
    const count = g.int(4);
    for (let i = 0; i < count; i += 1) value.push(buildValue(g, depth - 1, options));
    if (g.chance(60)) value.length = Math.max(0, value.length - 1); // a hole
  } else {
    value = {};
    const count = 1 + g.int(4);
    for (let i = 0; i < count; i += 1) put(value, keyValue(g, secrets), buildValue(g, depth - 1, options));
    // Adjacent keys whose concatenation is a secret: the keys-only pass joins
    // them flatly, while a string value in between hides the adjacency from
    // the all-descriptors pass.
    if (g.chance(600) && Array.isArray(secrets) && secrets.length) {
      const secret = String(g.pick(secrets) ?? '');
      if (secret.length >= 2) {
        const cut = 1 + g.int(secret.length - 1);
        if (g.chance(500)) {
          put(value, secret.slice(0, cut), 'interposed');
          put(value, secret.slice(cut), g.int(NUMBER_POOL.length));
        } else {
          put(value, secret.slice(0, cut), g.pick(NUMBER_POOL));
          put(value, secret.slice(cut), 'interposed');
        }
      }
    }
    if (allowCycle && g.chance(150) && shared) {
      const ancestor = g.pick(shared);
      if (ancestor && typeof ancestor === 'object') put(value, 'self', ancestor);
    }
  }
  if (shared && value && typeof value === 'object') shared.push(value);
  return value;
}

function buildToolResultContent(g, secrets, shared) {
  const choice = g.int(5);
  if (choice === 0) return textValue(g, secrets);
  if (choice === 1) {
    return { text: textValue(g, secrets), extra: buildValue(g, 1, { secrets, shared }) };
  }
  const blocks = [];
  const options = { secrets, shared, allowCycle: false };
  for (let i = 0, count = g.int(4); i < count; i += 1) {
    const kind = g.int(4);
    if (kind === 0) blocks.push(textValue(g, secrets));
    else if (kind === 1) blocks.push({ type: 'text', text: textValue(g, secrets) });
    else if (kind === 2) {
      put(blocks, i, { type: 'text', text: textValue(g, secrets), input: buildValue(g, 1, options) });
    } else {
      put(blocks, i, { content: [textValue(g, secrets), { type: 'text', text: textValue(g, secrets) }] });
    }
  }
  return blocks;
}

function buildBlock(g, secrets, shared) {
  const choice = g.int(7);
  if (choice === 0) return textValue(g, secrets);
  if (choice === 1) return { type: 'text', text: textValue(g, secrets) };
  if (choice === 2) return { type: 'thinking', thinking: textValue(g, secrets) };
  if (choice === 3) {
    return {
      type: 'tool_use', id: g.pick(['toolu_1', 'pr1.AAAA.BBBB']), name: 'Bash',
      input: buildValue(g, 2, { secrets, shared, allowCycle: true }),
    };
  }
  if (choice === 4) {
    return { type: 'tool_result', tool_use_id: 'toolu_1', content: buildToolResultContent(g, secrets, shared) };
  }
  const block = { type: g.pick(['image', 'unknown', undefined]) };
  if (g.chance(600)) put(block, 'text', textValue(g, secrets));
  if (g.chance(400)) put(block, 'thinking', textValue(g, secrets));
  if (g.chance(400)) put(block, 'input', buildValue(g, 1, { secrets, shared, allowCycle: true }));
  if (g.chance(300)) put(block, 'content', buildToolResultContent(g, secrets, shared));
  return block;
}

const EVENT_TYPES = [
  'assistant', 'user', 'tool_start', 'tool_update', 'tool_result', 'unknown', 'nonobject',
];

function buildEvent(g, kind) {
  const secrets = secretList(g);
  const shared = [];
  const event = {};
  if (kind === 'nonobject') {
    return { secrets, event: g.pick(['pr1.AAAA.BBBB', '', 5, null, undefined, true, Symbol('s'), 7n]) };
  }
  if (kind === 'assistant' || kind === 'user') {
    put(event, 'type', kind);
    const message = { role: kind === 'user' ? 'user' : 'assistant' };
    if (g.chance(400)) put(message, 'id', textValue(g, secrets));
    if (g.chance(150)) put(message, 'content', textValue(g, secrets));
    else {
      const content = [];
      for (let i = 0, count = g.int(5); i < count; i += 1) content.push(buildBlock(g, secrets, shared));
      put(message, 'content', content);
    }
    put(event, 'message', message);
    if (g.chance(250)) put(event, 'usage', { input_tokens: g.int(100), model: textValue(g, secrets) });
    if (g.chance(100)) put(event, 'self', event);
  } else if (kind === 'tool_start' || kind === 'tool_update') {
    put(event, 'type', kind);
    put(event, 'id', g.pick(['toolu_1', 'pr1.AAAA.BBBB']));
    put(event, 'input', buildValue(g, 3, { secrets, shared, allowCycle: true }));
  } else if (kind === 'tool_result') {
    put(event, 'type', 'tool_result');
    put(event, 'content', buildToolResultContent(g, secrets, shared));
  } else {
    put(event, 'type', g.pick(['stream_event', 'result', 'error', 'part_delta', undefined]));
    put(event, 'payload', buildValue(g, 3, { secrets, shared, allowCycle: true }));
    if (g.chance(150)) put(event, 'cycle', event);
  }
  return { secrets, event };
}

// Identity, key order and descriptor flags, keyed by the input node so the
// two runs can be compared node by node. A node can be reached several times
// (a shared sub-tree, or the nullish mapping left behind by a renamed key), so
// every visit is recorded and compared in input-key order.
function identityShape(node, outputs) {
  const ids = new Map();
  return outputs.map((mapped) => {
    if (mapped === node) return 'self';
    if (mapped === undefined) return 'undefined';
    if (mapped === null || typeof mapped !== 'object') return `primitive:${String(mapped)}`;
    if (!ids.has(mapped)) ids.set(mapped, ids.size);
    return `object:${ids.get(mapped)}`;
  });
}

function snapshot(input, output) {
  const records = new Map();
  const walk = (node, mapped) => {
    if (!node || typeof node !== 'object') return;
    let record = records.get(node);
    if (!record) {
      record = { outputs: [], mappings: [], keys: null, flags: null };
      records.set(node, record);
    }
    record.outputs.push(mapped);
    const isObject = mapped !== null && typeof mapped === 'object';
    if (!isObject) return;
    if (record.keys === null) {
      record.keys = Object.keys(mapped);
      record.flags = record.keys.map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(mapped, name);
        return [name, descriptor.enumerable, descriptor.configurable, descriptor.writable];
      });
    }
    // Cycles and shared nodes terminate: only the first visit through each
    // distinct output object is expanded.
    if (record.mappings.includes(mapped)) return;
    record.mappings.push(mapped);
    for (const name of Object.keys(node)) walk(node[name], mapped[name]);
  };
  walk(input, output);
  return records;
}

function assertSameShape(input, actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
  assert.equal(actual === input, expected === input, `${label}: top-level identity`);
  const ours = snapshot(input, actual);
  const theirs = snapshot(input, expected);
  assert.deepStrictEqual([...ours.keys()], [...theirs.keys()], `${label}: visited nodes`);
  for (const [node, record] of ours) {
    const other = theirs.get(node);
    assert.deepStrictEqual(record.keys, other.keys, `${label}: own-key order`);
    assert.deepStrictEqual(record.flags, other.flags, `${label}: descriptor flags`);
    assert.deepStrictEqual(identityShape(node, record.outputs), identityShape(node, other.outputs),
      `${label}: subtree identity`);
  }
}

function verifyScrub(event, secrets, label) {
  const actual = nativeScrub()(event, secrets);
  const expected = legacyScrub(event, secrets);
  assertSameShape(event, actual, expected, label);
}

function verifyRoute(value, label) {
  const actual = nativeRoute()(value);
  const expected = legacyText.redactProviderRouteCapability(value);
  assertSameShape(value, actual, expected, `${label} (native)`);
  const wrapper = observability.redactProviderRouteCapability(value);
  assertSameShape(value, wrapper, expected, `${label} (wrapper)`);
}

test('the route anchor precheck proves route-only events unchanged', () => {
  // Route redaction rewrites each string independently, so "no route anchor
  // anywhere" must mean the native walk returns the caller's own event. The
  // precheck is only used for event types with no model-controlled parts.
  let rejected = 0;
  for (let seed = 1; seed <= 3000 && rejected < 100; seed += 1) {
    const g = generator(seed * 104729);
    for (const kind of ['unknown', 'nonobject']) {
      const { secrets, event } = buildEvent(g, kind);
      if (observability.maybeRouteCapability(event)) continue;
      rejected += 1;
      assert.equal(nativeScrub()(event, secrets), event, `seed ${seed}: ${show(event)}`);
    }
  }
  assert.equal(rejected, 100, 'the precheck must reject a representative sample');
});

test('scrubProviderSemanticStructure matches the frozen Node walk on every event type', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const g = generator(seed);
    for (const kind of EVENT_TYPES) {
      const { secrets, event } = buildEvent(g, kind);
      verifyScrub(event, secrets, `seed ${seed} ${kind}: ${show(event)}`);
    }
  }
});

test('route capability redaction matches the frozen Node object walk', () => {
  for (let seed = 1; seed <= 1500; seed += 1) {
    const g = generator(seed * 7919);
    const secrets = secretList(g);
    const value = buildValue(g, 3, { secrets, allowCycle: true, shared: [] });
    verifyRoute(value, `seed ${seed}: ${show(value)}`);
  }
});

test('secrets split across values and keys stay non-reconstructable', () => {
  const capability = 'pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0';
  const token = 'cHJveHktcm91dGUtc2VjcmV0';
  const split = Math.floor(capability.length / 2);
  const tokenSplit = Math.floor(token.length / 2);
  const event = {
    type: 'assistant',
    message: { content: [
      { type: 'tool_use', id: 'a', input: { [capability]: 'ordinary', [token]: 'decoded' } },
      { type: 'tool_use', id: 'b', input: { [capability.slice(0, split)]: capability.slice(split) } },
      { type: 'tool_use', id: 'c', input: { first: capability.slice(0, split), second: capability.slice(split) } },
      { type: 'tool_use', id: 'd', input: { [token.slice(0, tokenSplit)]: token.slice(tokenSplit) } },
      { type: 'text', text: `before ${capability.slice(0, split)}` },
      { type: 'text', text: `${capability.slice(split)} after` },
    ] },
  };
  const safe = nativeScrub()(event, [capability, token]);
  verifyScrub(event, [capability, token], 'split capability fixture');
  assert.notEqual(safe, event);
  const keys = Object.keys(safe.message.content[0].input);
  assert.deepStrictEqual(keys.sort(), ['[REDACTED_PROVIDER_ROUTE]', '[REDACTED_PROVIDER_ROUTE]#2'].sort());
  for (const block of safe.message.content) {
    const text = JSON.stringify(block);
    assert.equal(text.includes(capability), false);
    assert.equal(text.includes(token), false);
  }
  assert.equal(Object.keys(event.message.content[0].input)[0], capability, 'input is not mutated');
});

test('the keys-only pass joins keys that an interposed value separates', () => {
  const capability = 'pr1.AAAA.BBBB';
  const keysSplit = { type: 'tool_start', input: {
    'pr1.AAAA.': 'interposed value', BBBB: 1,
  } };
  const arraySplit = { type: 'tool_start', input: [
    { 'pr1.AAAA.': 'interposed value' }, { BBBB: 1 },
  ] };
  const tokenSplit = { type: 'tool_update', input: {
    'proxy-route-': 'interposed value', x1: 2,
  } };
  for (const [event, secrets] of [
    [keysSplit, [capability]],
    [arraySplit, [capability]],
    [tokenSplit, ['proxy-route-x1']],
  ]) {
    verifyScrub(event, secrets, `keys-only pass: ${show(event)}`);
    const safe = nativeScrub()(event, secrets);
    assert.equal(JSON.stringify(safe).includes('pr1.AAAA.'), false);
    assert.equal(JSON.stringify(safe).includes('proxy-route-'), false);
  }
});

test('colliding keys and key order follow the same delete-and-define sequence', () => {
  const event = { type: 'tool_start', input: {
    first: 'x',
    'pr1.AAAA.BBBB': 1,
    middle: 'y',
    'pr1.CCCC.DDDD': 2,
    last: 'z',
  } };
  const secrets = ['pr1.AAAA.BBBB', 'pr1.CCCC.DDDD'];
  const safe = nativeScrub()(event, secrets);
  verifyScrub(event, secrets, 'colliding keys');
  assert.deepStrictEqual(Object.keys(safe.input), [
    'first', 'middle', 'last', '[REDACTED_PROVIDER_ROUTE]', '[REDACTED_PROVIDER_ROUTE]#2',
  ]);
  assert.deepStrictEqual(Object.values(safe.input), ['x', 'y', 'z', 1, 2]);
});

test('own __proto__, constructor and numeric-like keys never touch a prototype', () => {
  const input = {};
  put(input, '__proto__', { polluted: true });
  put(input, 'constructor', 'pr1.AAAA.BBBB');
  put(input, '2', 'two');
  put(input, '1', 'one');
  put(input, '01', 'zero-one');
  const event = { type: 'tool_update', input };
  const safe = nativeScrub()(event, ['pr1.AAAA.BBBB']);
  verifyScrub(event, ['pr1.AAAA.BBBB'], '__proto__ fixture');
  assert.equal(Object.getPrototypeOf(safe.input), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(safe.input, '__proto__'), true);
  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(safe.input, '__proto__'),
    { value: { polluted: true }, writable: true, enumerable: true, configurable: true });
  assert.deepStrictEqual(Object.keys(safe.input), ['1', '2', '__proto__', 'constructor', '01']);
});

test('shared and cyclic sub-objects keep the Node shape and identity', () => {
  const shared = { text: 'pr1.AAAA.BBBB' };
  const standalone = { text: 'unchanged' };
  const event = {
    type: 'tool_start',
    input: { left: shared, right: shared, stable: standalone, list: [shared, standalone] },
  };
  const safe = nativeScrub()(event, ['pr1.AAAA.BBBB']);
  verifyScrub(event, ['pr1.AAAA.BBBB'], 'shared fixture');
  assert.equal(safe.input.left, safe.input.right, 'shared node stays shared');
  assert.equal(safe.input.list[0], safe.input.left, 'sharing survives arrays');
  assert.notEqual(safe.input.stable, standalone);
  assert.equal(safe.input.stable.text, 'unchanged');

  const cyclic = { type: 'error', payload: { text: 'pr1.AAAA.BBBB' } };
  cyclic.self = cyclic;
  cyclic.payload.owner = cyclic;
  verifyScrub(cyclic, ['pr1.AAAA.BBBB'], 'cyclic fixture');
  assert.equal(nativeScrub()({ type: 'error', payload: { text: 'nothing' } }, ['SECRET']).payload.text, 'nothing');
});

test('unchanged values keep the caller identity, including subtrees', () => {
  const untouched = { deep: { text: 'plain words', list: [1, 2, 3] } };
  const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'nothing secret' }] }, extra: untouched };
  assert.equal(nativeScrub()(event, ['SECRET']), event);
  assert.equal(observability.redactProviderRouteCapability(event), event);
  const routeOnly = { nested: { text: 'pr1.AAAA.BBBB' } };
  const redacted = observability.redactProviderRouteCapability(routeOnly);
  assert.notEqual(redacted, routeOnly);
  const clean = { nested: { text: 'plain' } };
  assert.equal(observability.redactProviderRouteCapability(clean), clean);
  assert.equal(observability.redactProviderRouteCapability(clean).nested, clean.nested);
});

test('NaN makes a structure change without a secret, exactly like Node', () => {
  const event = { type: 'error', payload: { value: NaN } };
  const safe = nativeScrub()(event, []);
  verifyScrub(event, [], 'NaN fixture');
  assert.notEqual(safe, event);
  assert.equal(Number.isNaN(safe.payload.value), true);
});

test('dates and buffers follow the clone and route walks', () => {
  const date = new Date(0);
  const buffer = Buffer.from('abc');
  verifyScrub({ type: 'tool_start', input: { date, buffer } }, ['SECRET'], 'date/buffer scrub');
  verifyRoute({ date, buffer }, 'date/buffer route');
  // Nothing changes in either value, so the original nodes keep their identity.
  assert.equal(nativeScrub()({ type: 'tool_start', input: { date } }, ['SECRET']).input.date, date);
  // A sibling redaction forces the clone, which turns both into plain objects.
  const cloned = nativeScrub()(
    { type: 'tool_start', input: { date, buffer, secret: 'pr1.AAAA.BBBB' } },
    ['pr1.AAAA.BBBB'],
  ).input;
  assert.deepStrictEqual(cloned.date, {});
  assert.deepStrictEqual(Object.keys(cloned.buffer), ['0', '1', '2']);
});

// Wire fixtures are serialized only in tests. Production callers supply the
// original CLI line; live host objects continue using the direct value bridge.
function verifyWire(text, secrets, label) {
  const event = JSON.parse(text);
  const safe = legacyScrub(event, secrets);
  const encoded = getNative().providerScrubSemanticJson(text, secrets);
  const actual = JSON.parse(encoded);
  assert.deepStrictEqual(actual, safe, label);
  function keys(a, b) {
    if (!a || typeof a !== 'object') return;
    assert.deepStrictEqual(Object.keys(a), Object.keys(b), `${label}: key order`);
    for (const key of Object.keys(a)) keys(a[key], b[key]);
  }
  keys(actual, safe);
  if (safe === event) assert.equal(encoded, text, `${label}: no-op keeps original wire bytes`);
  return actual;
}

test('original wire JSON shares the frozen semantic rules across generated events', (t) => {
  let checked = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const g = generator(seed * 107);
    for (const kind of EVENT_TYPES) {
      const { secrets, event } = buildEvent(g, kind);
      let text;
      try { text = JSON.stringify(event); } catch (_) { continue; } // cycles/BigInt have no wire JSON
      if (text === undefined) continue;
      verifyWire(text, secrets, `wire seed ${seed} ${kind}`);
      checked += 1;
    }
  }
  assert.ok(checked > 2000, `checked ${checked} valid JSON events`);
  t.diagnostic(`compared ${checked} valid wire events with the frozen Node implementation`);
});

test('wire edits preserve JS number semantics, escaped surrogates and duplicate-key order', () => {
  verifyWire(String.raw`{ "type":"tool_start", "n":-0, "huge":1e400, "small":-1e400,
    "input":{"2":"tail","1":"SECRET","01":"\ud800z","__proto__":{"text":"SECRET"},
      "dup":"old","dup":"SECRET","constructor":"pr1.AAAA.BBBB", "float":9007199254740993} }`,
  ['SECRET', '\ud800z'], 'wire numbers and UTF-16');
  verifyWire(' { "negative": -0, "overflow": 1e400, "text": "\\ud800" } \n', [], 'byte-exact no-op');
});

test('wire split secrets cover every UTF-16 boundary, keys, collisions and content blocks', () => {
  for (const secret of ['proxy-route-x1', 'pr1.AAAA.BBBB', '😀\ud800z']) {
    for (let cut = 0; cut <= secret.length; cut += 1) {
      const left = secret.slice(0, cut), right = secret.slice(cut);
      const events = [
        { type: 'tool_start', input: [left, right] },
        { type: 'tool_update', input: { [left]: 'interposed', [right]: 1, [secret]: 2,
          '[REDACTED_PROVIDER_ROUTE]': 3, '[REDACTED_PROVIDER_ROUTE]#2': 4 } },
        { type: 'tool_start', input: { [left]: right } },
        { type: 'assistant', message: { content: [{ type: 'text', text: left },
          { type: 'thinking', thinking: right }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: [left, right] }] } },
      ];
      for (const event of events) verifyWire(JSON.stringify(event), [secret], `wire split ${secret.length}/${cut}`);
    }
  }
});

test('wire parsing rejects malformed or excessively nested data without a successful result', () => {
  for (const text of ['{"type":', '{} trailing', '{"x":NaN}', '{"x":"\\ud80x"}']) {
    assert.throws(() => getNative().providerScrubSemanticJson(text, []));
  }
  const deep = '['.repeat(1005) + '0' + ']'.repeat(1005);
  assert.throws(() => getNative().providerScrubSemanticJson(deep, []), /Maximum call stack/);
  assert.equal(getNative().providerScrubSemanticJson('{}', []), '{}', 'errors do not poison later calls');
});
