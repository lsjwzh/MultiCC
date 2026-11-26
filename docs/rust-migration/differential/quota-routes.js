'use strict';
// Differential run for the twenty-two quota & pricing routes retired from nine
// Node modules:
//
//   GET|HEAD /api/pricing/status   GET|HEAD /api/pricing/lookup
//   POST     /api/pricing/refresh  GET|HEAD /api/pricing/search
//   GET|HEAD /api/opencode/quota   POST     /api/opencode/quota/login
//   GET|HEAD /api/qoder/quota      POST     /api/qoder/quota/login
//   GET|HEAD /api/qoder/quota/cookies
//   GET|HEAD /api/codex/quota
//   GET|HEAD /api/ark/quota        POST     /api/ark/quota/login
//   POST     /api/ark/quota/install
//   GET|HEAD /api/kimi/quota       POST     /api/kimi/quota/login
//   GET|HEAD /api/claude/quota     POST     /api/claude/quota/login
//   GET|HEAD /api/aliyun/quota     POST     /api/aliyun/quota/login
//   GET|HEAD /api/quota/bars/idle  GET|HEAD /api/quota/bars/state
//   POST     /api/quota/bars/refresh
//
// now answered by native/gateway/src/app/quota_routes.rs (rules in
// native/core/src/quota_routes.rs, bars via native/core/src/quota_bar_view.rs).
//
//   node docs/rust-migration/differential/quota-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-quota-routes.js) over the scripted world in
// tests/helpers/quota-scripted-world.js; the Rust front door calls its host
// port (/api/__host/quota), and the stub Node child here is the real
// src/routes/quota-host.js composition over the same world. So the comparison
// covers the split itself: what stayed in Node (the models.dev price table,
// the nine console fetchers, the managed-profile login window, the codex auth
// files, the arkcli subprocess/installer, the quota-bar cache, the Claude
// usage queue and its live 5h map, the two recorders) must feed the front door
// exactly the facts the retired handlers used.
//
// The one clock is `world.clock`: it feeds the host port's `now()`, the Claude
// usage queue's one-minute floor and the bar cache's stamps, so the
// first-read / fresh-hit / expired-refetch sequence is byte-comparable. The
// two process-local stores are the production modules, not re-modelled.
//
// Side effects are compared per case: the price table's arguments, every
// fetcher's arguments (the selectors the front door passed), the
// recordVendor/recordClaude payloads, the cache keys and the login URLs. A
// route that answers the same bytes but asks Node for the wrong thing — or
// twice — fails.
//
// No corpus case is expected to differ. The host port being down
// (503 rust_backend_unavailable) has no Node-side twin; it is covered by
// native/gateway/tests/quota_routes.rs and docs/gateway.md §9.
const fs = require('fs');
const path = require('path');
const { main, send, TOKEN } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const T0 = 1700000000000;
// Far enough from the wall clock on both sides that `reading()`'s
// `at > now` branch (which folds a window with a passed deadline into
// "estimated") takes the same side in Node and in Rust.
const FUTURE = 4102444800000;
const FUTURE_SEC = 4102444800;

let worldPath = '';
let effectsPath = '';
let bag = null;
const caseNames = new Map();
let legacy = null;
let upstreamText = '';
const nodeEffects = new Map();
const capturedEtags = new Map();
const priorByCase = new Map();
let lastCase = null;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function priorEtag(tag) {
  return capturedEtags.get(priorByCase.get(tag)) || 'W/"none"';
}

// ── the scripted facts ─────────────────────────────────────────────────────
//
// Every result below is a plausible console DTO with its deadlines far in the
// future, so the rendered bar text carries a `{cd:…}` placeholder instead of a
// number that would move with the wall clock.

const PRICE_STATUS = { loaded: true, entries: 3, fetchedAt: T0 - 60000 };
const PRICES = {
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, updatedAt: T0 - 60000 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, updatedAt: T0 - 60000 },
};
const SEARCH = {
  claude: [
    { id: 'claude-sonnet-4-5', provider: 'anthropic', input: 3 },
    { id: 'claude-opus-4-1', provider: 'anthropic', input: 15 },
  ],
};

const OPENCODE_OK = {
  status: 'ok',
  fetchedAt: T0 - 5000,
  workspaceId: 'ws-1',
  url: 'https://opencode.ai/workspace/ws-1/go',
  source: 'zen-api',
  usage: {
    rolling: { status: 'ok', resetInSec: FUTURE_SEC, usagePercent: 21 },
    weekly: { status: 'ok', resetInSec: FUTURE_SEC, usagePercent: 33 },
    monthly: { status: 'rate-limited', resetInSec: FUTURE_SEC, usagePercent: 100 },
    useBalance: false,
  },
};

const QODER_OK = {
  status: 'ok',
  fetchedAt: T0 - 5000,
  quota: {
    total_quota: { quota_summary: { used_value: 40, limit_value: 200, remaining_value: 160, usage_percentage: 20 } },
    plan_quota: { quota_summary: { used_value: 5, limit_value: 50, remaining_value: 45, usage_percentage: 10 } },
    resource_package_quota: { quota_summary: { used_value: 0, limit_value: 0, remaining_value: 0, usage_percentage: 0 } },
  },
};

const CODEX_OK = {
  status: 'ok',
  fetchedAt: T0 - 5000,
  planType: 'plus',
  email: 'user@example.test',
  limitReached: false,
  windows: [
    { window: '5h', usedPercent: 42, remainingPercent: 58, windowSeconds: 18000, resetsAt: FUTURE_SEC },
    { window: '1wk', usedPercent: 12, remainingPercent: 88, windowSeconds: 604800, resetsAt: FUTURE_SEC },
  ],
  weekly: { usedPercent: 12, remainingPercent: 88, windowSeconds: 604800, resetsAt: FUTURE_SEC },
  additional: [],
  credits: null,
};

const ARK_OK = {
  status: 'ok',
  fetchedAt: T0 - 5000,
  viewer: { id: 'viewer-1' },
  items: [
    {
      product: 'coding-plan',
      tier: 'pro',
      subscribed: true,
      periods: [
        { label: 'weekly', percent: 24, used: 12, total: 50, resetAt: FUTURE },
        { label: 'session', percent: 8, resetAt: FUTURE },
      ],
    },
  ],
};

const KIMI_OK = {
  status: 'ok',
  fetchedAt: T0 - 5000,
  sites: [
    { site: 'Moonshot', host: 'api.moonshot.cn', ok: true, available: 12.5, currency: 'CNY', voucher: 2, cash: 10.5 },
  ],
};

const ALIYUN_OK = {
  status: 'ok',
  fetchedAt: T0 - 5000,
  source: 'console',
  summary: [{ window: 'monthly', usedPercent: 18, text: '本月已用 18%' }],
  account: { id: 'aliyun-1', label: 'Aliyun' },
};

const CLAUDE_OK = {
  status: 'ok',
  fetchedAt: T0 - 1000,
  source: 'oauth',
  url: 'https://api.anthropic.com/api/oauth/usage',
  account: { id: 'acct-1', label: 'Claude', email: 'user@example.test' },
  summary: [
    { window: '1wk', label: 'All models', usedPercent: 30, resetMs: FUTURE },
    { window: '1m', label: 'Opus', usedPercent: 55, resetMs: FUTURE },
  ],
  usage: { five_hour: { utilization: 0.2 } },
};

const CLAUDE_ESTIMATED = {
  status: 'ok',
  fetchedAt: T0 - 1000,
  source: 'oauth',
  summary: [{ window: '1wk', label: 'All models', usedPercent: 30, resetMs: T0 - 1000 }],
};

function baseWorld(tag) {
  return {
    case: tag,
    clock: T0,
    price: {
      status: clone(PRICE_STATUS),
      prices: clone(PRICES),
      search: clone(SEARCH),
      refresh: { loaded: true, entries: 3, fetchedAt: T0 },
    },
    fetch: {},
    cookies: null,
    accounts: { files: { 'acct-1': '/home/user/.multicc/accounts/acct-1/auth.json' } },
    arkcli: { bin: { cmd: '/usr/local/bin/arkcli', prefix: [] }, spawn: { pid: 7788 }, install: { ok: true } },
    login: {},
    cache: true,
    resetState: true,
  };
}

function worldFor(tag, fetch = {}, extra = {}) {
  const world = baseWorld(tag);
  world.fetch = fetch;
  return { ...world, ...extra };
}

// ── corpus plumbing ────────────────────────────────────────────────────────

let counter = 0;
const pending = [];

function useScenario(scenario) {
  return {
    before(side) {
      if (side.name === 'node') bag.apply(scenario);
      else fs.writeFileSync(worldPath, JSON.stringify(scenario));
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      nodeEffects.set(scenario.case, clone(bag.effects.calls));
      bag.effects.calls.length = 0;
      if (response.headers && response.headers.etag) capturedEtags.set(scenario.case, response.headers.etag);
    },
  };
}

function add(name, buildRequest, buildWorld, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  priorByCase.set(tag, lastCase);
  lastCase = tag;
  const scenario = buildWorld ? buildWorld(tag) : baseWorld(tag);
  scenario.case = tag;
  caseNames.set(tag, name);
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) hooks[hook] = fn;
  pending.push([name, () => buildRequest(tag), hooks]);
}

// ── corpus ─────────────────────────────────────────────────────────────────

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  const post = (url, body, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  // ── Express automatic OPTIONS: the Allow list of every migrated path ────
  const optionPaths = [
    '/api/pricing/status', '/api/pricing/lookup', '/api/pricing/refresh', '/api/pricing/search',
    '/api/opencode/quota', '/api/opencode/quota/login',
    '/api/qoder/quota', '/api/qoder/quota/login', '/api/qoder/quota/cookies',
    '/api/codex/quota',
    '/api/ark/quota', '/api/ark/quota/login', '/api/ark/quota/install',
    '/api/kimi/quota', '/api/kimi/quota/login',
    '/api/claude/quota', '/api/claude/quota/login',
    '/api/aliyun/quota', '/api/aliyun/quota/login',
    '/api/quota/bars/idle', '/api/quota/bars/state', '/api/quota/bars/refresh',
  ];
  for (const url of optionPaths) add(`OPTIONS ${url}`, () => options(url), tag => baseWorld(tag));

  // ── /api/pricing/* ─────────────────────────────────────────────────────
  add('HEAD pricing status', () => head('/api/pricing/status'), tag => baseWorld(tag));
  add('GET pricing status', () => get('/api/pricing/status'), tag => baseWorld(tag));
  add('GET pricing status if-none-match star', () => get('/api/pricing/status', { ...L, 'If-None-Match': '*' }), tag => baseWorld(tag));
  add('GET pricing status conditional', tag => get('/api/pricing/status', { ...L, 'If-None-Match': priorEtag(tag) }), tag => baseWorld(tag));
  add('GET pricing status gzip', () => get('/api/pricing/status', { ...L, 'Accept-Encoding': 'gzip, deflate' }), tag => baseWorld(tag));
  add('GET pricing lookup trims and dedupes ids',
    () => get('/api/pricing/lookup?models=%20claude-sonnet-4-5%20,,gpt-5-codex,claude-sonnet-4-5,unknown-model'),
    tag => baseWorld(tag));
  add('GET pricing lookup without models', () => get('/api/pricing/lookup'), tag => baseWorld(tag));
  add('GET pricing lookup with an empty list', () => get('/api/pricing/lookup?models='), tag => baseWorld(tag));
  add('GET pricing lookup over the cap',
    () => get(`/api/pricing/lookup?models=${Array.from({ length: 51 }, (_, i) => `m${i}`).join(',')}`),
    tag => baseWorld(tag));
  add('GET pricing lookup with an over-long id',
    () => get(`/api/pricing/lookup?models=${'x'.repeat(101)}`), tag => baseWorld(tag));
  add('GET pricing lookup counted in utf16 units',
    () => get(`/api/pricing/lookup?models=${encodeURIComponent('额'.repeat(101))}`), tag => baseWorld(tag));
  add('POST pricing refresh conditional', () => post('/api/pricing/refresh'), tag => baseWorld(tag));
  add('POST pricing refresh with query force',
    () => post('/api/pricing/refresh?force=1'), tag => baseWorld(tag));
  add('POST pricing refresh with body force',
    () => post('/api/pricing/refresh', { force: true }), tag => baseWorld(tag));
  add('POST pricing refresh with body force string',
    () => post('/api/pricing/refresh', { force: 'true' }), tag => baseWorld(tag));
  add('POST pricing refresh with a zero force',
    () => post('/api/pricing/refresh?force=0'), tag => baseWorld(tag));
  add('POST pricing refresh when the table throws',
    () => post('/api/pricing/refresh?force=1'),
    (tag) => {
      const world = baseWorld(tag);
      world.price.refresh = { throw: 'models.dev is unreachable' };
      return world;
    });
  add('GET pricing search with a cap',
    () => get('/api/pricing/search?q=claude&limit=3'), tag => baseWorld(tag));
  add('GET pricing search without a query',
    () => get('/api/pricing/search?limit=5'), tag => baseWorld(tag));
  add('GET pricing search caps a large limit',
    () => get('/api/pricing/search?q=claude&limit=100'), tag => baseWorld(tag));
  add('GET pricing search defaults an unparsable limit',
    () => get('/api/pricing/search?q=claude&limit=abc'), tag => baseWorld(tag));
  add('GET pricing search trims the query',
    () => get('/api/pricing/search?q=%20%20claude%20%20'), tag => baseWorld(tag));

  // ── /api/opencode/quota ────────────────────────────────────────────────
  add('GET opencode quota ok', () => get('/api/opencode/quota'),
    tag => worldFor(tag, { opencode: { value: clone(OPENCODE_OK) } }));
  add('HEAD opencode quota ok', () => head('/api/opencode/quota'),
    tag => worldFor(tag, { opencode: { value: clone(OPENCODE_OK) } }));
  add('GET opencode quota needs login', () => get('/api/opencode/quota'),
    tag => worldFor(tag, { opencode: { value: { status: 'needs_login', error: 'opencode.ai login required in this Chrome' } } }));
  add('GET opencode quota no auth', () => get('/api/opencode/quota'),
    tag => worldFor(tag, { opencode: { value: { status: 'no_auth', error: 'zen key rejected' } } }));
  add('GET opencode quota without a browser', () => get('/api/opencode/quota'),
    tag => worldFor(tag, { opencode: { value: { status: 'chrome_unavailable', error: '托管浏览器启动失败' } } }));
  add('GET opencode quota unavailable', () => get('/api/opencode/quota'),
    tag => worldFor(tag, { opencode: { value: { status: 'unavailable', error: 'script tags missing' } } }));
  add('GET opencode quota when the fetcher throws', () => get('/api/opencode/quota'),
    tag => worldFor(tag, { opencode: { throw: 'cdp exploded' } }));
  add('POST opencode login opens a window', () => post('/api/opencode/quota/login'),
    tag => baseWorld(tag));
  add('POST opencode login without a browser', () => post('/api/opencode/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.login = { fail: { code: 'chrome_unavailable', message: '没有可连的 Chrome' } };
      return world;
    });
  add('POST opencode login fails generically', () => post('/api/opencode/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.login = { fail: { message: 'profile is locked' } };
      return world;
    });

  // ── /api/qoder/quota ───────────────────────────────────────────────────
  add('GET qoder quota ok', () => get('/api/qoder/quota'),
    tag => worldFor(tag, { qoder: { value: clone(QODER_OK) } }));
  add('GET qoder quota needs login', () => get('/api/qoder/quota'),
    tag => worldFor(tag, { qoder: { value: { status: 'needs_login', error: 'qoder login required' } } }));
  add('GET qoder quota without a browser', () => get('/api/qoder/quota'),
    tag => worldFor(tag, { qoder: { value: { status: 'chrome_unavailable', error: 'no chrome' } } }));
  add('GET qoder quota unavailable', () => get('/api/qoder/quota'),
    tag => worldFor(tag, { qoder: { value: { status: 'unavailable', error: 'quota panel missing' } } }));
  add('GET qoder quota when the fetcher throws', () => get('/api/qoder/quota'),
    tag => worldFor(tag, { qoder: { throw: 'page detached' } }));
  add('POST qoder login opens a window', () => post('/api/qoder/quota/login'), tag => baseWorld(tag));
  add('POST qoder login fails generically', () => post('/api/qoder/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.login = { fail: { message: 'spawn EAGAIN' } };
      return world;
    });
  add('GET qoder cookies when saved', () => get('/api/qoder/quota/cookies'),
    (tag) => {
      const world = baseWorld(tag);
      world.cookies = { cookieHeader: 'sid=1; uid=2', savedAt: T0 - 1000, account: { id: 'q1' } };
      return world;
    });
  add('GET qoder cookies when missing', () => get('/api/qoder/quota/cookies'), tag => baseWorld(tag));
  add('GET qoder cookies with a null store', () => get('/api/qoder/quota/cookies'),
    (tag) => {
      const world = baseWorld(tag);
      world.cookies = null;
      return world;
    });

  // ── /api/codex/quota ───────────────────────────────────────────────────
  add('GET codex quota ok', () => get('/api/codex/quota'),
    tag => worldFor(tag, { codex: { value: clone(CODEX_OK) } }));
  add('GET codex quota builds the official usage request', () => get('/api/codex/quota?account=fixture-account'),
    tag => worldFor(tag, {}, { codexWire: true }));
  add('GET codex quota no auth', () => get('/api/codex/quota'),
    tag => worldFor(tag, { codex: { value: { status: 'no_auth', error: '未找到 ~/.codex/auth.json，请先登录 codex' } } }));
  add('GET codex quota unavailable', () => get('/api/codex/quota'),
    tag => worldFor(tag, { codex: { value: { status: 'unavailable', error: 'rate_limit missing' } } }));
  add('GET codex quota when the fetcher throws', () => get('/api/codex/quota'),
    tag => worldFor(tag, { codex: { throw: 'fetch failed' } }));
  add('GET codex quota for an official account', () => get('/api/codex/quota?account=acct-1'),
    tag => worldFor(tag, { codex: { value: clone(CODEX_OK) } }));
  add('GET codex quota for an unknown account', () => get('/api/codex/quota?account=acct-9'),
    tag => worldFor(tag, { codex: { value: clone(CODEX_OK) } }));
  add('GET codex quota when accounts are disabled', () => get('/api/codex/quota?account=acct-1'),
    (tag) => {
      const world = worldFor(tag, { codex: { value: clone(CODEX_OK) } });
      world.accounts = { enabled: false };
      return world;
    });
  add('GET codex quota trims the account id', () => get('/api/codex/quota?account=%20acct-1%20'),
    tag => worldFor(tag, { codex: { value: clone(CODEX_OK) } }));

  // ── /api/ark/quota ─────────────────────────────────────────────────────
  add('GET ark quota ok', () => get('/api/ark/quota'),
    tag => worldFor(tag, { ark: { value: clone(ARK_OK) } }));
  add('GET ark quota with a plan base url', () => get('/api/ark/quota?baseUrl=https://ark.cn-beijing.volces.com/api/v3/plan'),
    tag => worldFor(tag, { ark: { value: clone(ARK_OK) } }));
  add('GET ark quota needs auth', () => get('/api/ark/quota'),
    tag => worldFor(tag, { ark: { value: { status: 'needs_auth', error: '需要先运行 arkcli auth login 登录火山账号后再查询' } } }));
  add('GET ark quota needs install', () => get('/api/ark/quota'),
    tag => worldFor(tag, { ark: { value: { status: 'needs_install', error: 'arkcli not found on PATH' } } }));
  add('GET ark quota unavailable', () => get('/api/ark/quota'),
    tag => worldFor(tag, { ark: { value: { status: 'unavailable', error: 'items missing' } } }));
  add('GET ark quota when the fetcher throws, keeping the raw base url',
    () => get('/api/ark/quota?baseUrl=https://ark.example.test/coding&baseUrl=x'),
    tag => worldFor(tag, { ark: { throw: 'arkcli timed out' } }));
  add('POST ark login when arkcli is missing', () => post('/api/ark/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.arkcli = { bin: null, spawn: { pid: 1 }, install: { ok: true } };
      return world;
    });
  add('POST ark login starts the sso flow', () => post('/api/ark/quota/login'), tag => baseWorld(tag));
  add('POST ark login when spawn throws', () => post('/api/ark/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.arkcli.spawn = { throw: 'EACCES: permission denied' };
      return world;
    });
  add('POST ark login when the locator throws', () => post('/api/ark/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.arkcli.resolveThrows = 'PATH is not a string';
      return world;
    });
  add('POST ark install succeeds', () => post('/api/ark/quota/install'), tag => baseWorld(tag));
  add('POST ark install reports a failure', () => post('/api/ark/quota/install'),
    (tag) => {
      const world = baseWorld(tag);
      world.arkcli.install = { ok: false, error: 'npm exit 1' };
      return world;
    });
  add('POST ark install without an error message', () => post('/api/ark/quota/install'),
    (tag) => {
      const world = baseWorld(tag);
      world.arkcli.install = { ok: false };
      return world;
    });
  add('POST ark install when the installer throws', () => post('/api/ark/quota/install'),
    (tag) => {
      const world = baseWorld(tag);
      world.arkcli.install = { throw: 'npm not found' };
      return world;
    });

  // ── /api/kimi/quota ────────────────────────────────────────────────────
  add('GET kimi quota ok', () => get('/api/kimi/quota'),
    tag => worldFor(tag, { kimi: { value: clone(KIMI_OK) } }));
  add('GET kimi quota with a host selector', () => get('/api/kimi/quota?host=API.moonshot.cn'),
    tag => worldFor(tag, { kimi: { value: clone(KIMI_OK) } }));
  add('GET kimi quota not configured', () => get('/api/kimi/quota'),
    tag => worldFor(tag, { kimi: { value: { status: 'not_configured', error: 'no kimi key' } } }));
  add('GET kimi quota needs login', () => get('/api/kimi/quota'),
    tag => worldFor(tag, { kimi: { value: { status: 'needs_login', error: 'kimi.com login required' } } }));
  add('GET kimi quota without a browser', () => get('/api/kimi/quota'),
    tag => worldFor(tag, { kimi: { value: { status: 'chrome_unavailable', error: 'no chrome' } } }));
  add('GET kimi quota unavailable', () => get('/api/kimi/quota'),
    tag => worldFor(tag, { kimi: { value: { status: 'unavailable', error: 'all kimi fetches failed' } } }));
  add('GET kimi quota when the fetcher throws after a real balance', () => get('/api/kimi/quota?host=x.test'),
    tag => worldFor(tag, { kimi: { throw: 'balance api dumped' } }));
  add('POST kimi login opens a window', () => post('/api/kimi/quota/login'), tag => baseWorld(tag));
  add('POST kimi login without a browser', () => post('/api/kimi/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.login = { fail: { code: 'chrome_unavailable', message: 'no chrome' } };
      return world;
    });

  // ── /api/claude/quota ──────────────────────────────────────────────────
  add('GET claude quota with no reading', () => get('/api/claude/quota'), tag => baseWorld(tag));
  add('GET claude quota with a seeded reading', () => get('/api/claude/quota?session=chat-1'),
    (tag) => {
      const world = baseWorld(tag);
      world.claude = { session: 'chat-1', seed: clone(CLAUDE_OK) };
      return world;
    });
  add('GET claude quota merges the live window', () => get('/api/claude/quota?session=chat-1'),
    (tag) => {
      const world = baseWorld(tag);
      world.claude = { session: 'chat-1', seed: clone(CLAUDE_OK) };
      world.claudeLive = {
        session: 'chat-1',
        info: {
          rateLimitType: 'five_hour',
          status: 'allowed',
          utilization: 0.42,
          resetsAt: FUTURE_SEC,
          windows: [{ window: '5h', usedPercent: 42, resetMs: FUTURE }],
        },
      };
      return world;
    });
  add('GET claude quota keeps the estimated marker for a passed deadline', () => get('/api/claude/quota?session=chat-1'),
    (tag) => {
      const world = baseWorld(tag);
      world.claude = { session: 'chat-1', seed: clone(CLAUDE_ESTIMATED) };
      return world;
    });
  add('GET claude quota with force inside the minute reads the cache', () => get('/api/claude/quota?session=chat-1&force=1'),
    (tag) => {
      const world = baseWorld(tag);
      world.clock = T0 + 1000;
      world.claude = { session: 'chat-1', seed: clone(CLAUDE_OK) };
      return world;
    });
  add('GET claude quota with force past the minute refetches', () => get('/api/claude/quota?session=chat-1&force=1'),
    (tag) => {
      const world = worldFor(tag, { claude: { value: clone(CLAUDE_OK) } });
      world.clock = T0 + 61000;
      world.resetState = false;
      return world;
    });
  add('GET claude quota shares one scrape between two callers', () => get('/api/claude/quota?session=chat-1&force=1'),
    (tag) => {
      const world = worldFor(tag, { claude: { value: clone(CLAUDE_OK) } });
      world.clock = T0 + 62000;
      world.resetState = false;
      world.prewarmClaude = 'chat-1';
      return world;
    });
  add('GET claude quota honours the true spelling of force', () => get('/api/claude/quota?session=chat-1&force=true'),
    (tag) => {
      const world = worldFor(tag, { claude: { value: clone(CLAUDE_OK) } });
      world.clock = T0 + 63000;
      world.resetState = false;
      return world;
    });
  add('GET claude quota ignores a non-string session', () => get('/api/claude/quota?session=a&session=b'),
    tag => baseWorld(tag));
  add('GET claude quota unavailable', () => get('/api/claude/quota?session=chat-2&force=1'),
    tag => worldFor(tag, { claude: { value: { status: 'chrome_unavailable', error: 'no chrome' } } }));
  add('GET claude quota needs login', () => get('/api/claude/quota?session=chat-3&force=1'),
    tag => worldFor(tag, { claude: { value: { status: 'needs_login', error: 'claude.ai login required' } } }));
  add('POST claude login opens a window', () => post('/api/claude/quota/login'), tag => baseWorld(tag));
  add('POST claude login fails generically', () => post('/api/claude/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.login = { fail: { message: 'window closed' } };
      return world;
    });

  // ── /api/aliyun/quota ──────────────────────────────────────────────────
  add('GET aliyun quota ok', () => get('/api/aliyun/quota'),
    tag => worldFor(tag, { aliyun: { value: clone(ALIYUN_OK) } }));
  add('GET aliyun quota needs login', () => get('/api/aliyun/quota'),
    tag => worldFor(tag, { aliyun: { value: { status: 'needs_login', error: 'aliyun login required' } } }));
  add('GET aliyun quota without a browser', () => get('/api/aliyun/quota'),
    tag => worldFor(tag, { aliyun: { value: { status: 'chrome_unavailable', error: 'no chrome' } } }));
  add('GET aliyun quota unavailable', () => get('/api/aliyun/quota'),
    tag => worldFor(tag, { aliyun: { value: { status: 'unavailable', error: 'console panel missing' } } }));
  add('GET aliyun quota when the fetcher throws', () => get('/api/aliyun/quota'),
    tag => worldFor(tag, { aliyun: { throw: 'cdp exploded' } }));
  add('POST aliyun login opens a window', () => post('/api/aliyun/quota/login'), tag => baseWorld(tag));
  add('POST aliyun login without a browser', () => post('/api/aliyun/quota/login'),
    (tag) => {
      const world = baseWorld(tag);
      world.login = { fail: { code: 'chrome_unavailable', message: 'no chrome' } };
      return world;
    });

  // ── /api/quota/bars/* ──────────────────────────────────────────────────
  add('HEAD quota bars idle', () => head('/api/quota/bars/idle'), tag => baseWorld(tag));
  add('GET quota bars idle', () => get('/api/quota/bars/idle'), tag => baseWorld(tag));
  add('GET quota bars idle conditional',
    tag => get('/api/quota/bars/idle', { ...L, 'If-None-Match': priorEtag(tag) }), tag => baseWorld(tag));
  add('GET quota bars idle gzip',
    () => get('/api/quota/bars/idle', { ...L, 'Accept-Encoding': 'gzip, deflate' }), tag => baseWorld(tag));
  add('GET quota bars state is empty before anything is cached',
    () => get('/api/quota/bars/state?kind=codex&session=s1'), tag => baseWorld(tag));
  add('GET quota bars state with the cache disabled',
    () => get('/api/quota/bars/state?session=s1'),
    (tag) => {
      const world = baseWorld(tag);
      world.cache = false;
      return world;
    });
  add('POST quota bars refresh rejects an unknown kind',
    () => post('/api/quota/bars/refresh', { kind: 'nope' }), tag => baseWorld(tag));
  add('POST quota bars refresh rejects a missing kind',
    () => post('/api/quota/bars/refresh', {}), tag => baseWorld(tag));
  add('POST quota bars refresh records a first opencode reading',
    () => post('/api/quota/bars/refresh', { kind: 'opencode' }),
    tag => worldFor(tag, { opencode: { value: clone(OPENCODE_OK) } }));
  add('GET quota bars state after the first reading',
    () => get('/api/quota/bars/state?session=s1'), tag => baseWorld(tag));
  add('POST quota bars refresh hits the cached bar',
    () => post('/api/quota/bars/refresh', { kind: 'opencode' }),
    (tag) => {
      const world = worldFor(tag, { opencode: { value: { status: 'unavailable', error: 'console changed' } } });
      world.resetState = false;
      world.clock = T0 + 1000;
      return world;
    });
  add('GET quota bars state keeps the last good bar beside the error',
    () => get('/api/quota/bars/state?session=s1'), tag => baseWorld(tag));
  add('POST quota bars refresh qoder from the query string',
    () => post('/api/quota/bars/refresh?kind=QODER'),
    tag => worldFor(tag, { qoder: { value: clone(QODER_OK) } }));
  add('POST quota bars refresh codex with a stale tail',
    () => post('/api/quota/bars/refresh', { kind: 'codex' }),
    tag => worldFor(tag, { codex: { value: clone(CODEX_OK) } }));
  add('POST quota bars refresh ark keeps the plan selector',
    () => post('/api/quota/bars/refresh', { kind: 'ark', baseUrl: 'https://ark.example.test/api/v3/coding' }),
    tag => worldFor(tag, { ark: { value: clone(ARK_OK) } }));
  add('POST quota bars refresh kimi lowercases the host',
    () => post('/api/quota/bars/refresh', { kind: 'kimi', host: 'API.Moonshot.CN' }),
    tag => worldFor(tag, { kimi: { value: clone(KIMI_OK) } }));
  add('POST quota bars refresh claude with no reading is idle, not an error',
    () => post('/api/quota/bars/refresh', { kind: 'claude', session: 'chat-9' }),
    tag => worldFor(tag, {}));
  add('POST quota bars refresh claude with force starts a scrape',
    () => post('/api/quota/bars/refresh?force=1', { kind: 'claude', session: 'chat-9' }),
    tag => worldFor(tag, { claude: { value: clone(CLAUDE_OK) } }));
  add('POST quota bars refresh claude reads the cached account after a scrape',
    () => post('/api/quota/bars/refresh', { kind: 'claude', session: 'chat-9' }),
    (tag) => {
      const world = worldFor(tag, {});
      world.clock = T0 + 1000;
      world.resetState = false;
      return world;
    });
  add('POST quota bars refresh reports a throwing vendor',
    () => post('/api/quota/bars/refresh', { kind: 'opencode' }),
    tag => worldFor(tag, { opencode: { throw: 'stream closed' } }));
  add('POST quota bars refresh keeps a failing vendor status verbatim',
    () => post('/api/quota/bars/refresh', { kind: 'kimi', host: 'api.moonshot.cn' }),
    tag => worldFor(tag, { kimi: { value: { status: 'needs_login', error: 'kimi.com login required', reason: 'auth' } } }));
  add('POST quota bars refresh sanitises an error string',
    () => post('/api/quota/bars/refresh', { kind: 'codex' }),
    tag => worldFor(tag, { codex: { value: { status: 'unavailable', error: `  bad\tgateway ${'x'.repeat(300)}` } } }));

  return pending;
}

// ── the stub Node child ────────────────────────────────────────────────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/quota-scripted-world'));
const { HOST_PATH, createQuotaRuntime } = require(path.join(REPO, 'src/routes/quota-host'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null }; }
}

const bag = world.buildDeps({ case: 'initial' }, { dataRoot: process.env.MULTICC_DATA_DIR,
  codexUsage: require(path.join(REPO, 'src/routes/codex-quota')).fetchCodexUsage });
const runtime = createQuotaRuntime(bag.deps);
const app = express();
app.use('/api', express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  bag.apply(readWorld()).then(() => next(), next);
  res.on('finish', () => {
    const calls = bag.effects.calls.splice(0);
    if (calls.length) {
      fs.appendFileSync(effectsPath, JSON.stringify({ case: bag.world().case || null, calls }) + '\\n');
    }
  });
});
runtime.mount(app);

const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const end = buffered.indexOf('\\r\\n');
    if (end < 0) return;
    socket.removeListener('data', onData);
    socket.pause();
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket);
    socket.resume();
  };
  socket.on('data', onData);
  socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
`;
}

// ── run ────────────────────────────────────────────────────────────────────

const OPTIONS_ALLOW = {
  '/api/pricing/status': 'GET,HEAD',
  '/api/pricing/lookup': 'GET,HEAD',
  '/api/pricing/refresh': 'POST',
  '/api/pricing/search': 'GET,HEAD',
  '/api/opencode/quota': 'GET,HEAD',
  '/api/opencode/quota/login': 'POST',
  '/api/qoder/quota': 'GET,HEAD',
  '/api/qoder/quota/login': 'POST',
  '/api/qoder/quota/cookies': 'GET,HEAD',
  '/api/codex/quota': 'GET,HEAD',
  '/api/ark/quota': 'GET,HEAD',
  '/api/ark/quota/login': 'POST',
  '/api/ark/quota/install': 'POST',
  '/api/kimi/quota': 'GET,HEAD',
  '/api/kimi/quota/login': 'POST',
  '/api/claude/quota': 'GET,HEAD',
  '/api/claude/quota/login': 'POST',
  '/api/aliyun/quota': 'GET,HEAD',
  '/api/aliyun/quota/login': 'POST',
  '/api/quota/bars/idle': 'GET,HEAD',
  '/api/quota/bars/state': 'GET,HEAD',
  '/api/quota/bars/refresh': 'POST',
};

main({
  name: 'quota-routes',
  mount(app, { repo, work, dataRoot }) {
    worldPath = path.join(work, 'quota-world.json');
    effectsPath = path.join(work, 'quota-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify(baseWorld('initial')));
    const helper = require(path.join(repo, 'tests/helpers/quota-scripted-world'));
    bag = helper.buildDeps(baseWorld('initial'), { dataRoot,
      codexUsage: require(path.join(repo, 'tests/helpers/frozen-file-batch16/codex-quota')).fetchCodexUsage });
    legacy = require(path.join(repo, 'tests/helpers/legacy-quota-routes'));
    // server.js mounts pricing with the shared asyncHandler, so a rejected
    // refresh reaches safeErrorHandler exactly as it did in production. The
    // handler goes onto the same deps object the world mutates, never a copy:
    // `accounts.enabled === false` is applied by removing the member.
    const { asyncHandler } = require(path.join(repo, 'src/http-errors'));
    bag.deps.asyncHandler = asyncHandler;
    legacy.mountQuotaRoutes(app, bag.deps);
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: work,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
  }),
  async ready(port) {
    // The front door listens before the quota host. Wait for a read through both.
    for (let attempt = 0; attempt < 300; attempt++) {
      const res = await send(port, { method: 'GET', url: '/api/pricing/status',
        headers: { ...L, Authorization: 'Bearer ' + TOKEN } });
      if (res.status === 200) return;
      if (res.status !== 503) throw new Error('quota readiness returned HTTP ' + res.status);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('quota host did not become ready');
  },
  corpus,
  finalize({ work, views }) {
    fs.writeFileSync(path.join(work, 'views.json'), JSON.stringify(views, null, 2));
    const problems = [];
    const byName = new Map(views.map(view => [view.name, view]));

    // A handler that never ran would still "match" (both sides 500), so pin
    // the branches that prove the cluster works, and the coverage the brief
    // asks for: the conditional 304, the login refusals and the claude queue's
    // first-read / fresh-hit / expired-refetch sequence.
    const statuses = new Set(views.map(view => view.node.status));
    for (const wanted of [200, 304, 400, 401, 404, 500, 502, 503]) {
      if (!statuses.has(wanted)) problems.push(`no corpus case answered ${wanted}`);
    }
    const allowSeen = new Set();
    for (const [url, allow] of Object.entries(OPTIONS_ALLOW)) {
      const view = byName.get(`OPTIONS ${url}`);
      if (!view) { problems.push(`missing OPTIONS case for ${url}`); continue; }
      if (view.node.headers.allow !== allow || view.rust.headers.allow !== allow) {
        problems.push(`OPTIONS ${url}: Allow expected ${allow}, got node ${view.node.headers.allow} / rust ${view.rust.headers.allow}`);
      }
      allowSeen.add(allow);
    }
    if (!allowSeen.has('GET,HEAD')) problems.push('no path exercised a GET,HEAD Allow list');
    if (!allowSeen.has('POST')) problems.push('no path exercised a POST-only Allow list');

    const pins = [
      ['GET opencode quota ok', 200, '"text"'],
      ['GET qoder quota ok', 200, '"quota"'],
      ['GET codex quota builds the official usage request', 200, '"fixture-plan"'],
      ['GET codex quota ok', 200, '"windows"'],
      ['GET ark quota ok', 200, '"items"'],
      ['GET kimi quota ok', 200, '"available"'],
      ['GET aliyun quota ok', 200, '"summary"'],
      ['GET claude quota with a seeded reading', 200, '"summary"'],
      ['GET claude quota merges the live window', 200, '5h'],
      ['GET claude quota keeps the estimated marker for a passed deadline', 200, '"resetMs":1699999999000'],
      ['GET claude quota with no reading', 200, '"idle"'],
      ['GET pricing status', 200, '"entries"'],
      ['GET pricing lookup trims and dedupes ids', 200, '"input":3'],
      ['POST pricing refresh with query force', 200, '"ok":true'],
      ['POST pricing refresh when the table throws', 500, 'internal_error'],
      ['POST ark login when the locator throws', 500, 'internal_error'],
      ['POST ark install without an error message', 500, '"status":"error"'],
      ['POST quota bars refresh records a first opencode reading', 200, '"cached"'],
      ['POST quota bars refresh keeps a failing vendor status verbatim', 401, '"reason":"auth"'],
      ['POST quota bars refresh claude with no reading is idle, not an error', 200, '"idle"'],
      ['GET pricing status conditional', 304, ''],
      ['GET quota bars idle conditional', 304, ''],
      ['POST opencode login without a browser', 503, 'chrome_unavailable'],
      ['POST kimi login without a browser', 503, 'chrome_unavailable'],
    ];
    for (const [name, status, needle] of pins) {
      for (const side of ['node', 'rust']) {
        const view = byName.get(name);
        if (!view) { problems.push(`missing case ${name}`); continue; }
        if (view[side].status !== status) problems.push(`${name}: ${side} answered ${view[side].status}, expected ${status}`);
        if (needle && !view[side].body.includes(needle)) {
          problems.push(`${name}: ${side} body is missing ${needle}`);
        }
      }
    }

    // ── side effects ─────────────────────────────────────────────────────
    const rustEffects = new Map();
    const text = fs.readFileSync(effectsPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!rustEffects.has(entry.case)) rustEffects.set(entry.case, []);
      rustEffects.get(entry.case).push(...entry.calls);
    }
    const wireCase = [...caseNames].find(([, name]) => name === 'GET codex quota builds the official usage request');
    for (const [side, effects] of [['node', nodeEffects], ['rust', rustEffects]]) {
      const calls = (effects.get(wireCase?.[0]) || []).filter(entry => entry.op === 'codexWireFetch');
      if (calls.length !== 1 || !calls[0].valid) problems.push(side + ': expected one matching Codex usage request');
    }
    const mismatches = [];
    for (const [tag, calls] of nodeEffects) {
      const rust = rustEffects.get(tag) || [];
      if (JSON.stringify(calls) !== JSON.stringify(rust)) {
        mismatches.push({ case: caseNames.get(tag) || tag, node: calls, rust });
      }
    }
    const details = path.join(work, 'effect-mismatches.json');
    fs.writeFileSync(details, JSON.stringify(mismatches, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
    }
    if (problems.length) {
      for (const problem of problems) console.log(`[quota-routes] ${problem}`);
      const problemFile = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(problemFile, JSON.stringify(problems, null, 2));
      return { ok: false, details: problemFile };
    }
    if (mismatches.length) {
      console.log(`[quota-routes] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[quota-routes] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
