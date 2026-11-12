'use strict';
// Compare frozen Node routes with the real Rust gateway and host adapters.
// Usage: node docs/rust-migration/differential/system-scan.js <repo> <gateway> <addon>
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { run } = require('./lib');
const INTERFACES = {
  utun0: [{ family: 'IPv4', internal: false, address: '10.1.0.1' }],
  en0: [{ family: 'IPv4', internal: false, address: '192.168.1.9' }],
  eth0: [{ family: 4, internal: false, address: '10.0.0.8' }],
};
const PASSES = Array.from({ length: 7 }, (_, i) => ({ seq: 7 - i, label: `pass-${i}` }));
const TAGS = 'a refs/tags/v1.2.0\nb refs/tags/v3.0.0\nc refs/tags/v2.5.0\n';
const NOW = Date.parse('2026-07-27T05:32:00.000Z');
let releaseBody = '{"tag_name":"v2.3.4"}';
let upstreamText = '';
function mockHttps() {
  return { get(_url, _options, callback) {
    const request = new EventEmitter(); request.destroy = () => {};
    process.nextTick(() => { const response = new EventEmitter(); callback(response);
      process.nextTick(() => { response.emit('data', releaseBody); response.emit('end'); }); });
    return request;
  } };
}
function upstream(repo, rootDir) {
  return `'use strict';
const net = require('node:net'); const http = require('node:http');
const path = require('node:path'); const fs = require('node:fs');
const repo = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [repo] }));
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
const app = express(); app.use(express.json());
require(path.join(repo, 'src/routes/system-host')).mountSystemHostRoute(app, {
 fs, path, rootDir: ${JSON.stringify(rootDir)}, networkInterfaces: () => (${JSON.stringify(INTERFACES)}),
 getPort: () => 45123, getBindHost: () => '0.0.0.0', authRequired: () => true,
 uptimeSeconds: () => 8100, now: () => ${NOW}, gitRun: async () => ${JSON.stringify(TAGS)},
});
require(path.join(repo, 'src/routes/scan-history-host')).mountScanHistoryHostRoute(app, {
 scanHistory: { seq: 7, passes: ${JSON.stringify(PASSES)} }, maxPasses: 5,
});
app.use((req, res) => res.status(599).send('forwarded:' + req.method + ' ' + req.url));
const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
 socket.on('error', () => {}); let buffered = Buffer.alloc(0);
 const onData = chunk => { buffered = Buffer.concat([buffered, chunk]);
  const end = buffered.indexOf('\\r\\n'); if (end < 0) return;
  socket.removeListener('data', onData); socket.pause();
  const rest = buffered.subarray(end + 2); if (rest.length) socket.unshift(rest);
  server.emit('connection', socket); socket.resume(); };
 socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
}
async function main() {
  const releaseServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.end(releaseBody);
  });
  await new Promise(resolve => releaseServer.listen(0, '127.0.0.1', resolve));
  try {
    const ok = await run({
      name: 'system-scan',
      mount(app, { repo, work }) {
        const rootDir = path.join(work, 'gw');
        fs.writeFileSync(path.join(rootDir, 'package.json'), '{"version":"1.7.3"}');
        fs.writeFileSync(path.join(rootDir, '.multicc_channel'), '# channel: release\n');
        const legacy = require(path.join(repo, 'tests/helpers/legacy-system-scan-routes'));
        const scan = require(path.join(repo, 'tests/helpers/legacy-scan-route'));
        const deps = { fs, path, https: mockHttps(), rootDir, networkInterfaces: () => INTERFACES,
          getPort: () => 45123, getBindHost: () => '0.0.0.0', authRequired: () => true,
          uptimeSeconds: () => 8100, now: () => NOW, gitRun: async () => TAGS };
        app.get('/api/server-info', legacy.createServerInfoHandler(deps));
        app.get('/api/version-check', legacy.createVersionCheckHandler(deps));
        app.get('/api/debug/codex-proxy-trace', (req, res) => {
          const requested = Number(req.query && req.query.limit);
          const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 100;
          res.json({ entries: require(path.join(repo, 'src/codex/proxy-trace')).codexProxyTrace().snapshot(limit) });
        });
        scan.mountScanRoutes(app, { scanHistory: { seq: 7, passes: PASSES }, maxPasses: 5 });
        upstreamText = upstream(repo, rootDir);
      },
      get upstream() { return upstreamText; },
      gatewayEnv: () => ({ MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
        MULTICC_VERSION_CHECK_RELEASES_URL: `http://127.0.0.1:${releaseServer.address().port}/latest` }),
      corpus() {
        const headers = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
        const req = (method, url) => ({ method, url, headers });
        const cases = [];
        for (const url of ['/api/server-info', '/api/Server-Info/', '/api/scan/history',
          '/api/debug/codex-proxy-trace', '/api/version-check']) {
          for (const method of ['GET', 'HEAD', 'OPTIONS']) cases.push([`${method} ${url}`, req(method, url)]);
        }
        for (const value of ['1', '3', '999', '0', '-2', '-999', '1.9', '1e3', 'abc', '', '0x10', '2&limit=3']) {
          for (const url of ['/api/scan/history', '/api/debug/codex-proxy-trace'])
            cases.push([`${url} limit=${value}`, req('GET', `${url}?limit=${value}`)]);
        }
        for (const [name, body] of [['fallback', '{}'], ['malformed', '{']]) {
          cases.push([`version ${name}`, req('GET', '/api/version-check'), { before() { releaseBody = body; } }]);
        }
        return cases;
      },
    });
    process.exitCode = ok ? 0 : 1;
  } finally { releaseServer.closeAllConnections?.(); releaseServer.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
