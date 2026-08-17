'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const DEFAULT_TIMEOUT_MS = 15_000;
const CHROME_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]);

class CdpUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdpUnavailableError';
    this.code = 'CDP_UNAVAILABLE';
  }
}

function findChromeBinary(env = process.env) {
  const configured = String(env.MULTICC_CHROME_BIN || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  return CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate)) || null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeName(value) {
  return String(value || 'failure').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'failure';
}

function parseActivePort(raw) {
  const [portLine, wsPathLine] = String(raw || '').split('\n');
  const port = Number(portLine);
  const wsPath = String(wsPathLine || '').trim();
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (!wsPath.startsWith('/devtools/browser/')) return null;
  return { port, wsPath };
}

class CdpConnection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.on('message', raw => this.#onMessage(raw));
    socket.on('close', () => this.#failPending(new Error('CDP socket closed')));
    socket.on('error', error => this.#failPending(error));
  }

  #onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    if (message.id != null && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP command failed'));
      else entry.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners) {
      try { listener(message); } catch (_) {}
    }
  }

  #failPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId = null) {
    const id = ++this.nextId;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify(frame)); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try { this.socket.close(); } catch (_) {}
  }
}

async function connect(wsUrl, timeoutMs) {
  const socket = new WebSocket(wsUrl, {
    perMessageDeflate: false,
    maxPayload: 32 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch (_) {}
      reject(new CdpUnavailableError('Chrome DevTools WebSocket timed out'));
    }, timeoutMs);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return new CdpConnection(socket, timeoutMs);
}

function responseSpec(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)
      && ('body' in value || 'status' in value || 'headers' in value)) {
    return {
      status: Number(value.status) || 200,
      headers: value.headers || {},
      body: value.body == null ? '' : value.body,
    };
  }
  return { status: 200, headers: {}, body: value == null ? '' : value };
}

async function startFixtureServer(routes = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({
      method: req.method,
      path: url.pathname,
      url: req.url,
      headers: { ...req.headers },
      body: body.toString('utf8'),
    });
    try {
      const route = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname];
      if (route == null) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const value = typeof route === 'function'
        ? await route({ req, url, body, requests })
        : route;
      const spec = responseSpec(value);
      const payload = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(String(spec.body));
      res.writeHead(spec.status, {
        'cache-control': 'no-store',
        'content-length': payload.length,
        ...spec.headers,
      });
      res.end(payload);
    } catch (error) {
      const payload = Buffer.from('fixture route failed');
      res.writeHead(500, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': payload.length,
      });
      res.end(payload);
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function waitForActivePort(profileDir, chrome, timeoutMs, stderrTail) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new CdpUnavailableError(`Chrome exited before CDP became ready: ${stderrTail()}`);
    }
    try {
      const parsed = parseActivePort(fs.readFileSync(file, 'utf8'));
      if (parsed) return parsed;
    } catch (_) {}
    await sleep(50);
  }
  throw new CdpUnavailableError(`Chrome did not create DevToolsActivePort: ${stderrTail()}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { child.kill('SIGTERM'); } catch (_) {}
  await Promise.race([exited, sleep(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch (_) {}
    await Promise.race([exited, sleep(1_000)]);
  }
}

async function createCdpHarness(options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const binary = options.chromeBinary || findChromeBinary(options.env);
  if (!binary) throw new CdpUnavailableError('Chrome/Chromium executable not found');

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cdp-test-'));
  const profileDir = path.join(rootDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  let fixture = null;
  let chrome = null;
  let connection = null;
  let targetId = null;
  let sessionId = null;
  let stderr = '';

  try {
    fixture = await startFixtureServer(options.routes || {});
    chrome = spawn(binary, [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4_000); });
    const active = await waitForActivePort(profileDir, chrome, timeoutMs, () => stderr.trim());
    connection = await connect(`ws://127.0.0.1:${active.port}${active.wsPath}`, timeoutMs);
    await connection.send('Browser.getVersion');
    const created = await connection.send('Target.createTarget', { url: 'about:blank', background: true });
    targetId = created.targetId;
    if (!targetId) throw new CdpUnavailableError('Chrome did not create a test target');
    const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;
    if (!sessionId) throw new CdpUnavailableError('Chrome did not attach the test target');
    const send = (method, params = {}) => connection.send(method, params, sessionId);
    await Promise.all([
      send('Page.enable'),
      send('Runtime.enable'),
      send('Network.enable'),
    ]);

    const harness = {
      baseUrl: fixture.baseUrl,
      requests: fixture.requests,
      rootDir,
      profileDir,
      send,
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', {
          expression: String(expression),
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) {
          const detail = result.exceptionDetails.exception?.description
            || result.exceptionDetails.text
            || 'browser evaluation failed';
          throw new Error(detail);
        }
        return result.result ? result.result.value : undefined;
      },
      async navigate(relativeOrAbsolute) {
        const url = new URL(relativeOrAbsolute, fixture.baseUrl).toString();
        await send('Page.navigate', { url });
        const ready = await this.waitFor('document.readyState === "complete"', { timeoutMs });
        if (!ready) throw new Error(`page did not finish loading: ${url}`);
        return url;
      },
      async waitFor(expression, waitOptions = {}) {
        const deadline = Date.now() + (Number(waitOptions.timeoutMs) || timeoutMs);
        const intervalMs = Number(waitOptions.intervalMs) || 50;
        while (Date.now() < deadline) {
          try {
            const value = await this.evaluate(expression);
            if (value) return value;
          } catch (_) {}
          await sleep(intervalMs);
        }
        return null;
      },
      async screenshot(fileName = 'failure.png') {
        const screenshotDir = options.screenshotDir || path.join(rootDir, 'screenshots');
        fs.mkdirSync(screenshotDir, { recursive: true });
        const file = path.join(
          screenshotDir,
          `${safeName(path.basename(fileName, path.extname(fileName)))}-${process.pid}-${Date.now()}.png`,
        );
        const captured = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(file, Buffer.from(captured.data, 'base64'));
        return file;
      },
      async screenshotOnFailure(label, operation) {
        try { return await operation(); }
        catch (error) {
          try { error.screenshotPath = await this.screenshot(label); } catch (_) {}
          throw error;
        }
      },
      async close() {
        if (connection && targetId) {
          try { await connection.send('Target.closeTarget', { targetId }); } catch (_) {}
        }
        if (connection) connection.close();
        connection = null;
        await stopProcess(chrome);
        chrome = null;
        if (fixture) await fixture.close();
        fixture = null;
        fs.rmSync(rootDir, { recursive: true, force: true });
      },
    };
    return harness;
  } catch (error) {
    if (connection) connection.close();
    await stopProcess(chrome);
    if (fixture) await fixture.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}

async function withCdpHarness(options, operation) {
  const harness = await createCdpHarness(options);
  try { return await operation(harness); }
  finally { await harness.close(); }
}

module.exports = {
  CdpUnavailableError,
  createCdpHarness,
  findChromeBinary,
  withCdpHarness,
};
