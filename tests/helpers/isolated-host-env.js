'use strict';

// Only tool and native-module locators cross into a disposable test host.
// Provider credentials and unrelated application settings must not be inherited.
module.exports = function isolatedHostEnv() {
  const keys = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'MULTICC_RUST_ADDON', 'MULTICC_RUST_PREBUILT_DIR'];
  return Object.fromEntries(keys.filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]));
};
