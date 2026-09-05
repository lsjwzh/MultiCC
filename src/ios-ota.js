'use strict';

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
const VALID_PROTO = new Set(['http', 'https']);
// host[:port] only — never a path, and no XML/URL metacharacters.
const HOST_PATTERN = /^[a-z0-9._:-]+$/i;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;
const BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,127}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
  if (!sidecar || typeof sidecar !== 'object') return result;

  if (typeof sidecar.versionName === 'string' && VERSION_PATTERN.test(sidecar.versionName.trim())) {
    result.versionName = sidecar.versionName.trim();
  }
  if (typeof sidecar.bundleId === 'string' && BUNDLE_ID_PATTERN.test(sidecar.bundleId.trim())) {
    result.bundleId = sidecar.bundleId.trim();
  }
  if (typeof sidecar.versionCode === 'string' && VERSION_PATTERN.test(sidecar.versionCode.trim())) {
    result.versionCode = sidecar.versionCode.trim();
  } else if (Number.isSafeInteger(sidecar.versionCode) && sidecar.versionCode > 0) {
    result.versionCode = String(sidecar.versionCode);
  }
  if (typeof sidecar.title === 'string' && sidecar.title.trim()) {
    result.title = sidecar.title.trim().slice(0, 80);
  }
  if (typeof sidecar.sha256 === 'string' && SHA256_PATTERN.test(sidecar.sha256)) {
    result.sha256 = sidecar.sha256;
  }
  if (typeof sidecar.builtAt === 'string' && Number.isFinite(Date.parse(sidecar.builtAt))) {
    result.builtAt = new Date(sidecar.builtAt).toISOString();
  }
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
  let proto = firstHeaderValue(headers['x-forwarded-proto']).toLowerCase()
    || String((req && req.protocol) || '').toLowerCase();
  if (!VALID_PROTO.has(proto)) proto = 'https';
  let host = firstHeaderValue(headers['x-forwarded-host']).toLowerCase()
    || firstHeaderValue(headers.host).toLowerCase();
  if (!HOST_PATTERN.test(host)) host = '127.0.0.1';
  return `${proto}://${host}`;
}

function buildManifestXml(meta, baseUrl) {
  const assetUrl = `${baseUrl}/${IPA_NAME}`;
  const title = meta.title || 'MultiCC';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>items</key>',
    '\t<array>',
    '\t\t<dict>',
    '\t\t\t<key>assets</key>',
    '\t\t\t<array>',
    '\t\t\t\t<dict>',
    '\t\t\t\t\t<key>kind</key>',
    '\t\t\t\t\t<string>software-package</string>',
    '\t\t\t\t\t<key>url</key>',
    `\t\t\t\t\t<string>${xmlEscape(assetUrl)}</string>`,
    '\t\t\t\t</dict>',
    '\t\t\t</array>',
    '\t\t\t<key>metadata</key>',
    '\t\t\t<dict>',
    '\t\t\t\t<key>bundle-identifier</key>',
    `\t\t\t\t<string>${xmlEscape(meta.bundleId)}</string>`,
    '\t\t\t\t<key>bundle-version</key>',
    `\t\t\t\t<string>${xmlEscape(meta.versionName)}</string>`,
    '\t\t\t\t<key>kind</key>',
    '\t\t\t\t<string>software</string>',
    '\t\t\t\t<key>title</key>',
    `\t\t\t\t<string>${xmlEscape(title)}</string>`,
    '\t\t\t</dict>',
    '\t\t</dict>',
    '\t</array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function createIosOta(rawDeps) {
  const deps = rawDeps || {};
  if (!deps.fs || !deps.path || !deps.rootDir) {
    throw new TypeError('iOS OTA distribution requires fs, path, and rootDir');
  }

  function info() {
    const local = readLocalIpa(deps);
    const result = { exists: false, installable: false, installPage: '/ios-ota', downloadUrl: `/${IPA_NAME}` };
    if (!local.exists) return result;
    Object.assign(result, { exists: true, size: local.size, mtime: local.mtime });
    for (const key of ['versionName', 'versionCode', 'bundleId', 'title', 'sha256', 'builtAt']) {
      if (local[key] != null) result[key] = local[key];
    }
    result.installable = !!(local.bundleId && local.versionName);
    return result;
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
