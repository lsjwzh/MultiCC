'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { atomicWriteJson, ensurePrivateDir } = require('./runtime-security');

const QWEN_AUDIO_PACKAGE = 'qwen-audio-agent';
const QWEN_AUDIO_PACKAGE_VERSION = '1.1.1';
const QWEN_AUDIO_PACKAGE_INTEGRITY = 'sha512-GTerCeO+XoHLWt+uMMnh3GOjnvxJgKVgEHzylE0UnUs2VovhH8mT5sAu9nV3hzoLOrythvBXziPomiNslRE2bg==';
const QWEN_AUDIO_NODE_VERSION = '24.15.0';
const INSTALL_SCHEMA_VERSION = 1;

// Qwen Audio Agent 1.1.1 explicitly supports Node 24.15.0. MultiCC also runs
// on Node 20 and can be launched from unsupported odd-numbered Node releases,
// so the voice runtime carries a small, pinned Node rather than inheriting the
// host executable by accident. Digests come from nodejs.org's signed release
// manifest for v24.15.0.
const NODE_ARTIFACTS = Object.freeze({
  'darwin-arm64': Object.freeze({
    file: 'node-v24.15.0-darwin-arm64.tar.gz',
    sha256: '372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4',
  }),
  'darwin-x64': Object.freeze({
    file: 'node-v24.15.0-darwin-x64.tar.gz',
    sha256: 'ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b',
  }),
  'linux-arm64': Object.freeze({
    file: 'node-v24.15.0-linux-arm64.tar.gz',
    sha256: '73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed',
  }),
  'linux-x64': Object.freeze({
    file: 'node-v24.15.0-linux-x64.tar.gz',
    sha256: '44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89',
  }),
});

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function safeError(error, fallbackCode = 'install_failed') {
  const known = new Set([
    'install_locked',
    'platform_unsupported',
    'download_failed',
    'node_integrity_mismatch',
    'archive_extract_failed',
    'package_install_failed',
    'package_integrity_mismatch',
    'runtime_smoke_test_failed',
  ]);
  const code = known.has(error?.code) ? error.code : fallbackCode;
  const messages = {
    install_locked: '另一个 Qwen Audio 安装正在进行',
    platform_unsupported: '当前平台暂不支持自动安装 Qwen Audio Runtime',
    download_failed: '下载 Qwen Audio 运行时失败',
    node_integrity_mismatch: 'Qwen Audio 私有 Node 校验失败',
    archive_extract_failed: '解压 Qwen Audio 私有 Node 失败',
    package_install_failed: '安装 Qwen Audio Agent 包失败',
    package_integrity_mismatch: 'Qwen Audio Agent 包校验失败',
    runtime_smoke_test_failed: 'Qwen Audio Runtime 自检失败',
    install_failed: 'Qwen Audio Runtime 安装失败',
  };
  return { code, message: messages[code] || messages.install_failed };
}

function commandPromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: options.timeout || 300000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

async function downloadFile(url, target, {
  fetchImpl = globalThis.fetch,
  maxBytes = 160 * 1024 * 1024,
  timeoutMs = 180000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch unavailable');
    error.code = 'download_failed';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  let handle;
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response?.ok || !response.body) {
      const error = new Error(`download HTTP ${response?.status || 0}`);
      error.code = 'download_failed';
      throw error;
    }
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > maxBytes) {
      const error = new Error('download exceeds size limit');
      error.code = 'download_failed';
      throw error;
    }
    handle = fs.openSync(target, 'wx', 0o600);
    const reader = response.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (_) {}
        const error = new Error('download exceeds size limit');
        error.code = 'download_failed';
        throw error;
      }
      fs.writeSync(handle, value);
    }
    fs.fsyncSync(handle);
  } catch (error) {
    if (!error.code) error.code = 'download_failed';
    throw error;
  } finally {
    clearTimeout(timer);
    if (handle !== undefined) fs.closeSync(handle);
  }
}

async function downloadWithRetry(url, target, {
  attempts = 3,
  retryDelayMs = 1500,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  ...downloadOptions
} = {}) {
  const limit = Math.max(1, Math.min(Number(attempts) || 1, 5));
  let lastError;
  for (let attempt = 1; attempt <= limit; attempt++) {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      await downloadFile(url, target, downloadOptions);
      return;
    } catch (error) {
      lastError = error;
      try { fs.unlinkSync(target); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      }
      if (attempt < limit) await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function safeChildEnv(nodeBin, cacheDir) {
  const env = {
    // Keep user-level npm credentials and registry overrides out of the
    // installer. The official registry plus pinned integrity is the only
    // package source admitted into this managed runtime.
    HOME: cacheDir,
    PATH: `${path.dirname(nodeBin)}${path.delimiter}${process.env.PATH || ''}`,
    NODE_ENV: 'production',
    npm_config_cache: cacheDir,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_engine_strict: 'true',
  };
  for (const name of [
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY',
    'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function createQwenAudioInstaller({
  runtimeRoot,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  run = commandPromise,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError('qwen audio installer requires an absolute runtimeRoot');
  }
  const key = platformKey(platform, arch);
  const artifact = NODE_ARTIFACTS[key] || null;
  const versionKey = `qwen-${QWEN_AUDIO_PACKAGE_VERSION}-node-${QWEN_AUDIO_NODE_VERSION}-${key}`;
  const versionsDir = path.join(runtimeRoot, 'versions');
  const targetDir = path.join(versionsDir, versionKey);
  const activeFile = path.join(runtimeRoot, 'active.json');
  const lockFile = path.join(runtimeRoot, '.install.lock');
  const cacheDir = path.join(runtimeRoot, 'npm-cache');
  let installPromise = null;
  let lifecycleState = 'idle';
  let progress = null;
  let lastError = null;

  function runtimeFromDirectory(directory) {
    if (directory !== versionKey) return null;
    const base = path.join(versionsDir, directory);
    const nodePath = path.join(base, 'node', 'bin', 'node');
    const packageRoot = path.join(base, 'app', 'node_modules', QWEN_AUDIO_PACKAGE);
    const qwenBin = path.join(packageRoot, 'cli', 'bin', 'qwenaudio.mjs');
    const serverEntry = path.join(packageRoot, 'server', 'src', 'index.mjs');
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      if (manifest.name !== QWEN_AUDIO_PACKAGE || manifest.version !== QWEN_AUDIO_PACKAGE_VERSION) return null;
      if (!executable(nodePath) || !fs.statSync(qwenBin).isFile() || !fs.statSync(serverEntry).isFile()) return null;
    } catch (_) {
      return null;
    }
    return Object.freeze({
      directory,
      base,
      nodePath,
      packageRoot,
      qwenBin,
      serverEntry,
      fleetConfigRoot: path.join(runtimeRoot, 'fleets'),
    });
  }

  function resolveInstalled() {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(activeFile, 'utf8')); }
    catch (_) { return null; }
    if (manifest.schemaVersion !== INSTALL_SCHEMA_VERSION
        || manifest.package?.name !== QWEN_AUDIO_PACKAGE
        || manifest.package?.version !== QWEN_AUDIO_PACKAGE_VERSION
        || manifest.package?.integrity !== QWEN_AUDIO_PACKAGE_INTEGRITY
        || manifest.node?.version !== QWEN_AUDIO_NODE_VERSION
        || manifest.node?.sha256 !== artifact?.sha256) {
      return null;
    }
    return runtimeFromDirectory(manifest.directory);
  }

  function status() {
    const runtime = resolveInstalled();
    const state = lifecycleState === 'installing'
      ? 'installing'
      : lastError ? 'error' : runtime ? 'ready' : 'not_installed';
    return {
      state,
      installed: !!runtime,
      supported: !!artifact,
      platform: key,
      package: { name: QWEN_AUDIO_PACKAGE, version: QWEN_AUDIO_PACKAGE_VERSION },
      node: { version: QWEN_AUDIO_NODE_VERSION, managed: true },
      progress,
      lastError,
    };
  }

  function updateProgress(stage, detail = null) {
    lifecycleState = 'installing';
    progress = { stage, detail };
  }

  function lockIsStale() {
    let stat;
    try {
      stat = fs.statSync(lockFile);
      const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const pid = Number(data.pid);
      if (!Number.isInteger(pid) || pid < 1) {
        return Date.now() - stat.mtimeMs > 15 * 60 * 1000;
      }
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    } catch (_) {
      return !!stat && Date.now() - stat.mtimeMs > 15 * 60 * 1000;
    }
  }

  function acquireLock(retried = false) {
    ensurePrivateDir(runtimeRoot);
    let handle;
    try {
      handle = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`);
      return handle;
    } catch (error) {
      if (handle !== undefined) fs.closeSync(handle);
      if (error.code === 'EEXIST') {
        if (!retried && lockIsStale()) {
          try {
            fs.renameSync(lockFile, `${lockFile}.stale-${Date.now()}`);
            return acquireLock(true);
          } catch (_) {}
        }
        const locked = new Error('install already running');
        locked.code = 'install_locked';
        throw locked;
      }
      throw error;
    }
  }

  function releaseLock(handle) {
    try { fs.closeSync(handle); } catch (_) {}
    try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function performInstall() {
    if (!artifact) {
      const error = new Error(`unsupported platform ${key}`);
      error.code = 'platform_unsupported';
      throw error;
    }
    const existing = runtimeFromDirectory(versionKey);
    if (existing) {
      atomicWriteJson(activeFile, {
        schemaVersion: INSTALL_SCHEMA_VERSION,
        directory: versionKey,
        package: {
          name: QWEN_AUDIO_PACKAGE,
          version: QWEN_AUDIO_PACKAGE_VERSION,
          integrity: QWEN_AUDIO_PACKAGE_INTEGRITY,
        },
        node: { version: QWEN_AUDIO_NODE_VERSION, sha256: artifact.sha256 },
        installedAt: now(),
      });
      return existing;
    }

    ensurePrivateDir(runtimeRoot);
    ensurePrivateDir(versionsDir);
    ensurePrivateDir(cacheDir);
    const lock = acquireLock();
    let stage = null;
    try {
      stage = fs.mkdtempSync(path.join(runtimeRoot, '.install-'));
      fs.chmodSync(stage, 0o700);
      const archive = path.join(stage, artifact.file);
      updateProgress('downloading_node', artifact.file);
      await downloadWithRetry(
        `https://nodejs.org/dist/v${QWEN_AUDIO_NODE_VERSION}/${artifact.file}`,
        archive,
        { fetchImpl },
      );
      if (sha256File(archive) !== artifact.sha256) {
        const error = new Error('node archive digest mismatch');
        error.code = 'node_integrity_mismatch';
        throw error;
      }

      updateProgress('extracting_node');
      try {
        await run('tar', ['-xzf', archive, '-C', stage], { timeout: 180000 });
      } catch (cause) {
        const error = new Error('node archive extraction failed');
        error.code = 'archive_extract_failed';
        error.cause = cause;
        throw error;
      }
      const extracted = path.join(stage, artifact.file.replace(/\.tar\.gz$/, ''));
      const nodeDir = path.join(stage, 'node');
      fs.renameSync(extracted, nodeDir);
      const nodePath = path.join(nodeDir, 'bin', 'node');
      if (!executable(nodePath)) {
        const error = new Error('private node is not executable');
        error.code = 'archive_extract_failed';
        throw error;
      }

      updateProgress('installing_package', `${QWEN_AUDIO_PACKAGE}@${QWEN_AUDIO_PACKAGE_VERSION}`);
      const appDir = path.join(stage, 'app');
      ensurePrivateDir(appDir);
      const npmCli = path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      try {
        await run(nodePath, [
          npmCli,
          'install',
          '--prefix', appDir,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--omit=dev',
          '--save-exact',
          `${QWEN_AUDIO_PACKAGE}@${QWEN_AUDIO_PACKAGE_VERSION}`,
        ], {
          cwd: appDir,
          env: safeChildEnv(nodePath, cacheDir),
          timeout: 420000,
        });
      } catch (cause) {
        const error = new Error('qwen package installation failed');
        error.code = 'package_install_failed';
        error.cause = cause;
        throw error;
      }

      const lockData = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'));
      const packageEntry = lockData.packages?.[`node_modules/${QWEN_AUDIO_PACKAGE}`];
      if (packageEntry?.version !== QWEN_AUDIO_PACKAGE_VERSION
          || packageEntry?.integrity !== QWEN_AUDIO_PACKAGE_INTEGRITY) {
        const error = new Error('qwen package integrity mismatch');
        error.code = 'package_integrity_mismatch';
        throw error;
      }

      updateProgress('smoke_testing');
      const qwenBin = path.join(appDir, 'node_modules', QWEN_AUDIO_PACKAGE, 'cli', 'bin', 'qwenaudio.mjs');
      try {
        await run(nodePath, [qwenBin, '--help'], {
          cwd: appDir,
          env: safeChildEnv(nodePath, cacheDir),
          timeout: 30000,
        });
      } catch (cause) {
        const error = new Error('qwen runtime smoke test failed');
        error.code = 'runtime_smoke_test_failed';
        error.cause = cause;
        throw error;
      }

      fs.unlinkSync(archive);
      if (fs.existsSync(targetDir)) {
        const quarantine = `${targetDir}.invalid-${Date.now()}`;
        fs.renameSync(targetDir, quarantine);
      }
      fs.renameSync(stage, targetDir);
      atomicWriteJson(activeFile, {
        schemaVersion: INSTALL_SCHEMA_VERSION,
        directory: versionKey,
        package: {
          name: QWEN_AUDIO_PACKAGE,
          version: QWEN_AUDIO_PACKAGE_VERSION,
          integrity: QWEN_AUDIO_PACKAGE_INTEGRITY,
        },
        node: { version: QWEN_AUDIO_NODE_VERSION, sha256: artifact.sha256 },
        installedAt: now(),
      });
      return runtimeFromDirectory(versionKey);
    } finally {
      if (stage && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      releaseLock(lock);
    }
  }

  async function install() {
    if (installPromise) return installPromise;
    lastError = null;
    progress = null;
    lifecycleState = 'installing';
    installPromise = performInstall()
      .then(runtime => {
        lifecycleState = 'idle';
        progress = { stage: 'complete', detail: null };
        return runtime;
      })
      .catch(error => {
        lifecycleState = 'idle';
        progress = null;
        lastError = safeError(error);
        try { log.error?.('[multicc/qwen-audio] install failed', lastError); } catch (_) {}
        throw error;
      })
      .finally(() => { installPromise = null; });
    return installPromise;
  }

  function startInstall() {
    const pending = install();
    pending.catch(() => {});
    return status();
  }

  return Object.freeze({
    install,
    resolveInstalled,
    startInstall,
    status,
    waitForInstall: () => installPromise || Promise.resolve(resolveInstalled()),
  });
}

module.exports = {
  INSTALL_SCHEMA_VERSION,
  NODE_ARTIFACTS,
  QWEN_AUDIO_NODE_VERSION,
  QWEN_AUDIO_PACKAGE,
  QWEN_AUDIO_PACKAGE_INTEGRITY,
  QWEN_AUDIO_PACKAGE_VERSION,
  createQwenAudioInstaller,
  downloadFile,
  downloadWithRetry,
  platformKey,
  safeError,
  safeChildEnv,
  sha256File,
};
