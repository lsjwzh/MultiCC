#!/usr/bin/env node
'use strict';

// Build a self-contained MultiCC bundle: the server, its production
// node_modules, and a pinned official Node runtime — nothing to install on the
// target machine, no compiler, no Homebrew.
//
// Why this exists: the Electron desktop build needs macOS 13+ (Electron 44 =
// Chromium 152), and Homebrew no longer supports macOS 12 or builds Intel
// bottles, so an older Mac (e.g. Mac Pro 2013, macOS 12.7) cannot install
// either one. The Node project still builds darwin-x64 with
// `-mmacosx-version-min=11.0`, so a bundle pinned to Node 22 runs there
// untouched — provided nothing in it has to be compiled. Storage no longer
// does: src/sqlite/driver.js uses the SQLite built into that runtime.
//
//   node scripts/standalone-bundle.js --platform darwin --arch x64
//
// Result:
//   <out>/multicc-standalone-<version>-<platform>-<arch>/     bundle directory
//   <out>/multicc-standalone-<version>-<platform>-<arch>.tar.gz(+ .sha256)
//   <out>/multicc-standalone-<version>-<platform>-<arch>.zip   (win32: nobody
//     un-tars a tarball on Windows, and Explorer opens a zip natively)
//
// Layout (macOS; Linux/Windows use the same Resources/ tree without the .app):
//   MultiCC.app/Contents/Resources/app-server/   server.js + src/ + public/ + node_modules
//   MultiCC.app/Contents/Resources/runtime/      the pinned Node runtime
//   MultiCC.app/Contents/Resources/launcher/     standalone-launcher.js + lib/ (desktop/lib)
//
// The desktop app is a shell around that same Resources tree, not a second
// build of the server: scripts/desktop-stage-standalone.js stages it with
// stageResources() below and Electron spawns the bundled runtime inside it, so
// `multicc-standalone-*.tar.gz` and `MultiCC.dmg` run identical code on the
// identical pinned Node.
//
// The runtime's internal layout is the official one, not ours: the unix
// tarballs put the binary at runtime/bin/node, while the Windows zip keeps
// node.exe at the root of runtime/ with no bin/ level. Everything that needs
// that path goes through runtimeNodePath() so the two cannot drift apart — the
// first Windows build died on exactly this.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { stageServer } = require('./desktop-bundle-server');
const { nativeBinaryArch, nativeBinaryPlatform, verifyNativeArch } = require('./native-arch');
const { createZipArchive } = require('./zip-archive');

// Pinned on purpose. Node 24/26 official macOS binaries are built with
// -mmacosx-version-min=13.5, so following "latest" would silently drop every
// macOS 11/12 machine this bundle exists for. Node 22 LTS is maintained into
// 2027-04 and its darwin-x64 build targets macOS 11.0.
const DEFAULT_NODE_VERSION = '22.23.2';
const NODE_MAJOR_FLOOR = { major: 22, minor: 16 };
const MACOS_FLOOR = '11.0';
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);
const NODE_PLATFORM = { darwin: 'darwin', linux: 'linux', win32: 'win' };
const LAUNCHER_LIB_FILES = ['port-chooser.js', 'health-probe.js', 'backend-supervisor.js', 'orphan-reclaim.js', 'desktop-env.js'];
// Both entry points travel together: the launcher owns the lifecycle, the CLI
// is the command a user actually types. Shipping only one would leave the
// bundle either unusable from a shell or unable to start a server.
const LAUNCHER_FILES = ['standalone-launcher.js', 'standalone-cli.js'];
const NODE_DIST_BASE = 'https://nodejs.org/dist';
const BUNDLE_README = '使用说明.txt';
// The server's durable state is SQLite. It ships inside Node itself
// (`node:sqlite`), so the smoke test below loads the bundled runtime and proves
// *it* can open a database — the one check that would have caught "the runtime
// we pinned cannot do storage" without any addon involved.
const RUNTIME_SMOKE_SCRIPT = "[require('node:sqlite').DatabaseSync]"
  + ".map(ctor => new ctor(':memory:'))"
  + ".map(db => (db.exec('create table t(x)'), db.close(), 'sqlite-ok'))[0]";

function parseArgs(argv) {
  const args = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: DEFAULT_NODE_VERSION,
    out: null,
    repoRoot: null,
    install: true,
    runtime: true,
    verify: true,
    archive: true,
    runtimeTarball: null,
    cacheDir: path.join(os.tmpdir(), 'multicc-standalone-cache'),
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform') args.platform = argv[++i];
    else if (arg === '--arch') args.arch = argv[++i];
    else if (arg === '--node-version') args.nodeVersion = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--repo-root') args.repoRoot = argv[++i];
    else if (arg === '--runtime-tarball') args.runtimeTarball = path.resolve(argv[++i]);
    else if (arg === '--cache-dir') args.cacheDir = argv[++i];
    else if (arg === '--install') args.install = true;
    else if (arg === '--no-install') args.install = false;
    else if (arg === '--runtime') args.runtime = true;
    else if (arg === '--no-runtime') args.runtime = false;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--no-verify') args.verify = false;
    else if (arg === '--archive') args.archive = true;
    else if (arg === '--no-archive') args.archive = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else { console.error(`unknown argument: ${arg}`); process.exit(2); }
  }
  if (!SUPPORTED_PLATFORMS.has(args.platform)) {
    console.error(`unsupported --platform ${args.platform} (expected darwin|linux|win32)`);
    process.exit(2);
  }
  if (!SUPPORTED_ARCHES.has(args.arch)) {
    console.error(`unsupported --arch ${args.arch} (expected x64|arm64)`);
    process.exit(2);
  }
  return args;
}

function bundleName(version, platform, arch) {
  return `multicc-standalone-${version}-${platform}-${arch}`;
}

function nodeDistFileName(nodeVersion, platform, arch) {
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return `node-v${nodeVersion}-${NODE_PLATFORM[platform]}-${arch}.${ext}`;
}

function nodeDistUrl(nodeVersion, platform, arch) {
  return `${NODE_DIST_BASE}/v${nodeVersion}/${nodeDistFileName(nodeVersion, platform, arch)}`;
}

// Where node lives inside Resources/runtime for a given platform.
function runtimeNodePath(resourcesDir, platform) {
  return platform === 'win32'
    ? path.join(resourcesDir, 'runtime', 'node.exe')
    : path.join(resourcesDir, 'runtime', 'bin', 'node');
}

function parseShasums(text, fileName) {
  for (const line of String(text || '').split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === fileName) return match[1].toLowerCase();
  }
  return null;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertNodeVersionSupported(nodeVersion) {
  const [major, minor] = String(nodeVersion).split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    throw new Error(`invalid node version: ${nodeVersion}`);
  }
  if (major < NODE_MAJOR_FLOOR.major
    || (major === NODE_MAJOR_FLOOR.major && minor < NODE_MAJOR_FLOOR.minor)) {
    throw new Error(`Node ${nodeVersion} is below the server floor `
      + `${NODE_MAJOR_FLOOR.major}.${NODE_MAJOR_FLOOR.minor} (package.json engines)`);
  }
  return { major, minor };
}

// Node 24+ raised its macOS floor to 13.5, which would defeat the whole point
// of the bundle. Warn loudly rather than silently shipping a bundle that no
// macOS 11/12 machine can start.
function macosFloorForNode(nodeVersion) {
  const major = Number(String(nodeVersion).split('.')[0]);
  return major >= 24 ? '13.5' : MACOS_FLOOR;
}

// nodejs.org is a single hop away from most builds but not all: undici surfaces
// a dropped connection as "terminated", which aborted a release build with no
// usable explanation. Retry a few times (the SHASUMS256 check after this makes
// a retry safe) and report what actually happened.
async function downloadFile(url, dest, logger = console, { attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger.log(`[standalone-bundle] downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`);
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) throw new Error('empty response body');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      return dest;
    } catch (error) {
      lastError = error;
      logger.log(`[standalone-bundle] download failed (${error.message})`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw new Error(`download failed after ${attempts} attempts for ${url}: ${lastError && lastError.message}`);
}

async function fetchNodeRuntime({ nodeVersion, platform, arch, cacheDir, runtimeTarball, logger = console }) {
  const fileName = nodeDistFileName(nodeVersion, platform, arch);
  if (runtimeTarball) {
    if (!fs.existsSync(runtimeTarball)) throw new Error(`--runtime-tarball not found: ${runtimeTarball}`);
    logger.log(`[standalone-bundle] using local runtime archive ${runtimeTarball} (sha256 not verified)`);
    return { archive: runtimeTarball, sha256: sha256File(runtimeTarball), verified: false, fileName };
  }
  const archive = path.join(cacheDir, fileName);
  const expectedFile = path.join(cacheDir, `SHASUMS256-${nodeVersion}.txt`);
  if (!fs.existsSync(archive)) await downloadFile(nodeDistUrl(nodeVersion, platform, arch), archive, logger);
  if (!fs.existsSync(expectedFile)) {
    await downloadFile(`${NODE_DIST_BASE}/v${nodeVersion}/SHASUMS256.txt`, expectedFile, logger);
  }
  const expected = parseShasums(fs.readFileSync(expectedFile, 'utf8'), fileName);
  if (!expected) throw new Error(`SHASUMS256.txt has no entry for ${fileName} — refusing to install an unverifiable runtime`);
  const actual = sha256File(archive);
  if (actual !== expected) {
    throw new Error(`runtime checksum mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  }
  logger.log(`[standalone-bundle] runtime checksum verified (${fileName})`);
  return { archive, sha256: actual, verified: true, fileName };
}

function extractRuntime({ archive, platform, dest, logger = console }) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (platform === 'win32') {
    const res = spawnSync('unzip', ['-q', archive, '-d', dest], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error('unzip failed for the Windows runtime archive (needs unzip on PATH)');
    const inner = fs.readdirSync(dest).map(name => path.join(dest, name))
      .find(entry => fs.statSync(entry).isDirectory());
    if (!inner) throw new Error('runtime archive did not contain a directory');
    for (const entry of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, entry), path.join(dest, entry));
    }
    fs.rmSync(inner, { recursive: true, force: true });
  } else {
    const res = spawnSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
    if (res.status !== 0) {
      throw new Error(res.status === null
        ? `tar never completed (${res.error ? res.error.code || res.error.message : 'unknown error'})`
        : `tar failed with status ${res.status}`);
    }
  }
  // Headers and man pages are build-time material for people who compile
  // against Node; a shipped runtime only needs bin/ and lib/.
  for (const drop of ['include', 'share', 'CHANGELOG.md', 'README.md']) {
    fs.rmSync(path.join(dest, drop), { recursive: true, force: true });
  }
  const nodeBin = runtimeNodePath(path.dirname(dest), platform);
  if (!fs.existsSync(nodeBin)) throw new Error(`runtime archive has no ${path.relative(dest, nodeBin)}`);
  if (platform !== 'win32') fs.chmodSync(nodeBin, 0o755);
  logger.log(`[standalone-bundle] runtime ready (${path.relative(path.dirname(dest), nodeBin)})`);
  return dest;
}

function copyLauncher({ repoRoot, resourcesDir, logger = console }) {
  const launcherDir = path.join(resourcesDir, 'launcher');
  const libDir = path.join(launcherDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  for (const file of LAUNCHER_FILES) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', file), path.join(launcherDir, file));
  }
  for (const file of LAUNCHER_LIB_FILES) {
    fs.copyFileSync(path.join(repoRoot, 'desktop', 'lib', file), path.join(libDir, file));
  }
  logger.log(`[standalone-bundle] launcher staged (${LAUNCHER_FILES.length} entry point(s), `
    + `${LAUNCHER_LIB_FILES.length} shared lib module(s))`);
  return launcherDir;
}

function macosInfoPlist({ version, resourcesName }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>MultiCC</string>
  <key>CFBundleDisplayName</key>
  <string>MultiCC</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.lsjwzh.multicc.standalone</string>
  <key>CFBundleExecutable</key>
  <string>MultiCC</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>${MACOS_FLOOR}</string>
  <key>NSHumanReadableCopyright</key>
  <string>MultiCC — MIT licensed; bundled Node runtime is MIT licensed</string>
  <key>ResourcesDirName</key>
  <string>${resourcesName}</string>
</dict>
</plist>
`;
}

function macosLauncherScript() {
  return `#!/bin/sh
# MultiCC standalone entry point. LaunchServices runs this file directly (no
# Terminal window appears); it hands over to the bundled Node runtime.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$(cd "$HERE/../Resources" && pwd)"
exec "$RESOURCES/runtime/bin/node" "$RESOURCES/launcher/standalone-launcher.js" --start "$@"
`;
}

// The `multicc` command every wrapper below funnels into. Keeping the path
// resolution here (and only here) means the .command/.cmd/double-click entries
// cannot drift from what the CLI itself expects.
function macosCommandScript({ subcommand }) {
  return `#!/bin/sh
# Double-click wrapper: multicc ${subcommand}. Keep this file next to MultiCC.app.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/multicc" ${subcommand} "$@"
`;
}

function posixScript({ subcommand }) {
  return `#!/bin/sh
# MultiCC standalone: multicc ${subcommand}. Keep this file next to Resources/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/multicc" ${subcommand} "$@"
`;
}

function windowsCommandScript({ subcommand }) {
  return `@echo off
rem MultiCC standalone: multicc ${subcommand}. Keep this file next to Resources\\.
setlocal
set "HERE=%~dp0"
call "%HERE%multicc.cmd" ${subcommand} %*
`;
}

// The user-facing command of the bundle. On macOS it has to reach through
// MultiCC.app/Contents/Resources; elsewhere Resources/ is a sibling.
function multiccWrapper({ platform }) {
  if (platform === 'darwin') {
    return `#!/bin/sh
# MultiCC standalone — the command you type. See "multicc help".
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$HERE/MultiCC.app/Contents/Resources"
if [ ! -x "$RESOURCES/runtime/bin/node" ]; then
  echo "找不到内置运行时：$RESOURCES/runtime/bin/node" >&2
  echo "请确认 MultiCC.app 与本文件在同一目录，且已完整解压（不要只拷部分文件）。" >&2
  exit 1
fi
exec "$RESOURCES/runtime/bin/node" "$RESOURCES/launcher/standalone-cli.js" "$@"
`;
  }
  return `#!/bin/sh
# MultiCC standalone — the command you type. See "multicc help".
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$HERE/Resources"
if [ ! -x "$RESOURCES/runtime/bin/node" ]; then
  echo "bundled runtime not found at $RESOURCES/runtime/bin/node" >&2
  echo "keep multicc next to Resources/ and unpack the archive fully." >&2
  exit 1
fi
exec "$RESOURCES/runtime/bin/node" "$RESOURCES/launcher/standalone-cli.js" "$@"
`;
}

function multiccWrapperWindows() {
  return `@echo off
rem MultiCC standalone — the command you type. See "multicc help".
setlocal
set "HERE=%~dp0"
set "RESOURCES=%HERE%Resources"
if not exist "%RESOURCES%\\runtime\\node.exe" (
  echo bundled runtime not found at "%RESOURCES%\\runtime\\node.exe" 1>&2
  echo keep multicc.cmd next to Resources\\ and unpack the archive fully. 1>&2
  exit /b 1
)
"%RESOURCES%\\runtime\\node.exe" "%RESOURCES%\\launcher\\standalone-cli.js" %*
`;
}

function bundleReadme({ version, platform, nodeVersion, macosFloor }) {
  const mac = platform === 'darwin';
  const cmd = mac ? './multicc' : platform === 'win32' ? 'multicc.cmd' : './multicc';
  const lines = [
    `MultiCC 单文件版（standalone）${version}`,
    `${platform} / 内置 Node ${nodeVersion} —— 不需要你机器上装 Node、Homebrew、Xcode 或 Git。`,
    '',
    '## 最快的用法',
    '',
    mac
      ? '双击 `MultiCC.app`。就这样 —— 浏览器会自动打开界面（默认 http://127.0.0.1:3000，端口被占用时会自动往后找）。\n'
        + '首次打开若提示「无法验证开发者」：右键点图标 → 打开 → 再点「打开」。'
      : platform === 'win32'
        ? '双击 `Start-MultiCC.cmd`。就这样 —— 浏览器会自动打开界面。'
        : '运行 `./start-multicc.sh`（或者先 `chmod +x multicc` 再 `./multicc start`）。',
    '',
    `想用命令行，就认准一个命令：${cmd}`,
    '',
    '## 命令一览',
    '',
    '```',
    `${cmd} start             启动（后台运行 + 自动开浏览器）`,
    `${cmd} start -f          前台启动（日志直接打在终端，Ctrl-C 停止）`,
    `${cmd} stop              优雅停止`,
    `${cmd} restart           重启`,
    `${cmd} status            看运行状态和访问地址`,
    `${cmd} url               只打印访问地址`,
    `${cmd} open              打开界面`,
    `${cmd} log -f            跟踪日志`,
    `${cmd} config list       看配置`,
    `${cmd} config set PORT 8123     改端口（下次 start 生效）`,
    `${cmd} update            升级到最新版（自动下载、校验、替换，数据不动）`,
    `${cmd} service install   装成开机自启（macOS launchd / Linux systemd 用户服务）`,
    `${cmd} version           看版本`,
    '```',
    '',
    '不等价的说法：`start` 已经把服务跑成后台进程，所以你不需要额外开终端窗口挂着。',
    '',
    '## 数据在哪',
    '',
    mac
      ? '- 会话、provider、聊天记录、记忆：`~/Library/Application Support/MultiCCStandalone/`'
      : '- 会话、provider、聊天记录、记忆：用户配置目录下的 `MultiCCStandalone/`',
    '- 日志：上面这个目录里的 `logs/`（`server-*.log`、`standalone.log`）',
    `- 升级时只替换程序本体（${mac ? '`MultiCC.app`' : '`Resources/`'}），数据目录不要动；\n`
    + `  \`${cmd} update\` 会自动做到这一点。`,
    '',
    '## 系统要求',
    mac
      ? `- macOS ${macosFloor} 及以上（Intel 与 Apple Silicon 均可）。`
      : '- 64 位 Linux / Windows 10 及以上。',
    `- 内置 Node 运行时 ${nodeVersion}；不要把它换成 Node 24+：Node 24+ 要求 macOS 13.5 起。`,
    '- 存储用的是 Node 自带的 SQLite（`node:sqlite`），包里没有任何需要编译或匹配 ABI 的原生 SQLite 模块。',
    '',
    '## 已知限制',
    '- 本地语音识别（sherpa-onnx）需要 macOS 15 及以上；更老系统上会自动回退到云端 ASR。',
    mac ? '- macOS 12 上的 Safari 不支持 Web Push；需要通知时请用 Chrome 打开。' : '',
    '',
    '## 端口与多实例',
    '- 服务只监听 127.0.0.1；同一个数据目录只允许一个实例，重复启动会复用已在运行的实例。',
    '',
  ].filter(line => line !== '');
  return `${lines.join('\n')}\n`;
}

function writeFileMode(file, content, mode) {
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

function writePlatformShell({ bundleDir, resourcesDir, version, platform, nodeVersion, logger = console }) {
  const macosFloor = macosFloorForNode(nodeVersion);
  // The `multicc` command sits at the bundle root on every platform: it is the
  // documented surface (installer scripts, README, desktop shell all point here),
  // so its location must not depend on the OS.
  if (platform === 'win32') {
    writeFileMode(path.join(bundleDir, 'multicc.cmd'), multiccWrapperWindows());
  } else {
    writeFileMode(path.join(bundleDir, 'multicc'), multiccWrapper({ platform }), 0o755);
  }
  if (platform === 'darwin') {
    const appDir = path.join(bundleDir, 'MultiCC.app');
    const contents = path.join(appDir, 'Contents');
    const macosDir = path.join(contents, 'MacOS');
    fs.mkdirSync(macosDir, { recursive: true });
    if (resourcesDir !== path.join(contents, 'Resources')) {
      throw new Error('macOS bundle resources must live at MultiCC.app/Contents/Resources');
    }
    writeFileMode(path.join(contents, 'Info.plist'), macosInfoPlist({ version, resourcesName: 'Resources' }));
    writeFileMode(path.join(contents, 'PkgInfo'), 'APPL????');
    writeFileMode(path.join(macosDir, 'MultiCC'), macosLauncherScript(), 0o755);
    writeFileMode(path.join(bundleDir, '启动 MultiCC.command'),
      macosCommandScript({ subcommand: 'start' }), 0o755);
    writeFileMode(path.join(bundleDir, '停止 MultiCC.command'),
      macosCommandScript({ subcommand: 'stop' }), 0o755);
    writeFileMode(path.join(bundleDir, '查看状态 MultiCC.command'),
      macosCommandScript({ subcommand: 'status' }), 0o755);
  } else if (platform === 'linux') {
    writeFileMode(path.join(bundleDir, 'start-multicc.sh'),
      posixScript({ subcommand: 'start' }), 0o755);
    writeFileMode(path.join(bundleDir, 'stop-multicc.sh'),
      posixScript({ subcommand: 'stop' }), 0o755);
    writeFileMode(path.join(bundleDir, 'status-multicc.sh'),
      posixScript({ subcommand: 'status' }), 0o755);
  } else {
    writeFileMode(path.join(bundleDir, 'Start-MultiCC.cmd'),
      windowsCommandScript({ subcommand: 'start' }));
    writeFileMode(path.join(bundleDir, 'Stop-MultiCC.cmd'),
      windowsCommandScript({ subcommand: 'stop' }));
    writeFileMode(path.join(bundleDir, 'Status-MultiCC.cmd'),
      windowsCommandScript({ subcommand: 'status' }));
  }
  writeFileMode(path.join(bundleDir, platform === 'darwin' ? BUNDLE_README : 'README.txt'),
    bundleReadme({ version, platform, nodeVersion, macosFloor }));
  logger.log(`[standalone-bundle] ${platform} wrappers written`);
}

function sanityGate({ bundleDir, resourcesDir, platform, arch, install, runtime, appServerDir, logger = console }) {
  const must = [
    path.join(appServerDir, 'server.js'),
    path.join(appServerDir, 'public', 'manage.html'),
    path.join(appServerDir, 'plugins', 'bridges', 'wechat-ilink.js'),
    path.join(resourcesDir, 'launcher', 'standalone-launcher.js'),
    path.join(resourcesDir, 'launcher', 'standalone-cli.js'),
    path.join(bundleDir, platform === 'win32' ? 'multicc.cmd' : 'multicc'),
    ...LAUNCHER_LIB_FILES.map(file => path.join(resourcesDir, 'launcher', 'lib', file)),
    ...(install ? [path.join(appServerDir, 'node_modules', 'express')] : []),
    ...(runtime ? [runtimeNodePath(resourcesDir, platform)] : []),
  ];
  for (const file of must) {
    if (!fs.existsSync(file)) throw new Error(`bundle is missing ${path.relative(bundleDir, file) || file}`);
  }
  // Optional packages (sherpa-onnx) still ship prebuilt binaries: presence is
  // not enough, because one built for the build host installs fine and only
  // fails at the first require() on the target machine. Storage is not in this
  // list — it comes from the runtime itself and is proved by the smoke test.
  verifyNativeArch({ root: appServerDir, arch, platform, allowNone: true, logger });
  if (platform === 'darwin') {
    const plist = path.join(bundleDir, 'MultiCC.app', 'Contents', 'Info.plist');
    if (!fs.readFileSync(plist, 'utf8').includes('<string>MultiCC</string>')) {
      throw new Error('Info.plist is missing CFBundleExecutable');
    }
    const entry = path.join(bundleDir, 'MultiCC.app', 'Contents', 'MacOS', 'MultiCC');
    if (!(fs.statSync(entry).mode & 0o111)) throw new Error('the .app entry point is not executable');
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
    if (lint.error && lint.error.code !== 'ENOENT') throw new Error(`plutil failed: ${lint.error.message}`);
    if (!lint.error && lint.status !== 0) throw new Error(`Info.plist is not valid: ${lint.stdout}${lint.stderr}`);
  }
  logger.log('[standalone-bundle] sanity gate passed');
}

// The one check that proves the bundle will actually boot: make the runtime that
// ships next to it open a SQLite database. Every other check (file lists, pinned
// versions, staged manifests) can pass while storage still fails on the target
// machine, and storage is what the server cannot start without.
// Cross-arch builds on a host that cannot execute the target runtime (Linux
// arm64 building x64) skip instead of failing — CI runs those natively.
function verifyRuntimeSqlite({
  runtimeNode,
  logger = console,
  timeoutMs = 60_000,
} = {}) {
  if (!runtimeNode || !fs.existsSync(runtimeNode)) {
    logger.log('[standalone-bundle] runtime smoke skipped: no bundled runtime to test with');
    return { ok: false, skipped: true, reason: 'runtime-missing' };
  }
  const res = spawnSync(runtimeNode, ['--disable-warning=ExperimentalWarning', '-e', RUNTIME_SMOKE_SCRIPT],
    { encoding: 'utf8', timeout: timeoutMs });
  if (res.error) {
    const code = res.error.code;
    if (code === 'ENOEXEC' || code === 'EPERM' || code === 'EACCES') {
      logger.log(`[standalone-bundle] runtime smoke skipped: this host cannot execute the target runtime (${code})`);
      return { ok: false, skipped: true, reason: code };
    }
    throw new Error(`runtime smoke could not run: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const output = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-6).join(' | ');
    throw new Error(`the bundled runtime cannot open a SQLite database: ${output}`);
  }
  logger.log('[standalone-bundle] runtime smoke passed (node:sqlite works under the bundled runtime)');
  return { ok: true, skipped: false };
}

// The runtime is the one binary every install executes first, and it carries no
// extension for verifyNativeArch to notice: a bundled runtime for the wrong
// arch or the wrong OS is invisible to a file listing, installs fine, and dies
// at exec time on the user's machine (the first Windows build shipped a
// bin/node layout that never existed). Read the header of what actually landed.
function verifyRuntimeArch({ runtimeNode, arch, platform, logger = console }) {
  if (!runtimeNode || !fs.existsSync(runtimeNode)) {
    throw new Error(`no runtime to verify at ${runtimeNode || '(undefined)'}`);
  }
  const found = nativeBinaryArch(runtimeNode);
  if (found !== arch) {
    throw new Error(`the staged runtime is ${found}, expected ${arch} (${runtimeNode})`);
  }
  const format = nativeBinaryPlatform(runtimeNode);
  if (format !== platform) {
    throw new Error(`the staged runtime is a ${format || 'unrecognised'} binary, expected ${platform} (${runtimeNode})`);
  }
  logger.log(`[standalone-bundle] runtime arch verified (${platform}/${arch})`);
  return { arch: found, platform: format };
}

// The Resources tree a MultiCC install is made of — server + production deps, a
// pinned Node runtime, the launcher, and (in the caller) the manifest. Two
// shipped forms wrap the very same tree: the standalone package adds a bundle
// root (wrappers + archive, see writePlatformShell/archiveBundle) and the
// Electron desktop app adds a shell. Staging lives here, once, so the two can
// never drift into "the dmg runs a different server than the tarball".
async function stageResources({
  repoRoot,
  resourcesDir,
  platform,
  arch,
  nodeVersion = DEFAULT_NODE_VERSION,
  install = true,
  runtime: withRuntime = true,
  verify = true,
  cacheDir = path.join(os.tmpdir(), 'multicc-standalone-cache'),
  runtimeTarball = null,
  logger = console,
}) {
  assertNodeVersionSupported(nodeVersion);
  fs.rmSync(resourcesDir, { recursive: true, force: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Cross-arch builds: the staged production deps (and every prebuilt native
  // addon left in them) must match the TARGET, not the build host.
  // prebuild-install reads npm_config_arch/npm_config_target when picking a
  // binary, so these stay pinned even though SQLite itself is now the runtime's
  // built-in `node:sqlite` — the optional sherpa-onnx ASR payload still needs
  // the right arch and the right runtime ABI.
  const npmEnv = {
    // Target the BUNDLED runtime, not the build host: without this a staged
    // addon is built for whatever Node runs the build (ABI 147 on a Node 26
    // host) and the bundle dies at the first require() with ERR_DLOPEN_FAILED.
    npm_config_target: nodeVersion,
    npm_config_runtime: 'node',
    npm_config_arch: arch,
    npm_config_platform: platform,
    npm_config_os: platform,
    npm_config_cpu: arch,
  };
  const staged = stageServer({
    repoRoot,
    out: path.join(resourcesDir, 'app-server'),
    install,
    npmEnv,
    logger,
  });

  let runtime = null;
  if (withRuntime) {
    const fetched = await fetchNodeRuntime({
      nodeVersion,
      platform,
      arch,
      cacheDir,
      runtimeTarball,
      logger,
    });
    extractRuntime({
      archive: fetched.archive,
      platform,
      dest: path.join(resourcesDir, 'runtime'),
      logger,
    });
    runtime = fetched;
    verifyRuntimeArch({ runtimeNode: runtimeNodePath(resourcesDir, platform), arch, platform, logger });
    if (verify) {
      verifyRuntimeSqlite({ runtimeNode: runtimeNodePath(resourcesDir, platform), logger });
    }
  } else {
    logger.log('[standalone-bundle] staging without a Node runtime');
  }

  copyLauncher({ repoRoot, resourcesDir, logger });
  return { staged, runtime, resourcesDir };
}

function writeManifest({ resourcesDir, version, platform, arch, nodeVersion, nodeRuntime, install }) {
  const manifest = {
    name: 'multicc-standalone',
    version,
    platform,
    arch,
    nodeVersion,
    nodeRuntime,
    productionDependencies: install,
    builtAt: new Date().toISOString(),
    macosMinimum: platform === 'darwin' ? macosFloorForNode(nodeVersion) : null,
  };
  fs.writeFileSync(path.join(resourcesDir, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function archiveBundle({ bundleDir, outDir, name, platform = process.platform, logger = console }) {
  // Windows gets a zip: that is what Explorer, PowerShell and every download
  // page expect, and it needs no extra tooling on the way in (scripts/
  // zip-archive.js writes it from Node, so a cross-arch Windows build behaves
  // the same on a macOS, Linux or Windows runner).
  const zip = platform === 'win32';
  const archive = path.join(outDir, `${name}${zip ? '.zip' : '.tar.gz'}`);
  if (zip) {
    createZipArchive({ rootDir: bundleDir, out: archive, logger });
  } else {
    fs.rmSync(archive, { force: true });
    const res = spawnSync('tar', ['-czf', archive, '-C', outDir, path.basename(bundleDir)], { stdio: 'inherit' });
    if (res.status !== 0) {
      throw new Error(res.status === null
        ? `tar never completed (${res.error ? res.error.code || res.error.message : 'unknown error'})`
        : `tar failed with status ${res.status}`);
    }
  }
  const digest = sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  const bytes = fs.statSync(archive).size;
  logger.log(`[standalone-bundle] archive ${path.basename(archive)} (${(bytes / 1048576).toFixed(1)} MB)`);
  return { archive, sha256: digest, bytes };
}

async function buildStandaloneBundle(args, { logger = console } = {}) {
  const repoRoot = path.resolve(args.repoRoot || path.join(__dirname, '..'));
  const outDir = path.resolve(args.out || path.join(repoRoot, 'dist-standalone'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = rootPkg.version;
  const name = bundleName(version, args.platform, args.arch);
  const bundleDir = path.join(outDir, name);
  const resourcesDir = args.platform === 'darwin'
    ? path.join(bundleDir, 'MultiCC.app', 'Contents', 'Resources')
    : path.join(bundleDir, 'Resources');
  assertNodeVersionSupported(args.nodeVersion);
  if (args.platform === 'darwin' && Number(String(args.nodeVersion).split('.')[0]) >= 24) {
    logger.error(`[standalone-bundle] WARNING: Node ${args.nodeVersion} requires macOS 13.5+ — `
      + 'this bundle will no longer start on macOS 11/12.');
  }

  logger.log(`[standalone-bundle] building ${name} (node ${args.nodeVersion}) -> ${bundleDir}`);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  const { staged, runtime } = await stageResources({
    repoRoot,
    resourcesDir,
    platform: args.platform,
    arch: args.arch,
    nodeVersion: args.nodeVersion,
    install: args.install,
    runtime: args.runtime,
    verify: args.verify,
    cacheDir: args.cacheDir,
    runtimeTarball: args.runtimeTarball,
    logger,
  });

  writePlatformShell({
    bundleDir, resourcesDir, version, platform: args.platform, nodeVersion: args.nodeVersion, logger,
  });
  sanityGate({
    bundleDir,
    resourcesDir,
    platform: args.platform,
    arch: args.arch,
    install: args.install,
    runtime: args.runtime,
    appServerDir: staged.out,
    logger,
  });
  const manifest = writeManifest({
    resourcesDir,
    version,
    platform: args.platform,
    arch: args.arch,
    nodeVersion: args.nodeVersion,
    nodeRuntime: args.runtime ? (runtime && runtime.verified ? 'bundled-verified' : 'bundled') : 'none',
    install: args.install,
  });

  let archive = null;
  if (args.archive) {
    archive = archiveBundle({ bundleDir, outDir, name, platform: args.platform, logger });
  }
  logger.log(`[standalone-bundle] done: ${bundleDir}`);
  return { bundleDir, outDir, name, version, manifest, archive, staged };
}

function usage() {
  console.log(`usage: standalone-bundle.js [--platform darwin|linux|win32] [--arch x64|arm64]
                            [--node-version ${DEFAULT_NODE_VERSION}] [--out <dir>] [--runtime-tarball <path>]
                            [--no-install] [--no-runtime] [--no-verify] [--no-archive] [--repo-root <dir>]`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }
  await buildStandaloneBundle(args);
  return 0;
}

if (require.main === module) {
  main().then(code => { if (code) process.exit(code); }).catch(error => {
    console.error(`[standalone-bundle] ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = {
  BUNDLE_README,
  DEFAULT_NODE_VERSION,
  LAUNCHER_LIB_FILES,
  MACOS_FLOOR,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  archiveBundle,
  assertNodeVersionSupported,
  buildStandaloneBundle,
  bundleName,
  bundleReadme,
  copyLauncher,
  extractRuntime,
  fetchNodeRuntime,
  macosFloorForNode,
  macosCommandScript,
  macosInfoPlist,
  macosLauncherScript,
  multiccWrapper,
  multiccWrapperWindows,
  nodeDistFileName,
  nodeDistUrl,
  parseArgs,
  parseShasums,
  posixScript,
  runtimeNodePath,
  sanityGate,
  sha256File,
  stageResources,
  verifyRuntimeArch,
  verifyRuntimeSqlite,
  windowsCommandScript,
  writeManifest,
  writePlatformShell,
};
