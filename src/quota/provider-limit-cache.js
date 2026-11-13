'use strict';

// Compatibility exports. SQLite ownership and mutation policy live in Rust.
const { createNativeProviderLimitCache } = require('./provider-limit-cache-native-host');
const STALE_MS_DEFAULT = 10 * 60 * 1000;
const DATABASE_SCHEMA_VERSION = 1;

module.exports = {
  createProviderLimitCache: createNativeProviderLimitCache,
  STALE_MS_DEFAULT,
  DATABASE_SCHEMA_VERSION,
};
