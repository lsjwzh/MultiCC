'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPlan, parseArgs, RELEASE_CORE_LANES } = require('../scripts/run-test-tier');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

// The installer is served from the release tag it installs, so the tag in the
// documented URL is the version a user gets: no flags, nothing to keep in sync
// by hand on the command line.
function installVersions(relative) {
  const source = read(relative);
  return [...source.matchAll(/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/v(\d+\.\d+\.\d+)\/install\.sh/g)]
    .map(match => ({ url: match[1] }));
}

function windowsInstallVersions(relative) {
  const source = read(relative);
  return [...source.matchAll(/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/v(\d+\.\d+\.\d+)\/install\.ps1/g)]
    .map(match => ({ url: match[1] }));
}

test('public stable install commands use package.json as their version source', () => {
  for (const relative of ['README.md', 'README.zh.md', 'docs/installation.md']) {
    const commands = installVersions(relative);
    assert.ok(commands.length > 0, `${relative} must publish a stable install command`);
    for (const command of commands) {
      assert.equal(command.url, pkg.version, `${relative} install tag drifted`);
    }
    const windowsCommands = windowsInstallVersions(relative);
    assert.ok(windowsCommands.length > 0, `${relative} must publish a stable Windows install command`);
    for (const command of windowsCommands) {
      assert.equal(command.url, pkg.version, `${relative} Windows install tag drifted`);
    }
  }

  const installer = read('install.sh');
  const declared = installer.match(/^INSTALLER_VERSION="([^"]+)"/m);
  assert.ok(declared, 'install.sh must declare INSTALLER_VERSION');
  assert.equal(declared[1], pkg.version, 'installer version drifted from package.json');

  const windowsInstaller = read('install.ps1');
  const windowsDeclared = windowsInstaller.match(/^\$InstallerVersion\s*=\s*'([^']+)'/m);
  assert.ok(windowsDeclared, 'install.ps1 must declare InstallerVersion');
  assert.equal(windowsDeclared[1], pkg.version, 'Windows installer version drifted from package.json');
});

test('tag releases use the manifest core tier instead of the legacy full suite', () => {
  const coreGate = pkg.scripts && pkg.scripts['test:release:core'];
  const installGate = pkg.scripts && pkg.scripts['test:install'];
  const releaseGate = pkg.scripts && pkg.scripts['test:release'];
  assert.match(String(coreGate || ''), /npm run test:tiers:check/);
  assert.match(String(coreGate || ''), /node scripts\/run-test-tier\.js core/);
  assert.equal(installGate, 'npm run test:release:clean-install');
  assert.equal(releaseGate, 'npm run test:release:core && npm run test:install');
  assert.doesNotMatch(String(coreGate || ''), /(?:^|&&)\s*npm test(?:\s|$)/,
    'the release gate must not fall back to the unclassified full suite');

  const manifest = JSON.parse(read('tests/test-tiers.json'));
  for (const path of [
    'tests/test-codex-official-relay.js',
    'tests/test-claude-passthrough-hop.js',
  ]) {
    const entry = manifest.tests.find(candidate => candidate.path === path);
    assert.equal(entry?.tier, 'core', `${path} must stay in the release core tier`);
  }

  const coreWorkflow = read('.github/workflows/core-tests.yml');
  assert.match(coreWorkflow, /npm run test:release:core/);
  for (const workflow of ['.github/workflows/release.yml', '.github/workflows/desktop-release.yml']) {
    assert.match(read(workflow), /core-tests:\s+uses: \.\/\.github\/workflows\/core-tests\.yml/,
      `${workflow} must call the canonical core gate`);
  }
});

test('core runner covers every selected path and expands declared variants', () => {
  assert.deepEqual(parseArgs(['core', '--lane', 'isolated', '--dry-run']), {
    tier: 'core', lane: 'isolated', dryRun: true,
  });
  assert.throws(() => parseArgs(['flow']), /only accepts the core tier/);
  assert.throws(() => parseArgs(['core', '--lane']), /requires a value/);

  const manifest = JSON.parse(read('tests/test-tiers.json'));
  const core = manifest.tests.filter(entry => entry.tier === 'core');
  const plan = buildPlan(manifest, { node: 'node', flutter: 'flutter', root });
  // Re-audited: bb5601a2 registered tests/test-dom-helpers-escape.js as core
  // without moving these numbers off 297 (one deterministic Node unit test, no
  // external side effects — safe for the release core tier), this tranche's
  // registration of tests/test-auto-route-notes.js adds one more of the same
  // kind, and the format consolidation registers tests/test-format-guard.js —
  // likewise a static Node unit test that reads public/ and the Flutter source
  // and writes nothing. 297 + 3 = 300. 62119be9 then added
  // tests/test-proxy-stall-watch.js (pure in-memory unit test, registered as
  // core on rebase): 301. Re-audited again: this tranche registers
  // tests/test-session-runtime-busy.js, which asserts a truth table over plain
  // objects plus source-text invariants and touches no clock, port, FS or
  // process — safe for the release core tier. 301 + 1 = 302.
  assert.equal(core.length, 302, 'the reviewed core set changed; re-audit the release tier');
  assert.equal(plan.entries.length, 302);
  assert.deepEqual(
    [...new Set(plan.entries.map(entry => entry.lane))].sort(),
    [...RELEASE_CORE_LANES].sort(),
  );
  assert.equal(core.filter(entry => entry.lane === 'deterministic').length, 259);
  assert.equal(core.filter(entry => entry.lane === 'isolated').length, 24);
  assert.equal(core.filter(entry => entry.lane === 'flutter').length, 19,
    'the reviewed non-UI Flutter core set changed; re-audit it before release');

  const expectedPaths = core.flatMap(entry => Array.from(
    { length: entry.variants?.length || 1 }, () => entry.path,
  )).sort();
  const plannedPaths = plan.commands.flatMap(command => command.paths).sort();
  assert.deepEqual(plannedPaths, expectedPaths, 'the runner must neither skip nor add manifest paths');
  assert.equal(plan.commands.length, 286,
    '283 Node entries, two extra variant executions, and one batched Flutter command are expected');

  const presentationSuites = new Map([
    ['tests/test-chat-history-ordering.js', 'other'],
    ['tests/test-chat-history-view.js', 'other'],
    ['tests/test-chat-recovery-service.js', 'flow'],
    ['tests/test-task-board-groups.js', 'other'],
  ]);
  for (const [testPath, tier] of presentationSuites) {
    const entry = manifest.tests.find(candidate => candidate.path === testPath);
    assert.equal(entry?.tier, tier, `${testPath} is UI/presentation coverage and must not block a release`);
  }

  const dispatchVariants = plan.commands
    .filter(command => command.paths.includes('tests/test-dispatch-loop-isolated.js'))
    .map(command => command.args.slice(1));
  assert.deepEqual(dispatchVariants, [[], ['--new-task']]);
  const taskFirstVariants = plan.commands
    .filter(command => command.paths.includes('tests/test-task-first-isolated.js'))
    .map(command => command.args.slice(1));
  assert.deepEqual(taskFirstVariants, [[], ['--no-token']]);
});
