#!/usr/bin/env node
/**
 * Empirical mobile-viewport probe for the /manage left drawer (#nav).
 *
 * Drives a real headless Chrome over CDP (no puppeteer dependency — we speak the
 * protocol directly over the `ws` package the server already depends on), opens
 * the drawer at a matrix of phone viewports, and measures whether the bottom
 * action row (.nav-bottom / .nav-foot) and the restart button are actually
 * inside the visible viewport and hit-testable.
 *
 * This is a developer evidence tool, not part of `npm test` (it needs Chrome).
 * The pure-Node layout contract regression lives in
 * tests/test-manage-mobile-nav-layout.js.
 *
 * Usage:
 *   node scripts/measure-mobile-nav.js [--out DIR] [--url URL] [--label before]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

// iOS Safari / Android Chrome collapse their toolbars while scrolling, which is
// what makes the *dynamic* viewport dynamic. Each scenario is therefore measured
// twice: once with the toolbar showing (viewport shrunk by this much) and once
// with it collapsed (full height).
//
// The emulation shrinks the real viewport rather than subtracting a synthetic
// band after layout — that is exactly what the toolbar does to `innerHeight` and
// to `100dvh` on device, so the geometry we read back is the geometry the phone
// would lay out. Caveat worth stating plainly: headless Chrome has no browser
// chrome, so it cannot reproduce the one way `100vh` differs from `100dvh` —
// `vh` staying pinned to the LARGE viewport while the toolbar is out. This probe
// therefore treats a `vh`-sized drawer more kindly than a phone does, making
// every failure it reports a lower bound. The height ladder itself
// (vh → -webkit-fill-available → dvh) is pinned by the pure-Node contract test.
const TOOLBAR_PX = { ios: 92, android: 72 };

const SCENARIOS = [
  { id: '320x568-iphone-se1', width: 320, height: 568, dsf: 2, chrome: 'ios', note: '最小主流手机宽度' },
  { id: '360x640-android', width: 360, height: 640, dsf: 3, chrome: 'android', note: '主流 Android' },
  { id: '390x844-iphone14', width: 390, height: 844, dsf: 3, chrome: 'ios', note: 'iPhone 14, 有 home indicator', safeBottom: 34 },
  { id: '412x915-pixel7', width: 412, height: 915, dsf: 2.6, chrome: 'android', note: 'Pixel 7', safeBottom: 24 },
  { id: '740x360-landscape', width: 740, height: 360, dsf: 3, chrome: 'ios', note: '低高度横屏' },
  { id: '390x844-long-content', width: 390, height: 844, dsf: 3, chrome: 'ios', note: '内容列表很长', longContent: true, safeBottom: 34 },
  { id: '390x844-font-200', width: 390, height: 844, dsf: 3, chrome: 'ios', note: '系统字体放大 200%', fontScale: 2, safeBottom: 34 },
  { id: '360x640-en-locale', width: 360, height: 640, dsf: 3, chrome: 'android', note: '英文长文案', locale: 'en' },
  { id: '1440x900-desktop', width: 1440, height: 900, dsf: 2, chrome: null, note: '桌面对照(不得回退)', desktop: true },
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('No Chrome/Chromium binary found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/**
 * The long-running multicc server serves public/ from whichever worktree it was
 * started in — measuring http://127.0.0.1:3000/manage from inside a session
 * worktree silently probes SOMEONE ELSE'S copy of the file. This serves a chosen
 * public/ directory instead and proxies everything it does not have on disk
 * (/api/*, /multicc.apk, …) to the real server, so the page still boots with
 * live data while the HTML/CSS under test is the local one.
 */
function startStaticProxy(root, upstream) {
  return new Promise(resolve => {
    const up = new URL(upstream);
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/manage' ? '/manage.html'
        : urlPath === '/' ? '/index.html'
        : urlPath;
      const filePath = path.join(root, rel);
      if (filePath.startsWith(path.resolve(root)) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      const proxied = http.request({
        hostname: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers,
      }, pres => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
      });
      proxied.on('error', () => { res.writeHead(502); res.end('upstream unavailable'); });
      req.pipe(proxied);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function httpPut(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT',
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { return JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`)); }
    catch (err) { lastErr = err; await sleep(200); }
  }
  throw new Error('devtools not reachable: ' + (lastErr && lastErr.message));
}

/** Minimal CDP client: send(method, params) -> Promise<result>. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const handlers = this.events.get(msg.method) || [];
        this.events.set(msg.method, []);
        for (const h of handlers) h(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  once(method) {
    return new Promise(resolve => {
      const list = this.events.get(method) || [];
      list.push(resolve);
      this.events.set(method, list);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    }
    return r.result.value;
  }
}

/**
 * Runs inside the page. Returns geometry for the drawer, its bottom action row
 * and the restart button, plus a hit test at the button's centre.
 */
const MEASURE_JS = `(() => {
  const vv = window.visualViewport;
  const innerH = window.innerHeight;
  const innerW = window.innerWidth;
  const nav = document.getElementById('nav');
  const foot = document.querySelector('.nav-foot');
  const bottom = document.querySelector('.nav-bottom') || foot;
  const btn = document.getElementById('svc-restart-btn');
  const scroller = document.getElementById('nav-scroll');
  const rect = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
  };
  const cs = el => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return { position: s.position, overflowY: s.overflowY, height: s.height, maxHeight: s.maxHeight, minHeight: s.minHeight, flex: s.flex, paddingBottom: s.paddingBottom };
  };
  let hit = null;
  if (btn) {
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const el = (x >= 0 && y >= 0 && x <= innerW && y <= innerH) ? document.elementFromPoint(x, y) : null;
    hit = {
      point: { x: +x.toFixed(1), y: +y.toFixed(1) },
      inViewportPoint: x >= 0 && y >= 0 && x <= innerW && y <= innerH,
      hitsButton: !!(el && (el === btn || btn.contains(el))),
      hitTag: el ? (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]) : null,
    };
  }
  // Every interactive control in the bottom action row, each with its own centre
  // hit test. This — not the container's border box — is what "the action area is
  // visible and not obscured" means: .nav-bottom's padding-bottom IS the
  // safe-area reservation, so its padding box is *supposed* to extend under the
  // home indicator. Measuring the container would demand the inset twice.
  const actions = [...document.querySelectorAll('.nav-foot .hdr-btn')].map(el => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const inVp = x >= 0 && y >= 0 && x <= innerW && y <= innerH;
    const at = inVp ? document.elementFromPoint(x, y) : null;
    return {
      id: el.id || null,
      text: el.textContent.trim().slice(0, 20),
      rect: rect(el),
      hits: !!(at && (at === el || el.contains(at))),
      inViewportPoint: inVp,
    };
  });

  return {
    innerW, innerH,
    visualViewportH: vv ? +vv.height.toFixed(1) : null,
    navOpen: document.body.classList.contains('nav-open'),
    actions,
    nav: { rect: rect(nav), style: cs(nav), scrollH: nav ? nav.scrollHeight : null, clientH: nav ? nav.clientHeight : null },
    scroller: scroller ? { rect: rect(scroller), style: cs(scroller), scrollH: scroller.scrollHeight, clientH: scroller.clientHeight, scrollable: scroller.scrollHeight > scroller.clientHeight + 1 } : null,
    bottomRegion: { rect: rect(bottom), style: cs(bottom) },
    footRect: rect(foot),
    restartRect: rect(btn),
    restartText: btn ? btn.textContent.trim() : null,
    hit,
    navItemCount: document.querySelectorAll('#nav .nav-item').length,
  };
})()`;

/**
 * The viewport states a scenario is measured in. Phones get two: toolbar out
 * (the small viewport — the state the old drawer failed in) and toolbar
 * collapsed (the large viewport). Desktop has no dynamic chrome.
 */
function viewportStates(scenario) {
  if (scenario.desktop) return [{ id: 'desktop', height: scenario.height, toolbar: 0 }];
  const toolbar = TOOLBAR_PX[scenario.chrome];
  return [
    { id: 'toolbar-shown', height: scenario.height - toolbar, toolbar },
    { id: 'toolbar-hidden', height: scenario.height, toolbar: 0 },
  ];
}

async function runScenario(cdp, scenario, url, outDir, label, state) {
  const { width, dsf } = scenario;
  const height = state.height;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dsf, mobile: !scenario.desktop,
  });

  // Seed localStorage before any page script runs: suppress the first-run
  // onboarding modal (it covers the drawer and would ruin the screenshots) and
  // pick the locale so i18n applies at boot rather than after a repaint.
  if (scenario._priorScript) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scenario._priorScript });
  }
  const seeded = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{
      localStorage.setItem('multicc_onboard_done','1');
      localStorage.setItem('multicc_lang','${scenario.locale || 'zh'}');
    }catch(e){}`,
  });
  scenario._priorScript = seeded.identifier;

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(12000)]);
  await sleep(700); // let dashboard JS settle
  // setLang() can bounce the document; make sure <body> exists before we poke it.
  for (let i = 0; i < 40; i++) {
    if (await cdp.evaluate('!!document.body')) break;
    await sleep(150);
  }

  // Scenario knobs applied in-page.
  const prep = [];
  if (scenario.longContent) {
    // Long middle list: duplicate the nav items so the scroll area definitely
    // overflows, mirroring a workspace with many views.
    prep.push(`(() => {
      const host = document.getElementById('nav-scroll') || document.getElementById('nav');
      const items = [...document.querySelectorAll('#nav .nav-item')];
      const anchor = document.getElementById('version-bar') || document.querySelector('.nav-bottom') || document.querySelector('.nav-foot');
      for (let i = 0; i < 14; i++) for (const it of items.slice(0, 4)) {
        const c = it.cloneNode(true);
        if (anchor && anchor.parentNode === host) host.insertBefore(c, anchor); else host.appendChild(c);
      }
    })()`);
  }
  if (scenario.fontScale) {
    prep.push(`document.documentElement.style.fontSize = (16 * ${scenario.fontScale}) + 'px';
               document.body.style.fontSize = (14 * ${scenario.fontScale}) + 'px';`);
  }
  if (scenario.locale === 'en') {
    // Locale is seeded into localStorage pre-boot, so the drawer already renders
    // in English. Only re-run the DOM pass — NOT setLang(), which persists and
    // reloads the document, leaving document.body momentarily null and blowing
    // up every later prep step.
    prep.push(`(() => { try {
      if (typeof applyI18n === 'function') applyI18n(document);
    } catch(e){} })()`);
  }
  // Dismiss any onboarding/tour overlay that still slipped through.
  prep.push(`(() => { try {
    document.querySelectorAll('.tour-pop,.tour-mask,#tour-pop,#tour-mask').forEach(el => el.remove());
  } catch(e){} })()`);
  if (scenario.safeBottom) {
    // Chrome headless cannot supply real env(safe-area-inset-*). The fix reads
    // the inset through --mc-safe-bottom (default env(...,0px)), so overriding
    // that variable is a faithful stand-in for a notched device.
    prep.push(`document.documentElement.style.setProperty('--mc-safe-bottom', '${scenario.safeBottom}px')`);
  }
  for (const js of prep) await cdp.evaluate(js);

  // Open the drawer LAST, and settle on POSITION rather than on the class: a
  // late async render can call setView(), which strips `nav-open` and restarts
  // the .25s slide-out. Re-adding the class then restarts the transition from
  // x=-236, so `classList.contains('nav-open')` can read true while the drawer
  // is still entirely off-screen — measuring there reports a phantom failure.
  // Wait until the drawer has actually come to rest at x≈0.
  if (!scenario.desktop) {
    let settled = false;
    for (let i = 0; i < 8 && !settled; i++) {
      await cdp.evaluate(`document.body.classList.add('nav-open')`);
      await sleep(450); // drawer transition (.25s) + margin
      settled = await cdp.evaluate(`(() => {
        const n = document.getElementById('nav');
        return !!(n && document.body.classList.contains('nav-open')
          && n.getBoundingClientRect().left >= -0.5);
      })()`);
    }
    if (!settled) throw new Error('drawer never settled open');
  } else {
    await sleep(450);
  }

  const m = await cdp.evaluate(MEASURE_JS);

  // Derived verdicts. The toolbar is already reflected in m.innerH (the viewport
  // was shrunk for the toolbar-shown state), so the only band left to reserve is
  // the home indicator, which overlays the viewport rather than shrinking it.
  const safe = scenario.safeBottom || 0;
  const visibleBottom = m.innerH - safe;
  const r = m.restartRect;
  const acts = m.actions || [];
  const obscured = acts.filter(a => !(a.rect.bottom <= visibleBottom + 0.5 && a.rect.top >= -0.5));
  const unhittable = acts.filter(a => !a.hits);
  const verdict = {
    state: state.id,
    visibleBottom,
    toolbarPx: state.toolbar,
    safeAreaPx: safe,
    restartFullyInLayoutViewport: !!(r && r.bottom <= m.innerH + 0.5 && r.top >= -0.5),
    restartFullyVisibleOnDevice: !!(r && r.bottom <= visibleBottom + 0.5 && r.top >= -0.5),
    restartOverflowPx: r ? +(r.bottom - visibleBottom).toFixed(1) : null,
    // Content edge of the action row, i.e. below the last button but above the
    // safe-area padding that .nav-bottom deliberately reserves.
    actionRowContentBottom: m.footRect ? m.footRect.bottom : null,
    actionCount: acts.length,
    actionsFullyVisibleOnDevice: acts.length > 0 && obscured.length === 0,
    obscuredActions: obscured.map(a => ({ id: a.id, text: a.text, bottom: a.rect.bottom })),
    allActionsHitTestable: acts.length > 0 && unhittable.length === 0,
    unhittableActions: unhittable.map(a => ({ id: a.id, text: a.text })),
    hitTestPassesInLayoutViewport: !!(m.hit && m.hit.hitsButton),
    middleScrollable: m.scroller ? m.scroller.scrollable : null,
    navOverflowsWithoutScroller: m.nav.scrollH != null && m.nav.clientH != null
      ? m.nav.scrollH > m.nav.clientH + 1 : null,
  };
  verdict.pass = verdict.restartFullyVisibleOnDevice
    && verdict.hitTestPassesInLayoutViewport
    && verdict.actionsFullyVisibleOnDevice
    && verdict.allActionsHitTestable;

  const shotPath = path.join(outDir, `${label}-${scenario.id}-${state.id}.png`);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  return { scenario: { ...scenario }, state, measured: m, verdict, screenshot: shotPath };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const upstream = arg('upstream', 'http://127.0.0.1:3000');
  const serveRoot = arg('serve-root', null);
  const label = arg('label', 'run');
  const outDir = arg('out', '/tmp/multicc-mobile-nav-evidence');
  fs.mkdirSync(outDir, { recursive: true });

  let staticServer = null;
  let url = arg('url', upstream + '/manage');
  if (serveRoot) {
    const started = await startStaticProxy(path.resolve(serveRoot), upstream);
    staticServer = started.server;
    url = `http://127.0.0.1:${started.port}/manage`;
    console.error(`[measure-mobile-nav] serving ${path.resolve(serveRoot)} at ${url} (proxy → ${upstream})`);
  }

  const port = 9333 + (process.pid % 400);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nav-chrome-'));
  const chrome = spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-dev-shm-usage',
  ], { stdio: 'ignore' });

  const results = [];
  try {
    await waitForDevtools(port);
    const target = JSON.parse(await httpPut(`http://127.0.0.1:${port}/json/new?about:blank`));
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const s of SCENARIOS) {
      for (const state of viewportStates(s)) {
        process.stderr.write(`  · ${s.id} [${state.id}] … `);
        try {
          const r = await runScenario(cdp, s, url, outDir, label, state);
          results.push(r);
          process.stderr.write(`${r.verdict.pass ? 'PASS' : 'FAIL'} (restart bottom=${r.measured.restartRect ? r.measured.restartRect.bottom : 'n/a'}, visibleBottom=${r.verdict.visibleBottom})\n`);
        } catch (err) {
          results.push({ scenario: s, state, error: err.message });
          process.stderr.write(`ERROR ${err.message}\n`);
        }
      }
    }
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    if (staticServer) staticServer.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }

  const jsonPath = path.join(outDir, `${label}-measurements.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ url, label, results }, null, 2));
  const failed = results.filter(r => r.error || !r.verdict || !r.verdict.pass);
  console.log(`\n[measure-mobile-nav] ${label}: ${results.length - failed.length}/${results.length} scenarios pass`);
  console.log(`[measure-mobile-nav] json: ${jsonPath}`);
  for (const r of results) {
    const tag = `${r.scenario.id} [${r.state ? r.state.id : '?'}]`;
    if (r.error) { console.log(`  ${tag}: ERROR ${r.error}`); continue; }
    const v = r.verdict;
    console.log(`  ${v.pass ? '✅' : '❌'} ${tag.padEnd(40)} restart.bottom=${String(r.measured.restartRect ? r.measured.restartRect.bottom : 'n/a').padStart(7)} visibleBottom=${String(v.visibleBottom).padStart(5)} overflow=${String(v.restartOverflowPx).padStart(7)}px hit=${v.hitTestPassesInLayoutViewport} midScroll=${v.middleScrollable}`);
  }
  process.exitCode = 0; // reporting tool: never fail the caller
}

main().catch(err => { console.error(err); process.exit(1); });
