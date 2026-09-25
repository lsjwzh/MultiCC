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

// Spawned with detached: true so the installer runs in its own session, without
// the terminal this test suite was started from. That is not cosmetic: every
// question the installer asks is read from /dev/tty, and `[ -r /dev/tty ]` only
// checks the device node's permissions — so from an interactive terminal a plain
// child would block on a prompt that no one is there to answer, and the suite
// would hang instead of failing. Detached, those reads fail immediately, which is
// exactly the no-terminal path a `curl … | bash` install takes.
function runInstaller(args, { cwd, env = {} } = {}) {
  return spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    cwd: cwd || ROOT,
    detached: true,
    env: { ...process.env, ...env, MULTICC_STANDALONE_HOME: env.MULTICC_STANDALONE_HOME || '' },
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
