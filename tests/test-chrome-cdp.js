'use strict';

// Isolation tests for src/chrome-cdp.js. Everything the module touches — the
// filesystem, the debug-port probe, the WebSocket — is injectable, so these run
// with no browser present and no network.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const {
  createChromeCdp,
  defaultProfileDirs,
  parseDevToolsActivePort,
  cookieDomainMatches,
  portsFromEnv,
  profileDirsFromEnv,
  ChromeUnavailableError,
  DEFAULT_PORTS,
} = require('../src/chrome-cdp');

// A stand-in for a browser's WebSocket endpoint. `handle` decides what each
// command answers; everything else behaves like `ws` does.
function fakeSocketFactory(endpoints) {
  const opened = [];
  const factory = (url) => {
    const spec = endpoints[url];
    if (!spec) throw new Error(`refused: ${url}`);
    const listeners = { message: [], open: [], close: [], error: [] };
    const socket = {
      url,
      closed: false,
      sent: [],
      on(event, fn) { (listeners[event] || []).push(fn); return socket; },
      emit(event, arg) { for (const fn of listeners[event] || []) fn(arg); },
      send(raw) {
        socket.sent.push(JSON.parse(raw));
        const frame = JSON.parse(raw);
        const reply = spec.handle(frame, socket);
        if (reply === undefined) return;
        setImmediate(() => socket.emit('message', Buffer.from(JSON.stringify(
          Object.assign({ id: frame.id }, reply),
        ))));
      },
      close() {
        if (socket.closed) return;
        socket.closed = true;
        socket.emit('close');
      },
    };
    opened.push(socket);
    if (spec.failToOpen) setImmediate(() => socket.emit('error', new Error('ECONNREFUSED')));
    else setImmediate(() => socket.emit('open'));
    return socket;
  };
  factory.opened = opened;
  return factory;
}

const refuseProbe = () => Promise.reject(new Error('ECONNREFUSED'));
const noProfiles = () => Promise.reject(new Error('ENOENT'));

test('parseDevToolsActivePort reads the two-line file Chrome writes', () => {
  assert.deepEqual(
    parseDevToolsActivePort('58142\n/devtools/browser/5a1342d3-4bcd\n'),
    { port: 58142, path: '/devtools/browser/5a1342d3-4bcd' },
  );
});

test('parseDevToolsActivePort rejects anything that is not that file', () => {
  assert.equal(parseDevToolsActivePort(''), null);
  assert.equal(parseDevToolsActivePort('58142'), null, 'no ws path');
  assert.equal(parseDevToolsActivePort('notaport\n/devtools/browser/x'), null);
  assert.equal(parseDevToolsActivePort('0\n/devtools/browser/x'), null);
  assert.equal(parseDevToolsActivePort('70000\n/devtools/browser/x'), null);
  assert.equal(parseDevToolsActivePort('58142\n/json/version'), null, 'wrong path shape');
});

test('cookieDomainMatches accepts the site, its dot-form and subdomains only', () => {
  assert.ok(cookieDomainMatches('qoder.com.cn', 'qoder.com.cn'));
  assert.ok(cookieDomainMatches('.qoder.com.cn', 'qoder.com.cn'));
  assert.ok(cookieDomainMatches('api.qoder.com.cn', 'qoder.com.cn'));
  assert.ok(!cookieDomainMatches('notqoder.com.cn', 'qoder.com.cn'));
  assert.ok(!cookieDomainMatches('qoder.com.cn.evil.example', 'qoder.com.cn'));
  assert.ok(!cookieDomainMatches('', 'qoder.com.cn'));
  assert.ok(!cookieDomainMatches('qoder.com.cn', ''));
});

test('defaultProfileDirs covers the Chromium family per platform', () => {
  const mac = defaultProfileDirs('darwin', {}, '/Users/x');
  assert.ok(mac.includes('/Users/x/Library/Application Support/Google/Chrome'));
  assert.ok(mac.some((dir) => dir.includes('Microsoft Edge')));

  const win = defaultProfileDirs('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U');
  assert.ok(win.some((dir) => dir.includes('Chrome') && dir.includes('User Data')));

  const linux = defaultProfileDirs('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/x');
  assert.ok(linux.includes('/cfg/google-chrome'));
});

test('portsFromEnv defaults to 9222, honours the env list and dedupes', () => {
  assert.deepEqual(portsFromEnv({}, []), DEFAULT_PORTS);
  assert.deepEqual(portsFromEnv({ MULTICC_CHROME_CDP_PORTS: '9333, 9444' }, []), [9333, 9444]);
  assert.deepEqual(portsFromEnv({ MULTICC_CHROME_CDP_PORTS: '9333' }, ['9333']), [9333]);
  assert.deepEqual(portsFromEnv({ MULTICC_CHROME_CDP_PORTS: 'nope,70000,-1' }, []), DEFAULT_PORTS);
  assert.deepEqual(portsFromEnv({}, ['9555']), [9555]);
});

test('profileDirsFromEnv puts the user override ahead of the guesses', () => {
  const dirs = profileDirsFromEnv({ MULTICC_CHROME_PROFILE_DIRS: `/custom/one${path.delimiter}/custom/two` });
  assert.equal(dirs[0], '/custom/one');
  assert.equal(dirs[1], '/custom/two');
  assert.ok(dirs.length > 2, 'defaults still appended');
  assert.deepEqual(profileDirsFromEnv({}), defaultProfileDirs(process.platform, {}, os.homedir()));
});

test('discover prefers a live debug port, then profile files', async () => {
  const cdp = createChromeCdp({
    ports: [9222],
    profileDirs: ['/p/one', '/p/two'],
    probeDebugPort: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/flagged' }),
    readFile: async (file) => {
      if (file === path.join('/p/one', 'DevToolsActivePort')) return '58142\n/devtools/browser/one';
      throw new Error('ENOENT');
    },
  });

  const { found, tried } = await cdp.discover();
  assert.deepEqual(found.map((c) => c.source), ['debug-port', 'profile']);
  assert.equal(found[0].wsUrl, 'ws://127.0.0.1:9222/devtools/browser/flagged');
  assert.equal(found[1].wsUrl, 'ws://127.0.0.1:58142/devtools/browser/one');
  assert.deepEqual(tried, [{ source: 'profile', detail: '/p/two', reason: 'no DevToolsActivePort' }]);
});

test('discover records why each candidate was skipped', async () => {
  const cdp = createChromeCdp({
    ports: [9222],
    profileDirs: ['/p/garbage'],
    probeDebugPort: refuseProbe,
    readFile: async () => 'this is not a port file',
  });

  const { found, tried } = await cdp.discover();
  assert.deepEqual(found, []);
  assert.equal(tried.length, 2);
  assert.equal(tried[0].source, 'debug-port');
  assert.equal(tried[1].reason, 'unparsable DevToolsActivePort');
});

test('attach skips a stale DevToolsActivePort and uses the live one', async () => {
  // Both files parse; only the second names a browser that answers. This is the
  // case the module exists to survive — a file outlives the browser that wrote
  // it, so only the handshake tells the truth.
  const openSocket = fakeSocketFactory({
    'ws://127.0.0.1:1111/devtools/browser/stale': { failToOpen: true, handle: () => undefined },
    'ws://127.0.0.1:2222/devtools/browser/live': {
      handle: (frame) => (frame.method === 'Browser.getVersion'
        ? { result: { product: 'Chrome/140' } }
        : { result: {} }),
    },
  });
  const cdp = createChromeCdp({
    ports: [],
    profileDirs: ['/p/stale', '/p/live'],
    probeDebugPort: refuseProbe,
    readFile: async (file) => (file.includes('stale')
      ? '1111\n/devtools/browser/stale'
      : '2222\n/devtools/browser/live'),
    openSocket,
  });

  const browser = await cdp.attach();
  assert.equal(browser.wsUrl, 'ws://127.0.0.1:2222/devtools/browser/live');
  assert.equal(browser.source, 'profile');
  browser.close();
  assert.ok(openSocket.opened[0].closed, 'the stale socket is not left open');
});

test('attach rejects a browser that opens but fails the version handshake', async () => {
  const cdp = createChromeCdp({
    ports: [],
    profileDirs: ['/p/one'],
    probeDebugPort: refuseProbe,
    readFile: async () => '3333\n/devtools/browser/half-dead',
    openSocket: fakeSocketFactory({
      'ws://127.0.0.1:3333/devtools/browser/half-dead': {
        handle: () => ({ error: { message: 'Browser is shutting down' } }),
      },
    }),
  });

  await assert.rejects(cdp.attach(), (err) => {
    assert.ok(err instanceof ChromeUnavailableError);
    assert.equal(err.code, 'chrome_unavailable');
    assert.match(err.tried.at(-1).reason, /shutting down/);
    return true;
  });
});

test('attach reports chrome_unavailable when nothing is running', async () => {
  const cdp = createChromeCdp({ ports: [9222], profileDirs: ['/p/one'], probeDebugPort: refuseProbe, readFile: noProfiles });
  await assert.rejects(cdp.attach(), (err) => err.code === 'chrome_unavailable');
});

test('a command the browser never answers rejects instead of hanging', async () => {
  const cdp = createChromeCdp({
    ports: [],
    profileDirs: ['/p/one'],
    commandTimeoutMs: 20,
    probeDebugPort: refuseProbe,
    readFile: async () => '5555\n/devtools/browser/mute',
    openSocket: fakeSocketFactory({
      'ws://127.0.0.1:5555/devtools/browser/mute': {
        // Answers the handshake, then goes quiet — a renderer that wedged.
        handle: (frame) => (frame.method === 'Browser.getVersion' ? { result: {} } : undefined),
      },
    }),
  });

  const browser = await cdp.attach();
  await assert.rejects(browser.send('Storage.getCookies'), /CDP timeout: Storage.getCookies/);
  browser.close();
});

// A browser stub good enough for withPage/getCookies, with a record of the
// targets it was asked to create and close.
function browserStub(handlers = {}) {
  const calls = [];
  const listeners = new Set();
  const browser = {
    calls,
    closed: false,
    send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (handlers[method]) return Promise.resolve(handlers[method](params, sessionId));
      if (method === 'Target.createTarget') return Promise.resolve({ targetId: 'T1' });
      if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'S1' });
      return Promise.resolve({});
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(message) { for (const fn of listeners) fn(message); },
    listenerCount: () => listeners.size,
    close() { browser.closed = true; },
  };
  return browser;
}

test('withPage closes its throwaway tab on the happy path', async () => {
  const cdp = createChromeCdp({});
  const browser = browserStub();
  const out = await cdp.withPage(async (page) => {
    assert.equal(page.sessionId, 'S1');
    return 'done';
  }, { browser });

  assert.equal(out, 'done');
  assert.ok(browser.calls.some((c) => c.method === 'Target.closeTarget' && c.params.targetId === 'T1'));
  assert.equal(browser.listenerCount(), 0, 'the page event listener is detached');
  assert.equal(browser.closed, false, 'a borrowed browser is left to its owner');
});

test('withPage closes the tab even when the body throws', async () => {
  const cdp = createChromeCdp({});
  const browser = browserStub();
  await assert.rejects(
    cdp.withPage(async () => { throw new Error('scrape failed'); }, { browser }),
    /scrape failed/,
  );
  assert.ok(browser.calls.some((c) => c.method === 'Target.closeTarget'));
  assert.equal(browser.listenerCount(), 0);
});

test('withPage closes a browser it opened itself', async () => {
  const openSocket = fakeSocketFactory({
    'ws://127.0.0.1:4444/devtools/browser/live': {
      handle: () => ({ result: { targetId: 'T1', sessionId: 'S1' } }),
    },
  });
  const cdp = createChromeCdp({
    ports: [],
    profileDirs: ['/p/one'],
    probeDebugPort: refuseProbe,
    readFile: async () => '4444\n/devtools/browser/live',
    openSocket,
  });

  assert.equal(await cdp.withPage(async () => 'ok'), 'ok');
  assert.equal(openSocket.opened.length, 1);
  assert.ok(openSocket.opened[0].closed, 'an attach made by withPage is hung up again');
});

test('withPage surfaces a tab Chrome refused to create', async () => {
  const cdp = createChromeCdp({});
  const browser = browserStub({ 'Target.createTarget': () => ({}) });
  await assert.rejects(cdp.withPage(async () => 'unreachable', { browser }), /no targetId/);
  assert.ok(!browser.calls.some((c) => c.method === 'Target.closeTarget'), 'nothing to close');
});

test('page helpers speak flattened sessions and read response bodies', async () => {
  const cdp = createChromeCdp({});
  const browser = browserStub({
    'Runtime.evaluate': () => ({ result: { value: 'https://example.test/usage' } }),
    'Network.getResponseBody': () => ({ body: Buffer.from('{"ok":1}').toString('base64'), base64Encoded: true }),
  });

  await cdp.withPage(async (page) => {
    await page.enable(['Network', 'Page']);
    await page.navigate('https://example.test/usage');
    assert.equal(await page.evaluate('location.href'), 'https://example.test/usage');

    // Events for other sessions must not land in this page's response list.
    browser.emit({ sessionId: 'OTHER', method: 'Network.responseReceived', params: { requestId: 'X', response: { url: 'https://other.test/', status: 200 } } });
    browser.emit({ sessionId: 'S1', method: 'Network.responseReceived', params: { requestId: 'R1', response: { url: 'https://example.test/api/usage', status: 200 } } });

    assert.equal(page.responses.length, 1);
    const hit = page.findResponse((r) => r.url.includes('/api/usage'));
    assert.equal(hit.requestId, 'R1');
    assert.equal(await page.responseBody('R1'), '{"ok":1}');
  }, { browser });

  const sent = browser.calls.filter((c) => c.method.startsWith('Network.') || c.method.startsWith('Page.') || c.method.startsWith('Runtime.'));
  assert.ok(sent.every((c) => c.sessionId === 'S1'), 'every page command carries the session id');
});

test('waitFor polls until truthy and gives up with null', async () => {
  const cdp = createChromeCdp({ commandTimeoutMs: 50 });
  const browser = browserStub();
  await cdp.withPage(async (page) => {
    let calls = 0;
    const hit = await page.waitFor(async () => { calls += 1; return calls >= 3 ? 'ready' : null; }, { timeoutMs: 1000, intervalMs: 1 });
    assert.equal(hit, 'ready');
    assert.equal(calls, 3);

    const thrower = await page.waitFor(async () => { throw new Error('renderer busy'); }, { timeoutMs: 5, intervalMs: 1 });
    assert.equal(thrower, null, 'a throwing predicate times out rather than escaping');
  }, { browser });
});

test('getCookies keeps only the site asked for, and never the rest of the jar', async () => {
  const cdp = createChromeCdp({});
  const browser = browserStub({
    'Storage.getCookies': () => ({
      cookies: [
        { name: 'sid', value: 'a', domain: '.qoder.com.cn' },
        { name: 'api', value: 'b', domain: 'api.qoder.com.cn' },
        { name: 'bank', value: 'SECRET', domain: 'bank.example' },
        { name: 'lookalike', value: 'c', domain: 'qoder.com.cn.evil.example' },
      ],
    }),
  });

  const cookies = await cdp.getCookies('qoder.com.cn', { browser });
  assert.deepEqual(cookies.map((c) => c.name), ['sid', 'api']);
  assert.equal(browser.closed, false, 'a borrowed browser stays open for the caller');
});

test('getCookies tolerates a browser that answers with nothing', async () => {
  const cdp = createChromeCdp({});
  const browser = browserStub({ 'Storage.getCookies': () => ({}) });
  assert.deepEqual(await cdp.getCookies('qoder.com.cn', { browser }), []);
});
