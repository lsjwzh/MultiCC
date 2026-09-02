'use strict';

const net = require('node:net');

const DEFAULT_VERSION_RESULT = Object.freeze({
  current: '0.0.0',
  channel: 'dev',
  latest: null,
  latestVersion: null,
  updateAvailable: false,
  apiError: true,
});

// Native clients use this deliberately small contract to reject a host whose
// connection protocol they do not understand before persisting credentials.
// Bump only when /api/server-info or the authenticated App bootstrap contract
// becomes backwards-incompatible.
const APP_CONNECTION_PROTOCOL = 1;

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

const VIRTUAL_INTERFACE = /^(?:lo\d*|utun\d*|tun\d*|tap\d*|tailscale\d*|docker\d*|br-|veth|vmnet|virbr|vEthernet|awdl\d*|llw\d*|bridge\d*|wg\d*|zt)/i;
const PREFERRED_INTERFACE = /^(?:en\d+|eth\d*|enp|eno|ens|wlan|wlp|wi-?fi|ethernet)/i;

function ipv4Priority(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return -1;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return -1;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 300;
  if (a === 100 && b >= 64 && b <= 127) return 100;
  return 0;
}

function selectLanAddresses(interfaces) {
  const nets = interfaces && typeof interfaces === 'object' ? interfaces : {};
  const candidates = [];
  let order = 0;
  for (const name of Object.keys(nets)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    const entries = Array.isArray(nets[name]) ? nets[name] : [];
    for (const entry of entries) {
      const ipv4 = entry && (entry.family === 'IPv4' || entry.family === 4) && !entry.internal;
      const priority = ipv4 ? ipv4Priority(entry.address) : -1;
      if (priority <= 0) continue;
      candidates.push({ address: entry.address, priority: priority + (PREFERRED_INTERFACE.test(name) ? 50 : 0), order: order++ });
    }
  }
  candidates.sort((a, b) => b.priority - a.priority || a.order - b.order || a.address.localeCompare(b.address));
  return [...new Set(candidates.map(candidate => candidate.address))];
}

function selectLanAddress(interfaces) {
  return selectLanAddresses(interfaces)[0] || '127.0.0.1';
}

function reachableLanAddresses(interfaces, bindHost) {
  const host = String(bindHost || '0.0.0.0').trim().toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return [];
  if (net.isIP(host) === 4 && host !== '0.0.0.0') return ipv4Priority(host) >= 0 ? [host] : [];
  return selectLanAddresses(interfaces);
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
  let serverVersion = null;
  try {
    if (deps.fs && deps.path && deps.rootDir) {
      serverVersion = readInstallMetadata(deps).current;
    }
  } catch (_) {
    // Direct unit harnesses and damaged installations still expose identity
    // and protocol. Version is helpful metadata, not a health dependency.
  }
  return function serverInfoHandler(req, res) {
    const interfaces = deps.networkInterfaces();
    const bindHost = typeof deps.getBindHost === 'function' ? deps.getBindHost() : '0.0.0.0';
    const lanAddresses = reachableLanAddresses(interfaces, bindHost);
    const ip = lanAddresses[0] || '127.0.0.1';
    const port = deps.getPort();
    // Negative uptime is impossible, but a clamped floor is cheaper than a
    // startedAt in the future if a platform ever reports one.
    const uptimeMs = Math.max(0, Math.round(uptimeSeconds() * 1000));
    res.json({
      product: 'multicc',
      appProtocolVersion: APP_CONNECTION_PROTOCOL,
      ...(serverVersion ? { version: serverVersion } : {}),
      ip,
      port,
      proto: 'http',
      url: `http://${ip}:${port}`,
      bindHost,
      lanAvailable: lanAddresses.length > 0,
      lanAddresses,
      lanUrls: lanAddresses.map(address => `http://${address}:${port}`),
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
  return async function apkInfoHandler(req, res, next) {
    try {
      res.json(await deps.apkDistribution.info());
    } catch (error) {
      next(error);
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
  if (!deps.apkDistribution
      || typeof deps.apkDistribution.info !== 'function'
      || typeof deps.apkDistribution.downloadHandler !== 'function') {
    throw new TypeError('system route APK distribution runtime is required');
  }
  return deps;
}

function mountSystemRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('Express app.get is required');
  }
  const deps = assertSystemRouteDeps(rawDeps);
  app.get('/api/server-info', createServerInfoHandler(deps));
  app.get('/api/version-check', createVersionCheckHandler(deps));
  app.get('/api/apk-info', createApkInfoHandler(deps));
  // Mounted before express.static: local files fall through to static serving;
  // verified releases redirect, and every other state terminates explicitly.
  app.get('/multicc.apk', deps.apkDistribution.downloadHandler);
}

module.exports = {
  APP_CONNECTION_PROTOCOL,
  DEFAULT_VERSION_RESULT,
  compareSemver,
  ipv4Priority,
  selectLanAddresses,
  selectLanAddress,
  reachableLanAddresses,
  readInstallMetadata,
  fetchLatestRelease,
  latestTagFromRemote,
  resolveVersionInfo,
  createServerInfoHandler,
  createVersionCheckHandler,
  createApkInfoHandler,
  mountSystemRoutes,
};
