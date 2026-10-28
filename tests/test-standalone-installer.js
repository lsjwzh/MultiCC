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
  write(path.join(resources, 'app-server', 'plugins', 'chrome-proxy-launcher', 'plugin.json'),
    `${JSON.stringify({ id: 'chrome-proxy-launcher', version })}\n`);
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

// Spawned with detached: true so the installer runs in its own session, without
// the terminal this test suite was started from. That is not cosmetic: every
// question the installer asks is read from /dev/tty, and `[ -r /dev/tty ]` only
// checks the device node's permissions — so from an interactive terminal a plain
// child would block on a prompt that no one is there to answer, and the suite
// would hang instead of failing. Detached, those reads fail immediately, which is
// exactly the no-terminal path a `curl … | bash` install takes.
function runInstaller(args, { cwd, env = {} } = {}) {
  const standaloneHome = env.MULTICC_STANDALONE_HOME || tmpdir('multicc-installer-data-');
  const userHome = env.HOME || tmpdir('multicc-installer-user-');
  const childEnv = {
    ...process.env,
    ...env,
    HOME: userHome,
    MULTICC_INSTALLER_APPLICATIONS_DIR: env.MULTICC_INSTALLER_APPLICATIONS_DIR || path.join(userHome, 'Applications'),
    MULTICC_STANDALONE_HOME: standaloneHome,
    MULTICC_DESKTOP_DIR: env.MULTICC_DESKTOP_DIR || path.join(standaloneHome, 'Desktop'),
  };
  // A test runner hosted by a MultiCC server inherits its PORT. The installer
  // treats PORT as an explicit choice, so an ambient value would change what
  // every test installs. Only a PORT a test asks for is passed through.
  if (!Object.prototype.hasOwnProperty.call(env, 'PORT')) delete childEnv.PORT;
  return spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    cwd: cwd || ROOT,
    detached: true,
    env: childEnv,
  });
}

// A bash child reports directories through its own getcwd, which on macOS answers
// /private/var for what os.tmpdir() calls /var. Comparing against the canonical
// path keeps the assertions below about the installer, not about the filesystem.
function canonical(dir) {
  return fs.realpathSync(dir);
}

// The shape a pre-standalone release leaves behind: the project itself, the
// launcher the old installer generated, the .env it wrote its settings into, and
// the state beside the code — for those releases the package root WAS the data
// root. `dir` is where the old installer happened to be run from.
function writeLegacyInstall(dir, { session = 'legacy-session' } = {}) {
  write(path.join(dir, 'package.json'), '{"name":"multicc","version":"1.6.10"}\n');
  write(path.join(dir, 'multicc'), '#!/bin/sh\nexit 1\n', 0o755);
  write(path.join(dir, '.env'), 'ACCESS_TOKEN=legacy-token\nPORT=3222\n');
  write(path.join(dir, 'sessions.json'), `{"sessions":[{"id":"${session}"}]}\n`);
  write(path.join(dir, 'chat_history', `${session}.jsonl`), '{"role":"user"}\n');
  return dir;
}

function legacyData(session = 'legacy-session') {
  return {
    sessions: `{"sessions":[{"id":"${session}"}]}\n`,
    history: path.join('chat_history', `${session}.jsonl`),
  };
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
  const shortcutName = PLATFORM === 'darwin' ? 'MultiCC.app'
    : PLATFORM === 'win32' ? 'MultiCC.lnk' : 'MultiCC.desktop';
  assert.equal(fs.existsSync(path.join(home, 'Desktop', shortcutName)), true,
    'a normal install must leave a one-click launcher on the desktop');

  // The config must be written through the bundle's own CLI, into the data
  // directory — never into the package, which is what makes a swap safe.
  const list = spawnSync(path.join(installDir, 'multicc'), ['config', 'list'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /PORT=3111/);
  assert.match(list.stdout, /PORT_PINNED=1/, 'an explicit --port must be pinned, not merely a starting point');
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

  // A private plugin copied into the program's plugins/ (what its README says to
  // do), and the built-in one as an older version left it.
  const installedPlugins = path.join(installDir, resourcesRel(), 'app-server', 'plugins');
  write(path.join(installedPlugins, 'gapaw-creator-workbench', 'plugin.json'), '{"id":"gapaw-creator-workbench","version":"0.10.0"}\n');
  write(path.join(installedPlugins, 'gapaw-creator-workbench', 'bin', 'tool'), '#!/bin/sh\n', 0o755);
  write(path.join(installedPlugins, 'chrome-proxy-launcher', 'plugin.json'), '{"id":"chrome-proxy-launcher","version":"old"}\n');

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
  // …but the plugin installed by hand came along; the built-in is the new package's.
  assert.match(second.stdout, /kept plugin gapaw-creator-workbench/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installedPlugins, 'gapaw-creator-workbench', 'plugin.json'), 'utf8')).version, '0.10.0',
    'an upgrade must not lose a plugin someone installed by hand');
  assert.ok(fs.statSync(path.join(installedPlugins, 'gapaw-creator-workbench', 'bin', 'tool')).mode & 0o100, 'still executable');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installedPlugins, 'chrome-proxy-launcher', 'plugin.json'), 'utf8')).version, '9.9.9');
});

// PORT in the environment used to be overwritten by the script's own default,
// so `PORT=3133 ./install.sh` silently installed on 3000. It is as explicit as
// --port and must be pinned the same way.
test('install.sh honours PORT from the environment and pins it', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const home = tmpdir('multicc-installer-home-');
  const targetParent = tmpdir('multicc-installer-target-');
  const installDir = path.join(targetParent, 'MultiCC');
  const env = { MULTICC_STANDALONE_HOME: home, PORT: '3133' };

  const res = runInstaller(['--from', archive, '--dir', installDir, '--token', 't',
    '--no-service', '--no-start', '--no-open'], { env });
  assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /PORT set to 3133 \(pinned/);

  const list = spawnSync(path.join(installDir, 'multicc'), ['config', 'list'],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(list.stdout, /PORT=3133/);
  assert.match(list.stdout, /PORT_PINNED=1/,
    'a port from the environment must not be silently downgraded to a start port');
});

// No port anywhere means "start at 3000 and walk to the first free port", so
// the config must not record a pin that would turn a busy 3000 into a failure.
test('install.sh leaves an unspecified port as a starting port', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const home = tmpdir('multicc-installer-home-');
  const targetParent = tmpdir('multicc-installer-target-');
  const installDir = path.join(targetParent, 'MultiCC');
  const env = { MULTICC_STANDALONE_HOME: home, PORT: '' };

  const res = runInstaller(['--from', archive, '--dir', installDir, '--token', 't',
    '--no-service', '--no-start', '--no-open'], { env });
  assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /PORT set to 3000 \(starting port/);

  const list = spawnSync(path.join(installDir, 'multicc'), ['config', 'list'],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(list.stdout, /PORT=3000/);
  assert.doesNotMatch(list.stdout, /PORT_PINNED/,
    'a default install must not pin 3000 — a busy port has to move forward');
});

// A user coming from a pre-standalone release has an installation the current
// guard does not recognise, because the old installer put the repository itself
// at the install path. That is a published MultiCC install, not a stray
// directory: it must be upgraded rather than refused, its files must survive,
// and the token and port it was configured with must carry over — the user's
// phone, bookmarks and other devices already carry them.
test('install.sh upgrades a pre-standalone source checkout instead of refusing it', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const targetParent = tmpdir('multicc-installer-legacy-');
  const installDir = path.join(targetParent, 'MultiCC');
  const home = tmpdir('multicc-installer-home-');
  const env = { MULTICC_STANDALONE_HOME: home };

  // The shape a v1.x/v2.0.3 install has: the project itself, its dependencies,
  // a launcher, and the .env the old installer wrote its settings into.
  fs.mkdirSync(path.join(installDir, 'node_modules', 'some-dep'), { recursive: true });
  fs.writeFileSync(path.join(installDir, 'package.json'), '{"name":"multicc","version":"1.6.10"}\n');
  fs.writeFileSync(path.join(installDir, 'server.js'), '// legacy entry point\n');
  fs.writeFileSync(path.join(installDir, '.env'), 'ACCESS_TOKEN=legacy-token\nPORT=3222\n');
  const legacyLauncher = path.join(installDir, 'multicc');
  fs.writeFileSync(legacyLauncher, '#!/bin/sh\necho "node not found" >&2\nexit 1\n');
  fs.chmodSync(legacyLauncher, 0o755);
  // The data: for these releases the data root WAS the package root, so the
  // user's sessions, chat history, task databases and memories sat next to the
  // source. `server.js` and `node_modules` above are not data and must not be
  // swept up with them.
  write(path.join(installDir, 'sessions.json'), '{"sessions":[{"id":"legacy-session"}]}\n');
  write(path.join(installDir, 'chat_history', 'legacy-session.jsonl'), '{"role":"user"}\n');
  write(path.join(installDir, 'task-shells.sqlite'), 'SQLite format 3\0legacy\n');
  write(path.join(installDir, 'ui-layout.json'), '{"theme":"dark"}\n');
  write(path.join(installDir, 'memories', 'note.md'), '# remembered\n');
  write(path.join(installDir, 'logs', 'multicc.log'), 'not data\n');
  // A private plugin in the checkout's own plugins/, next to a built-in one.
  write(path.join(installDir, 'plugins', 'private-notes', 'plugin.json'), '{"id":"private-notes","version":"0.1.0"}\n');
  write(path.join(installDir, 'plugins', 'chrome-proxy-launcher', 'plugin.json'), '{"id":"chrome-proxy-launcher","version":"old"}\n');

  const res = runInstaller(['--from', archive, '--dir', installDir, '--yes', '--no-start'], { env });
  assert.equal(res.status, 0, `upgrading an old installation must succeed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /older MultiCC installation/i,
    'an old installation must be reported, not silently replaced');

  // The previous installation is kept whole next to the new one, never deleted.
  const backups = fs.readdirSync(targetParent).filter(name => name.includes('.legacy-'));
  assert.equal(backups.length, 1, 'the previous installation must be kept as a backup');
  const backup = path.join(targetParent, backups[0]);
  assert.equal(fs.readFileSync(path.join(backup, 'package.json'), 'utf8'),
    '{"name":"multicc","version":"1.6.10"}\n', 'the backup must keep the old tree');
  assert.equal(fs.existsSync(path.join(backup, 'server.js')), true);
  const newPlugins = path.join(installDir, resourcesRel(), 'app-server', 'plugins');
  assert.equal(JSON.parse(fs.readFileSync(path.join(newPlugins, 'private-notes', 'plugin.json'), 'utf8')).version, '0.1.0',
    'a plugin installed by hand in the old checkout comes along');
  assert.equal(JSON.parse(fs.readFileSync(path.join(newPlugins, 'chrome-proxy-launcher', 'plugin.json'), 'utf8')).version, '9.9.9',
    'the built-in is the new package\'s');
  assert.equal(fs.existsSync(path.join(backup, 'node_modules', 'some-dep')), true,
    'a kept backup must not be trimmed');
  assert.equal(fs.readFileSync(path.join(backup, '.env'), 'utf8'),
    'ACCESS_TOKEN=legacy-token\nPORT=3222\n', 'the old settings must stay readable in the backup');

  // What landed at the install path is the real standalone package.
  assert.equal(fs.existsSync(path.join(installDir, resourcesRel(), 'bundle-manifest.json')), true);
  assert.equal(fs.existsSync(path.join(installDir, 'multicc')), true);

  // The settings the user already relies on followed them across the upgrade.
  const token = spawnSync(path.join(installDir, 'multicc'), ['config', 'get', 'ACCESS_TOKEN'],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(token.stdout.trim(), 'legacy-token',
    'the token from the old installation must be reused, or every saved URL breaks');
  const list = spawnSync(path.join(installDir, 'multicc'), ['config', 'list'],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(list.stdout, /PORT=3222/, 'the port from the old installation must be reused');

  // And the data came with them. The destination is `<userData>/data`, which is
  // what the launcher hands the server as MULTICC_DATA_DIR (desktop/lib/
  // desktop-env.js) — a copy that missed it would leave every session invisible
  // while reporting a clean upgrade.
  const dataDir = path.join(home, 'data');
  assert.equal(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8'),
    '{"sessions":[{"id":"legacy-session"}]}\n', 'sessions must be brought across');
  assert.equal(fs.existsSync(path.join(dataDir, 'chat_history', 'legacy-session.jsonl')), true,
    'chat history must be brought across');
  assert.equal(fs.existsSync(path.join(dataDir, 'task-shells.sqlite')), true,
    'the task databases must be brought across');
  assert.equal(fs.existsSync(path.join(dataDir, 'ui-layout.json')), true);
  // memories are not inside data/ by accident: desktop-env sets memoryRoot to
  // `<dataRoot>/memories`, so the old memories/ dir has to land exactly there.
  assert.equal(fs.readFileSync(path.join(dataDir, 'memories', 'note.md'), 'utf8'), '# remembered\n',
    'memories must land on the memory root the launcher uses');
  // The code that happened to live in the same directory is not data.
  assert.equal(fs.existsSync(path.join(dataDir, 'node_modules')), false,
    'dependencies must not be copied into the data directory');
  assert.equal(fs.existsSync(path.join(dataDir, 'server.js')), false,
    'the old server entry point must not be copied into the data directory');
  assert.equal(fs.existsSync(path.join(dataDir, 'logs')), false,
    'logs are not state and must not be copied');
  // A copy, never a move: the backup still holds the originals.
  assert.equal(fs.existsSync(path.join(backup, 'sessions.json')), true,
    'the backup must keep its own copy of the data');
  assert.match(res.stdout, /Brought your data across/i);
});

// Declining, or asking for it up front, has to actually leave the data alone:
// the whole point of the prompt is that it is safe to say no.
test('install.sh leaves the old data in the backup when asked to', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const targetParent = tmpdir('multicc-installer-nodata-');
  const installDir = path.join(targetParent, 'MultiCC');
  const home = tmpdir('multicc-installer-nodata-home-');
  const env = { MULTICC_STANDALONE_HOME: home };

  write(path.join(installDir, 'package.json'), '{"name":"multicc","version":"1.6.10"}\n');
  // The launcher is what makes it an installation rather than a loose copy of
  // the sources, and the guard deliberately still requires it.
  write(path.join(installDir, 'multicc'), '#!/bin/sh\nexit 1\n', 0o755);
  write(path.join(installDir, 'sessions.json'), '{"sessions":[{"id":"legacy-session"}]}\n');
  write(path.join(installDir, 'chat_history', 'x.jsonl'), '{}\n');

  const res = runInstaller(['--from', archive, '--dir', installDir, '--yes', '--no-data', '--no-start'], { env });
  assert.equal(res.status, 0, `--no-data must still install:\n${res.stdout}\n${res.stderr}`);

  const backups = fs.readdirSync(targetParent).filter(name => name.includes('.legacy-'));
  assert.equal(backups.length, 1, 'the old installation must still be kept as a backup');
  const backup = path.join(targetParent, backups[0]);
  assert.equal(fs.existsSync(path.join(backup, 'sessions.json')), true);
  assert.equal(fs.existsSync(path.join(home, 'data')), false,
    '--no-data must not create or fill the data directory');
  assert.match(res.stdout, /data stays in the backup/i,
    'the user must be told the data was left behind, not left to discover it');
});

// The oldest installer put MultiCC wherever it happened to be run from
// ($PWD/MultiCC by default), while today's release installs to a fixed per-user
// directory. So the installation with the user's history in it is routinely NOT
// the path this run installs into — and a run that only looks at its own target
// reports a clean first install and leaves every session behind.
test('install.sh finds a pre-standalone installation that is not at the install path', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const cwd = canonical(tmpdir('multicc-installer-elsewhere-'));
  const legacy = writeLegacyInstall(path.join(cwd, 'MultiCC'));
  const data = legacyData();
  const targetParent = tmpdir('multicc-installer-elsewhere-target-');
  const installDir = path.join(targetParent, 'MultiCC');
  const home = tmpdir('multicc-installer-elsewhere-home-');
  // HOME is redirected so the search is hermetic: the login service a real
  // installation on this machine may have registered is read from
  // ~/Library/LaunchAgents, and a developer machine is not a test fixture.
  const env = {
    HOME: tmpdir('multicc-installer-elsewhere-fakehome-'),
    MULTICC_STANDALONE_HOME: home,
  };

  const res = runInstaller([
    '--from', archive, '--dir', installDir, '--token', 'installer-test-token',
    '--port', '3121', '--no-service', '--no-start', '--no-open',
  ], { cwd, env });
  assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /Another MultiCC installation is on this machine/,
    'an installation elsewhere on the machine must be reported, not ignored');
  assert.ok(res.stdout.includes(legacy),
    `the installer must name the directory it found:\n${res.stdout}`);
  assert.match(res.stdout, /still holds data for you/i,
    'the summary has to say where the history is, not just that something was skipped');
  assert.match(res.stdout, /--adopt-data/, 'and the one switch that would include it');

  // Reported, never obeyed. There is no terminal on this run, and a question
  // nobody can answer must fall on the side that changes nothing: the installer
  // must not copy a directory the user did not name.
  assert.equal(fs.existsSync(path.join(home, 'data')), false,
    'no data may be copied when there was nobody to ask');
  // The other installation is read-only to this run: not stopped, not renamed,
  // not upgraded, and nothing new beside it.
  assert.deepEqual(fs.readdirSync(cwd), ['MultiCC'],
    'the installation that was found must not be moved or added to');
  assert.equal(fs.readFileSync(path.join(legacy, 'sessions.json'), 'utf8'), data.sessions,
    'its data must still be there, exactly as it was');

  // A first install of a fresh package, not a rebuild of the old one.
  assert.equal(fs.existsSync(path.join(installDir, 'multicc')), true,
    'the install itself must still complete');
  const token = spawnSync(path.join(installDir, 'multicc'), ['config', 'get', 'ACCESS_TOKEN'],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(token.stdout.trim(), 'installer-test-token',
    "the other installation's token is not taken — each installation is configured on its own");
});

// The switch for someone who knows where their old installation is, and wants it
// in the new one. The source is a source: read, never written, never moved.
test('install.sh --adopt-data copies the named installation in and leaves it where it is', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const cwd = canonical(tmpdir('multicc-installer-adopt-'));
  const legacy = writeLegacyInstall(path.join(cwd, 'MultiCC'));
  const data = legacyData();
  const targetParent = tmpdir('multicc-installer-adopt-target-');
  const installDir = path.join(targetParent, 'MultiCC');
  const home = tmpdir('multicc-installer-adopt-home-');
  const env = {
    HOME: tmpdir('multicc-installer-adopt-fakehome-'),
    MULTICC_STANDALONE_HOME: home,
  };

  const res = runInstaller([
    '--from', archive, '--dir', installDir, '--token', 'installer-test-token',
    '--port', '3122', '--adopt-data', legacy, '--no-service', '--no-start', '--no-open',
  ], { cwd, env });
  assert.equal(res.status, 0, `installer failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /Using the data of the older installation/, 'the named path must be used');
  assert.match(res.stdout, /Brought your data across/i);

  // The data is where the launcher looks for it: `<userData>/data`.
  const dataDir = path.join(home, 'data');
  assert.equal(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8'), data.sessions,
    'the named installation must be brought across');
  assert.equal(fs.existsSync(path.join(dataDir, data.history)), true,
    'and so must its chat history');
  // A copy, never a move: the source keeps everything, and nothing was created
  // next to it — no backup rename, which would be a destructive surprise on a
  // directory this run was only told to read.
  assert.equal(fs.readFileSync(path.join(legacy, 'sessions.json'), 'utf8'), data.sessions,
    'the source installation must be left exactly as it was');
  assert.deepEqual(fs.readdirSync(cwd), ['MultiCC'],
    'the installation named with --adopt-data must not be renamed or added to');
});

test('install.sh refuses --adopt-data on a directory that is not an older installation', () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const notAnInstall = tmpdir('multicc-installer-adopt-bad-');
  fs.writeFileSync(path.join(notAnInstall, 'my-notes.txt'), 'do not read me\n');
  const installDir = path.join(tmpdir('multicc-installer-adopt-bad-target-'), 'MultiCC');

  const res = runInstaller([
    '--from', archive, '--dir', installDir, '--adopt-data', notAnInstall,
    '--no-service', '--no-start', '--no-open',
  ], { env: { MULTICC_STANDALONE_HOME: tmpdir('multicc-installer-adopt-bad-home-') } });
  assert.notEqual(res.status, 0, 'an unrelated directory must not be accepted as a data source');
  assert.match(`${res.stdout}${res.stderr}`, /not a pre-standalone MultiCC installation/);
  assert.equal(fs.readFileSync(path.join(notAnInstall, 'my-notes.txt'), 'utf8'), 'do not read me\n');
  assert.equal(fs.existsSync(installDir), false,
    'the path is checked before anything is downloaded, so a bad one installs nothing');
});

// The question the installer asks has to be unanswerable the same way on both
// platforms: with no terminal, the safe answer is the one nobody chose.
test('both installers decline to copy data they cannot ask about', () => {
  const sh = fs.readFileSync(INSTALLER, 'utf8');
  const ps1 = fs.readFileSync(WINDOWS_INSTALLER, 'utf8');
  assert.match(sh, /answer <\/dev\/tty \|\| answer="__no_terminal__"/,
    'install.sh must distinguish "no terminal" from the enter key, which means yes');
  assert.match(ps1, /\[Console\]::IsInputRedirected/,
    'install.ps1 must not fall back to the default answer when there is no console');
  assert.match(ps1, /\[string\]\$AdoptData/,
    'Windows needs the POSIX --adopt-data escape hatch too');
  assert.match(ps1, /function Find-LegacyElsewhere/,
    'an installation that is not at the install path must be found on Windows too');
  assert.match(ps1, /function Test-LegacyInstallRunning/,
    'both installers have to warn before copying from a running installation');
});


// install.ps1 is the one part of the installer that cannot run on the machine
// this suite runs on, so the Windows upgrade path is the one place a wrong
// directory could still be copied from unnoticed. Skipped where there is no
// PowerShell — but the images that build the Windows package have it.
test('install.ps1 copies from an old installation found elsewhere, and only when told to', t => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
  if (pwsh.error || pwsh.status !== 0) {
    t.skip('pwsh is not installed here');
    return;
  }

  const fixture = canonical(tmpdir('multicc-installer-ps1-adopt-'));
  const legacy = writeLegacyInstall(path.join(fixture, 'work', 'MultiCC'));
  fs.mkdirSync(path.join(legacy, 'node_modules', 'some-dep'), { recursive: true });

  const res = spawnSync('pwsh', [
    '-NoProfile', '-File', path.join(__dirname, 'fixtures', 'install-ps1-adopt-harness.ps1'),
    '-Installer', WINDOWS_INSTALLER, '-Fixture', fixture,
  ], { encoding: 'utf8', detached: true });
  assert.equal(res.status, 0, `the Windows adopt path failed:\n${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /FAIL/, res.stdout);
  assert.match(res.stdout, /all checks passed/);
});

// install.sh is a bash script, but callers do not always say so: the web
// updater used to run the copy it had just downloaded through /bin/sh, which on
// macOS is bash in POSIX mode. The script got as far as resolving the release
// and then died with "syntax error near unexpected token '<'" on the first
// process substitution — an update that looks like it started and then stops.
test('install.sh re-execs itself under bash when it was started by sh', () => {
  const res = spawnSync('/bin/sh', [INSTALLER, '--help'], { encoding: 'utf8', cwd: ROOT, detached: true });
  assert.equal(res.status, 0, `install.sh under /bin/sh failed:\n${res.stdout}\n${res.stderr}`);
  assert.doesNotMatch(`${res.stdout}${res.stderr}`, /syntax error/);
  assert.match(res.stdout, /One-Click Installer/);
  const sh = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(sh, /BASH_VERSION:-\}/, 'install.sh must detect a non-bash shell and re-exec');
});

// The two installers have to agree on what counts as data. A name that is on one
// list and not the other is a platform that silently loses that file on upgrade,
// and nothing else in the suite would notice.
test('both installers carry across exactly the same set of data files', () => {
  const sh = fs.readFileSync(INSTALLER, 'utf8');
  const shBlock = sh.slice(sh.indexOf('legacy_data_items() {'));
  const shList = shBlock.slice(shBlock.indexOf("printf '%s\\n'"), shBlock.indexOf('\n}'))
    .replace(/\\\n/g, ' ')
    .split(/\s+/)
    .map(token => token.replace(/[\\;]/g, ''))
    .filter(token => /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(token))
    .filter(token => token !== 'printf');

  const ps1 = fs.readFileSync(WINDOWS_INSTALLER, 'utf8');
  const ps1Block = (ps1.match(/\$script:LegacyDataItems = @\(([\s\S]*?)\n\)/) || [])[1];
  assert.ok(ps1Block, 'the Windows data list must be a literal array this test can read');
  const ps1List = (ps1Block.match(/'([^']+)'/g) || []).map(quoted => quoted.slice(1, -1));

  assert.ok(shList.length > 30, `the POSIX list must not have collapsed: ${shList.join(',')}`);
  assert.deepEqual([...shList].sort(), [...ps1List].sort(),
    'the POSIX and Windows data lists must be identical');
  // Spot-check the ones whose absence is the whole point of the migration.
  for (const required of ['sessions.json', 'chat_history', 'task-shells.sqlite', 'memories', 'secrets.json']) {
    assert.ok(shList.includes(required), `${required} must be on the list`);
  }
  // And the ones that must never be: the code that happened to sit beside them.
  for (const forbidden of ['node_modules', '.git', 'package.json', 'server.js', 'src']) {
    assert.ok(!shList.includes(forbidden), `${forbidden} must never be copied as data`);
  }
});

// The old guard's protection must survive this: a directory that is merely
// not-MultiCC, even one holding a launcher-shaped file, is still refused.
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

// `$VAR` is a name that bash (and PowerShell) keep reading past the ASCII
// boundary: "$PROFILE_ENTRY（" is one variable called PROFILE_ENTRY（. Under
// `set -u` the whole installer dies the moment such a message is built — the
// upgrade-lock error killed the run before it could refuse, so the lock test
// above saw exit 0 and no message. Braces are the fix; scan every shell script
// this repo ships so the next Chinese sentence cannot hide the same defect.
test('shell scripts never glue $VAR to a non-ASCII character', () => {
  const files = [
    INSTALLER,
    WINDOWS_INSTALLER,
    path.join(ROOT, 'multicc'),
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(name => name.endsWith('.sh'))
      .map(name => path.join(ROOT, 'scripts', name)),
  ];
  const glued = /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/g;
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(glued)) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(ROOT, file)}:${line} ${JSON.stringify(source.slice(match.index, match.index + 24))}`);
    }
  }
  assert.deepEqual(offenders, [], 'write ${VAR} instead of $VAR when the next character is non-ASCII');
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
  assert.match(source, /function Test-LegacyInstall/,
    'an installation from before the standalone package must be recognised, not refused');
  assert.match(source, /function Read-LegacyEnv/,
    'the token and port the old installation was configured with must be carried over');
  assert.match(source, /\$legacyDir = "\$InstallDir\.legacy-/,
    'the old installation must be renamed aside and kept, never deleted');
  assert.match(source, /\[switch\]\$Yes/,
    'the upgrade prompt needs a headless escape hatch, like the POSIX --yes');
  assert.match(source, /\[switch\]\$NoData/,
    'Windows needs the POSIX --no-data escape hatch too');
  assert.match(source, /\[switch\]\$NoShortcut/);
  assert.match(source, /CreateShortcut\(\$shortcutPath\)/,
    'the native Windows installer must create a desktop launcher');
  assert.match(source, /function Copy-LegacyDataAcross/,
    "the old installation's data must be brought across, or a Windows upgrade looks empty");
  assert.match(source, /Split-Path -Parent \$envFile\) 'data'/,
    'the data directory must be derived from what the CLI reports, not hard-coded');
  assert.match(source, /Invoke-MultiCC @\('config', 'set', 'PORT'/);
  assert.match(source, /Invoke-MultiCC \$startArgs/,
    'a normal Windows install must return only after starting the shared CLI');
  assert.doesNotMatch(source, /\bnpm (?:install|ci)\b|\bgit clone\b/,
    'the Windows target must not need a toolchain either');
});

test('install.ps1 stays ASCII so Windows PowerShell 5.1 can read it from disk', () => {
  const bytes = fs.readFileSync(WINDOWS_INSTALLER);
  // powershell.exe 5.1 is what a Windows user has by default, and it reads a
  // .ps1 with no BOM as ANSI text. A UTF-8 em dash then arrives as mojibake whose
  // bytes cp1252 maps to typographic quotes — and PowerShell accepts those as
  // string delimiters, so the quote balance shifts and the file stops parsing at
  // all ("The string is missing the terminator: '"). v2.1.2 shipped with 65 such
  // characters: the Windows smoke failed, which skipped the release job, and that
  // release never got its standalone or desktop assets. The documented
  // `irm … | iex` one-liner decodes the response as UTF-8 and hid this; only the
  // file on disk (and -From) sees it. A BOM is not the fix either — the pipeline
  // path would then begin with U+FEFF and fail as a stray character.
  const nonAscii = [...new Set([...bytes.toString('utf8')].filter(char => char.charCodeAt(0) > 127))];
  assert.deepEqual(nonAscii, [], 'install.ps1 must stay ASCII-only (see the comment above)');
});

test('both installers verify the new package before they touch the old installation', () => {
  const sh = fs.readFileSync(INSTALLER, 'utf8');
  const ps1 = fs.readFileSync(WINDOWS_INSTALLER, 'utf8');
  // A failed or corrupt download must never disturb an installation that still
  // works, so the rename-aside has to come after the download is verified.
  assert.ok(sh.indexOf('prepare_legacy_upgrade "$INSTALL_DIR"') > sh.indexOf('Checksum verified'),
    'install.sh must verify the download before renaming the old installation aside');
  assert.ok(ps1.indexOf('Test-LegacyInstall $InstallDir') > ps1.indexOf('Assert-Bundle $staged'),
    'install.ps1 must validate the staged package before renaming the old installation aside');
});

test('both installers put the old directory back when the new one cannot land', () => {
  const sh = fs.readFileSync(INSTALLER, 'utf8');
  const ps1 = fs.readFileSync(WINDOWS_INSTALLER, 'utf8');
  // Otherwise a half-finished install leaves someone with neither the new
  // installation nor a working old one.
  assert.match(sh, /\[ -n "\$LEGACY_DIR" \] && \[ -d "\$LEGACY_DIR" \]/,
    'install.sh must restore the previous installation when the move fails');
  assert.match(ps1, /IsNullOrWhiteSpace\(\$legacyDir\)[\s\S]{0,140}Move-Item -LiteralPath \$legacyDir -Destination \$InstallDir/,
    'install.ps1 must restore the previous installation when the move fails');
});

test('both installers copy hand-installed plugins across before the old directory goes', () => {
  const sh = fs.readFileSync(INSTALLER, 'utf8');
  const ps1 = fs.readFileSync(WINDOWS_INSTALLER, 'utf8');
  const carry = sh.indexOf('__carry-plugins --from "$CARRY_FROM"');
  assert.ok(carry > sh.indexOf('mv "$UNPACK_DIR" "$INSTALL_DIR"') && carry < sh.indexOf('UPGRADE_COMMITTED=true\n'),
    'install.sh must copy plugins after the new package lands and before the old one is removed');
  assert.match(sh, /if \[ -n "\$OLD_DIR" \] && \[ "\$PLUGINS_LEFT_BEHIND" != "\$OLD_DIR" \]; then rm -rf "\$OLD_DIR"; fi/,
    'install.sh must keep the old directory when a plugin could not be copied');
  const ps1Carry = ps1.indexOf('__carry-plugins --from $carryFrom');
  assert.ok(ps1Carry > ps1.indexOf('Move-Item -LiteralPath $staged -Destination $InstallDir') && ps1Carry < ps1.indexOf('Remove-Item -LiteralPath $oldDir -Recurse -Force'),
    'install.ps1 must copy plugins before it removes the old directory');
  assert.match(ps1, /if \(\$pluginsCopied -and [^\n]*\$oldDir[^\n]*\)\s*\{\s*Remove-Item -LiteralPath \$oldDir -Recurse -Force/,
    'install.ps1 must keep the old directory when a plugin could not be copied');
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
  assert.match(help.stdout, /--no-shortcut/);
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

function writeDesktopApp(app) {
  write(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.lsjwzh.multicc</string></dict></plist>`);
  write(path.join(app, 'Contents', 'MacOS', 'MultiCC'), 'desktop sentinel\n');
}

test('coexisting desktop and standalone require a target; --yes cannot guess it', { skip: PLATFORM !== 'darwin' }, () => {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const home = tmpdir('multicc-coexist-');
  const target = path.join(home, 'MultiCC');
  fs.cpSync(fixture.root, target, { recursive: true });
  const desktop = path.join(home, 'Applications', 'MultiCC.app');
  writeDesktopApp(desktop);
  write(path.join(target, 'old-marker'), 'keep');
  const res = runInstaller(['--from', archive, '--yes', '--no-start'], { env: { HOME: home } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /standalone.*MultiCC/);
  assert.match(res.stdout, /desktop.*MultiCC\.app/);
  assert.match(res.stdout, /--target standalone/);
  assert.equal(fs.readFileSync(path.join(target, 'old-marker'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(desktop, 'Contents', 'MacOS', 'MultiCC'), 'utf8'), 'desktop sentinel\n');

  const selected = runInstaller(['--target', 'standalone', '--from', archive, '--no-start'], { env: { HOME: home } });
  assert.equal(selected.status, 0, `${selected.stdout}\n${selected.stderr}`);
  assert.equal(fs.existsSync(path.join(target, 'old-marker')), false);
  assert.equal(fs.readFileSync(path.join(desktop, 'Contents', 'MacOS', 'MultiCC'), 'utf8'), 'desktop sentinel\n');
});

test('an explicit desktop target gives the desktop release and cannot take a standalone archive', () => {
  const selected = runInstaller(['--target', 'desktop', '--version', 'v9.9.9']);
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /releases\/tag\/v9\.9\.9/);
  const latest = runInstaller(['--target', 'desktop', '--version', 'latest']);
  assert.equal(latest.status, 0);
  assert.match(latest.stdout, /releases\/latest/);
  const incompatible = runInstaller(['--target', 'desktop', '--from', '/unused']);
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stdout, /cannot be combined/);
});

test('even --dir and --yes cannot replace an Electron app with a standalone', { skip: PLATFORM !== 'darwin' }, () => {
  const parent = tmpdir('multicc-desktop-target-');
  const app = path.join(parent, 'MultiCC.app');
  writeDesktopApp(app);
  for (const target of [parent, app]) {
    const res = runInstaller(['--dir', target, '--yes', '--no-start']);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /不能用独立包覆盖/);
    assert.equal(fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'MultiCC'), 'utf8'), 'desktop sentinel\n');
  }
});

test('multiple standalone locations need --dir even with --target standalone', () => {
  const fixture = buildFixtureBundle();
  const home = tmpdir('multicc-multiple-');
  fs.cpSync(fixture.root, path.join(home, 'MultiCC'), { recursive: true });
  const res = runInstaller(['--target', 'standalone', '--no-start'], { cwd: fixture.root, env: { HOME: home } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /--dir/);
  assert.equal(fs.existsSync(path.join(fixture.root, 'multicc')), true);
});

// A launchctl substitute with a real plist and real standalone bundle. It
// starts only the fixture server; no real login job is ever touched.
function serviceFixture() {
  const fixture = buildFixtureBundle();
  const archive = archiveFixture(fixture);
  const home = tmpdir('multicc-service-user-');
  const target = path.join(home, 'MultiCC');
  fs.cpSync(fixture.root, target, { recursive: true });
  write(path.join(target, 'old-marker'), 'previous version');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.multicc.server.plist');
  write(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>ProgramArguments</key><array><string>${target}/${resourcesRel()}/runtime/bin/node</string></array>
</dict></plist>`);
  const bin = path.join(home, 'test-tools');
  const events = path.join(home, 'events');
  const loaded = path.join(home, 'loaded');
  write(loaded, 'yes');
  const original = fs.readFileSync(path.join(target, 'multicc'), 'utf8');
  write(path.join(target, 'multicc'), original.replace('#!/bin/sh', '#!/bin/sh\necho "old:$1" >> "$TEST_EVENTS"'), 0o755);
  write(path.join(bin, 'launchctl'), `#!/bin/sh
case "$1" in
  list) [ -f "$TEST_LOADED" ] || exit 1; cat "$TEST_PLIST" ;;
  unload)
    echo unload >> "$TEST_EVENTS"
    [ "$TEST_FAIL_UNLOAD" != 1 ] || exit 1
    rm -f "$TEST_LOADED" ;;
  load)
    echo load >> "$TEST_EVENTS"
    touch "$TEST_LOADED"
    MULTICC_SERVICE=1 "$TEST_TARGET/multicc" start --no-open > /dev/null 2>&1 ;;
  *) exit 1 ;;
esac
`, 0o755);
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}`,
    MULTICC_STANDALONE_HOME: path.join(home, 'state'),
    TEST_EVENTS: events, TEST_LOADED: loaded, TEST_PLIST: plist, TEST_TARGET: target };
  return { archive, home, target, plist, bin, events, loaded, env };
}

test('upgrading a loaded service unloads before stop and reloads only after swap, retaining its port', { skip: PLATFORM !== 'darwin' }, t => {
  const f = serviceFixture();
  t.after(() => spawnSync(path.join(f.target, 'multicc'), ['stop'], { env: { ...process.env, ...f.env } }));
  spawnSync(path.join(f.target, 'multicc'), ['config', 'set', 'PORT', '3421'], { env: { ...process.env, ...f.env } });
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-service', '--no-open'], { env: f.env });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const events = fs.readFileSync(f.events, 'utf8').trim().split('\n');
  assert.ok(events.indexOf('unload') < events.indexOf('old:stop'), events.join('\n'));
  assert.ok(events.indexOf('old:stop') < events.indexOf('load'), events.join('\n'));
  assert.equal(fs.existsSync(path.join(f.target, 'old-marker')), false);
  assert.equal(fs.existsSync(f.loaded), true);
  assert.match(res.stdout, /PORT set to 3421/);
  assert.equal(fs.readdirSync(f.home).some(name => name.startsWith('MultiCC.old-')), false);
});

test('--no-start pauses a loaded service and leaves it registered without relaunching', { skip: PLATFORM !== 'darwin' }, () => {
  const f = serviceFixture();
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-start'], { env: f.env });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const events = fs.readFileSync(f.events, 'utf8');
  assert.match(events, /unload[\s\S]*old:stop/);
  assert.doesNotMatch(events, /^load$/m);
  assert.equal(fs.existsSync(f.plist), true);
  assert.equal(fs.existsSync(f.loaded), false);
});

test('a service that cannot be paused blocks the swap', { skip: PLATFORM !== 'darwin' }, () => {
  const f = serviceFixture();
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-start'], { env: { ...f.env, TEST_FAIL_UNLOAD: '1' } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /无法暂停/);
  assert.equal(fs.readFileSync(path.join(f.target, 'old-marker'), 'utf8'), 'previous version');
  assert.doesNotMatch(fs.readFileSync(f.events, 'utf8'), /old:stop/);
});

test('暂停服务清除 PID 记录后，升级仍须确认此前的进程已退出', { skip: PLATFORM !== 'darwin' }, () => {
  const f = serviceFixture();
  const statusFile = path.join(f.home, 'old-status.json');
  write(statusFile, JSON.stringify({ pid: process.pid, dataDir: f.env.MULTICC_STANDALONE_HOME }));
  // 只模拟状态和停机命令，不向真实进程发信号。
  write(path.join(f.target, 'multicc'), `#!/bin/sh
echo "old:$1" >> "$TEST_EVENTS"
case "$1" in
  status)
    if [ -f "$TEST_STATUS" ]; then cat "$TEST_STATUS"
    else printf '{"pid":null,"dataDir":"%s"}\\n' "$MULTICC_STANDALONE_HOME"; fi ;;
  stop|start) exit 0 ;;
  *) exit 1 ;;
esac
`, 0o755);
  const service = path.join(f.bin, 'launchctl');
  fs.writeFileSync(service, fs.readFileSync(service, 'utf8').replace(
    'rm -f "$TEST_LOADED"', 'rm -f "$TEST_LOADED" "$TEST_STATUS"',
  ));
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-start'], {
    env: { ...f.env, TEST_STATUS: statusFile },
  });
  assert.notEqual(res.status, 0, res.stdout);
  assert.match(res.stdout, /旧进程.*仍在运行/);
  assert.equal(fs.readFileSync(path.join(f.target, 'old-marker'), 'utf8'), 'previous version');
  const events = fs.readFileSync(f.events, 'utf8').trim().split('\n');
  assert.ok(events.indexOf('old:status') < events.indexOf('unload'), events.join('\n'));
  assert.equal(fs.readdirSync(f.home).some(name => name.startsWith('MultiCC.old-')), false);
});

test('a failed replacement restores the previous files and reloads its service', { skip: PLATFORM !== 'darwin' }, t => {
  const f = serviceFixture();
  t.after(() => spawnSync(path.join(f.target, 'multicc'), ['stop'], { env: { ...process.env, ...f.env } }));
  write(path.join(f.bin, 'mv'), `#!/bin/sh
case "$1" in */unpacked) exit 1 ;; esac
exec /bin/mv "$@"
`, 0o755);
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-start'], { env: f.env });
  assert.notEqual(res.status, 0);
  assert.equal(fs.readFileSync(path.join(f.target, 'old-marker'), 'utf8'), 'previous version');
  assert.equal(fs.existsSync(f.loaded), true);
  assert.match(fs.readFileSync(f.events, 'utf8'), /unload[\s\S]*old:stop[\s\S]*load/);
});

test('a service owned by another install is never unloaded or reconfigured', { skip: PLATFORM !== 'darwin' }, () => {
  const f = serviceFixture();
  const other = path.join(f.home, 'other-install');
  fs.writeFileSync(f.plist, fs.readFileSync(f.plist, 'utf8').replace(f.target, other));
  const originalPlist = fs.readFileSync(f.plist, 'utf8');
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-start'], { env: f.env });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), originalPlist);
  assert.doesNotMatch(fs.readFileSync(f.events, 'utf8'), /^(unload|load)$/m);
  assert.equal(fs.existsSync(f.loaded), true);
});

test('a loaded job with different arguments blocks the upgrade without unloading it', { skip: PLATFORM !== 'darwin' }, () => {
  const f = serviceFixture();
  const loadedPlist = path.join(f.home, 'loaded-job.plist');
  fs.writeFileSync(loadedPlist, fs.readFileSync(f.plist, 'utf8').replace(f.target, path.join(f.home, 'other')));
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-start'], { env: { ...f.env, TEST_PLIST: loadedPlist } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /已加载的开机服务与目标安装不一致/);
  assert.equal(fs.readFileSync(path.join(f.target, 'old-marker'), 'utf8'), 'previous version');
  assert.equal(fs.existsSync(f.events), false);
});

test('a stop that reports success while its recorded pid remains alive cannot swap files', { skip: PLATFORM !== 'darwin' }, () => {
  const f = serviceFixture();
  const state = JSON.stringify({ pid: process.pid, dataDir: path.join(f.home, 'state') });
  // A false-success stop; the test runner is only probed with kill -0. No
  // command in this fixture signals it, and start is also intercepted.
  write(path.join(f.target, 'multicc'), `#!/bin/sh
case "$1" in
  status) echo '${state}' ;;
  stop|start) exit 0 ;;
  *) exit 1 ;;
esac
`, 0o755);
  const res = runInstaller(['--from', f.archive, '--dir', f.target, '--no-start'], { env: f.env });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /仍在运行/);
  assert.equal(fs.readFileSync(path.join(f.target, 'old-marker'), 'utf8'), 'previous version');
  assert.equal(fs.existsSync(f.loaded), true, 'the old service is restored on refusal');
});

test('configuration failure rolls back the program before boot and restores the service', { skip: PLATFORM !== 'darwin' }, t => {
  const f = serviceFixture();
  t.after(() => spawnSync(path.join(f.target, 'multicc'), ['stop'], { env: { ...process.env, ...f.env } }));
  const broken = buildFixtureBundle();
  const wrapper = path.join(broken.root, 'multicc');
  write(wrapper, fs.readFileSync(wrapper, 'utf8').replace('#!/bin/sh', '#!/bin/sh\n[ "$1:$2:$3" != "config:set:PORT" ] || exit 1'), 0o755);
  const archive = archiveFixture(broken);
  const res = runInstaller(['--from', archive, '--dir', f.target, '--no-start'], { env: f.env });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /无法保存端口配置/);
  assert.equal(fs.readFileSync(path.join(f.target, 'old-marker'), 'utf8'), 'previous version');
  assert.equal(fs.existsSync(f.loaded), true);
  assert.equal(fs.readdirSync(f.home).some(name => name.startsWith('MultiCC.failed-')), true);
});

test('an existing upgrade lock prevents concurrent replacement', () => {
  const fixture = buildFixtureBundle();
  const parent = tmpdir('multicc-locked-');
  const target = path.join(parent, 'MultiCC');
  fs.cpSync(fixture.root, target, { recursive: true });
  const lock = path.join(parent, '.MultiCC.upgrade-lock');
  fs.mkdirSync(lock);
  const res = runInstaller(['--dir', target, '--no-start']);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /已有升级锁/);
  assert.equal(fs.existsSync(lock), true, 'do not remove somebody else\'s lock');
  assert.equal(fs.existsSync(path.join(target, 'multicc')), true);
});
