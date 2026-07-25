'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { mountZcodeAuthRoutes } = require('../src/routes/zcode-auth');

const MODULE = path.join(__dirname, '..', 'src', 'cli-adapters', 'zcode-auth.js');

function runWithHome(home, source) {
  const stdout = execFileSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ZCODE_AUTH_MODULE: MODULE },
  });
  return JSON.parse(stdout);
}

test('native auth recognizes custom ZCode provider kinds without assuming Z.ai/BigModel', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.zcode', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    model: 'custom/gpt-test',
    provider: {
      custom: {
        kind: 'openai-compatible',
        options: { baseURL: 'https://chat.example/v1', apiKey: 'secret' },
        models: { 'gpt-test': { id: 'gpt-test' } },
      },
    },
  }));

  const status = runWithHome(home, `
    const auth = require(process.env.ZCODE_AUTH_MODULE);
    process.stdout.write(JSON.stringify(auth.getZcodeAuthStatus()));
  `);
  assert.deepEqual(status, {
    configured: true,
    provider: 'custom',
    hasKey: true,
    source: 'cli_config',
    kind: 'openai-compatible',
    baseURL: 'https://chat.example/v1',
    model: 'custom/gpt-test',
  });
});

test('turn admission never auto-copies a desktop key into the native CLI config', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-auth-no-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const desktopDir = path.join(home, '.zcode', 'v2');
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(path.join(desktopDir, 'config.json'), JSON.stringify({
    provider: {
      'builtin:zai': {
        options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: 'desktop-secret' },
      },
    },
  }));

  const result = runWithHome(home, `
    const fs = require('node:fs');
    const auth = require(process.env.ZCODE_AUTH_MODULE);
    const native = auth.ensureZcodeAuth({ cli: 'zcode', provider: null });
    const routed = auth.ensureZcodeAuth({ cli: 'zcode', provider: 'multicc-provider' });
    process.stdout.write(JSON.stringify({
      native,
      routed,
      cliConfigCreated: fs.existsSync(auth.CLI_CONFIG_PATH),
    }));
  `);
  assert.equal(result.native.ok, false);
  assert.equal(result.native.code, 'configuration_required');
  assert.deepEqual(result.routed, {
    ok: true,
    provider: 'multicc-provider',
    source: 'multicc_provider',
  });
  assert.equal(result.cliConfigCreated, false);
});

function routeHarness(zcodeAuth) {
  const handlers = new Map();
  const app = {};
  for (const method of ['get', 'post', 'put']) {
    app[method] = (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler);
  }
  mountZcodeAuthRoutes(app, { zcodeAuth });
  return {
    invoke(method, route, body = {}) {
      return new Promise((resolve, reject) => {
        const handler = handlers.get(`${method} ${route}`);
        const res = {
          statusCode: 200,
          status(code) { this.statusCode = code; return this; },
          json(payload) { resolve({ status: this.statusCode, body: payload }); },
        };
        try {
          const pending = handler({ body }, res);
          if (pending && typeof pending.catch === 'function') pending.catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    },
  };
}

test('auth HTTP DTOs exclude credential material, paths, URLs, and raw login errors', async () => {
  const child = new EventEmitter();
  child.kill = () => {};
  const secret = 'secret-auth-value';
  const localPath = '/Users/private/.zcode/cli/config.json';
  const h = routeHarness({
    getZcodeAuthStatus: () => ({
      configured: true,
      provider: 'custom',
      hasKey: true,
      source: 'cli_config',
      kind: 'openai-compatible',
      model: 'custom/model',
      baseURL: `https://user:${secret}@example.test/v1?token=${secret}`,
      cliConfigPath: localPath,
    }),
    detectDesktopApiKeys: () => ({
      zai: { apiKey: secret, baseURL: `https://example.test/?key=${secret}` },
    }),
    isZcodeLoginAvailable: () => true,
    spawnZcodeLogin: () => {
      queueMicrotask(() => child.emit('error', new Error(`${localPath}?token=${secret}`)));
      return child;
    },
    ensureZcodeAuth: () => ({
      ok: false,
      code: 'configuration_required',
      message: `${localPath}?token=${secret}`,
    }),
  });

  const status = await h.invoke('GET', '/api/zcode/auth');
  assert.deepEqual(status.body, {
    configured: true,
    provider: 'custom',
    hasKey: true,
    source: 'cli_config',
    kind: 'openai-compatible',
    model: 'custom/model',
    loginAvailable: true,
    desktopProviders: [{ id: 'zai', hasKey: true }],
  });
  const check = await h.invoke('GET', '/api/zcode/auth/check');
  assert.equal(JSON.stringify(check).includes(secret), false);
  assert.equal(JSON.stringify(check).includes(localPath), false);

  const login = await h.invoke('POST', '/api/zcode/auth/login');
  assert.deepEqual(login, {
    status: 500,
    body: {
      ok: false,
      code: 'spawn_error',
      message: '无法启动 ZCode 官方登录流程。',
    },
  });
});
