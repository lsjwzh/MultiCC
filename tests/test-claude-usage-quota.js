'use strict';

// The Claude usage-quota route (claude.ai/settings/usage scrape): parser units
// plus the page-driving logic, exercised without a browser. Same shape as
// test-quota-chrome-routes.js — a fakePage stands in for the CDP page.

const test = require('node:test');
const assert = require('node:assert');

// The route reads its budget once at load time; the give-up paths below are
// supposed to wait it out, so shrink it before requiring rather than sitting
// through the production 15s / 30s.
process.env.CLAUDE_QUOTA_TIMEOUT_MS = '200';
process.env.CLAUDE_QUOTA_PANEL_TIMEOUT_MS = '200';

const claude = require('../src/routes/claude-usage-quota');

// A realistic claude.ai/settings/usage body: window label, plan name sometimes
// sits between label and value, percentage, then the reset countdown.
const USAGE_TEXT = [
  'Usage',
  'Current session',
  '42%',
  'Resets in 2h 15m',
  'Weekly limit',
  '65%',
  'Resets in 3d 4h',
  'Monthly limit',
  '20%',
  'Resets in 15d',
].join('\n');

test('windowTokenForLabel maps the page labels to the unified window tokens', () => {
  assert.equal(claude.windowTokenForLabel('Current session'), '5h');
  assert.equal(claude.windowTokenForLabel('5 hours'), '5h');
  assert.equal(claude.windowTokenForLabel('Weekly limit'), '1wk');
  assert.equal(claude.windowTokenForLabel('7 day'), '1wk');
  assert.equal(claude.windowTokenForLabel('Monthly limit'), '1m');
  assert.equal(claude.windowTokenForLabel('30 day'), '1m');
  assert.equal(claude.windowTokenForLabel('Whatever'), null);
  assert.equal(claude.windowTokenForLabel(''), null);
  assert.equal(claude.windowTokenForLabel(null), null);
});

test('parseClaudeReset parses the countdown shapes and ignores junk', () => {
  const now = 1_700_000_000_000;
  assert.equal(claude.parseClaudeReset('Resets in 2h 15m', now), now + (2 * 3600 + 15 * 60) * 1000);
  assert.equal(claude.parseClaudeReset('Resets in 3d 4h', now), now + (3 * 86400 + 4 * 3600) * 1000);
  assert.equal(claude.parseClaudeReset('Resets in 45m', now), now + 45 * 60 * 1000);
  assert.equal(claude.parseClaudeReset('Resets in 2h', now), now + 2 * 3600 * 1000);
  assert.equal(claude.parseClaudeReset('Resets in 2 H 15 M', now), now + (2 * 3600 + 15 * 60) * 1000);
  assert.equal(claude.parseClaudeReset('Some other text', now), null);
  assert.equal(claude.parseClaudeReset('', now), null);
  assert.equal(claude.parseClaudeReset(null, now), null);
});

test('parseClaudeReset resolves the absolute weekday form to the next such time', () => {
  // The page prints a countdown for a window turning over soon and an absolute
  // local weekday for one days away ("Resets Wed 2:00 PM"). Only the countdown
  // used to be understood, so the weekly rows lost their reset time entirely —
  // and worse, the unparsed line was mistaken for the window's own label.
  const sunNoon = new Date(2026, 7, 9, 12, 0, 0, 0).getTime();   // a Sunday
  const at = claude.parseClaudeReset('Resets Wed 2:00 PM', sunNoon);
  const d = new Date(at);
  assert.equal(d.getDay(), 3, 'Wednesday');
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 12, 'the coming Wednesday, not one in the past');

  // Same weekday as today, at a time already gone → next week, never behind now.
  const later = claude.parseClaudeReset('Resets Sun 9:00 AM', sunNoon);
  assert.ok(later > sunNoon);
  assert.equal(new Date(later).getDate(), 16);

  // …and the same weekday at a time still ahead stays today.
  assert.equal(new Date(claude.parseClaudeReset('Resets Sun 6 PM', sunNoon)).getDate(), 9);
  assert.equal(claude.parseClaudeReset('Resets Funday 2:00 PM', sunNoon), null);
});

test('summarizeUsageText reads the current label / reset / percent layout', () => {
  // The reset line now sits ABOVE its percentage. Each row must take its own
  // reset time, not the neighbouring row's.
  const sunNoon = new Date(2026, 7, 9, 12, 0, 0, 0).getTime();
  const text = [
    'Current session',
    'Resets in 15m',
    '7%',
    'Weekly limit',
    'Resets Wed 2:00 PM',
    '25%',
    'Weekly limit (Opus)',
    'Resets Wed 2:00 PM',
    '1%',
  ].join('\n');
  const summary = claude.summarizeUsageText(text, sunNoon);
  assert.equal(summary.length, 3);
  assert.deepEqual(summary.map((s) => s.window), ['5h', '1wk', '1wk']);
  assert.deepEqual(summary.map((s) => s.usedPercent), [7, 25, 1]);
  assert.equal(summary[0].resetMs, sunNoon + 15 * 60 * 1000, '5h keeps its own countdown');
  const wed = new Date(summary[1].resetMs);
  assert.equal(wed.getDay(), 3);
  assert.equal(wed.getHours(), 14);
  assert.equal(summary[2].resetMs, summary[1].resetMs);
  // The reset line is boilerplate, never a window name — mistaking it for one
  // is what put "Resets Wed 2:00 PM" on the bar where "1wk" belongs.
  assert.equal(summary.some((s) => /Resets/i.test(s.label)), false);
});

test('summarizeUsageText carries the section heading down to rows named by model', () => {
  // Captured from the live page: the window is named ONCE, on a section
  // heading, and the rows under it are labelled by what they meter. Reading the
  // window off the row alone classified both weekly rows as null and dropped
  // them — the bar showed 5h and nothing else.
  const sunNoon = new Date(2026, 7, 9, 12, 0, 0, 0).getTime();
  const text = [
    'Current session',
    'Resets in 1 hr 18 min',
    '48%',
    'Weekly limits',
    'All models',
    'Resets Wed 2:00 PM',
    '46%',
    'Fable',
    'Resets Wed 1:59 PM',
    '35%',
  ].join('\n');
  const summary = claude.summarizeUsageText(text, sunNoon);
  assert.deepEqual(summary.map((s) => s.window), ['5h', '1wk', '1wk']);
  assert.deepEqual(summary.map((s) => s.label), ['Current session', 'All models', 'Fable']);
  assert.deepEqual(summary.map((s) => s.usedPercent), [48, 46, 35]);
  // "1 hr 18 min" is 78 minutes. The old shape-ladder wanted a space where the
  // page had the "r" of "hr", so it fell through to the plain-hours pattern and
  // read a flat 60.
  assert.equal(summary[0].resetMs, sunNoon + 78 * 60 * 1000);
});

test('parseClaudeReset sums whatever units the page spelled out', () => {
  const now = 1_700_000_000_000;
  assert.equal(claude.parseClaudeReset('Resets in 1 hr 18 min', now), now + 78 * 60 * 1000);
  assert.equal(claude.parseClaudeReset('Resets in 45 minutes', now), now + 45 * 60 * 1000);
  assert.equal(claude.parseClaudeReset('Resets in 2 hours 5 mins', now), now + 125 * 60 * 1000);
  assert.equal(claude.parseClaudeReset('Resets in 3 days 4 hrs', now), now + (3 * 86400 + 4 * 3600) * 1000);
});

test('usagePanelReady requires a percentage plus a window marker', () => {
  assert.ok(claude.usagePanelReady(USAGE_TEXT));
  assert.ok(claude.usagePanelReady('Current session\n42%\nResets in 2h'));
  assert.ok(!claude.usagePanelReady('Just some shell text'));
  assert.ok(!claude.usagePanelReady('42%'));
  assert.ok(!claude.usagePanelReady('Weekly limit'));
  assert.ok(!claude.usagePanelReady(''));
  assert.ok(!claude.usagePanelReady(null));
});

test('summarizeUsageText pulls the windows with reset times and labels', () => {
  const now = 1_700_000_000_000;
  const summary = claude.summarizeUsageText(USAGE_TEXT, now);
  assert.ok(Array.isArray(summary));
  assert.equal(summary.length, 3);
  const byWindow = Object.fromEntries(summary.map((s) => [s.window, s]));
  assert.equal(byWindow['5h'].usedPercent, 42);
  assert.equal(byWindow['5h'].label, 'Current session');
  assert.equal(byWindow['5h'].resetMs, now + (2 * 3600 + 15 * 60) * 1000);
  assert.equal(byWindow['1wk'].usedPercent, 65);
  assert.equal(byWindow['1wk'].label, 'Weekly limit');
  assert.equal(byWindow['1wk'].resetMs, now + (3 * 86400 + 4 * 3600) * 1000);
  assert.equal(byWindow['1m'].usedPercent, 20);
  assert.equal(byWindow['1m'].label, 'Monthly limit');
  assert.equal(byWindow['1m'].resetMs, now + 15 * 86400 * 1000);
});

test('summarizeUsageText skips plan-name lines between label and value', () => {
  const text = ['Pro', 'Weekly limit', '65%', 'Resets in 3d 4h'].join('\n');
  const summary = claude.summarizeUsageText(text, 1_700_000_000_000);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].window, '1wk');
  assert.equal(summary[0].label, 'Weekly limit');
  assert.equal(summary[0].usedPercent, 65);
});

test('summarizeUsageText returns null when there are no percentages', () => {
  assert.equal(claude.summarizeUsageText('Nothing to see here'), null);
  assert.equal(claude.summarizeUsageText(''), null);
  assert.equal(claude.summarizeUsageText(null), null);
});

// A page stand-in with the same surface src/chrome-cdp.js hands to callers,
// returning RAW evaluate values (location.href / document.readyState) like the
// kimi route does.
function fakePage({ urls, bodyText = '', readyState = 'complete' }) {
  const navigated = [];
  let urlIdx = 0;
  return {
    navigated,
    enable: async () => {},
    navigate: async (url) => { navigated.push(url); },
    async evaluate(expression) {
      if (expression.includes('location.href')) {
        const url = urls[Math.min(urlIdx, urls.length - 1)];
        urlIdx += 1;
        return url;
      }
      if (expression.includes('document.readyState')) return readyState;
      if (expression.includes('innerText')) return bodyText;
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

test('readClaudeUsageFromPage parses the hydrated usage page', async () => {
  const page = fakePage({ urls: ['https://claude.ai/settings/usage'], bodyText: USAGE_TEXT });
  const result = await claude.readClaudeUsageFromPage(page);
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'usage-page');
  assert.ok(Array.isArray(result.summary));
  assert.deepEqual(result.summary.map((s) => s.window), ['5h', '1wk', '1m']);
  assert.deepEqual(page.navigated, ['https://claude.ai/settings/usage']);
});

test('readClaudeUsageFromPage recognises the login redirect', async () => {
  const page = fakePage({ urls: ['https://claude.ai/login'], bodyText: 'Log in to Claude' });
  const result = await claude.readClaudeUsageFromPage(page);
  assert.equal(result.status, 'needs_login');
});

test('readClaudeUsageFromPage reports an unrenderable page (Cloudflare/blank) as unavailable', async () => {
  const page = fakePage({
    urls: ['https://claude.ai/settings/usage'],
    bodyText: 'Checking your browser before accessing claude.ai...',
  });
  const result = await claude.readClaudeUsageFromPage(page);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /未渲染/);
});

test('readClaudeUsageFromPage gives up on a page that never settles', async () => {
  const page = fakePage({ urls: ['https://claude.ai/settings/usage'], readyState: 'loading' });
  const result = await claude.readClaudeUsageFromPage(page);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /never settled/);
});

test('both claude usage routes mount without a browser anywhere in sight', () => {
  const routes = [];
  const app = {
    get: (route, handler) => routes.push(['GET', route, typeof handler]),
    post: (route, handler) => routes.push(['POST', route, typeof handler]),
  };
  claude.mountClaudeUsageQuotaRoutes(app);
  assert.deepEqual(routes, [
    ['GET', '/api/claude/quota', 'function'],
    ['POST', '/api/claude/quota/login', 'function'],
  ]);
});
