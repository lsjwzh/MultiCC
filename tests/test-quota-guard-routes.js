'use strict';

// Real front door + native runtime: the file a settings save writes must be
// the same configuration the proxy guard subsequently enforces.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const addonPath = process.env.MULTICC_RUST_ADDON || path.join(
  process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../native/prebuilt'),
  `${process.platform}-${process.arch}`, 'multicc_core.node',
);
const { createQuotaGuard } = require('../src/quota/quota-guard');
const NOW = 1_800_000_000_000;

async function mount(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-quota-api-'));
  fs.copyFileSync(path.resolve('native/gateway/tests/fixtures/upstream.js'), path.join(dir, 'server.js'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MULTICC_QUOTA_GUARD')));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', ACCESS_TOKEN: '', LAN_ONLY: '0', MULTICC_LAN_ONLY: '0',
    MULTICC_DATA_DIR: dir, FIXTURE_STATE_DIR: path.join(dir, 'state'), ...extra });
  const binary = path.join(path.dirname(addonPath), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  const child = spawn(binary, ['serve', '--cwd', dir, '--node', process.execPath, '--stdin-lifeline', 'server.js'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { log += data; });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(kill); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(dir, 'state/ready'))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`gateway failed: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  async function call(method, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/quota-guard`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { code: response.status, payload: response.status === 304 ? null : await response.json(), response };
  }
  return { get: () => call('GET'), put: body => call('PUT', body), call,
    file: path.join(dir, 'quota-guard.json'),
    noNode() { assert.equal(fs.existsSync(path.join(dir, 'state/requests.log')), false); },
  };
}

test('without a file the native API and guard share exactly the defaults', async t => {
  const routes = await mount(t);
  const res = await routes.get();
  assert.equal(res.code, 200);
  const guard = createQuotaGuard({ configFile: routes.file, env: {}, now: () => NOW });
  assert.deepEqual(res.payload.config, guard.config());
  assert.deepEqual(res.payload.saved, {});
  assert.deepEqual(res.payload.envOverrides, []);
  assert.equal(res.payload.filePath, routes.file);
  routes.noNode();
});

test('a partial save preserves unknown fields and uses the legacy JSON format', async t => {
  const routes = await mount(t);
  const initial = { weeklyPercent: 90, custom: { label: '保留', empty: [], surrogate: '\ud800' } };
  fs.writeFileSync(routes.file, JSON.stringify(initial));
  const res = await routes.put({ enabled: false, fiveHourPercent: '97.5' });
  assert.equal(res.code, 200);
  const saved = { ...initial, fiveHourPercent: 97.5, enabled: false };
  assert.deepEqual(res.payload.saved, saved);
  assert.equal(res.payload.config.enabled, false);
  assert.equal(fs.readFileSync(routes.file, 'utf8'), `${JSON.stringify(saved, null, 2)}\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(routes.file).mode & 0o777, 0o644);
  routes.noNode();
});

test('invalid values preserve the existing file and validation precedence', async t => {
  const routes = await mount(t);
  fs.writeFileSync(routes.file, '{"weeklyPercent":90}');
  for (const fiveHourPercent of [0, -1, 101, 'abc', '', null]) {
    const res = await routes.put({ fiveHourPercent, enabled: 'bad' });
    assert.equal(res.code, 400);
    assert.match(res.payload.error, /^fiveHourPercent:/);
  }
  for (const body of [{ scope: 'none' }, { enabled: 'yes' }, {}, [], { maxReadingAgeMs: 5 }]) {
    assert.equal((await routes.put(body)).code, 400);
  }
  assert.equal(fs.readFileSync(routes.file, 'utf8'), '{"weeklyPercent":90}');
  assert.deepEqual(fs.readdirSync(path.dirname(routes.file)).filter(name => name.endsWith('.tmp')), []);
});

test('environment precedence is reported while saved values remain intact', async t => {
  const routes = await mount(t, { MULTICC_QUOTA_GUARD_WEEKLY_PERCENT: '80' });
  const res = await routes.put({ weeklyPercent: 95, scope: ' ALL ', maxReadingAgeMs: '600000.9' });
  assert.equal(res.code, 200);
  assert.equal(res.payload.saved.weeklyPercent, 95);
  assert.equal(res.payload.config.weeklyPercent, 80);
  assert.equal(res.payload.config.scope, 'all');
  assert.equal(res.payload.config.maxReadingAgeMs, 600000);
  assert.deepEqual(res.payload.envOverrides, ['weeklyPercent']);
});

test('the native host rereads saved thresholds after five seconds', async t => {
  const routes = await mount(t);
  let clock = NOW;
  const cache = { get: () => ({ fetchedAt: clock, summary: { windows: [{ window: '5h', usedPercent: 60, resetMs: clock + 3600000 }] } }) };
  const guard = createQuotaGuard({ cache, configFile: routes.file, env: {}, now: () => clock });
  const check = () => guard.check({ providerId: 'claude-official-abc' });
  assert.equal(check().blocked, false);
  await routes.put({ fiveHourPercent: 50 });
  assert.equal(check().blocked, false, 'cached config remains effective until the interval elapses');
  clock += 5000;
  assert.equal(check().blocked, true);
  assert.equal(check().threshold, 50);
  fs.writeFileSync(routes.file, '{broken');
  clock += 5000;
  assert.equal(check().blocked, false, 'malformed settings revert to defaults');
  assert.deepEqual((await routes.get()).payload.saved, {});
});

test('ETag/304 and a write failure remain native responses', async t => {
  const routes = await mount(t);
  const first = await routes.get();
  const cached = await routes.call('GET', undefined, { 'If-None-Match': first.response.headers.get('etag'), 'Cache-Control': 'max-age=0' });
  assert.equal(cached.code, 304);
  fs.mkdirSync(routes.file);
  const failure = await routes.put({ enabled: false });
  assert.equal(failure.code, 500);
  assert.match(failure.payload.error, /^写入失败：/);
  assert.deepEqual(fs.readdirSync(path.dirname(routes.file)).filter(name => name.endsWith('.tmp')), []);
  routes.noNode();
});
