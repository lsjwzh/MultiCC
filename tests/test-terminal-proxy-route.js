'use strict';

// 终端（长活 tmux 会话）那条托管 provider 路由的能力，和它过 proxy guard 的凭据。
//
// 背景：终端不是回合。它的路由段以前写的是明文 session id（codex 的
// config.toml base_url、claude 的 ANTHROPIC_BASE_URL），而 guard 只认
// `pr1.<b64 id>.<b64 token>` 这种带能力令牌的段 —— 于是任何绑了托管 provider 的
// 终端，每个请求都被 409 `provider_route_capability_mismatch`，终端里只看到
// `unexpected status 409 Conflict`。这里的用例就是那件事的回归钉子。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { getNative } = require('../src/native/runtime');
// Frozen independently from the deleted production module before this batch.
const { createTerminalProxyRoutes: legacyTerminalRoutes } = require('./helpers/legacy-terminal-route');

function createTerminalProxyRoutes(options) {
  const native = getNative();
  const port = native.providerTerminalValidate(options);
  return Object.freeze({
    sessionSegment: session => native.providerTerminalSessionSegment(session, port),
    lookup: sessionId => native.providerTerminalLookup(sessionId, port),
  });
}

function fixture() {
  const records = new Map();
  const persisted = [];
  const routes = {};
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-terminal',
    resolveTerminalRoute: sessionId => routes.value.lookup(sessionId),
  });
  routes.value = createTerminalProxyRoutes({
    persistedSessions: records,
    persist: reason => persisted.push(reason),
    mint: () => 'route-token-1',
    encode: (id, token) => runtime.encodeProxyRoute(id, token),
  });
  return { records, persisted, runtime, routes: routes.value };
}

test('a terminal with a managed provider gets an encoded route capability, minted once', () => {
  const { records, persisted, routes } = fixture();
  const session = { id: 'multicc-codex-term-01', kind: 'terminal', provider: 'codex-official' };
  records.set(session.id, session);

  const first = routes.sessionSegment(session);
  assert.match(first, /^pr1\./, '路由段要带能力令牌：' + first);
  assert.notEqual(first, session.id, '明文 id 永远过不了 guard');
  assert.equal(session.proxyRouteToken, 'route-token-1');
  assert.deepEqual(persisted, ['runtime.terminal-route-token'], '令牌要和会话记录一起落盘（进程配置里已经写死了它）');
  assert.equal(routes.sessionSegment(session), first, '同一个会话每次拿到的段必须是同一个');
  assert.equal(persisted.length, 1, '已经有令牌就不再写盘');
});

test('a terminal without a managed provider keeps the bare id (it never touches the proxy)', () => {
  const { routes, persisted } = fixture();
  const session = { id: 'codex-login', kind: 'terminal', provider: null };
  assert.equal(routes.sessionSegment(session), 'codex-login');
  assert.equal(routes.lookup('codex-login'), null, '没有 provider 的终端没有路由能力可言');
  assert.deepEqual(persisted, []);
});

test('lookup answers only for terminal records carrying both a provider and a token', () => {
  const { records, routes } = fixture();
  records.set('chat-1', { id: 'chat-1', kind: 'chat', provider: 'codex-official', proxyRouteToken: 't' });
  records.set('term-no-provider', { id: 'term-no-provider', kind: 'terminal', provider: null, proxyRouteToken: 't' });
  records.set('term-no-token', { id: 'term-no-token', kind: 'terminal', provider: 'codex-official' });
  records.set('term-sub', {
    id: 'term-sub', kind: 'terminal', provider: 'codex-official', proxyRouteToken: 't2',
    subagent: { providerId: 'codex-lab', model: 'gpt-5.5' },
  });

  assert.equal(routes.lookup('chat-1'), null, 'chat 会话走 attempt 那条路，不靠这个端口');
  assert.equal(routes.lookup('term-no-provider'), null);
  assert.equal(routes.lookup('term-no-token'), null, '老终端要重新起一次才会拿到令牌');
  assert.equal(routes.lookup('nope'), null);
  assert.deepEqual(routes.lookup('term-sub').allowedSubProviderIds, ['codex-official', 'codex-lab']);
});

test('the terminal capability admits its own provider and declared sub route without a turn attempt', () => {
  const { records, runtime, routes } = fixture();
  const session = {
    id: 'multicc-codex-term-01', kind: 'terminal', provider: 'codex-official',
    subagent: { providerId: 'codex-lab' },
  };
  records.set(session.id, session);
  const segment = routes.sessionSegment(session);

  const main = runtime.authorizeProxyRequest({ sessionId: segment, role: 'main', providerId: 'codex-official' });
  assert.equal(main.ok, true, '终端自己的主线路必须放行');
  assert.equal(main.terminal, true);
  assert.equal(main.attempt, null, '终端没有回合，不许凭空造一个 attempt');
  assert.equal(runtime.authorizeProxyRequest({ sessionId: segment, role: 'sub', providerId: 'codex-lab' }).ok, true,
    '声明的子线路放行');

  assert.equal(runtime.authorizeProxyRequest({ sessionId: segment, role: 'main', providerId: 'codex-lab' }).code,
    'provider_route_mismatch', '别人的 provider 不能借这条路由');
  assert.equal(runtime.authorizeProxyRequest({ sessionId: segment, role: 'sub', providerId: 'codex-other' }).code,
    'provider_subroute_not_allowed', '没声明的子线路不能借');
  assert.equal(runtime.authorizeProxyRequest({ sessionId: session.id, role: 'main', providerId: 'codex-official' }).code,
    'proxy_route_capability_mismatch', '明文 id 仍旧不放行');
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: runtime.encodeProxyRoute(session.id, 'stale-token'), role: 'main', providerId: 'codex-official',
  }).code, 'proxy_route_capability_mismatch', '旧令牌不放行');
});

test('a deleted terminal loses its route immediately', () => {
  const { records, runtime, routes } = fixture();
  const session = { id: 'multicc-claude-term-01', kind: 'terminal', provider: 'claude-official' };
  records.set(session.id, session);
  const segment = routes.sessionSegment(session);
  assert.equal(runtime.authorizeProxyRequest({ sessionId: segment, role: 'main', providerId: 'claude-official' }).ok, true);

  records.delete(session.id);
  assert.equal(runtime.authorizeProxyRequest({ sessionId: segment, role: 'main', providerId: 'claude-official' }).ok, false,
    '会话没了，路由就该失效 —— 不需要任何生命周期钩子');
});

test('without the terminal lookup port a terminal route stays closed (fail-closed)', () => {
  const bare = createProviderAttemptRuntime({ runtimeEpoch: 'epoch-bare' });
  const { records, routes } = fixture();
  const session = { id: 'multicc-claude-term-01', kind: 'terminal', provider: 'claude-official' };
  records.set(session.id, session);

  const decision = bare.authorizeProxyRequest({
    sessionId: routes.sessionSegment(session), role: 'main', providerId: 'claude-official',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'proxy_route_capability_mismatch');
});

// Each side builds independent live records and callbacks. The oracle imports
// only the frozen original module, never the addon-backed production bridge.
function capture(action, sentinel) {
  try {
    const value = action();
    return { value, frozen: Object.isFrozen(value),
      keys: value && typeof value === 'object' ? Object.keys(value) : null,
      allowedFrozen: Array.isArray(value?.allowedSubProviderIds) ? Object.isFrozen(value.allowedSubProviderIds) : null };
  } catch (error) {
    return { error: { name: error.name, message: error.message, code: error.code, same: error === sentinel } };
  }
}
function compareTerminal(execute, context) {
  assert.deepEqual(execute(createTerminalProxyRoutes), execute(legacyTerminalRoutes), context);
}

test('the production server validates and uses the addon-backed terminal route bridge', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.doesNotMatch(server, /require\(['"]\.\/src\/providers\/terminal-route['"]\)/,
    'the deleted Node implementation must not remain in production');
  for (const command of ['providerTerminalValidate', 'providerTerminalSessionSegment', 'providerTerminalLookup']) {
    assert.match(server, new RegExp(`\\b${command}\\b`), `server must wire ${command}`);
  }
  assert.match(server, /terminalProxyRoutes\.sessionSegment\(persisted\)/,
    'terminal process configuration must consume the addon-owned route segment');
  assert.match(server, /resolveTerminalRoute:\s*\w+\s*=>\s*terminalProxyRoutes\.lookup\(\w+\)/,
    'proxy authorization must resolve the same terminal store');
});

test('terminal factory matches frozen initialization reads, failures and captured host ports', () => {
  const execute = (factory, throwAt, invalid) => {
    const trace = [];
    const sentinel = new Error(`stop at ${throwAt}`);
    const record = { id: 'terminal-1', kind: 'terminal', provider: 'p', proxyRouteToken: ' t ' };
    const store = {};
    Object.defineProperty(store, 'get', { configurable: true, get() {
      trace.push('store.get');
      if (throwAt === 'store.get') throw sentinel;
      return function(id) { trace.push(['lookup', this === store, id]); return id === record.id ? record : undefined; };
    } });
    const values = {
      persistedSessions: invalid === 'store' ? null : store,
      persist(reason) { trace.push(['persist', reason]); },
      encode: invalid === 'encode' ? null : function(id, token) { trace.push(['encode', id, token]); return `${id}|${token}`; },
      mint() { trace.push('mint'); return 'minted'; },
    };
    const options = new Proxy(values, { get(target, key, receiver) {
      trace.push(['options', key]);
      if (key === throwAt) throw sentinel;
      return Reflect.get(target, key, receiver);
    } });
    const result = capture(() => {
      const routes = factory(options);
      trace.push(['routesFrozen', Object.isFrozen(routes)]);
      // The constructor captures each option once. Later reassignment of the
      // original options must not swap the already-captured port.
      values.persistedSessions = new Map();
      values.encode = () => { throw new Error('new encoder must not run'); };
      values.mint = () => { throw new Error('new mint must not run'); };
      values.persist = () => { throw new Error('new persist must not run'); };
      trace.push(['segment', capture(() => routes.sessionSegment(record), sentinel)]);
      trace.push(['lookup-result', capture(() => routes.lookup(record.id), sentinel)]);
      return 'ready';
    }, sentinel);
    trace.push(['result', result]);
    return trace;
  };
  for (const throwAt of [undefined, 'persistedSessions', 'persist', 'encode', 'mint', 'store.get']) {
    compareTerminal(factory => execute(factory, throwAt), `constructor getter ${String(throwAt)}`);
  }
  for (const invalid of ['store', 'encode']) compareTerminal(factory => execute(factory, undefined, invalid), `invalid ${invalid}`);
  for (const options of [undefined, null, false, 0, '', Symbol('options'), {}, { persistedSessions: new Map() }]) {
    compareTerminal(factory => [capture(() => factory(options))], `constructor ${String(options)}`);
  }
});

test('terminal route default mint survives persisted-session reload and keeps the old token', () => {
  const native = getNative();
  let saves = 0;
  let disk;
  const firstStore = new Map();
  const initial = { id: 'terminal-one', kind: 'terminal', provider: 'p' };
  firstStore.set(initial.id, initial);
  const first = createTerminalProxyRoutes({ persistedSessions: firstStore,
    persist(reason) { assert.equal(reason, 'runtime.terminal-route-token'); saves++; disk = JSON.stringify([...firstStore]); },
    encode: native.providerEncodeProxySession });
  const segment = first.sessionSegment(initial);
  assert.match(initial.proxyRouteToken, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(saves, 1);
  const restored = new Map(JSON.parse(disk));
  const afterRestart = createTerminalProxyRoutes({ persistedSessions: restored,
    persist() { assert.fail('a stored capability must not be minted or persisted twice'); },
    encode: native.providerEncodeProxySession });
  assert.equal(afterRestart.sessionSegment(restored.get(initial.id)), segment);
  assert.equal(afterRestart.lookup(initial.id).token, initial.proxyRouteToken);
  const another = { id: 'terminal-two', kind: 'terminal', provider: 'p' };
  restored.set(another.id, another);
  // Separate runtime with persistence enabled for the new record.
  const other = createTerminalProxyRoutes({ persistedSessions: restored, persist() {}, encode: native.providerEncodeProxySession });
  other.sessionSegment(another);
  assert.match(another.proxyRouteToken, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(another.proxyRouteToken, initial.proxyRouteToken);
});

function segmentTrace(factory, spec = {}) {
  const trace = [];
  const sentinel = new Error(`sentinel ${spec.throwAt}`);
  let routes;
  let entered = false;
  let calls = 0;
  const minted = spec.minted === 'object' ? { opaque: 'minted-object' }
    : spec.minted === 'symbol' ? Symbol.for('minted-token')
    : spec.minted === 'null' ? null
    : spec.minted === 'zero' ? 0
    : spec.minted === 'undefined' ? undefined : null;
  const raw = typeof spec.session === 'function' ? spec.session() : {
    id: spec.id === undefined ? 'term-1' : spec.id,
    provider: spec.provider === undefined ? 'provider-a' : spec.provider,
    ...(Object.hasOwn(spec, 'token') ? { proxyRouteToken: spec.token } : {}),
  };
  if (spec.frozen && raw && typeof raw === 'object') Object.freeze(raw);
  const session = raw && typeof raw === 'object' ? new Proxy(raw, {
    get(target, key, receiver) {
      if (['id', 'provider', 'proxyRouteToken'].includes(key)) {
        trace.push(['get', key]);
        if (spec.throwAt === `get.${key}`) throw sentinel;
      }
      return Reflect.get(target, key, receiver);
    },
    set(target, key, value, receiver) {
      trace.push(['set', key, value === minted ? 'minted-reference' : value]);
      if (spec.throwAt === `set.${key}`) throw sentinel;
      if (spec.rejectSet) return false;
      return Reflect.set(target, key, value, receiver);
    },
  }) : raw;
  const maybeReenter = where => {
    if (spec.reenter === where && !entered) {
      entered = true;
      trace.push(['nested', where, capture(() => routes.sessionSegment(session), sentinel)]);
    }
  };
  routes = factory({ persistedSessions: new Map(),
    mint() {
      calls++;
      trace.push(['mint', calls]);
      if (spec.throwAt === 'mint') throw sentinel;
      const result = spec.minted ? minted : `token-${calls}`;
      maybeReenter('mint');
      return result;
    },
    persist(reason) {
      trace.push(['persist', reason]);
      if (spec.throwAt === 'persist') throw sentinel;
      maybeReenter('persist');
    },
    encode(id, token) {
      trace.push(['encode', id, token === minted && !!spec.minted ? 'minted-reference' : token]);
      if (spec.throwAt === 'encode') throw sentinel;
      maybeReenter('encode');
      return `encoded:${id}`;
    },
  });
  for (let i = 0; i < (spec.repeat ?? 1); i++) {
    trace.push(['segment', capture(() => routes.sessionSegment(session), sentinel)]);
  }
  if (raw && typeof raw === 'object') {
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'proxyRouteToken');
    trace.push(['stored', !!descriptor, descriptor?.value === minted && !!spec.minted ? 'minted-reference' : descriptor?.value]);
  }
  return trace;
}

test('native terminal segment matches frozen short-circuit, conversion and token semantics', () => {
  const cases = [
    ...[undefined, null, false, 0, -0, NaN, '', 0n, true, 'abc', Symbol.for('session')].map(value => ({ session: () => value })),
    ...[undefined, null, false, 0, NaN, '', ' ', '  term  ', '\ud800', Symbol.for('id')].map(id => ({ session: () => ({ id, provider: 'p' }) })),
    ...[undefined, null, false, 0, NaN, '', ' ', '  p  ', '\ud801', Symbol.for('provider')].map(provider => ({ session: () => ({ id: 'term', provider }) })),
    ...[undefined, null, false, 0, NaN, '', ' ', '  existing  ', '\ud800', Symbol.for('token')].map(token => ({ token, repeat: 2 })),
    ...['object', 'symbol', 'null', 'zero', 'undefined'].map(minted => ({ minted, repeat: 2 })),
    { id: '\ud800', provider: '\ud801', token: '\ud802' },
    { token: ' existing ', repeat: 2 }, { repeat: 2 },
  ];
  for (const [index, spec] of cases.entries()) {
    compareTerminal(factory => segmentTrace(factory, spec), `segment case ${index}`);
  }
});

test('native terminal segment preserves lazy getters, strict assignment and callback exceptions', () => {
  for (const throwAt of ['get.id', 'get.provider', 'get.proxyRouteToken', 'set.proxyRouteToken', 'mint', 'persist', 'encode']) {
    compareTerminal(factory => segmentTrace(factory, { throwAt, repeat: 2 }), throwAt);
  }
  compareTerminal(factory => segmentTrace(factory, { rejectSet: true }), 'proxy setter returning false');
  compareTerminal(factory => segmentTrace(factory, { frozen: true }), 'frozen session');
  for (const reenter of ['mint', 'persist', 'encode']) {
    compareTerminal(factory => segmentTrace(factory, { reenter, repeat: 2 }), `reentry ${reenter}`);
  }
  const calls = segmentTrace(legacyTerminalRoutes, { reenter: 'persist' });
  assert.equal(calls.filter(row => row[0] === 'mint').length, 1);
  assert.equal(calls.filter(row => row[0] === 'persist').length, 1);
  assert.equal(calls.filter(row => row[0] === 'encode').length, 2);
});

function lookupTrace(factory, spec = {}) {
  const trace = [];
  const sentinel = new Error(`sentinel ${spec.throwAt}`);
  let routes;
  let entered = false;
  let subReads = 0;
  const records = new Map();
  const sub = new Proxy({ providerId: spec.subId === undefined ? 'provider-sub' : spec.subId }, {
    get(target, key, receiver) {
      if (key === 'providerId') {
        trace.push(['get', 'sub.providerId']);
        if (spec.throwAt === 'sub.providerId') throw sentinel;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const base = {
    id: 'term', kind: spec.kind === undefined ? 'terminal' : spec.kind,
    provider: spec.provider === undefined ? 'provider-a' : spec.provider,
    proxyRouteToken: spec.token === undefined ? 'token' : spec.token,
    subagent: sub,
  };
  const maybeReenter = where => {
    if (spec.reenter === where && !entered) {
      entered = true;
      trace.push(['nested', where, capture(() => routes.lookup('inner'), sentinel)]);
    }
  };
  const record = new Proxy(base, {
    get(target, key, receiver) {
      if (['kind', 'provider', 'proxyRouteToken', 'subagent'].includes(key)) {
        trace.push(['get', key]);
        if (spec.throwAt === key) throw sentinel;
        if (key === 'subagent') {
          subReads++;
          maybeReenter('subagent');
          if (spec.deleteDuringSubagent && subReads === 1) records.delete('term');
          if (spec.secondSubNull && subReads === 2) return null;
        }
      }
      return Reflect.get(target, key, receiver);
    },
  });
  records.set('term', Object.hasOwn(spec, 'record') ? spec.record : record);
  records.set('inner', { kind: 'terminal', provider: 'inner-provider', proxyRouteToken: 'inner-token' });
  const store = { get(id) {
    trace.push(['store.get', this === store, id]);
    if (spec.throwAt === 'store.get') throw sentinel;
    maybeReenter('store.get');
    return records.get(id);
  } };
  routes = factory({ persistedSessions: store, encode: () => 'unused', mint: () => 'unused' });
  for (const id of spec.ids || ['term']) {
    trace.push(['lookup', capture(() => routes.lookup(id), sentinel)]);
  }
  if (spec.deleteDuringSubagent) {
    trace.push(['after-delete', capture(() => routes.lookup('term'), sentinel)]);
  }
  trace.push(['subReads', subReads]);
  return trace;
}

test('native terminal lookup matches frozen validation, subroute, conversion and frozen key order', () => {
  const cases = [
    {}, { kind: 'chat' }, { kind: '' }, { kind: null },
    ...[null, false, 0, '', ' ', ' provider-a ', '\ud800', Symbol.for('provider')].map(provider => ({ provider })),
    ...[null, false, 0, '', ' ', ' token ', '\ud801', Symbol.for('token')].map(token => ({ token })),
    ...[null, false, 0, '', ' ', 'provider-a', ' provider-sub ', '\ud802', Symbol.for('sub')].map(subId => ({ subId })),
    ...[undefined, null, false, 0, NaN, '', 0n, true, 'chat', Symbol.for('record')].map(record => ({ record })),
    { ids: [undefined, null, false, 0, NaN, '', 0n, Symbol.for('session'), '\ud800', ' term ', 'term'] },
    { secondSubNull: true }, { deleteDuringSubagent: true },
  ];
  for (const [index, spec] of cases.entries()) compareTerminal(factory => lookupTrace(factory, spec), `lookup case ${index}`);
  const result = lookupTrace(legacyTerminalRoutes).find(row => row[0] === 'lookup')[1];
  assert.deepEqual(result.keys, ['token', 'providerId', 'allowedSubProviderIds']);
  assert.equal(result.frozen, true);
  assert.equal(result.allowedFrozen, true);
  assert.deepEqual(lookupTrace(legacyTerminalRoutes).filter(row => row[0] === 'get').map(row => row[1]),
    ['kind', 'provider', 'proxyRouteToken', 'subagent', 'subagent', 'sub.providerId']);
});

test('native terminal lookup preserves throwing getters and synchronous reentry', () => {
  for (const throwAt of ['store.get', 'kind', 'provider', 'proxyRouteToken', 'subagent', 'sub.providerId']) {
    compareTerminal(factory => lookupTrace(factory, { throwAt }), `lookup throw ${throwAt}`);
  }
  for (const reenter of ['store.get', 'subagent']) {
    compareTerminal(factory => lookupTrace(factory, { reenter }), `lookup reentry ${reenter}`);
  }
});

test('terminal differential detects missing persistence, token reuse and subagent lookup mutations', () => {
  const filename = require.resolve('./helpers/legacy-terminal-route');
  const frozen = fs.readFileSync(filename, 'utf8');
  const mutations = [
    ["      if (typeof persist === 'function') persist('runtime.terminal-route-token');",
      '      // removed persistence', factory => segmentTrace(factory)],
    ['    let token = clean(session.proxyRouteToken);', "    let token = '';", factory => segmentTrace(factory, { repeat: 2 })],
    ['    const subId = clean(record.subagent && record.subagent.providerId);', "    const subId = '';", factory => lookupTrace(factory)],
  ];
  for (const [before, after, trace] of mutations) {
    assert.ok(frozen.includes(before), `frozen oracle anchor missing: ${before}`);
    const oracle = new Module(filename, module);
    oracle.filename = filename;
    oracle.paths = module.paths;
    oracle._compile(frozen.replace(before, after), filename);
    assert.notDeepEqual(trace(createTerminalProxyRoutes), trace(oracle.exports.createTerminalProxyRoutes), before);
  }
});

test('terminal token assignment never consults a patched Object.assign', () => {
  const execute = (factory, assignment, patch) => {
    const trace = [];
    const sentinel = new Error('Object.assign must not be consulted');
    const raw = { id: 'terminal-assign', provider: 'provider-a' };
    if (assignment === 'readonly') {
      Object.defineProperty(raw, 'proxyRouteToken', { value: '', writable: false, configurable: true });
    }
    const session = assignment === 'proxy-reject' ? new Proxy(raw, {
      set(_target, key) { trace.push(['set-rejected', key]); return false; },
    }) : raw;
    const routes = factory({ persistedSessions: new Map(),
      mint: () => { trace.push('mint'); return 'token-1'; },
      persist: reason => trace.push(['persist', reason]),
      encode: (id, token) => { trace.push(['encode', id, token]); return `${id}|${token}`; },
    });
    const original = Object.getOwnPropertyDescriptor(Object, 'assign');
    let result;
    try {
      if (patch === 'getter') {
        Object.defineProperty(Object, 'assign', { configurable: true, get() {
          trace.push('assign-getter');
          throw sentinel;
        } });
      } else {
        Object.defineProperty(Object, 'assign', { ...original, value() {
          trace.push('assign-call');
          throw sentinel;
        } });
      }
      result = capture(() => routes.sessionSegment(session), sentinel);
    } finally {
      Object.defineProperty(Object, 'assign', original);
    }
    const stored = Object.getOwnPropertyDescriptor(raw, 'proxyRouteToken');
    return { trace, result, stored: stored ? stored.value : undefined };
  };
  for (const assignment of ['writable', 'readonly', 'proxy-reject']) {
    for (const patch of ['getter', 'function']) {
      const expected = execute(legacyTerminalRoutes, assignment, patch);
      assert.equal(expected.trace.includes('assign-getter'), false);
      assert.equal(expected.trace.includes('assign-call'), false);
      assert.deepEqual(execute(createTerminalProxyRoutes, assignment, patch), expected, `${assignment}: ${patch}`);
    }
  }
});

test('strict token assignment works when JavaScript string code generation is disabled', () => {
  const { spawnSync } = require('node:child_process');
  const { addonPath } = require('../src/native/runtime');
  const script = `
    'use strict';
    const assert = require('node:assert/strict');
    const native = require(process.env.MULTICC_RUST_ADDON);
    const port = native.providerTerminalValidate({ persistedSessions: new Map(),
      mint: () => 'known-token', encode: (id, token) => id + ':' + token });
    const session = { id: 'term', provider: 'provider' };
    assert.equal(native.providerTerminalSessionSegment(session, port), 'term:known-token');
    assert.equal(session.proxyRouteToken, 'known-token');
  `;
  const child = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '-e', script], {
    env: { ...process.env, MULTICC_RUST_ADDON: addonPath() }, encoding: 'utf8', timeout: 45000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test('terminal lookup resolves outer and inner Object.freeze before calling either', () => {
  const execute = (factory, mode) => {
    const trace = [];
    const sentinel = new Error('inner freeze failed');
    const store = new Map([
      ['outer', { kind: 'terminal', provider: 'p', proxyRouteToken: 'token', subagent: { providerId: 'sub' } }],
      ['nested', { kind: 'terminal', provider: 'inner', proxyRouteToken: 'inner-token' }],
    ]);
    const routes = factory({ persistedSessions: store, encode: () => 'unused' });
    const original = Object.getOwnPropertyDescriptor(Object, 'freeze');
    let reads = 0;
    let nested = false;
    const replacement = function(value) {
      trace.push(['replacement', this === Object, Array.isArray(value)]);
      return original.value.call(this, value);
    };
    const outer = function(value) {
      trace.push(['outer-call', this === Object, Array.isArray(value)]);
      return original.value.call(this, value);
    };
    const inner = function(value) {
      trace.push(['inner-call', this === Object, Array.isArray(value)]);
      if (mode === 'throw-inner') throw sentinel;
      if (mode === 'reenter' && !nested) {
        nested = true;
        Object.defineProperty(Object, 'freeze', { ...original, value: replacement });
        trace.push(['nested', capture(() => routes.lookup('nested'), sentinel)]);
      }
      return original.value.call(this, value);
    };
    let result;
    try {
      Object.defineProperty(Object, 'freeze', { configurable: true, get() {
        reads++;
        trace.push(['freeze-get', reads, this === Object]);
        if (reads === 1 && mode === 'replace-getter') {
          Object.defineProperty(Object, 'freeze', { ...original, value: inner });
        }
        if ((reads === 1 && mode.startsWith('outer-invalid-'))
            || (reads === 2 && mode.startsWith('inner-invalid-'))) {
          if (mode.endsWith('-null')) return null;
          if (mode.endsWith('-number')) return 7;
          return undefined;
        }
        return reads === 1 ? outer : inner;
      } });
      result = capture(() => routes.lookup('outer'), sentinel);
    } finally {
      Object.defineProperty(Object, 'freeze', original);
    }
    return { trace, result };
  };
  for (const mode of ['normal', 'replace-getter', 'throw-inner', 'reenter',
    'outer-invalid-null', 'outer-invalid-number', 'outer-invalid-undefined',
    'inner-invalid-null', 'inner-invalid-number', 'inner-invalid-undefined']) {
    const expected = execute(legacyTerminalRoutes, mode);
    if (mode === 'normal') {
      assert.deepEqual(expected.trace, [
        ['freeze-get', 1, true], ['freeze-get', 2, true],
        ['inner-call', true, true], ['outer-call', true, false],
      ]);
    }
    if (mode === 'throw-inner') assert.equal(expected.result.error.same, true);
    if (mode.startsWith('outer-invalid-')) {
      assert.equal(expected.result.error.name, 'TypeError');
      assert.ok(expected.trace.some(item => item[0] === 'inner-call'),
        'the inner argument must be frozen before a non-callable outer function fails');
    }
    assert.deepEqual(execute(createTerminalProxyRoutes, mode), expected, mode);
  }
});

test('terminal lookup creates array elements without calling inherited numeric setters', () => {
  const { spawnSync } = require('node:child_process');
  const { addonPath } = require('../src/native/runtime');
  const script = `
    'use strict';
    const assert = require('node:assert/strict');
    const native = require(process.env.MULTICC_RUST_ADDON);
    const legacy = require('./tests/helpers/legacy-terminal-route');
    const store = new Map([['term', { kind: 'terminal', provider: 'main', proxyRouteToken: 'token',
      subagent: { providerId: 'sub' } }]]);
    const options = { persistedSessions: store, encode: () => 'unused' };
    const originalRoutes = legacy.createTerminalProxyRoutes(options);
    const port = native.providerTerminalValidate(options);
    for (const key of ['0', '1']) {
      const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
      const sentinel = new Error('inherited array setter was called');
      let oldValue, nativeValue, oldError, nativeError;
      try {
        Object.defineProperty(Array.prototype, key, { configurable: true,
          set() { throw sentinel; } });
        try { oldValue = originalRoutes.lookup('term'); } catch (error) { oldError = error; }
        try { nativeValue = native.providerTerminalLookup('term', port); } catch (error) { nativeError = error; }
      } finally {
        if (descriptor) Object.defineProperty(Array.prototype, key, descriptor);
        else delete Array.prototype[key];
      }
      assert.equal(oldError, undefined, 'oracle must not invoke the inherited setter');
      assert.equal(nativeError, undefined, 'native path must not invoke the inherited setter');
      assert.deepEqual(nativeValue, oldValue);
      assert.deepEqual(nativeValue.allowedSubProviderIds, ['main', 'sub']);
      assert.equal(Object.isFrozen(nativeValue), true);
      assert.equal(Object.isFrozen(nativeValue.allowedSubProviderIds), true);
    }
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MULTICC_RUST_ADDON: addonPath() },
    encoding: 'utf8', timeout: 45000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test('terminal paths preserve strict primitive receivers for getters and methods', () => {
  const execute = (factory, scenario, primitive) => {
    const trace = [];
    const saved = [];
    const otherPrimitive = typeof primitive === 'string' ? 17 : 'sub-primitive';
    const proto = typeof primitive === 'string' ? String.prototype : Number.prototype;
    const otherProto = typeof otherPrimitive === 'string' ? String.prototype : Number.prototype;
    const install = (object, key, descriptor) => {
      saved.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
      Object.defineProperty(object, key, { configurable: true, ...descriptor });
    };
    const receiverGetter = (label, expected, value) => function() {
      trace.push([label, typeof this, this === expected]);
      return value;
    };
    const encode = (id, token) => { trace.push(['encode', id, token]); return `${id}|${token}`; };
    const normalRecord = { kind: 'terminal', provider: 'provider', proxyRouteToken: 'token' };
    const defaultStore = new Map([['term', normalRecord]]);
    let result;
    try {
      if (scenario === 'session') {
        const routes = factory({ persistedSessions: defaultStore, encode });
        install(proto, 'id', { get: receiverGetter('session.id', primitive, 'term') });
        install(proto, 'provider', { get: receiverGetter('session.provider', primitive, 'provider') });
        install(proto, 'proxyRouteToken', { get: receiverGetter('session.token', primitive, 'token') });
        result = capture(() => routes.sessionSegment(primitive));
      } else if (scenario === 'options') {
        for (const [key, value] of [
          ['persistedSessions', defaultStore], ['persist', undefined], ['encode', encode], ['mint', undefined],
        ]) install(proto, key, { get: receiverGetter(`options.${key}`, primitive, value) });
        result = capture(() => factory(primitive).lookup('term'));
      } else if (scenario === 'store') {
        const get = function(id) {
          trace.push(['store.call', typeof this, this === primitive, id]);
          return normalRecord;
        };
        install(proto, 'get', { get: receiverGetter('store.get', primitive, get) });
        result = capture(() => factory({ persistedSessions: primitive, encode }).lookup('term'));
      } else if (scenario === 'record-subagent') {
        const store = new Map([['term', primitive]]);
        const routes = factory({ persistedSessions: store, encode });
        for (const [key, value] of [
          ['kind', 'terminal'], ['provider', 'provider'], ['proxyRouteToken', 'token'], ['subagent', otherPrimitive],
        ]) install(proto, key, { get: receiverGetter(`record.${key}`, primitive, value) });
        install(otherProto, 'providerId', { get: receiverGetter('subagent.providerId', otherPrimitive, 'sub') });
        result = capture(() => routes.lookup('term'));
      } else {
        const trim = Object.getOwnPropertyDescriptor(String.prototype, 'trim');
        const routes = factory({ persistedSessions: defaultStore, encode });
        install(String.prototype, 'trim', { get() {
          trace.push(['trim.get', typeof this, String(this)]);
          return function() {
            trace.push(['trim.call', typeof this, String(this)]);
            return trim.value.call(this);
          };
        } });
        const session = { id: ' term ', provider: ' provider ', proxyRouteToken: ' token ' };
        result = [capture(() => routes.sessionSegment(session)), capture(() => routes.lookup(' term '))];
      }
    } catch (error) {
      result = { outerError: [error.name, error.message] };
    } finally {
      for (const [object, key, descriptor] of saved.reverse()) {
        if (descriptor) Object.defineProperty(object, key, descriptor);
        else delete object[key];
      }
    }
    return { trace, result };
  };
  for (const scenario of ['session', 'options', 'store', 'record-subagent', 'trim']) {
    for (const primitive of ['primitive', 23]) {
      const expected = execute(legacyTerminalRoutes, scenario, primitive);
      assert.ok(expected.trace.length > 0, `oracle did not exercise ${scenario}`);
      for (const item of expected.trace) {
        if (typeof item[0] === 'string' && item[0] !== 'encode' && !item[0].startsWith('trim.')) {
          assert.equal(item[2], true, `${item[0]} must receive the primitive itself`);
        }
        if (item[0].startsWith('trim.')) assert.equal(item[1], 'string');
      }
      assert.deepEqual(execute(createTerminalProxyRoutes, scenario, primitive), expected,
        `${scenario}: ${typeof primitive}`);
    }
  }
});
