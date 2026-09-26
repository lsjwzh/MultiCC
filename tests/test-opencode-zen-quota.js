'use strict';

// The OpenCode Go bar used to depend on a browser session that dies silently:
// the profile cookie outlives the server-side session, so the scrape degraded to
// needs_login weeks later. The Zen gateway answers the same three windows for an
// API key read off disk, and these tests pin that path — discovery, the
// {percent,resetsAt} → {usagePercent,resetInSec} conversion the bar renderer
// needs, and the rejected-key diagnosis.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_ZEN_BASE_URL,
  discoverZenCredentials,
  usageUrlsFor,
  normalizeUsage,
  fetchZenGoUsage,
} = require('../src/quota/opencode-zen');
const { renderQuotaBar } = require('../src/quota/quota-bar-view');
const { resolveQuotaBar } = require('../public/quota-bar-view');

const GO_KEY = 'sk-go-test-key';
const NOW = Date.parse('2026-09-26T04:00:00.000Z');

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-zen-'));
  return {
    home,
    writeConfig: (value) => {
      const dir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(value, null, 2));
    },
    writeAuth: (value) => {
      const dir = path.join(home, '.local', 'share', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(value, null, 2));
    },
  };
}

const noEnv = () => ({ PATH: '/usr/bin' });

test('discovery reads the Go gateway key out of opencode.json with its base URL', () => {
  const env = tempHome();
  env.writeConfig({
    provider: {
      opencodego: {
        name: 'OpenCode Go',
        options: { apiKey: GO_KEY, baseURL: 'https://opencode.ai/zen/go/v1' },
      },
      deepseek: {
        options: { apiKey: 'sk-unrelated', baseURL: 'https://api.deepseek.com/v1' },
      },
    },
  });
  const found = discoverZenCredentials({ home: env.home, env: noEnv() });
  assert.equal(found.length, 1);
  assert.equal(found[0].apiKey, GO_KEY);
  assert.equal(found[0].baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(found[0].source, 'opencode.json:opencodego');
});

test('discovery accepts a Zen-named provider that declares no base URL', () => {
  const env = tempHome();
  env.writeConfig({ provider: { opencode: { options: { apiKey: GO_KEY } } } });
  const found = discoverZenCredentials({ home: env.home, env: noEnv() });
  assert.deepEqual(found.map((c) => c.baseUrl), [null]);
});

test('discovery reads both api and oauth credentials from auth.json, zen ids only', () => {
  const env = tempHome();
  env.writeAuth({
    opencode: { type: 'oauth', access: 'oauth-access', refresh: 'r', expiry: NOW + 1000 },
    'opencode-go': { type: 'api', key: { apiKey: GO_KEY } },
    openrouter: { type: 'api', key: { apiKey: 'sk-router' } },
  });
  const found = discoverZenCredentials({ home: env.home, env: noEnv() });
  assert.deepEqual(found.map((c) => c.apiKey), ['oauth-access', GO_KEY]);
  assert.deepEqual(found.map((c) => c.source), ['auth.json:opencode', 'auth.json:opencode-go']);
});

test('auth.json wins over opencode.json, and the env override wins over both', () => {
  const env = tempHome();
  env.writeAuth({ opencode: { type: 'api', key: { apiKey: 'sk-from-auth' } } });
  env.writeConfig({
    provider: { opencodego: { options: { apiKey: GO_KEY, baseURL: 'https://opencode.ai/zen/go/v1' } } },
  });
  const both = discoverZenCredentials({ home: env.home, env: noEnv() });
  assert.deepEqual(both.map((c) => c.apiKey), ['sk-from-auth', GO_KEY]);

  const overridden = discoverZenCredentials({
    home: env.home,
    env: { ...noEnv(), OPENCODE_ZEN_API_KEY: 'sk-from-env', OPENCODE_ZEN_BASE_URL: 'https://example.test/zen/go/v1' },
  });
  assert.equal(overridden[0].apiKey, 'sk-from-env');
  assert.equal(overridden[0].baseUrl, 'https://example.test/zen/go/v1');
  assert.equal(overridden[0].source, 'env');
});

test('discovery finds nothing when OpenCode has no official subscription', () => {
  const env = tempHome();
  env.writeConfig({ provider: { openrouter: { options: { apiKey: 'sk-router' } } } });
  assert.deepEqual(discoverZenCredentials({ home: env.home, env: noEnv() }), []);
});

test('usageUrlsFor tries the credential base first, then the default, deduped', () => {
  assert.deepEqual(usageUrlsFor({ baseUrl: 'https://opencode.ai/zen/go/v1/' }), [
    'https://opencode.ai/zen/go/v1/usage',
  ]);
  assert.deepEqual(usageUrlsFor({ baseUrl: 'https://example.test/zen/go/v1' }), [
    'https://example.test/zen/go/v1/usage',
    `${DEFAULT_ZEN_BASE_URL}/usage`,
  ]);
  assert.deepEqual(usageUrlsFor({ baseUrl: null }), [`${DEFAULT_ZEN_BASE_URL}/usage`]);
});

test('normalizeUsage converts percent/resetsAt into the bar renderer window shape', () => {
  const usage = normalizeUsage({
    usage: {
      rolling: { status: 'ok', percent: 19, resetsAt: '2026-09-26T09:00:00.000Z' },
      weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-28T00:00:00.000Z' },
      monthly: null,
    },
  }, NOW);
  assert.equal(usage.rolling.usagePercent, 19);
  assert.equal(usage.rolling.resetInSec, 5 * 3600);
  assert.equal(usage.weekly.status, 'rate-limited');
  assert.equal(usage.monthly, null);
  assert.equal(usage.useBalance, null);
});

test('normalizeUsage keeps a window without a parseable resetsAt and rejects an empty payload', () => {
  const usage = normalizeUsage({ usage: { rolling: { status: 'ok', percent: 3 } } }, NOW);
  assert.deepEqual(usage.rolling, { status: 'ok', usagePercent: 3, resetInSec: null, resetsAt: null });
  assert.equal(normalizeUsage({ usage: {} }, NOW), null);
  assert.equal(normalizeUsage(null, NOW), null);
});

test('fetchZenGoUsage returns null with no credential so the caller can scrape instead', async () => {
  const result = await fetchZenGoUsage({ credentials: [], now: NOW });
  assert.equal(result, null);
});

test('fetchZenGoUsage queries the gateway with the key and maps an ok response', async () => {
  const calls = [];
  const result = await fetchZenGoUsage({
    now: NOW,
    credentials: [{ apiKey: GO_KEY, baseUrl: 'https://opencode.ai/zen/go/v1', source: 'test' }],
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          usage: {
            rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-26T09:00:00.000Z' },
            weekly: { status: 'ok', percent: 40, resetsAt: '2026-09-28T00:00:00.000Z' },
            monthly: { status: 'ok', percent: 7, resetsAt: '2026-09-30T00:00:00.000Z' },
          },
        }),
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_ZEN_BASE_URL}/usage`);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${GO_KEY}`);
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'zen-api:test');
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.usage.rolling.resetInSec, 5 * 3600);
  assert.equal(result.usage.weekly.usagePercent, 40);
});

test('fetchZenGoUsage falls through to the default base when the credential base 404s', async () => {
  const urls = [];
  const result = await fetchZenGoUsage({
    now: NOW,
    credentials: [{ apiKey: GO_KEY, baseUrl: 'https://example.test/zen/go/v1', source: 'test' }],
    fetch: async (url) => {
      urls.push(url);
      if (url.startsWith('https://example.test')) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ usage: { monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-30T00:00:00.000Z' } } }),
      };
    },
  });
  assert.deepEqual(urls, ['https://example.test/zen/go/v1/usage', `${DEFAULT_ZEN_BASE_URL}/usage`]);
  assert.equal(result.status, 'ok');
  assert.equal(result.usage.monthly.usagePercent, 1);
});

test('fetchZenGoUsage reports no_auth with the endpoint diagnosis when every key is rejected', async () => {
  const result = await fetchZenGoUsage({
    now: NOW,
    credentials: [{ apiKey: 'sk-dead', baseUrl: null, source: 'auth.json:opencode' }],
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(result.status, 'no_auth');
  assert.match(result.error, /401/);
  assert.match(result.error, /重新生成/);
});

test('the bar names the Zen API as its source and renders the three windows', () => {
  const dto = {
    status: 'ok',
    source: 'zen-api:opencode.json:opencodego',
    fetchedAt: NOW,
    usage: normalizeUsage({
      usage: {
        rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-26T09:00:00.000Z' },
        weekly: { status: 'ok', percent: 40, resetsAt: '2026-09-28T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 7, resetsAt: '2026-09-30T00:00:00.000Z' },
      },
    }, NOW),
  };
  const bar = renderQuotaBar('opencode', dto);
  assert.match(bar.title, /Zen API \/zen\/go\/v1\/usage/);
  assert.match(bar.title, /5h: 0%/);
  assert.match(bar.title, /周: 40%/);
  assert.match(bar.title, /月: 7%/);
  const resolved = resolveQuotaBar(bar, { now: NOW });
  assert.match(resolved.text, /^OpenCode Go · /);
  assert.equal(resolved.action, null);
});

test('the bar reports a rejected subscription key in red, without a dead-end action', () => {
  const bar = renderQuotaBar('opencode', { status: 'no_auth', error: 'key 被拒（401）' });
  assert.match(bar.text, /订阅 key 失效/);
  assert.equal(bar.color, '#f85149');
  assert.equal(bar.action, null);
  assert.match(bar.title, /401/);
});
