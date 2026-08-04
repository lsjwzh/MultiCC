'use strict';

// Isolation tests for the arkcli stream parser in src/routes/ark-quota.js.
// arkcli writes its JSON payload and then appends non-JSON chatter (the
// "arkcli X.Y available" upgrade notice) to the same stream; parsing the
// whole stream therefore fails precisely on the error path, which used to
// misreport a missing login as a bare `unavailable`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArkcliJsonStream } = require('../src/routes/ark-quota');

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
