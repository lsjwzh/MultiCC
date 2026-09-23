'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { createProviderBinding } = require('../src/providers/binding');
const { createTurnRuntimeStore } = require('../src/chat/runtime-store');
const chatStream = require('../src/chat/chat-stream');
const providers = require('../src/providers/core');
const prepareTurn = require('./helpers/claude-exp-turn');
const { createStreamRouter } = require('../src/chat/stream-router');

test('the real host selects the persistent SDK runner and preserves native session identity', t => {
  const seen = [];
  t.mock.method(providers, 'applyClaudeProxyEnv', () => {});
  t.mock.method(providers, 'settingsOverrideFor', () => '/isolated/settings.json');
  t.mock.method(chatStream, 'ensure', (name, cfg) => {
    seen.push({ name, cfg });
    throw new Error('test stopped at persistent runner boundary');
  });
  for (const nativeId of [null, randomUUID()]) {
    const errors = [];
    const record = { id: 'sdk-host', cli: 'claude-exp', kind: 'chat', cliSessionId: nativeId,
      model: 'claude-sonnet-4-6' };
    const prepared = prepareTurn({ record, cwd: '/isolated/project', connected: true, stopAtInvocation: false,
      hostDeps: {
        chatTurnPreparationRuntime: createTurnRuntimeStore(),
        getPort: () => 3000, getClaudeOfficialViaProxy: () => false,
        chatBroadcast: (_id, event) => { if (event.type === 'error') errors.push(event.error); },
        providerRouterRuntime: {
          createBinding: (_session, overrides = {}) => createProviderBinding({
            cli: 'claude-exp', sessionId: record.id, providerId: '_default_',
            model: overrides.model || record.model, roleKind: 'main', routeName: 'main',
          }),
          resolveSpawnEnv: () => ({}), getProviderSummary: () => null,
          buildChildEnv: () => ({ env: { HOME: '/isolated' } }),
        },
      },
    });
    assert.equal(seen.length, nativeId ? 2 : 1, errors.join('; '));
    const { cfg } = seen.at(-1);
    assert.equal(prepared.envelope.spawnOpts.mode, 'streaming');
    assert.equal(cfg.sessionId, record.cliSessionId);
    assert.equal(cfg.resume, !!nativeId);
    assert.equal(cfg.sdkOptions.model, record.model);
    assert.equal(cfg.settingsFile, '/isolated/settings.json');
    assert.equal(record._streamSessionId, undefined, 'SDK must not allocate a second competing native identity');
  }
});

test('switching stream backends waits for the previous native process before accepting input', async () => {
  let exit, oldAlive = true, sends = 0;
  const legacy = { ensure() {}, status: () => ({ alive: oldAlive }),
    closeAndWait: () => new Promise(resolve => { exit = () => { oldAlive = false; resolve({ closed: true }); }; }) };
  const sdk = { ensure() {}, send() { assert.equal(oldAlive, false); sends++; return Promise.resolve('done'); } };
  const stream = createStreamRouter(legacy, sdk);
  stream.ensure('switch', {});
  stream.ensure('switch', { sdkOptions: {} });
  const turn = stream.send('switch', 'hello');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 0);
  exit();
  assert.equal(await turn, 'done');
  assert.equal(sends, 1);
});
