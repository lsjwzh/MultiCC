'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeQuota } = require('../src/quota/claude-header-quota');
const { createProxyBroadcasters } = require('../src/chat/proxy-broadcast');
const Queue = require('../src/quota/claude-usage-queue');
const State = require('../src/quota/claude-bar-state');
const Renderer = require('../src/quota/quota-bar-view');
const { resolveQuotaBar } = require('../public/quota-bar-view');
const { createProviderLimitCache } = require('../src/quota/provider-limit-cache');
const { createLimitRecorder } = require('../src/quota/limit-cache-recorder');
const { limitState } = require('../src/chat/auto-provider-policy');

const available = claudeQuota('extract', { headers: {} }) !== undefined;
if (process.env.MULTICC_REQUIRE_RUST_TESTS === '1') assert.ok(available, 'Build the Claude quota Rust bridge');
const rustTest = (name, fn) => test(name, { skip: !available && 'Rust quota bridge is not built' }, fn);
const NOW = 1_700_000_000_000;
const header = (five, week) => claudeQuota('extract', { headers: {
  'anthropic-ratelimit-unified-5h-utilization': five,
  'anthropic-ratelimit-unified-5h-reset': String((NOW + 3600_000) / 1000),
  'anthropic-ratelimit-unified-7d-utilization': week,
  'anthropic-ratelimit-unified-7d-reset': String((NOW + 6 * 86400_000) / 1000),
} });
const normalized = (five, week, at = NOW) => Renderer.normalizeWindowEvent(header(five, week), at);
const view = (session, now = NOW) => resolveQuotaBar(State.renderClaudeBar(session, now), { now });

function state(t) {
  State.resetClaudeBarState(); Queue.resetClaudeUsageQueue();
  Queue.configureClaudeKeyResolver(session => session === 'other' ? 'claude:other' : 'claude:shared');
  const calls = [];
  Queue.configureClaudeUsageQueue({ now: () => NOW, fetchUsage: async () => {
    calls.push('usage'); throw new Error('Passive headers must not query usage');
  } });
  t.after(() => { State.resetClaudeBarState(); Queue.resetClaudeUsageQueue(); });
  return calls;
}

rustTest('5h and weekly headers render without a usage endpoint or browser login', t => {
  const calls = state(t);
  State.rememberClaudeLive('first', normalized('0.2', '0.65'));
  const bar = view('first');
  assert.match(bar.text, /5h 80% 1h/);
  assert.match(bar.text, /1wk-ALL 35% 6d/);
  assert.equal(bar.action, null);
  assert.doesNotMatch(bar.title, /未登录|尚未抓取/);
  assert.deepEqual(calls, []);
});

rustTest('partial headers preserve the week, same-account sessions share it and accounts stay isolated', t => {
  state(t);
  State.rememberClaudeLive('first', normalized('0.2', '0.65'));
  State.rememberClaudeLive('second', normalized('0.3', undefined, NOW + 1000));
  assert.match(view('first', NOW + 1000).text, /5h 70%/);
  assert.match(view('second', NOW + 1000).text, /1wk-ALL 35%/);
  assert.match(view('other').text, /5h - · 1wk -/);
  State.rememberClaudeLive('other', normalized(undefined, '0.1'));
  assert.match(view('other').text, /1wk-ALL 90%/);
  assert.match(view('first').text, /1wk-ALL 35%/);
});

rustTest('weekly-only events and the SDK seven_day event are accepted without labelling them 5h', t => {
  state(t);
  State.rememberClaudeLive('first', normalized(undefined, '1'));
  assert.match(view('first').text, /5h - · 1wk-ALL 0%/);
  assert.equal(view('first').color, '#f85149');
  const sdk = Renderer.normalizeWindowEvent({ rateLimitType: 'seven_day', status: 'allowed', utilization: 0.4,
    resetsAt: (NOW + 86400_000) / 1000 }, NOW);
  assert.equal(sdk.kind, 'weekly');
  State.rememberClaudeLive('other', sdk);
  assert.match(view('other').text, /5h - · 1wk-ALL 60%/);
});

rustTest('each live window expires at its own reset without reviving a closed 5h value', t => {
  state(t);
  State.rememberClaudeLive('first', normalized('0.2', '0.65'));
  const weekOnly = view('first', NOW + 3600_001);
  assert.match(weekOnly.text, /5h - · 1wk-ALL 35%/);
  assert.doesNotMatch(weekOnly.text, /5h 80%/);
  assert.match(view('first', NOW + 6 * 86400_000 + 1).text, /5h - · 1wk -/);
});

rustTest('the broadcast includes both windows and an exhausted week enters the account cache without extra queries', t => {
  state(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-header-quota-'));
  const cache = createProviderLimitCache({ file: path.join(root, 'quota.db'), now: () => NOW });
  t.after(() => { cache.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const provider = { id: 'claude-official-a', appType: 'claude' };
  const providers = { getProvider: () => provider, appTypeForCli: () => 'claude',
    getProviderLimitTarget: () => ({ strategy: 'claude-oauth-usage' }) };
  const recorder = createLimitRecorder({ cache, providers, now: () => NOW,
    persistedSessions: new Map([['first', { cli: 'claude', provider: provider.id }]]) });
  let refreshes = 0;
  recorder.setRefresher(() => { refreshes++; });
  const messages = [];
  t.mock.method(Date, 'now', () => NOW);
  const broadcaster = createProxyBroadcasters((_session, event) => messages.push(event), { recordLimit: recorder.recordSession });
  broadcaster.onRateLimit({ sessionId: 'first', role: 'main', providerId: provider.id, rateLimitInfo: header('0.2', '1') });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].rate_limit_info.windows.length, 2);
  assert.match(resolveQuotaBar(messages[0].bar, { now: NOW }).text, /5h 80%.*1wk-ALL 0%/);
  let entry = cache.get('claude', provider.id);
  assert.equal(entry.summary.windows.length, 2);
  assert.equal(limitState(entry, { now: NOW }).state, 'exhausted');
  broadcaster.onRateLimit({ sessionId: 'first', role: 'main', providerId: provider.id, rateLimitInfo: header('0.3', undefined) });
  entry = recorder.recordProviderFailure({ providerId: provider.id, httpStatus: 429, category: 'rate_limit' });
  assert.equal(limitState(entry, { now: NOW }).state, 'exhausted');
  assert.equal(entry.summary.windows.find(w => w.window === '1wk').usedPercent, 100);
  assert.equal(refreshes, 0);
  const withoutHeaders = { ...provider, id: 'claude-official-idle' };
  const idleRecorder = createLimitRecorder({ cache, now: () => NOW, persistedSessions: new Map(),
    providers: { ...providers, getProvider: () => withoutHeaders } });
  idleRecorder.setRefresher(() => { refreshes++; });
  idleRecorder.recordProviderFailure({ providerId: withoutHeaders.id, httpStatus: 429, category: 'rate_limit' });
  assert.equal(refreshes, 0, 'an official account without headers also avoids an automatic usage query');
  recorder.recordProviderFailure({ providerId: provider.id, httpStatus: 401, category: 'authentication_permission' });
  assert.equal(cache.get('claude', provider.id).summary.revoked, true, 'authentication failures still park the account');
  assert.equal(refreshes, 0, 'authentication failures do not trigger an automatic usage query either');
});
