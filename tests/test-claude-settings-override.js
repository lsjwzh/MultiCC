'use strict';

// Unit tests for src/providers/claude-settings-override.js — the per-session
// --settings override that keeps ~/.claude/settings.json env from hijacking
// per-session provider routing on Claude Code ≥2.1, and that carries the
// official lane's chosen model so a ccswitch-style terminal config cannot
// redirect the official account.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The module resolves ~/.multicc/claude-settings-overrides at require time:
// isolate HOME so the test never writes into the operator's live data dir.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-settings-override-'));
const previousHome = process.env.HOME;
process.env.HOME = HOME;
process.on('exit', () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const {
  settingsOverrideFor,
  routingEnvOf,
  OVERRIDE_DIR,
} = require('../src/providers/claude-settings-override');

// Mirrors BLANK_WHEN_ABSENT_KEYS: routing/model keys the session does not
// define, which must be neutralized so the user-level settings cannot supply
// them (or an upstream model) behind the session's back.
const BLANKS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SIMPLE',
];

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
  ok(doc.ultracode === true, 'extraSettings merged into file');
  assert.ok(!('model' in doc), 'no model is invented when extraSettings carries none');
  for (const k of BLANKS) ok(doc.env[k] === '', `${k} blanked when only extra settings are written`);
  ok(Object.keys(doc.env).length === BLANKS.length, 'the env block holds only the blanking keys');
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
  // be blanked, not inherited from ~/.claude/settings.json. ANTHROPIC_CUSTOM_HEADERS
  // belongs here too — the CLI expands it into literal upstream headers, so a
  // value from the user-level file would ride along to the provider.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SIMPLE']) {
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
  // The fix is "don't INHERIT", not "never send": a provider that declares its
  // own headers still gets them mirrored, and the local proxy forwards client
  // headers to that provider — which is what such a provider asks for.
  const r = settingsOverrideFor('sess-headers', {
    ANTHROPIC_BASE_URL: 'https://headers.example.com',
    ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: fixture',
  });
  const doc = JSON.parse(fs.readFileSync(r, 'utf8'));
  ok(doc.env.ANTHROPIC_CUSTOM_HEADERS === 'x-tenant: fixture', 'provider-declared custom headers survive unblanked');
  cleanup('sess-headers');
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

console.log('── official lane: terminal config isolation ──');
{
  // A ccswitch-style ~/.claude/settings.json may carry model + routing env.
  // The official lane has no provider routing env of its own, so the override
  // is written from the chosen model alone and must blank every routing key.
  const r = settingsOverrideFor('sess-official', { MULTICC_SESSION_ID: 's' }, {
    model: 'claude-opus-5[1m]',
  });
  ok(r && fs.existsSync(r), 'official lane writes an override file without routing env');
  const doc = JSON.parse(fs.readFileSync(r, 'utf8'));
  ok(doc.model === 'claude-opus-5[1m]', 'chosen model is carried at the top level (higher precedence than user settings)');
  for (const k of BLANKS) ok(doc.env[k] === '', `${k} blanked for the official lane`);
  ok(!JSON.stringify(doc).includes('deepseek'), 'a terminal-switched model never reaches the override file');
  cleanup('sess-official');
}
{
  // OAuth/keychain login must survive: an empty env value reads as unset, and a
  // real OAuth token in the session env is mirrored untouched (not blanked).
  const r = settingsOverrideFor('sess-oauth', {
    MULTICC_SESSION_ID: 's',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-keychain',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000/ccfw/oauth-session',
  }, { model: 'claude-opus-5[1m]' });
  const doc = JSON.parse(fs.readFileSync(r, 'utf8'));
  ok(doc.env.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-from-keychain', 'OAuth token mirrored untouched');
  ok(doc.env.ANTHROPIC_API_KEY === '', 'blank API key reads as unset, so keychain/OAuth login still applies');
  ok(doc.model === 'claude-opus-5[1m]', 'OAuth session keeps the chosen model');
  cleanup('sess-oauth');
}

console.log(`\n${passed} passed, 0 failed`);
console.log('ALL TESTS PASSED ✓');
