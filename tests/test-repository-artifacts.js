'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { evaluatePolicy, scanTrackedEntry, trackedEntries } = require('../scripts/check-repository-artifacts');

function entry(path, content) {
  return { path, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content || '') };
}

test('artifact policy rejects new APKs, backups, runtime state and raw audit dumps', () => {
  const files = [
    entry('release.apk', Buffer.concat([Buffer.from([0]), Buffer.alloc(1024 * 1024 + 1)])),
    entry('server.js.bak.next', 'backup'),
    entry('sessions.json', '{}'),
    entry('npm-audit-new.json', '{}'),
  ];
  const result = evaluatePolicy(files, { accepted: {} });
  assert.ok(result.unexpected.some(item => item === 'tracked-apk:release.apk'));
  assert.ok(result.unexpected.some(item => item === 'large-binary:release.apk'));
  assert.ok(result.unexpected.some(item => item === 'backup:server.js.bak.next'));
  assert.ok(result.unexpected.some(item => item === 'runtime-state:sessions.json'));
  assert.ok(result.unexpected.some(item => item === 'raw-audit-dump:npm-audit-new.json'));
});

test('artifact policy detects high-confidence credentials without logging values', () => {
  const credential = 'AKIA' + 'A'.repeat(16);
  assert.deepEqual(scanTrackedEntry('tests/fixtures/live.txt', Buffer.from(credential)), [
    'credential-content', 'sensitive-fixture',
  ]);
});

test('reviewed baseline accepts exact findings and reports stale entries', () => {
  const files = [entry('old.apk', Buffer.from([0, 1]))];
  const accepted = evaluatePolicy(files, { accepted: { 'tracked-apk': ['old.apk'] } });
  assert.deepEqual(accepted.unexpected, []);
  assert.deepEqual(accepted.stale, []);
  const stale = evaluatePolicy([], { accepted: { 'tracked-apk': ['old.apk'] } });
  assert.deepEqual(stale.stale, ['tracked-apk:old.apk']);
});

test('tracked entry scan tolerates files deleted in the uncommitted worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-worktree-'));
  try {
    childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, 'keep.js'), 'module.exports = true;\n');
    fs.writeFileSync(path.join(root, 'drop.js'), 'module.exports = false;\n');
    childProcess.execFileSync('git', ['add', 'keep.js', 'drop.js'], { cwd: root });
    fs.unlinkSync(path.join(root, 'drop.js'));
    assert.deepEqual(trackedEntries(root).map(entry => entry.path), ['keep.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The APK is built, not tracked ──────────────────────────────────────────
//
// public/multicc.apk used to be a 59 MB tracked binary, which every session
// worktree checked out a private copy of (149 worktrees × 59 MB ≈ 8.6 GB of
// pure duplication). It is now a release asset (with an optional ignored local
// override), so these tests pin both halves: nothing re-tracks an APK and only
// the release workflow produces the official distribution artifact.

const REPO_ROOT = path.resolve(__dirname, '..');

function trackedPaths() {
  return childProcess.execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT })
    .toString('utf8').split('\0').filter(Boolean);
}

test('APK and generated sidecars are untracked and ignored build artifacts', () => {
  assert.deepEqual(trackedPaths().filter(file => file.startsWith('public/multicc.apk')), []);
  for (const file of [
    'public/multicc.apk',
    'public/multicc.apk.json',
    'public/multicc.apk.sha1',
    'public/multicc.apk.sha256',
    'public/multicc.apk.tmp.123',
  ]) {
    const ignored = childProcess.spawnSync('git', ['check-ignore', '--no-index', '-q', file], {
      cwd: REPO_ROOT,
    });
    assert.equal(ignored.status, 0, `${file} must stay ignored after an on-demand build`);
  }
  const baseline = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'governance', 'repository-artifact-baseline.json'), 'utf8'));
  // The category stays (the scanner still rejects new APKs); the exemption goes.
  assert.deepEqual(baseline.accepted['tracked-apk'], []);
  assert.equal(baseline.accepted['large-binary'].includes('public/multicc.apk'), false);
});

test('APK building is release-only and never blocks install or update', () => {
  const publish = path.join(REPO_ROOT, 'scripts', 'publish-apk.sh');
  assert.equal(fs.existsSync(publish), true, 'scripts/publish-apk.sh is the single build implementation');
  // eslint-disable-next-line no-bitwise
  assert.equal((fs.statSync(publish).mode & 0o111) !== 0, true, 'publish-apk.sh must stay executable');
  const publishSource = fs.readFileSync(publish, 'utf8');
  assert.match(publishSource, /MULTICC_RELEASE_TAG/);
  // A missing Flutter SDK must be a named, non-zero failure, never a silent
  // half-build that leaves a stale APK looking fresh.
  assert.match(publishSource, /command -v flutter/);

  const cli = fs.readFileSync(path.join(REPO_ROOT, 'multicc'), 'utf8');
  assert.doesNotMatch(cli, /^\s*apk\)\s+/m, 'the host CLI must not expose an official build action');
  assert.doesNotMatch(cli, /ensure_apk_if_possible/, 'update must never synchronously build Flutter');

  const installer = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  assert.doesNotMatch(installer, /publish-apk\.sh/, 'install must not synchronously build Flutter');
  assert.match(installer, /--no-apk[^\n]+no longer needed/, 'the removed flag remains a harmless compatibility no-op');
  assert.doesNotMatch(installer, /command -v flutter/, 'Flutter is a release-runner prerequisite');
});

function apkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-publish-apk-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'publish-apk.sh'),
    path.join(root, 'scripts', 'publish-apk.sh'),
  );
  fs.writeFileSync(path.join(root, 'app', 'pubspec.yaml'), 'name: multicc_app\nversion: 2.29.7+119\n');
  return root;
}

function fakeFlutter(root) {
  const bin = path.join(root, 'fake-bin');
  const log = path.join(root, 'flutter-calls.log');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'flutter');
  fs.writeFileSync(executable, `#!/bin/sh
printf 'call\\n' >> "$FAKE_FLUTTER_LOG"
if [ "\${FAKE_FLUTTER_FAIL:-0}" = 1 ]; then exit 7; fi
mkdir -p build/app/outputs/flutter-apk
printf 'fixture-apk' > build/app/outputs/flutter-apk/app-release.apk
`);
  fs.chmodSync(executable, 0o755);
  const apksigner = path.join(bin, 'apksigner');
  fs.writeFileSync(apksigner, `#!/bin/sh
printf 'Signer #1 certificate SHA-256 digest: %s\n' "\${FAKE_SIGNER_SHA256}"
`);
  fs.chmodSync(apksigner, 0o755);
  return { bin, log, apksigner };
}

function runPublish(root, args, env) {
  return childProcess.spawnSync('bash', [path.join(root, 'scripts', 'publish-apk.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      MULTICC_APK_BUILD_LOCK: path.join(root, 'apk-build.lock'),
      MULTICC_RELEASE_TAG: 'v1.5.3',
      MULTICC_RELEASE_VERSION: '1.5.3',
      MULTICC_RELEASE_COMMIT: 'a'.repeat(40),
      ...env,
    },
  });
}

test('publish-apk builds atomically, writes truthful metadata and skips only a current APK', () => {
  const root = apkFixture();
  try {
    const fake = fakeFlutter(root);
    const env = {
      FAKE_FLUTTER_LOG: fake.log,
      PATH: `${fake.bin}:/usr/bin:/bin`,
      APKSIGNER_BIN: fake.apksigner,
      FAKE_SIGNER_SHA256: 'b'.repeat(64),
      MULTICC_APK_EXPECTED_SIGNER_SHA256: 'b'.repeat(64),
      MULTICC_ANDROID_KEYSTORE_PATH: '/tmp/fixture-release.jks',
      MULTICC_ANDROID_STORE_PASSWORD: 'fixture-store-password',
      MULTICC_ANDROID_KEY_ALIAS: 'fixture-key',
      MULTICC_ANDROID_KEY_PASSWORD: 'fixture-key-password',
    };
    const first = runPublish(root, [], env);
    assert.equal(first.status, 0, first.stderr);

    const apk = path.join(root, 'public', 'multicc.apk');
    assert.equal(fs.readFileSync(apk, 'utf8'), 'fixture-apk');
    const metadata = JSON.parse(fs.readFileSync(`${apk}.json`, 'utf8'));
    assert.equal(metadata.versionName, '2.29.7');
    assert.equal(metadata.versionCode, 119);
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.releaseTag, 'v1.5.3');
    assert.equal(metadata.releaseVersion, '1.5.3');
    assert.equal(metadata.gitCommit, 'a'.repeat(40));
    assert.equal(metadata.signerSha256, 'b'.repeat(64));
    assert.equal(metadata.sha256, crypto.createHash('sha256').update('fixture-apk').digest('hex'));
    assert.equal(metadata.size, Buffer.byteLength('fixture-apk'));
    assert.match(metadata.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(fs.readFileSync(`${apk}.sha1`, 'utf8').trim(),
      crypto.createHash('sha1').update('fixture-apk').digest('hex'));
    assert.equal(fs.readFileSync(`${apk}.sha256`, 'utf8').trim(),
      crypto.createHash('sha256').update('fixture-apk').digest('hex'));

    const skipped = runPublish(root, ['--if-missing'], env);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(fs.readFileSync(fake.log, 'utf8'), 'call\n');

    const reusedWithoutFlutter = runPublish(root, ['--if-missing'], { PATH: '/usr/bin:/bin' });
    assert.equal(reusedWithoutFlutter.status, 0, reusedWithoutFlutter.stderr);

    fs.rmSync(`${apk}.json`);
    const repairedMetadata = runPublish(root, ['--if-missing'], env);
    assert.equal(repairedMetadata.status, 0, repairedMetadata.stderr);
    assert.equal(fs.readFileSync(fake.log, 'utf8'), 'call\ncall\n');

    fs.writeFileSync(path.join(root, 'app', 'pubspec.yaml'), 'name: multicc_app\nversion: 2.29.8+120\n');
    const refreshedVersion = runPublish(root, ['--if-missing'], env);
    assert.equal(refreshedVersion.status, 0, refreshedVersion.stderr);
    assert.equal(fs.readFileSync(fake.log, 'utf8'), 'call\ncall\ncall\n');
    assert.equal(JSON.parse(fs.readFileSync(`${apk}.json`, 'utf8')).versionCode, 120);

    fs.writeFileSync(apk, '');
    const rebuilt = runPublish(root, ['--if-missing'], env);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.equal(fs.readFileSync(fake.log, 'utf8'), 'call\ncall\ncall\ncall\n');
    assert.equal(fs.readFileSync(apk, 'utf8'), 'fixture-apk');

    fs.writeFileSync(apk, 'known-good');
    const failed = runPublish(root, [], { ...env, FAKE_FLUTTER_FAIL: '1' });
    assert.equal(failed.status, 7);
    assert.equal(fs.readFileSync(apk, 'utf8'), 'known-good', 'a failed build must not replace the served APK');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publish-apk fails clearly and leaves no artifact when Flutter is unavailable', () => {
  const root = apkFixture();
  try {
    const result = runPublish(root, [], { PATH: '/usr/bin:/bin' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Flutter SDK not found/);
    assert.equal(fs.existsSync(path.join(root, 'public', 'multicc.apk')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publish-apk rejects an invalid pubspec version instead of advertising unknown', () => {
  const root = apkFixture();
  try {
    fs.writeFileSync(path.join(root, 'app', 'pubspec.yaml'), 'name: multicc_app\nversion: invalid\n');
    const result = runPublish(root, [], { PATH: '/usr/bin:/bin' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must declare version/);
    assert.equal(fs.existsSync(path.join(root, 'public', 'multicc.apk.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publish-apk serializes builds and recovers a stale process lock', () => {
  const root = apkFixture();
  try {
    const fake = fakeFlutter(root);
    const lock = path.join(root, 'apk-build.lock');
    const env = {
      FAKE_FLUTTER_LOG: fake.log,
      PATH: `${fake.bin}:/usr/bin:/bin`,
      APKSIGNER_BIN: fake.apksigner,
      FAKE_SIGNER_SHA256: 'b'.repeat(64),
      MULTICC_APK_EXPECTED_SIGNER_SHA256: 'b'.repeat(64),
      MULTICC_ANDROID_KEYSTORE_PATH: '/tmp/fixture-release.jks',
      MULTICC_ANDROID_STORE_PASSWORD: 'fixture-store-password',
      MULTICC_ANDROID_KEY_ALIAS: 'fixture-key',
      MULTICC_ANDROID_KEY_PASSWORD: 'fixture-key-password',
    };
    fs.writeFileSync(lock, `${process.pid}\n`);
    const blocked = runPublish(root, [], env);
    assert.equal(blocked.status, 75);
    assert.match(blocked.stderr, /already running/);
    assert.equal(fs.existsSync(path.join(root, 'public', 'multicc.apk')), false);

    fs.writeFileSync(lock, '99999999\n');
    const recovered = runPublish(root, [], env);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'public', 'multicc.apk'), 'utf8'), 'fixture-apk');
    assert.equal(fs.existsSync(lock), false, 'the owning build releases its lock');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manage only downloads the selected local-or-release APK source', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'public', 'manage-host-settings.js'), 'utf8');
  const html = fs.readFileSync(path.join(REPO_ROOT, 'public', 'manage.html'), 'utf8');
  assert.match(html, /id="apk-download-btn"[^>]+href="\/multicc\.apk"/);
  assert.match(html, /id="apk-source-status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(html, /apk-build-btn|startApkBuild/);
  assert.match(source, /info\.source === 'release'/);
  assert.match(source, /info\.downloadUrl/);
  assert.doesNotMatch(source, /startApkBuild|\/api\/apk-build/);
});
