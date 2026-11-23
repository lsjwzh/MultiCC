'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, token } = require('./production-entry');

async function sample(dir, gateway, addon, host) {
  const data = path.join(dir, 'data');
  const write = (file, value) => fs.writeFileSync(path.join(data, file), JSON.stringify(value));
  const read = file => JSON.parse(fs.readFileSync(path.join(data, file)));
  fs.mkdirSync(data, { recursive: true });
  const fake = 'fixture-only-demo-credential';
  const claude = { id: 'a', name: 'Claude relay', appType: 'claude', settingsConfig: { env: {
    ANTHROPIC_BASE_URL: 'https://relay.invalid', ANTHROPIC_AUTH_TOKEN: fake,
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'alternate', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Alias',
  } } };
  const codex = { id: 'b', name: 'Codex relay', appType: 'codex', settingsConfig: {
    auth: { OPENAI_API_KEY: fake }, config: 'model = "main"\nbase_url = "https://relay.invalid/v1"\nwire_api = "chat_completions"',
    modelCatalog: { models: [{ model: 'extra' }] },
  } };
  write('providers.json', { providers: [claude, codex,
    { ...codex, id: 'no-key', settingsConfig: { ...codex.settingsConfig, auth: {} } },
    { ...codex, id: 'loop', settingsConfig: { ...codex.settingsConfig, config: 'base_url = "http://localhost:1234"' } }] });
  const accountDir = path.join(dir, 'home', '.multicc', 'official-accounts', 'claude');
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, '0123456789abcdef.json'),
    JSON.stringify({ label: '测试账号', access_token: 'fixture-only', email: 'fixture@example.invalid' }));
  const at = 1700000000000;
  write('provider-limit-cache.json', { __multiccSchema: { kind: 'provider-limit-cache', schemaVersion: 1 }, data: { entries: { 'codex:b': {
    appType: 'codex', providerId: 'b', kind: 'balance', status: 'ok',
    summary: { kind: 'balance', available: true, total: 12.5, currency: 'CNY' },
    summaryText: '¥12.50', fetchedAt: at, updatedAt: at, lastError: null, lastErrorAt: null,
  } }, updatedAt: at } });
  write('provider-defaults.json', { claude: 'a', codex: 'b' });
  write('aux-config.json', { cli: 'codex', providerId: 'b', model: '  extra  ' });
  write('token_daily.json', { '2024-02-29': { a: { inputTokens: 30, cacheReadTokens: 12, outputTokens: 4, turnCount: 2 } } });
  const checks = {};
  // Pin executable discovery to disposable, inert locators on both entries.
  const env = { MULTICC_CLAUDE_BIN: process.execPath, CODEX_CMD: process.execPath };
  let server = await start(dir, gateway, addon, host, true, undefined, env);
  const get = async (route, body) => {
    const res = await fetch(server.origin + route, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-access-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return [res.status, await res.json()];
  };
  const template = { name: '计划', enabled: false, dirId: 'dir-fixture', cron: '1 2 3 4 *', prompt: '测试' };
  try {
    for (const query of ['poll=1', 'poll=1&appType=codex', 'poll=1&cli=claude', 'poll=1&cli=unknown']) {
      const [status, catalog] = await get('/api/providers?' + query);
      assert.equal(status, 200);
      assert.ok(!JSON.stringify(catalog).includes(fake));
      assert.equal(catalog.defaults.codex, 'b');
      if (query === 'poll=1') {
        assert.equal(catalog.providers.find(p => p.activeAccountId === '0123456789abcdef').name, 'Claude 账号 · 测试账号');
        assert.equal(catalog.providers.find(p => p.id === 'b').limit.stale, true);
        assert.equal(catalog.providers.find(p => p.id === 'a').aliasMap.sonnet.name, 'Alias');
        assert.equal(catalog.stats.find(p => p.providerId === 'a').totalTokens, 34);
      }
      catalog.ccSwitchStatus.message = catalog.ccSwitchStatus.message.replace(dir, '<deployment>');
      catalog.ccSwitchStatus.dbPath = catalog.ccSwitchStatus.dbPath.replace(dir, '<deployment>');
      checks[query] = catalog;
    }
    const [status, aux] = await get('/api/aux/config');
    assert.equal(status, 200);
    assert.ok(!JSON.stringify(aux).includes(fake));
    assert.equal(aux.protocol, 'openai');
    assert.deepEqual(aux.providersByProtocol.openai.map(p => p.id), ['codex-official', 'b']);
    assert.equal(aux.providersByProtocol.openai[1].wireApi, 'chat_completions');
    assert.equal(aux.providersByProtocol.openai[1].limit.summary.total, 12.5);
    checks.aux = aux;
    for (const route of ['/api/providers?poll=1', '/api/aux/config']) {
      const url = server.origin + route;
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.ok(head.headers.get('etag'));
      const fresh = await fetch(url, { headers: { 'if-none-match': head.headers.get('etag'), 'cache-control': 'max-age=0' } });
      assert.equal(fresh.status, 304);
      checks['conditional ' + route] = fresh.status;
    }
    checks.legacyConfig = read('aux-config.json');
    assert.deepEqual(checks.legacyConfig, { protocol: 'openai', providerId: 'b', model: 'extra' });
    const invalid = [{}, { dirId: 'missing' }, { cli: 'unknown' }, { prompt: '  ' }, { cron: '* * *' }, { kind: 'script' }];
    for (const [i, overrides] of invalid.entries()) {
      const row = await get('/api/cron', i ? { ...template, ...overrides } : {});
      assert.equal(row[0], 400);
      checks['invalid-' + i] = row;
    }
    const [created, agent] = await get('/api/cron', { ...template, dirPath: path.join(dir, 'repo'), dirId: '' });
    assert.equal(created, 200);
    assert.ok(agent.taskId && agent.lastSessionId && agent.id.startsWith('cron_'));
    assert.equal(agent.runCount, 0);
    checks.agent = { ...agent, id: '<id>', createdAt: '<created>', taskId: '<task>', taskUrl: '<url>', lastSessionId: '<session>' };
    const scripts = await Promise.all(['script1', 'script2'].map(name => get('/api/cron', { ...template, name, kind: 'script',
      command: '  echo fixture  ', scriptTimeoutMs: 9000000 })));
    for (const [code, script] of scripts) {
      assert.equal(code, 200);
      assert.equal(script.taskId, null);
      assert.equal(script.scriptTimeoutMs, 3600000);
      checks[script.name] = { ...script, id: '<id>', createdAt: '<created>' };
    }
    const ids = [agent, ...scripts.map(row => row[1])].map(row => row.id).sort();
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(read('scheduled_tasks.json').map(row => row.id).sort(), ids);
    await server.stop();
    server = null;
    server = await start(dir, gateway, addon, host, false, undefined, env);
    const [listStatus, list] = await get('/api/cron');
    assert.equal(listStatus, 200);
    assert.deepEqual(list.map(row => row.id).sort(), ids);
    const restored = list.find(row => row.id === agent.id);
    assert.equal(restored.taskId, agent.taskId);
    assert.equal(restored.lastSessionId, agent.lastSessionId);
    assert.deepEqual(list.map(row => row.runCount), [0, 0, 0]);
    checks.restart = [list.length, restored.taskBindingBroken];
    const [auxStatus, restoredAux] = await get('/api/aux/config');
    assert.equal(auxStatus, 200);
    assert.deepEqual(restoredAux, aux);
    checks.auxRestart = true;
    if (!host) {
      // Fail after reserving an identity, then retry the identical request.
      const board = path.join(data, 'task_board.json');
      fs.renameSync(board, board + '.original');
      fs.writeFileSync(board, JSON.stringify({ schemaVersion: 999 }));
      const retry = { ...template, name: '重试创建' };
      let failed;
      try { failed = await get('/api/cron', retry); } finally {
        fs.unlinkSync(board);
        fs.renameSync(board + '.original', board);
      }
      assert.equal(failed[0], 500);
      assert.equal(read('scheduled_tasks.json').length, 3);
      const reservationDir = path.join(data, '.cron-create');
      const [reservation] = fs.readdirSync(reservationDir);
      const pending = JSON.parse(fs.readFileSync(path.join(reservationDir, reservation)));
      const [code, retried] = await get('/api/cron', retry);
      assert.equal(code, 200);
      assert.equal(retried.id, pending.id);
      assert.equal(read('scheduled_tasks.json').length, 4);
      assert.equal(fs.readdirSync(reservationDir).length, 0);
      console.log('PASS Rust interrupted bind and retry');
    }
  } finally { if (server) await server.stop(); }
  return checks;
}

(async () => {
  const [gateway, addon] = process.argv.slice(2).map(p => path.resolve(p));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-catalog-cron-'));
  try {
    const oracle = await sample(path.join(temp, 'reference'), gateway, addon, true);
    const rust = await sample(path.join(temp, 'rust'), gateway, addon, false);
    for (const key of Object.keys(oracle)) {
      assert.deepEqual(rust[key], oracle[key], key);
      console.log('PASS', key);
    }
    console.log(JSON.stringify({ equal: Object.keys(oracle).length }));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
