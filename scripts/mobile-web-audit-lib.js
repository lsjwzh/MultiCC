#!/usr/bin/env node
// Mobile-web audit driver.
//
// Drives a headless Chrome over CDP with an iPhone device-metrics override so
// the pages render at the exact viewport / DPR / touch model a phone gets, then
// walks the UI tree (view by view, overlay by overlay), runs a DOM audit for
// horizontal overflow, out-of-viewport paintable boxes, sub-44px touch targets
// and hard-clipped text, and captures screenshots.
//
// Chrome is the automation engine because the iOS simulator has no scriptable
// tap (no idb, safaridriver needs a manual "Allow Remote Automation" toggle).
// Real-WebKit checks are done separately by `xcrun simctl openurl` + screenshot.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) reject(new Error(m.method + ': ' + JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        c.events.push(m);
        if (c.events.length > 500) c.events.shift();
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timeout')); }
      }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function launch({ width = 430, height = 932, dpr = 3 } = {}) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars',
    `--user-data-dir=/tmp/multicc-audit-chrome`,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 60; i++) {
    try { await getJson('/json/version'); break; } catch (_) { await sleep(250); }
  }
  const targets = await getJson('/json/list');
  const page = targets.find(t => t.type === 'page');
  const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: true,
    screenWidth: width, screenHeight: height,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }).catch(() => {});
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  }).catch(() => {});
  return { proc, cdp, width, height };
}

async function nav(cdp, url, waitMs = 2500) {
  await cdp.send('Page.navigate', { url });
  await sleep(waitMs);
}

async function evaluate(cdp, expr, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function tapSelector(cdp, sel, waitMs = 700) {
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1, pointerType: 'touch',
    });
  }
  await sleep(waitMs);
  return true;
}

async function screenshot(cdp, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
  return path;
}

// ---------------------------------------------------------------------------
// DOM audit. Reports, per page state:
//   oov   – painted box crossing the viewport's left/right edge
//   scrollx – the document itself scrolls horizontally
//   touch – interactive control whose hit box is under 44x44
//   clip  – text hard-clipped with no ellipsis
//   under – fixed/sticky bottom bar without safe-area padding
// ---------------------------------------------------------------------------
const AUDIT = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const issues = [];
  const seen = new Set();
  const desc = el => {
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  const push = o => { const k = o.k + '|' + o.el + '|' + (o.info || ''); if (!seen.has(k)) { seen.add(k); issues.push(o); } };
  const de = document.documentElement;
  const scrollX = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0) - vw;
  if (scrollX > 1) push({ k: 'scrollx', el: 'document', info: '+' + Math.round(scrollX) + 'px' });

  const vis = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return null;
    // A closed <details> keeps layout boxes for its content in Chrome
    // (content-visibility:hidden on the slot), but nothing paints or hit-tests.
    const det = el.closest && el.closest('details:not([open])');
    if (det && det !== el && !(el.closest('summary'))) return null;
    return cs;
  };
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const cs = vis(el);
    if (!cs) continue;
    // Skip subtrees that are deliberately off-canvas (closed drawers/menus that
    // stay in flow via transform) – they are not visible to the user.
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Fully off-canvas = a closed drawer/menu parked outside the viewport by a
    // transform. Not something the user can see, so not an overflow.
    // Horizontal-only: a box below the fold still overflows sideways once the
    // user scrolls to it, so vertical position must NOT disqualify it.
    if (r.right <= 0 || r.left >= vw) continue;
    const isLayer =/scrim|backdrop|barrier|lightbox|overlay/i.test(el.id + ' ' + (typeof el.className === 'string' ? el.className : ''));
    if (!isLayer && (r.right > vw + 2 || r.left < -2)) {
      // Only report when this box is the one actually painting past the edge:
      // ignore pure wrappers whose own paint is transparent AND whose overflow
      // clips (their children get reported instead).
      const paints = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px' ||
        cs.borderLeftWidth !== '0px' || cs.borderRightWidth !== '0px' || el.tagName === 'IMG' ||
        (el.children.length === 0 && (el.textContent || '').trim().length > 0);
      // Ancestor already clips it? Then nothing paints past the edge – but the
      // part beyond the clip is only reachable if that ancestor can scroll.
      // hidden/clip = content silently lost; auto/scroll = fine.
      let clipped = false, lost = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (pc.overflowX !== 'visible') {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 2 && pr.left >= -2) {
            clipped = true;
            if (/^(hidden|clip)$/.test(pc.overflowX) && p.scrollWidth > p.clientWidth + 2) {
              lost = true;
              push({ k: 'lost', el: desc(el), info: 'clipped by ' + desc(p) + ' ' + p.scrollWidth + '>' + p.clientWidth,
                     txt: (el.textContent || '').trim().slice(0, 30) });
            }
          }
          break;
        }
      }
      if (paints && !clipped && !lost) {
        push({ k: 'oov', el: desc(el), info: 'L' + Math.round(r.left) + ' R' + Math.round(r.right) + ' /vw' + vw,
               txt: (el.textContent || '').trim().slice(0, 30) });
      }
    }
    // Hard-clipped text (no ellipsis, no scroll affordance).
    if (el.children.length === 0 && (el.textContent || '').trim().length > 2) {
      if (cs.overflowX === 'hidden' && cs.textOverflow === 'clip' && el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace === 'nowrap') {
        push({ k: 'clip', el: desc(el), info: el.scrollWidth + '>' + el.clientWidth, txt: (el.textContent || '').trim().slice(0, 30) });
      }
    }
  }
  for (const el of document.querySelectorAll('button, a[href], [role=button], [onclick], input, select, summary')) {
    const cs = vis(el);
    if (!cs) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.left >= vw || r.right <= 0) continue;
    if (r.width < 44 || r.height < 44) {
      push({ k: 'touch', el: desc(el), info: Math.round(r.width) + 'x' + Math.round(r.height),
             txt: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 20) });
    }
  }
  // Overlap: a visible text/control box whose own centre hit-tests to an
  // unrelated element is painted over by something stacked above it. This is
  // the failure mode geometry alone cannot see (floating docks, pinned hint
  // cards and pill rows landing on top of each other at phone widths).
  // Skipped while a full-screen overlay is up, where covering is intended.
  const modalUp = [...document.querySelectorAll('body *')].some(e => {
    const cs = getComputedStyle(e);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.width > vw * 0.9 && r.height > vh * 0.8 && +cs.opacity > 0.05;
  });
  if (!modalUp) {
    for (const el of document.querySelectorAll('body *')) {
      const cs = vis(el);
      if (!cs) continue;
      if (el.children.length > 0 && !/^(BUTTON|A|INPUT|SELECT|SUMMARY)$/.test(el.tagName)) continue;
      const txt = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      if (txt.length < 1) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh) continue;
      // Scrolled out of its own scroll container: the pinned chrome covering it
      // is the scroll region's edge doing its job, not a layout collision.
      let outOfScroller = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (pc.overflowY === 'auto' || pc.overflowY === 'scroll') {
          const pr = p.getBoundingClientRect();
          if (r.top < pr.top - 1 || r.bottom > pr.bottom + 1) outOfScroller = true;
          break;
        }
      }
      if (outOfScroller) continue;
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (!hit) continue;
      if (hit === el || el.contains(hit) || hit.contains(el)) continue;
      push({ k: 'covered', el: desc(el), info: 'by ' + desc(hit), txt: txt.slice(0, 26) });
    }
  }

  // Bottom-pinned bars must respect the home indicator.
  for (const el of document.querySelectorAll('body *')) {
    const cs = vis(el);
    if (!cs) continue;
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    // A bar, not a full-screen sheet/backdrop (those legitimately cover all of it).
    if (r.height < 20 || r.height > vh * 0.4 || r.width < vw * 0.5) continue;
    if (r.left >= vw || r.right <= 0) continue;
    if (Math.abs(r.bottom - vh) > 4) continue;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const raw = el.getAttribute('style') || '';
    const usesEnv = /safe-area-inset-bottom/.test(raw) || pb >= 20;
    if (!usesEnv) push({ k: 'under', el: desc(el), info: 'padding-bottom:' + cs.paddingBottom });
  }
  return { vw, vh, n: issues.length, issues };
})()`;

async function audit(cdp, label) {
  const r = await evaluate(cdp, AUDIT);
  return { label, ...r };
}

module.exports = { launch, nav, evaluate, tapSelector, screenshot, audit, sleep, AUDIT, Cdp };
