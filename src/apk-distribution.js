'use strict';

// Android APK distribution has one authoritative selection rule:
//   1. a non-empty, regular public/multicc.apk wins;
//   2. otherwise use the exact GitHub Release for package.json.version.
//
// Remote availability is never inferred from a syntactically valid URL. The
// release and its bounded metadata sidecar must both be verified first. A
// transient GitHub failure may still redirect an explicit download attempt to
// the fixed candidate, but /api/apk-info remains honest (`exists: false`).

const OWNER = 'lsjwzh';
const REPOSITORY = 'MultiCC';
const APK_NAME = 'multicc.apk';
const MANIFEST_NAME = `${APK_NAME}.json`;
const SIGNER_PIN_NAME = 'release-cert.sha256';
const RELEASE_API_HOST = 'api.github.com';
const RELEASE_DOWNLOAD_HOST = 'github.com';
const REDIRECT_HOSTS = new Set([
  RELEASE_DOWNLOAD_HOST,
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const POSITIVE_TTL_MS = 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RELEASE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_REDIRECTS = 3;
const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseIdentity(deps) {
  try {
    const pkg = JSON.parse(deps.fs.readFileSync(deps.path.join(deps.rootDir, 'package.json'), 'utf8'));
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    if (!STRICT_VERSION.test(version)) {
      return { valid: false, version: null, tag: null, releaseUrl: null, manifestUrl: null };
    }
    const tag = `v${version}`;
    const base = `https://${RELEASE_DOWNLOAD_HOST}/${OWNER}/${REPOSITORY}/releases/download/${tag}`;
    return {
      valid: true,
      version,
      tag,
      releaseUrl: `${base}/${APK_NAME}`,
      manifestUrl: `${base}/${MANIFEST_NAME}`,
      apiUrl: `https://${RELEASE_API_HOST}/repos/${OWNER}/${REPOSITORY}/releases/tags/${tag}`,
    };
  } catch (_) {
    return { valid: false, version: null, tag: null, releaseUrl: null, manifestUrl: null };
  }
}

function targetVersion(deps) {
  try {
    const pubspec = deps.fs.readFileSync(deps.path.join(deps.rootDir, 'app', 'pubspec.yaml'), 'utf8');
    const match = pubspec.match(/^\s*version:\s*([^\s+]+)\+(\d+)\s*$/m);
    if (!match) return null;
    const versionCode = Number(match[2]);
    if (!Number.isSafeInteger(versionCode) || versionCode <= 0) return null;
    return { versionName: match[1], versionCode };
  } catch (_) {
    return null;
  }
}

function expectedSignerSha256(deps) {
  try {
    const pinPath = deps.path.join(deps.rootDir, 'app', 'android', SIGNER_PIN_NAME);
    const stat = deps.fs.lstatSync(pinPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 256) return null;
    const value = deps.fs.readFileSync(pinPath, 'utf8').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function readLocalApk(deps, target) {
  const apkPath = deps.path.join(deps.rootDir, 'public', APK_NAME);
  const result = { localExists: false, localCurrent: false, apkPath };
  try {
    // lstat deliberately rejects symlinks: a public download must never turn a
    // fixed filename into an arbitrary host-file capability.
    const stat = deps.fs.lstatSync(apkPath);
    if (!stat.isFile() || stat.size <= 0) return result;
    result.localExists = true;
    result.size = stat.size;
    result.mtime = stat.mtime.toISOString();
  } catch (_) {
    return result;
  }

  try {
    const metadataPath = `${apkPath}.json`;
    const metadataStat = deps.fs.lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.size <= 0 || metadataStat.size > MAX_MANIFEST_BYTES) return result;
    const metadata = JSON.parse(deps.fs.readFileSync(metadataPath, 'utf8'));
    if (typeof metadata.versionName === 'string' && metadata.versionName.trim()) {
      result.versionName = metadata.versionName.trim().slice(0, 80);
    }
    if (Number.isSafeInteger(Number(metadata.versionCode)) && Number(metadata.versionCode) > 0) {
      result.versionCode = Number(metadata.versionCode);
    }
  } catch (_) {
    // A package without metadata is still a valid local download, just stale.
  }

  result.localCurrent = !!(target
    && result.versionName === target.versionName
    && result.versionCode === target.versionCode);
  return result;
}

function httpError(message, statusCode = null) {
  const error = new Error(message);
  if (statusCode != null) error.statusCode = statusCode;
  return error;
}

function requestText(deps, url, options = {}, redirectCount = 0) {
  const allowedHosts = options.allowedHosts || new Set();
  let parsed;
  try { parsed = new URL(url); } catch (_) { return Promise.reject(httpError('invalid_url')); }
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
    return Promise.reject(httpError('untrusted_host'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = deps.https.get(parsed.href, {
      headers: options.headers || {},
      timeout: deps.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, (response) => {
      const status = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers && response.headers.location;
        if (!location || redirectCount >= MAX_REDIRECTS) {
          finish(reject, httpError('redirect_rejected', status));
          return;
        }
        let next;
        try { next = new URL(location, parsed).href; } catch (_) {
          finish(reject, httpError('redirect_rejected', status));
          return;
        }
        response.resume?.();
        requestText(deps, next, options, redirectCount + 1).then(
          value => finish(resolve, value),
          error => finish(reject, error),
        );
        return;
      }
      if (status !== 200) {
        response.resume?.();
        finish(reject, httpError('unexpected_status', status));
        return;
      }
      const declared = Number(response.headers && response.headers['content-length']);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        response.destroy?.();
        finish(reject, httpError('response_too_large'));
        return;
      }
      let body = '';
      let bytes = 0;
      response.setEncoding?.('utf8');
      response.on('data', (chunk) => {
        if (settled) return;
        const text = String(chunk);
        bytes += Buffer.byteLength(text);
        if (bytes > options.maxBytes) {
          response.destroy?.();
          finish(reject, httpError('response_too_large'));
          return;
        }
        body += text;
      });
      response.on('end', () => finish(resolve, body));
      response.on('error', error => finish(reject, error));
    });
    request.on('timeout', () => request.destroy(httpError('timeout')));
    request.on('error', error => finish(reject, error));
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function exactAsset(release, name, expectedUrl, { requireSize = true } = {}) {
  if (!release || !Array.isArray(release.assets)) return null;
  const matches = release.assets.filter(asset => asset && asset.name === name);
  if (matches.length !== 1) return null;
  const asset = matches[0];
  if (asset.state !== 'uploaded' || asset.browser_download_url !== expectedUrl) return null;
  const size = Number(asset.size);
  if (requireSize && (!Number.isSafeInteger(size) || size <= 0)) return null;
  return { ...asset, size };
}

function validManifest(value, identity, apkAsset, expectedSigner) {
  if (!value || value.schemaVersion !== 1) return false;
  const releaseVersion = value.releaseVersion == null ? value.serverVersion : value.releaseVersion;
  if (value.releaseTag !== identity.tag || releaseVersion !== identity.version) return false;
  if (typeof value.versionName !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/.test(value.versionName)) return false;
  if (!Number.isSafeInteger(value.versionCode) || value.versionCode <= 0) return false;
  if (!Number.isSafeInteger(value.size) || value.size !== apkAsset.size) return false;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  if (typeof value.signerSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.signerSha256)
      || value.signerSha256 !== expectedSigner) return false;
  if (typeof value.gitCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.gitCommit)) return false;
  if (typeof value.builtAt !== 'string' || !Number.isFinite(Date.parse(value.builtAt))) return false;
  return true;
}

async function inspectRemote(deps, identity) {
  const expectedSigner = expectedSignerSha256(deps);
  if (!expectedSigner) return { state: 'invalid', reason: 'signer_pin_invalid' };
  let releaseText;
  try {
    releaseText = await requestText(deps, identity.apiUrl, {
      allowedHosts: new Set([RELEASE_API_HOST]),
      maxBytes: MAX_RELEASE_BYTES,
      headers: {
        'User-Agent': 'multicc-apk-distribution/1.0',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    return error && error.statusCode === 404
      ? { state: 'missing', reason: 'release_missing' }
      : { state: 'unknown', reason: 'release_unavailable' };
  }

  const release = parseJson(releaseText);
  if (!release || release.tag_name !== identity.tag || release.draft === true || release.prerelease === true) {
    return { state: 'invalid', reason: 'release_invalid' };
  }
  const apkAsset = exactAsset(release, APK_NAME, identity.releaseUrl);
  const manifestAsset = exactAsset(release, MANIFEST_NAME, identity.manifestUrl);
  if (!apkAsset || !manifestAsset || manifestAsset.size > MAX_MANIFEST_BYTES) {
    return { state: 'missing', reason: 'asset_missing' };
  }

  let manifestText;
  try {
    manifestText = await requestText(deps, identity.manifestUrl, {
      allowedHosts: REDIRECT_HOSTS,
      maxBytes: MAX_MANIFEST_BYTES,
      headers: { 'User-Agent': 'multicc-apk-distribution/1.0', Accept: 'application/json' },
    });
  } catch (error) {
    return error && error.statusCode === 404
      ? { state: 'missing', reason: 'manifest_missing' }
      : { state: 'unknown', reason: 'manifest_unavailable' };
  }
  const manifest = parseJson(manifestText);
  if (!validManifest(manifest, identity, apkAsset, expectedSigner)) {
    return { state: 'invalid', reason: 'manifest_invalid' };
  }

  const updatedAt = typeof apkAsset.updated_at === 'string' && Number.isFinite(Date.parse(apkAsset.updated_at))
    ? new Date(apkAsset.updated_at).toISOString()
    : new Date(manifest.builtAt).toISOString();
  return {
    state: 'available',
    downloadUrl: identity.releaseUrl,
    versionName: manifest.versionName,
    versionCode: manifest.versionCode,
    size: apkAsset.size,
    mtime: updatedAt,
    sha256: manifest.sha256,
    signerSha256: manifest.signerSha256,
    gitCommit: manifest.gitCommit,
    builtAt: new Date(manifest.builtAt).toISOString(),
  };
}

function cacheTtl(state) {
  if (state === 'available') return POSITIVE_TTL_MS;
  if (state === 'missing' || state === 'invalid') return MISSING_TTL_MS;
  return ERROR_TTL_MS;
}

function createApkDistribution(rawDeps) {
  const deps = rawDeps || {};
  if (!deps.fs || !deps.path || !deps.https || !deps.rootDir) {
    throw new TypeError('APK distribution requires fs, path, https, and rootDir');
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  let cache = null;
  let inFlight = null;

  async function remote(identity) {
    if (!identity.valid) return { state: 'invalid_version', reason: 'invalid_version' };
    const timestamp = now();
    if (cache && cache.version === identity.version && cache.expiresAt > timestamp) return cache.value;
    if (inFlight && inFlight.version === identity.version) return inFlight.promise;
    const pending = inspectRemote(deps, identity).then((value) => {
      cache = { version: identity.version, value, expiresAt: now() + cacheTtl(value.state) };
      return value;
    });
    inFlight = { version: identity.version, promise: pending };
    try { return await pending; } finally {
      if (inFlight && inFlight.promise === pending) inFlight = null;
    }
  }

  function baseInfo(identity, target) {
    const info = {
      exists: false,
      localExists: false,
      source: null,
      downloadUrl: null,
      releaseTag: identity.tag,
      releaseUrl: identity.releaseUrl,
      remoteState: identity.valid ? 'not_checked' : 'invalid_version',
      current: false,
      localCurrent: false,
    };
    if (target) {
      info.targetVersionName = target.versionName;
      info.targetVersionCode = target.versionCode;
    }
    return info;
  }

  async function info() {
    const identity = releaseIdentity(deps);
    const target = targetVersion(deps);
    const local = readLocalApk(deps, target);
    const result = baseInfo(identity, target);
    if (local.localExists) {
      Object.assign(result, {
        exists: true,
        localExists: true,
        source: 'local',
        downloadUrl: '/multicc.apk',
        remoteState: 'skipped_local',
        current: local.localCurrent,
        localCurrent: local.localCurrent,
        size: local.size,
        mtime: local.mtime,
      });
      if (local.versionName) result.versionName = local.versionName;
      if (local.versionCode) result.versionCode = local.versionCode;
      return result;
    }

    const release = await remote(identity);
    result.remoteState = release.state;
    if (release.reason) result.remoteReason = release.reason;
    if (release.state !== 'available') return result;
    Object.assign(result, {
      exists: true,
      source: 'release',
      downloadUrl: release.downloadUrl,
      versionName: release.versionName,
      versionCode: release.versionCode,
      size: release.size,
      mtime: release.mtime,
      sha256: release.sha256,
      signerSha256: release.signerSha256,
      gitCommit: release.gitCommit,
      builtAt: release.builtAt,
      current: !!(target
        && release.versionName === target.versionName
        && release.versionCode === target.versionCode),
    });
    return result;
  }

  async function downloadHandler(req, res, next) {
    const identity = releaseIdentity(deps);
    const local = readLocalApk(deps, targetVersion(deps));
    if (local.localExists) return next();
    if (!identity.valid) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    const release = await remote(identity);
    const candidate = release.state === 'available' ? release.downloadUrl
      : release.state === 'unknown' ? identity.releaseUrl : null;
    if (!candidate) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, candidate);
  }

  return Object.freeze({ info, downloadHandler });
}

module.exports = {
  OWNER,
  REPOSITORY,
  APK_NAME,
  MANIFEST_NAME,
  STRICT_VERSION,
  POSITIVE_TTL_MS,
  MISSING_TTL_MS,
  ERROR_TTL_MS,
  releaseIdentity,
  targetVersion,
  expectedSignerSha256,
  readLocalApk,
  validManifest,
  createApkDistribution,
};
