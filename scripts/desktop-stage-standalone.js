#!/usr/bin/env node
'use strict';

// Stage the standalone Resources tree that the Electron desktop app wraps.
//
// The desktop app is a shell around the standalone release, not a second build
// of the server: this stages the exact tree scripts/standalone-bundle.js puts
// in `multicc-standalone-<version>-<platform>-<arch>` — app-server (server +
// production deps), the pinned Node runtime, and the launcher — and
// electron-builder ships it as extraResources. desktop/lib/desktop-env.js then
// resolves the bundled runtime from there, so the dmg and the tarball run the
// same code on the same pinned Node (22.x, node:sqlite included) instead of the
// Electron binary's own Node.
//
//   node scripts/desktop-stage-standalone.js --out desktop/.staging/resources
//
// What a bundle root would add on top (the `multicc` command, the
// `.command`/`.sh`/`.cmd` wrappers, the archive) is deliberately NOT written
// here: inside an .app none of those paths exist, and a half-valid copy of the
// user-facing command would be worse than none.
//
// Flags mirror standalone-bundle.js so a build machine has one vocabulary:
//   --out <dir>            where to stage (default desktop/.staging/resources)
//   --platform, --arch     target (defaults to the host — see the arch gate)
//   --node-version         pinned runtime (default 22.23.2)
//   --runtime-tarball      use a local runtime archive instead of downloading
//   --repo-root            source checkout (default: this repo)
//   --no-install           copy the server without npm install (dev only)
//   --no-runtime           skip the Node runtime (dev only)
//   --no-verify            skip booting the staged runtime

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_NODE_VERSION,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  stageResources,
  writeManifest,
} = require('./standalone-bundle');

function parseArgs(argv) {
  const args = {
    out: null,
    repoRoot: null,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: DEFAULT_NODE_VERSION,
    install: true,
    runtime: true,
    verify: true,
    runtimeTarball: null,
    cacheDir: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--repo-root') args.repoRoot = argv[++i];
    else if (arg === '--platform') args.platform = argv[++i];
    else if (arg === '--arch') args.arch = argv[++i];
    else if (arg === '--node-version') args.nodeVersion = argv[++i];
    else if (arg === '--runtime-tarball') args.runtimeTarball = path.resolve(argv[++i]);
    else if (arg === '--cache-dir') args.cacheDir = path.resolve(argv[++i]);
    else if (arg === '--install') args.install = true;
    else if (arg === '--no-install') args.install = false;
    else if (arg === '--runtime') args.runtime = true;
    else if (arg === '--no-runtime') args.runtime = false;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--no-verify') args.verify = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
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

async function stageDesktopResources(args, { logger = console } = {}) {
  const repoRoot = path.resolve(args.repoRoot || path.join(__dirname, '..'));
  const outDir = path.resolve(args.out || path.join(repoRoot, 'desktop', '.staging', 'resources'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  logger.log(`[desktop-stage] staging ${args.platform}/${args.arch} (node ${args.nodeVersion}) -> ${outDir}`);
  const { staged } = await stageResources({
    repoRoot,
    resourcesDir: outDir,
    platform: args.platform,
    arch: args.arch,
    nodeVersion: args.nodeVersion,
    install: args.install,
    runtime: args.runtime,
    verify: args.verify,
    cacheDir: args.cacheDir || undefined,
    runtimeTarball: args.runtimeTarball,
    logger,
  });

  // Same manifest a standalone package carries: it is how a support request
  // answers "which server, on which runtime" without inspecting the app.
  const manifest = writeManifest({
    resourcesDir: outDir,
    version: rootPkg.version,
    platform: args.platform,
    arch: args.arch,
    nodeVersion: args.nodeVersion,
    nodeRuntime: args.runtime ? 'bundled' : 'none',
    install: args.install,
  });

  // electron-builder copies these entries (desktop/package.json extraResources)
  // into Contents/Resources. A missing one is a dmg that only fails on the
  // user's machine, so fail the build here instead.
  const must = [
    'bundle-manifest.json',
    'app-server/server.js',
    'launcher/standalone-launcher.js',
    'launcher/standalone-cli.js',
    'launcher/lib/backend-supervisor.js',
    'launcher/lib/desktop-env.js',
  ];
  if (args.runtime) {
    must.push(args.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node');
  }
  for (const rel of must) {
    if (!fs.existsSync(path.join(outDir, rel))) {
      throw new Error(`staged desktop resources are missing ${rel}`);
    }
  }
  logger.log(`[desktop-stage] done: ${outDir}`);
  return { outDir, manifest, staged };
}

function usage() {
  console.log(`usage: desktop-stage-standalone.js [--out <dir>] [--platform darwin|linux|win32] [--arch x64|arm64]
                                   [--node-version ${DEFAULT_NODE_VERSION}] [--runtime-tarball <path>]
                                   [--repo-root <dir>] [--no-install] [--no-runtime] [--no-verify]`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  await stageDesktopResources(args);
  return 0;
}

if (require.main === module) {
  main().then(code => { if (code) process.exit(code); }).catch(error => {
    console.error(`[desktop-stage] ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, stageDesktopResources, usage };
