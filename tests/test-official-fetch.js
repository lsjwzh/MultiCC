'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficialFetch, parseMacProxy } = require('../src/network/official-fetch');

test('macOS system HTTP proxies are parsed only when explicitly enabled', () => {
  assert.deepEqual(parseMacProxy('<dictionary> {\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7897\n HTTPSEnable : 1\n HTTPEnable : 0\n HTTPProxy : ignored\n HTTPPort : 8\n}'), { httpProxy: '', httpsProxy: 'http://127.0.0.1:7897' });
  assert.deepEqual(parseMacProxy('HTTPSProxy : localhost\n HTTPSPort : 0\n HTTPSEnable : 1'), { httpProxy: '', httpsProxy: '' });
});

test('system proxy discovery is singleflight, refreshes, preserves the stream and does not retry failed requests', async () => {
  let now = 0, scans = 0, calls = 0, closes = 0;
  const configs = [], requests = [];
  const response = { body: { stream: true } };
  const f = createOfficialFetch({ env: {}, platform: 'darwin', now: () => now,
    readSystemProxy: async () => { scans++; return { httpsProxy: `http://localhost:${scans === 1 ? 7897 : 7898}` }; },
    createDispatcher: config => { configs.push(config); return { close: async () => { closes++; } }; },
    fetch: async (url, init) => { calls++; requests.push(init); return response; },
  });
  const signal = new AbortController().signal;
  const init = { method: 'POST', body: 'payload', headers: { authorization: 'Bearer test' }, signal };
  const replies = await Promise.all([f('https://chatgpt.com', init), f('https://chatgpt.com', init)]);
  assert.equal(scans, 1);
  assert.equal(calls, 2);
  assert.equal(configs[0].httpsProxy, 'http://localhost:7897');
  assert.equal(replies[0], response);
  assert.equal(requests[0].body, init.body);
  assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].headers, init.headers);
  now = 30001;
  await f('https://chatgpt.com');
  assert.equal(configs[1].httpsProxy, 'http://localhost:7898');
  assert.equal(closes, 1);
  await f.close();
});

test('explicit environment routing overrides system configuration and carries NO_PROXY', async () => {
  let captured;
  const f = createOfficialFetch({ platform: 'darwin', env: { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost,.internal' },
    readSystemProxy: () => { throw new Error('must not read system'); },
    createDispatcher: config => { captured = config; return { close() {} }; }, fetch: async () => ({ status: 200 }),
  });
  await f('https://chatgpt.com');
  assert.deepEqual(captured, { httpProxy: '', httpsProxy: 'http://proxy:8080', noProxy: 'localhost,.internal' });
});

test('Linux without proxy settings retains native fetch behavior and failures retain their cause without replay', async () => {
  const cause = new Error('connect timed out'); cause.code = 'UND_ERR_CONNECT_TIMEOUT';
  const failure = new TypeError('fetch failed', { cause });
  let calls = 0;
  const f = createOfficialFetch({ env: {}, platform: 'linux', fetch: async (_, init) => {
    assert.equal(init.dispatcher, undefined); calls++; throw failure;
  } });
  await assert.rejects(f('https://chatgpt.com'), e => e === failure && e.cause === cause && e.multiccProxyMode === 'direct');
  assert.equal(calls, 1);
});

test('unsupported proxy scheme and discovery failure never silently bypass configured routing', async () => {
  let calls = 0;
  const f = createOfficialFetch({ platform: 'linux', env: { ALL_PROXY: 'socks5://localhost:7897' }, fetch: async () => { calls++; } });
  await assert.rejects(f('https://chatgpt.com'), /HTTP\(S\) proxy/);
  const g = createOfficialFetch({ platform: 'darwin', env: {}, readSystemProxy: async () => { throw new Error('discovery failed'); }, fetch: async () => { calls++; } });
  await assert.rejects(g('https://chatgpt.com'), e => e.multiccProxyMode === 'proxy-discovery');
  assert.equal(calls, 0);
});
