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
const MAX_SIDECAR_BYTES = 16 * 1024;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;
const BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,127}$/i;
function xmlEscape(value) { return getNative().iosEscape(String(value)); }

function readLocalIpa(deps) { return getNative().iosReadLocal(deps); }
function absoluteBaseUrl(req) { return getNative().iosAbsoluteUrl(req); }
function buildManifestXml(meta, baseUrl) { return getNative().iosBuildManifest(meta, baseUrl); }
function createIosOta(deps) { return getNative().iosOtaApi(deps); }

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
