'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFile } = require('node:child_process');
const binary = process.env.PLUGIN_TEST_BIN || path.resolve(__dirname, '../target/release/chrome-proxy-launcher');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-egress-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.multicc/plugins-data/chrome-proxy-launcher');
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  const profile = { id: 'fixture', name: 'fixture', proxy: { scheme: 'http', host: '127.0.0.1', port: 1 }, chromePath: '/usr/bin/true', createdAt: 0, updatedAt: 0 };
  const profilesFile = path.join(root, 'profiles.json');
  fs.writeFileSync(profilesFile, JSON.stringify([profile]));
  function run(command, input) {
    const result = spawnSync(binary, [command], { env: { ...process.env, HOME: home, MULTICC_CDP_GATEWAY: '0' }, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    return JSON.parse(result.stdout);
  }
  return { home, root, profile, profilesFile, run };
}
test('运行中拒绝再次启动或修改出口，保留旧进程记录与配置', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'run/fixture.pid'), String(process.pid));
  fs.writeFileSync(path.join(f.root, 'run/fixture.core.pid'), 'sentinel');
  const before = fs.readFileSync(f.profilesFile, 'utf8');
  for (const [cmd, input] of [
    ['launch', { id: 'fixture', checkProxy: false }],
    ['save', { ...f.profile, proxy: { ...f.profile.proxy, port: 2 } }],
  ]) {
    const response = f.run(cmd, input);
    assert.equal(response.ok, false);
    assert.match(response.error, /仍在运行/);
    assert.equal(fs.readFileSync(f.profilesFile, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(f.root, 'run/fixture.core.pid'), 'utf8'), 'sentinel');
  }
  assert.equal(f.run('save', { ...f.profile, name: 'renamed' }).ok, true);
});
test('引用运行中浏览器的订阅刷新在联网和清理出口前被拒绝', t => {
  const f = fixture(t);
  delete f.profile.proxy;
  f.profile.subscription = { id: 'sub', node: 'node' };
  fs.writeFileSync(f.profilesFile, JSON.stringify([f.profile]));
  fs.writeFileSync(path.join(f.root, 'run/fixture.pid'), String(process.pid));
  fs.writeFileSync(path.join(f.root, 'subscriptions.json'), JSON.stringify([{ id: 'sub', name: 'test', url: 'http://127.0.0.1:1/unreachable' }]));
  const response = f.run('subscription-refresh', { id: 'sub' });
  assert.equal(response.ok, false);
  assert.match(response.error, /仍在运行/);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
test('真实 Chrome：固定代理可用时访问成功，断代理后目标直连数为零', { skip: !process.env.CHROME_TEST_BIN, timeout: 40000 }, async t => {
  const f = fixture(t);
  let targetHits = 0;
  const target = http.createServer((req, res) => { targetHits++; res.end('PROXY_PATH_OK'); });
  await listen(target);
  t.after(() => close(target));
  const url = `http://127.0.0.1:${target.address().port}/`;
  const proxy = http.createServer((req, res) => {
    if (req.url !== url) { res.writeHead(502); res.end(); return; }
    http.get(url, upstream => upstream.pipe(res)).on('error', () => { res.writeHead(502); res.end(); });
  });
  proxy.on('connect', (req, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await listen(proxy);
  t.after(() => close(proxy));
  f.profile.proxy.port = proxy.address().port;
  fs.writeFileSync(f.profilesFile, JSON.stringify([f.profile]));
  // 普通启动也必须拥有控制管道；用临时无头实例获取实际参数后正常关闭。
  const wrapper = path.join(f.home, 'chrome');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec '+"'"+process.env.CHROME_TEST_BIN.replaceAll("'", "'\\''")+"'"+' --headless=new --use-mock-keychain --disable-background-networking \"$@\"\n', {mode:0o700});
  f.profile.chromePath = wrapper;
  fs.writeFileSync(f.profilesFile, JSON.stringify([f.profile]));
  const launched = f.run('launch', { id: 'fixture', checkProxy: false, url, automaticFingerprint: false });
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(f.run('stop', {id:'fixture'}).ok, true);
  let runNumber = 0;
  const runChrome = () => new Promise((resolve, reject) => {
    const suffix = ++runNumber;
    const logFile = path.join(f.home, `network-${suffix}.json`);
    const args = launched.data.args.map(arg => arg.startsWith('--user-data-dir=')
      ? `--user-data-dir=${path.join(f.home, `headless-${suffix}`)}` : arg);
    // 独立 user-data-dir 仍会访问系统钥匙串；只在测试中使用模拟钥匙串。
    execFile(process.env.CHROME_TEST_BIN, [...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '--headless=new', '--disable-background-networking', '--dump-dom', `--log-net-log=${logFile}`, ...args],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try { resolve({ html: stdout, log: JSON.parse(fs.readFileSync(logFile, 'utf8')) }); }
        catch (e) { reject(e); }
      });
  });
  assert.match((await runChrome()).html, /PROXY_PATH_OK/);
  assert.ok(targetHits > 0);
  await close(proxy);
  const before = targetHits;
  const blocked = await runChrome();
  assert.doesNotMatch(blocked.html, /PROXY_PATH_OK/);
  // 无头 Chrome 不保证输出网络错误页 DOM，以网络日志确认确实尝试了页面加载并报代理错误。
  const requestSources = new Set(blocked.log.events.filter(e => e.params?.url === url).map(e => e.source.id));
  assert.ok(requestSources.size > 0);
  assert.ok(blocked.log.events.some(e => requestSources.has(e.source.id) && e.params?.net_error === -130));
  assert.equal(targetHits, before);
});
