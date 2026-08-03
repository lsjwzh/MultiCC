'use strict';

// Talking to a browser that holds the user's login.
//
// Several vendors publish subscription usage only to a logged-in web session —
// no token API — so the quota routes need a browser that has the user's
// cookies. Reaching one means CDP, and CDP means the browser was started with
// remote debugging on: a Chrome launched normally answers 404 on /json/version
// and silently drops WebSocket upgrades, whatever else may be listening.
// (Measured, Chrome 150: a debug-enabled instance answers 200 there. Do not
// read a bound socket, or a leftover DevToolsActivePort, as proof of one.)
//
// What this does remove is the fixed port. The old code hardcoded 9222 and told
// the user to launch Chrome with `--remote-debugging-port=9222`, which is both
// a number they have no reason to want and a flag recent Chrome refuses on the
// default profile. But Chrome writes whatever port it ended up on, plus the
// browser-level target id, into `DevToolsActivePort` at the root of its
// user-data directory:
//
//     58142
//     /devtools/browser/5a1342d3-4bcd-43d6-9651-fc6967b5e9f9
//
// So `--remote-debugging-port=0` on a profile of the user's choosing is enough:
// we read the file and find them. That is the answer to "every user's port is
// different, and it may not be up at all" — the file names the current one, and
// its absence is a clean negative.
//
// A fixed port is still probed first, for anyone who deliberately runs a debug
// browser on one. And because a `DevToolsActivePort` outlives the browser that
// wrote it, a candidate is only believed once a real connection answers
// `Browser.getVersion`.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORTS = [9222];
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const WS_OPTIONS = { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 };

class ChromeUnavailableError extends Error {
  constructor(message, tried) {
    super(message);
    this.name = 'ChromeUnavailableError';
    // Routes surface this verbatim to the frontend, which decides what to tell
    // the user, so the code is part of the contract.
    this.code = 'chrome_unavailable';
    this.tried = Array.isArray(tried) ? tried : [];
  }
}

// Where each Chromium-family browser keeps its user-data root. We check them
// all rather than asking the user which browser they use — the file either
// exists and names a live port, or it does not.
function defaultProfileDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      path.join(base, 'Google', 'Chrome'),
      path.join(base, 'Google', 'Chrome Beta'),
      path.join(base, 'Google', 'Chrome Canary'),
      path.join(base, 'Chromium'),
      path.join(base, 'Microsoft Edge'),
      path.join(base, 'BraveSoftware', 'Brave-Browser'),
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    ];
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(config, 'google-chrome'),
    path.join(config, 'chromium'),
    path.join(config, 'microsoft-edge'),
    path.join(config, 'BraveSoftware', 'Brave-Browser'),
  ];
}

function parseDevToolsActivePort(raw) {
  const lines = String(raw == null ? '' : raw).split('\n');
  const port = Number(String(lines[0] || '').trim());
  const wsPath = String(lines[1] || '').trim();
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!wsPath.startsWith('/devtools/')) return null;
  return { port, path: wsPath };
}

// A cookie domain is `qoder.com.cn` or `.qoder.com.cn`; both belong to the site
// we asked for, and so does any subdomain of it.
function cookieDomainMatches(cookieDomain, site) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const s = String(site || '').replace(/^\./, '').toLowerCase();
  if (!d || !s) return false;
  return d === s || d.endsWith(`.${s}`);
}

function httpJson(host, port, endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: endpoint, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('non-JSON response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createChromeCdp(options = {}) {
  const {
    host = DEFAULT_HOST,
    ports = DEFAULT_PORTS,
    profileDirs = defaultProfileDirs(),
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    readFile = (file) => fs.promises.readFile(file, 'utf8'),
    probeDebugPort = (h, p) => httpJson(h, p, '/json/version', connectTimeoutMs),
    openSocket = (url) => new WebSocket(url, WS_OPTIONS),
    now = () => Date.now(),
  } = options;

  // Candidates in preference order, without connecting to any of them.
  async function discover() {
    const found = [];
    const tried = [];
    for (const port of ports) {
      const detail = `${host}:${port}`;
      try {
        const info = await probeDebugPort(host, port);
        if (info && info.webSocketDebuggerUrl) {
          found.push({ source: 'debug-port', detail, wsUrl: info.webSocketDebuggerUrl });
        } else {
          tried.push({ source: 'debug-port', detail, reason: 'no webSocketDebuggerUrl' });
        }
      } catch (err) {
        tried.push({ source: 'debug-port', detail, reason: err.message });
      }
    }
    for (const dir of profileDirs) {
      const file = path.join(dir, 'DevToolsActivePort');
      let raw;
      try { raw = await readFile(file); }
      catch (_) { tried.push({ source: 'profile', detail: dir, reason: 'no DevToolsActivePort' }); continue; }
      const parsed = parseDevToolsActivePort(raw);
      if (!parsed) { tried.push({ source: 'profile', detail: dir, reason: 'unparsable DevToolsActivePort' }); continue; }
      found.push({ source: 'profile', detail: dir, wsUrl: `ws://${host}:${parsed.port}${parsed.path}` });
    }
    return { found, tried };
  }

  function openBrowserSocket(candidate) {
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = openSocket(candidate.wsUrl); }
      catch (err) { reject(err); return; }

      const pending = new Map();
      const listeners = new Set();
      let nextId = 0;
      let opened = false;

      const timer = setTimeout(() => {
        if (opened) return;
        try { socket.close(); } catch (_) {}
        reject(new Error('connect timeout'));
      }, connectTimeoutMs);

      // Settling a command always goes through here, so its timeout dies with
      // it — an un-cleared timer would keep the event loop alive for the whole
      // command budget after the work is done.
      function settle(id, apply) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        apply(entry);
      }

      function fail(err) {
        for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(err));
      }

      socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch (_) { return; }
        if (message.id && pending.has(message.id)) {
          settle(message.id, (entry) => {
            if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
            else entry.resolve(message.result);
          });
          return;
        }
        for (const listener of listeners) {
          try { listener(message); } catch (_) {}
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        fail(err);
        if (opened) return;
        // Nobody upstream has a handle to this socket yet, so hanging it up is
        // ours to do — attach() walks straight on to the next candidate.
        try { socket.close(); } catch (_) {}
        reject(err);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        fail(new Error('CDP socket closed'));
      });
      socket.on('open', () => {
        opened = true;
        clearTimeout(timer);
        resolve({
          source: candidate.source,
          detail: candidate.detail,
          wsUrl: candidate.wsUrl,
          send(method, params, sessionId) {
            const id = ++nextId;
            const frame = { id, method, params: params || {} };
            if (sessionId) frame.sessionId = sessionId;
            return new Promise((resolveSend, rejectSend) => {
              const entry = { resolve: resolveSend, reject: rejectSend, timer: null };
              pending.set(id, entry);
              try { socket.send(JSON.stringify(frame)); }
              catch (err) { pending.delete(id); rejectSend(err); return; }
              entry.timer = setTimeout(() => {
                settle(id, () => rejectSend(new Error(`CDP timeout: ${method}`)));
              }, commandTimeoutMs);
            });
          },
          on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close() { try { socket.close(); } catch (_) {} },
        });
      });
    });
  }

  // Connect to the first candidate that actually answers. A stale
  // DevToolsActivePort left behind by a closed browser looks identical on disk
  // to a live one, so the handshake is the only honest test.
  async function attach() {
    const { found, tried } = await discover();
    for (const candidate of found) {
      let browser = null;
      try {
        browser = await openBrowserSocket(candidate);
        await browser.send('Browser.getVersion');
        return browser;
      } catch (err) {
        if (browser) browser.close();
        tried.push({ source: candidate.source, detail: candidate.detail, reason: err.message });
      }
    }
    throw new ChromeUnavailableError('no reachable Chrome DevTools endpoint', tried);
  }

  function makePage(browser, sessionId) {
    const responses = [];
    const off = browser.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method !== 'Network.responseReceived') return;
      const response = message.params && message.params.response;
      responses.push({
        requestId: message.params.requestId,
        url: (response && response.url) || '',
        status: response && response.status,
      });
    });
    const send = (method, params) => browser.send(method, params, sessionId);
    return {
      sessionId,
      responses,
      send,
      dispose: off,
      enable: (domains) => Promise.all(domains.map((domain) => send(`${domain}.enable`, {}))),
      navigate: (url) => send('Page.navigate', { url }),
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true });
        return result && result.result ? result.result.value : undefined;
      },
      async responseBody(requestId) {
        const body = await send('Network.getResponseBody', { requestId });
        if (!body) return '';
        return body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      },
      findResponse: (predicate) => responses.find(predicate),
      // Poll until `predicate` returns something truthy, or give up. Returns
      // null on timeout so callers can report *why* nothing was found rather
      // than turning every slow page into an exception.
      async waitFor(predicate, { timeoutMs = commandTimeoutMs, intervalMs = 600 } = {}) {
        const deadline = now() + timeoutMs;
        for (;;) {
          let hit = null;
          try { hit = await predicate(); } catch (_) { hit = null; }
          if (hit) return hit;
          if (now() >= deadline) return null;
          await delay(intervalMs);
        }
      },
    };
  }

  // Run `fn` against a throwaway tab in the user's browser, and take the tab
  // away again afterwards whatever happens — leaving stray tabs in someone's
  // own browser is the fastest way to make this feature unwelcome.
  async function withPage(fn, { url = 'about:blank', browser = null } = {}) {
    const owned = !browser;
    const session = browser || await attach();
    let targetId = null;
    let page = null;
    try {
      const created = await session.send('Target.createTarget', { url, background: true });
      targetId = created && created.targetId;
      if (!targetId) throw new Error('Target.createTarget returned no targetId');
      const attached = await session.send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attached && attached.sessionId;
      if (!sessionId) throw new Error('Target.attachToTarget returned no sessionId');
      page = makePage(session, sessionId);
      return await fn(page);
    } finally {
      if (page) page.dispose();
      if (targetId) { try { await session.send('Target.closeTarget', { targetId }); } catch (_) {} }
      if (owned) session.close();
    }
  }

  // Cookies for one site, without opening a tab. `Network.getCookies` needs a
  // page session; at browser level Chrome only offers the whole jar, so we take
  // it and immediately keep just the domain we were asked for. Nothing else is
  // returned, persisted or logged.
  async function getCookies(site, { browser = null } = {}) {
    const owned = !browser;
    const session = browser || await attach();
    try {
      const result = await session.send('Storage.getCookies', {});
      const all = (result && Array.isArray(result.cookies)) ? result.cookies : [];
      return all.filter((cookie) => cookieDomainMatches(cookie.domain, site));
    } finally {
      if (owned) session.close();
    }
  }

  return { discover, attach, withPage, getCookies };
}

// Env overrides exist so a user with an unusual setup (a debug browser on
// another port, a profile somewhere we don't guess) can point us at it.
function portsFromEnv(env = process.env, extra = []) {
  const raw = String(env.MULTICC_CHROME_CDP_PORTS || '').split(',');
  const parsed = raw.concat(extra).map((value) => Number(String(value).trim())).filter(
    (value) => Number.isInteger(value) && value > 0 && value <= 65535,
  );
  const unique = [...new Set(parsed)];
  return unique.length ? unique : DEFAULT_PORTS;
}

function profileDirsFromEnv(env = process.env) {
  const extra = String(env.MULTICC_CHROME_PROFILE_DIRS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  return extra.concat(defaultProfileDirs(process.platform, env));
}

module.exports = {
  createChromeCdp,
  defaultProfileDirs,
  parseDevToolsActivePort,
  cookieDomainMatches,
  portsFromEnv,
  profileDirsFromEnv,
  ChromeUnavailableError,
  DEFAULT_PORTS,
};
