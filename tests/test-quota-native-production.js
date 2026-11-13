'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProviderQuotaRuntime } = require('../src/quota/provider-runtime');
const { createAutoProviderRuntime } = require('../src/chat/auto-provider-runtime');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { createNativeProviderLimitCache } = require('../src/quota/provider-limit-cache-native-host');
const { createLimitRecorder } = require('../src/quota/limit-cache-recorder');

test('production quota commits precede auto selection and final proxy admission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-quota-production-'));
  const ids = ['claude-official-guarded', 'claude-official-roomy'];
  const list = ids.map(id => ({ id, name: id, appType: 'claude', apiFormat: 'anthropic',
    compatibleClis: ['claude'], model: `${id}-model`, modelOptions: [`${id}-model`] }));
  const providers = {
    appTypeForCli: () => 'claude', appTypesForCli: () => ['claude'],
    listProviders: type => list.filter(item => !type || item.appType === type),
    getProvider: (_type, id) => list.find(item => item.id === id),
    getProviderLimitTarget: () => null,
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: (_type, id, model) => list.some(item => item.id === id && item.model === model),
  };
  const paths = {
    providerQuotaHistoryDbFile: path.join(root, 'history.db'),
    providerLimitDbFile: path.join(root, 'limits.db'),
    providerLimitCacheFile: path.join(root, 'limits.json'),
    quotaBarCacheFile: path.join(root, 'bars.json'),
    quotaGuardFile: path.join(root, 'guard.json'),
  };
  const addon = require('../src/native/runtime').getNative();
  await addon.accountSubscriptionCache(paths.providerLimitDbFile, JSON.stringify({
    operation: 'record', vendor: 'claude', accountId: 'global', attemptAt: 123,
    result: { status: 'unavailable' },
  }));
  fs.writeFileSync(paths.providerLimitCacheFile, JSON.stringify({ __multiccSchema: { kind: 'cache' }, data: {
    entries: { 'claude:old': { appType: 'claude', providerId: 'old', summaryText: 'legacy' } },
  } }));
  const quota = createProviderQuotaRuntime({ paths, persistedSessions: new Map(), providers,
    broadcast: () => {}, logger: { info() {}, warn() {} } });
  try {
    await quota.providerLimitCache.ready();
    assert.equal((await quota.providerLimitCache.get('claude', 'old')).summaryText, 'legacy');
    assert.equal(fs.existsSync(`${paths.providerLimitCacheFile}.migrated`), true);
    const subscriptions = JSON.parse(await addon.accountSubscriptionCache(paths.providerLimitDbFile, JSON.stringify({ operation: 'read' })));
    assert.equal(subscriptions['claude:global'].lastAttemptAt, 123);
    const now = Date.now();
    const pending = quota.limitRecorder.recordOfficialWindows('claude', ids[0], {
      windows: [{ window: '5h', usedPercent: 99, resetMs: now + 3_600_000 }], fetchedAt: now,
    });
    const auto = createAutoProviderRuntime({ providers, providerLimitCache: quota.providerLimitCache,
      quotaGuard: quota.quotaGuard, emit: () => {}, hasLiveBackgroundTasks: () => false });
    const session = { id: 's1', cli: 'claude', providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
      candidates: [{ providerId: ids[0], priority: 1 }, { providerId: ids[1], priority: 2 }],
    } };
    const turn = await auto.beginTurnAsync({ session, turnId: 't1', promptText: 'hi' });
    await pending;
    assert.equal(turn.initial().providerId, ids[1]);
    let sequence = 0;
    const attempts = createProviderAttemptRuntime({ quotaGuard: quota.quotaGuard,
      runtimeEpoch: 'quota-test', nextId: prefix => `${prefix}-${++sequence}` });
    const attempt = attempts.beginAttempt({ sessionId: 's1', turnId: 't1', cli: 'claude',
      providerId: ids[0], providerName: ids[0], protocol: 'anthropic', model: 'm',
      providerRevision: 'r', attemptNo: 1 });
    const decision = await attempts.authorizeProxyRequestAsync({ protocol: 'claude',
      providerId: ids[0], sessionId: attempts.proxySessionId(attempt), role: 'main', method: 'POST' });
    assert.equal(decision.ok, false);
    assert.match(decision.code, /^quota_guard:/);

    const other = createNativeProviderLimitCache({ file: paths.providerLimitDbFile, logger: null });
    try {
      await other.ready();
      const otherRecorder = createLimitRecorder({ cache: other, persistedSessions: new Map(), providers });
      const fetchedAt = Date.now();
      await Promise.all([
        quota.limitRecorder.recordOfficialWindows('claude', 'parallel', { fetchedAt,
          windows: [{ window: '5h', usedPercent: 20, resetMs: fetchedAt + 3_600_000 }] }),
        otherRecorder.recordOfficialWindows('claude', 'parallel', { fetchedAt,
          windows: [{ window: '7d', usedPercent: 90, resetMs: fetchedAt + 86_400_000 }] }),
      ]);
      const row = await quota.providerLimitCache.get('claude', 'parallel');
      assert.deepEqual(new Set(row.summary.windows.map(item => item.window)), new Set(['5h', '7d']));
    } finally { await other.close(); }
  } finally {
    await quota.providerLimitCache.close();
    quota.providerQuotaHistory.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
