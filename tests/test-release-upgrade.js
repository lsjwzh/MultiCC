'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const installer = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
const manager = fs.readFileSync(path.join(ROOT, 'multicc'), 'utf8');
const runtimeCheck = fs.readFileSync(path.join(ROOT, 'scripts/check-runtime-deps.js'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const releaseWorkflowPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
const androidGradle = fs.readFileSync(path.join(ROOT, 'app', 'android', 'app', 'build.gradle.kts'), 'utf8');
const signerPin = fs.readFileSync(path.join(ROOT, 'app', 'android', 'release-cert.sha256'), 'utf8').trim();

const stableCommand = `curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v${pkg.version}/install.sh | bash -s -- --branch v${pkg.version}`;
assert.ok(installer.includes(stableCommand), 'installer help must clone the release tag, not main');
assert.ok(readme.includes(stableCommand), 'README stable command must clone the release tag, not main');
assert.match(installer, /--branch v\$\{INSTALLER_VERSION\}/);

assert.equal(fs.existsSync(releaseWorkflowPath), true, 'release workflow must be version controlled');
const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
assert.match(releaseWorkflow, /^\s*push:\s*[\r\n]+\s*tags:\s*[\r\n]+\s*- ['"]v\*\.\*\.\*['"]/m,
  'only release tags may trigger APK publication');
assert.doesNotMatch(releaseWorkflow, /^\s*(pull_request|workflow_dispatch|release):/m,
  'APK publication must not have a non-tag trigger');
assert.match(releaseWorkflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/,
  'the broad Actions tag glob must be narrowed by a strict SemVer check');
assert.match(releaseWorkflow, /TAG[^\n]+v\$\{?PKG_VERSION\}?/,
  'the release tag must equal package.json version');
assert.match(releaseWorkflow, /flutter-version:\s*['"]?3\.32\.2/);
assert.match(releaseWorkflow, /java-version:\s*['"]?17/);
assert.match(releaseWorkflow, /permissions:[\s\S]*?contents:\s*write/);
for (const secret of [
  'ANDROID_RELEASE_KEYSTORE_BASE64',
  'ANDROID_RELEASE_STORE_PASSWORD',
  'ANDROID_RELEASE_KEY_ALIAS',
  'ANDROID_RELEASE_KEY_PASSWORD',
  'ANDROID_RELEASE_CERT_SHA256',
]) {
  assert.ok(releaseWorkflow.includes(`secrets.${secret}`), `release workflow must require ${secret}`);
}
assert.match(releaseWorkflow, /gh release create/);
assert.match(releaseWorkflow, /multicc\.apk\.json/);
assert.match(releaseWorkflow, /multicc\.apk\.sha256/);
assert.doesNotMatch(releaseWorkflow, /--clobber/, 'published APK assets must never be destructively replaced');
assert.match(signerPin, /^[a-f0-9]{64}$/, 'the official public certificate fingerprint must be pinned');
assert.match(releaseWorkflow, /release-cert\.sha256/,
  'the workflow must bind its signing secret to the repository certificate pin');

for (const name of [
  'MULTICC_ANDROID_KEYSTORE_PATH',
  'MULTICC_ANDROID_STORE_PASSWORD',
  'MULTICC_ANDROID_KEY_ALIAS',
  'MULTICC_ANDROID_KEY_PASSWORD',
]) {
  assert.ok(androidGradle.includes(name), `Gradle must read official signing input ${name}`);
}
assert.doesNotMatch(androidGradle, /signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)/,
  'release builds must never silently fall back to the Android debug key');
assert.match(androidGradle, /GradleException[\s\S]*official release signing/i,
  'a release task without complete official signing input must fail closed');

const beforeCapture = manager.indexOf('before="$(git rev-parse HEAD');
const stableBranch = manager.indexOf('if [ "$channel" = "stable" ]');
const stableAfter = manager.indexOf('after="$(git rev-parse HEAD', stableBranch);
const dependencyDiff = manager.indexOf('Dependencies changed — running npm install');
assert.ok(beforeCapture >= 0 && beforeCapture < stableBranch, 'stable updates must capture the old revision before checkout');
assert.ok(stableAfter > stableBranch, 'stable updates must capture the new revision after checkout');
assert.ok(dependencyDiff > stableAfter, 'stable updates must install changed manifests before restart');
assert.match(manager, /Runtime dependencies are incomplete or outdated — running npm install/);
assert.match(manager, /scripts\/check-runtime-deps\.js/);
assert.match(installer, /npm install \(full package\.json, including @homebridge\/ciao for LAN discovery\)/);
assert.match(runtimeCheck, /requireFn\('@homebridge\/ciao'\)/);
assert.match(manager, /Verifying runtime dependencies before service install/);
assert.ok(manager.indexOf('Runtime dependencies are incomplete — running npm install') > manager.indexOf('do_install()'),
  './multicc install must repair missing runtime packages before registering the service');
assert.match(manager, /wait_for_ready\(\)/);
assert.match(manager, /Waiting for startup migrations and readiness/);
assert.ok(manager.indexOf('if ! wait_for_ready') > manager.indexOf('Restarting to apply update'),
  'the real update path must verify Commander migration readiness after restart');

const cprSpec = pkg.dependencies['cli-provider-router'];
assert.match(cprSpec, /^https:\/\/github\.com\/lsjwzh\/cli-provider-router\/archive\/[0-9a-f]{40}\.tar\.gz$/);
assert.equal(lock.packages[''].dependencies['cli-provider-router'], cprSpec);
assert.equal(lock.packages['node_modules/cli-provider-router'].resolved, cprSpec);
assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^cli-provider-router\/$/m);

const ciaoSpec = pkg.dependencies['@homebridge/ciao'];
assert.equal(ciaoSpec, '^1.3.10');
assert.equal(lock.packages[''].dependencies['@homebridge/ciao'], ciaoSpec);
assert.equal(lock.packages['node_modules/@homebridge/ciao'].version, '1.3.10');

console.log('Release upgrade guard tests passed');
