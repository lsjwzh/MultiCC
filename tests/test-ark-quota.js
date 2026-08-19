'use strict';

// Isolation tests for the arkcli stream parser in src/routes/ark-quota.js.
// arkcli writes its JSON payload and then appends non-JSON chatter (the
// "arkcli X.Y available" upgrade notice) to the same stream; parsing the
// whole stream therefore fails precisely on the error path, which used to
// misreport a missing login as a bare `unavailable`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArkcliJsonStream } = require('../src/routes/ark-quota');
const { renderQuotaBar } = require('../src/quota/quota-bar-view');

test('parses a clean JSON payload', () => {
  const parsed = parseArkcliJsonStream('{"ok":true,"items":[]}');
  assert.deepEqual(parsed, { ok: true, items: [] });
});

test('parses the payload when the upgrade notice trails it (the production case)', () => {
  const stderr = [
    '{',
    '  "ok": false,',
    '  "error": {',
    '    "type": "error",',
    '    "message": "not configured, run `arkcli config init --profile default` or `arkcli auth login`"',
    '  }',
    '}',
    '',
    'arkcli 1.0.10 available, current 1.0.8',
    'Run: npm i @volcengine/ark-cli@1.0.10 -g --registry https://registry.npmjs.org',
    '',
  ].join('\n');
  const parsed = parseArkcliJsonStream(stderr);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error.message, /not configured/);
});

test('does not end the scan on braces inside JSON strings', () => {
  const parsed = parseArkcliJsonStream('{"ok":false,"error":{"message":"run } arkcli { auth"}} trailing');
  assert.equal(parsed.error.message, 'run } arkcli { auth');
});

test('handles escaped quotes inside strings', () => {
  const parsed = parseArkcliJsonStream('{"m":"a\\"}b"} noise');
  assert.equal(parsed.m, 'a"}b');
});

test('returns null for streams without a JSON object', () => {
  assert.equal(parseArkcliJsonStream(''), null);
  assert.equal(parseArkcliJsonStream('no json here'), null);
  assert.equal(parseArkcliJsonStream(null), null);
});

test('returns null for an unterminated object', () => {
  assert.equal(parseArkcliJsonStream('{"ok":true'), null);
});

test('skips leading non-JSON text before the payload', () => {
  const parsed = parseArkcliJsonStream('warn: something\n{"ok":true}');
  assert.equal(parsed.ok, true);
});

test('renders Ark Coding compact bar as remaining quota in canonical window order', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const bar = renderQuotaBar('ark', {
    status: 'ok',
    fetchedAt: now,
    viewer: { user_name: 'tester', auth_method: 'sso' },
    items: [
      {
        product: 'agent-plan',
        tier: 'pro',
        subscribed: true,
        periods: [
          { label: 'weekly', used: 90, total: 100, percent: 90, resetAt: now + 2 * 24 * 3600 * 1000 },
        ],
      },
      {
        product: 'coding-plan',
        tier: 'pro',
        subscribed: true,
        periods: [
          { label: 'monthly', used: 70, total: 100, percent: 70, resetAt: now + 22 * 24 * 3600 * 1000 },
          { label: '5h', used: 20, total: 100, percent: 20, resetAt: now + 5 * 3600 * 1000 },
          { label: 'weekly', used: 40, total: 100, percent: 40, resetAt: now + (5 * 24 + 1) * 3600 * 1000 },
        ],
      },
    ],
  }, { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' });

  assert.equal(
    bar.text,
    `Coding · 5h 80% {cd:${now + 5 * 3600 * 1000}} · 1wk 60% {cd:${now + (5 * 24 + 1) * 3600 * 1000}} · 1m 30% {cd:${now + 22 * 24 * 3600 * 1000}} · {ago:${now}} ⟳`,
  );
  assert.match(bar.title, /Coding · pro（当前 provider）/);
  assert.match(bar.title, /5h: 余量 80% · 已用 20% \(20\/100\)/);
  assert.match(bar.title, /周: 余量 60% · 已用 40% \(40\/100\)/);
  assert.match(bar.title, /月: 余量 30% · 已用 70% \(70\/100\)/);
});

test('renders the Coding Plan session window as the 5h rolling window', () => {
  // arkcli reports the coding-plan current-session window as `session`; the
  // official console shows it with a reset countdown — it is the same 5h
  // rolling window the agent plan reports as `5h`, so the bar must say 5h.
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const bar = renderQuotaBar('ark', {
    status: 'ok',
    fetchedAt: now,
    viewer: null,
    items: [
      {
        product: 'coding-plan',
        tier: 'pro',
        subscribed: true,
        periods: [
          { label: 'session', used: null, total: null, percent: 30.4, resetAt: now + 11 * 60 * 1000 },
          { label: 'weekly', used: null, total: null, percent: 45.86, resetAt: now + 4.5 * 24 * 3600 * 1000 },
          { label: 'monthly', used: null, total: null, percent: 63.82, resetAt: now + 20.5 * 24 * 3600 * 1000 },
        ],
      },
    ],
  }, { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' });

  assert.ok(bar.text.startsWith('Coding · 5h 70%'), `session window must render as 5h: ${bar.text}`);
  assert.ok(!bar.text.includes('会话'), `bar must not label the session window 会话: ${bar.text}`);
  assert.match(bar.title, /5h: 余量 70% · 已用 30\.4%/);
  assert.ok(!bar.title.includes('会话:'), `tooltip must not label the session window 会话: ${bar.title}`);
});
