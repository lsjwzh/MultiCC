'use strict';

// mbrowser × MultiCC isolation plugins: discovery (which environments, which
// accounts, which sites each has been used for), routing a site to the
// environment that holds it, and the read-only page bridge. A fake MultiCC
// plugin API and fake History/Cookies databases stand in for the real ones;
// nothing here reaches a real browser, plugin or server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MBROWSER = path.join(ROOT, 'skills', 'multicc-browser', 'bin', 'mbrowser');
const I = require(path.join(ROOT, 'skills', 'multicc-browser', 'lib', 'isolation'));

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { /* skipped below */ }

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-iso-'));
process.on('exit', () => { try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
const DATA_ROOT = path.join(TEMP, 'plugins-data');
const PLUGIN = 'iso-plugin';

function profileDir(id) {
  return path.join(DATA_ROOT, PLUGIN, 'chrome-profiles', id);
}

// Chrome's own tables, cut down to the columns mbrowser reads.
function seedProfile(id, { visits = {}, cookies = [] }) {
  const dir = path.join(profileDir(id), 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const history = new sqlite.DatabaseSync(path.join(dir, 'History'));
  history.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER)');
  for (const [url, count] of Object.entries(visits)) {
    history.prepare('INSERT INTO urls (url, visit_count) VALUES (?, ?)').run(url, count);
  }
  history.close();
  const jar = new sqlite.DatabaseSync(path.join(dir, 'Cookies'));
  jar.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB)');
  for (const host of cookies) jar.prepare('INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)').run(host, 'c', Buffer.from('secret'));
  jar.close();
}

function createFakeMultiCC() {
  const state = {
    profiles: [
      { id: 'shop', name: 'shop@example.test', note: 'US store', egressText: 'node A', egressType: 'subscription',
        running: true, pid: 999999, createdAt: 10, updatedAt: 11, subscription: { id: 'sub', node: 'A' } },
      { id: 'other', name: 'other@example.test', note: '', egressText: 'node B', egressType: 'direct',
        running: false, createdAt: 20, updatedAt: 21 },
    ],
    subscriptions: [{ id: 'sub', name: 'S', url: 'https://sub.invalid', nodes: [], updatedAt: 5, sourceBytes: 77 }],
    reads: [],
    launches: [],
  };
  const answer = (command, input) => {
    if (command === 'list') return { profiles: state.profiles, subscriptions: state.subscriptions };
    if (command === 'launch') {
      state.launches.push(input);
      const profile = state.profiles.find(item => item.id === input.id);
      profile.running = true;
      return { ok: true, id: input.id };
    }
    if (command === 'browser-read') {
      state.reads.push(input);
      const profile = state.profiles.find(item => item.id === input.profileId);
      const expected = { profileCreatedAt: profile.createdAt, profileUpdatedAt: profile.updatedAt,
        subscription: profile.subscription ? { id: 'sub', updatedAt: 5, sourceBytes: 77 } : null, confidence: 'public_metadata' };
      if (JSON.stringify(input.sourceRevision) !== JSON.stringify(expected)) return { error: '实例配置或读取协议已变化' };
      if (!Array.isArray(input.origins) || !input.origins.length) return { error: '实例页面读取失败，请重新检查' };
      const base = { available: true, protocol: input.protocol, requestId: input.requestId, profileId: input.profileId,
        sourceRevision: input.sourceRevision, action: input.action, instanceId: 'inst-1' };
      if (input.action === 'status') return { ...base, state: 'ready' };
      if (input.action === 'open-page') return { ...base, targetId: 'AAAABBBBCCCCDDDD' };
      if (input.action === 'pages') {
        return { ...base, pages: [{ targetId: 'AAAABBBBCCCCDDDD', title: 'Shop', url: 'https://seller.shop.example/a', origin: 'https://seller.shop.example' }] };
      }
      if (input.action === 'read-page') {
        return { ...base, page: { targetId: input.targetId, title: 'Shop', url: 'https://seller.shop.example/a', text: 'Hello shop', truncated: false } };
      }
    }
    return { error: `unexpected ${command}` };
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let payload;
      if (request.method === 'GET' && request.url === '/api/plugins') {
        payload = { plugins: [
          { id: PLUGIN, name: 'Isolation', version: '1', commands: ['list', 'launch', 'stop', 'browser-read', 'browser-read-capabilities'] },
          { id: 'unrelated', name: 'Other', version: '1', commands: ['status'] },
        ] };
      } else {
        const match = /^\/api\/plugins\/([^/]+)\/run$/.exec(request.url);
        const parsed = JSON.parse(body || '{}');
        payload = match && match[1] === PLUGIN ? answer(parsed.command, parsed.input) : { error: 'no such plugin' };
      }
      response.writeHead(payload.error ? 500 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => server.close(done)),
  })));
}

function run(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [MBROWSER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('names, sites and refs are parsed the way routing needs', () => {
  assert.equal(I.siteOf('.seller.shop.example'), 'shop.example');
  assert.equal(I.siteOf('www.amazon.co.uk'), 'amazon.co.uk');
  assert.equal(I.siteOf('127.0.0.1'), '127.0.0.1');
  assert.equal(I.hostOf('https://Seller.Shop.example/x?y=1'), 'seller.shop.example');
  assert.equal(I.hostOf('shop.example'), 'shop.example');
  assert.equal(I.hostOf('file:///etc/passwd'), null);
  assert.deepEqual(I.parseIsoRef('iso:shop'), { pluginId: null, profileId: 'shop' });
  assert.deepEqual(I.parseIsoRef('iso:iso-plugin/shop'), { pluginId: 'iso-plugin', profileId: 'shop' });
  assert.throws(() => I.parseIsoRef('iso:../x'), error => error.code === 'usage');
  assert.throws(() => I.parseIsoRef('iso:a/b/c'), error => error.code === 'usage');
  assert.match(I.daemonName({ pluginId: PLUGIN, profileId: 'shop' }), /^iso-[0-9a-f]{16}$/);
  assert.notEqual(I.daemonName({ pluginId: PLUGIN, profileId: 'shop' }),
    I.daemonName({ pluginId: 'another-plugin', profileId: 'shop' }));
  assert.match(I.daemonName({ pluginId: PLUGIN, profileId: 'x'.repeat(100) }), /^iso-[0-9a-f]{16}$/);
  assert.equal(I.isIsolationPlugin({ commands: ['list', 'launch', 'browser-read'] }), true);
  assert.equal(I.isIsolationPlugin({ commands: ['list', 'launch'] }), false);
});

test('an environment is driven fully only when its own running process holds a live DevTools port', async t => {
  const dir = fs.mkdtempSync(path.join(TEMP, 'control-'));
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.deepEqual(await I.controlOf({ running: false }, dir), { control: 'stopped' });
  const browserControl = { protocol: 'multicc-browser-control-v1', wsUrl: 'pipe:///tmp/private.sock' };
  assert.deepEqual(await I.controlOf({ running: true, browserControl }, dir),
    { control: 'agent', wsUrl: browserControl.wsUrl }, 'private Agent transport takes priority over stale ports');
  assert.deepEqual(await I.controlOf({ running: false, browserControl }, dir), { control: 'stopped' });
  assert.deepEqual(await I.controlOf({ running: true, pid: process.pid }, dir), { control: 'read' }, 'pipe-only instance');
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/abc\n`);
  fs.symlinkSync(`host-${process.pid}`, path.join(dir, 'SingletonLock'));
  const full = await I.controlOf({ running: true, pid: process.pid }, dir);
  assert.equal(full.control, 'cdp');
  assert.equal(full.wsUrl, `ws://127.0.0.1:${server.address().port}/devtools/browser/abc`);
  assert.equal((await I.controlOf({ running: true, pid: 1 }, dir)).control, 'read', 'a port held by some other process is not this instance');
});

test('routing: one environment that visited the site wins, several are a question, none falls back', () => {
  const envs = [
    { ref: 'iso:a', account: 'a', control: 'read', sites: [{ site: 'shop.example', visits: 4, cookies: 3 }, { site: 'ads.example', visits: 0, cookies: 9 }] },
    { ref: 'iso:b', account: 'b', control: 'cdp', sites: [{ site: 'both.example', visits: 1, cookies: 1 }, { site: 'ads.example', visits: 0, cookies: 2 }] },
    { ref: 'iso:c', account: 'c', control: 'stopped', sites: [{ site: 'both.example', visits: 7, cookies: 1 }] },
    // No readable history: cookies are all there is to go on.
    { ref: 'iso:d', account: 'd', control: 'read', sites: [{ site: 'legacy.example', visits: 0, cookies: 2 }] },
  ];
  const single = I.route('https://seller.shop.example/x', envs);
  assert.equal(single.kind, 'isolation');
  assert.equal(single.choice, 'iso:a');
  assert.equal(I.route('ads.example', envs).kind, 'fallback', 'embedded ad cookies are not a visit');
  const both = I.route('both.example', envs);
  assert.equal(both.kind, 'ambiguous');
  assert.equal(both.choice, null);
  assert.deepEqual(both.candidates.map(c => c.ref), ['iso:c', 'iso:b']);
  assert.equal(I.route('legacy.example', envs).choice, 'iso:d');
  assert.equal(I.route('nowhere.example', envs, { fallback: 'main' }).choice, 'main');
  assert.throws(() => I.route('data:text/plain,x', envs), error => error.code === 'usage');
});

test('envs, route and the read-only bridge through the CLI', { skip: !sqlite && 'node:sqlite unavailable' }, async t => {
  seedProfile('shop', {
    visits: { 'https://seller.shop.example/a': 5, 'https://www.both.example/': 1 },
    cookies: ['.shop.example', '.ads.example', '.ads.example'],
  });
  seedProfile('other', { visits: { 'https://both.example/home': 2 }, cookies: ['.ads.example'] });
  const fake = await createFakeMultiCC();
  t.after(() => fake.close());
  const env = {
    ...process.env,
    MULTICC_BASE_URL: fake.url,
    MBROWSER_ISO_DATA_ROOT: DATA_ROOT,
    MULTICC_DATA_DIR: path.join(TEMP, 'state'),
    MBROWSER_PROFILES_DIR: path.join(TEMP, 'profiles'),
    MBROWSER_MAIN_USER_DATA_DIR: path.join(TEMP, 'main-chrome'),
    MULTICC_CDP_DIR: path.join(TEMP, 'cdpd'),
    MBROWSER_PROFILE: '',
    MULTICC_SESSION_ID: 'iso-session',
  };

  // ---- discovery: only isolation plugins, every identity with its account and sites.
  const listed = JSON.parse((await run(['envs', '--json'], env)).stdout);
  assert.deepEqual(listed.environments.map(e => [e.ref, e.account, e.control]),
    [['iso:shop', 'shop@example.test', 'read'], ['iso:other', 'other@example.test', 'stopped']]);
  const shop = listed.environments[0];
  assert.equal(shop.note, 'US store');
  assert.equal(shop.egress, 'node A');
  assert.deepEqual(shop.sites.find(s => s.site === 'shop.example'), { site: 'shop.example', visits: 5, cookies: 1 });
  assert.deepEqual(shop.sites.find(s => s.site === 'ads.example'), { site: 'ads.example', visits: 0, cookies: 2 });
  assert.equal('sourceRevision' in shop, false, 'internal bridge metadata is not part of the listing');
  const text = (await run(['envs'], env)).stdout;
  assert.match(text, /iso:shop {2}account: shop@example\.test \(US store\)/);
  assert.match(text, /read-only/);
  assert.match((await run(['envs', 'both.example'], env)).stdout, /iso:other/);

  // ---- route
  const routed = JSON.parse((await run(['route', 'https://seller.shop.example/a', '--json'], env)).stdout);
  assert.equal(routed.choice, 'iso:shop');
  const ambiguous = await run(['route', 'both.example'], env);
  assert.match(ambiguous.stdout, /ask the user which account/);
  assert.match(JSON.parse((await run(['route', 'ads.example', '--json'], env)).stdout).choice, /^main$/);

  // ---- an unqualified open is routed to the environment, and the session sticks to it.
  const opened = await run(['open', 'https://seller.shop.example/a'], env);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /routed to iso:shop \(shop@example\.test\)/);
  assert.match(opened.stdout, /read-only environment/);
  const openRead = fake.state.reads.find(read => read.action === 'open-page');
  assert.equal(openRead.url, 'https://seller.shop.example/a');
  assert.deepEqual(openRead.origins, ['https://seller.shop.example']);
  assert.equal(openRead.expectedInstanceId, 'inst-1');
  assert.equal(openRead.protocol, 'multicc-browser-read-v1');
  assert.match(openRead.requestId, /^[0-9a-f-]{36}$/);

  const read = await run(['text'], env);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout.trim(), 'Hello shop');
  assert.equal(fake.state.reads.at(-1).targetId, 'AAAABBBBCCCCDDDD');
  assert.match((await run(['snapshot'], env)).stdout, /^page: Shop — https:\/\/seller\.shop\.example\/a {2}\[iso:shop, read-only/);
  assert.match((await run(['tabs'], env)).stdout, /AAAABBBB \* Shop/);

  const click = await run(['click', 'e1'], env);
  assert.equal(click.status, 1);
  assert.match(click.stderr, /iso_read_only/);
  assert.match(click.stderr, /Do not redo it in the everyday Chrome/);

  const query = await run(['open', 'https://seller.shop.example/a?q=1', '-p', 'iso:shop'], env);
  assert.match(query.stderr, /iso_url_rejected/);

  // ---- two environments used the site: a question, not a guess.
  const both = await run(['open', 'https://both.example/'], env);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /route_ambiguous/);
  assert.match(both.stderr, /-p iso:shop/);
  assert.match(both.stderr, /-p iso:other/);

  // ---- a stopped environment is never launched as a side effect.
  const stopped = await run(['open', 'https://both.example/', '-p', 'iso:other'], env);
  assert.match(stopped.stderr, /iso_not_running/);
  assert.equal(fake.state.launches.length, 0);
  const started = await run(['start', 'iso:other', 'https://both.example/'], env);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(fake.state.launches, [{ id: 'other', url: 'https://both.example/' }]);

  assert.equal((await run(['tag', 'iso:shop', '--domain', 'x.example'], env)).status, 2);
  assert.equal((await run(['open', 'x.example', '-p', 'iso:nope'], env)).status, 1);

  // ---- no MultiCC server: an unqualified open is simply not routed.
  const offline = await run(['route', 'shop.example'], { ...env, MULTICC_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /multicc_unavailable/);
});
