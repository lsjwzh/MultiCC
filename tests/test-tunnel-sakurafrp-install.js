'use strict';

// Hermetic tests for the SakuraFrp standalone-frpc installer. Every network and
// filesystem touch is injected, so these run offline and never leave a binary
// behind. The security invariants that matter most:
//   • an unverifiable download (wrong MD5 or wrong size) throws AND writes nothing
//   • a non-https or off-allowlist URL is refused before any request is made
//   • an arch with no vendor build resolves to null, never a wrong download

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  frpcArchKey,
  parseClientManifest,
  selectFrpcClient,
  assertSafeDownloadUrl,
  discoverFrpc,
  installFrpc,
  fetchClientManifest,
} = require('../src/tunnel-sakurafrp-install');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

const createdDirs = [];
test.after(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDest(name = 'frpc') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-sakurafrp-install-'));
  createdDirs.push(dir);
  return { dir, dest: path.join(dir, name) };
}

// A manifest shaped exactly like the real /system/clients `frpc` family. The
// docker entry (no hash/size) is included on purpose: it must be dropped.
function manifestFor(bytes, {
  host = 'nya.globalslb.net',
  proto = 'https',
  size = bytes.length,
  hash = md5(bytes),
  archKey = 'darwin_arm64',
} = {}) {
  return {
    frpc: {
      ver: '0.51.0-sakura-14',
      archs: {
        [archKey]: {
          title: 'Apple Silicon (arm64)',
          url: `${proto}://${host}/natfrp/client/frpc/0.51.0-sakura-14/frpc_${archKey}`,
          hash,
          size,
        },
        docker_hub: { title: 'Docker Hub', url: 'https://hub.docker.com/r/natfrp/frpc' },
      },
    },
  };
}

// Routes by URL: the clients endpoint yields `manifest`, anything else yields the
// download bytes. Counts calls so a test can prove no request was issued.
function fakeFetch({ manifest, bytes, ok = true, status = 200 }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (String(url).includes('/system/clients')) {
      return { ok, status, json: async () => manifest, arrayBuffer: async () => bytes };
    }
    return { ok, status, json: async () => undefined, arrayBuffer: async () => bytes };
  };
  fn.calls = calls;
  return fn;
}

test('frpcArchKey maps Node platform/arch to vendor keys and nulls the rest', () => {
  assert.equal(frpcArchKey('darwin', 'arm64'), 'darwin_arm64');
  assert.equal(frpcArchKey('darwin', 'x64'), 'darwin_amd64');
  assert.equal(frpcArchKey('win32', 'x64'), 'windows_amd64');
  assert.equal(frpcArchKey('win32', 'ia32'), 'windows_386');
  assert.equal(frpcArchKey('win32', 'arm64'), 'windows_arm64');
  assert.equal(frpcArchKey('linux', 'x64'), 'linux_amd64');
  assert.equal(frpcArchKey('linux', 'arm'), 'linux_armv7');
  assert.equal(frpcArchKey('linux', 'arm64'), 'linux_arm64');
  assert.equal(frpcArchKey('linux', 'mipsel'), 'linux_mipsle');
  assert.equal(frpcArchKey('linux', 'riscv64'), 'linux_riscv64');
  assert.equal(frpcArchKey('freebsd', 'x64'), 'freebsd_amd64');
  // No vendor build / ABI we refuse to guess:
  assert.equal(frpcArchKey('linux', 'ppc64'), null);
  assert.equal(frpcArchKey('linux', 's390x'), null);
  assert.equal(frpcArchKey('aix', 'ppc64'), null);
  assert.equal(frpcArchKey('sunos', 'x64'), null);
});

test('parseClientManifest keeps verifiable frpc entries and drops hash-less ones', () => {
  const parsed = parseClientManifest(manifestFor(Buffer.from('x')));
  assert.equal(parsed.version, '0.51.0-sakura-14');
  assert.ok(parsed.clients.darwin_arm64, 'real binary retained');
  assert.equal(parsed.clients.docker_hub, undefined, 'docker link (no hash) dropped');
  assert.throws(() => parseClientManifest({}), /missing the frpc family/);
  assert.throws(() => parseClientManifest(null), /missing the frpc family/);
});

test('selectFrpcClient returns the entry only for a known arch key', () => {
  const parsed = parseClientManifest(manifestFor(Buffer.from('x')));
  assert.ok(selectFrpcClient(parsed, 'darwin_arm64'));
  assert.equal(selectFrpcClient(parsed, 'linux_amd64'), null);
  assert.equal(selectFrpcClient(null, 'darwin_arm64'), null);
});

test('assertSafeDownloadUrl enforces https and the host allowlist', () => {
  assert.equal(assertSafeDownloadUrl('https://nya.globalslb.net/frpc').hostname, 'nya.globalslb.net');
  assert.equal(assertSafeDownloadUrl('https://cdn.natfrp.com/frpc').hostname, 'cdn.natfrp.com');
  assert.throws(() => assertSafeDownloadUrl('http://nya.globalslb.net/frpc'), /must be https/);
  assert.throws(() => assertSafeDownloadUrl('https://evil.example.com/frpc'), /not on the SakuraFrp allowlist/);
  assert.throws(() => assertSafeDownloadUrl('https://globalslb.net.evil.com/frpc'), /allowlist/);
  assert.throws(() => assertSafeDownloadUrl('not a url'), /not parseable/);
});

test('installFrpc downloads, verifies MD5+size, and writes a 0755 executable', async () => {
  const bytes = Buffer.from('#!/bin/sh\necho frpc\n');
  const { dir, dest } = tmpDest();
  const result = await installFrpc({
    dest,
    platform: 'darwin',
    arch: 'arm64',
    manifest: manifestFor(bytes),
    fetch: fakeFetch({ bytes }),
  });
  assert.equal(result.path, dest);
  assert.equal(result.version, '0.51.0-sakura-14');
  assert.equal(result.archKey, 'darwin_arm64');
  assert.equal(result.size, bytes.length);
  assert.equal(result.hash, md5(bytes));
  assert.deepEqual(fs.readFileSync(dest), bytes);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o755);
  assert.equal(fs.readdirSync(dir).filter(f => f.includes('.partial-')).length, 0, 'no temp file left');
});

test('MD5 mismatch throws and leaves no executable at the destination', async () => {
  const bytes = Buffer.from('real-bytes');
  const { dir, dest } = tmpDest();
  await assert.rejects(
    installFrpc({
      dest, platform: 'darwin', arch: 'arm64',
      manifest: manifestFor(bytes, { hash: '0'.repeat(32) }),
      fetch: fakeFetch({ bytes }),
    }),
    /MD5 mismatch/,
  );
  assert.equal(fs.existsSync(dest), false, 'unverified binary must never be written');
  assert.equal(fs.readdirSync(dir).length, 0, 'nothing left in the dir');
});

test('size mismatch throws and leaves no executable at the destination', async () => {
  const bytes = Buffer.from('real-bytes');
  const { dir, dest } = tmpDest();
  await assert.rejects(
    installFrpc({
      dest, platform: 'darwin', arch: 'arm64',
      manifest: manifestFor(bytes, { size: bytes.length + 1 }),
      fetch: fakeFetch({ bytes }),
    }),
    /size mismatch/,
  );
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('a non-https download URL is refused before any request is made', async () => {
  const bytes = Buffer.from('x');
  const { dest } = tmpDest();
  const fetch = fakeFetch({ bytes });
  await assert.rejects(
    installFrpc({
      dest, platform: 'darwin', arch: 'arm64',
      manifest: manifestFor(bytes, { proto: 'http' }),
      fetch,
    }),
    /must be https/,
  );
  assert.equal(fetch.calls.length, 0, 'no request issued for an unsafe URL');
  assert.equal(fs.existsSync(dest), false);
});

test('an off-allowlist download host is refused before any request is made', async () => {
  const bytes = Buffer.from('x');
  const { dest } = tmpDest();
  const fetch = fakeFetch({ bytes });
  await assert.rejects(
    installFrpc({
      dest, platform: 'darwin', arch: 'arm64',
      manifest: manifestFor(bytes, { host: 'malware.example.net' }),
      fetch,
    }),
    /allowlist/,
  );
  assert.equal(fetch.calls.length, 0);
  assert.equal(fs.existsSync(dest), false);
});

test('installFrpc throws for an arch with no vendor build', async () => {
  const { dest } = tmpDest();
  await assert.rejects(
    installFrpc({ dest, platform: 'linux', arch: 's390x', manifest: manifestFor(Buffer.from('x')), fetch: fakeFetch({ bytes: Buffer.from('x') }) }),
    /no build for linux\/s390x/,
  );
  assert.equal(fs.existsSync(dest), false);
});

test('installFrpc throws when the manifest lacks a verifiable entry for the arch', async () => {
  const bytes = Buffer.from('x');
  const { dest } = tmpDest();
  // Manifest advertises linux_amd64, but we ask for darwin/arm64.
  await assert.rejects(
    installFrpc({ dest, platform: 'darwin', arch: 'arm64', manifest: manifestFor(bytes, { archKey: 'linux_amd64' }), fetch: fakeFetch({ bytes }) }),
    /no verifiable entry for darwin_arm64/,
  );
  assert.equal(fs.existsSync(dest), false);
});

test('installFrpc surfaces a failed download response', async () => {
  const bytes = Buffer.from('x');
  const { dest } = tmpDest();
  await assert.rejects(
    installFrpc({ dest, platform: 'darwin', arch: 'arm64', manifest: manifestFor(bytes), fetch: fakeFetch({ bytes, ok: false, status: 404 }) }),
    /download responded 404/,
  );
  assert.equal(fs.existsSync(dest), false);
});

test('discoverFrpc reports the build without downloading', async () => {
  const bytes = Buffer.from('x');
  const fetch = fakeFetch({ bytes, manifest: manifestFor(bytes) });
  const found = await discoverFrpc({ platform: 'darwin', arch: 'arm64', manifest: manifestFor(bytes) });
  assert.equal(found.supported, true);
  assert.equal(found.version, '0.51.0-sakura-14');
  assert.equal(found.archKey, 'darwin_arm64');
  assert.match(found.client.url, /frpc_darwin_arm64$/);
  assert.equal(fetch.calls.length, 0, 'discovery used the injected manifest, no fetch');

  const unsupported = await discoverFrpc({ platform: 'aix', arch: 'ppc64', fetch });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.archKey, null);
  assert.equal(fetch.calls.length, 0, 'unsupported arch never reaches the network');
});

test('fetchClientManifest fetches the manifest and surfaces non-OK responses', async () => {
  const manifest = manifestFor(Buffer.from('x'));
  const okFetch = fakeFetch({ manifest, bytes: Buffer.alloc(0) });
  assert.deepEqual(await fetchClientManifest({ fetch: okFetch }), manifest);
  assert.equal(okFetch.calls.length, 1);

  const badFetch = fakeFetch({ manifest, bytes: Buffer.alloc(0), ok: false, status: 503 });
  await assert.rejects(fetchClientManifest({ fetch: badFetch }), /responded 503/);
});
