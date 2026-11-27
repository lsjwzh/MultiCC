'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { createOutbound } = require('../src/network/outbound');
const { createProxyPolicy, bypassProxy, parseMacSystemProxy } = require('../src/network/proxy-policy');
const { installGlobalProxy } = require('../src/network/global-proxy');

async function fixture(t) {
  const sockets = new Set();
  const hits = [];
  const origin = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${origin.address().port}/local` });
    }
    res.end('正常响应');
  });
  const ws = new WebSocketServer({ server: origin });
  ws.on('connection', client => client.send('长连接成功'));
  const proxy = http.createServer((req, res) => { hits.push(req.url); res.end('正常响应'); });
  proxy.on('connect', (req, client, head) => {
    hits.push(req.url);
    const remote = net.connect(origin.address().port, '127.0.0.1');
    sockets.add(remote); remote.on('close', () => sockets.delete(remote));
    remote.on('error', () => client.destroy());
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    });
    client.on('close', () => remote.destroy());
  });
  for (const server of [origin, proxy]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    ws.close();
    await Promise.all([origin, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  return { origin, hits, proxyUrl: `http://127.0.0.1:${proxy.address().port}` };
}

test('统一入口在没有全局初始化时代理 HTTP、WebSocket，重定向到本机则直连', async t => {
  const f = await fixture(t);
  const client = createOutbound({ platform: 'linux', env: { HTTP_PROXY: f.proxyUrl } });
  t.after(() => client.close());
  const response = await client.outboundFetch('http://audit.invalid/redirect');
  assert.equal(await response.text(), '正常响应');
  assert.equal(f.hits.length, 1);
  const socket = new WebSocket('ws://audit.invalid/socket', { agent: client.outboundAgent });
  t.after(() => socket.terminate());
  const [data] = await once(socket, 'message');
  assert.equal(data.toString(), '长连接成功');
  assert.equal(f.hits.length, 2);
  socket.close(); await once(socket, 'close');
  const local = await client.outboundFetch(`http://127.0.0.1:${f.origin.address().port}/local`);
  await local.text();
  assert.equal(f.hits.length, 2);
});

test('代理连接失败不会改为直连重试，原有取消信号有效', async t => {
  const dead = net.createServer(); dead.listen(0, '127.0.0.1'); await once(dead, 'listening');
  const port = dead.address().port; await new Promise(r => dead.close(r));
  const client = createOutbound({ platform: 'linux', env: { HTTP_PROXY: `http://127.0.0.1:${port}` } });
  t.after(() => client.close());
  await assert.rejects(client.outboundFetch('http://audit.invalid/', { signal: AbortSignal.timeout(1000) }),
    error => error.cause?.code === 'ECONNREFUSED');
  await assert.rejects(client.outboundFetch('http://audit.invalid/', { signal: AbortSignal.abort() }), /abort/i);
});

test('初次发现失败阻止外网，但本地 IPC 仍可用；不支持的代理不会直连', async t => {
  const f = await fixture(t);
  const client = createOutbound({ platform: 'darwin', env: {}, readSystemProxy: async () => { throw new Error('发现失败'); } });
  t.after(() => client.close());
  await assert.rejects(client.outboundFetch('http://audit.invalid/'), /发现失败/);
  assert.equal(await (await client.outboundFetch(`http://127.0.0.1:${f.origin.address().port}/`)).text(), '正常响应');
  const policy = createProxyPolicy({ platform: 'linux', env: { ALL_PROXY: 'socks5://127.0.0.1:1234' } });
  await assert.rejects(policy.proxyForUrl('https://audit.invalid'), /HTTP\(S\)/);
});

test('系统设置刷新、异常保留上次代理，环境配置始终优先', async () => {
  let now = 0, fail = false, scans = 0;
  const env = {};
  const policy = createProxyPolicy({ env, platform: 'darwin', now: () => now, readSystemProxy: async () => {
    scans++;
    if (fail) throw new Error('暂时失败');
    return { httpsProxy: `http://proxy:${scans}`, exceptions: ['192.168.0.0/16'] };
  } });
  assert.equal(await policy.proxyForUrl('https://audit.invalid'), 'http://proxy:1');
  now = 31000; fail = true;
  assert.equal(await policy.proxyForUrl('https://audit.invalid'), 'http://proxy:1');
  env.https_proxy = 'http://override:8888';
  assert.equal(await policy.proxyForUrl('https://audit.invalid'), 'http://override:8888');
  assert.equal(scans, 2);
});

test('统一旁路支持本机、域名、端口、IPv4 CIDR 和系统例外', () => {
  const entries = ['.example.test', 'specific.test:8443', '192.168.0.0/16', '10.0.0.1-10.0.0.9', '<local>'];
  for (const url of ['http://127.2.3.4', 'http://[::1]', 'https://a.example.test', 'https://specific.test:8443',
    'https://192.168.8.2', 'http://10.0.0.5', 'http://printer']) assert.equal(bypassProxy(new URL(url), entries), true, url);
  for (const url of ['https://specific.test', 'https://other.test', 'http://192.169.0.1']) {
    assert.equal(bypassProxy(new URL(url), entries), false, url);
  }
});

test('子进程获得系统代理和大小写一致的环境，父环境不被修改', async t => {
  const env = {};
  const client = createOutbound({ env, platform: 'darwin', readSystemProxy: async () => ({
    httpProxy: 'http://proxy:1234', httpsProxy: 'http://proxy:5678', exceptions: ['*.local'],
  }) });
  t.after(() => client.close());
  const child = await client.getChildProxyEnv({ PATH: '/usr/bin', https_proxy: 'http://stale:1' });
  assert.equal(child.https_proxy, 'http://proxy:5678');
  assert.equal(child.HTTPS_PROXY, child.https_proxy);
  assert.equal(child.http_proxy, 'http://proxy:1234');
  assert.ok(child.NO_PROXY.includes('127.0.0.1'));
  assert.ok(child.NO_PROXY.includes('*.local'));
  assert.deepEqual(env, {});
});

test('启动尚未完成时默认 fetch 和 HTTP 都等待代理，且不依赖新版 Node 代理 API', async t => {
  const f = await fixture(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const previous = http.setGlobalProxyFromEnv;
  http.setGlobalProxyFromEnv = undefined;
  const global = installGlobalProxy({ env: {}, platform: 'darwin', refresh: false, log() {}, readSystemProxy: () => pending });
  t.after(() => { global.stop(); http.setGlobalProxyFromEnv = previous; });
  const request = fetch('http://audit.invalid/');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.hits.length, 0);
  release({ httpProxy: f.proxyUrl, httpsProxy: f.proxyUrl });
  await global.ready;
  assert.equal(await (await request).text(), '正常响应');
  // Native HTTP uses absolute-form through the same policy.
  const body = await new Promise((resolve, reject) => {
    http.get('http://audit.invalid/native', res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  assert.equal(body, '正常响应');
  assert.equal(f.hits.length, 2);
});


test('代理发现等待支持及时取消且不会发送请求', async t => {
  let release, requests = 0;
  const discovery = new Promise(resolve => { release = resolve; });
  const client = createOutbound({ env: {}, platform: 'darwin', readSystemProxy: () => discovery,
    fetch: async () => { requests++; } });
  t.after(() => client.close());
  const controller = new AbortController();
  const result = client.outboundFetch('https://audit.invalid', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(result, /abort/i);
  assert.equal(requests, 0);
  release({ httpsProxy: 'http://proxy:1234' });
});

test('兼容原生 Request 对象与 macOS 排除简单主机名设置', async t => {
  const f = await fixture(t);
  const client = createOutbound({ env: {}, platform: 'linux' });
  t.after(() => client.close());
  const request = new globalThis.Request(`http://127.0.0.1:${f.origin.address().port}/`);
  assert.equal(await (await client.outboundFetch(request)).text(), '正常响应');
  const config = parseMacSystemProxy('ExcludeSimpleHostnames : 1');
  assert.ok(config.exceptions.includes('<local>'));
});

test('混合系统代理配置不能让未支持的协议静默直连', async () => {
  const policy = createProxyPolicy({ env: {}, platform: 'darwin', readSystemProxy: async () => ({
    httpProxy: 'http://proxy:1234', httpsProxy: '', socksProxy: 'socks5://proxy:1234',
  }) });
  await assert.rejects(policy.proxyForUrl('https://audit.invalid'), /SOCKS/);
});

test('HTTPS 和加密 WebSocket 使用代理隧道并正常校验证书', { timeout: 20000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const https = require('node:https');
  const run = require('node:util').promisify(require('node:child_process').execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-proxy-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cert.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=audit.invalid\n[ext]\nsubjectAltName=DNS:audit.invalid\n');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', path.join(dir, 'cert.cnf'), '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')]);
  const sockets = new Set();
  let hits = 0;
  const origin = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')),
    cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (_, res) => res.end('加密请求成功'));
  const ws = new WebSocketServer({ server: origin });
  ws.on('connection', client => client.send('加密长连接成功'));
  const proxy = http.createServer();
  proxy.on('connect', (_, client, head) => {
    hits++;
    const remote = net.connect(origin.address().port, '127.0.0.1');
    sockets.add(remote); remote.on('close', () => sockets.delete(remote));
    remote.on('error', () => client.destroy());
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    });
    client.on('close', () => remote.destroy());
  });
  for (const server of [origin, proxy]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    ws.close();
    await Promise.all([origin, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  const code = `
    const network = require(${JSON.stringify(require.resolve('../src/network/outbound'))});
    const { installGlobalProxy } = require(${JSON.stringify(require.resolve('../src/network/global-proxy'))});
    const WebSocket = require(${JSON.stringify(require.resolve('ws'))});
    const https = require('node:https');
    (async () => {
      const global = installGlobalProxy(); await global.ready;
      console.log(await (await network.outboundFetch('https://audit.invalid/')).text());
      await new Promise((resolve, reject) => {
        https.get('https://audit.invalid/native', res => { res.resume(); res.on('end', resolve); }).on('error', reject);
      });
      await new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://audit.invalid/', { agent: network.outboundAgent });
        ws.on('message', data => { console.log(data.toString()); ws.close(); });
        ws.on('error', reject); ws.on('close', resolve);
      });
      global.stop(); await network.close();
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = await run(process.execPath, ['-e', code], { timeout: 10000,
    env: { PATH: process.env.PATH, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem') } });
  assert.match(result.stdout, /加密请求成功/);
  assert.match(result.stdout, /加密长连接成功/);
  assert.equal(hits, 3);
});

require('node:test')('67f54869 differential: network/proxy-policy', async () => {
  const { compare } = require('./helpers/compare-leaf-hosts');
  await compare('network/proxy-policy.js', api => {
    const rows = [];
    for (const env of [{}, { https_proxy: '', ALL_PROXY: 'http://local:9', NO_PROXY: 'a, a b' }, { ALL_PROXY: 'socks5://x' }]) {
      try { rows.push(api.resolveProxyConfig(env, { exceptions: ['.example'] })); }
      catch (error) { rows.push([error.name, error.message]); }
      rows.push(api.mergeLoopbackNoProxy(env));
    }
    for (const host of ['[[::1]]', 'localHost', '10.01.1.3', '\ud800', 'a.example']) {
      rows.push(api.isLoopback(host), api.bypassProxy({ hostname: host, protocol: 'https:', port: '' }, ['10.0.0.0/8', '.example:443', '\ud801']));
    }
    return rows;
  });
});
