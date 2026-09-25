'use strict';

// Page commands. Each action receives a `ctx` supplied by the daemon:
//
//   ctx.targetId / ctx.owner / ctx.profile
//   ctx.send(method, params, opts)     session-scoped CDP (re-attaches on retry)
//   ctx.browser(method, params, opts)  browser-level CDP
//   ctx.ensure(...domains)             lazy domain enable
//   ctx.on(method, handler)            session-scoped event subscription
//   ctx.resolveRef(ref)                -> {backendDOMNodeId, role, name, nth, frameId}
//   ctx.snapshot({interactive,maxChars}) -> {text, refs, tab, title, url}
//   ctx.newTab({url, background, visible}) / ctx.listTabs() / ctx.switchTab(p) / ctx.closeTab(id)
//   ctx.pendingDialog()                -> {type, message, url} | null
//
// Actions return plain objects; `text` is the human-facing rendering and the CLI
// prints it verbatim unless --json is given.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { MbError } = require('./paths');
const { parseChord, keyEventParams } = require('./keys');

const LOAD_TIMEOUT = 30000;
const CLICK_SETTLE_MS = 300;

// Not unref'd: `wait` polls in a loop, and an unref'd sleep there would let a
// process with no other work exit mid-command.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeUrl(input) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  if (!text) throw new MbError('usage', 'open needs a URL');
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(text)) return `http://${text}`;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(text)) return `https://${text}`;
  if (path.isAbsolute(text) && fs.existsSync(text)) return `file://${text}`;
  return text;
}

async function readyState(ctx) {
  try {
    const result = await ctx.send('Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true }, { timeout: 5000 });
    return result && result.result ? result.result.value : null;
  } catch (_) {
    return null;
  }
}

async function waitForLoad(ctx, timeoutMs = LOAD_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await readyState(ctx) === 'complete') return true;
    await sleep(100);
  }
  return false;
}

async function objectIdOf(ctx, backendNodeId) {
  const result = await ctx.send('DOM.resolveNode', { backendNodeId });
  if (!result || !result.object || !result.object.objectId) {
    throw new MbError('stale_ref', `backend node ${backendNodeId} is gone — take a new snapshot`);
  }
  return result.object.objectId;
}

async function callOn(ctx, objectId, functionDeclaration, args = [], extra = {}) {
  const result = await ctx.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map(value => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    ...extra,
  }, { timeout: 15000 });
  if (result && result.exceptionDetails) {
    const exception = result.exceptionDetails;
    throw new MbError('js_error', (exception.exception && exception.exception.description) || exception.text || 'JS error');
  }
  return result && result.result ? result.result.value : undefined;
}

function largestQuadCenter(quads) {
  let best = null;
  let bestArea = 0;
  for (const quad of quads || []) {
    if (!Array.isArray(quad) || quad.length < 8) continue;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const area = width * height;
    if (area <= bestArea) continue;
    bestArea = area;
    best = { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4, width, height };
  }
  return best;
}

async function viewportInfo(ctx) {
  try {
    const result = await ctx.send('Runtime.evaluate', {
      expression: '({sx:window.scrollX||0,sy:window.scrollY||0,w:window.innerWidth||0,h:window.innerHeight||0})',
      returnByValue: true,
    }, { timeout: 5000 });
    return (result && result.result && result.result.value) || { sx: 0, sy: 0, w: 0, h: 0 };
  } catch (_) {
    return { sx: 0, sy: 0, w: 0, h: 0 };
  }
}

// The clickable point of an element, in viewport coordinates.
//
// DOM.getContentQuads is the primary source, but its coordinate space depends
// on the frame, so the quad is shifted by the page's scroll offset and only
// trusted when that lands inside the viewport; otherwise the element's
// getBoundingClientRect (always viewport-relative) is used.
async function clickablePoint(ctx, backendNodeId) {
  const quads = await ctx.send('DOM.getContentQuads', { backendNodeId }, { timeout: 10000 })
    .then(result => result.quads || [])
    .catch(() => []);
  const quad = largestQuadCenter(quads);
  if (quad) {
    const viewport = await viewportInfo(ctx);
    const point = { x: quad.x - viewport.sx, y: quad.y - viewport.sy, source: 'quads' };
    if (viewport.w > 0 && point.x >= 0 && point.y >= 0 && point.x < viewport.w && point.y < viewport.h) {
      return { ...point, quad };
    }
  }
  const rect = await rectOf(ctx, backendNodeId);
  if (rect && rect.width > 0 && rect.height > 0) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, source: 'rect', rect };
  }
  return null;
}

async function rectOf(ctx, backendNodeId) {
  const objectId = await objectIdOf(ctx, backendNodeId);
  const rect = await callOn(ctx, objectId,
    'function(){const r=this.getBoundingClientRect();const sx=window.scrollX||0;const sy=window.scrollY||0;' +
    'return {x:r.x,y:r.y,width:r.width,height:r.height,pageX:r.x+sx,pageY:r.y+sy,sx:sx,sy:sy};}');
  return rect && typeof rect.x === 'number' ? rect : null;
}

async function jsClick(ctx, backendNodeId, { right = false } = {}) {
  const objectId = await objectIdOf(ctx, backendNodeId);
  const script = right
    ? 'function(){this.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}));return true;}'
    : 'function(){this.click();return true;}';
  await callOn(ctx, objectId, script, [], { userGesture: true });
  return right ? 'contextmenu' : 'click';
}

async function mouseAt(ctx, x, y, button, clickCount) {
  const buttons = button === 'right' ? 2 : 1;
  await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await ctx.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, buttons, clickCount, modifiers: 0,
  });
  await ctx.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers: 0,
  });
}

async function click(ctx, args) {
  const button = args.right ? 'right' : 'left';
  let target = { source: 'xy', x: Number(args.x), y: Number(args.y) };
  let backendNodeId = null;
  if (args.ref) {
    backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
    await ctx.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, { timeout: 10000 }).catch(() => {});
    const point = await clickablePoint(ctx, backendNodeId);
    if (point) {
      target = point;
    } else {
      // Hidden or zero-size: a real mouse event would land nowhere.
      await jsClick(ctx, backendNodeId, { right: args.right });
      const url = await currentUrl(ctx);
      return { text: `click ${args.ref}: no visible box, used the js-click fallback${url ? ` — ${url}` : ''}`, fallback: 'js-click', url };
    }
  } else if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new MbError('usage', 'click needs a REF or --xy X Y');
  }
  const before = await currentUrl(ctx);
  if (args.double) {
    await mouseAt(ctx, target.x, target.y, button, 1);
    await mouseAt(ctx, target.x, target.y, button, 2);
  } else {
    await mouseAt(ctx, target.x, target.y, button, 1);
  }
  await sleep(CLICK_SETTLE_MS);
  const after = await currentUrl(ctx);
  const where = args.ref ? `click ${args.ref}` : `click --xy ${target.x},${target.y}`;
  const note = target.source === 'rect' ? ' (rect fallback)' : '';
  const nav = after && after !== before ? ` — navigated to ${after}` : '';
  return { text: `${where} ok at ${Math.round(target.x)},${Math.round(target.y)}${note}${nav}`, url: after, navigated: Boolean(nav), point: target };
}

async function currentUrl(ctx) {
  try {
    const result = await ctx.send('Runtime.evaluate',
      { expression: 'location.href', returnByValue: true }, { timeout: 5000 });
    return result && result.result ? result.result.value : null;
  } catch (_) {
    return null;
  }
}

async function clearValue(ctx, backendNodeId) {
  const objectId = await objectIdOf(ctx, backendNodeId);
  const outcome = await callOn(ctx, objectId, `function(){
    if (this.isContentEditable) {
      this.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(this);
      selection.addRange(range);
      return { contentEditable: true };
    }
    const tag = this.tagName;
    const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(this, ''); else this.value = '';
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return { contentEditable: false };
  }`);
  if (outcome && outcome.contentEditable) {
    // A contenteditable selection lives in the renderer, so the delete has to
    // come back through the input pipeline.
    const backspace = keyEventParams(parseChord('Backspace'), 'rawKeyDown');
    await ctx.send('Input.dispatchKeyEvent', backspace);
    await ctx.send('Input.dispatchKeyEvent', keyEventParams(parseChord('Backspace'), 'keyUp'));
  }
  return Boolean(outcome);
}

async function pressChord(ctx, spec) {
  const chord = parseChord(spec);
  await ctx.send('Input.dispatchKeyEvent', keyEventParams(chord, chord.text !== undefined ? 'keyDown' : 'rawKeyDown'));
  await ctx.send('Input.dispatchKeyEvent', keyEventParams(chord, 'keyUp'));
  return chord;
}

async function type(ctx, args) {
  const backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
  await ctx.send('DOM.focus', { backendNodeId }, { timeout: 10000 }).catch(async () => {
    const objectId = await objectIdOf(ctx, backendNodeId);
    await callOn(ctx, objectId, 'function(){this.focus();return true;}');
  });
  const notes = [];
  if (args.clear) {
    await clearValue(ctx, backendNodeId);
    notes.push('cleared');
  }
  if (args.text) await ctx.send('Input.insertText', { text: String(args.text) });
  if (args.submit) {
    await pressChord(ctx, 'Enter');
    notes.push('submitted');
  }
  await sleep(120);
  const url = await currentUrl(ctx);
  return {
    text: `type ${args.ref} ok (${args.text ? `${String(args.text).length} chars` : 'no text'})` +
      `${notes.length ? ` [${notes.join(', ')}]` : ''}${url ? ` — ${url}` : ''}`,
    url,
  };
}

async function press(ctx, args) {
  const chord = await pressChord(ctx, args.key);
  return { text: `press ${args.key} ok (modifiers=${chord.modifiers}${chord.commands ? `, ${chord.commands.join(',')}` : ''})`, chord };
}

async function selectAction(ctx, args) {
  const backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
  const objectId = await objectIdOf(ctx, backendNodeId);
  const outcome = await callOn(ctx, objectId, `function(value){
    const tag = (this.tagName || '').toUpperCase();
    if (tag !== 'SELECT') {
      return { unsupported: true, role: this.getAttribute('role') || tag };
    }
    const wanted = String(value);
    const options = Array.from(this.options || []);
    let index = options.findIndex(option => option.value === wanted);
    if (index < 0) index = options.findIndex(option => (option.textContent || '').trim() === wanted.trim());
    if (index < 0) index = options.findIndex(option => (option.label || '').trim() === wanted.trim());
    if (index < 0) return { missing: true, values: options.map(option => option.value) };
    this.selectedIndex = index;
    const option = options[index];
    if (option && !option.selected) option.selected = true;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: this.value, text: (option && option.textContent || '').trim() };
  }`, [String(args.value)]);
  if (outcome && outcome.unsupported) {
    throw new MbError('unsupported',
      `${args.ref} is a ${outcome.role}, not a <select>; click it and then click the option instead`);
  }
  if (outcome && outcome.missing) {
    throw new MbError('no_option',
      `no option matches ${JSON.stringify(args.value)}; available: ${(outcome.values || []).join(', ')}`);
  }
  return { text: `select ${args.ref} = ${JSON.stringify(outcome.value)}${outcome.text ? ` (${outcome.text})` : ''}`, value: outcome.value };
}

async function hover(ctx, args) {
  const backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
  await ctx.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, { timeout: 10000 }).catch(() => {});
  const point = await clickablePoint(ctx, backendNodeId);
  if (!point) throw new MbError('not_visible', `hover ${args.ref}: element has no visible box`);
  await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  return { text: `hover ${args.ref} ok at ${Math.round(point.x)},${Math.round(point.y)}`, point };
}

async function scroll(ctx, args) {
  const dy = (args.direction === 'up' ? -1 : 1) * (Number(args.px) || 600);
  const dx = args.direction === 'left' ? -Math.abs(Number(args.px) || 600)
    : args.direction === 'right' ? Math.abs(Number(args.px) || 600) : 0;
  let point = null;
  if (args.ref) {
    const backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
    point = await clickablePoint(ctx, backendNodeId);
    if (!point) throw new MbError('not_visible', `scroll --ref ${args.ref}: element has no visible box`);
  } else {
    const viewport = await viewportInfo(ctx);
    point = { x: Math.floor(viewport.w / 2), y: Math.floor(viewport.h / 2) };
  }
  await ctx.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: point.x, y: point.y, deltaX: dx, deltaY: dy, button: 'none', buttons: 0,
  }).catch(async () => {
    await ctx.send('Runtime.evaluate', {
      expression: `window.scrollBy(${dx},${dy})`, returnByValue: true,
    });
  });
  await sleep(150);
  const position = await ctx.send('Runtime.evaluate', {
    expression: '({x:window.scrollX,y:window.scrollY})', returnByValue: true,
  }).then(result => (result && result.result && result.result.value) || null).catch(() => null);
  return { text: `scroll ok (deltaX=${dx}, deltaY=${dy}); scroll=${position ? `${position.x},${position.y}` : 'unknown'}`, position };
}

async function upload(ctx, args) {
  const backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
  const files = (args.files || []).map(file => path.resolve(file));
  for (const file of files) {
    if (!fs.existsSync(file)) throw new MbError('usage', `file not found: ${file}`);
  }
  if (!files.length) throw new MbError('usage', 'upload needs at least one file');
  const objectId = await objectIdOf(ctx, backendNodeId);
  const isFileInput = await callOn(ctx, objectId,
    'function(){return (this.tagName||"").toUpperCase()==="INPUT" && (this.type||"")==="file";}');
  if (!isFileInput) throw new MbError('unsupported', `${args.ref} is not an <input type="file">`);
  await ctx.send('DOM.setFileInputFiles', { files, backendNodeId });
  return { text: `upload ${args.ref} ok (${files.length} file${files.length === 1 ? '' : 's'})`, files };
}

function screenshotPath(profile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.tmpdir(), `mbrowser-${profile}-${stamp}.png`);
}

async function screenshot(ctx, args) {
  const target = args.out ? path.resolve(args.out) : screenshotPath(ctx.profile);
  const params = { format: 'png' };
  if (args.ref) {
    const backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
    const rect = await rectOf(ctx, backendNodeId);
    if (!rect) throw new MbError('not_visible', `screenshot --ref ${args.ref}: element has no box`);
    params.clip = {
      x: rect.pageX, y: rect.pageY, width: Math.max(rect.width, 1), height: Math.max(rect.height, 1), scale: 1,
    };
    params.captureBeyondViewport = true;
  } else if (args.full) {
    const metrics = await ctx.send('Page.getLayoutMetrics');
    const size = (metrics && (metrics.cssContentSize || metrics.contentSize)) || { width: 1440, height: 900 };
    params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    params.captureBeyondViewport = true;
  }
  const result = await ctx.send('Page.captureScreenshot', params, { timeout: 30000 });
  if (!result || !result.data) throw new MbError('screenshot_failed', 'Page.captureScreenshot returned no data');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return { text: target, path: target, bytes: fs.statSync(target).size };
}

async function text(ctx, args) {
  const maxChars = Number(args.maxChars) || 8000;
  let value = '';
  if (args.ref) {
    const backendNodeId = (await ctx.resolveRef(args.ref)).backendDOMNodeId;
    const objectId = await objectIdOf(ctx, backendNodeId);
    value = await callOn(ctx, objectId, 'function(){return this.innerText || this.value || "";}');
  } else {
    const result = await ctx.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""', returnByValue: true,
    }, { timeout: 15000 });
    if (result && result.exceptionDetails) throw new MbError('js_error', result.exceptionDetails.text || 'JS error');
    value = result && result.result ? result.result.value : '';
  }
  const full = String(value === undefined || value === null ? '' : value);
  const text = full.length > maxChars ? `${full.slice(0, maxChars)}\n[...TRUNCATED at ${maxChars} chars]` : full;
  return { text, chars: full.length, truncated: full.length > maxChars };
}

async function evaluate(ctx, args) {
  const expression = String(args.js === undefined || args.js === null ? '' : args.js);
  if (!expression.trim()) throw new MbError('usage', 'eval needs a JS expression');
  const run = async source => ctx.send('Runtime.evaluate', {
    expression: source, returnByValue: true, awaitPromise: true, userGesture: false,
  }, { timeout: 30000 });
  let result = await run(expression);
  let source = expression;
  if (result && result.exceptionDetails) {
    const detail = result.exceptionDetails;
    const message = (detail.exception && detail.exception.description) || detail.text || '';
    if (/Illegal return statement/i.test(message)) {
      // `return x` is only legal inside a function; wrap and retry once.
      source = `(async()=>{${expression}})()`;
      result = await run(source);
    }
  }
  if (result && result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new MbError('js_error', (detail.exception && detail.exception.description) || detail.text || 'JS exception');
  }
  const value = result && result.result ? result.result.value : undefined;
  return {
    text: typeof value === 'string' ? value : JSON.stringify(value),
    value,
    type: result && result.result ? result.result.type : null,
    expression: source,
  };
}

async function wait(ctx, args) {
  const timeoutMs = (Number(args.timeout) || 15) * 1000;
  const deadline = Date.now() + timeoutMs;
  if (args.ms) await sleep(Number(args.ms));
  const wanted = [];
  if (args.text) wanted.push(`text ${JSON.stringify(args.text)}`);
  if (args.selector) wanted.push(`selector ${args.selector}`);
  if (args.load) wanted.push('load');
  if (args.idle) wanted.push('idle');
  if (!wanted.length && !args.ms) throw new MbError('usage', 'wait needs --text, --selector, --load, --idle or --ms');

  const checkSelector = async () => {
    const result = await ctx.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(args.selector)}) !== null`, returnByValue: true,
    }, { timeout: 5000 });
    return Boolean(result && result.result && result.result.value);
  };
  const checkText = async () => {
    const result = await ctx.send('Runtime.evaluate', {
      expression: `(document.body ? document.body.innerText : "").includes(${JSON.stringify(args.text)})`,
      returnByValue: true,
    }, { timeout: 5000 });
    return Boolean(result && result.result && result.result.value);
  };
  const checkIdle = idleWaiter(ctx, args.quietMs ? Number(args.quietMs) : 500);

  try {
    for (;;) {
      let ok = true;
      if (args.text) ok = ok && await checkText().catch(() => false);
      if (ok && args.selector) ok = ok && await checkSelector().catch(() => false);
      if (ok && args.load) ok = ok && (await readyState(ctx)) === 'complete';
      if (ok && args.idle) ok = ok && await checkIdle().catch(() => true);
      if (ok) {
        return { text: `wait ok (${wanted.join(', ')}${args.ms ? `, ${args.ms}ms` : ''})`, waited: wanted };
      }
      if (Date.now() > deadline) {
        throw new MbError('timeout', `wait timed out after ${timeoutMs}ms for ${wanted.join(', ')}`);
      }
      await sleep(150);
    }
  } finally {
    // The idle waiter subscribes to Network events; a wait that never disposes
    // would keep three listeners alive on the daemon's single CDP socket.
    checkIdle.dispose();
  }
}

// Network idle without buffering the whole stream: subscribe once, count only
// the requests that are still open, and report quiet once the counter drains.
function idleWaiter(ctx, quietMs) {
  let pending = 0;
  let lastActivity = Date.now();
  const offs = [
    ctx.on('Network.requestWillBeSent', () => { pending += 1; lastActivity = Date.now(); }),
    ctx.on('Network.loadingFinished', () => { pending = Math.max(0, pending - 1); lastActivity = Date.now(); }),
    ctx.on('Network.loadingFailed', () => { pending = Math.max(0, pending - 1); lastActivity = Date.now(); }),
  ];
  let primed = false;
  // A request that never finishes (long-poll, SSE, an ad beacon) would hold the
  // counter above zero forever, so a long enough silence also counts as idle —
  // otherwise `wait --idle` could never succeed on such a page.
  const stuckMs = Math.max(quietMs * 4, 5000);
  const check = async () => {
    if (!primed) {
      await ctx.ensure('Network');
      primed = true;
      lastActivity = Date.now();
    }
    const quiet = Date.now() - lastActivity;
    if (pending === 0) return quiet >= quietMs;
    return quiet >= stuckMs;
  };
  check.dispose = () => { for (const off of offs) { try { off(); } catch (_) { /* ignore */ } } };
  return check;
}

async function open(ctx, args) {
  const url = normalizeUrl(args.url);
  const target = args.newTab ? await ctx.newTab({ url, background: false }) : null;
  if (!target) {
    const before = await currentUrl(ctx);
    await ctx.send('Page.navigate', { url }, { timeout: 30000 });
    const loaded = await waitForLoad(ctx);
    const info = await ctx.pageInfo();
    const note = loaded ? '' : ' (load timed out; page may still be loading)';
    const redirect = info.url && info.url !== url && info.url !== before ? ` (redirected to ${info.url})` : '';
    return { text: `open ${url}${note}${redirect} — ${info.title || '(untitled)'}`, url: info.url || url, title: info.title, loaded };
  }
  // Target.createTarget returns before the page has loaded, and ctx is bound to
  // the old tab, so this cannot wait for the new tab's load state.
  return { text: `open ${url} in a new tab ${target.shortId} — ${target.title || '(untitled)'}`, ...target, newTab: true };
}

async function historyStep(ctx, args, delta) {
  const history = await ctx.send('Page.getNavigationHistory');
  const entries = history.entries || [];
  const index = Number(history.currentIndex || 0) + delta;
  if (index < 0 || index >= entries.length) {
    throw new MbError('no_history', `no ${delta < 0 ? 'previous' : 'next'} entry in this tab's history`);
  }
  await ctx.send('Page.navigateToHistoryEntry', { entryId: entries[index].id });
  await waitForLoad(ctx, 15000);
  const info = await ctx.pageInfo();
  return { text: `${delta < 0 ? 'back' : 'forward'} ok — ${info.title || '(untitled)'} ${info.url}`, url: info.url, title: info.title };
}

async function reload(ctx) {
  await ctx.send('Page.reload', { ignoreCache: Boolean(args.hard) });
  const loaded = await waitForLoad(ctx);
  const info = await ctx.pageInfo();
  return { text: `reload ${loaded ? 'ok' : 'timed out'} — ${info.title || '(untitled)'} ${info.url}`, url: info.url, loaded };
}

async function tabs(ctx) {
  const list = await ctx.listTabs();
  const lines = list.map(tab => `${tab.shortId} ${tab.mark} ${tab.title || '(untitled)'} — ${tab.url}${tab.owner ? ` [${tab.owner}]` : ''}`);
  return { text: lines.join('\n') || '(no tabs)', tabs: list };
}

async function tab(ctx, args) {
  if (!args.target) throw new MbError('usage', 'tab needs a TARGET (a short id from `mbrowser tabs`)');
  const result = await ctx.switchTab(args.target);
  return {
    text: `tab ${result.shortId} now current${result.foreign ? ' (another owner\'s tab)' : ''} — ${result.title || '(untitled)'} ${result.url}`,
    ...result,
  };
}

async function close(ctx, args) {
  const result = await ctx.closeTab(args.target || null);
  return { text: `closed tab ${result.shortId} (${result.title || result.url || 'untitled'})`, ...result };
}

async function dialog(ctx, args) {
  const decision = args.decision === 'dismiss' ? false : true;
  const result = await ctx.handleDialog(decision, args.text);
  return {
    text: `dialog ${args.decision}${args.text ? ' with text' : ''} — ${result.type}: ${result.message}`,
    ...result,
  };
}

const COMMANDS = {
  snapshot: (ctx, args) => ctx.snapshot({ interactive: Boolean(args.interactive), maxChars: args.maxChars }),
  open,
  click,
  type,
  press,
  select: selectAction,
  hover,
  scroll,
  upload,
  screenshot,
  text,
  eval: evaluate,
  wait,
  back: (ctx, args) => historyStep(ctx, args, -1),
  forward: (ctx, args) => historyStep(ctx, args, 1),
  reload,
  tabs,
  tab,
  close,
  dialog,
};

module.exports = {
  COMMANDS,
  LOAD_TIMEOUT,
  normalizeUrl,
  waitForLoad,
  readyState,
  rectOf,
  clickablePoint,
  largestQuadCenter,
  viewportInfo,
  screenshotPath,
  sleep,
};
