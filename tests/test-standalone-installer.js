'use strict';

// install.sh and install.ps1 are the two OS-native bootstraps into one shared
// standalone contract. They do something the old git-clone installer never did:
// download a package and
// replaces whatever is at the target path. Both of those can destroy a working
// installation or a user's directory if they misbehave, so they are tested
// against a real archive here rather than by reading the script.
//
// The fixture bundle is deliberately minimal (a runtime shim, the real launcher
// and CLI, an empty server) — it is enough for install.sh and the bundled
// `multicc config` path to run for real, without downloading a 40 MB runtime.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(ROOT, 'install.sh');
const WINDOWS_INSTALLER = path.join(ROOT, 'install.ps1');
const FIXTURE_SERVER = path.join(ROOT, 'tests', 'fixtures', 'desktop-fixture-server.js');
const bundleScript = require(path.join(ROOT, 'scripts', 'standalone-bundle.js'));
const PLATFORM = process.platform;
const ARCH = process.arch;

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

// Where a bundle keeps its read-only payload, exactly as the bundle builder
// lays it out: the .app wrapper on macOS, a sibling Resources/ elsewhere. The
// installer validates the same path, so a fixture that guessed wrong would
// silently test a layout nothing ships.
function resourcesRel(platform = PLATFORM) {
  return platform === 'darwin' ? path.join('MultiCC.app', 'Contents', 'Resources') : 'Resources';
}

// A bundle that is complete enough for install.sh (which checks the wrapper and
// the runtime) and for the CLI's `config` command (which checks the launcher and
// app-server/server.js before running anything).
function buildFixtureBundle(version = '9.9.9') {
  const scratch = tmpdir('multicc-installer-fixture-');
  const name = `multicc-standalone-${version}-${PLATFORM}-${ARCH}`;
  const root = path.join(scratch, name);
  const resources = path.join(root, resourcesRel());
  write(path.join(resources, 'runtime', 'bin', 'node'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, 0o755);
  write(path.join(resources, 'app-server', 'server.js'), `require(${JSON.stringify(FIXTURE_SERVER)});\n`);
  write(path.join(resources, 'app-server', 'package.json'), `${JSON.stringify({ name: 'multicc', version }, null, 2)}\n`);
  write(path.join(resources, 'bundle-manifest.json'),
    `${JSON.stringify({ version, platform: PLATFORM, arch: ARCH }, null, 2)}\n`);
  fs.mkdirSync(path.join(resources, 'launcher', 'lib'), { recursive: true });
  for (const file of ['standalone-launcher.js', 'standalone-cli.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(resources, 'launcher', file));
  }
  for (const file of bundleScript.LAUNCHER_LIB_FILES) {
    fs.copyFileSync(path.join(ROOT, 'desktop', 'lib', file), path.join(resources, 'launcher', 'lib', file));
  }
  write(path.join(root, 'multicc'), bundleScript.multiccWrapper({ platform: PLATFORM }), 0o755);
  write(path.join(root, '使用说明.txt'), 'fixture\n');
  return { scratch, name, root };
}

// Mirrors how the bundle builder packages a directory, including the archive's
// own top-level directory — the shape install.sh has to shed.
function archiveFixture({ scratch, name, root }, { corrupt = false } = {}) {
  const archive = path.join(scratch, `${name}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', archive, '-C', scratch, name], { encoding: 'utf8' });
  assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${corrupt ? 'f'.repeat(64) : digest}  ${path.basename(archive)}\n`);
  return archive;
}

function runInstaller(args, { cwd, env = {} } = {}) {
  return spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    cwd: cwd || ROOT,
    env: { ...process.env, ...env, MULTICC_STANDALONE_HOME: env.MULTICC_STANDALONE_HOME || '' },
  });
}

test('install.sh unpacks, configures, starts, and safely replaces a previous install', t => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const home = tmpdir('multicc-installer-home-');
  const targetParent = tmpdir('multicc-installer-target-');
  const installDir = path.join(targetParent, 'MultiCC');
  const env = { MULTICC_STANDALONE_HOME: home };
  t.after(() => {
    if (fs.existsSync(path.join(installDir, 'multicc'))) {
      spawnSync(path.join(installDir, 'multicc'), ['stop'], {
        encoding: 'utf8', env: { ...process.env, ...env },
      });
    }
  });

  const first = runInstaller([
    '--from', archive, '--dir', installDir, '--token', 'installer-test-token',
    '--port', '3111', '--no-service', '--no-open',
  ], { env });
  assert.equal(first.status, 0, `installer failed:\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /Installation Complete/);
  assert.match(first.stdout, /MultiCC is ready/, 'a normal install must return with a ready server');
  assert.equal(fs.existsSync(path.join(installDir, 'multicc')), true, 'the multicc command must be installed');
  assert.equal(fs.existsSync(path.join(installDir, resourcesRel(), 'runtime', 'bin', 'node')), true,
    'the bundled runtime must be installed');
  assert.equal(fs.existsSync(path.join(installDir, fixture.name)), false,
    'the archive directory level must be stripped, not nested');

  // The config must be written through the bundle's own CLI, into the data
  // directory — never into the package, which is what makes a swap safe.
  const list = spawnSync(path.join(installDir, 'multicc'), ['config', 'list'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /PORT=3111/);
  assert.match(list.stdout, /ACCESS_TOKEN=\*+/, 'the token must never be printed in full by `config list`');
  assert.equal(fs.existsSync(path.join(installDir, 'multicc.env')), false,
    'the config must not be written inside the package');

  const token = spawnSync(path.join(installDir, 'multicc'), ['config', 'get', 'ACCESS_TOKEN'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(token.stdout.trim(), 'installer-test-token');
  const firstStatus = spawnSync(path.join(installDir, 'multicc'), ['status', '--json'], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(firstStatus.status, 0, firstStatus.stderr);
  assert.equal(JSON.parse(firstStatus.stdout).running, true, 'the installer must leave MultiCC running');

  // Reinstalling over a previous installation is an upgrade, not an error.
  const second = runInstaller([
    '--from', archive, '--dir', installDir, '--port', '3111', '--no-service', '--no-open',
  ], { env });
  assert.equal(second.status, 0, `reinstall failed:\n${second.stdout}\n${second.stderr}`);
  assert.equal(second.stdout.includes('Existing installation found'), true, 'an existing install must be reported');
  assert.equal(fs.existsSync(path.join(installDir, 'multicc')), true);
  const tokenAfter = spawnSync(path.join(installDir, 'multicc'), ['config', 'get', 'ACCESS_TOKEN'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(tokenAfter.stdout.trim(), 'installer-test-token',
    'reinstalling without --token must keep the configured token');
  const secondStatus = spawnSync(path.join(installDir, 'multicc'), ['status', '--json'], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(JSON.parse(secondStatus.stdout).running, true,
    'a replacement install must stop the old process and bring the new bundle back up');
  const leftovers = fs.readdirSync(targetParent).filter(name => name.includes('.old-'));
  assert.deepEqual(leftovers, [], 'the replaced installation must not be left behind');
});

test('install.sh refuses to touch a directory that is not a MultiCC install', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const targetParent = tmpdir('multicc-installer-busy-');
  const installDir = path.join(targetParent, 'MultiCC');
  fs.mkdirSync(installDir, { recursive: true });
  const precious = path.join(installDir, 'my-notes.txt');
  fs.writeFileSync(precious, 'do not delete me\n');

  const res = runInstaller(['--from', archive, '--dir', installDir, '--no-service',
    '--token', 't', '--port', '3000'], { env: { MULTICC_STANDALONE_HOME: tmpdir('multicc-installer-home-') } });
  assert.notEqual(res.status, 0, 'installing over an unrelated directory must fail');
  assert.match(`${res.stdout}${res.stderr}`, /does not look like a MultiCC installation/);
  assert.equal(fs.readFileSync(precious, 'utf8'), 'do not delete me\n', 'nothing in that directory may be deleted');
});

test('install.sh never mistakes a source checkout for a replaceable standalone install', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const targetParent = tmpdir('multicc-installer-source-checkout-');
  const installDir = path.join(targetParent, 'MultiCC');
  fs.mkdirSync(path.join(installDir, '.git'), { recursive: true });
  const sourceCommand = path.join(installDir, 'multicc');
  fs.writeFileSync(sourceCommand, '#!/bin/sh\necho source-checkout\n');
  fs.chmodSync(sourceCommand, 0o755);
  fs.writeFileSync(path.join(installDir, 'package.json'), '{"name":"multicc-source"}\n');

  const res = runInstaller(['--from', archive, '--dir', installDir, '--no-start'], {
    env: { MULTICC_STANDALONE_HOME: tmpdir('multicc-installer-home-') },
  });
  assert.notEqual(res.status, 0, 'a source checkout at ~/MultiCC must never be replaced');
  assert.match(`${res.stdout}${res.stderr}`, /does not look like a MultiCC installation/);
  assert.equal(fs.readFileSync(sourceCommand, 'utf8'), '#!/bin/sh\necho source-checkout\n');
  assert.equal(fs.existsSync(path.join(installDir, '.git')), true);
});

test('install.sh refuses a package whose checksum does not match', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture, { corrupt: true });
  const targetParent = tmpdir('multicc-installer-badsum-');
  const installDir = path.join(targetParent, 'MultiCC');

  const res = runInstaller(['--from', archive, '--dir', installDir, '--no-service',
    '--token', 't', '--port', '3000'], { env: { MULTICC_STANDALONE_HOME: tmpdir('multicc-installer-home-') } });
  assert.notEqual(res.status, 0, 'a checksum mismatch must fail the install');
  assert.match(`${res.stdout}${res.stderr}`, /Checksum mismatch/);
  assert.equal(fs.existsSync(installDir), false, 'nothing may be installed from an unverified package');
});

test('install.sh rejects a package that is missing its runtime', () => {
  const fixture = buildFixtureBundle();
  fs.rmSync(path.join(fixture.root, resourcesRel(), 'runtime'), { recursive: true });
  const archive = archiveFixture(fixture);
  const targetParent = tmpdir('multicc-installer-incomplete-');
  const installDir = path.join(targetParent, 'MultiCC');

  const res = runInstaller(['--from', archive, '--dir', installDir, '--no-service',
    '--token', 't', '--port', '3000'], { env: { MULTICC_STANDALONE_HOME: tmpdir('multicc-installer-home-') } });
  assert.notEqual(res.status, 0, 'an incomplete package must be rejected');
  assert.match(`${res.stdout}${res.stderr}`, /incomplete/);
  assert.equal(fs.existsSync(installDir), false);
});

test('install.sh is dependency-free: no git, npm or node on the target machine', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.doesNotMatch(source, /\bgit clone\b/, 'the installer must not clone the repository');
  assert.doesNotMatch(source, /\bgit pull\b/, 'the installer must not pull');
  assert.doesNotMatch(source, /\bnpm install\b/, 'the installer must not install npm dependencies');
  assert.doesNotMatch(source, /command -v node\b/, 'a host Node runtime must not be required');
  // The only tools it may insist on are the downloader, the unpacker and a
  // SHA-256 utility — everything else comes inside the package.
  assert.match(source, /multicc-standalone-\$\{VERSION_NUMBER\}-\$\{PLATFORM\}-\$\{ARCH\}/,
    'the installer must download the standalone package for this platform');
  assert.match(source, /sha256/);
});

test('install.ps1 is the native Windows path over the same standalone contract', () => {
  const source = fs.readFileSync(WINDOWS_INSTALLER, 'utf8');
  assert.match(source, /multicc-standalone-\$ResolvedVersion-win32-x64\.zip/,
    'Windows must consume the same versioned standalone asset family');
  assert.match(source, /Get-FileHash[^\n]+SHA256/,
    'the PowerShell bootstrap must verify the release sidecar before extraction');
  assert.match(source, /Expand-Archive/);
  assert.match(source, /Resources\\runtime\\node\.exe/);
  assert.match(source, /bundle-manifest\.json/);
  assert.match(source, /manifest\.platform[^\n]+win32/);
  assert.match(source, /manifest\.arch[^\n]+x64/);
  assert.match(source, /Join-Path \$env:USERPROFILE 'MultiCC'/,
    'Windows and POSIX installers must both use a stable per-user MultiCC directory');
  assert.match(source, /Invoke-MultiCC @\('config', 'set', 'PORT'/);
  assert.match(source, /Invoke-MultiCC \$startArgs/,
    'a normal Windows install must return only after starting the shared CLI');
  assert.doesNotMatch(source, /\bnpm (?:install|ci)\b|\bgit clone\b/,
    'the Windows target must not need a toolchain either');
});

test('install.sh keeps the old --branch command line working', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(source, /--branch\)\s+need_val[^\n]*VERSION="\$2"/,
    'a previously published --branch <tag> command must still install that release');
});

test('install.sh defaults to a stable home install and exposes headless switches', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(source, /INSTALL_DIR="\$\{INSTALL_DIR:-\$\{HOME:-\$PWD\}\/MultiCC\}"/,
    'a curl-piped install must not depend on the terminal current directory');
  const help = runInstaller(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--no-start/);
  assert.match(help.stdout, /--no-open/);
  assert.match(help.stdout, /starts MultiCC and opens the browser/);
});

test('install.sh really installs at HOME/MultiCC when --dir is omitted', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const home = tmpdir('multicc-installer-default-home-');
  const dataHome = tmpdir('multicc-installer-default-data-');
  const res = runInstaller([
    '--from', archive, '--token', 'installer-test-token', '--no-start',
  ], { cwd: tmpdir('multicc-installer-unrelated-cwd-'), env: { HOME: home, MULTICC_STANDALONE_HOME: dataHome } });
  assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);
  assert.equal(fs.existsSync(path.join(home, 'MultiCC', 'multicc')), true,
    'default install must be stable under HOME, not whichever directory invoked curl');
});
