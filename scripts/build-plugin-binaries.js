#!/usr/bin/env node
'use strict';
// 内置插件的平台二进制：发版时每个 standalone / 桌面包都要带上目标平台那一份。
//
//   plugins/<id>/plugin.json 声明 engine.binaryPlatformDir 且目录里有 Cargo.toml
//     → cargo 编译到 plugins/<id>/<binaryPlatformDir>/<platform>-<arch>/
//   plugins/<id>/bundled-binaries.json（可选）→ 按平台下载第三方单文件（如 meow 内核），
//     sha256 校验后 gzip 放进同一目录
//
// 打包（desktop-bundle-server.js → stagePluginBinaries）只保留目标平台目录。
// 仓库里只提交 darwin-arm64 一份；其他平台在发版流水线里现编。
//
// Linux 产物一律用 musl 静态链接：CI 的 ubuntu-latest 比用户机器的 glibc 新，
// gnu 产物在 AlmaLinux 9 这类发行版上会因 GLIBC_2.3x 符号缺失起不来。
// 交叉编译 Linux 时走 cargo-zigbuild（自带 musl 交叉链接器，不依赖系统工具链）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { verify } = require('./build-rust-kernels');

const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

function targetFor(platform, arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`插件二进制不支持的目标：${platform}-${arch}`);
  return target;
}

function binaryFileName(binary, platform) {
  const base = path.basename(binary);
  return platform === 'win32' && !base.endsWith('.exe') ? `${base}.exe` : base;
}

// 需要编译的内置插件：命令型、按平台分目录、带 Rust 源码。没有 Cargo.toml 的
// 插件（自带脚本或现成二进制）不归这里管。
function compiledPlugins(repoRoot) {
  const root = path.join(repoRoot, 'plugins');
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    } catch (_) {
      continue;
    }
    const engine = manifest.engine || {};
    if (engine.type !== 'command' || !engine.binary || !engine.binaryPlatformDir) continue;
    if (!fs.existsSync(path.join(dir, 'Cargo.toml'))) continue;
    found.push({ id: manifest.id || entry.name, dir, manifest });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function platformDir(plugin, platform, arch) {
  return path.join(plugin.dir, plugin.manifest.engine.binaryPlatformDir, `${platform}-${arch}`);
}

function readBundledAssets(plugin) {
  const file = path.join(plugin.dir, 'bundled-binaries.json');
  if (!fs.existsSync(file)) return [];
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (body.schema !== 1 || !Array.isArray(body.assets)) {
    throw new Error(`${plugin.id}/bundled-binaries.json 格式不认识（需要 schema 1 + assets 数组）`);
  }
  return body.assets;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hostTriple(run = spawnSync) {
  const result = run('rustc', ['-vV'], { encoding: 'utf8' });
  const line = `${result.stdout || ''}`.split('\n').find(item => item.startsWith('host:'));
  if (result.error || result.status !== 0 || !line) throw new Error('找不到 rustc；请先安装 Rust 工具链');
  return line.slice('host:'.length).trim();
}

// 同一目标直接 cargo build；交叉到 Linux 用 cargo zigbuild。其余交叉组合
// （macOS 双架构、Windows）由宿主自带的工具链负责，CI 里已 rustup target add。
function cargoCommand({ target, host }) {
  if (target !== host && target.includes('-linux-')) return ['zigbuild'];
  return ['build'];
}

function writeIfChanged(file, buffer, { mode } = {}) {
  let same = false;
  try { same = fs.readFileSync(file).equals(buffer); } catch (_) {}
  if (!same) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, file);
  }
  if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(file, mode);
  return !same;
}

// 未知子命令必须按插件协议回一行 {"ok":false,...}：能说出这句话才算真能跑。
function probePluginBinary(file, { run = spawnSync } = {}) {
  const result = run(file, ['__multicc_build_probe__'], { input: '{}', encoding: 'utf8', timeout: 15_000 });
  let reply = null;
  try { reply = JSON.parse(`${result.stdout || ''}`.trim().split('\n').pop()); } catch (_) {}
  return { ok: !result.error && !!reply && reply.ok === false, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

function buildPluginBinary(plugin, { platform, arch, host, targetDir, run = spawnSync, logger = console }) {
  const target = targetFor(platform, arch);
  const cargoTarget = path.resolve(targetDir || process.env.CARGO_TARGET_DIR || path.join(plugin.dir, 'target'));
  const args = [...cargoCommand({ target, host }), '--locked', '--release',
    '--manifest-path', path.join(plugin.dir, 'Cargo.toml'), '--target', target];
  const result = run('cargo', args, { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: cargoTarget } });
  if (result.error || result.status !== 0) {
    const hint = args[0] === 'zigbuild' ? '（交叉编译 Linux 需要 cargo-zigbuild：pip install cargo-zigbuild）' : '';
    throw new Error(`插件 ${plugin.id} 编译失败：${target}${hint}`);
  }
  const name = binaryFileName(plugin.manifest.engine.binary, platform);
  const source = path.join(cargoTarget, target, 'release', name);
  verify(source, platform, arch);
  const file = path.join(platformDir(plugin, platform, arch), name);
  writeIfChanged(file, fs.readFileSync(source), { mode: 0o755 });
  if (platform === process.platform && arch === process.arch) {
    const probed = probePluginBinary(file, { run });
    if (!probed.ok) throw new Error(`插件 ${plugin.id} 二进制自检失败：${probed.output || '无输出'}`);
  }
  logger.log(`[plugins] ${plugin.id} ${platform}-${arch} 二进制：${file}`);
  return file;
}

async function download(url, dest, { attempts = 3, logger = console } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      return buffer;
    } catch (error) {
      lastError = error;
      logger.log(`[plugins] 下载失败（${error.message}），第 ${attempt}/${attempts} 次：${url}`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw new Error(`下载失败：${url}（${lastError && lastError.message}）`);
}

function findMember(root, member) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findMember(full, member);
      if (nested) return nested;
    } else if (entry.name === member) {
      return full;
    }
  }
  return null;
}

// tar.gz 各平台 tar 都认；zip 在 Linux 上 GNU tar 不认，先试 unzip。
function extractArchive(archive, dest, { run = spawnSync } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const attempts = archive.endsWith('.zip')
    ? [['unzip', ['-q', '-o', archive, '-d', dest]], ['tar', ['-xf', archive, '-C', dest]]]
    : [['tar', ['-xzf', archive, '-C', dest]]];
  for (const [command, args] of attempts) {
    const result = run(command, args, { stdio: 'ignore' });
    if (!result.error && result.status === 0) return;
  }
  throw new Error(`解压失败：${path.basename(archive)}`);
}

async function stageBundledAsset(plugin, asset, { platform, arch, cacheDir, fetchArchive = download, logger = console }) {
  const spec = (asset.targets || {})[`${platform}-${arch}`];
  if (!spec) {
    logger.log(`[plugins] ${plugin.id} 的 ${asset.name} 没有 ${platform}-${arch} 版本，跳过`);
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(spec.sha256 || '') || !spec.url || !spec.member || !spec.output) {
    throw new Error(`${plugin.id}/bundled-binaries.json 中 ${asset.name} ${platform}-${arch} 缺少 url / sha256 / member / output`);
  }
  const archive = path.join(cacheDir, spec.sha256, path.basename(new URL(spec.url).pathname));
  let buffer = fs.existsSync(archive) ? fs.readFileSync(archive) : null;
  if (!buffer || sha256(buffer) !== spec.sha256) buffer = await fetchArchive(spec.url, archive, { logger });
  const actual = sha256(buffer);
  if (actual !== spec.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(`${asset.name} ${platform}-${arch} sha256 不匹配：期望 ${spec.sha256}，实际 ${actual}`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-plugin-asset-'));
  try {
    extractArchive(archive, scratch);
    const member = findMember(scratch, spec.member);
    if (!member) throw new Error(`${path.basename(archive)} 里没有 ${spec.member}`);
    verify(member, platform, arch);
    const content = fs.readFileSync(member);
    const file = path.join(platformDir(plugin, platform, arch), spec.output);
    // 内容一致就不重写：仓库里提交的 .gz 由 gzip 命令生成，字节和这里不同。
    let same = false;
    try { same = zlib.gunzipSync(fs.readFileSync(file)).equals(content); } catch (_) {}
    if (!same) writeIfChanged(file, zlib.gzipSync(content, { level: 9 }));
    logger.log(`[plugins] ${plugin.id} ${platform}-${arch} ${asset.name} ${asset.version || ''}：${file}`);
    return file;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function buildPluginBinaries({ platform = process.platform, arch = process.arch, repoRoot,
  targetDir, cacheDir = path.join(os.tmpdir(), 'multicc-plugin-assets'), only = null,
  run = spawnSync, logger = console } = {}) {
  const repo = path.resolve(repoRoot || path.resolve(__dirname, '..'));
  targetFor(platform, arch);
  const plugins = compiledPlugins(repo).filter(plugin => !only || only.includes(plugin.id));
  if (!plugins.length) {
    logger.log('[plugins] 没有需要编译的内置插件');
    return [];
  }
  const host = hostTriple(run);
  const produced = [];
  for (const plugin of plugins) {
    const binary = buildPluginBinary(plugin, { platform, arch, host, targetDir, run, logger });
    const assets = [];
    for (const asset of readBundledAssets(plugin)) {
      const file = await stageBundledAsset(plugin, asset, { platform, arch, cacheDir, logger });
      if (file) assets.push(file);
    }
    produced.push({ id: plugin.id, binary, assets });
  }
  return produced;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = { '--platform': 'platform', '--arch': 'arch', '--target-dir': 'targetDir',
      '--cache-dir': 'cacheDir', '--only': 'only' }[flag];
    if (!key || !argv[i + 1]) {
      throw new Error('参数：[--platform 平台] [--arch 架构] [--target-dir 编译缓存] [--cache-dir 下载缓存] [--only 插件id,…]');
    }
    options[key] = argv[++i];
  }
  if (options.only) options.only = options.only.split(',').map(item => item.trim()).filter(Boolean);
  return options;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => buildPluginBinaries(parseArgs(process.argv.slice(2))))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {
  TARGETS, binaryFileName, buildPluginBinaries, cargoCommand, compiledPlugins, extractArchive,
  findMember, parseArgs, platformDir, probePluginBinary, readBundledAssets, stageBundledAsset, targetFor,
};
