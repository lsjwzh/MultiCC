'use strict';

// Compare one empty, authenticated deployment per runtime. Capture only HTTP
// status, public error codes and equality; runtime payloads need not be saved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '../../..');
const token = 'ephemeral-contract-test-token';
const paths = [
  '/healthz', '/readyz', '/manage', '/chat.html', '/api/claude/models',
  '/api/settings/access-token', '/api/host/battery', '/api/settings/notify',
  '/api/push/health', '/api/push/vapid-key', '/api/push/bark-devices',
  '/api/settings/power', '/metrics', '/api/server-info', '/api/directories',
  '/api/sessions', '/api/task-board/search?q=fixture', '/api/docs-registry', '/api/cron', '/api/channels',
  '/api/machines', '/api/share/unknown/entry', '/api/repo-operations/unknown',
];

async function start(dir, gateway, addon, fixture, seeded = false, upgradedBoard, deployment = {}) {
  for (const part of ['data', 'home', 'package']) fs.mkdirSync(path.join(dir, part), { recursive: true });
  const cwd = path.join(dir, 'package');
  for (const name of ['public', 'package.json']) {
    if (!fs.existsSync(path.join(cwd, name))) {
      fs.symlinkSync(path.join(root, name), path.join(cwd, name), name === 'public' ? 'dir' : 'file');
    }
  }
  if (fixture) {
    // server.js reads .env relative to __dirname. Give the oracle its own
    // entry file so a developer checkout's keys never enter the experiment.
    fs.copyFileSync(path.join(root, 'server.js'), path.join(cwd, 'server.js'));
    for (const name of ['src', 'plugins', 'node_modules', 'scripts', 'skills', 'native']) {
      if (!fs.existsSync(path.join(cwd, name))) fs.symlinkSync(path.join(root, name), path.join(cwd, name), 'dir');
    }
  }
  const env = { ...require(path.join(root, 'tests/helpers/isolated-host-env'))(),
    HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), HOST: '127.0.0.1',
    MULTICC_DATA_DIR: path.join(dir, 'data'), MULTICC_ENV_FILE: path.join(cwd, '.env'),
    MULTICC_RUST_ADDON: addon, NODE_ENV: 'test', ACCESS_TOKEN: token, ASR_LOCAL: 'off', ...deployment,
  };
  if (seeded) {
    const seed = (name, value) => fs.writeFileSync(path.join(dir, 'data', name), JSON.stringify(value), { mode: 0o600 });
    env.BARK_URL = 'https://old.example.invalid/demo-private-path';
    env.WEBHOOK_URL = 'https://hooks.example.invalid/demo-private-path';
    env.MULTICC_AGENT_DIR = path.join(dir, 'agent');
    fs.mkdirSync(env.MULTICC_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.MULTICC_AGENT_DIR, 'power-settings.json'), JSON.stringify({ autoUnlock: true }));
    const storeDir = path.join(dir, 'data');
    fs.mkdirSync(path.join(storeDir, 'artifacts', 'published'), { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'artifacts', 'published', 'index.html'), '<img src="../nested/image.png">');
    seed('docs_registry.json', [
      { id: 'plain', title: 'Missing dependency', url: '/artifacts/nested/image.png', createdAt: '2025-01-02', sessionId: 'task-fixture' },
      { id: 'publication', title: 'Pinned before upgrade', url: '/artifacts/published/', pinned: true, createdAt: '2025-01-01' },
    ]);
    const boardTasks = {
      'tsk-alpha': { title: '缓存 Search', status: 'active', dirId: 'dir-fixture', updatedAt: 994, areas: ['工具'], description: '📎 缓存 ＳＥＡＲＣＨ' },
      'tsk-beta': { title: '另一个', status: 'done', dirId: 'dir-fixture', refs: [{ sessionId: 'task-fixture', excerpt: 'search' }] },
      'tsk-deleted': { title: 'Search', dirId: 'dir-fixture' },
    };
    seed('task_board.json', upgradedBoard || { schemaVersion: 2, revision: 2, tasks: boardTasks, deletedTaskIds: ['tsk-deleted'] });
    seed('bark-devices.json', { version: 1, legacy: { enabled: false }, devices: [
      { id: 'fixture-bark', url: 'https://device.example.invalid/demo-private-path', name: '测试手机', enabled: true },
    ] });
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env });
    git('init', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
      'commit', '--allow-empty', '-m', 'fixture');
    git('remote', 'add', 'origin', 'https://example.invalid/unused');
    fs.writeFileSync(path.join(repo, 'untracked'), '');
    seed('directories.json', [{ id: 'dir-fixture', name: 'Fixture', path: repo, baseBranch: 'main' }]);
    seed('sessions.json', [{ id: 'task-fixture', dirId: 'dir-fixture', kind: 'chat', cli: 'claude', label: '会话' }]);
    seed('push_subscriptions.json', [{ endpoint: 'https://push.example.invalid/original' }]);
    const { scryptSync } = require('node:crypto');
    const share = { token: 'seed-share', access: 'view', type: 'messages', messages: [{ role: 'user', content: 'fixture' }],
      salt: 'fixture-salt', pwHash: scryptSync('demo-password', 'fixture-salt', 32).toString('hex'), secret: 'fixture-share-secret' };
    seed('shares.json', { 'seed-share': share, expired: { ...share, token: 'expired', expiresAt: 1 },
      conversation: { token: 'conversation', access: 'view', sessionId: 'task-fixture' } });
    seed('machines.json', { version: 1, id: 'machine_fixture', name: '测试电脑', peers: [], grants: [] });
  }
  const args = fixture ? ['--node', process.execPath, path.join(cwd, 'server.js')] : [];
  const child = spawn(gateway, ['serve', '--ephemeral-loopback', '--stdin-lifeline', '--cwd', cwd, ...args],
    { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
  const closed = once(child, 'close');
  let output = '';
  child.stderr.on('data', bytes => { output += bytes; });
  const stop = async () => {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    try { await closed; } finally { clearTimeout(timeout); }
  };
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && child.exitCode === null && !child.signalCode) {
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (port) {
        const origin = 'http://127.0.0.1:' + port;
        try {
          const reply = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1000) });
          await reply.arrayBuffer();
          if (reply.ok) return { origin, stop };
        } catch {}
      }
      await delay(80);
    }
    throw Error('isolated ' + (fixture ? 'reference' : 'Rust') + ' entry did not become ready');
  } catch (error) {
    await stop();
    throw error;
  }
}

async function sample(dir, gateway, addon, fixture) {
  const server = await start(dir, gateway, addon, fixture);
  try {
    const responses = [];
    for (const route of paths) {
      const response = await fetch(server.origin + route, { redirect: 'manual',
        headers: { 'x-access-token': token, 'x-request-id': 'entry-test', 'x-correlation-id': 'entry-test' },
        signal: AbortSignal.timeout(8000) });
      const body = await response.text();
      let code;
      try { code = JSON.parse(body)?.code; } catch {}
      responses.push({ status: response.status, body, code });
    }
    return responses;
  } finally { await server.stop(); }
}

async function contracts(dir, gateway, addon, fixture, upgradedBoard) {
  let server = await start(dir, gateway, addon, fixture, true, upgradedBoard);
  const passed = [];
  async function request(route, status, options = {}) {
    const response = await fetch(server.origin + route, { ...options, signal: AbortSignal.timeout(5000),
      headers: { 'x-request-id': 'seed', 'x-correlation-id': 'seed', ...options.headers } });
    assert.equal(response.status, status, route);
    return response;
  }
  try {
    const remote = { 'x-forwarded-for': '192.0.2.11' };
    const key = '/api/settings/access-token';
    assert.equal((await (await request(key, 403, { headers: remote })).json()).code, 'AUTH_REQUIRED');
    passed.push('remote authentication');
    assert.deepEqual(await (await request(key, 200, { headers: { ...remote, 'x-access-token': token } })).json(),
      { hasToken: true, masked: '****oken', canEdit: false });
    passed.push('remote masked token and locality');
    const devices = await (await request('/api/push/bark-devices', 200)).json();
    assert.deepEqual(devices.devices, [
      { id: 'legacy', name: '原有手机', enabled: false, legacy: true, origin: 'https://old.example.invalid' },
      { id: 'fixture-bark', name: '测试手机', enabled: true, legacy: false, origin: 'https://device.example.invalid' },
    ]);
    passed.push('persisted and legacy Bark devices');
    const notify = await (await request('/api/settings/notify', 200)).json();
    assert.deepEqual(notify, { barkUrl: 'https://old.example.invalid/••••', barkOrigin: 'https://old.example.invalid',
      hasBark: true, barkDevices: devices.devices, webhookUrl: 'https://hooks.example.invalid/••••',
      webhookOrigin: 'https://hooks.example.invalid', hasWebhook: true });
    passed.push('notification configuration and URL masking');
    const battery = await (await request('/api/host/battery', 200)).json();
    assert.equal(typeof battery.available, 'boolean');
    if (battery.available) {
      assert.ok(battery.percent >= 0 && battery.percent <= 100);
      assert.equal(typeof battery.charging, 'boolean');
      assert.equal(typeof battery.pluggedIn, 'boolean');
    }
    passed.push('battery telemetry shape');
    const power = await (await request('/api/settings/power', 200)).json();
    if (process.platform === 'darwin') {
      assert.equal(power.available, true);
      assert.equal(typeof power.enabled, 'boolean');
      assert.equal(typeof power.systemSleepDisabled, 'boolean');
      assert.equal(typeof power.batteryGuard.running, 'boolean');
      assert.equal(power.unlockPassword.canEdit, true);
      if (power.unlockPassword.error) assert.equal(power.unlockPassword.error, 'read-failed');
      else assert.equal(power.unlockPassword.requested, true);
      const readOnly = await (await request('/api/settings/power', 200, { headers: { ...remote, 'x-access-token': token } })).json();
      assert.equal(readOnly.unlockPassword.canEdit, false);
    } else assert.deepEqual(power, { available: false, enabled: false });
    passed.push('system power observation, stored intent and local edit permission');
    const info = await (await request('/api/server-info', 200)).json();
    assert.equal(info.product, 'multicc');
    assert.equal(info.version, require(path.join(root, 'package.json')).version);
    assert.equal(info.authRequired, true);
    assert.ok(typeof info.uptimeMs === 'number' && info.uptimeMs >= 0 && Number.isFinite(Date.parse(info.startedAt)));
    if (!fixture) assert.equal(info.port, Number(new URL(server.origin).port));
    passed.push('server identity, listener and uptime');
    const machines = await request('/api/machines', 200);
    assert.equal(machines.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await machines.json()).self, { id: 'machine_fixture', name: '测试电脑', local: true, protocol: 1 });
    passed.push('stored machine identity');
    assert.deepEqual(await (await request('/api/machines/grants', 200)).json(), { grants: [] });
    passed.push('grant listing');
    await request('/api/machines/self', 403, { headers: { 'sec-fetch-site': 'cross-site' } });
    passed.push('cross-site refusal');
    await request('/api/machines/self', 200, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '新名称' }) });
    assert.equal((await (await request('/api/machines/self', 200)).json()).name, '新名称');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'machines.json'))).name, '新名称');
    passed.push('rename persisted and visible on reread');
    const cards = await (await request('/api/directories', 200)).json();
    const card = cards.find(item => item.id === 'dir-fixture');
    assert.equal(card.counts.claude_chat, 1);
    assert.deepEqual(card.pushState, { available: true, hasRemote: true, branch: 'main', remote: 'origin',
      remoteBranch: 'main', upstream: null, upstreamConfigured: false, remoteBranchExists: false,
      ahead: 1, behind: 0, dirty: 1 });
    passed.push('stored directory, session count, local git refs and dirty tree');
    const docs = await (await request('/api/docs-registry', 200)).json();
    assert.deepEqual(docs.map(item => [item.id, item.permanent, item.retained, item.expired]), [
      ['publication', true, true, false], ['plain', false, true, true],
    ]);
    assert.equal(docs[1].dir, path.join(dir, 'repo'));
    assert.deepEqual((await (await request('/api/docs-registry?dir=' + encodeURIComponent(path.join(dir, 'repo')), 200)).json()).map(e => e.id), ['plain']);
    passed.push('legacy pin, transitive artifact, expiration and session directory');
    const board = await (await request('/api/task-board/search?q=search', 200)).json();
    assert.deepEqual(board.results.map(hit => hit.taskId), ['tsk-alpha', 'tsk-beta']);
    const filtered = await (await request('/api/task-board/search?q=缓存&dirId=dir-fixture&statuses=active&limit=1', 200)).json();
    assert.deepEqual(filtered.results.map(hit => hit.taskId), ['tsk-alpha']);
    assert.deepEqual(filtered.results[0].snippet, { text: '📎 缓存 ＳＥＡＲＣＨ', ranges: [[3, 5]] });
    assert.deepEqual((await (await request('/api/task-board/search?q=search&minScore=999', 200)).json()).results, []);
    passed.push('board ranking, deletion, filters, UTF-16 snippet');
    // Compare scores, field order, normalized matches and all displayed values across engines.
    const metrics = await request('/metrics', 200);
    assert.match(metrics.headers.get('content-type'), /version=0\.0\.4/);
    const table = await metrics.text();
    for (const name of ['ready', 'ws_clients', 'active_turns', 'git_queue_depth']) {
      assert.ok(table.split('\n').some(line => line === 'multicc_' + name + ' ' + (name === 'ready' ? '1' : '0')), name);
    }
    assert.deepEqual(await (await request('/api/repo-operations/unknown', 404)).json(), { error: 'operation not found' });
    passed.push('authenticated Prometheus gauges and unknown operation');
    const compared = [board, filtered];
    const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sharePath = '/api/share/seed-share';
    assert.deepEqual(await (await request(sharePath + '/entry', 401)).json(), { needPassword: true });
    await request(sharePath + '/auth', 403, post({ password: 'bad' }));
    const login = await request(sharePath + '/auth', 200, post({ password: 'demo-password' }));
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/);
    const { createHmac } = require('node:crypto');
    assert.equal(cookie.split(';')[0], 'multicc_share_seed-share=' +
      createHmac('sha256', 'fixture-share-secret').update('seed-share').digest('hex'));
    assert.deepEqual(await (await request(sharePath + '/entry', 200, { headers: { cookie: cookie.split(';')[0] } })).json(),
      { access: 'view', type: 'messages', label: '消息分享', messages: [{ role: 'user', content: 'fixture' }] });
    passed.push('share password, scoped cookie and saved snapshot');
    assert.equal((await (await request('/api/share/conversation/entry', 200)).json()).label, '会话');
    await request('/api/share/expired/entry', 404);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'shares.json'))).expired, undefined);
    passed.push('live share session and expired record cleanup');
    const subscription = { endpoint: 'https://push.example.invalid/new', keys: { auth: 'test' } };
    await request('/api/push/validate', 400, post({}));
    await request('/api/push/subscribe', 400, post({}));
    await request('/api/push/subscribe', 200, post(subscription));
    await request('/api/push/subscribe', 200, post({ ...subscription, keys: { auth: 'replacement' } }));
    assert.deepEqual(await (await request('/api/push/validate', 200, post(subscription))).json(), { known: true });
    const health = await (await request('/api/push/health', 200)).json();
    assert.equal(health.subscriptionCount, 2);
    assert.equal(health.bark.configured, true);
    assert.equal(health.webhook.configured, true);
    assert.equal(health.global.totalSent, 0);
    assert.ok(!JSON.stringify(health).includes('push.example.invalid'));
    passed.push('subscription replacement, validation and health redaction');
    const vapid = await (await request('/api/push/vapid-key', 200)).json();
    assert.deepEqual(Object.keys(vapid), ['publicKey']);
    const envFile = path.join(dir, 'package', '.env');
    const privateKey = /^VAPID_PRIVATE_KEY=(.+)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1];
    const ec = require('node:crypto').createECDH('prime256v1');
    ec.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    assert.ok(ec.getPublicKey().equals(Buffer.from(vapid.publicKey, 'base64url')), 'persisted VAPID pair');
    if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o077, 0);
    const settingsPath = '/api/settings/notify';
    const originalConfig = fs.readFileSync(envFile, 'utf8');
    await request(settingsPath, 200, post({ barkUrl: notify.barkUrl, webhookUrl: notify.webhookUrl }));
    assert.equal(fs.readFileSync(envFile, 'utf8'), originalConfig);
    await request(settingsPath, 400, post({ barkUrl: '', webhookUrl: 'invalid' }));
    assert.equal(fs.readFileSync(envFile, 'utf8'), originalConfig);
    const target = 'https://updated.example.invalid/fixture-only';
    assert.deepEqual(await (await request(settingsPath, 200, post({ webhookUrl: target, barkUrl: '' }))).json(), { ok: true });
    assert.equal((await (await request(settingsPath, 200)).json()).webhookUrl, 'https://updated.example.invalid/••••');
    assert.deepEqual((await (await request('/api/push/bark-devices', 200)).json()).devices.map(d => d.id), ['fixture-bark']);
    assert.ok(fs.readFileSync(envFile, 'utf8').split('\n').includes('WEBHOOK_URL=' + target));
    passed.push('notification write is atomic, preserves masked values and updates live device configuration');
    await server.stop();
    server = await start(dir, gateway, addon, fixture);
    assert.equal((await (await request('/api/settings/notify', 200)).json()).webhookOrigin, 'https://updated.example.invalid');
    assert.deepEqual(await (await request('/api/push/vapid-key', 200)).json(), vapid);
    assert.deepEqual(await (await request('/api/push/validate', 200, post(subscription))).json(), { known: true });
    await request('/api/push/subscribe', 200, { ...post(subscription), method: 'DELETE' });
    assert.deepEqual(await (await request('/api/push/validate', 200, post(subscription))).json(), { known: false });
    passed.push('VAPID keypair and subscriptions survive restart; unsubscribe persists');
    return {passed, compared};
  } finally { await server.stop(); }
}

async function main() {
  const [gateway, addon] = process.argv.slice(2).map(file => path.resolve(file));
  if (!gateway || !addon) throw Error('usage: node production-entry.js <gateway> <reference addon>');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-entry-test-'));
  try {
    if (process.argv[4] === '--contracts') {
      const reference = await contracts(path.join(dir, 'reference'), gateway, addon, true);
      // A pre-task-first checkout adds a board row on compatibility-host boot.
      // Compare ranking against the same upgraded corpus. Also run the fresh
      // deployment to expose how adoption affects BM25 document frequencies.
      const upgraded = JSON.parse(fs.readFileSync(path.join(dir, 'reference/data/task_board.json')));
      const rust = await contracts(path.join(dir, 'rust'), gateway, addon, false, upgraded);
      assert.deepEqual(rust, reference);
      const fresh = await contracts(path.join(dir, 'legacy-import'), gateway, addon, false);
      const legacyRankingMatched = JSON.stringify(fresh.compared) === JSON.stringify(reference.compared);
      console.log(JSON.stringify({ reference: reference.passed.length, rust: rust.passed.length,
        passed: rust.passed, samePersistedBoard: true, legacyRankingMatched }, null, 2));
      if (!legacyRankingMatched) process.exitCode = 1;
      return;
    }
    if (process.argv[4] === '--cutover') {
      const probes = [
        ['GET', '/api/settings/notify'], ['POST', '/api/settings/notify'],
        ['POST', '/api/cron'], ['GET', '/api/cron/calendar?month=2026-11'],
        ['GET', '/api/providers'], ['GET', '/api/update/status'],
        ['GET', '/api/aux/config'], ['GET', '/api/secrets'],
        ['GET', '/api/directories'], ['GET', '/api/channels'],
      ];
      async function check(side, fixture) {
        const server = await start(path.join(dir, side), gateway, addon, fixture);
        try {
          const rows = [];
          for (const [method, route] of probes) {
            const res = await fetch(server.origin + route, {
              method, redirect: 'manual', signal: AbortSignal.timeout(8000),
              ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
            });
            const obj = await res.json().catch(() => ({}));
            rows.push({ status: res.status, code: obj.code });
          }
          return rows;
        } finally { await server.stop(); }
      }
      const reference = await check('host', true);
      const rust = await check('default', false);
      const results = probes.map(([method, path], i) => ({ method, path, reference: reference[i], rust: rust[i] }));
      console.log(JSON.stringify(results, null, 2));
      if (results.some(r => r.reference.status !== r.rust.status || r.reference.code !== r.rust.code)) process.exitCode = 1;
      return;
    }
    const before = await sample(path.join(dir, 'reference'), gateway, addon, true);
    const after = await sample(path.join(dir, 'rust'), gateway, addon, false);
    const rows = paths.map((route, i) => ({ route, reference: before[i].status, rust: after[i].status,
      code: after[i].code, identical: before[i].status === after[i].status && before[i].body === after[i].body }));
    console.log(JSON.stringify(rows, null, 2));
    if (rows.some(row => row.reference !== row.rust)) process.exitCode = 1;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { start, token };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 2; });
