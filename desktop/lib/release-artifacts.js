'use strict';

// Release-asset hygiene for desktop builds. Used by CI (not by the app at
// runtime): writes digest-only `.sha256` sidecars — the exact convention
// publish-apk.sh uses for multicc.apk.sha256 — validates that electron-builder
// produced the stable artifact names users and docs depend on, and emits one
// consolidated SHA256SUMS.txt in `sha256sum` format.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// multicc-desktop-<semver>-<platform>-<arch>.<ext>
//   platform: macos | windows | linux
//   arch:     arm64 | x64 | universal
//   ext:      dmg (macos) | exe (windows) | AppImage | deb (linux)
const ARTIFACT_NAME_RE = /^multicc-desktop-(\d+)\.(\d+)\.(\d+)-(macos|windows|linux)-(arm64|x64|universal)\.(dmg|exe|AppImage|deb)$/;

const PLATFORM_EXTS = {
  macos: new Set(['dmg']),
  windows: new Set(['exe']),
  linux: new Set(['AppImage', 'deb']),
};

function computeSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// `<file>.sha256` containing the bare hex digest (+ newline). Byte-for-byte
// the same shape tests/test release.yml asserts for multicc.apk.sha256.
function writeSidecar(filePath) {
  const digest = computeSha256(filePath);
  fs.writeFileSync(`${filePath}.sha256`, `${digest}\n`);
  return digest;
}

function validateArtifactName(name, { platform, version } = {}) {
  const m = ARTIFACT_NAME_RE.exec(name);
  if (!m) return { ok: false, error: `artifact name "${name}" does not match multicc-desktop-<version>-<platform>-<arch>.<ext>` };
  const [, major, minor, patch, namePlatform, , ext] = m;
  if (!PLATFORM_EXTS[namePlatform].has(ext)) {
    return { ok: false, error: `platform ${namePlatform} cannot ship .${ext}` };
  }
  if (version && `${major}.${minor}.${patch}` !== String(version)) {
    return { ok: false, error: `artifact version ${major}.${minor}.${patch} != expected ${version}` };
  }
  if (platform && namePlatform !== platform) {
    return { ok: false, error: `artifact platform ${namePlatform} != expected ${platform}` };
  }
  return { ok: true, name, platform: namePlatform, ext };
}

// Validate a directory of build outputs and write sidecars + manifest.
// Returns the accepted artifact list; throws on any name violation so a
// misconfigured electron-builder fails the build, not the user's download.
function prepareReleaseAssets({ files, version, platform, manifestName = 'SHA256SUMS.txt', manifestDir }) {
  const entries = [];
  for (const filePath of files) {
    const name = path.basename(filePath);
    const check = validateArtifactName(name, { platform, version });
    if (!check.ok) throw new Error(`[release-artifacts] ${check.error}`);
    const digest = writeSidecar(filePath);
    entries.push({ filePath, name, digest, size: fs.statSync(filePath).size });
  }
  if (!entries.length) throw new Error('[release-artifacts] no artifacts to publish');
  const dir = manifestDir || path.dirname(entries[0].filePath);
  // sha256sum-verify format: `<digest>  <name>`
  const manifest = entries.map(e => `${e.digest}  ${e.name}`).sort().join('\n') + '\n';
  fs.writeFileSync(path.join(dir, manifestName), manifest);
  return entries;
}

module.exports = { ARTIFACT_NAME_RE, computeSha256, writeSidecar, validateArtifactName, prepareReleaseAssets };
