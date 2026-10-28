'use strict';

// Host bridge only. Rust owns persistence, freshness and public projection;
// the existing OAuth query ports stay here until credential I/O moves to Rust.
const { getNative, runNative } = require('../native/runtime');
const readers = new Map();
let file = null, entries = {}, loaded = null, writes = Promise.resolve();
function configure(options = {}) { file = options.file || null; entries = {}; loaded = null; writes = Promise.resolve(); }
function native() { return getNative('subscription'); }
async function access(input) {
  const addon = native();
  if (!file || typeof addon?.accountSubscriptionCache !== 'function') return;
  entries = JSON.parse(await runNative(() => addon.accountSubscriptionCache(file, JSON.stringify(input))));
}
function ready() {
  if (!loaded) loaded = access({ operation: 'read' }).catch(error => { loaded = null; throw error; });
  return loaded;
}
function record(vendor, accountId, result, attemptAt) {
  const work = writes.catch(() => {}).then(() => ready())
    .then(() => access({ operation: 'record', vendor, accountId, result, attemptAt }));
  writes = work;
  return work;
}
function project(providers) {
  const addon = native();
  return typeof addon?.projectAccountSubscriptions === 'function'
    ? JSON.parse(addon.projectAccountSubscriptions(JSON.stringify({ providers, subscriptions: entries }))) : providers;
}
function register(vendor, reader) { readers.set(vendor, reader); }
function refresh(provider) { return readers.get(provider.appType)?.(provider.officialAccountId || ''); }
module.exports = { configure, ready, record, project, register, refresh, snapshot: () => entries };
