'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const binary = process.env.PLUGIN_TEST_BIN || path.resolve(__dirname, '../target/release/chrome-proxy-launcher');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 经过真实启动入口和本地代理，检查网页首段脚本看到的时区。
// 假地理服务让测试不依赖真实 IP、第三方服务或用户的浏览器数据。
test('出口时区随身份独立设置，识别失败时如实报告', { skip: !process.env.CHROME_TEST_BIN, timeout: 90000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-timezone-'));
  const env = { ...process.env, HOME: home, TZ: 'Asia/Shanghai', MULTICC_CDP_GATEWAY: '0' };
  const ids = [];
  const run = (command, input) => new Promise((resolve, reject) => {
    const child = execFile(binary, [command], { env, timeout: 25000 }, (error, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(error || e); }
    });
    child.stdin.end(JSON.stringify(input));
  });
  const wrapper = path.join(home, 'chrome');
  const chromeLog = path.join(home, 'chrome.log');
  // macOS 无头 Chrome 将 Cocoa 的 -AppleLanguages 参数误当成额外网址；
  // 这里仅排除界面语言参数，保留生产启动路径的 TZ 和其余参数。
  fs.writeFileSync(wrapper, '#!/bin/bash\nargs=()\nwhile (($#)); do if [[ "$1" == "-AppleLanguages" ]]; then shift 2; else args+=("$1"); shift; fi; done\nexec ' + "'" + process.env.CHROME_TEST_BIN.replaceAll("'", "'\\''") + "'" + ' --headless=new --use-mock-keychain --disable-background-networking "${args[@]}" 2>"' + chromeLog + '"\n', { mode: 0o700 });
  const samples = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('http://ip-api.com/')) {
      const zone = server.zone;
      if (zone === null) { res.writeHead(503); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'success', country: 'United States', countryCode: 'US', timezone: zone, query: '203.0.113.42' }));
    } else if (req.url.startsWith('http://time.fixture/sample?')) {
      samples.push(JSON.parse(decodeURIComponent(req.url.split('?')[1])));
      res.end('ok');
    } else if (req.url.startsWith('http://time.fixture/')) {
      res.setHeader('content-type', 'text/html');
      res.end(`<script>fetch('/sample?'+encodeURIComponent(JSON.stringify({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,january:new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),july:new Date('2026-07-15T12:00:00Z').getTimezoneOffset()})))</script>`);
    } else { res.writeHead(502); res.end(); }
  });
  server.on('connect', (_, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const id of ids) await run('stop', { id }).catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const [timezone, fingerprint, expected] of [
    ['America/Los_Angeles', true, { zone: 'America/Los_Angeles', january: 480, july: 420 }],
    ['Europe/London', false, { zone: 'Europe/London', january: 0, july: -60 }],
    ['', false, { zone: 'Asia/Shanghai', january: -480, july: -480 }],
    [null, false, { zone: 'Asia/Shanghai', january: -480, july: -480 }],
  ]) {
    server.zone = timezone;
    const saved = await run('save', { name: `zone-${ids.length}`, chromePath: wrapper, proxy: { scheme: 'http', host: '127.0.0.1', port: server.address().port } });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const id = saved.data.profile.id; ids.push(id);
    const launched = await run('launch', { id, url: 'http://time.fixture/', automaticFingerprint: fingerprint });
    assert.equal(launched.ok, true, JSON.stringify(launched) + '\n' + (fs.existsSync(chromeLog) ? fs.readFileSync(chromeLog, 'utf8') : ''));
    assert.equal(launched.data.geo.applied, Boolean(timezone), JSON.stringify(launched.data.geo));
    if (!timezone) assert.match(launched.data.geo.reason, /时区/);
    for (let i = 0; !samples.length && i < 200; i++) await delay(50);
    assert.deepEqual(samples.shift(), expected);
  }
});
