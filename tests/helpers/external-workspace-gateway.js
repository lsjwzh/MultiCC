'use strict';
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const addonPath = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../../native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');
const binary = path.join(path.dirname(addonPath), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
const fixture = path.resolve(__dirname, 'gateway-auth-child.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const remote = { host: 'fixture.example', 'x-request-id': 'auth-test', 'x-correlation-id': 'correlation-test' };
function request(port, method, url, headers = {}, body = '', host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({ host, port, method, path: url,
      headers: { ...remote, ...headers, 'content-length': bytes.length }, timeout: 8000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), bytes: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`fixture request timeout: ${port} ${method} ${url}`)));
    req.on('error', reject); req.end(bytes);
  });
}
async function start(t, native = true, options = {}) {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-external-gateway-'));
  fs.mkdirSync(dir, { recursive: true });
  if (options.source) fs.writeFileSync(path.join(dir, 'source-context.json'), JSON.stringify(options.source));
  if (options.shares) fs.writeFileSync(path.join(dir, 'fleet-shares.json'), JSON.stringify(options.shares));
  if (options.seed) fs.writeFileSync(path.join(dir, 'external-fleets.json'), JSON.stringify(options.seed));
  // A real package layout keeps the gateway's static root independent of its
  // data directory and working directory. Both oracles see identical file stats.
  const packageRoot = path.join(dir, 'package');
  const script = options.source ? path.join(packageRoot, 'server.js') : fixture;
  if (options.source) {
    fs.mkdirSync(path.join(packageRoot, 'public'), { recursive: true });
    fs.writeFileSync(script, `require(${JSON.stringify(fixture)});\n`);
    const source = path.resolve(__dirname, '../../public/fleet-share.html');
    const page = path.join(packageRoot, 'public/fleet-share.html');
    fs.copyFileSync(source, page);
    const stat = fs.statSync(source);
    fs.utimesSync(page, stat.atime, stat.mtime);
  }
  const host = options.host || '127.0.0.1';
  const env = { ...process.env, PORT: String(port), HOST: host, MULTICC_ENV_FILE: path.join(dir, '.env'),
    MULTICC_ALLOW_REMOTE: options.allowRemote ? '1' : '0', ACCESS_TOKEN: 'fixture-token',
    MULTICC_TEST_SOURCE_ROUTES: options.source ? '1' : '0',
    MULTICC_TEST_PACKAGE_ROOT: packageRoot,
    MULTICC_DATA_DIR: dir, MULTICC_GATEWAY_BACKOFF_SCALE: '0.01', MULTICC_RUST_ADDON: addonPath, MULTICC_TEST_EXTERNAL_ROUTES: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('MULTICC_GATEWAY_') && key !== 'MULTICC_GATEWAY_BACKOFF_SCALE') delete env[key];
  const child = spawn(native ? binary : process.execPath, native ? ['serve', '--cwd', dir, '--node', process.execPath, '--stdin-lifeline', '--', script] : [script],
    { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', c => { logs += c; }); child.stderr.on('data', c => { logs += c; });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGINT'); await exit; }
    if (!options.dir) fs.rmSync(dir, { recursive: true, force: true });
  };
  t.after(close);
  for (let i = 0; i < 150; i++) {
    try { if ((await request(port, 'GET', '/fixture/state', {}, '', host)).status === 200) return { port, dir, packageRoot, child, close, origin: `http://${host}:${port}` }; } catch {}
    if (child.exitCode !== null) throw new Error(`fixture exited: ${logs}`);
    await delay(20);
  }
  throw new Error(`fixture did not start: ${logs}`);
}
module.exports = { start, request };
