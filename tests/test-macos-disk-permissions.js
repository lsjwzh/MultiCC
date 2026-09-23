'use strict';
// Regression tests for the macOS disk-permission failure chain reported from a
// macOS 11.7.10 machine running the Portable package out of ~/Downloads:
//
//   1. gitIsRepo() reported a TCC-denied directory as "not a git repo", so the
//      caller ran `git init` again on every registration and the user saw the
//      same raw `fatal: unable to get current working directory` forever.
//   2. Nothing in the bundle knew about AppTranslocation, so a quarantined
//      copy ran from a random read-only path where grants can never stick.
//   3. The failure message named no actionable object ("grant Full Disk Access
//      to MultiCC" — but the object to grant depends on how it was started).
//
// Plus static locks on the wiring, so a refactor cannot quietly drop the
// quarantine strip or the Info.plist usage strings the prompt depends on.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const {
  isPermissionDeniedGitError, isDeveloperToolsMissingGitError, gitIsRepo,
} = require('../src/git/service');
const { defaultRepoActor } = require('../src/repo-actor');
const {
  friendlyDirReason, macPermissionTargets, macPermissionGuidance, directoryWriteDenied,
  developerToolsGuidance,
} = require('../src/directories');
const {
  isAppTranslocated, translocationGuidance, dequarantine,
} = require('../desktop/lib/desktop-env');

// git's exact wording on a TCC-denied cwd — copied from the field report.
const TCC_FATAL = 'Command failed: git init\n'
  + 'fatal: unable to get current working directory: Operation not permitted\n';
const NOT_A_REPO = 'Command failed: git rev-parse --is-inside-work-tree\n'
  + 'fatal: not a git repository (or any of the parent directories): .git\n';
// The CLT shim on a machine that has never installed developer tools.
const NO_TOOLS = 'Command failed: git init\n'
  + 'xcode-select: note: No developer tools were found, requesting install.\n';

(async () => {
  // ── classifying git failures ──
  {
    ok(isPermissionDeniedGitError({ stderr: TCC_FATAL }), 'classify: TCC fatal → permission denied');
    ok(isPermissionDeniedGitError(new Error('fatal: EPERM: operation not permitted, open x')),
      'classify: EPERM in message → permission denied');
    ok(isPermissionDeniedGitError(new Error('EACCES: permission denied')),
      'classify: EACCES → permission denied');
    ok(!isPermissionDeniedGitError(new Error(NOT_A_REPO)),
      'classify: "not a git repository" is NOT a permission error');
    ok(!isPermissionDeniedGitError(null) && !isPermissionDeniedGitError(new Error('')),
      'classify: empty/absent error is not a permission error');
  }

  // ── gitIsRepo: deny vs "not a repo" must not collapse ──
  {
    const real = defaultRepoActor.runGit;
    try {
      defaultRepoActor.runGit = async (cwd, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
          if (cwd === '/denied') throw Object.assign(new Error(TCC_FATAL), { stderr: TCC_FATAL });
          if (cwd === '/plain') throw Object.assign(new Error(NOT_A_REPO), { stderr: NOT_A_REPO });
          if (cwd === '/repo') return 'true';
          return 'false';
        }
        return '';
      };

      ok(await gitIsRepo('/repo') === true, 'gitIsRepo: real repo → true');

      let plain = 'did not throw';
      try { plain = await gitIsRepo('/plain'); } catch (e) { plain = 'threw'; }
      ok(plain === false, 'gitIsRepo: "not a git repository" → false (still a legit empty dir)');

      let denied = null;
      try { await gitIsRepo('/denied'); } catch (e) { denied = e; }
      ok(denied && denied.code === 'GIT_PERMISSION_DENIED',
        'gitIsRepo: denied dir → throws GIT_PERMISSION_DENIED instead of masquerading as "no repo"');
      ok(denied && denied.path === '/denied', 'gitIsRepo: thrown error carries the path');
      ok(denied && /Operation not permitted/.test(denied.message),
        'gitIsRepo: thrown error keeps git\'s original text for the log');
    } finally {
      defaultRepoActor.runGit = real;
    }
    // The patch must be gone, or every later test (and this file's own exit)
    // would still be running against a fake git.
    ok(defaultRepoActor.runGit === real, 'gitIsRepo: runGit seam restored after the test');
  }

  // ── missing Command Line Tools: same failure shape, different cause ──
  // /usr/bin/git is a CLT shim on macOS. With the tools absent it prints this
  // note, pops an install dialog and exits non-zero — reported from a fresh
  // install where the user reasonably concluded MultiCC (or Node) was at fault.
  {
    ok(isDeveloperToolsMissingGitError({ stderr: NO_TOOLS }),
      'classify: xcode-select install note → developer tools missing');
    ok(isDeveloperToolsMissingGitError(new Error(
      "xcode-select: error: tool 'git' requires Xcode, but active developer directory "
      + "'/Library/Developer/CommandLineTools' is a command line tools instance")),
      'classify: xcode-select "requires Xcode" → developer tools missing');
    ok(isDeveloperToolsMissingGitError(new Error(
      'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)')),
      'classify: xcrun invalid active developer path → developer tools missing');
    ok(!isDeveloperToolsMissingGitError(new Error(NOT_A_REPO)),
      'classify: "not a git repository" is NOT a toolchain problem');
    ok(!isDeveloperToolsMissingGitError({ stderr: TCC_FATAL }),
      'classify: a TCC denial is NOT a toolchain problem');
    ok(!isDeveloperToolsMissingGitError(null) && !isDeveloperToolsMissingGitError(new Error('')),
      'classify: empty/absent error is not a toolchain problem');

    const real = defaultRepoActor.runGit;
    let initRan = false;
    try {
      defaultRepoActor.runGit = async (cwd, args) => {
        if (args[0] === 'init') { initRan = true; return ''; }
        throw Object.assign(new Error(NO_TOOLS), { stderr: NO_TOOLS });
      };
      let missing = null;
      try { await gitIsRepo('/fresh-mac'); } catch (e) { missing = e; }
      ok(missing && missing.code === 'GIT_TOOLS_MISSING',
        'gitIsRepo: no developer tools → throws GIT_TOOLS_MISSING instead of "no repo"');
      ok(missing && missing.path === '/fresh-mac', 'gitIsRepo: thrown tools error carries the path');
      ok(!initRan,
        'gitIsRepo: refusing to answer false stops the caller before a second `git init` dialog');
    } finally {
      defaultRepoActor.runGit = real;
    }
    ok(defaultRepoActor.runGit === real, 'gitIsRepo: runGit seam restored after the tools test');

    // The whole point: the user is told the one command that fixes it.
    const shown = friendlyDirReason('git-error: ' + NO_TOOLS);
    ok(shown.includes('xcode-select --install'),
      'friendlyDirReason: toolchain failure names `xcode-select --install`');
    ok(!shown.startsWith('无法将目录初始化为 git 仓库'),
      'friendlyDirReason: toolchain failure no longer falls through to the bare git fatal');
    ok(shown.includes(NO_TOOLS.trim().slice(0, 40)),
      'friendlyDirReason: original git text is still appended for support');
    ok(!shown.includes('完全磁盘访问权限'),
      'friendlyDirReason: a toolchain failure is not mislabelled as a permission problem');
    ok(friendlyDirReason('git-error: ' + TCC_FATAL).includes('完全磁盘访问权限'),
      'friendlyDirReason: the TCC branch still wins for a real denial');
    ok(developerToolsGuidance().includes('xcode-select --switch'),
      'guidance: an already-installed Xcode gets the --switch hint');
  }

  // ── which object the user must actually authorize ──
  {
    const terminal = macPermissionTargets({ execPath: '/usr/local/bin/node', env: {} });
    ok(!terminal.appBundle && !terminal.desktop && !terminal.service && !terminal.translocated,
      'targets: plain terminal launch → no .app, no mode flags');

    const bundled = macPermissionTargets({
      execPath: '/Applications/MultiCC/MultiCC.app/Contents/Resources/runtime/bin/node', env: {},
    });
    ok(bundled.appBundle === '/Applications/MultiCC/MultiCC.app',
      'targets: bundled runtime node → the enclosing .app is named');
    ok(macPermissionGuidance(bundled).includes('/Applications/MultiCC/MultiCC.app'),
      'guidance: names the .app to authorize');

    const svc = macPermissionTargets({ execPath: '/opt/multicc/runtime/bin/node', env: { MULTICC_SERVICE: '1' } });
    ok(svc.service, 'targets: MULTICC_SERVICE=1 → service mode');
    const svcText = macPermissionGuidance(svc);
    ok(svcText.includes('launchd') && svcText.includes('/opt/multicc/runtime/bin/node'),
      'guidance: launchd cannot prompt → names the exact binary to add by hand');

    const desk = macPermissionTargets({ execPath: '/Applications/MultiCC.app/Contents/MacOS/MultiCC', env: { MULTICC_DESKTOP: '1' } });
    ok(desk.desktop && desk.appBundle === '/Applications/MultiCC.app',
      'targets: desktop shell mode');
    ok(macPermissionGuidance(desk).includes('MultiCC.app'), 'guidance: desktop → names the app');

    const trans = macPermissionTargets({
      execPath: '/private/var/folders/xy/AppTranslocation/9F3/d/MultiCC.app/Contents/Resources/runtime/bin/node',
      env: {},
    });
    ok(trans.translocated, 'targets: /AppTranslocation/ in the running path → translocated');

    for (const [label, text] of [
      ['terminal', macPermissionGuidance(terminal)],
      ['service', macPermissionGuidance(svc)],
      ['translocated', macPermissionGuidance(trans)],
    ]) {
      ok(text.includes('完全磁盘访问权限') && text.includes('重新启动'),
        `guidance (${label}): names the exact pane and the restart requirement`);
      ok(text.includes('~/working'), `guidance (${label}): offers the unprotected-path workaround`);
    }
    ok(macPermissionGuidance(trans).includes('xattr -dr com.apple.quarantine'),
      'guidance (translocated): gives the exact de-quarantine command');
    ok(!macPermissionGuidance(terminal).includes('xattr -dr'),
      'guidance (terminal): no translocation noise when not translocated');
  }

  // ── reason code → message ──
  {
    const perm = friendlyDirReason('permission-denied: /Users/u/Downloads/working');
    ok(perm.includes('完全磁盘访问权限') && perm.includes('permission-denied: /Users/u/Downloads/working'),
      'friendlyDirReason: denied path → guidance plus the original reason');
    ok(friendlyDirReason('git-error: ' + TCC_FATAL).includes('完全磁盘访问权限'),
      'friendlyDirReason: legacy git-error text with the TCC fatal still routes to guidance');
    ok(friendlyDirReason('git-error: boom') === '无法将目录初始化为 git 仓库: git-error: boom',
      'friendlyDirReason: unrelated git failure keeps the plain prefix');
    ok(friendlyDirReason('unsuitable: 目录太大') === '目录太大',
      'friendlyDirReason: unsuitable reason is unwrapped verbatim');
    ok(friendlyDirReason('home-or-above') === '不允许选择 $HOME 或更高层目录'
      && friendlyDirReason('path-missing') === '目录不存在',
      'friendlyDirReason: home-or-above / path-missing unchanged');
  }

  // ── the write probe that runs before git is ever spawned ──
  {
    const probeNames = [];
    const boom = (code) => () => { const e = new Error(code); e.code = code; throw e; };

    ok(directoryWriteDenied('/denied', { mkdirSync: boom('EPERM'), rmdirSync: () => {} }) === true,
      'probe: mkdir EPERM → denied');
    ok(directoryWriteDenied('/denied', { mkdirSync: boom('EACCES'), rmdirSync: () => {} }) === true,
      'probe: mkdir EACCES → denied');
    ok(directoryWriteDenied('/busy', { mkdirSync: boom('EEXIST'), rmdirSync: () => {} }) === false,
      'probe: mkdir EEXIST is not a denial (stale probe left behind by a crash)');
    ok(directoryWriteDenied('/ro', { mkdirSync: boom('EROFS'), rmdirSync: () => {} }) === false,
      'probe: EROFS is left to git — it has its own message for read-only mounts');

    let removed = null;
    ok(directoryWriteDenied('/ok', {
      mkdirSync: (p) => probeNames.push(p),
      rmdirSync: (p) => { removed = p; },
    }) === false, 'probe: writable dir → not denied');
    ok(probeNames.length === 1 && /\.multicc-probe-\d+$/.test(probeNames[0]) && removed === probeNames[0],
      'probe: cleans up exactly the file it created');
  }

  // ── AppTranslocation / quarantine ──
  {
    ok(isAppTranslocated('/private/var/folders/xy/AppTranslocation/9F3/d/MultiCC'), 'translocation: path detected');
    ok(!isAppTranslocated('/Applications/MultiCC/MultiCC.app/Contents/Resources'),
      'translocation: installed location is not translocated');
    ok(translocationGuidance('/Applications/MultiCC') === null, 'translocation: no warning when installed properly');

    const warn = translocationGuidance('/private/var/folders/xy/AppTranslocation/9F3/d/MultiCC.app/Contents/Resources');
    ok(warn && warn.includes('xattr -dr com.apple.quarantine'), 'translocation: warning carries the fix command');
    ok(warn.includes('"/private/var/folders/xy/AppTranslocation/9F3/d"'),
      'translocation: command targets the directory holding the .app, not the .app itself');

    ok(dequarantine('/tmp/x', { platform: 'linux' }) === false,
      'dequarantine: no-op (and no spawn) off darwin');
    if (process.platform === 'darwin') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-dq-'));
      try {
        ok(dequarantine(tmp) === true, 'dequarantine: strips the flag on darwin');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  // ── wiring locks ──
  {
    const cli = read('scripts/standalone-cli.js');
    ok(/dequarantine\(dest,\s*\{\s*platform/.test(cli),
      'wiring: the packager strips quarantine from a freshly extracted bundle');
    ok(/translocationGuidance\(layout\.resources\)/.test(cli),
      'wiring: the CLI warns when it runs from an AppTranslocation path');
    ok(/<key>MULTICC_SERVICE<\/key><string>1<\/string>/.test(cli) && /Environment=MULTICC_SERVICE=1/.test(cli),
      'wiring: both launchd and systemd units mark the service launch (so guidance can name the right object)');

    const launcher = read('scripts/standalone-launcher.js');
    ok(/translocationGuidance\(__dirname\)/.test(launcher) && /gatekeeperWarning/.test(launcher),
      'wiring: the launcher warns on every start when translocated');

    const installer = read('install.sh');
    ok(/if \[ "\$PLATFORM" = "darwin" \][^\n]*\n[^\n]*xattr -dr com\.apple\.quarantine "\$UNPACK_DIR"/.test(installer),
      'wiring: install.sh clears the download flag after unpacking (darwin-guarded)');
    // The installer is where a fresh macOS is still cheap to fix: the package
    // ships its own Node but cannot ship git, and /usr/bin/git is a shim that
    // lies about being present. Without this check the user only finds out when
    // the first directory fails to initialise.
    ok(/step "Checking git"/.test(installer),
      'wiring: install.sh checks that git actually works before it finishes');
    ok(/xcode-select -p/.test(installer),
      'wiring: install.sh probes with `xcode-select -p`, which does not pop the install dialog');
    ok(/xcode-select --install/.test(installer),
      'wiring: install.sh names the command that fixes a fresh macOS');
    ok(!/No Node, npm, git, Homebrew or Xcode required: the standalone package ships\nits own runtime\./.test(installer),
      'wiring: install.sh no longer promises that git is unnecessary to run MultiCC');
    ok(/GIT_MISSING/.test(installer) && installer.indexOf('GIT_MISSING') !== installer.lastIndexOf('GIT_MISSING'),
      'wiring: the git warning is repeated in the final banner, not just mid-scroll');
    ok(/\|\| true/.test(installer.split('com.apple.quarantine')[1].split('\n')[0]),
      'wiring: a failing xattr never aborts the install');

    const server = read('server.js');
    ok(/directoryWriteDenied/.test(server.split('\n').filter(l => /require\('\.\/src\/directories'\)/.test(l)).join(''))
      || /directoryWriteDenied,?\s*\n?\s*\} = require\('\.\/src\/directories'\)/.test(server),
      'wiring: server.js takes the write probe from src/directories');
    ok(!/^function directoryWriteDenied/m.test(server),
      'wiring: server.js does not keep a second copy of the probe');
    ok(/e\.code === 'GIT_PERMISSION_DENIED'\) return \{ ok: false, reason: 'permission-denied: '/.test(server),
      'wiring: ensureDirGitReady translates GIT_PERMISSION_DENIED into the permission-denied reason');

    const dirMod = read('src/directories.js');
    ok(/^\s*directoryWriteDenied,\s*$/m.test(dirMod), 'wiring: src/directories exports directoryWriteDenied');

    const keys = ['NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription',
      'NSDownloadsFolderUsageDescription', 'NSRemovableVolumesUsageDescription',
      'NSNetworkVolumesUsageDescription'];
    const bundleGen = read('scripts/standalone-bundle.js');
    for (const k of keys) {
      ok(new RegExp(`<key>${k}</key>`).test(bundleGen),
        `wiring: generated Info.plist has ${k} (without it macOS shows no prompt at all)`);
    }
    const pkg = JSON.parse(read('desktop/package.json'));
    for (const k of keys) {
      ok(typeof pkg.build.mac.extendInfo[k] === 'string' && pkg.build.mac.extendInfo[k].length > 0,
        `wiring: desktop build carries ${k}`);
    }
  }

  // ── one-click repair: the fix code has to survive the whole way out ──
  // A remedy the user must retype into a terminal is a remedy most users never
  // apply. The chain is: classifier → dirReasonFix → service `extra` → HTTP body
  // → button. Any missing link silently degrades it back to prose, so each one
  // is asserted here rather than left to the end-to-end UI tests.
  {
    const { dirReasonFix } = require('../src/directories');
    ok(dirReasonFix('git-error: ' + NO_TOOLS) === 'install-developer-tools',
      'dirReasonFix: a missing toolchain names the install remedy');
    // A TCC denial cannot be repaired by running anything — only the user, in
    // System Settings, can grant it. It still gets a code, because the pane is
    // hard to find and the program to add depends on how MultiCC was started.
    ok(dirReasonFix(TCC_FATAL) === 'open-disk-access',
      'dirReasonFix: a permission denial points at the Full Disk Access pane');
    ok(dirReasonFix('boom') === null && dirReasonFix(null) === null,
      'dirReasonFix: unknown and empty reasons stay null');

    ok(/'dirReasonFix'/.test(read('src/directory/ports.js')),
      'wiring: dirReasonFix is part of the directory helper port, not an optional extra');
    const svc = read('src/directory/service.js');
    ok(/helpers\.dirReasonFix\(reason\)/.test(svc) && /fixExtra\(ready\.reason\)/.test(svc),
      'wiring: register/update attach the fix code to the failure they return');
    ok(/helpers: \{ resolveCwd, isHomeOrAbove, realPathOf, friendlyDirReason, dirReasonFix \}/.test(read('server.js')),
      'wiring: server.js supplies dirReasonFix to the directory service');

    // The endpoint must probe with xcode-select, never with git --version: the
    // latter pops the very dialog the button is supposed to raise deliberately.
    const route = read('src/routes/developer-tools.js');
    ok(/'xcode-select'/.test(route) && /'--install'/.test(route),
      'wiring: the route runs xcode-select --install');
    ok(!/git['"\s]*,?\s*\[['"]--version/.test(route),
      'wiring: the route never probes with git --version');
    ok(/\/api\/system\/developer-tools\/install/.test(route)
      && /createDeveloperToolsRoutes\(\)\.mountRoutes\(app\)/.test(read('src/routes/system.js')),
      'wiring: the install route is mounted');

    ok(read('public/air-task-settings.js').includes('/api/system/developer-tools/install'),
      'wiring: the task-settings dialog offers the repair as a button');
    ok(/if \(result\.fix\) failure\.fix = result\.fix;/.test(read('public/air-task-settings.js')),
      'wiring: the Air client keeps the fix code off the error body');
    ok(/renderFix\(fixBox, e\.fix\)/.test(read('public/air-task-settings.js')),
      'wiring: the dialog has somewhere to render the button');
  }

  console.log(`\n== macos disk permissions: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
