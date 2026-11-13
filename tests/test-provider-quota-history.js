'use strict';

// Provider 余量历史：Node 采样写入适配层 ↔ Rust 内核。
// 读取端点已迁到 Rust 前门（GET /api/providers/limit-history），这里直接调用
// RustQuotaHistory.query 校验内核落盘与去重语义。
// 需要带 RustQuotaHistory 的原生模块（CI 在 npm test 之前执行 build:rust）。
// 没有可用内核时显式 skip，而不是把「测不了」当成通过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProviderQuotaHistory } = require('../src/quota/provider-quota-history');
const { createProviderLimitCache } = require('./helpers/legacy-provider-limit-cache');
const { getNative, runNative } = require('../src/native/runtime');

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function tempFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-quota-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

function nativeHistory(t, file) {
  let addon;
  try { addon = getNative(); } catch (_) { return null; }
  if (typeof addon.RustQuotaHistory !== 'function') return null;
  try { return new addon.RustQuotaHistory(file, RETENTION_MS); } catch (_) { return null; }
}

async function query(handle, payload) {
  const result = await runNative(() => handle.query(JSON.stringify(payload)));
  return JSON.parse(result.result);
}

const windowEntry = (usedPercent, resetMs = 9_000_000) => ({
  kind: 'window',
  summary: { kind: 'window', status: 'ok', window: '5h', usedPercentage: usedPercent, windows: [{ window: '5h', label: '5h', usedPercent, resetMs }] },
  fetchedAt: 1_000_000,
});

test('records readings and answers a downsampled series', async t => {
  const file = tempFile(t, 'history.db');
  const reader = nativeHistory(t, file);
  if (!reader) {
    t.skip('native quota-history kernel unavailable (run npm run build:rust)');
    return;
  }
  const history = createProviderQuotaHistory({ file, logger: { warn() {} } });
  await history.recordEntry({ appType: 'claude', providerId: 'glm', updatedAt: 1_000_000, ...windowEntry(12) });
  await history.recordEntry({ appType: 'claude', providerId: 'glm', updatedAt: 1_600_000, ...windowEntry(40) });
  // Within five minutes of the previous sample → deduped in Rust.
  await history.recordEntry({ appType: 'claude', providerId: 'glm', updatedAt: 1_700_000, ...windowEntry(55) });

  const result = await query(reader, {
    providers: [{ appType: 'claude', providerId: 'glm' }], sinceMs: 0, points: 20,
  });
  const series = result.providers['claude:glm'].series['5h'];
  assert.equal(result.providers['claude:glm'].samples, 2);
  assert.deepEqual(series.points, [[1_000_000, 88], [1_600_000, 60]]);
  assert.equal(series.last, 60);
  assert.equal(series.unit, 'percent');
});

test('balance readings use total and keep the currency', async t => {
  const file = tempFile(t, 'history.db');
  const reader = nativeHistory(t, file);
  if (!reader) {
    t.skip('native quota-history kernel unavailable (run npm run build:rust)');
    return;
  }
  const history = createProviderQuotaHistory({ file, logger: { warn() {} } });
  // Production shape from src/quota/limit-cache-recorder.js: `available` is a
  // boolean and the money left is `total`.
  await history.recordEntry({
    appType: 'codex', providerId: 'deepseek', updatedAt: 1_000_000,
    summary: { kind: 'balance', available: true, total: 12.5, currency: 'CNY' },
  });
  const result = await query(reader, {
    providers: [{ appType: 'codex', providerId: 'deepseek' }], sinceMs: 0, points: 20,
  });
  const series = result.providers['codex:deepseek'].series.balance;
  assert.deepEqual(series.points, [[1_000_000, 12.5]]);
  assert.equal(series.unit, 'CNY');
});

test('availability cooldowns carry no samples', async t => {
  const file = tempFile(t, 'history.db');
  const reader = nativeHistory(t, file);
  if (!reader) { t.skip('native quota-history kernel unavailable'); return; }
  const history = createProviderQuotaHistory({ file, logger: { warn() {} } });
  const written = await history.recordEntry({
    appType: 'claude', providerId: 'glm', updatedAt: 1_000_000,
    summary: { kind: 'availability', status: 'rejected' },
  });
  assert.equal(written, null);
  const result = await query(reader, { providers: [{ appType: 'claude', providerId: 'glm' }], sinceMs: 0 });
  assert.deepEqual(result.providers, {});
});

test('the limit cache feeds the history through onRecord', async t => {
  const file = tempFile(t, 'history.db');
  const reader = nativeHistory(t, file);
  if (!reader) { t.skip('native quota-history kernel unavailable'); return; }
  const history = createProviderQuotaHistory({ file, logger: { warn() {} } });
  const pending = [];
  const cache = createProviderLimitCache({
    file: tempFile(t, 'cache.db'),
    onRecord: entry => pending.push(history.recordEntry(entry)),
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => cache.close());
  cache.record('claude', 'glm', windowEntry(25));
  cache.recordFailure('claude', 'glm', { error: 'boom' });
  await Promise.all(pending);

  const result = await query(reader, { providers: [{ appType: 'claude', providerId: 'glm' }], sinceMs: 0 });
  const entry = result.providers['claude:glm'];
  assert.ok(entry, 'a successful cache write must produce one sample');
  assert.equal(entry.series['5h'].last, 75);
  assert.equal(entry.samples, 1, 'failures never add samples');
});
