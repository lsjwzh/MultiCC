'use strict';
// Tests for the SQLite-backed provider-limit cache and its recorder
// (src/quota/provider-limit-cache.js + src/quota/limit-cache-recorder.js).
//
// Covers the dispatch requirements:
//   - real SQLite table keyed on (app_type, provider_id), schema + meta version
//   - idempotent upsert on a composite primary key
//   - structured window/balance summaries + compact bar text survive a restart
//   - a failed fetch never overwrites the last good data (preserve-on-failure)
//   - provider deletion prunes orphaned cache entries
//   - one-time idempotent JSON → SQLite migration; SQLite becomes the sole
//     authority and the legacy JSON is archived (never deleted, never re-written)
//   - schema-version mismatch fails closed
//   - no credentials ever reach the persisted database

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createProviderLimitCache,
  STALE_MS_DEFAULT,
  DATABASE_SCHEMA_VERSION,
} = require('../src/quota/provider-limit-cache');
const { createLimitRecorder } = require('../src/quota/limit-cache-recorder');
const { compactBarText } = require('../src/quota/quota-bar-view');
const { writeJsonAtomic } = require('../src/state-store');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}
function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `multicc-limit-cache-${label}-`));
}
function tmpDb(label) {
  return path.join(tmpDir(label), 'provider-limit-cache.db');
}

// Deterministic clock for reproducible freshness/stale assertions.
function fixedClock(startMs) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// A minimal providers facade the recorder can talk to.
function stubProviders({ appTypeForCli = () => 'claude', list = [], targets = {} } = {}) {
  return {
    appTypeForCli,
    listProviders(appType) {
      return list.filter(p => !appType || p.appType === appType);
    },
    getProviderLimitTarget(appType, id) {
      return targets[`${appType}:${id}`] || null;
    },
  };
}

function fakeSessions(records) {
  const m = new Map();
  for (const [name, rec] of Object.entries(records)) m.set(name, rec);
  return m;
}

// ── compactBarText ──────────────────────────────────────────────────────────

function testCompactBarText() {
  const cases = [
    ['5h 20% 1.2h · 1wk 50% 3d 5h', '5h 20% 1.2h · 1wk 50% 3d 5h'],
    ['5h 20% {cd:12345} · 1wk 50% 3d 5h · {ago:999} · ⟳ 刷新', '5h 20% · 1wk 50% 3d 5h'],
    ['5h - · 1wk 75% 3d · {ago:123} · ⟳ 刷新', '5h - · 1wk 75% 3d'],
    ['⟳ 刷新', ''],
    ['', ''],
    [null, ''],
    ['¥1.23 · 余额不足', '¥1.23 · 余额不足'],
  ];
  for (const [input, expected] of cases) {
    const got = compactBarText(input);
    ok(got === expected, `compactBarText(${JSON.stringify(input)}) → ${JSON.stringify(got)}`);
  }
}

// ── SQLite schema: real table, composite PK, meta schema version ─────────────

function testSqliteSchema() {
  const file = tmpDb('schema');
  const clock = fixedClock(1_700_000_000_000);
  const cache = createProviderLimitCache({ file, now: clock.now });
  cache.record('claude', 'p-1', { kind: 'window', summaryText: '5h 80%' });
  cache.close();

  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true });
  try {
    const version = JSON.parse(
      db.prepare("SELECT value_json FROM provider_limit_meta WHERE key = 'databaseSchemaVersion'").get().value_json,
    );
    ok(version === DATABASE_SCHEMA_VERSION, `meta databaseSchemaVersion = ${DATABASE_SCHEMA_VERSION}`);
    ok(db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal', 'WAL journal mode persisted');

    const cols = db.prepare('PRAGMA table_info(provider_limit_cache)').all().map(r => r.name);
    for (const expect of ['app_type', 'provider_id', 'summary_json', 'summary_text', 'bar_text', 'fetched_at', 'updated_at', 'last_error', 'last_error_at']) {
      ok(cols.includes(expect), `table has column ${expect}`);
    }
    // Composite primary key → uniqueness by (app_type, provider_id).
    const pks = db.prepare('PRAGMA table_info(provider_limit_cache)').all()
      .filter(r => r.pk > 0).map(r => r.name).sort();
    ok(pks.join(',') === 'app_type,provider_id', `composite PK is (app_type, provider_id), got [${pks}]`);
    const rows = db.prepare('SELECT count(*) AS n FROM provider_limit_cache').get().n;
    ok(rows === 1, 'record writes exactly one row');
  } finally {
    db.close();
  }
}

// ── store: success upsert / failure preserve / restart / prune / no secrets ─

function testStore() {
  const file = tmpDb('store');
  const clock = fixedClock(1_700_000_000_000);
  const cache = createProviderLimitCache({ file, now: clock.now });

  // 1. success upsert (window)
  const w1 = cache.record('claude', 'p-1', {
    kind: 'window',
    summary: { kind: 'window', provider: 'glm', status: 'allowed', usedPercentage: 20, resetsAtMs: 12345, observedAtMs: 1_700_000_000_000 },
    summaryText: '5h 80% 1.2h',
    barText: '5h 80% {cd:12345}',
    fetchedAt: 1_700_000_000_000,
  });
  ok(w1.status === 'ok' && w1.summaryText === '5h 80% 1.2h', 'success upsert returns ok entry');
  ok(cache.get('claude', 'p-1').kind === 'window', 'get returns the window entry');
  ok(cache.key('claude', 'p-1') === 'claude:p-1', 'key is appType:providerId');

  // 2. idempotent re-record (same identity) updates in place, no duplicate keys
  cache.record('claude', 'p-1', { kind: 'window', summary: w1.summary, summaryText: '5h 70% 1.0h', fetchedAt: 1_700_000_060_000 });
  ok(Object.keys(cache.snapshot().entries).length === 1, 're-record is an upsert (single key)');
  ok(cache.get('claude', 'p-1').summaryText === '5h 70% 1.0h', 're-record overwrites the summary text');

  // 3. failed fetch preserves last good value, stamps diagnostics only
  clock.advance(10_000);
  const failEntry = cache.recordFailure('claude', 'p-1', { error: 'fetch_failed', code: 'ENETUNREACH' });
  ok(failEntry.summaryText === '5h 70% 1.0h', 'failure keeps the previous summary text');
  ok(failEntry.status === 'ok', 'failure keeps status ok (last good data still valid)');
  ok(failEntry.lastError === 'fetch_failed' && failEntry.lastErrorCode === 'ENETUNREACH', 'failure records diagnostic lastError');
  ok(failEntry.lastErrorAt != null, 'failure records lastErrorAt');

  // 4. restart recovery — a fresh cache instance on the same file sees the data
  const cache2 = createProviderLimitCache({ file, now: clock.now });
  const revived = cache2.get('claude', 'p-1');
  ok(revived && revived.summaryText === '5h 70% 1.0h', 'restart recovers the persisted summary');
  ok(revived && revived.lastError === 'fetch_failed', 'restart recovers the failure diagnostic');
  ok(revived && revived.kind === 'window', 'restart recovers the structured kind');
  ok(revived && revived.summary && revived.summary.usedPercentage === 20, 'restart recovers the structured summary fields');

  // 5. prune drops orphan entries (deleted/renamed provider)
  cache.record('codex', 'p-gone', { kind: 'balance', summaryText: '¥2.00', summary: { kind: 'balance', available: true } });
  const live = new Set([cache.key('claude', 'p-1')]);
  const removed = cache.prune(live);
  ok(removed === 1, 'prune removes the orphan');
  ok(cache.get('codex', 'p-gone') === null, 'orphan is gone after prune');
  ok(cache.get('claude', 'p-1') !== null, 'live entry survives prune');

  // 6. no credentials anywhere on disk (close first so WAL is checkpointed)
  cache.close();
  cache2.close();
  const raw = fs.readFileSync(file, 'utf8');
  const lower = raw.toLowerCase();
  ok(!/token/.test(lower), 'persisted database contains no "token"');
  ok(!/apikey/.test(lower) && !/api_key/.test(lower), 'persisted database contains no api key');
  ok(!/anthopic_auth|anthropic_auth/.test(lower), 'persisted database contains no auth env keys');
}

// ── recorder: session DTOs / provider results / vendor routes / claude ──────

function testRecorder() {
  const file = tmpDb('recorder');
  const clock = fixedClock(1_700_000_000_000);
  const cache = createProviderLimitCache({ file, now: clock.now });

  const glmTarget = { providerId: 'p-glm', appType: 'claude', host: 'open.bigmodel.cn', apiKey: 'sk-secret', strategy: 'glm-monitor' };
  const deepseekTarget = { providerId: 'p-ds', appType: 'claude', host: 'api.deepseek.com', apiKey: 'sk-secret', strategy: 'deepseek-balance' };
  const providers = stubProviders({
    appTypeForCli: () => 'claude',
    list: [
      { id: 'p-glm', appType: 'claude', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { id: 'p-ds', appType: 'claude', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    ],
    targets: { 'claude:p-glm': glmTarget, 'claude:p-ds': deepseekTarget },
  });
  const sessions = fakeSessions({
    s1: { cli: 'claude', provider: 'p-glm' },
    s2: { cli: 'claude', provider: 'p-ds' },
  });
  const recorder = createLimitRecorder({ cache, persistedSessions: sessions, providers, now: clock.now });

  // window DTO from the poller → structured window summary + compact text
  const w = recorder.recordSession('s1', { kind: 'window', rateLimitType: 'five_hour', status: 'allowed', utilization: 0.2, resetsAt: 1_700_000_360_000, provider: 'glm' });
  ok(w && w.kind === 'window', 'recordSession(window) records a window entry');
  ok(w.summaryText === '5h 80%', 'window DTO renders a compact segment text');
  ok(w.summary.usedPercentage === 20 && w.summary.provider === 'glm', 'window DTO stores normalized structured fields');

  // balance DTO → structured balance + ¥ text
  const b = recorder.recordSession('s2', { kind: 'balance', available: true, total: 12.5, currency: 'CNY' });
  ok(b && b.kind === 'balance', 'recordSession(balance) records a balance entry');
  ok(b.summaryText === '¥12.50', 'balance DTO renders ¥ compact text');
  ok(b.summary.total === 12.5 && b.summary.available === true, 'balance DTO stores normalized structured fields');

  // provider-balance runtime result → same recorder path
  const viaProvider = recorder.recordProvider('claude', 'p-glm', { ok: true, providerId: 'p-glm', dto: { kind: 'window', rateLimitType: 'five_hour', status: 'rejected', utilization: 1.0, resetsAt: 1_700_000_360_000, provider: 'glm' } });
  ok(viaProvider && viaProvider.summary.status === 'rejected' && viaProvider.summaryText === '5h 0%', 'recordProvider(ok) records the DTO summary');

  // provider-balance failure → diagnostics, no data overwrite
  const before = cache.get('claude', 'p-glm').summaryText;
  recorder.recordProvider('claude', 'p-glm', { ok: false, reason: 'fetch_failed' });
  const after = cache.get('claude', 'p-glm');
  ok(after.summaryText === before && after.lastError === 'fetch_failed', 'provider failure preserves data and stamps error');

  // vendor route: zhipu host match → records against every provider on that host
  const zhipuResult = { status: 'ok', fetchedAt: 1_700_000_000_000, sites: [{ host: 'open.bigmodel.cn', site: 'bigmodel', ok: true, usedPercent: 40, weeklyUsedPercent: 55, resetsAt: 1_700_000_360_000 }] };
  const n = recorder.recordVendor({ kind: 'zhipu', result: zhipuResult, host: 'open.bigmodel.cn' });
  ok(n >= 1, 'recordVendor(zhipu) records for the host-matched provider');
  const zv = cache.get('claude', 'p-glm');
  ok(zv && zv.kind === 'zhipu' && zv.summaryText.length > 0, 'zhipu vendor summary text stored');

  // vendor route failure without session → no record at all (preserve contract)
  recorder.recordVendor({ kind: 'zhipu', result: { status: 'unavailable', error: 'boom' }, host: 'open.bigmodel.cn' });
  ok(cache.get('claude', 'p-glm').summaryText === zv.summaryText, 'vendor failure with no session never overwrites');

  // claude usage-page scrape
  const claudeResult = { status: 'ok', fetchedAt: 1_700_000_000_000, summary: [{ window: '5h', usedPercent: 30 }, { window: '1wk', usedPercent: 60 }] };
  const c = recorder.recordClaude('s1', claudeResult, '5h 70% {cd:1} · 1wk 40% 3d · ⟳ 刷新');
  ok(c && c.kind === 'claude', 'recordClaude records a claude entry');
  ok(c.summaryText === '5h 70% · 1wk 40% 3d', 'claude compact text strips placeholders and refresh action');
  ok(c.summary.windows.length === 2, 'claude structured windows stored');

  // host/baseUrl matchers
  ok(recorder.resolveByHost('open.bigmodel.cn').some(m => m.providerId === 'p-glm'), 'resolveByHost finds the glm provider');
  ok(recorder.resolveByBaseUrl('https://open.bigmodel.cn/api/paas/v4').some(m => m.providerId === 'p-glm'), 'resolveByBaseUrl finds by baseUrl');
  ok(recorder.resolveByBaseUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions').some(m => m.providerId === 'p-glm'), 'resolveByBaseUrl matches by host + path prefix');
  ok(recorder.resolveByHost('unrelated.example.com').length === 0, 'unknown host matches nothing');

  cache.close();
}

// ── stale/freshness projection ──────────────────────────────────────────────

function testStale() {
  const file = tmpDb('stale');
  const clock = fixedClock(1_700_000_000_000);
  const cache = createProviderLimitCache({ file, now: clock.now });
  cache.record('claude', 'p-a', { kind: 'window', summaryText: '5h 80%', fetchedAt: clock.now() });
  const staleAfterMs = STALE_MS_DEFAULT;
  ok(cache.get('claude', 'p-a').fetchedAt != null, 'entry carries fetchedAt');
  ok(staleAfterMs === 10 * 60 * 1000, 'default stale window is 10 minutes');
  cache.close();
}

// ── JSON → SQLite migration ─────────────────────────────────────────────────

function writeLegacyJson(file, entries, updatedAt) {
  writeJsonAtomic(file, { entries, updatedAt }, { kind: 'provider-limit-cache', schemaVersion: 1 });
}

function testMigration() {
  const dir = tmpDir('migrate');
  const db = path.join(dir, 'provider-limit-cache.db');
  const legacy = path.join(dir, 'provider-limit-cache.json');
  const clock = fixedClock(1_700_000_000_000);

  // Legacy file written by the previous JSON-backed implementation.
  writeLegacyJson(legacy, {
    'claude:p-1': {
      appType: 'claude', providerId: 'p-1', kind: 'window', status: 'ok',
      summary: { kind: 'window', provider: 'glm', usedPercentage: 20, resetsAtMs: 12345, observedAtMs: 1_700_000_000_000 },
      summaryText: '5h 80%', barText: '5h 80% {cd:1}', fetchedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000, lastError: null, lastErrorAt: null,
    },
    'codex:p-2': {
      appType: 'codex', providerId: 'p-2', kind: 'balance', status: 'ok',
      summary: { kind: 'balance', available: true, total: 12.5, currency: 'CNY' },
      summaryText: '¥12.50', barText: null, fetchedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000, lastError: null, lastErrorAt: null,
    },
  }, 1_700_000_000_000);

  const cache = createProviderLimitCache({ file: db, legacyJsonFile: legacy, now: clock.now });
  ok(cache.migration.migrated === true, 'migration reports migrated:true');
  ok(cache.migration.legacyEntryCount === 2, 'migration imports all legacy entries');
  ok(cache.migration.created === true, 'migration reports the DB was created');

  const e1 = cache.get('claude', 'p-1');
  const e2 = cache.get('codex', 'p-2');
  ok(e1 && e1.summaryText === '5h 80%' && e1.summary.usedPercentage === 20, 'migrated window entry intact');
  ok(e2 && e2.summaryText === '¥12.50' && e2.summary.currency === 'CNY', 'migrated balance entry intact');
  ok(e1.updatedAt === 1_700_000_000_000, 'migrated entry keeps updatedAt');

  // Legacy JSON is archived (kept, never deleted), never re-written.
  ok(!fs.existsSync(legacy), 'legacy JSON removed from its live path');
  ok(fs.existsSync(cache.migration.archivedJsonFile), 'legacy JSON archived to *.migrated');
  ok(cache.migration.archivedJsonFile.endsWith('.migrated'), 'archive name is provider-limit-cache.json.migrated');

  // Runtime no longer treats JSON as authority: a record only touches the DB,
  // the JSON path stays absent, and a fresh instance reads the updated row.
  cache.record('claude', 'p-1', { kind: 'window', summaryText: '5h 50%', fetchedAt: 1_700_000_060_000 });
  ok(!fs.existsSync(legacy), 'recording does not recreate the JSON file');
  cache.close();

  const cache2 = createProviderLimitCache({ file: db, legacyJsonFile: legacy, now: clock.now });
  ok(cache2.migration.migrated === false, 're-open with archived JSON is not a re-migration');
  ok(cache2.get('claude', 'p-1').summaryText === '5h 50%', 'fresh instance reads the DB (JSON is not authoritative)');
  cache2.close();

  // Migration is idempotent even if the JSON reappears (crash window): a
  // re-created legacy JSON fills only gaps (INSERT OR IGNORE), then archives.
  writeLegacyJson(legacy, {
    'codex:p-2': {
      appType: 'codex', providerId: 'p-2', kind: 'balance', status: 'ok',
      summary: { kind: 'balance', available: true, total: 12.5, currency: 'CNY' },
      summaryText: '¥12.50 (old)', barText: null, fetchedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000, lastError: null, lastErrorAt: null,
    },
  }, 1_700_000_000_000);
  const cache3 = createProviderLimitCache({ file: db, legacyJsonFile: legacy, now: clock.now });
  ok(cache3.migration.migrated === true, 'reappeared legacy JSON triggers catch-up');
  ok(cache3.get('codex', 'p-2').summaryText === '¥12.50', 'catch-up never overwrites newer DB rows (gap-fill only)');
  ok(cache3.get('claude', 'p-1').summaryText === '5h 50%', 'existing rows untouched by catch-up');
  ok(!fs.existsSync(legacy), 'reappeared legacy JSON archived again');
  cache3.close();
}

// ── schema guard: unsupported version fails closed ──────────────────────────

function testSchemaGuard() {
  const file = tmpDb('guard');
  const cache = createProviderLimitCache({ file });
  cache.record('claude', 'p-1', { kind: 'window', summaryText: '5h 80%' });
  cache.close();

  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.prepare("UPDATE provider_limit_meta SET value_json = ? WHERE key = 'databaseSchemaVersion'").run(JSON.stringify(99));
  db.close();

  let threw = false;
  try {
    const reopened = createProviderLimitCache({ file });
    reopened.close();
  } catch (e) {
    threw = /unsupported schema version/.test(String(e.message));
  }
  ok(threw, 'opening a DB with an unsupported schema version fails closed');
}

testCompactBarText();
testSqliteSchema();
testStore();
testRecorder();
testStale();
testMigration();
testSchemaGuard();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
