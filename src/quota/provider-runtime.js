'use strict';

// Host composition for the durable quota stores and virtual-provider bridge.
const { createProviderLimitCache } = require('./provider-limit-cache');
const { createProviderQuotaHistory } = require('./provider-quota-history');
const { createLimitRecorder } = require('./limit-cache-recorder');
const { createQuotaBarCache } = require('./quota-bar-cache');
const { createQuotaGuard } = require('./quota-guard');
const { connectProviderLimitSync } = require('./provider-limit-sync');

function createProviderQuotaRuntime({ paths, persistedSessions, providers, broadcast, logger }) {
  const providerQuotaHistory = createProviderQuotaHistory({ file: paths.providerQuotaHistoryDbFile });
  const providerLimitCache = createProviderLimitCache({ file: paths.providerLimitDbFile,
    legacyJsonFile: paths.providerLimitCacheFile, onRecord: entry => providerQuotaHistory.recordEntry(entry) });
  const limitRecorder = createLimitRecorder({ cache: providerLimitCache, persistedSessions, providers });
  connectProviderLimitSync({ cache: providerLimitCache, persistedSessions, providers, broadcast });
  const quotaBarCache = createQuotaBarCache({ file: paths.quotaBarCacheFile });
  const quotaGuard = createQuotaGuard({ cache: providerLimitCache, configFile: paths.quotaGuardFile, logger });
  require('./account-subscription-cache').configure({ file: paths.providerLimitDbFile });
  require('../providers/virtual-provider').configure({ cache: providerLimitCache, guard: quotaGuard, recordDto: limitRecorder.recordDto });
  return { providerQuotaHistory, providerLimitCache, limitRecorder, quotaBarCache, quotaGuard };
}
module.exports = { createProviderQuotaRuntime };
