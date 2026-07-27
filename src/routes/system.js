'use strict';

const DEFAULT_VERSION_RESULT = Object.freeze({
  current: '0.0.0',
  channel: 'dev',
  latest: null,
  latestVersion: null,
  updateAvailable: false,
  apiError: true,
});

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

function createApkInfoHandler(deps) {
  return function apkInfoHandler(req, res) {
    const apkPath = deps.path.join(deps.rootDir, 'public', 'multicc.apk');
    try {
      const stat = deps.fs.statSync(apkPath);
      const info = { exists: true, mtime: stat.mtime.toISOString(), size: stat.size };
      try {
        const metadata = JSON.parse(deps.fs.readFileSync(`${apkPath}.json`, 'utf8'));
        if (metadata.versionName) info.versionName = metadata.versionName;
        if (metadata.versionCode) info.versionCode = metadata.versionCode;
      } catch (_) {
        // The version sidecar is optional.
      }
      res.json(info);
    } catch (_) {
      res.json({ exists: false });
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
  return deps;
}

function mountSystemRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app.get is required');
  const deps = assertSystemRouteDeps(rawDeps);
  app.get('/api/server-info', createServerInfoHandler(deps));
  app.get('/api/version-check', createVersionCheckHandler(deps));
  app.get('/api/apk-info', createApkInfoHandler(deps));
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
  createApkInfoHandler,
  mountSystemRoutes,
};
