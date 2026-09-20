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
// `-mmacosx-version-min=11.0`, and better-sqlite3's darwin-x64 prebuild targets
// 10.7, so a bundle pinned to Node 22 runs there untouched.
//
//   node scripts/portable-bundle.js --platform darwin --arch x64
//
// Result:
//   <out>/multicc-portable-<version>-<platform>-<arch>/     bundle directory
//   <out>/multicc-portable-<version>-<platform>-<arch>.tar.gz(+ .sha256)
//
// Layout (macOS; Linux/Windows use the same Resources/ tree without the .app):
//   MultiCC.app/Contents/Resources/app-server/   server.js + src/ + public/ + node_modules
//   MultiCC.app/Contents/Resources/runtime/      the pinned Node runtime
//   MultiCC.app/Contents/Resources/launcher/     portable-launcher.js + lib/ (desktop/lib)

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { stageServer } = require('./desktop-bundle-server');
const { verifyNativeArch } = require('./native-arch');

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
const NODE_DIST_BASE = 'https://nodejs.org/dist';
const BUNDLE_README = '使用说明.txt';
// better-sqlite3 is the one native dependency the server cannot start without.
const NATIVE_SMOKE_MODULE = 'better-sqlite3';

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
    cacheDir: path.join(os.tmpdir(), 'multicc-portable-cache'),
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
  return `multicc-portable-${version}-${platform}-${arch}`;
}

function nodeDistFileName(nodeVersion, platform, arch) {
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return `node-v${nodeVersion}-${NODE_PLATFORM[platform]}-${arch}.${ext}`;
}

function nodeDistUrl(nodeVersion, platform, arch) {
  return `${NODE_DIST_BASE}/v${nodeVersion}/${nodeDistFileName(nodeVersion, platform, arch)}`;
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
    logger.log(`[portable-bundle] downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`);
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
      logger.log(`[portable-bundle] download failed (${error.message})`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw new Error(`download failed after ${attempts} attempts for ${url}: ${lastError && lastError.message}`);
}

async function fetchNodeRuntime({ nodeVersion, platform, arch, cacheDir, runtimeTarball, logger = console }) {
  const fileName = nodeDistFileName(nodeVersion, platform, arch);
  if (runtimeTarball) {
    if (!fs.existsSync(runtimeTarball)) throw new Error(`--runtime-tarball not found: ${runtimeTarball}`);
    logger.log(`[portable-bundle] using local runtime archive ${runtimeTarball} (sha256 not verified)`);
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
  logger.log(`[portable-bundle] runtime checksum verified (${fileName})`);
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
  const nodeBin = path.join(dest, 'bin', platform === 'win32' ? 'node.exe' : 'node');
  if (!fs.existsSync(nodeBin)) throw new Error(`runtime archive has no ${path.relative(dest, nodeBin)}`);
  if (platform !== 'win32') fs.chmodSync(nodeBin, 0o755);
  logger.log(`[portable-bundle] runtime ready (${path.relative(path.dirname(dest), nodeBin)})`);
  return dest;
}

function copyLauncher({ repoRoot, resourcesDir, logger = console }) {
  const launcherDir = path.join(resourcesDir, 'launcher');
  const libDir = path.join(launcherDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'portable-launcher.js'),
    path.join(launcherDir, 'portable-launcher.js'));
  for (const file of LAUNCHER_LIB_FILES) {
    fs.copyFileSync(path.join(repoRoot, 'desktop', 'lib', file), path.join(libDir, file));
  }
  logger.log(`[portable-bundle] launcher staged (${LAUNCHER_LIB_FILES.length} shared lib module(s))`);
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
  <string>io.github.lsjwzh.multicc.portable</string>
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
# MultiCC portable entry point. LaunchServices runs this file directly (no
# Terminal window appears); it hands over to the bundled Node runtime.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$(cd "$HERE/../Resources" && pwd)"
exec "$RESOURCES/runtime/bin/node" "$RESOURCES/launcher/portable-launcher.js" --start "$@"
`;
}

function macosCommandScript({ action, extraFlags = '' }) {
  return `#!/bin/sh
# Double-click wrapper: ${action}. Keep this file next to MultiCC.app.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$HERE/MultiCC.app/Contents/Resources/runtime/bin/node"
LAUNCHER="$HERE/MultiCC.app/Contents/Resources/launcher/portable-launcher.js"
if [ ! -x "$NODE" ]; then
  echo "找不到内置运行时：$NODE" >&2
  echo "请确认 MultiCC.app 与本文件在同一目录，且已完整解压（不要只拷 .command）。" >&2
  exit 1
fi
exec "$NODE" "$LAUNCHER" ${action}${extraFlags ? ` ${extraFlags}` : ''} "$@"
`;
}

function posixScript({ platform, action, extraFlags = '' }) {
  return `#!/bin/sh
# MultiCC portable launcher (${action}). Keep this file next to Resources/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/Resources/runtime/bin/node" "$HERE/Resources/launcher/portable-launcher.js" ${action}${extraFlags ? ` ${extraFlags}` : ''} "$@"
`;
}

function windowsCommandScript({ action, extraFlags = '' }) {
  return `@echo off
rem MultiCC portable launcher (${action}). Keep this file next to Resources\\.
setlocal
set "HERE=%~dp0"
"%HERE%Resources\\runtime\\bin\\node.exe" "%HERE%Resources\\launcher\\portable-launcher.js" ${action}${extraFlags ? ` ${extraFlags}` : ''} %*
`;
}

function bundleReadme({ version, platform, nodeVersion, macosFloor }) {
  const mac = platform === 'darwin';
  const lines = [
    `MultiCC 便携版 ${version}（${platform}，内置 Node ${nodeVersion}）`,
    '',
    '这个包不依赖你机器上安装的 Node、Homebrew 或 Xcode：运行时和服务器依赖都在包内。',
    '',
    mac ? '## 启动' : '## 启动',
    mac
      ? '1. 双击 `MultiCC.app`（首次打开若提示「无法验证开发者」：右键点图标 → 打开 → 再点「打开」）。\n'
        + '   等价方式：双击 `启动 MultiCC.command`（后台启动，不占用终端窗口）。'
      : '1. 运行 `start-multicc.sh`（Linux）或 `Start-MultiCC.cmd`（Windows）。',
    mac
      ? '2. 浏览器会自动打开 MultiCC 界面（默认 http://127.0.0.1:3000，端口被占用时自动往后找）。'
      : '2. 浏览器会自动打开 MultiCC 界面（默认 http://127.0.0.1:3000，端口被占用时自动往后找）。',
    '',
    '## 停止 / 查看状态',
    mac
      ? '- 停止：双击 `停止 MultiCC.command`（它会请监管进程优雅排空后再退出，不要直接强杀）。\n'
        + '- 状态：双击 `查看状态 MultiCC.command`。\n'
        + '- 三个 `.command` 都会把额外参数透传给启动器，例如 `启动 MultiCC.command --port 8123`。'
      : '- 停止：`stop-multicc.sh`（Linux）/ `Stop-MultiCC.cmd`（Windows）。\n'
        + '- 状态：上述脚本加 `--status`。',
    '',
    '## 数据位置',
    mac
      ? '- 会话、provider、聊天记录、记忆：`~/Library/Application Support/MultiCCPortable/`'
      : '- 会话、provider、聊天记录、记忆：用户配置目录下的 `MultiCCPortable/`',
    '- 日志：上述目录的 `logs/`（`server-*.log`、`portable.log`）',
    '- 升级包时只替换 `' + (mac ? 'MultiCC.app' : 'Resources') + '`，数据目录不要动。',
    '',
    '## 系统要求',
    mac
      ? `- macOS ${macosFloor} 及以上（Intel 与 Apple Silicon 均可）。`
      : '- 64 位 Linux / Windows 10 及以上。',
    `- 内置 Node 运行时 ${nodeVersion}；不要把它换成 Node 24+：Node 24+ 要求 macOS 13.5 起。`,
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
      macosCommandScript({ action: '--start', extraFlags: '--detach' }), 0o755);
    writeFileMode(path.join(bundleDir, '停止 MultiCC.command'),
      macosCommandScript({ action: '--stop' }), 0o755);
    writeFileMode(path.join(bundleDir, '查看状态 MultiCC.command'),
      macosCommandScript({ action: '--status' }), 0o755);
  } else if (platform === 'linux') {
    writeFileMode(path.join(bundleDir, 'start-multicc.sh'),
      posixScript({ platform, action: '--start' }), 0o755);
    writeFileMode(path.join(bundleDir, 'stop-multicc.sh'),
      posixScript({ platform, action: '--stop' }), 0o755);
  } else {
    writeFileMode(path.join(bundleDir, 'Start-MultiCC.cmd'),
      windowsCommandScript({ action: '--start' }));
    writeFileMode(path.join(bundleDir, 'Stop-MultiCC.cmd'),
      windowsCommandScript({ action: '--stop' }));
  }
  writeFileMode(path.join(bundleDir, platform === 'darwin' ? BUNDLE_README : 'README.txt'),
    bundleReadme({ version, platform, nodeVersion, macosFloor }));
  logger.log(`[portable-bundle] ${platform} wrappers written`);
}

function sanityGate({ bundleDir, resourcesDir, platform, arch, install, runtime, appServerDir, logger = console }) {
  const must = [
    path.join(appServerDir, 'server.js'),
    path.join(appServerDir, 'public', 'manage.html'),
    path.join(appServerDir, 'plugins', 'bridges', 'wechat-ilink.js'),
    path.join(resourcesDir, 'launcher', 'portable-launcher.js'),
    ...LAUNCHER_LIB_FILES.map(file => path.join(resourcesDir, 'launcher', 'lib', file)),
    ...(install ? [
      path.join(appServerDir, 'node_modules', 'express'),
      path.join(appServerDir, 'node_modules', 'better-sqlite3'),
    ] : []),
    ...(runtime ? [path.join(resourcesDir, 'runtime', 'bin', platform === 'win32' ? 'node.exe' : 'node')] : []),
  ];
  for (const file of must) {
    if (!fs.existsSync(file)) throw new Error(`bundle is missing ${path.relative(bundleDir, file) || file}`);
  }
  // Presence is not enough: an addon built for the build host installs fine and
  // only fails at the first require() on the target machine.
  verifyNativeArch({ root: appServerDir, arch, platform, allowNone: !install, logger });
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
  logger.log('[portable-bundle] sanity gate passed');
}

// The one check that proves the bundle will actually boot: load the native
// addon with the runtime that ships next to it. Everything else (file lists,
// ABI-looking prebuild names) can pass while `new Database()` still fails.
// Cross-arch builds on a host that cannot execute the target runtime (Linux
// arm64 building x64) skip instead of failing — CI runs those natively.
function verifyStagedNative({
  appServerDir,
  runtimeNode,
  moduleName = NATIVE_SMOKE_MODULE,
  logger = console,
  timeoutMs = 60_000,
} = {}) {
  const moduleDir = path.join(appServerDir, 'node_modules', moduleName);
  if (!fs.existsSync(moduleDir)) {
    logger.log(`[portable-bundle] native smoke skipped: ${moduleName} is not staged`);
    return { ok: false, skipped: true, reason: 'module-missing' };
  }
  if (!runtimeNode || !fs.existsSync(runtimeNode)) {
    logger.log('[portable-bundle] native smoke skipped: no bundled runtime to test with');
    return { ok: false, skipped: true, reason: 'runtime-missing' };
  }
  const script = `const Database = require(${JSON.stringify(moduleDir)});`
    + "const db = new Database(':memory:'); db.exec('create table t(x)'); db.close(); console.log('native-ok');";
  const res = spawnSync(runtimeNode, ['-e', script], { encoding: 'utf8', timeout: timeoutMs });
  if (res.error) {
    const code = res.error.code;
    if (code === 'ENOEXEC' || code === 'EPERM' || code === 'EACCES') {
      logger.log(`[portable-bundle] native smoke skipped: this host cannot execute the target runtime (${code})`);
      return { ok: false, skipped: true, reason: code };
    }
    throw new Error(`native smoke could not run: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const output = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-6).join(' | ');
    throw new Error(`the bundled runtime cannot load ${moduleName}: ${output}`);
  }
  logger.log(`[portable-bundle] native smoke passed (${moduleName} loads under the bundled runtime)`);
  return { ok: true, skipped: false };
}

function writeManifest({ resourcesDir, version, platform, arch, nodeVersion, nodeRuntime, install }) {
  const manifest = {
    name: 'multicc-portable',
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

function archiveBundle({ bundleDir, outDir, name, logger = console }) {
  const archive = path.join(outDir, `${name}.tar.gz`);
  fs.rmSync(archive, { force: true });
  const res = spawnSync('tar', ['-czf', archive, '-C', outDir, path.basename(bundleDir)], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(res.status === null
      ? `tar never completed (${res.error ? res.error.code || res.error.message : 'unknown error'})`
      : `tar failed with status ${res.status}`);
  }
  const digest = sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  const bytes = fs.statSync(archive).size;
  logger.log(`[portable-bundle] archive ${path.basename(archive)} (${(bytes / 1048576).toFixed(1)} MB)`);
  return { archive, sha256: digest, bytes };
}

async function buildPortableBundle(args, { logger = console } = {}) {
  const repoRoot = path.resolve(args.repoRoot || path.join(__dirname, '..'));
  const outDir = path.resolve(args.out || path.join(repoRoot, 'dist-portable'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = rootPkg.version;
  const name = bundleName(version, args.platform, args.arch);
  const bundleDir = path.join(outDir, name);
  const resourcesDir = args.platform === 'darwin'
    ? path.join(bundleDir, 'MultiCC.app', 'Contents', 'Resources')
    : path.join(bundleDir, 'Resources');
  assertNodeVersionSupported(args.nodeVersion);
  if (args.platform === 'darwin' && Number(String(args.nodeVersion).split('.')[0]) >= 24) {
    logger.error(`[portable-bundle] WARNING: Node ${args.nodeVersion} requires macOS 13.5+ — `
      + 'this bundle will no longer start on macOS 11/12.');
  }

  logger.log(`[portable-bundle] building ${name} (node ${args.nodeVersion}) -> ${bundleDir}`);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Cross-arch builds: the staged production deps (and every prebuilt native
  // addon in them) must match the TARGET, not the build host. better-sqlite3's
  // prebuild-install reads npm_config_arch when picking its binary.
  const npmEnv = {
    // Target the BUNDLED runtime, not the build host. prebuild-install picks
    // its binary from npm_config_target (falling back to the running Node), so
    // without this the staged better-sqlite3 is built for whatever Node runs
    // the build — ABI 147 on a Node 26 host — and the bundle dies at the first
    // `new Database()` with ERR_DLOPEN_FAILED.
    npm_config_target: args.nodeVersion,
    npm_config_runtime: 'node',
    npm_config_arch: args.arch,
    npm_config_platform: args.platform,
    npm_config_os: args.platform,
    npm_config_cpu: args.arch,
  };
  const staged = stageServer({
    repoRoot,
    out: path.join(resourcesDir, 'app-server'),
    install: args.install,
    npmEnv,
    logger,
  });

  let runtime = null;
  if (args.runtime) {
    const fetched = await fetchNodeRuntime({
      nodeVersion: args.nodeVersion,
      platform: args.platform,
      arch: args.arch,
      cacheDir: args.cacheDir,
      runtimeTarball: args.runtimeTarball,
      logger,
    });
    extractRuntime({
      archive: fetched.archive,
      platform: args.platform,
      dest: path.join(resourcesDir, 'runtime'),
      logger,
    });
    runtime = fetched;
  } else {
    logger.log('[portable-bundle] --no-runtime: skipping the Node runtime');
  }

  if (args.verify && args.install && args.runtime) {
    verifyStagedNative({
      appServerDir: staged.out,
      runtimeNode: path.join(resourcesDir, 'runtime', 'bin', args.platform === 'win32' ? 'node.exe' : 'node'),
      logger,
    });
  }

  copyLauncher({ repoRoot, resourcesDir, logger });
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
  if (args.archive && args.platform !== 'win32') {
    archive = archiveBundle({ bundleDir, outDir, name, logger });
  } else if (args.archive) {
    logger.log('[portable-bundle] archive skipped on win32 (ship the directory or zip it in CI)');
  }
  logger.log(`[portable-bundle] done: ${bundleDir}`);
  return { bundleDir, outDir, name, version, manifest, archive, staged };
}

function usage() {
  console.log(`usage: portable-bundle.js [--platform darwin|linux|win32] [--arch x64|arm64]
                            [--node-version ${DEFAULT_NODE_VERSION}] [--out <dir>] [--runtime-tarball <path>]
                            [--no-install] [--no-runtime] [--no-verify] [--no-archive] [--repo-root <dir>]`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }
  await buildPortableBundle(args);
  return 0;
}

if (require.main === module) {
  main().then(code => { if (code) process.exit(code); }).catch(error => {
    console.error(`[portable-bundle] ${error && error.message}`);
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
  buildPortableBundle,
  bundleName,
  bundleReadme,
  copyLauncher,
  extractRuntime,
  fetchNodeRuntime,
  macosFloorForNode,
  macosInfoPlist,
  macosLauncherScript,
  nodeDistFileName,
  nodeDistUrl,
  parseArgs,
  parseShasums,
  sanityGate,
  sha256File,
  verifyStagedNative,
  writePlatformShell,
};
