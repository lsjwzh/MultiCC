'use strict';

const assert = require('assert');
const { test } = require('node:test');
const {
  installGlobalProxy, resolveProxyEnv, parseMacSystemProxy, cidrToRange,
  latestChildProxyEnv, latestProxyMode, systemProxyHijackHint, resetLatestForTests,
} = require('../src/network/global-proxy');
const { ensureLoopbackNoProxyEnv, mergeLoopbackNoProxy } = require('../src/network/proxy-policy');

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : *.local
    3 : <local>
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}`;

test('cidrToRange converts CIDR to NO_PROXY ranges', () => {
  assert.strictEqual(cidrToRange('10.0.0.0/8'), '10.0.0.0-10.255.255.255');
  assert.strictEqual(cidrToRange('172.16.0.0/12'), '172.16.0.0-172.31.255.255');
  assert.strictEqual(cidrToRange('*.local'), null);
});

test('macOS system proxy and exceptions become proxy env, loopback always direct', () => {
  const cfg = resolveProxyEnv({}, parseMacSystemProxy(SCUTIL));
  assert.strictEqual(cfg.HTTPS_PROXY, 'http://127.0.0.1:7897');
  const noProxy = cfg.NO_PROXY.split(',');
  for (const h of ['localhost', '127.0.0.1', '::1', '192.168.0.0/16', '*.local']) assert.ok(noProxy.includes(h), h);
  assert.ok(noProxy.includes('<local>'));
});

test('explicit env wins over the system proxy; empty env means direct', () => {
  const system = parseMacSystemProxy(SCUTIL);
  assert.strictEqual(resolveProxyEnv({ HTTPS_PROXY: 'http://p:1' }, system).HTTPS_PROXY, 'http://p:1');
  assert.strictEqual(resolveProxyEnv({ HTTPS_PROXY: '' }, system), null);
  assert.throws(() => resolveProxyEnv({ ALL_PROXY: 'socks5://p:1' }, system), /HTTP\(S\)/);
  assert.strictEqual(resolveProxyEnv({}, null), null);
});

test('installGlobalProxy applies once per distinct config and re-applies on change', async () => {
  const applied = [];
  const env = {};
  let system = parseMacSystemProxy(SCUTIL);
  const g = installGlobalProxy({ env, platform: 'darwin', refresh: false, log() {}, apply: c => applied.push(c), readSystemProxy: async () => system });
  await g.ready;
  await g.refresh();
  assert.strictEqual(applied.length, 1);
  system = { httpProxy: '', httpsProxy: '', exceptions: [] };
  await g.refresh();
  assert.deepStrictEqual(applied, [applied[0], null]);
  g.stop();
});

test('a changed proxy is picked up by the periodic refresh', async () => {
  const applied = [];
  const env = { HTTP_PROXY: 'http://127.0.0.1:1111' };
  const g = installGlobalProxy({ env, platform: 'linux', refreshMs: 20, log() {}, apply: c => applied.push(c) });
  await g.ready;
  assert.strictEqual(applied.at(-1).HTTP_PROXY, 'http://127.0.0.1:1111');
  env.HTTP_PROXY = 'http://127.0.0.1:2222';
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(applied.at(-1).HTTP_PROXY, 'http://127.0.0.1:2222');
  g.stop();
});

test('a failed system-proxy read keeps the previous settings instead of going direct', async () => {
  let fail = false;
  const applied = [];
  const g = installGlobalProxy({
    env: {}, platform: 'darwin', refresh: false, log() {}, apply: c => applied.push(c),
    readSystemProxy: async () => {
      if (fail) throw new Error('scutil timeout');
      return { httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897', exceptions: [] };
    },
  });
  await g.ready;
  assert.strictEqual(applied.length, 1);
  fail = true;
  await g.refresh();
  assert.strictEqual(applied.length, 1, 'no re-apply: same config retained');
});

test('a SOCKS-only system proxy warns and does not claim to be proxied', async () => {
  const applied = [], logs = [];
  const g = installGlobalProxy({
    env: {}, platform: 'darwin', refresh: false, apply: c => applied.push(c), log: m => logs.push(m),
    readSystemProxy: async () => ({ httpProxy: '', httpsProxy: '', socksProxy: 'socks5://127.0.0.1:1080', exceptions: [] }),
  });
  await g.ready;
  assert.deepStrictEqual(applied, []);
  await assert.rejects(g.refresh(), /SOCKS/);
  assert.ok(logs.some(m => /SOCKS/.test(m)), logs.join('\n'));
});

test('an explicit proxy env skips reading the system proxy', async () => {
  let reads = 0;
  const g = installGlobalProxy({
    env: { HTTPS_PROXY: 'http://127.0.0.1:7897' }, platform: 'darwin', refresh: false, log() {}, apply() {},
    readSystemProxy: async () => { reads += 1; return { httpProxy: '', httpsProxy: '', exceptions: [] }; },
  });
  await g.ready;
  await g.refresh();
  assert.strictEqual(reads, 0);
});

test('mergeLoopbackNoProxy mirrors DIRECT_HOSTS into both spellings and keeps entries', () => {
  const merged = mergeLoopbackNoProxy({ no_proxy: 'example.com', OTHER: '1' });
  assert.ok(merged.no_proxy.includes('example.com'));
  for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) assert.ok(merged.NO_PROXY.includes(h), h);
  assert.strictEqual(merged.no_proxy, merged.NO_PROXY);
  assert.strictEqual(merged.OTHER, '1');
});

test('ensureLoopbackNoProxyEnv only rewrites env that carries proxy vars', () => {
  const clean = { PATH: '/bin' };
  assert.strictEqual(ensureLoopbackNoProxyEnv(clean), clean);
  const proxied = ensureLoopbackNoProxyEnv({ HTTP_PROXY: 'http://p:1' });
  assert.strictEqual(proxied.HTTP_PROXY, 'http://p:1');
  assert.ok(proxied.no_proxy.includes('127.0.0.1'));
  assert.strictEqual(proxied.NO_PROXY, proxied.no_proxy);
});

test('refresh publishes the child proxy env snapshot and its mode', async () => {
  resetLatestForTests();
  const system = parseMacSystemProxy(SCUTIL);
  const g = installGlobalProxy({
    env: {}, platform: 'darwin', refresh: false, log() {}, apply() {},
    readSystemProxy: async () => system,
  });
  await g.ready;
  const snapshot = latestChildProxyEnv();
  assert.strictEqual(snapshot.HTTPS_PROXY, 'http://127.0.0.1:7897');
  for (const h of ['localhost', '127.0.0.1', '::1']) assert.ok(snapshot.NO_PROXY.includes(h), h);
  assert.strictEqual(latestProxyMode(), 'system-proxy');
  g.stop();
  resetLatestForTests();
});

test('systemProxyHijackHint fires only for codex 502-style failures under an active system proxy', async () => {
  resetLatestForTests();
  assert.strictEqual(systemProxyHijackHint({ cli: 'codex', httpStatus: 502 }), null);
  const system = parseMacSystemProxy(SCUTIL);
  const g = installGlobalProxy({
    env: {}, platform: 'darwin', refresh: false, log() {}, apply() {},
    readSystemProxy: async () => system,
  });
  await g.ready;
  const hint = systemProxyHijackHint({ cli: 'codex', httpStatus: 502 });
  assert.ok(/系统代理劫持/.test(hint));
  assert.ok(systemProxyHijackHint({ cli: 'codex', detail: 'Unknown error' }).includes('127.0.0.1'));
  assert.strictEqual(systemProxyHijackHint({ cli: 'claude', httpStatus: 502 }), null);
  assert.strictEqual(systemProxyHijackHint({ cli: 'codex', httpStatus: 500 }), null);
  assert.strictEqual(systemProxyHijackHint({ cli: 'codex', httpStatus: null, detail: 'unrelated failure' }), null);
  g.stop();
  resetLatestForTests();
});
