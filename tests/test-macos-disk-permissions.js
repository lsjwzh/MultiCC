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
  isPermissionDeniedGitError, gitIsRepo,
} = require('../src/git/service');
const { defaultRepoActor } = require('../src/repo-actor');
const {
  friendlyDirReason, macPermissionTargets, macPermissionGuidance, directoryWriteDenied,
} = require('../src/directories');
const {
  isAppTranslocated, translocationGuidance, dequarantine,
} = require('../desktop/lib/desktop-env');

// git's exact wording on a TCC-denied cwd — copied from the field report.
const TCC_FATAL = 'Command failed: git init\n'
  + 'fatal: unable to get current working directory: Operation not permitted\n';
const NOT_A_REPO = 'Command failed: git rev-parse --is-inside-work-tree\n'
  + 'fatal: not a git repository (or any of the parent directories): .git\n';

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

  console.log(`\n== macos disk permissions: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
