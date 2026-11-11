'use strict';

// Host bridge only. Rust owns persistence, freshness and public projection;
// the existing OAuth query ports stay here until credential I/O moves to Rust.
const fs = require('node:fs');
const { getNative, runNative } = require('../native/runtime');
const readers = new Map();
let file = null, entries = {}, loaded = null, queue = Promise.resolve();
// The front door now writes this database too (the Rust subscription route),
// so the in-process snapshot can go stale between our own records. `project`
// keeps its synchronous contract: it notices a changed file (`provider-limit-
// cache.db` plus SQLite's -wal/-shm) and starts an async reload; the call that
// noticed still answers from the old snapshot, the next one after the read
// lands has it. See docs/gateway.md §9 (cross-process cache).
let fingerprint = null, reload = null;
function configure(options = {}) {
  file = options.file || null; entries = {}; loaded = null; queue = Promise.resolve();
  fingerprint = null; reload = null;
}
function native() { return getNative(); }
// Every read/write of the shared file runs one at a time, in submission order:
// an async reload must never land before an earlier record's rows or after a
// later record's, because `entries` is one snapshot for all callers.
function enqueue(work) {
  const run = queue.catch(() => {}).then(work);
  queue = run.catch(() => {});
  return run;
}
function stamp() {
  if (!file) return null;
  const parts = [];
  for (const name of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const stat = fs.statSync(name);
      parts.push(`${stat.mtimeMs}:${stat.size}`);
    } catch (_) {
      parts.push('-');
    }
  }
  return parts.join('|');
}
async function access(input) {
  if (!file) return;
  // A read trusts only the stamp taken before it: a writer that lands during
  // the read changes the current stamp, so the next project() reads again.
  // A record returns the whole table *as of its own write*, but a stamp taken
  // after it returns would fold any concurrent writer into that stamp while
  // leaving its row out of `entries` — and nothing would ever re-read it. Keep
  // `fingerprint = null` after a record instead: the next project() starts one
  // cheap re-read, so an interleaved write is visible at the next call.
  const before = input.operation === 'read' ? stamp() : null;
  const addon = native();
  entries = JSON.parse(await runNative(() => addon.accountSubscriptionCache(file, JSON.stringify(input))));
  fingerprint = before;
}
function ready() {
  if (!loaded) loaded = access({ operation: 'read' }).catch(error => { loaded = null; throw error; });
  return loaded;
}
function record(vendor, accountId, result, attemptAt) {
  return enqueue(() => ready()
    .then(() => access({ operation: 'record', vendor, accountId, result, attemptAt })));
}
function project(providers) {
  if (file && !reload && stamp() !== fingerprint) {
    // The gateway (or another process) wrote. Re-read the shared file without
    // making this synchronous path wait; failures leave the old snapshot and
    // the same check retries on the next call.
    reload = enqueue(() => access({ operation: 'read' })).catch(() => {}).finally(() => { reload = null; });
  }
  const addon = native();
  return JSON.parse(addon.projectAccountSubscriptions(JSON.stringify({ providers, subscriptions: entries })));
}
function register(vendor, reader) { readers.set(vendor, reader); }
function refresh(provider) { return readers.get(provider.appType)?.(provider.officialAccountId || ''); }
module.exports = { configure, ready, record, project, register, refresh, snapshot: () => entries };
