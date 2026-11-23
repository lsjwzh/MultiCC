'use strict';

// agy 账号存储在 native/core/src/agy_accounts.rs，规则本身由 Rust 单测钉住。
// 这里只测 Node 边界上剩下的三件事：
//   * `accountEnv()` 经原生模块读活动账号，且不改写任何存储规则；
//   * 登录终端的执行体只消费前门校验过的账号目录；
//   * 登录环境变量白名单与厂商登录流程表。
// 任何账号读写逻辑重新长回 JS，都会先在这里露出来。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { accountEnv, hasAccount } = require('../src/agy-accounts');

const REAL_HOME = process.env.HOME;

function tempHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agy-accounts-${tag}-`));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

const ROOT = ['.multicc', 'official-accounts', 'agy'];

function accountRoot(home) {
  return path.join(home, ...ROOT);
}

function accountHome(home, id) {
  return path.join(accountRoot(home), `${id}.home`);
}

/// 直接按 Rust 的磁盘布局造状态：账号目录 + `<id>.json` 元数据。
function createAccount(home, id, label = '工作号') {
  const dir = accountHome(home, id);
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  writeJson(path.join(accountRoot(home), `${id}.json`), {
    id, label, createdAt: 1, source: 'created',
  });
  return dir;
}

function setActive(home, id) {
  writeJson(path.join(accountRoot(home), 'active.json'), { id });
}

test.afterEach(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

test('no pin leaves HOME untouched', () => {
  const home = tempHome('unpinned');
  createAccount(home, '0123456789abcdef');
  assert.equal(accountEnv(home), null);
});

test('the active account is read through the native module', () => {
  const home = tempHome('pinned');
  const id = '0123456789abcdef';
  const dir = createAccount(home, id);
  setActive(home, id);
  assert.deepEqual(accountEnv(home), { HOME: dir });
});

test('a missing account directory is not a pin', () => {
  const home = tempHome('missing');
  const id = '0123456789abcdef';
  writeJson(path.join(accountRoot(home), `${id}.json`), { id, label: 'x', createdAt: 1 });
  setActive(home, id);
  assert.equal(accountEnv(home), null);
});

test('a malformed id in active.json is not a pin', () => {
  const home = tempHome('malformed');
  const dir = path.join(accountRoot(home), '..', '..', 'escape');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(accountRoot(home), 'active.json'), { id: '../../escape' });
  assert.equal(accountEnv(home), null);
});

test('an empty HOME is not a pin', () => {
  assert.equal(accountEnv(''), null);
  assert.throws(
    () => accountEnv('', '0123456789abcdef'),
    error => error.code === 'AGY_ACCOUNT_MISSING',
  );
});

test('explicit accountId overrides global active and fails closed when missing', () => {
  const home = tempHome('binding');
  const firstId = '0123456789abcdef';
  const secondId = 'fedcba9876543210';
  const firstDir = createAccount(home, firstId, '一号');
  const secondDir = createAccount(home, secondId, '二号');
  setActive(home, firstId);

  assert.equal(hasAccount(firstId, home), true);
  assert.equal(hasAccount(secondId, home), true);
  assert.equal(hasAccount('ffffffffffffffff', home), false);
  assert.equal(hasAccount('../../etc', home), false);

  assert.deepEqual(accountEnv(home, null), { HOME: firstDir });
  assert.deepEqual(accountEnv(home, secondId), { HOME: secondDir });
  assert.throws(
    () => accountEnv(home, 'ffffffffffffffff'),
    error => error.code === 'AGY_ACCOUNT_MISSING' && /重新选择账户/.test(error.message),
  );
  assert.throws(
    () => accountEnv(home, '../../etc'),
    error => error.code === 'AGY_ACCOUNT_MISSING',
  );
});

test('login env may pin HOME and nothing else', () => {
  const { sanitizeLoginEnv } = require('../src/official-accounts');
  assert.deepEqual(
    sanitizeLoginEnv({ HOME: '/tmp/acc' }, 'agy-login'),
    { ok: true, env: { HOME: '/tmp/acc' } },
  );
  assert.equal(sanitizeLoginEnv({ HOME: 'relative/path' }, 'agy-login').ok, false);
  assert.equal(sanitizeLoginEnv({ HOME: '/tmp/a\nb' }, 'agy-login').ok, false);
  // Keys outside the allowlist are dropped, never passed to the shell.
  assert.deepEqual(
    sanitizeLoginEnv({ HOME: '/tmp/acc', PATH: '/bin' }, 'agy-login').env,
    { HOME: '/tmp/acc' },
  );
  assert.equal(sanitizeLoginEnv({ HOME: '/tmp/acc' }, null).ok, false);
});

test('agy is a whitelisted interactive login flow', () => {
  const { vendorLoginForCli, cliForLoginFlow, vendorLoginTerminalCmd } =
    require('../src/cli-adapters/vendor-login');
  const spec = vendorLoginForCli('agy');
  assert.equal(spec.loginFlow, 'agy-login');
  assert.equal(cliForLoginFlow('agy-login'), 'agy');
  assert.equal(vendorLoginTerminalCmd('agy-login', { agy: '/opt/homebrew/bin/agy' }), '/opt/homebrew/bin/agy');
});

function routeApp() {
  const routes = new Map();
  return { routes, post: (p, h) => routes.set(`POST ${p}`, h) };
}

async function call(app, method, routePath, { params = {}, body } = {}) {
  const handler = app.routes.get(`${method} ${routePath}`);
  assert.ok(handler, `${method} ${routePath} must be mounted`);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ params, body }, res);
  return res;
}

test('the login terminal executor points HOME at the account it is given', async () => {
  const { mountAgyAccountRoutes } = require('../src/routes/agy-accounts');
  const home = tempHome('login-route');
  const id = '0123456789abcdef';
  const dir = accountHome(home, id);
  let captured = null;
  let disposed = null;
  const app = routeApp();
  mountAgyAccountRoutes(app, {
    directories: new Map([['d1', { id: 'd1', path: path.join(home, 'work') }]]),
    asyncHandler: fn => fn,
    disposeLoginTerminal: async (flow) => { disposed = flow; return 0; },
    createSessionRecord: async (args) => {
      captured = args;
      return { ok: true, id: 'agy-login', session: { id: 'agy-login' } };
    },
  });

  // 前门（Rust）已经把 id 校验、账号存在性判断和账号目录解析做完了。
  const ok = await call(app, 'POST', '/api/agy/accounts/:id/login-terminal', {
    params: { id }, body: { home: dir },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.id, 'agy-login');
  assert.equal(ok.body.url, '/?id=agy-login');
  assert.equal(captured.cli, 'agy');
  assert.equal(captured.kind, 'terminal');
  assert.equal(captured.loginFlow, 'agy-login');
  assert.deepEqual(captured.loginEnv, { HOME: dir });
  assert.equal(disposed, 'agy-login');
  assert.equal(fs.statSync(dir).isDirectory(), true, 'the executor creates the account home');

  const noHome = await call(app, 'POST', '/api/agy/accounts/:id/login-terminal', {
    params: { id }, body: {},
  });
  assert.equal(noHome.statusCode, 400);
  assert.equal(noHome.body.error, 'account home required');
});

test('the bridge no longer carries an account-home flag', () => {
  const { parseArgs } = require('./helpers/native-acp-bridge');
  // HOME 由父进程的 buildChildEnv 钉好，桥进程继承即可。
  const options = parseArgs(['--agent-bin', 'agy', '--', 'hi']);
  assert.equal('accountHome' in options, false);
});
