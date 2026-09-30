'use strict';

// The mbrowser daemon is the resident half of the executor: it owns the one CDP
// connection, the tab→owner map and the socket the CLI talks to. This file
// drives it end to end against a fake CDP server (the repo's `ws`, test-only
// here) so the whole protocol is exercised without launching Chrome:
//
//   CLI process → unix socket (0600) → daemon → WebSocket → fake Chrome
//
// The fake browser lives in this process, so the CLI is spawned asynchronously:
// a synchronous spawn would block the event loop and the daemon's HTTP probe of
// /json/version would time out. Everything (state dir, profile root,
// screenshots) lives under a temp root, so no real profile, cookie or browser
// is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const MBROWSER = path.join(ROOT, 'skills', 'multicc-browser', 'bin', 'mbrowser');
const DAEMON = path.join(ROOT, 'skills', 'multicc-browser', 'lib', 'daemon.js');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-daemon-'));
// The paths helper reads the environment lazily, but every child we spawn must
// see the same roots, so pin them on this process (and through it, on ENV).
process.env.MULTICC_DATA_DIR = path.join(TEMP, 'state');
process.env.MBROWSER_PROFILES_DIR = path.join(TEMP, 'profiles');
process.env.MBROWSER_PROFILE = '';
process.env.MULTICC_SESSION_ID = 'session-under-test';
delete process.env.MBROWSER_CHROME;

const P = require(path.join(ROOT, 'skills', 'multicc-browser', 'lib', 'paths'));

const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };
const PROFILE = 'fake';
const OWNER = 'session-under-test';

// A real 1x1 PNG: the screenshot action writes bytes verbatim, so the test can
// check the signature instead of trusting the fake.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------- fake chrome

// A tiny Chromium stand-in. It answers the CDP methods the executor uses, keeps
// a page model good enough for snapshot/click/type, and can emit the events a
// real browser would (targets appearing, frames navigating, dialogs opening).
async function createFakeChrome() {
  const page = { url: 'about:blank', title: 'Fake page', readyState: 'complete', body: 'Hello fake page', value: '' };
  const targets = new Map([['T1', { targetId: 'T1', type: 'page', url: 'about:blank', title: 'Fake page', attached: false }]]);
  const state = {
    page,
    targets,
    ax: [
      { nodeId: 1, role: 'RootWebArea', name: 'Fake page', childIds: [2, 3, 4, 5] },
      { nodeId: 2, role: 'heading', name: 'Fake page', parentId: 1, backendDOMNodeId: 101, properties: [{ name: 'level', value: { value: 1 } }] },
      { nodeId: 3, role: 'textbox', name: 'Name', parentId: 1, backendDOMNodeId: 102, value: { value: '' } },
      { nodeId: 4, role: 'button', name: 'Submit', parentId: 1, backendDOMNodeId: 103 },
      { nodeId: 5, role: 'link', name: 'Popup', parentId: 1, backendDOMNodeId: 104 },
    ],
    calls: [],
    input: [],
    sessions: [],
    sockets: new Set(),
    dialog: null,
    protocolErrors: new Map(),
  };
  let nextTargetId = 2;

  const axNodes = () => state.ax.map(entry => ({
    ...entry,
    role: { value: entry.role },
    name: { value: entry.name },
    ...(entry.childIds ? { childIds: [...entry.childIds] } : {}),
    ...(entry.properties ? { properties: entry.properties.map(item => ({ ...item })) } : {}),
    ...(entry.value ? { value: { ...entry.value } } : {}),
  }));
  const nodeFor = backendNodeId => state.ax.find(entry => entry.backendDOMNodeId === Number(backendNodeId)) || null;
  const value = (text, type = typeof text) => ({ result: { type, value: text } });

  function evaluate(expression) {
    if (/^\s*throw\b/.test(expression)) {
      const thrown = expression.replace(/^\s*throw\s*/, '').replace(/;\s*$/, '');
      return { exceptionDetails: { exception: { description: thrown }, text: 'Uncaught' } };
    }
    if (expression === 'document.readyState') return value(page.readyState);
    if (expression === 'location.href') return value(page.url);
    if (expression.includes('title: document.title')) return value({ title: page.title, href: page.url });
    if (expression.startsWith('(document.body ? document.body.innerText : "")')) {
      const wanted = expression.match(/\.includes\((".*")\)/);
      if (wanted) return value(page.body.includes(JSON.parse(wanted[1])));
      return value(page.body);
    }
    if (expression === 'document.body ? document.body.innerText : ""') return value(page.body);
    if (expression.startsWith('document.querySelector(')) {
      const selector = JSON.parse(expression.slice('document.querySelector('.length).split(')')[0]);
      return value(selector !== '#missing');
    }
    if (expression.includes('sx:window.scrollX')) return value({ sx: 0, sy: 0, w: 800, h: 600 });
    if (expression === '({x:window.scrollX,y:window.scrollY})') return value({ x: 0, y: 0 });
    if (/^window\.scrollBy\(/.test(expression)) return value(0);
    // `mbrowser eval 1+1`: digits and operators only, never arbitrary code.
    if (/^[-+*/%(). \d]+$/.test(expression)) {
      // eslint-disable-next-line no-new-func
      return value(new Function(`return (${expression});`)());
    }
    return value(null);
  }

  function callFunction(params) {
    const declaration = String(params.functionDeclaration || '');
    const node = nodeFor(String(params.objectId || '').replace(/^obj-/, ''));
    if (declaration.includes('getBoundingClientRect')) {
      return value({ x: 10, y: 20, width: 100, height: 20, pageX: 10, pageY: 20, sx: 0, sy: 0 });
    }
    if (declaration.includes('this.click()')) {
      state.input.push({ type: 'jsClick', node: node && node.name });
      return value(true);
    }
    if (declaration.includes('contextmenu')) {
      state.input.push({ type: 'jsContextMenu', node: node && node.name });
      return value(true);
    }
    if (declaration.includes('isContentEditable')) {
      page.value = '';
      return value({ contentEditable: false });
    }
    if (declaration.includes("const tag = (this.tagName || '').toUpperCase()")) {
      return value({ unsupported: true, role: node ? node.role : 'unknown' });
    }
    if (declaration.includes('innerText || this.value')) return value(page.value || 'element text');
    if (declaration.includes('toUpperCase()==="INPUT"')) return value(false);
    if (declaration.includes('this.focus()')) return value(true);
    return value(null);
  }

  function handle(method, params = {}) {
    state.calls.push(method);
    const failure = state.protocolErrors.get(method);
    if (failure) return { __error: { code: -32000, message: failure } };
    switch (method) {
      case 'Target.setDiscoverTargets': return {};
      case 'Target.setAutoAttach': return {};
      case 'Target.getTargets': return { targetInfos: [...targets.values()] };
      case 'Target.createTarget': {
        const targetId = `T${nextTargetId}`;
        nextTargetId += 1;
        const info = { targetId, type: 'page', url: params.url || 'about:blank', title: params.url || 'about:blank', attached: false };
        targets.set(targetId, info);
        emit('Target.targetCreated', { targetInfo: info });
        return { targetId };
      }
      case 'Target.closeTarget': {
        targets.delete(params.targetId);
        emit('Target.targetDestroyed', { targetId: params.targetId });
        return { success: true };
      }
      case 'Target.attachToTarget': {
        const sessionId = `S${state.sessions.length + 1}`;
        state.sessions.push({ sessionId, targetId: params.targetId });
        return { sessionId };
      }
      case 'Page.enable':
      case 'Runtime.enable':
      case 'DOM.enable':
      case 'Accessibility.enable':
      case 'Network.enable':
      case 'Emulation.setFocusEmulationEnabled':
      case 'Page.setLifecycleEventsEnabled':
      case 'DOM.focus':
      case 'DOM.scrollIntoViewIfNeeded':
      case 'DOM.setFileInputFiles':
        return {};
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'F1', loaderId: 'L1', url: page.url, name: '' } } };
      case 'Page.navigate':
        page.url = params.url;
        page.title = params.url;
        return { frameId: 'F1', loaderId: 'L1' };
      case 'Page.getNavigationHistory': {
        const entries = ['about:blank', page.url].map((url, index) => ({ id: index + 1, url }));
        return { currentIndex: entries.length - 1, entries };
      }
      case 'Page.navigateToHistoryEntry': {
        const entries = ['about:blank', page.url];
        page.url = entries[Number(params.entryId) - 1] || page.url;
        return {};
      }
      case 'Page.captureScreenshot': return { data: PNG };
      case 'Page.getLayoutMetrics':
        return { cssContentSize: { width: 800, height: 600 }, contentSize: { width: 800, height: 600 } };
      case 'Page.handleJavaScriptDialog':
        state.dialog = params;
        emit('Page.javascriptDialogClosed', { result: Boolean(params.accept), userInput: '' });
        return {};
      case 'Browser.getVersion': return { product: 'FakeChrome/1.0.0', protocolVersion: '1.3' };
      case 'Browser.close': return {};
      case 'Runtime.evaluate': return evaluate(String(params.expression || ''));
      case 'Runtime.callFunctionOn': return callFunction(params);
      case 'DOM.resolveNode': {
        const node = nodeFor(params.backendNodeId);
        if (!node) return { __error: { code: -32000, message: 'No node with given id found' } };
        return { object: { objectId: `obj-${node.backendDOMNodeId}` } };
      }
      case 'DOM.getContentQuads':
        return { quads: [[10, 20, 110, 20, 110, 40, 10, 40]] };
      case 'Input.dispatchMouseEvent': state.input.push(params); return {};
      case 'Input.insertText':
        page.value += String(params.text || '');
        state.input.push({ type: 'insertText', text: params.text });
        return {};
      case 'Input.dispatchKeyEvent': state.input.push(params); return {};
      case 'Accessibility.getFullAXTree': return { nodes: axNodes() };
      default: return {};
    }
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        Browser: 'FakeChrome/1.0.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
      }));
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request));
  });
  wss.on('connection', client => {
    state.sockets.add(client);
    client.on('close', () => state.sockets.delete(client));
    client.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
      const result = handle(message.method, message.params);
      const reply = { id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
      if (result && result.__error) reply.error = result.__error;
      else reply.result = result || {};
      try { client.send(JSON.stringify(reply)); } catch (_) { /* client went away */ }
    });
  });

  function emit(method, params, sessionId) {
    const payload = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) });
    for (const client of state.sockets) {
      try { client.send(payload); } catch (_) { /* ignore */ }
    }
  }

  // A browser pushes a page event to each attached session; the daemon compares
  // the sessionId against the tab it belongs to, so broadcasting per session is
  // what reaches every listener.
  state.emitForSessions = (method, params) => {
    for (const session of state.sessions) emit(method, params, session.sessionId);
    emit(method, params);
  };

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      cdpUrl: `http://127.0.0.1:${server.address().port}`,
      async close() {
        for (const client of state.sockets) { try { client.terminate(); } catch (_) { /* ignore */ } }
        await new Promise(done => wss.close(done));
        await new Promise(done => server.close(done));
      },
    }));
  });
}

// ------------------------------------------------------------------- harness

function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [MBROWSER, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 90000);
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function runOk(args) {
  const result = await run(args);
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function json(args) {
  return JSON.parse((await runOk([...args, '--json'])).stdout);
}

// Any process of ours still around: a daemon for this profile, or a browser
// whose command line names our temp profile root. COLUMNS keeps ps from
// truncating the command line on a narrow terminal.
function leftoverProcesses() {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid,command'],
      { encoding: 'utf8', env: { ...ENV, COLUMNS: '2000' } });
  } catch (_) { return []; }
  return output.split('\n')
    .map(line => line.trim())
    .filter(line => line && (line.includes(TEMP)
      || line.includes(DAEMON)
      || line.includes(`daemon.js ${PROFILE}`)));
}

async function waitForGone(pids, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.filter(pid => {
      try { process.kill(pid, 0); return true; } catch (_) { return false; }
    });
    if (!alive.length) return [];
    if (Date.now() > deadline) return alive;
    await sleep(100);
  }
}

// A port nothing listens on: bind, take the number, release — connecting to it
// is refused, which is how a stale --cdp-url behaves.
function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('the daemon drives a browser over the socket and shuts down cleanly', async t => {
  const chrome = await createFakeChrome();
  const startedPids = [];
  t.after(async () => {
    await run(['stop', '--all']);
    await waitForGone(startedPids);
    await chrome.close();
    fs.rmSync(TEMP, { recursive: true, force: true });
  });

  // ---- attach: the daemon must never launch or kill a browser it does not own.
  const attached = await json(['attach', PROFILE, '--cdp-url', chrome.cdpUrl]);
  assert.equal(attached.status.attachOnly, true);
  assert.equal(attached.status.cdpUrl, chrome.cdpUrl);
  assert.equal(attached.status.owned, false);
  assert.equal(attached.status.chromePid, null);
  assert.equal(attached.status.state, 'ready');

  const ping = await json(['ping', '-p', PROFILE]);
  assert.equal(ping.pong, true);
  assert.equal(ping.profile, PROFILE);
  assert.equal(ping.attachOnly, true);
  assert.equal(ping.state, 'ready');
  assert.equal(typeof ping.pid, 'number');
  assert.equal(typeof ping.version, 'string');
  startedPids.push(ping.pid);

  // Pointing the profile at another browser must retire the daemon holding the
  // old one: a daemon answers for the endpoint it booted with, so keeping it
  // would report the previous browser as the new one.
  const chrome2 = await createFakeChrome();
  t.after(() => chrome2.close());
  const moved = await json(['attach', PROFILE, '--cdp-url', chrome2.cdpUrl]);
  assert.equal(moved.retired.keepChrome, true, 'an attach-only daemon never stops the browser it borrowed');
  assert.equal(moved.retired.cdpUrl, chrome.cdpUrl);
  assert.equal(moved.ping.cdpUrl, chrome2.cdpUrl);
  assert.equal(moved.ping.owned, false);
  startedPids.push(moved.ping.pid);

  // An endpoint that is not there fails loudly instead of falling back to the
  // browser we used to be attached to.
  const deadPort = await freePort();
  const badAttach = await run(['attach', PROFILE, '--cdp-url', `http://127.0.0.1:${deadPort}`]);
  assert.equal(badAttach.status, 1, badAttach.stdout);
  assert.equal(badAttach.stdout.includes('attached to'), false, 'the old browser is not reported as the new one');
  assert.equal((await json(['status', '-p', PROFILE])).running, false,
    'the retired daemon is not left answering for the old endpoint');

  // Attaching back to a live browser works, and the rest of the run uses it.
  const reAttached = await json(['attach', PROFILE, '--cdp-url', chrome.cdpUrl]);
  assert.equal(reAttached.retired, null, 'nothing is running to retire');
  assert.equal(reAttached.ping.cdpUrl, chrome.cdpUrl);
  assert.equal(reAttached.ping.owned, false);
  startedPids.push(reAttached.ping.pid);

  // ---- socket permissions: only the owning user may talk to the daemon.
  const socketPath = P.socketPath(PROFILE);
  const socketStat = fs.statSync(socketPath);
  // eslint-disable-next-line no-bitwise
  assert.equal(socketStat.mode & 0o777, 0o600, `${socketPath} must be 0600`);
  assert.equal(socketStat.isSocket(), true);
  // eslint-disable-next-line no-bitwise
  assert.equal(fs.statSync(P.runDir()).mode & 0o777, 0o700);

  // ---- exactly one browser-level CDP connection, no per-command churn.
  assert.equal(chrome.state.sockets.size, 1);

  // ---- open: a session gets its own tab and navigates it.
  const opened = await json(['open', 'https://example.test/', '-p', PROFILE]);
  assert.equal(opened.url, 'https://example.test/');
  assert.equal(opened.loaded, true);
  assert.equal(chrome.state.calls.includes('Target.createTarget'), true);
  assert.equal(chrome.state.sessions[0].targetId, 'T2');

  const firstTabs = await json(['tabs', '-p', PROFILE]);
  const mine = firstTabs.tabs.filter(tab => tab.owner === OWNER);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].current, true);
  assert.equal(mine[0].url, 'https://example.test/');
  // A tab this session never created is listed but not adopted.
  assert.equal(firstTabs.tabs.find(tab => tab.id === 'T1').owner, null);

  // ---- snapshot: an AX tree with refs, resolved daemon-side.
  const snapshot = await json(['snapshot', '-p', PROFILE]);
  assert.match(snapshot.text, /^page: https:\/\/example\.test\/ — https:\/\/example\.test\/ {2}\[tab T2\]$/m);
  assert.match(snapshot.text, /^- heading "Fake page" \[level=1\]$/m);
  assert.equal(snapshot.refs, 3);
  assert.equal(snapshot.url, 'https://example.test/');
  const refOf = (text, role, name) => {
    const match = new RegExp(`${role} "${name}" \\[(e\\d+)\\]`).exec(text);
    assert.ok(match, `${role} "${name}" has no ref in:\n${text}`);
    return match[1];
  };
  const textboxRef = refOf(snapshot.text, 'textbox', 'Name');
  const buttonRef = refOf(snapshot.text, 'button', 'Submit');
  assert.ok(refOf(snapshot.text, 'link', 'Popup'));

  const interactive = await json(['snapshot', '--interactive', '-p', PROFILE]);
  assert.equal(interactive.text.split('\n').length, 3);
  assert.match(interactive.text, new RegExp(`textbox "Name" \\[${textboxRef}\\]`));

  // ---- click: a real mouse press at the element's centre, not a JS shim.
  chrome.state.input.length = 0;
  const clicked = await json(['click', buttonRef, '-p', PROFILE]);
  assert.match(clicked.text, /ok at 60,30/);
  const pressed = chrome.state.input.find(event => event.type === 'mousePressed');
  assert.deepEqual([pressed.x, pressed.y, pressed.button, pressed.clickCount], [60, 30, 'left', 1]);
  assert.equal(chrome.state.input.some(event => event.type === 'jsClick'), false);

  chrome.state.input.length = 0;
  await json(['click', '--xy', '5', '6', '-p', PROFILE]);
  const atXy = chrome.state.input.find(event => event.type === 'mousePressed');
  assert.deepEqual([atXy.x, atXy.y], [5, 6]);

  // ---- type: focus, clear, insert, submit.
  chrome.state.input.length = 0;
  const typed = await json(['type', textboxRef, 'hello world', '--clear', '--submit', '-p', PROFILE]);
  assert.match(typed.text, new RegExp(`^type ${textboxRef} ok \\(11 chars\\) \\[cleared, submitted\\]`));
  assert.equal(chrome.state.page.value, 'hello world');
  assert.deepEqual(chrome.state.input.filter(event => event.type === 'insertText').map(event => event.text),
    ['hello world']);
  const enter = chrome.state.input.find(event => event.type === 'keyDown' && event.key === 'Enter');
  assert.equal(enter.text, '\r');

  // ---- press, select, text and eval.
  assert.match((await json(['press', 'ctrl+a', '-p', PROFILE])).text, /^press ctrl\+a ok \(modifiers=2/);
  const notSelect = await run(['select', textboxRef, 'one', '-p', PROFILE]);
  assert.equal(notSelect.status, 1);
  assert.match(notSelect.stderr, /unsupported/);
  assert.equal((await json(['text', '-p', PROFILE])).text, 'Hello fake page');
  const evaluated = await json(['eval', '1+1', '-p', PROFILE]);
  assert.equal(evaluated.value, 2);
  assert.equal(evaluated.text, '2');
  const threw = await run(['eval', 'throw new Error("nope")', '-p', PROFILE]);
  assert.equal(threw.status, 1);
  assert.match(threw.stderr, /js_error/);

  // ---- wait: selector and text, with a miss reported as a timeout.
  assert.match((await json(['wait', '--selector', '#present', '--timeout', '5', '-p', PROFILE])).text,
    /^wait ok \(selector #present\)/);
  assert.match((await json(['wait', '--text', 'Hello', '--timeout', '5', '-p', PROFILE])).text, /wait ok/);
  const timedOut = await run(['wait', '--selector', '#missing', '--timeout', '1', '-p', PROFILE]);
  assert.equal(timedOut.status, 1);
  assert.match(timedOut.stderr, /timeout/);

  // ---- dialogs: an opening dialog is reported and can be accepted.
  chrome.state.emitForSessions('Page.javascriptDialogOpening',
    { type: 'alert', message: 'hi there', url: 'https://example.test/' });
  await sleep(200);
  const dialog = await json(['dialog', 'accept', '-p', PROFILE]);
  assert.equal(dialog.type, 'alert');
  assert.equal(dialog.message, 'hi there');
  assert.match(dialog.text, /^dialog accept — alert: hi there$/);
  assert.deepEqual(chrome.state.dialog, { accept: true });
  const withoutDialog = await run(['dialog', 'dismiss', '-p', PROFILE]);
  assert.equal(withoutDialog.status, 1);
  assert.match(withoutDialog.stderr, /no_dialog/);

  // ---- screenshot and history.
  const shot = path.join(TEMP, 'shot.png');
  const screenshot = await json(['screenshot', shot, '-p', PROFILE]);
  assert.equal(screenshot.path, shot);
  assert.ok(screenshot.bytes > 0);
  assert.equal(fs.readFileSync(shot).subarray(0, 4).toString('hex'), '89504e47');
  const full = await json(['screenshot', path.join(TEMP, 'full.png'), '--full', '-p', PROFILE]);
  assert.ok(full.bytes > 0);
  const forward = await run(['forward', '-p', PROFILE]);
  assert.equal(forward.status, 1, 'a single-entry history has no next page');
  assert.match(forward.stderr, /no_history/);
  assert.match((await json(['back', '-p', PROFILE])).text, /^back ok/);

  // ---- popups: a tab opened by our tab is ours, and its owner is told.
  chrome.state.emitForSessions('Target.targetCreated', {
    targetInfo: {
      targetId: 'T9', type: 'page', url: 'https://example.test/popup',
      title: 'Popup', openerId: 'T2',
    },
  });
  chrome.state.targets.set('T9', {
    targetId: 'T9', type: 'page', url: 'https://example.test/popup', title: 'Popup', openerId: 'T2',
  });
  await sleep(200);
  const afterPopup = await json(['tabs', '-p', PROFILE]);
  const popup = afterPopup.tabs.find(tab => tab.id === 'T9');
  assert.equal(popup.owner, OWNER);
  assert.equal(popup.current, true, 'the popup becomes the session current tab');
  assert.match(afterPopup.notice, /new tab opened/);
  // A tab nobody owns is never claimed just because something opened a popup.
  assert.equal(afterPopup.tabs.find(tab => tab.id === 'T1').owner, null);

  // ---- stale refs: a navigation invalidates a snapshot.
  chrome.state.emitForSessions('Page.frameNavigated',
    { frame: { id: 'F1', loaderId: 'L99', url: 'https://example.test/next' } });
  await sleep(150);
  chrome.state.ax = chrome.state.ax.filter(entry => entry.role !== 'button');
  const stale = await run(['click', buttonRef, '-p', PROFILE]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale_ref/);
  assert.match(stale.stderr, /snapshot/i);

  // A new snapshot is the cure, and an unknown ref is named as such.
  const fresh = await json(['snapshot', '-p', PROFILE]);
  assert.equal(fresh.refs, 2);
  assert.match((await run(['click', 'e999', '-p', PROFILE])).stderr, /stale_ref/);
  assert.match((await run(['tab', 'nosuchtab', '-p', PROFILE])).stderr, /no_target/);
  assert.match((await run(['close', 'nosuchtab', '-p', PROFILE])).stderr, /no_target/);

  // ---- close: a session closes its own tabs.
  const closed = await json(['close', 'T9', '-p', PROFILE]);
  assert.equal(closed.closed, true);
  assert.equal(chrome.state.calls.includes('Target.closeTarget'), true);

  // ---- a CDP-level failure is named, and the daemon keeps serving after it.
  chrome.state.protocolErrors.set('Page.getNavigationHistory', 'boom');
  const failed = await run(['back', '-p', PROFILE]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /cdp_error/);
  chrome.state.protocolErrors.clear();
  assert.equal((await json(['ping', '-p', PROFILE])).pong, true);

  // ---- stop: the daemon exits, the socket goes away, nothing is left behind.
  const stopped = await runOk(['stop', PROFILE]);
  assert.match(stopped.stdout, /daemon stopped/);
  assert.equal(fs.existsSync(socketPath), false, 'the socket file is removed on shutdown');
  assert.deepEqual(await waitForGone(startedPids), [], 'the daemon process exits');
  assert.equal(fs.existsSync(P.statePath(PROFILE)), false);

  // ---- a daemon that dies on boot reports why, instead of just its log path.
  const broken = await run(['start', 'broken', '--create', '--headless', '--mock-keychain',
    '--browser', path.join(TEMP, 'no-such-browser')]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /browser_missing/);
  assert.match(broken.stderr, /does not exist/);
  assert.equal(broken.stderr.includes('daemon_died'), false,
    'the boot failure recorded in the log is surfaced as the CLI error');

  assert.deepEqual(leftoverProcesses(), [], 'no mbrowser process or browser from this run survives');
});
