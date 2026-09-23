#!/usr/bin/env node
'use strict';

// Stage a self-contained copy of the MultiCC server for the desktop build
// (electron-builder extraResources). The staged tree is what the packaged app
// runs via ELECTRON_RUN_AS_NODE, so it must contain everything the server
// touches at runtime and nothing that belongs to development:
//
//   in:  server.js  src/  public/ (minus the 62MB APK + its metadata)  plugins/
//        scripts/multicc-router-mcp.js
//        package.json transformed — sherpa-onnx-node moves from dependencies
//        to optionalDependencies so a platform without its prebuilt binary
//        still installs (the server degrades to cloud ASR; see src/voice/asr-local.js)
//   out: <out>/node_modules via `npm install --omit=dev` (not npm ci — the
//        dependency transform intentionally desyncs the lock)
//
// Run with --no-install to stage without network access (tests do this).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OPTIONAL_AT_RUNTIME = ['sherpa-onnx-node'];
const PUBLIC_EXCLUDE = [/^multicc\.apk(\..*)?$/];

function parseArgs(argv) {
  const args = { out: null, repoRoot: null, install: true, arch: null, platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--repo-root') args.repoRoot = argv[++i];
    else if (argv[i] === '--arch') args.arch = argv[++i];
    else if (argv[i] === '--platform') args.platform = argv[++i];
    else if (argv[i] === '--install') args.install = true;
    else if (argv[i] === '--no-install') args.install = false;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  if (args.arch && !['x64', 'arm64', 'ia32'].includes(args.arch)) {
    console.error(`unsupported --arch ${args.arch} (expected x64|arm64|ia32)`);
    process.exit(2);
  }
  if (args.platform && !['darwin', 'linux', 'win32'].includes(args.platform)) {
    console.error(`unsupported --platform ${args.platform} (expected darwin|linux|win32)`);
    process.exit(2);
  }
  return args;
}

// Cross-arch staging. The macOS desktop job builds arm64 and x64 dmgs from one
// Apple Silicon runner, so the staged optional deps (sherpa-onnx ships one
// prebuilt package per platform) must resolve for the target — a single staged
// tree on the host arch is what once put an arm64 SQLite addon inside the x64
// dmg. npm's own view of the target comes from --os/--cpu (added in
// stageServer), while prebuilt-package resolution reads
// npm_config_arch/npm_config_platform.
function crossArchNpmEnv({ arch, platform }) {
  const npmEnv = {};
  if (arch) { npmEnv.npm_config_arch = arch; npmEnv.npm_config_cpu = arch; }
  if (platform) { npmEnv.npm_config_platform = platform; npmEnv.npm_config_os = platform; }
  return npmEnv;
}

function copyTree(src, dest, { filter } = {}) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      const base = path.basename(srcPath);
      if (filter && filter.some(re => re.test(base))) return false;
      return true;
    },
  });
}

function transformPackageJson(pkg) {
  const dependencies = { ...(pkg.dependencies || {}) };
  const optionalDependencies = { ...(pkg.optionalDependencies || {}) };
  for (const name of OPTIONAL_AT_RUNTIME) {
    if (dependencies[name]) {
      optionalDependencies[name] = dependencies[name];
      delete dependencies[name];
    }
  }
  return {
    name: pkg.name,
    version: pkg.version,
    private: true,
    description: pkg.description,
    engines: pkg.engines,
    dependencies,
    optionalDependencies,
    // The desktop shell owns process lifecycle; the manager script is not
    // used inside the packaged app (restart/update are gated server-side).
    scripts: { start: 'node server.js' },
  };
}

// Stage the server tree. Reused by the desktop build (extraResources) and by
// the standalone package (scripts/standalone-bundle.js, via stageResources()),
// so the list of files that must travel with the server exists exactly once.
//
//   out     — destination directory (wiped first)
//   install — run `npm install --omit=dev` in the staged tree
//   npmEnv  — extra env for that install. Cross-arch builds pass
//             npm_config_arch/npm_config_os so optional deps and prebuilds
//             resolve for the TARGET platform, not the build host.
function stageServer({ repoRoot, out, install = true, npmEnv = {}, logger = console }) {
  logger.log(`[desktop-bundle-server] staging ${repoRoot} -> ${out}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  // 1) source trees the server reads at runtime. plugins/ is not optional:
  //   server.js requires ./plugins/bridges/* at boot (caught by the local
  //   real-server smoke, not by the sentinel list alone).
  for (const entry of ['server.js', 'src', 'public', 'plugins', 'skills']) {
    const src = path.join(repoRoot, entry);
    if (!fs.existsSync(src)) throw new Error(`missing ${src} — run from the repo root`);
    if (entry === 'public') copyTree(src, path.join(out, 'public'), { filter: PUBLIC_EXCLUDE });
    else copyTree(src, path.join(out, entry));
  }
  // 2) the single script src/ spawns out of the repo tree (router MCP child)
  fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'multicc-router-mcp.js'),
    path.join(out, 'scripts', 'multicc-router-mcp.js'));
  // 3) transformed manifest, then production deps
  fs.writeFileSync(path.join(out, 'package.json'),
    `${JSON.stringify(transformPackageJson(rootPkg), null, 2)}\n`);

  if (install) {
    logger.log('[desktop-bundle-server] installing production dependencies…');
    // Node >= 20.12 refuses to spawn .cmd/.bat without a shell, so npm.cmd needs
    // shell: true on Windows; spawnSync reports that refusal as status null.
    const win = process.platform === 'win32';
    // Cross-arch staging: npm's --os/--cpu drive optional-dependency
    // resolution, which is the part npm still understands (npm_config_arch /
    // npm_config_platform stay in the env for prebuild-install, see
    // standalone-bundle.js).
    const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund'];
    if (npmEnv.npm_config_os) npmArgs.push(`--os=${npmEnv.npm_config_os}`);
    if (npmEnv.npm_config_cpu) npmArgs.push(`--cpu=${npmEnv.npm_config_cpu}`);
    const res = spawnSync(win ? 'npm.cmd' : 'npm', npmArgs, {
      cwd: out, stdio: 'inherit', shell: win, env: { ...process.env, ...npmEnv },
    });
    if (res.status !== 0) {
      throw new Error(res.status === null
        ? `npm install never completed (${res.error ? res.error.code || res.error.message : `killed by signal ${res.signal}`})`
        : `npm install failed with status ${res.status}`);
    }
  } else {
    logger.log('[desktop-bundle-server] --no-install: skipping dependency install');
  }

  // 4) sanity gate — a silent missing file here becomes "app won't start" there
  for (const must of ['server.js', 'src/paths.js', 'public/air.html', 'public/chat.html',
    'scripts/multicc-router-mcp.js', 'plugins/bridges/wechat-ilink.js',
    'skills/multicc-artifact/references/registration-rule.md',
    // Storage needs no compiled addon (src/sqlite/driver.js uses the SQLite
    // that ships inside Node), so express is the only hard module to prove.
    ...(install ? [path.join('node_modules', 'express')] : [])]) {
    if (!fs.existsSync(path.join(out, must))) throw new Error(`staged copy is missing ${must}`);
  }
  const staged = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  for (const name of OPTIONAL_AT_RUNTIME) {
    if (staged.dependencies[name]) throw new Error(`${name} must be optional in the staged manifest`);
  }

  // better-sqlite3 is not ours any more: the server stores its state in the
  // SQLite that ships inside Node (src/sqlite/driver.js). It still lands in the
  // tree as cli-provider-router's *optional* dependency, and it is the one
  // artifact there whose binary must match the runtime it is packaged with —
  // exactly the mismatch that once put an arm64 addon inside the x64 dmg. The
  // server never loads it (MultiCC's CC-Switch import uses the driver), and
  // CPR's SQLite-backed flows are written to report themselves unavailable when
  // the optional package is absent — so ship without it. Add it back if a
  // bundled flow ever needs CPR's own CC-Switch import/takeover.
  const optionalSqliteAddon = path.join(out, 'node_modules', 'better-sqlite3');
  if (install && fs.existsSync(optionalSqliteAddon)) {
    fs.rmSync(optionalSqliteAddon, { recursive: true, force: true });
    logger.log('[desktop-bundle-server] dropped the optional better-sqlite3 addon (storage is node:sqlite)');
  }
  const versionMatch = staged.version === rootPkg.version;
  logger.log(`[desktop-bundle-server] done (version ${staged.version}${versionMatch ? '' : ` — MISMATCH vs root ${rootPkg.version}`}, install=${install})`);
  return { out, version: staged.version, rootVersion: rootPkg.version, versionMatch, install };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: desktop-bundle-server.js [--out <dir>] [--repo-root <dir>] [--no-install]'
      + ' [--arch x64|arm64|ia32] [--platform darwin|linux|win32]');
    process.exit(0);
  }
  const repoRoot = path.resolve(args.repoRoot || path.join(__dirname, '..'));
  const out = path.resolve(args.out || path.join(repoRoot, 'desktop', '.staging', 'app-server'));
  const npmEnv = crossArchNpmEnv(args);
  if (Object.keys(npmEnv).length) {
    console.log(`[desktop-bundle-server] cross-arch staging for ${args.platform || 'this platform'}`
      + `/${args.arch || 'this arch'}`);
  }
  const result = stageServer({ repoRoot, out, install: args.install, npmEnv });
  if (!result.versionMatch) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`[desktop-bundle-server] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  OPTIONAL_AT_RUNTIME, PUBLIC_EXCLUDE, parseArgs, copyTree, crossArchNpmEnv,
  transformPackageJson, stageServer, main,
};
