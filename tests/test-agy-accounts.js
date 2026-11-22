'use strict';

// The Node account store is a mirror of native/core/src/agy_accounts.rs: same
// layout, same import whitelist, same never-echo-a-token rule. These tests pin
// those rules and the bridge's HOME injection, so a Rust change that is not
// carried here fails loudly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const accounts = require('../src/agy-accounts');
const { childEnv, parseArgs } = require('../src/cli-adapters/acp-bridge.cjs');

const REAL_HOME = process.env.HOME;

function tempHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agy-accounts-${tag}-`));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function signedIn(home) {
  const gemini = path.join(home, '.gemini');
  writeJson(path.join(gemini, 'oauth_creds.json'), {
    access_token: 'secret-access',
    refresh_token: 'secret-refresh',
    expiry_date: 1893456000000,
  });
  writeJson(path.join(gemini, 'google_accounts.json'), {
    active: 'alice@example.com',
    old: ['bob@example.com'],
  });
  writeJson(path.join(gemini, 'settings.json'), { theme: 'dark' });
  writeJson(path.join(gemini, 'antigravity-cli', 'settings.json'), { telemetry: false });
  // Runtime caches must not travel with an account.
  fs.mkdirSync(path.join(gemini, 'brain', 'conv-1'), { recursive: true });
  fs.writeFileSync(path.join(gemini, 'brain', 'conv-1', 'message.json'), '{}');
  fs.writeFileSync(path.join(gemini, 'antigravity-cli', 'cli.log'), 'noise');
  fs.writeFileSync(path.join(gemini, 'antigravity-cli', 'conversations.db'), 'db');
}

test.afterEach(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

test('ids are validated before any path join', () => {
  const home = tempHome('ids');
  assert.equal(accounts.validAccount('0123456789abcdef'), true);
  assert.equal(accounts.validAccount('0123456789ABCDEF'), false);
  assert.equal(accounts.validAccount('0123456789abcde'), false);
  assert.equal(accounts.validAccount('../../etc/passwd'), false);
  assert.equal(accounts.accountHome(home, '../../etc'), null);
  assert.equal(accounts.metaFile(home, 'zz'), null);
  assert.equal(
    accounts.accountHome(home, '0123456789abcdef'),
    path.join(home, '.multicc', 'official-accounts', 'agy', '0123456789abcdef.home'),
  );
});

test('create makes an empty home with private modes', () => {
  const home = tempHome('create');
  const record = accounts.createAccount(home, '  工作号  ', 'created');
  assert.equal(accounts.validAccount(record.id), true);
  assert.equal(record.label, '工作号');
  assert.equal(record.source, 'created');
  const dir = accounts.accountHome(home, record.id);
  assert.equal(fs.statSync(dir).isDirectory(), true);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(accounts.metaFile(home, record.id)).mode & 0o777, 0o600);
  // An empty account has no credentials yet.
  assert.deepEqual(accounts.loginStatus(home, record.id), {
    loggedIn: false,
    email: null,
    expiresAt: null,
  });
});

test('create defaults and truncates the label', () => {
  const home = tempHome('label');
  assert.equal(accounts.createAccount(home, '   ', 'created').label, accounts.DEFAULT_LABEL);
  const record = accounts.createAccount(home, '字'.repeat(200), 'created');
  assert.equal([...record.label].length, 64);
});

test('import copies credentials and config but not caches', () => {
  const home = tempHome('import');
  signedIn(home);
  const record = accounts.importAccount(home, '');
  // The label falls back to the imported Google address, and it is persisted
  // so the next list read agrees with this answer.
  assert.equal(record.label, 'alice@example.com');
  assert.equal(accounts.listAccounts(home)[0].label, 'alice@example.com');
  const target = path.join(accounts.accountHome(home, record.id), '.gemini');
  for (const name of ['oauth_creds.json', 'google_accounts.json', 'settings.json']) {
    assert.equal(fs.existsSync(path.join(target, name)), true, name);
  }
  assert.equal(fs.existsSync(path.join(target, 'antigravity-cli', 'settings.json')), true);
  assert.equal(fs.existsSync(path.join(target, 'brain')), false);
  assert.equal(fs.existsSync(path.join(target, 'antigravity-cli', 'cli.log')), false);
  assert.equal(fs.existsSync(path.join(target, 'antigravity-cli', 'conversations.db')), false);
  assert.deepEqual(accounts.loginStatus(home, record.id), {
    loggedIn: true,
    email: 'alice@example.com',
    expiresAt: 1893456000000,
  });
});

test('import without a local login fails and leaves nothing behind', () => {
  const home = tempHome('import-empty');
  assert.throws(() => accounts.importAccount(home, 'x'), /尚未登录/);
  const root = accounts.accountRoot(home);
  assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], []);
});

test('login status never echoes tokens', () => {
  const home = tempHome('secrets');
  signedIn(home);
  const record = accounts.importAccount(home, '');
  const serialized = JSON.stringify(accounts.loginStatus(home, record.id));
  assert.equal(serialized.includes('secret-access'), false);
  assert.equal(serialized.includes('secret-refresh'), false);
  assert.equal(accounts.loginStatus(home, record.id).email, 'alice@example.com');
});

test('active round trips, and delete clears the pin', () => {
  const home = tempHome('active');
  const record = accounts.createAccount(home, '一号', 'created');
  assert.equal(accounts.activeHome(home), null);
  accounts.setActive(home, record.id);
  assert.equal(accounts.activeId(home), record.id);
  assert.equal(accounts.activeHome(home), accounts.accountHome(home, record.id));
  accounts.setActive(home, null);
  assert.equal(accounts.activeId(home), null);
  accounts.setActive(home, record.id);
  accounts.deleteAccount(home, record.id);
  assert.equal(accounts.activeId(home), null);
  assert.equal(fs.existsSync(accounts.accountHome(home, record.id)), false);
});

test('unknown and malformed ids are rejected', () => {
  const home = tempHome('unknown');
  assert.throws(() => accounts.setActive(home, '0123456789abcdef'), /unknown account/);
  assert.throws(() => accounts.setActive(home, '../../etc'), /invalid account id/);
  assert.throws(() => accounts.deleteAccount(home, '0123456789abcdef'), /unknown account/);
});

test('accounts list oldest first and mark the active one', async () => {
  const home = tempHome('list');
  const older = accounts.createAccount(home, '旧号', 'created');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = accounts.createAccount(home, '新号', 'created');
  accounts.setActive(home, newer.id);
  const listed = accounts.listAccounts(home);
  assert.deepEqual(listed.map((account) => account.label), ['旧号', '新号']);
  assert.deepEqual(listed.map((account) => account.active), [false, true]);
  assert.equal(listed[0].id, older.id);
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

async function call(app, method, routePath, { params = {} } = {}) {
  const handler = app.routes.get(`${method} ${routePath}`);
  assert.ok(handler, `${method} ${routePath} must be mounted`);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ params }, res);
  return res;
}

test('the login terminal route points HOME at the account', async () => {
  const { mountAgyAccountRoutes } = require('../src/routes/agy-accounts');
  const home = tempHome('login-route');
  const record = accounts.createAccount(home, '工作号', 'created');
  let captured = null;
  const app = routeApp();
  mountAgyAccountRoutes(app, {
    homeDir: () => home,
    directories: new Map([['d1', { id: 'd1', path: path.join(home, 'work') }]]),
    asyncHandler: fn => fn,
    disposeLoginTerminal: async () => 0,
    createSessionRecord: async (args) => {
      captured = args;
      return { ok: true, id: 'agy-login', session: { id: 'agy-login' } };
    },
  });

  const ok = await call(app, 'POST', '/api/agy/accounts/:id/login-terminal', { params: { id: record.id } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.id, 'agy-login');
  assert.equal(captured.cli, 'agy');
  assert.equal(captured.kind, 'terminal');
  assert.equal(captured.loginFlow, 'agy-login');
  assert.deepEqual(captured.loginEnv, { HOME: accounts.accountHome(home, record.id) });

  const missing = await call(app, 'POST', '/api/agy/accounts/:id/login-terminal', { params: { id: 'f'.repeat(16) } });
  assert.equal(missing.statusCode, 404);
  const bad = await call(app, 'POST', '/api/agy/accounts/:id/login-terminal', { params: { id: '../../etc/passwd' } });
  assert.equal(bad.statusCode, 400);
});

test('the bridge injects the active home only when asked', () => {
  const home = tempHome('env');
  process.env.HOME = home;
  assert.deepEqual(childEnv({}, { HOME: '/real' }), { HOME: '/real' });
  // No account pinned: the real HOME is left alone.
  assert.deepEqual(childEnv({ accountHome: 'agy' }, { HOME: '/real' }), { HOME: '/real' });
  const record = accounts.createAccount(home, '工作', 'created');
  accounts.setActive(home, record.id);
  const env = childEnv({ accountHome: 'agy' }, { HOME: '/real', KEEP: '1' });
  assert.equal(env.HOME, accounts.accountHome(home, record.id));
  assert.equal(env.KEEP, '1');
  // And the adapter passes the flag through the bridge CLI.
  assert.equal(parseArgs(['--agent-bin', 'agy', '--account-home', 'agy', '--', 'hi']).accountHome, 'agy');
});
