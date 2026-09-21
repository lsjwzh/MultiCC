'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const installer = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
const windowsInstaller = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
const manager = fs.readFileSync(path.join(ROOT, 'multicc'), 'utf8');
const runtimeCheck = fs.readFileSync(path.join(ROOT, 'scripts/check-runtime-deps.js'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const releaseWorkflowPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
const androidGradle = fs.readFileSync(path.join(ROOT, 'app', 'android', 'app', 'build.gradle.kts'), 'utf8');
const signerPin = fs.readFileSync(path.join(ROOT, 'app', 'android', 'release-cert.sha256'), 'utf8').trim();

// The stable install command is one line with no flags: the tag in the URL is
// the version, and the script installs exactly that. Nothing about it may go
// back to cloning a branch.
const stableCommand = `curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v${pkg.version}/install.sh | bash`;
const stableWindowsCommand = `irm https://raw.githubusercontent.com/lsjwzh/MultiCC/v${pkg.version}/install.ps1 | iex`;
assert.equal(lock.version, pkg.version, 'package-lock root version must match package.json');
assert.equal(lock.packages[''].version, pkg.version,
  'package-lock workspace version must match package.json');
assert.ok(installer.includes(stableCommand), 'installer help must publish the release-tag command, not main');
assert.ok(readme.includes(stableCommand), 'README stable command must use the release tag, not main');
assert.ok(readme.includes(stableWindowsCommand), 'README Windows command must use the same release tag');
// The prefix alone is not enough: `… | bash -s -- --branch v2.0.3` also contains
// it, and that form is exactly what this release replaced. Pin the shape — the
// advertised line ends at `| bash`, with any flags confined to the <details>
// opt-in block that documents them (`--dir`, `--version`, `--from`, …).
const advertisedInstallLines = [...readme.matchAll(/^curl -sSL https:\/\/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/[^\n]*$/gm)]
  .map(match => match[0]);
assert.ok(advertisedInstallLines.includes(stableCommand),
  'README must advertise the flagless install line verbatim');
for (const line of advertisedInstallLines) {
  assert.doesNotMatch(line, /\|\s*bash\s+-s/, `README install line must not pass flags inline: ${line}`);
  assert.doesNotMatch(line, /--branch|--no-clone|--no-apk/, `README install line must not use the retired flags: ${line}`);
}
assert.doesNotMatch(readme, /--branch\s+v?\d+\.\d+\.\d+/, 'README must not document --branch version pinning');
assert.match(readme, /--version latest/, 'README must send "newest release" through --version latest');

// The Chinese README advertises the same line and must not drift from it. Flag
// examples below it are opt-in and abbreviated (`curl -sSL .../install.sh`), so
// only the full-URL lines have to be the flagless one.
const readmeZh = fs.readFileSync(path.join(ROOT, 'README.zh.md'), 'utf8');
assert.ok(readmeZh.includes(stableCommand), 'README.zh.md must advertise the same flagless install line');
assert.ok(readmeZh.includes(stableWindowsCommand), 'README.zh.md must advertise the Windows install line');
for (const line of readmeZh.matchAll(/^curl -sSL https:\/\/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/[^\n]*$/gm)) {
  assert.equal(line[0], stableCommand, 'README.zh.md install line must be flagless, like the English one');
}
assert.match(installer, /--version latest/,
  'the "newest release" path must be an explicit opt-in, not the default');

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
assert.match(releaseWorkflow, /keytool\s+-exportcert/,
  'the workflow must inspect the certificate embedded in the decoded keystore');
assert.match(releaseWorkflow, /openssl\s+dgst\s+-sha256/,
  'the workflow must compare the decoded keystore certificate by SHA-256');
assert.match(releaseWorkflow, /keystore certificate does not match app\/android\/release-cert\.sha256/,
  'the workflow must fail before building when the keystore certificate and pin differ');

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
// The installer no longer builds anything: dependencies and the runtime ship
// inside the package it downloads, so it must not run npm, git or a host node.
assert.doesNotMatch(installer, /npm install/, 'the installer must not install dependencies');
assert.doesNotMatch(installer, /\bgit (clone|pull)\b/, 'the installer must not use git');
assert.match(installer, /multicc-standalone-\$\{VERSION_NUMBER\}/,
  'the installer must download the standalone package');
assert.doesNotMatch(windowsInstaller, /npm (?:install|ci)/,
  'the Windows installer must not install dependencies');
assert.doesNotMatch(windowsInstaller, /\bgit (?:clone|pull)\b/,
  'the Windows installer must not use git');
assert.match(windowsInstaller, /multicc-standalone-\$ResolvedVersion-win32-x64\.zip/,
  'the Windows installer must download the same standalone package family');
assert.match(runtimeCheck, /requireFn\('@homebridge\/ciao'\)/);
assert.match(manager, /Verifying runtime dependencies before service install/);
assert.ok(manager.indexOf('Runtime dependencies are incomplete — running npm install') > manager.indexOf('do_install()'),
  './multicc install must repair missing runtime packages before registering the service');
assert.match(manager, /wait_for_ready\(\)/);
assert.match(manager, /Waiting for startup migrations and readiness/);
assert.ok(manager.indexOf('if ! wait_for_ready') > manager.indexOf('Restarting to apply update'),
  'the real update path must verify Commander migration readiness after restart');
// One-time data migrations (cron fan-out cleanup for installs <= 2.0.2) are
// driven by the pre-update version this path records, and must report back into
// the update output instead of leaving the user with a silently changed board.
assert.match(manager, /\.multicc_upgrade/, 'the update path must record the pre-update version');
assert.ok(manager.indexOf('.multicc_upgrade') < manager.indexOf('Restarting to apply update'),
  'the pre-update version must be recorded before the restart that runs the migration');
assert.match(manager, /cron-fanout-cleanup\.log/, 'the update path must surface the cleanup report');
assert.ok(manager.indexOf('rm -f "$LOG_DIR/cron-fanout-cleanup.log"') < manager.indexOf('Restarting to apply update'),
  'a stale report from an earlier boot must be cleared before the restart that writes a new one');
assert.ok(manager.indexOf('cat "$LOG_DIR/cron-fanout-cleanup.log"') > manager.indexOf('if ! wait_for_ready'),
  'the cleanup report is only printed after readiness');

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
