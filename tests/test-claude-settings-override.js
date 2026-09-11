'use strict';

// Unit tests for src/providers/claude-settings-override.js — the per-session
// --settings override that keeps ~/.claude/settings.json env from hijacking
// per-session provider routing on Claude Code ≥2.1.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  settingsOverrideFor,
  routingEnvOf,
  OVERRIDE_DIR,
} = require('../src/providers/claude-settings-override');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

const testFile = (name) => path.join(OVERRIDE_DIR, `${encodeURIComponent(name)}.json`);

function cleanup(...names) {
  for (const n of names) { try { fs.unlinkSync(testFile(n)); } catch (_) {} }
}

console.log('── routingEnvOf ──');
{
  const env = routingEnvOf({
    ANTHROPIC_BASE_URL: 'https://relay.example.com',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    MULTICC_SESSION_ID: 's1',
    TERM: 'dumb',
    ANTHROPIC_NUM: 42, // non-string dropped
  });
  assert.deepStrictEqual(env, {
    ANTHROPIC_BASE_URL: 'https://relay.example.com',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CODE_OAUTH_TOKEN: '',
  });
  passed += 1; console.log('  ✓ keeps ANTHROPIC_/CLAUDE_CODE_ string keys only');
}
ok(Object.keys(routingEnvOf(null)).length === 0, 'null env → empty');

console.log('── settingsOverrideFor ──');
{
  const r = settingsOverrideFor('sess-none', { MULTICC_SESSION_ID: 'x', TERM: 'dumb' });
  ok(r === null, 'no routing keys + no extra → null (provider-less session)');
}
{
  const r = settingsOverrideFor('sess-extra-only', {}, { ultracode: true });
  ok(r && fs.existsSync(r), 'extraSettings-only still writes a file');
  const doc = JSON.parse(fs.readFileSync(r, 'utf8'));
  assert.deepStrictEqual(doc, { ultracode: true, env: {} });
  passed += 1; console.log('  ✓ extraSettings merged into file');
  cleanup('sess-extra-only');
}
{
  const childEnv = {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000/ccfw/sess',
    ANTHROPIC_AUTH_TOKEN: 'proxy-token',
    ANTHROPIC_MODEL: 'k3',
    MULTICC_SESSION_ID: 'sess-a',
  };
  const r = settingsOverrideFor('sess-a', childEnv);
  ok(r === testFile('sess-a'), 'file path is per-session under OVERRIDE_DIR');
  const doc = JSON.parse(fs.readFileSync(r, 'utf8'));
  ok(doc.env.ANTHROPIC_BASE_URL === childEnv.ANTHROPIC_BASE_URL, 'base url mirrored');
  ok(doc.env.ANTHROPIC_AUTH_TOKEN === 'proxy-token', 'token mirrored');
  ok(doc.env.ANTHROPIC_MODEL === 'k3', 'model mirrored');
  ok(!('MULTICC_SESSION_ID' in doc.env), 'MULTICC_* stays out of the file');
  // User-settings leak guard: routing keys the provider does not define must
  // be blanked, not inherited from ~/.claude/settings.json.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SIMPLE']) {
    ok(doc.env[k] === '', `${k} blanked when absent`);
  }
  ok(doc.env.ANTHROPIC_BASE_URL !== '', 'defined keys are never blanked');
  const st = fs.statSync(r);
  ok((st.mode & 0o777) === 0o600, 'file mode 0600 (token not world-readable)');
  const dst = fs.statSync(OVERRIDE_DIR);
  ok((dst.mode & 0o777) === 0o700, 'dir mode 0700');
  cleanup('sess-a');
}
{
  // Rewrite keeps the file in sync with a provider switch.
  const a = settingsOverrideFor('sess-rw', { ANTHROPIC_BASE_URL: 'https://a.example.com', ANTHROPIC_AUTH_TOKEN: 'ta' });
  const b = settingsOverrideFor('sess-rw', { ANTHROPIC_BASE_URL: 'https://b.example.com', ANTHROPIC_AUTH_TOKEN: 'tb' });
  ok(a === b, 'same session → same file path across rewrites');
  const doc = JSON.parse(fs.readFileSync(b, 'utf8'));
  ok(doc.env.ANTHROPIC_BASE_URL === 'https://b.example.com', 'rewrite picks up the new provider');
  cleanup('sess-rw');
}
{
  const r = settingsOverrideFor('sess ultra/code', { ANTHROPIC_MODEL: 'm' });
  ok(r && path.basename(r) === `${encodeURIComponent('sess ultra/code')}.json`, 'session names are path-sanitized');
  cleanup('sess ultra/code');
}

console.log(`\n${passed} passed, 0 failed`);
console.log('ALL TESTS PASSED ✓');
