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
  // process — safe for the release core tier. 301 + 1 = 302. The zcode resident
  // work then registered tests/test-zcode-resident.js without moving them, which
  // left this assertion red on main: 302 + 1 = 303. That one is a genuine core
  // invariant (the resident lane and its background hold), and it is hermetic —
  // it spawns only its own fixture app-server into a temp directory, binds no
  // port, and is green in 6s over repeated runs — so it stays in the release
  // tier; the lane it is filed under is the owner's call, not this assertion's.
  // Re-audited: this tranche registers tests/test-terminal-proxy-route.js as core
  // — the terminal route capability and its proxy-guard admission (the regression
  // behind 「终端里 409 provider route attempt is no longer active」). It is a pure
  // in-memory unit test: fake session Map, injected encoder/mint, no clock, port,
  // FS or process — safe for the release core tier. 303 + 1 = 304.
  // Re-audited: this tranche registers app/test/terminal_service_test.dart as core —
  // the terminal attach snapshot must replace the screen rather than append to it,
  // which is what keeps a reconnect or a return from background from doubling the
  // scrollback. It is a plain test() over the transport with a fake WebSocketChannel
  // and a stubbed ticket HTTP client: no network, simulator, clock, port, FS or
  // process — safe for the release core tier. 304 + 1 = 305.
  // Re-audited for the v2.1.3 release. tests/test-global-lane-tier-alias.js had
  // been registered as core by an earlier tranche without moving these numbers,
  // which left this assertion red on main: 305 + 1 = 306. It is a genuine core
  // invariant (a tier alias must resolve inside the lane that owns the wire
  // model, not globally) and it is hermetic — plain objects and source text, no
  // clock, port, FS or process — so it stays in the release tier. This tranche
  // then registers three more, all of them the human-assist annotation contract:
  // tests/test-chat-annotate.js (the byte-exact block the web lightbox emits and
  // the App must reproduce, checked against public/chat-annotate.js and the
  // agent-side contract in src/chat/host-prompts.js), tests/test-assist-snapshots.js
  // (the 7-day screenshot retention sweep: per-file window, emptied session dirs
  // dropped, symlinks left alone, unbounded roots refused, data-dir isolation),
  // and app/test/image_annotate_format_test.dart (the same contract on the Dart
  // side, a plain test() with no widget tree). None of the three touches the
  // network, a simulator, a clock, a port, a live service or another process.
  // 306 + 3 = 309.
  // 2026-09-27 运行期防锁 + 自动解锁：tests/test-keep-awake.js（caffeinate
  // assertion 服务的纯 runtime 测试，注入 spawn，不碰真进程）与
  // tests/test-macos-unlock-password.js（钥匙串存取，注入 security，不碰真
  // 钥匙串）都是 hermetic 单测，注册为 core。309 + 2 = 311。
  // 2026-09-27 dead-subsystem 拆除：task-run 台账/生产主机/转发器那 14 个 core
  // 测试随 src/task-run 一起删除，另有 tests/test-task-board-{merge,cancel-run}.js
  // 与 6 个 app/test/*.dart（task board UI 退役）也退出 core。311 - 20 = 291。
  // 2026-09-28 行缓存守卫：tests/test-task-shell-row-cache.js 注册为 core
  // deterministic 时没同步这几个数字，main 因此一直红在 292 !== 291。它是
  // hermetic 的——只在临时目录里开一个 task-shell sqlite store 验证行缓存的
  // 复用与失效，不碰端口、网络、真库、时钟或别的进程——留在 core 是安全的。
  // 291 + 1 = 292。
  // 2026-09-28 自动解锁授权链路（本次）：再注册 tests/test-macos-unlock-probe.js。
  // 它注入 execFile，只解析 agent 的 stdout JSON，不 spawn 真进程也不碰真钥匙串，
  // 同样是 hermetic 单测。292 + 1 = 293，deterministic 250 + 2 = 252，
  // commands 277 + 2 = 279。
  assert.equal(core.length, 293, 'the reviewed core set changed; re-audit the release tier');
  assert.equal(plan.entries.length, 293);
  assert.deepEqual(
    [...new Set(plan.entries.map(entry => entry.lane))].sort(),
    [...RELEASE_CORE_LANES].sort(),
  );
  assert.equal(core.filter(entry => entry.lane === 'deterministic').length, 252);
  assert.equal(core.filter(entry => entry.lane === 'isolated').length, 24);
  assert.equal(core.filter(entry => entry.lane === 'flutter').length, 17,
    'the reviewed non-UI Flutter core set changed; re-audit it before release');

  const expectedPaths = core.flatMap(entry => Array.from(
    { length: entry.variants?.length || 1 }, () => entry.path,
  )).sort();
  const plannedPaths = plan.commands.flatMap(command => command.paths).sort();
  assert.deepEqual(plannedPaths, expectedPaths, 'the runner must neither skip nor add manifest paths');
  assert.equal(plan.commands.length, 279,
    '276 Node entries, two extra variant executions, and one batched Flutter command are expected');

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
