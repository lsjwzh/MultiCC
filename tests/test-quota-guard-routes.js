'use strict';

// The quota guard settings API is the only writer of quota-guard.json. These
// tests pin the three things a settings route can quietly get wrong: it must
// report the same effective config the guard acts on, it must not accept a
// value that would hold every request (0% through a half-filled form), and the
// file it writes must be the file the guard re-reads on its own.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mountQuotaGuardRoutes, percentInput } = require('../src/routes/quota-guard');
const { createQuotaGuard } = require('../src/quota/quota-guard');

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-quota-guard-'));
  return path.join(dir, 'quota-guard.json');
}

function fakeRes() {
  return {
    code: 200,
    payload: null,
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function mount(file, env = {}) {
  const routes = {};
  const app = {
    get(route, handler) { routes[`GET ${route}`] = handler; },
    put(route, handler) { routes[`PUT ${route}`] = handler; },
  };
  mountQuotaGuardRoutes(app, { file, env });
  return {
    get(body) {
      const res = fakeRes();
      routes['GET /api/settings/quota-guard']({}, res);
      void body;
      return res;
    },
    put(body) {
      const res = fakeRes();
      routes['PUT /api/settings/quota-guard']({ body }, res);
      return res;
    },
  };
}

test('with no file, the API answers exactly the defaults the guard uses', () => {
  const routes = mount(tempFile());
  const res = routes.get();
  assert.equal(res.code, 200);
  assert.deepEqual(res.payload.config, {
    enabled: true, fiveHourPercent: 98, weeklyPercent: 98, monthlyPercent: 98, scope: 'official',
    maxReadingAgeMs: 30 * 60_000,
  });
  assert.deepEqual(res.payload.saved, {});
  assert.deepEqual(res.payload.envOverrides, []);
});

test('a partial save keeps the rest and is answered as the new effective config', () => {
  const file = tempFile();
  const routes = mount(file);
  const saved = routes.put({ weeklyPercent: 90, enabled: false });
  assert.equal(saved.code, 200);
  assert.equal(saved.payload.config.weeklyPercent, 90);
  assert.equal(saved.payload.config.fiveHourPercent, 98);
  assert.equal(saved.payload.config.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).weeklyPercent, 90);
});

test('values that would strand every request are refused, not clamped', () => {
  const routes = mount(tempFile());
  for (const fiveHourPercent of [0, -1, 101, 'abc', '', null]) {
    const res = routes.put({ fiveHourPercent });
    assert.equal(res.code, 400, `fiveHourPercent=${JSON.stringify(fiveHourPercent)}`);
    assert.match(res.payload.error, /fiveHourPercent/);
  }
  assert.equal(routes.put({ scope: 'none' }).code, 400);
  assert.equal(routes.put({ enabled: 'yes' }).code, 400);
  assert.equal(routes.put({}).code, 400);
  assert.equal(percentInput('97.5').value, 97.5);
});

test('maxReadingAgeMs saves within its band and is refused outside it', () => {
  const file = tempFile();
  const routes = mount(file);
  for (const maxReadingAgeMs of [0, -1, 5, 59_999, 8 * 24 * 3600_000, 'abc', '', null]) {
    const res = routes.put({ maxReadingAgeMs });
    assert.equal(res.code, 400, `maxReadingAgeMs=${JSON.stringify(maxReadingAgeMs)}`);
    assert.match(res.payload.error, /maxReadingAgeMs/);
  }
  const saved = routes.put({ maxReadingAgeMs: 10 * 60_000 });
  assert.equal(saved.code, 200);
  assert.equal(saved.payload.config.maxReadingAgeMs, 600_000);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).maxReadingAgeMs, 600_000);
  // The guard itself re-reads the saved value.
  const instance = createQuotaGuard({
    cache: { get: () => null }, configFile: file, env: {}, now: () => NOW,
  });
  assert.equal(instance.config().maxReadingAgeMs, 600_000);
});

test('an environment override is reported instead of silently outvoted', () => {
  const file = tempFile();
  const routes = mount(file, { MULTICC_QUOTA_GUARD_WEEKLY_PERCENT: '80' });
  routes.put({ weeklyPercent: 95 });
  const res = routes.get();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).weeklyPercent, 95, 'the file keeps what was saved');
  assert.equal(res.payload.config.weeklyPercent, 80, 'the effective value is the env one');
  assert.deepEqual(res.payload.envOverrides, ['weeklyPercent']);
});

test('the saved file is what the guard itself re-reads', () => {
  const file = tempFile();
  mount(file).put({ fiveHourPercent: 50 });
  const cache = {
    get: () => ({
      status: 'ok',
      fetchedAt: NOW,
      summary: { kind: 'window', windows: [{ window: '5h', usedPercent: 60, resetMs: NOW + HOUR }] },
    }),
  };
  const guard = createQuotaGuard({ cache, configFile: file, env: {}, now: () => NOW });
  const verdict = guard.check({ providerId: 'claude-official-abc' });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.threshold, 50);
});

test('a malformed file reads as "nothing saved" rather than throwing', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json');
  const res = mount(file).get();
  assert.equal(res.code, 200);
  assert.deepEqual(res.payload.saved, {});
  assert.equal(res.payload.config.fiveHourPercent, 98);
});
