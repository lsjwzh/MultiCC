'use strict';

// The Rust front door is the only server for these routes now, so the frozen
// Node oracles and corpora that justified each port must not drift silently:
//   - native/core/tests/fixtures/outbound-proxy-cases.json is recomputed from
//     src/network/proxy-policy.js (still the Node policy for everything else);
//   - native/gateway/tests/fixtures/{account-subscription,provider-limit-history,
//     claude-models}.json are recomputed from the frozen Node oracles.
// Before this test, every generator was only wired to its own `node scripts/...`
// command, so a change to proxy-policy or an oracle reddened nothing in CI.
//
// Each generator is run in its own verify mode (no arguments), in a child
// process, with an isolated HOME/TMPDIR/data root and every proxy variable
// pinned to a closed loopback port. Any accidental outbound connection is
// refused by that closed port; on macOS the child additionally runs under a
// sandbox profile that denies all non-loopback outbound traffic. Nothing here
// reads the real HOME, the macOS Keychain or a real upstream.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const runtimePath = path.join(root, 'src', 'native', 'runtime.js');
const SANDBOX = '/usr/bin/sandbox-exec';
// Allow the local fake upstreams (Express on 127.0.0.1) and nothing else.
const SANDBOX_PROFILE = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))';

function addonAvailable() {
  try {
    require(runtimePath).getNative();
    return true;
  } catch (_) {
    return false;
  }
}

const addon = addonAvailable();
const skipAddon = addon
  ? false
  : 'optional Rust addon not built (native/prebuilt, MULTICC_RUST_PREBUILT_DIR or MULTICC_RUST_ADDON)';

function isolatedEnv(work) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: path.join(work, 'home'),
    TMPDIR: path.join(work, 'tmp'),
    TMP: path.join(work, 'tmp'),
    MULTICC_DATA_DIR: path.join(work, 'data'),
    // The account-subscription generator keeps its TLS material here.
    AS_WORK: path.join(work, 'as-work'),
    // A forgotten proxy would fall back to the host's system proxy; pin every
    // spelling at a closed loopback port so a stray request fails immediately.
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    http_proxy: 'http://127.0.0.1:1',
    https_proxy: 'http://127.0.0.1:1',
    all_proxy: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  for (const key of ['MULTICC_RUST_ADDON', 'MULTICC_RUST_PREBUILT_DIR', 'OPENSSL_BIN']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const dir of ['home', 'tmp', 'data', 'as-work']) fs.mkdirSync(path.join(work, dir), { recursive: true });
  return env;
}

function verify(script) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-front-door-fixture-'));
  const args = [path.join(root, script)];
  const command = fs.existsSync(SANDBOX) ? SANDBOX : process.execPath;
  if (command === SANDBOX) args.unshift('-p', SANDBOX_PROFILE, process.execPath);
  const run = spawnSync(command, args, {
    cwd: root,
    env: isolatedEnv(work),
    encoding: 'utf8',
    timeout: 180_000,
  });
  fs.rmSync(work, { recursive: true, force: true });
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  assert.equal(run.error, undefined, `${script}: ${run.error && run.error.message}`);
  assert.equal(run.status, 0, `${script} is stale or failed${output ? `:\n${output}` : ''}`);
  return output;
}

test('the outbound proxy corpus matches the live proxy policy', () => {
  assert.match(verify('scripts/generate-outbound-proxy-corpus.js'), /verified native\/core\/tests\/fixtures\/outbound-proxy-cases\.json/);
});

test('the claude models fixture matches the frozen Node oracle', () => {
  assert.match(verify('scripts/generate-claude-models-fixture.js'), /claude models fixture current/);
});

test('the provider limit history fixture matches the frozen Node oracle', { skip: skipAddon }, () => {
  assert.match(verify('scripts/generate-provider-limit-history-fixture.js'), /provider limit history fixture current/);
});

test('the account subscription fixture matches the frozen Node oracle', { skip: skipAddon }, () => {
  assert.match(verify('scripts/generate-account-subscription-fixture.js'), /fixture ok: 22 cases/);
});

test('the fixture generators never read the Keychain', () => {
  const files = [
    'scripts/generate-outbound-proxy-corpus.js',
    'scripts/generate-account-subscription-fixture.js',
    'scripts/generate-provider-limit-history-fixture.js',
    'scripts/generate-claude-models-fixture.js',
    'tests/helpers/legacy-account-subscription-route.js',
    'tests/helpers/legacy-provider-limit-history-route.js',
    'tests/helpers/legacy-claude-models-route.js',
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /\/usr\/bin\/security/, `${file} must not read the Keychain`);
  }
});
