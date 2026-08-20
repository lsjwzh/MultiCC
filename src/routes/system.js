'use strict';

const crypto = require('node:crypto');

const DEFAULT_VERSION_RESULT = Object.freeze({
  current: '0.0.0',
  channel: 'dev',
  latest: null,
  latestVersion: null,
  updateAvailable: false,
  apiError: true,
});
const APK_BUILD_LABEL = 'apk-build';
const APK_BUILD_COMMAND = 'exec ./scripts/publish-apk.sh';
const APK_BUILD_START_GRACE_MS = 15000;
const APK_BUILD_POINTER_NAME = 'apk-build-latest.json';

function compareSemver(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function selectLanAddress(interfaces) {
  const nets = interfaces && typeof interfaces === 'object' ? interfaces : {};
  for (const name of Object.keys(nets)) {
    const entries = Array.isArray(nets[name]) ? nets[name] : [];
    for (const net of entries) {
      if (net && net.family === 'IPv4' && !net.internal && net.address) return net.address;
    }
  }
  return '127.0.0.1';
}

function readInstallMetadata({ fs, path, rootDir }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  let channel = 'dev';
  try {
    const content = fs.readFileSync(path.join(rootDir, '.multicc_channel'), 'utf8');
    const match = content.match(/^# channel:\s*(\S+)/m);
    if (match) channel = match[1];
  } catch (_) {
    // Pre-channel installations do not have the sidecar.
  }
  return { current: pkg.version || '0.0.0', channel };
}

function fetchLatestRelease(https, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      'https://api.github.com/repos/lsjwzh/MultiCC/releases/latest',
      {
        headers: {
          'User-Agent': 'multicc-version-check/1.0',
          Accept: 'application/vnd.github+json',
        },
        timeout: timeoutMs,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timeout'));
    });
    request.on('error', reject);
  });
}

function latestTagFromRemote(output) {
  const tags = [...new Set(String(output || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.match(/refs\/tags\/(v\d+\.\d+\.\d+)/))
    .filter(Boolean)
    .map((match) => match[1]))];
  tags.sort((a, b) => compareSemver(a.replace(/^v/, ''), b.replace(/^v/, '')));
  return tags.length ? tags[tags.length - 1] : null;
}

async function resolveVersionInfo(deps) {
  const { fs, path, https, gitRun, rootDir } = deps;
  const { current, channel } = readInstallMetadata({ fs, path, rootDir });
  let latest = null;
  let apiError = false;

  try {
    const release = await fetchLatestRelease(https, deps.timeoutMs);
    latest = release && release.tag_name ? release.tag_name : null;
  } catch (_) {
    apiError = true;
  }

  if (!latest) {
    try {
      const remoteTags = await gitRun(rootDir, [
        'ls-remote', '--tags', 'https://github.com/lsjwzh/MultiCC.git', 'refs/tags/v*',
      ], { timeout: deps.timeoutMs || 15000, kind: 'version-check' });
      latest = latestTagFromRemote(remoteTags);
    } catch (_) {
      // Both discovery paths failed; the endpoint still returns local metadata.
    }
  }

  const latestVersion = latest ? latest.replace(/^v/, '') : null;
  return {
    current,
    channel,
    latest,
    latestVersion,
    updateAvailable: latestVersion ? compareSemver(current, latestVersion) < 0 : false,
    apiError,
  };
}

function createServerInfoHandler(deps) {
  // Boot time is derived from the process's own uptime rather than a
  // `Date.now()` captured at require time. A graceful restart replaces the
  // process, so uptime can never report the previous run's start, and there is
  // no second copy of the fact that could drift out of sync with reality.
  const uptimeSeconds = typeof deps.uptimeSeconds === 'function' ? deps.uptimeSeconds : () => process.uptime();
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  return function serverInfoHandler(req, res) {
    const ip = selectLanAddress(deps.networkInterfaces());
    const port = deps.getPort();
    // Negative uptime is impossible, but a clamped floor is cheaper than a
    // startedAt in the future if a platform ever reports one.
    const uptimeMs = Math.max(0, Math.round(uptimeSeconds() * 1000));
    res.json({
      ip,
      port,
      proto: 'http',
      url: `http://${ip}:${port}`,
      authRequired: Boolean(deps.authRequired()),
      // Both are sent on purpose. startedAt is the readable fact; uptimeMs is
      // the one a browser can use without inheriting this host's clock — a VM
      // whose clock is hours off would otherwise render a start time that
      // looks like a bug.
      startedAt: new Date(now() - uptimeMs).toISOString(),
      uptimeMs,
    });
  };
}

function createVersionCheckHandler(deps) {
  return async function versionCheckHandler(req, res) {
    try {
      res.json(await resolveVersionInfo(deps));
    } catch (_) {
      res.json({ ...DEFAULT_VERSION_RESULT });
    }
  };
}

function readApkTargetVersion(deps) {
  try {
    const pubspec = deps.fs.readFileSync(deps.path.join(deps.rootDir, 'app', 'pubspec.yaml'), 'utf8');
    const match = pubspec.match(/^\s*version:\s*([^\s+]+)\+(\d+)\s*$/m);
    if (!match) return null;
    return { versionName: match[1], versionCode: Number(match[2]) };
  } catch (_) {
    return null;
  }
}

function readApkInfo(deps) {
  const target = readApkTargetVersion(deps);
  const info = { exists: false };
  if (target) {
    info.targetVersionName = target.versionName;
    info.targetVersionCode = target.versionCode;
  }
  const apkPath = deps.path.join(deps.rootDir, 'public', 'multicc.apk');
  try {
    const stat = deps.fs.statSync(apkPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('APK is empty or not a regular file');
    info.exists = true;
    info.mtime = stat.mtime.toISOString();
    info.size = stat.size;
    try {
      const metadata = JSON.parse(deps.fs.readFileSync(`${apkPath}.json`, 'utf8'));
      if (metadata.versionName) info.versionName = metadata.versionName;
      if (metadata.versionCode) info.versionCode = metadata.versionCode;
    } catch (_) {
      // Missing metadata makes the package stale, but the old APK remains safe
      // to serve while an explicit rebuild runs.
    }
  } catch (_) {
    // A missing artifact is a normal on-demand state.
  }
  info.current = !!(info.exists && target
    && info.versionName === target.versionName
    && Number(info.versionCode) === target.versionCode);
  return info;
}

function createApkInfoHandler(deps) {
  return function apkInfoHandler(req, res) {
    res.json(readApkInfo(deps));
  };
}

function sanitizeBuildLog(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(-3000);
}

function apkBuildPointerPath(deps) {
  return deps.path.join(deps.detached.BASE_DIR, APK_BUILD_POINTER_NAME);
}

function readApkBuildPointer(deps) {
  try {
    const pointer = JSON.parse(deps.fs.readFileSync(apkBuildPointerPath(deps), 'utf8'));
    if (pointer.schemaVersion !== 1 || !/^d_apk_[a-f0-9]{16}$/.test(pointer.id)
        || !Number.isFinite(pointer.scheduledAt)) return { kind: 'invalid' };
    return { ...pointer, kind: 'valid' };
  } catch (error) {
    return error && error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
}

function apkBuildLockActive(deps) {
  const lockPath = deps.path.join(deps.detached.BASE_DIR, 'apk-build.lock');
  try {
    const pid = Number(deps.fs.readFileSync(lockPath, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    if (typeof deps.isProcessAlive === 'function') return !!deps.isProcessAlive(pid);
    process.kill(pid, 0);
    return true;
  } catch (_) { return false; }
}

function resolveApkBuildStatus(deps, pointer) {
  if (!pointer || pointer.kind === 'missing') {
    return apkBuildLockActive(deps) ? { state: 'running', source: 'external' } : { state: 'idle' };
  }
  if (pointer.kind === 'invalid') return { state: 'unknown', error: 'pointer_invalid' };
  if (pointer.startFailedAt) return { state: 'failed', error: 'start_failed' };
  let job = null;
  try { job = deps.detached.status(pointer.id); } catch (_) {}
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  if (!job) {
    if (now - pointer.scheduledAt < APK_BUILD_START_GRACE_MS) {
      return { state: 'running', source: 'scheduled', id: pointer.id, startedAt: new Date(pointer.scheduledAt).toISOString() };
    }
    return apkBuildLockActive(deps) ? { state: 'running', source: 'external' } : { state: 'failed', error: 'interrupted' };
  }
  if (job.label !== APK_BUILD_LABEL || job.command !== APK_BUILD_COMMAND || job.cwd !== deps.rootDir) {
    return { state: 'unknown', error: 'job_mismatch' };
  }
  const startedMs = Number(job.startedAt || 0);
  let state;
  if (job.done) state = job.exitCode === 0 ? 'succeeded' : 'failed';
  else if (job.running || (startedMs > 0 && now - startedMs < APK_BUILD_START_GRACE_MS)) state = 'running';
  else state = 'failed';
  if (state !== 'running' && apkBuildLockActive(deps)) return { state: 'running', source: 'external' };
  const result = {
    state,
    id: job.id,
    startedAt: startedMs > 0 ? new Date(startedMs).toISOString() : null,
  };
  if (job.done) result.exitCode = Number.isInteger(job.exitCode) ? job.exitCode : null;
  if (state === 'failed' && !job.done) result.error = 'interrupted';
  const logTail = sanitizeBuildLog(job.logTail);
  if (logTail) result.logTail = logTail;
  return result;
}

function createApkBuildRuntime(deps) {
  if (!deps || !deps.detached || ['status', 'launch'].some(name => typeof deps.detached[name] !== 'function')) {
    throw new TypeError('APK build detached runtime is required');
  }
  if (!deps.detached.BASE_DIR || typeof deps.atomicWriteJson !== 'function') {
    throw new TypeError('APK build durable pointer dependencies are required');
  }
  let pointer = readApkBuildPointer(deps);
  return Object.freeze({
    status() { return resolveApkBuildStatus(deps, pointer); },
    start() {
      const existing = resolveApkBuildStatus(deps, pointer);
      if (existing.state === 'running') return { reused: true, build: existing };
      if (existing.state === 'unknown') {
        const error = new Error('APK build pointer is invalid');
        error.code = 'APK_BUILD_STATE_INVALID';
        throw error;
      }
      const id = `d_apk_${crypto.randomBytes(8).toString('hex')}`;
      pointer = { kind: 'valid', schemaVersion: 1, id, scheduledAt: (deps.now || Date.now)() };
      deps.atomicWriteJson(apkBuildPointerPath(deps), {
        schemaVersion: pointer.schemaVersion, id: pointer.id, scheduledAt: pointer.scheduledAt,
      });
      try {
        deps.detached.launch({ id, command: APK_BUILD_COMMAND, cwd: deps.rootDir, label: APK_BUILD_LABEL });
      } catch (error) {
        pointer.startFailedAt = (deps.now || Date.now)();
        deps.atomicWriteJson(apkBuildPointerPath(deps), pointer);
        throw error;
      }
      return { reused: false, build: resolveApkBuildStatus(deps, pointer) };
    },
  });
}

function createApkBuildStatusHandler(deps) {
  return function apkBuildStatusHandler(req, res) {
    res.json(deps.apkBuildRuntime.status());
  };
}

function createApkBuildStartHandler(deps) {
  return function apkBuildStartHandler(req, res) {
    if (deps.getShuttingDown?.()) {
      return res.status(409).json({ ok: false, error: 'server_shutting_down', code: 'SERVER_SHUTTING_DOWN' });
    }
    let update;
    try { update = deps.getUpdateStatus?.() || {}; } catch (_) {
      return res.status(503).json({ ok: false, error: 'update_status_unavailable', code: 'UPDATE_STATUS_UNAVAILABLE' });
    }
    if (update.running || update.scheduled) {
      return res.status(409).json({ ok: false, error: 'update_in_progress', code: 'UPDATE_IN_PROGRESS', status: update });
    }
    if (update.state === 'unknown') {
      return res.status(503).json({ ok: false, error: 'update_status_unavailable', code: 'UPDATE_STATUS_UNAVAILABLE' });
    }
    try {
      const result = deps.apkBuildRuntime.start();
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      try { deps.logger?.warn?.('[apk-build] start failed'); } catch (_) {}
      const invalid = error && error.code === 'APK_BUILD_STATE_INVALID';
      return res.status(invalid ? 503 : 500).json({
        ok: false,
        error: invalid ? 'apk_build_status_unavailable' : 'apk_build_start_failed',
        code: invalid ? 'APK_BUILD_STATUS_UNAVAILABLE' : 'APK_BUILD_START_FAILED',
      });
    }
  };
}

function assertSystemRouteDeps(deps) {
  const requiredFunctions = ['networkInterfaces', 'getPort', 'authRequired', 'gitRun'];
  if (!deps || typeof deps !== 'object') throw new TypeError('system route dependencies are required');
  for (const name of requiredFunctions) {
    if (typeof deps[name] !== 'function') throw new TypeError(`system route dependency missing: ${name}`);
  }
  if (!deps.fs || !deps.path || !deps.https || !deps.rootDir) {
    throw new TypeError('system route filesystem dependencies are required');
  }
  if (!deps.apkBuildRuntime || ['status', 'start'].some(name => typeof deps.apkBuildRuntime[name] !== 'function')) {
    throw new TypeError('system route APK build runtime is required');
  }
  return deps;
}

function mountSystemRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express app.get/app.post are required');
  }
  const deps = assertSystemRouteDeps(rawDeps);
  app.get('/api/server-info', createServerInfoHandler(deps));
  app.get('/api/version-check', createVersionCheckHandler(deps));
  app.get('/api/apk-info', createApkInfoHandler(deps));
  app.get('/api/apk-build', createApkBuildStatusHandler(deps));
  app.post('/api/apk-build', createApkBuildStartHandler(deps));
}

module.exports = {
  DEFAULT_VERSION_RESULT,
  compareSemver,
  selectLanAddress,
  readInstallMetadata,
  fetchLatestRelease,
  latestTagFromRemote,
  resolveVersionInfo,
  createServerInfoHandler,
  createVersionCheckHandler,
  readApkTargetVersion,
  readApkInfo,
  createApkInfoHandler,
  sanitizeBuildLog,
  apkBuildPointerPath,
  readApkBuildPointer,
  apkBuildLockActive,
  resolveApkBuildStatus,
  createApkBuildRuntime,
  createApkBuildStatusHandler,
  createApkBuildStartHandler,
  mountSystemRoutes,
};
