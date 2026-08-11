'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  SERVICE_TXT,
  createLanDiscoveryRuntime,
  eligibilityFailure,
  instanceName,
  serviceOptions,
} = require('../src/lan-discovery');

function eligibleState(overrides = {}) {
  return {
    host: '192.168.1.23',
    port: 3000,
    allowRemote: true,
    accessToken: 'secret',
    listening: true,
    ...overrides,
  };
}

function fakeResponder({ advertiseError, shutdownError } = {}) {
  const calls = { advertise: 0, create: 0, shutdown: 0, options: null };
  const responder = {
    createService(options) {
      calls.create += 1;
      calls.options = options;
      return {
        async advertise() {
          calls.advertise += 1;
          if (advertiseError) throw advertiseError;
        },
      };
    },
    async shutdown() {
      calls.shutdown += 1;
      if (shutdownError) throw shutdownError;
    },
  };
  return { calls, responder };
}

test('eligibility requires a listening, authenticated non-loopback remote bind', () => {
  assert.equal(eligibilityFailure(eligibleState()), null);
  assert.equal(eligibilityFailure(eligibleState({ host: '127.0.0.1' })), 'loopback_bind');
  assert.equal(eligibilityFailure(eligibleState({ host: '127.8.9.10' })), 'loopback_bind');
  assert.equal(eligibilityFailure(eligibleState({ host: '0:0:0:0:0:0:0:1' })), 'loopback_bind');
  assert.equal(eligibilityFailure(eligibleState({ host: 'localhost' })), 'loopback_bind');
  assert.equal(eligibilityFailure(eligibleState({ allowRemote: false })), 'remote_not_allowed');
  assert.equal(eligibilityFailure(eligibleState({ accessToken: '' })), 'missing_access_token');
  assert.equal(eligibilityFailure(eligibleState({ listening: false })), 'not_listening');
  assert.equal(eligibilityFailure(eligibleState({ shuttingDown: true })), 'shutting_down');
});

test('service records are minimal and constrained to the HTTP bind', () => {
  assert.deepEqual(serviceOptions(eligibleState(), 'devbox.local'), {
    name: 'MultiCC devbox',
    type: 'multicc',
    protocol: 'tcp',
    port: 3000,
    txt: { pv: '1', product: 'multicc' },
    restrictedAddresses: ['192.168.1.23'],
    disabledIpv6: true,
  });
  assert.deepEqual(SERVICE_TXT, { pv: '1', product: 'multicc' });
  assert.equal(serviceOptions(eligibleState({ host: '0.0.0.0' }), 'devbox').disabledIpv6, true);
  assert.equal(serviceOptions(eligibleState({ host: '::' }), 'devbox').restrictedAddresses, undefined);
  assert.ok(Buffer.byteLength(instanceName('测'.repeat(80)), 'utf8') <= 63);
});

test('reconcile publishes once, reacts to token changes, and sends one goodbye', async () => {
  let state = eligibleState({ accessToken: '' });
  const created = [];
  const runtime = createLanDiscoveryRuntime({
    readState: () => state,
    getHostname: () => 'devbox.local',
    responderFactory: () => {
      const fake = fakeResponder();
      created.push(fake);
      return fake.responder;
    },
    logger: { info() {}, warn() {} },
  });

  assert.equal(await runtime.reconcile(), false);
  assert.equal(created.length, 0, 'an empty ACCESS_TOKEN must never acquire a responder');

  state = eligibleState();
  assert.equal(await runtime.reconcile(), true);
  assert.equal(await runtime.reconcile(), true);
  assert.equal(created.length, 1, 'unchanged state must not duplicate advertisements');
  assert.equal(created[0].calls.advertise, 1);
  assert.deepEqual(created[0].calls.options.txt, { pv: '1', product: 'multicc' });

  state = eligibleState({ accessToken: '' });
  assert.equal(await runtime.reconcile(), false);
  assert.equal(created[0].calls.shutdown, 1);
  await runtime.stop();
  assert.equal(created[0].calls.shutdown, 1, 'stop must not shut down a responder twice');
  assert.deepEqual(runtime.status(), { active: false, key: null });
});

test('bind changes replace the advertisement before publishing the new endpoint', async () => {
  let state = eligibleState();
  const created = [];
  const runtime = createLanDiscoveryRuntime({
    readState: () => state,
    responderFactory: () => {
      const fake = fakeResponder();
      created.push(fake);
      return fake.responder;
    },
    logger: { info() {}, warn() {} },
  });

  await runtime.reconcile();
  state = eligibleState({ port: 3001 });
  await runtime.reconcile();
  assert.equal(created.length, 2);
  assert.equal(created[0].calls.shutdown, 1);
  assert.equal(created[1].calls.options.port, 3001);
  await runtime.stop();
  assert.equal(created[1].calls.shutdown, 1);
});

test('advertising failures are logged, cleaned up, and never reject readiness work', async () => {
  const warnings = [];
  const failed = fakeResponder({ advertiseError: new Error('UDP 5353 unavailable') });
  const runtime = createLanDiscoveryRuntime({
    readState: eligibleState,
    responderFactory: () => failed.responder,
    logger: { info() {}, warn(event, fields) { warnings.push({ event, fields }); } },
  });

  assert.equal(await runtime.reconcile(), false);
  assert.equal(failed.calls.shutdown, 1);
  assert.equal(runtime.status().active, false);
  assert.equal(warnings.at(-1).event, 'lan_discovery_publish_failed');
  assert.equal(warnings.at(-1).fields.error, 'UDP 5353 unavailable');
});

test('shutdown failures are logged and remain best-effort', async () => {
  const warnings = [];
  const failed = fakeResponder({ shutdownError: new Error('goodbye failed') });
  const runtime = createLanDiscoveryRuntime({
    readState: eligibleState,
    responderFactory: () => failed.responder,
    logger: { info() {}, warn(event, fields) { warnings.push({ event, fields }); } },
  });

  assert.equal(await runtime.reconcile(), true);
  assert.equal(await runtime.stop(), true);
  assert.equal(failed.calls.shutdown, 1);
  assert.equal(warnings.at(-1).event, 'lan_discovery_stop_failed');
  assert.equal(runtime.status().active, false);
});

test('server composition publishes after listen and shuts discovery down with the host', () => {
  const root = path.join(__dirname, '..');
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const lifecycleSource = fs.readFileSync(path.join(root, 'src/host-lifecycle.js'), 'utf8');
  const listenIndex = serverSource.indexOf('server.listen(PORT, BIND_HOST');
  const publishIndex = serverSource.indexOf('void lanDiscovery.reconcile()', listenIndex);

  assert.match(serverSource, /createLanDiscoveryRuntime\(/);
  assert.ok(listenIndex >= 0 && publishIndex > listenIndex, 'discovery must publish only after HTTP listen starts');
  assert.match(serverSource, /ACCESS_TOKEN = token;\s+void lanDiscovery\.reconcile\(\);/);
  assert.match(serverSource, /\n\s+lanDiscovery,\s*\n/);
  assert.match(lifecycleSource, /await lanDiscovery\?\.stop\?\.\(\)/);
});
