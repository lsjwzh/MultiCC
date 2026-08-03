'use strict';

// The two quota routes that read a logged-in browser session: their parsing and
// their page-driving logic, exercised without a browser.

const test = require('node:test');
const assert = require('node:assert');

// The route reads its budget once at load time; the give-up paths below are
// supposed to wait it out, so shrink it before requiring rather than sitting
// through the production 10s.
process.env.OPENCODE_QUOTA_TIMEOUT_MS = '200';

const opencode = require('../src/routes/opencode-quota');
const qoder = require('../src/routes/qoder-quota');

// ---------------------------------------------------------------- opencode --

const SSR_SCRIPT = `
  window._$HY={};lite.subscription.get["ws_abc"]=$R[12]={
    rollingUsage:$R[35]={status:"ok",resetInSec:17617,usagePercent:19},
    weeklyUsage:$R[36]={status:"ok",resetInSec:400000,usagePercent:42},
    billing:{monthlyUsage:null,monthlyLimit:null},
    monthlyUsage:$R[37]={status:"ok",resetInSec:1200000,usagePercent:7},
    useBalance:!1,region:["us","eu","sg"]};
`;

test('parseUsage pulls the three triplets out of the SSR hydration literal', () => {
  const usage = opencode.parseUsage(SSR_SCRIPT);
  assert.deepEqual(usage.rolling, { status: 'ok', resetInSec: 17617, usagePercent: 19 });
  assert.deepEqual(usage.weekly, { status: 'ok', resetInSec: 400000, usagePercent: 42 });
  // The billing block's `monthlyUsage:null` must not win over the real one.
  assert.deepEqual(usage.monthly, { status: 'ok', resetInSec: 1200000, usagePercent: 7 });
  assert.equal(usage.useBalance, false);
});

test('parseUsage accepts the un-minified shapes too', () => {
  const usage = opencode.parseUsage(
    'rollingUsage:{status:"ok",resetInSec:60,usagePercent:1},useBalance:true',
  );
  assert.deepEqual(usage.rolling, { status: 'ok', resetInSec: 60, usagePercent: 1 });
  assert.equal(usage.weekly, null);
  assert.equal(usage.useBalance, true);
});

test('parseUsage returns null when there is nothing to parse', () => {
  assert.equal(opencode.parseUsage(''), null);
  assert.equal(opencode.parseUsage(null), null);
  assert.equal(opencode.parseUsage('<html>a login page</html>'), null);
});

// A page stand-in with the same surface src/chrome-cdp.js hands to callers.
// `script` is the state machine: each evaluate consumes the next answer.
function fakePage({ urls, bodyText = '', scripts = [] }) {
  const navigated = [];
  let urlIdx = 0;
  let scriptIdx = 0;
  return {
    navigated,
    enable: async () => {},
    navigate: async (url) => { navigated.push(url); },
    async evaluate(expression) {
      if (expression.includes('location.href')) {
        const url = urls[Math.min(urlIdx, urls.length - 1)];
        urlIdx += 1;
        return JSON.stringify({ u: url, r: 'complete', h: 5000 });
      }
      if (expression.includes('innerText')) return bodyText;
      if (expression.includes('querySelectorAll("script")')) {
        const text = scripts[Math.min(scriptIdx, scripts.length - 1)];
        scriptIdx += 1;
        return text === undefined ? '' : text;
      }
      return '';
    },
    async waitFor(predicate, { timeoutMs = 1000, intervalMs = 1 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let hit = null;
        try { hit = await predicate(); } catch (_) { hit = null; }
        if (hit) return hit;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };
}

test('readUsageFromPage reports the usage a logged-in console renders', async () => {
  const page = fakePage({
    urls: ['https://opencode.ai/workspace/ws_abc/go'],
    scripts: [SSR_SCRIPT],
  });
  const result = await opencode.readUsageFromPage(page);
  assert.equal(result.status, 'ok');
  assert.equal(result.workspaceId, 'ws_abc');
  assert.equal(result.usage.rolling.usagePercent, 19);
  assert.deepEqual(page.navigated, ['https://opencode.ai/auth'], 'already at /go — no second navigation');
});

test('readUsageFromPage walks on to /go when the redirect stops at the workspace', async () => {
  const page = fakePage({
    urls: ['https://opencode.ai/workspace/ws_abc'],
    scripts: ['', SSR_SCRIPT],
  });
  const result = await opencode.readUsageFromPage(page);
  assert.equal(result.status, 'ok');
  assert.equal(page.navigated[1], 'https://opencode.ai/workspace/ws_abc/go');
});

test('readUsageFromPage recognises the login screen', async () => {
  const page = fakePage({
    urls: ['https://auth.opencode.ai/authorize?client_id=x'],
    bodyText: 'Sign in\nContinue with GitHub\nContinue with Google',
  });
  const result = await opencode.readUsageFromPage(page);
  assert.equal(result.status, 'needs_login');
});

test('readUsageFromPage distinguishes a page that rendered nothing from one it could not parse', async () => {
  const blank = await opencode.readUsageFromPage(fakePage({
    urls: ['https://opencode.ai/workspace/ws_abc/go'],
    scripts: [''],
  }));
  assert.equal(blank.status, 'unavailable');
  assert.match(blank.error, /script tags missing/);

  const unparsable = await opencode.readUsageFromPage(fakePage({
    urls: ['https://opencode.ai/workspace/ws_abc/go'],
    scripts: ['console.log("hello")'],
  }));
  assert.equal(unparsable.status, 'unavailable');
  assert.match(unparsable.error, /usage literals not found/);
});

test('readUsageFromPage gives up on a page that never settles', async () => {
  const page = fakePage({ urls: ['about:blank'] });
  const result = await opencode.readUsageFromPage(page);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /never settled/);
});

// ------------------------------------------------------------------ qoder --

test('cookieHeader serialises a jar and skips junk entries', () => {
  assert.equal(
    qoder.cookieHeader([{ name: 'sid', value: 'a' }, { name: '', value: 'b' }, null, { name: 'tok', value: 'c' }]),
    'sid=a; tok=c',
  );
  assert.equal(qoder.cookieHeader([]), '');
  assert.equal(qoder.cookieHeader(null), '');
});

test('looksLikeQuota accepts any of the three quota blocks and nothing else', () => {
  assert.ok(qoder.looksLikeQuota({ total_quota: { quota_summary: {} } }));
  assert.ok(qoder.looksLikeQuota({ plan_quota: {} }));
  assert.ok(qoder.looksLikeQuota({ resource_package_quota: {} }));
  assert.ok(!qoder.looksLikeQuota({ message: 'unauthorized' }));
  assert.ok(!qoder.looksLikeQuota('<html>'));
  assert.ok(!qoder.looksLikeQuota(null));
});

test('isUnauthenticated covers both the 401 and the redirect-to-login shape', () => {
  assert.ok(qoder.isUnauthenticated({ statusCode: 401 }));
  assert.ok(qoder.isUnauthenticated({ statusCode: 403 }));
  assert.ok(qoder.isUnauthenticated({ statusCode: 302, location: 'https://qoder.com.cn/sign-in?next=/' }));
  assert.ok(qoder.isUnauthenticated({ statusCode: 307, location: '/login' }));
  assert.ok(!qoder.isUnauthenticated({ statusCode: 302, location: '/account/usage' }));
  assert.ok(!qoder.isUnauthenticated({ statusCode: 200 }));
  assert.ok(!qoder.isUnauthenticated({ statusCode: 500 }));
});

test('both routes mount without a browser anywhere in sight', () => {
  const routes = [];
  const app = {
    get: (route, handler) => routes.push(['GET', route, typeof handler]),
    post: (route, handler) => routes.push(['POST', route, typeof handler]),
  };
  opencode.mountOpenCodeQuotaRoutes(app);
  qoder.mountQoderQuotaRoutes(app);
  assert.deepEqual(routes, [
    ['GET', '/api/opencode/quota', 'function'],
    ['GET', '/api/qoder/quota', 'function'],
    ['POST', '/api/qoder/quota/login', 'function'],
    ['GET', '/api/qoder/quota/cookies', 'function'],
  ]);
});
