'use strict';

// SakuraFrp / Nyat standalone `frpc` installer.
//
// WHY THIS EXISTS: the graphical SakuraLauncher.app can't be scripted — it owns
// its own frpc child process and saved tunnel IDs, and its *bundled* frpc crashes
// in libsecinit when executed directly from Node under the macOS sandbox. But
// SakuraFrp also publishes the raw `frpc` binary for every platform/arch, with a
// vendor-provided MD5 + byte size, through the unauthenticated
// `/system/clients` endpoint. tunnel.js already knows how to drive a standalone
// frpc (`frpc -f {authtoken}`), so the only missing piece for a fully headless,
// CLI-only data plane is: fetch the right binary, PROVE it is the vendor's exact
// bytes, and drop it where the monitor can find it. That is this module.
//
// Everything here is pure and injectable (fetch / fs / crypto / manifest) so it
// is hermetically testable; the only side effect in the whole file is the final
// write in installFrpc(), which never happens until the download is verified.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPaths } = require('./paths');

const API_CLIENTS_URL = 'https://api.natfrp.com/v4/system/clients';

// Installable frpc bytes are served from the SakuraFrp CDN. Pin the host family
// so a tampered or MITM'd manifest can't silently redirect the download to an
// attacker host. The MD5+size check is the real integrity guarantee; this is
// defence in depth — it also stops us ever issuing a request somewhere unknown.
const DOWNLOAD_HOST_ALLOWLIST = Object.freeze(['globalslb.net', 'natfrp.com']);

// Node's (platform, arch) → SakuraFrp frpc arch key. Anything absent is
// deliberately unsupported — either no vendor build exists, or the ABI is one we
// refuse to guess at (linux arm_garbage, ppc64, s390x, mips64 which Node doesn't
// expose distinctly). Those resolve to null rather than a wrong-arch download.
const FRPC_ARCH_MAP = Object.freeze({
  darwin: Object.freeze({ arm64: 'darwin_arm64', x64: 'darwin_amd64' }),
  win32: Object.freeze({ x64: 'windows_amd64', ia32: 'windows_386', arm64: 'windows_arm64' }),
  linux: Object.freeze({
    x64: 'linux_amd64',
    ia32: 'linux_386',
    arm64: 'linux_arm64',
    arm: 'linux_armv7',
    mips: 'linux_mips',
    mipsel: 'linux_mipsle',
    riscv64: 'linux_riscv64',
    loong64: 'linux_loong64',
  }),
  freebsd: Object.freeze({ x64: 'freebsd_amd64', ia32: 'freebsd_386' }),
});

const MD5_HEX_RE = /^[a-f0-9]{32}$/i;

function frpcArchKey(platform = process.platform, arch = process.arch) {
  const byArch = FRPC_ARCH_MAP[platform];
  return (byArch && byArch[arch]) || null;
}

// Normalize the `frpc` family of the manifest into { version, clients }. Only
// entries carrying a usable url + MD5 + size survive — the docker/doc links in
// the same family have no hash and must never be treated as installable.
function parseClientManifest(manifest) {
  const family = manifest && manifest.frpc;
  if (!family || typeof family !== 'object' || !family.archs || typeof family.archs !== 'object') {
    throw new Error('SakuraFrp clients manifest is missing the frpc family');
  }
  const version = typeof family.ver === 'string' && family.ver ? family.ver : '';
  const clients = {};
  for (const [key, entry] of Object.entries(family.archs)) {
    if (!entry || typeof entry !== 'object') continue;
    const { url, hash, size } = entry;
    if (typeof url !== 'string' || !url) continue;
    if (typeof hash !== 'string' || !MD5_HEX_RE.test(hash)) continue;
    if (!Number.isInteger(size) || size <= 0) continue;
    clients[key] = { title: typeof entry.title === 'string' ? entry.title : key, url, hash, size };
  }
  return { version, clients };
}

function selectFrpcClient(parsed, archKey) {
  return (parsed && parsed.clients && parsed.clients[archKey]) || null;
}

// HTTPS-only + host allowlist. Returns the parsed URL on success, throws on any
// policy violation so callers can't accidentally fetch an unsafe location.
function assertSafeDownloadUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (_) { throw new Error(`frpc download URL is not parseable: ${rawUrl}`); }
  if (parsed.protocol !== 'https:') {
    throw new Error(`frpc download must be https, got ${parsed.protocol}// for ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = DOWNLOAD_HOST_ALLOWLIST.some(d => host === d || host.endsWith('.' + d));
  if (!allowed) {
    throw new Error(`frpc download host ${host} is not on the SakuraFrp allowlist`);
  }
  return parsed;
}

// Where a headless install lands. Mirrors the paths.js convention for large,
// replaceable third-party runtimes: a normal install keeps it under ~/.multicc,
// an isolated MULTICC_DATA_DIR instance keeps every byte below its own root.
function defaultFrpcDest({ dataDir, platform = process.platform } = {}) {
  const paths = createPaths({ dataDir });
  const base = paths.root === paths.pkgRoot
    ? path.join(os.homedir(), '.multicc', 'bin')
    : path.join(paths.root, 'bin');
  return path.join(base, platform === 'win32' ? 'frpc.exe' : 'frpc');
}

async function fetchClientManifest({ fetch = globalThis.fetch, url = API_CLIENTS_URL, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'multicc' } });
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) {
    throw new Error(`SakuraFrp /system/clients responded ${res ? res.status : 'with no response'}`);
  }
  return res.json();
}

// Download the binary and verify it in memory BEFORE anything touches disk, so
// the destination can never hold an unverified or half-written executable.
async function downloadFrpc(client, { fetch = globalThis.fetch, createHash = crypto.createHash, timeoutMs = 120000 } = {}) {
  assertSafeDownloadUrl(client.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(client.url, { signal: controller.signal, headers: { 'User-Agent': 'multicc' } });
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) {
    throw new Error(`frpc download responded ${res ? res.status : 'with no response'}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== client.size) {
    throw new Error(`frpc size mismatch: expected ${client.size} bytes, got ${bytes.length}`);
  }
  const digest = createHash('md5').update(bytes).digest('hex');
  if (digest.toLowerCase() !== String(client.hash).toLowerCase()) {
    throw new Error(`frpc MD5 mismatch: expected ${client.hash}, got ${digest}`);
  }
  return bytes;
}

// Write verified bytes to a sibling temp file, chmod 0755, then atomically
// rename over the destination. A crash mid-write leaves the old binary (or none)
// intact, never a truncated executable.
function writeExecutable(dest, bytes, { filesystem = fs } = {}) {
  filesystem.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.partial-${process.pid}`;
  try {
    filesystem.writeFileSync(temp, bytes, { mode: 0o755 });
    filesystem.chmodSync(temp, 0o755);
    filesystem.renameSync(temp, dest);
  } catch (err) {
    try { filesystem.rmSync(temp, { force: true }); } catch (_) { /* best effort */ }
    throw err;
  }
  try { filesystem.chmodSync(dest, 0o755); } catch (_) { /* dest is already 0755 from the temp */ }
  return dest;
}

// Version discovery without downloading — the "what would we install?" step for
// the onboarding UI. Never throws for an unsupported arch; it reports it.
async function discoverFrpc({ platform = process.platform, arch = process.arch, fetch = globalThis.fetch, manifest } = {}) {
  const archKey = frpcArchKey(platform, arch);
  if (!archKey) return { supported: false, platform, arch, archKey: null };
  const parsed = parseClientManifest(manifest || await fetchClientManifest({ fetch }));
  const client = selectFrpcClient(parsed, archKey);
  return { supported: !!client, platform, arch, archKey, version: parsed.version, client: client || null };
}

// Full headless install: discover the right frpc build, download it, prove its
// MD5+size, then atomically place an executable at `dest` (default ~/.multicc/bin).
async function installFrpc({
  dest,
  platform = process.platform,
  arch = process.arch,
  fetch = globalThis.fetch,
  createHash = crypto.createHash,
  filesystem = fs,
  manifest,
} = {}) {
  const archKey = frpcArchKey(platform, arch);
  if (!archKey) throw new Error(`SakuraFrp frpc has no build for ${platform}/${arch}`);
  const parsed = parseClientManifest(manifest || await fetchClientManifest({ fetch }));
  const client = selectFrpcClient(parsed, archKey);
  if (!client) throw new Error(`SakuraFrp frpc manifest has no verifiable entry for ${archKey}`);
  const bytes = await downloadFrpc(client, { fetch, createHash });
  const target = dest || defaultFrpcDest({ platform });
  writeExecutable(target, bytes, { filesystem });
  return {
    path: target,
    version: parsed.version,
    archKey,
    title: client.title,
    size: client.size,
    hash: client.hash,
  };
}

module.exports = {
  API_CLIENTS_URL,
  DOWNLOAD_HOST_ALLOWLIST,
  FRPC_ARCH_MAP,
  frpcArchKey,
  parseClientManifest,
  selectFrpcClient,
  assertSafeDownloadUrl,
  defaultFrpcDest,
  fetchClientManifest,
  downloadFrpc,
  writeExecutable,
  discoverFrpc,
  installFrpc,
};
