'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const account = require('../src/routes/account-routes-host');
const read = require('../src/routes/host-read-host');
const frozen = file => require('./helpers/frozen-file-batch10/' + file);

function app(queryParser) {
  const handlers = new Map();
  function register(verb) {
    return (url, handler) => {
      if (url === 'query parser fn') return queryParser;
      handlers.set(verb + ' ' + url, handler);
    };
  }
  return {
    get: register('GET'), post: register('POST'), patch: register('PATCH'), delete: register('DELETE'),
    async invoke(route, req = {}) {
      const res = { code: 200, status(code) { this.code = code; return this; },
        json(value) { this.value = value; return this; } };
      const returned = await handlers.get(route)(req, res);
      return [res.code, res.value, returned === res];
    },
  };
}

async function compare(oldApi, newApi, exercise) {
  assert.deepStrictEqual(await exercise(newApi), await exercise(oldApi));
}

test('系统端口与冻结入口的字段顺序、时钟、git 回退和远端闸门一致', async () => {
  await compare(frozen('system-host'), read, async api => {
    const router = app(), calls = [];
    api.mountSystemHostRoute(router, { fs: { readFileSync() { calls.push('version'); return '{"version":"1.0"}'; } },
      path, rootDir: '/fixture', isLocal: req => req.local, now: () => 123456,
      uptimeSeconds() { assert.equal(this, undefined); return 0.0025; },
      networkInterfaces() { calls.push('interfaces'); return {}; }, getPort: () => 1234,
      authRequired: () => 'y', gitRun: (...args) => { calls.push(args); return 'abcdef'; } });
    const invoke = (op, local = true) => router.invoke('POST /api/__host/system', { local, body: { op } });
    const results = [await invoke('server-info'), await invoke('ls-remote'), await invoke('other')];
    results.push(await router.invoke('POST /api/__host/system', { get body() { throw Error('远端请求读了正文'); } }));
    return [JSON.stringify(results), calls];
  });
});

test('供应商中继与冻结入口的原始请求、查询解析和 Promise 拒绝一致', async () => {
  await compare(frozen('provider-relay-host'), read, async api => {
    const events = [], router = app(query => { events.push(query); return { query }; });
    api.mountProviderRelayHostRoute(router, { isLocal: req => req.local,
      authRuntime: { admitGatewayRequest(req) { assert.equal(req.socket, req.connection); events.push(Object.keys(req)); return req; } },
      modelCatalogRuntime: { async sourceCatalogFacts(type, id, opts) { if (id === 0) throw Error('raw'); return [type, id, opts]; } } });
    const results = [];
    for (const body of [{ op: 'admission', request: { originalUrl: '/x?a=b?c', method: 'GET', peer: '::1' } },
      { op: 'catalogFacts', id: 1, refresh: true }, { op: 'catalogFacts', id: 0 }, { op: '' }]) {
      results.push(await router.invoke('POST /api/__host/provider-relay', { local: true, body }));
    }
    results.push(await router.invoke('POST /api/__host/provider-relay', { get body() { throw Error('远端请求读了正文'); } }));
    return [results, events];
  });
});

test('Command Code 状态保留文件选择、去控制字符和 UTF-16 截断', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.commandcode'));
  fs.writeFileSync(path.join(home, '.commandcode/auth.local.json'), JSON.stringify({
    apiKey: 'fixture', userName: 'a'.repeat(119) + '\x01😀', privateField: 'omit',
  }));
  await compare(frozen('commandcode-auth'), account, api =>
    [undefined, 'local', 'staging', 'constructor'].map(mode => api.readCommandcodeLogin({
      home, env: { COMMANDCODE_API_ENV: mode, COMMAND_CODE_API_KEY: '  ' },
    })));
});

test('Codex 登录与冻结入口的目录选择、清理顺序及返回对象一致', async () => {
  await compare(frozen('codex-oauth'), account, async api => {
    const events = [], answers = [];
    for (const entries of [[], [{ id: 'first' }], [{ id: 'first' }, { id: 'path', path: '/x' }]]) {
      const open = api.createLoginSessionOpener({ directories: entries, disposeLoginTerminal: async flow => events.push(flow),
        createSessionRecord: async record => { events.push(JSON.stringify(record)); return { ok: true, id: record.dir.id, reused: 1 }; } });
      answers.push(await open());
    }
    return [events, answers];
  });
});

test('Agy 登录与冻结入口的代理环境和终端会话投影一致', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await compare(frozen('agy-accounts'), account, async api => {
    const router = app(), calls = [], results = [];
    api.mountAgyAccountRoutes(router, { directories: [{ path: '/repo' }],
      disposeLoginTerminal: async flow => calls.push(flow),
      createSessionRecord: async input => { calls.push(JSON.stringify(input)); return { ok: true, session: { id: 'a/b' } }; } });
    for (const body of [{}, { home }, { home, proxyUrl: ' http://proxy.example ' }]) {
      results.push(await router.invoke('POST /api/agy/accounts/:id/login-terminal', { body }));
    }
    return [results, calls];
  });
});

test('CLI key 账户与冻结入口的保存错误及先释放后删除顺序一致', async () => {
  await compare(frozen('cli-key-accounts'), account, async api => {
    const router = app(), calls = [];
    const store = { list: cli => [cli], create() { throw Object.assign(Error('invalid'), { code: 'CLI_KEY_ACCOUNT_BAD' }); },
      update() { return null; }, has() { return true; }, remove(cli, id) { calls.push([cli, id]); } };
    api.mountCliKeyAccountRoutes(router, { store, sessionPersistence: { mutate(source, cb) { calls.push(source); return cb(new Map()); } } });
    const results = [];
    for (const cli of ['opencode', 'commandcode', 'unsupported']) {
      for (const verb of ['GET', 'POST', 'PATCH', 'DELETE']) {
        const route = verb + ' /api/cli-accounts/:cli' + (['GET', 'POST'].includes(verb) ? '' : '/:id');
        results.push(await router.invoke(route, { params: { cli, id: 'id' } }));
      }
    }
    return [results, calls];
  });
});

test('工作区概览与冻结入口的分类、审计顺序、上限和引用一致', async () => {
  const current = require('../src/routes/share-machines-host');
  await compare(frozen('workspaces'), current, api => {
    const entries = [{ path: 'file' }];
    const records = Array.from({ length: 30 }, (_, i) => ({ id: i, kind: 'chat', dirId: 'd',
      workspaceState: [undefined, 'planned', 'hibernated', 'transition'][i % 4],
      hibernateRemovedIgnored: { at: String(i % 7 + 1), entries } }));
    const out = api.buildOverview({ directories: [{ id: 'd', path: '/repo' }], records,
      getHibernation: () => null, getOrphanScanner: () => null });
    assert.equal(out.removedIgnoredAudit.length, 20);
    assert.equal(out.removedIgnoredAudit[0].entries, entries);
    return JSON.stringify(out);
  });
});

test('无人值守端口与冻结入口对照五种动作和拒绝分支', async () => {
  const current = require('../src/routes/orchestration-host');
  await compare(frozen('routes'), current, async api => {
    const router = app(), events = [], host = { get: id => id };
    for (const action of ['start', 'update', 'stop', 'clear', 'resume']) {
      host[action] = (...args) => {
        events.push([action, ...args]);
        const result = action === 'stop' ? { ok: false, status: '404', code: 'gone' } : { ok: true, unattended: args[0] };
        return ['start', 'resume'].includes(action) ? Promise.resolve(result) : result;
      };
    }
    api.mountUnattendedRoutes(router, { records: new Map([['s', {}], ['aux', { type: 'aux' }]]), getUnattended: () => host });
    const results = [];
    for (const id of ['s', 'aux', 'missing']) {
      for (const action of ['start', 'stop', 'resume', 'clear', 'update', '__proto__']) {
        results.push(await router.invoke('POST /api/sessions/:id/unattended', { params: { id }, body: { action } }));
      }
    }
    return [results, events];
  });
});
