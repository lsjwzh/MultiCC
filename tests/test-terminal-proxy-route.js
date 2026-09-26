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
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { createTerminalProxyRoutes } = require('../src/providers/terminal-route');

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
