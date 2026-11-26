'use strict';

const { getNative } = require('./native/binding');

// iOS OTA distribution (itms-services), mirroring the Android channel in
// src/apk-distribution.js: a locally built IPA lives at public/multicc-ios.ipa
// with a small JSON sidecar (public/multicc-ios.ipa.json) written atomically
// by scripts/publish-ipa.sh. The running server picks up a new publish on the
// next request — no restart, same as public/multicc.apk.
//
// iOS installs over the air through a manifest plist whose asset URL must be
// ABSOLUTE, and installation only succeeds over HTTPS. The same server is
// reached through loopback, LAN or Tailscale Funnel, so the manifest is
// rendered per request from the caller's own scheme/host — X-Forwarded-*
// first, because Funnel terminates TLS on the tailnet host and proxies to
// loopback (no `trust proxy` is set, so req.protocol alone would say "http").
//
// Auth mirrors the APK channel: /multicc-ios.ipa (extension whitelist) and
// /ios-ota/manifest.plist (explicit path) bypass ACCESS_TOKEN in
// src/routes/auth.js because the itms-services fetcher cannot complete the
// cookie login flow; /api/ios-ota-info and the /ios-ota install page stay
// behind the normal gate.

const IPA_NAME = 'multicc-ios.ipa';
const SIDECAR_SUFFIX = '.json';
const MAX_SIDECAR_BYTES = 16 * 1024;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;
const BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,127}$/i;
function xmlEscape(value) { return getNative().iosEscape(String(value)); }

// lstat deliberately rejects symlinks: a public download must never turn a
// fixed filename into an arbitrary host-file capability (same rule as the APK
// channel). A missing/invalid sidecar still leaves a downloadable IPA, just
// without installable metadata.
function readLocalIpa(deps) {
  const ipaPath = deps.path.join(deps.rootDir, 'public', IPA_NAME);
  const result = { exists: false, ipaPath };
  let stat;
  try { stat = deps.fs.lstatSync(ipaPath); } catch (_) { return result; }
  if (!stat.isFile() || stat.size <= 0) return result;
  result.exists = true;
  result.size = stat.size;
  result.mtime = stat.mtime.toISOString();

  let sidecar = null;
  try {
    const sidecarPath = `${ipaPath}${SIDECAR_SUFFIX}`;
    const sidecarStat = deps.fs.lstatSync(sidecarPath);
    if (sidecarStat.isFile() && sidecarStat.size > 0 && sidecarStat.size <= MAX_SIDECAR_BYTES) {
      sidecar = JSON.parse(deps.fs.readFileSync(sidecarPath, 'utf8'));
    }
  } catch (_) { sidecar = null; }
  getNative().iosSidecar(result, sidecar, value =>
    Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
  return result;
}

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').split(',')[0].trim();
}

// The caller's own origin. Funnel (or any loopback reverse proxy) advertises
// the external scheme/host via X-Forwarded-*; direct hits fall back to the
// Host header. Anything unrecognised collapses to a safe placeholder rather
// than reflecting attacker-controlled text into the plist.
function absoluteBaseUrl(req) {
  const headers = (req && req.headers) || {};
  const proto = firstHeaderValue(headers['x-forwarded-proto']).toLowerCase()
    || String((req && req.protocol) || '').toLowerCase();
  const host = firstHeaderValue(headers['x-forwarded-host']).toLowerCase()
    || firstHeaderValue(headers.host).toLowerCase();
  return getNative().iosOrigin(proto, host);
}

function buildManifestXml(meta, baseUrl) {
  const assetUrl = `${baseUrl}/${IPA_NAME}`;
  const title = meta.title || 'MultiCC';
  // Apple's manifest contract: bundle-version is the app's CFBundleVersion
  // (build number), not the marketing version. Handing installd the semantic
  // version here makes modern iOS fetch the whole IPA and then silently drop
  // the install — the exact "tap install, nothing happens" failure.
  const bundleVersion = meta.versionCode || meta.versionName;
  return getNative().iosManifest(String(assetUrl), String(meta.bundleId), String(bundleVersion), String(title));
}

function createIosOta(rawDeps) {
  const deps = rawDeps || {};
  if (!deps.fs || !deps.path || !deps.rootDir) {
    throw new TypeError('iOS OTA distribution requires fs, path, and rootDir');
  }

  function info() {
    return getNative().iosDistributionInfo(readLocalIpa(deps));
  }

  function manifestHandler(req, res) {
    const local = readLocalIpa(deps);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    // Without a parseable bundle id/version the plist cannot produce a working
    // install — answer honestly instead of emitting a broken manifest.
    if (!local.exists || !local.bundleId || !local.versionName) return res.status(404).end();
    res.set('Content-Type', 'text/xml; charset=utf-8');
    return res.status(200).send(buildManifestXml(local, absoluteBaseUrl(req)));
  }

  return Object.freeze({ info, manifestHandler });
}

module.exports = {
  IPA_NAME,
  MAX_SIDECAR_BYTES,
  VERSION_PATTERN,
  BUNDLE_ID_PATTERN,
  xmlEscape,
  readLocalIpa,
  absoluteBaseUrl,
  buildManifestXml,
  createIosOta,
};
