'use strict';

/**
 * Layout contract for the /manage left drawer (#nav) on phones.
 *
 * The bug this pins: the drawer was a flex column with no inner scroll region,
 * so a nav list taller than the viewport simply grew past the drawer and pushed
 * the bottom action row — including the restart button — off-screen, where
 * body{overflow:hidden} clipped it away entirely. Measured overflow was
 * identical (785px) at 320x568, 360x640 and 390x844, i.e. the drawer never
 * constrained its content at any size.
 *
 * Three layers guard the fix, and it is worth being precise about what each one
 * can actually prove:
 *   - this file            the CSS/DOM contract, parsed rather than grepped
 *   - scripts/measure-mobile-nav.js   real geometry in headless Chrome over CDP
 *   - the screenshots it writes        human-checkable rendering
 * Headless Chrome has no browser toolbar, so it cannot demonstrate the one way
 * 100vh differs from 100dvh. That rung of the height ladder is therefore pinned
 * here, statically, and nowhere else.
 *
 * Nothing here clicks the restart button or touches the service.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/manage.html'), 'utf8');
const manageJs = fs.readFileSync(path.join(ROOT, 'public/manage.js'), 'utf8');
const hostSettingsJs = fs.readFileSync(path.join(ROOT, 'public/manage-host-settings.js'), 'utf8');

/**
 * assert.match on a 100KB+ source file prints the entire file on failure, which
 * buries the actual problem. Assert on the boolean and carry the explanation in
 * the message instead.
 */
function assertContains(haystack, needle, message) {
  assert.ok(
    needle instanceof RegExp ? needle.test(haystack) : haystack.includes(needle),
    `${message}\n  looked for: ${needle}`,
  );
}

const MOBILE = '(max-width:860px)';
const SHORT = '(max-width:860px) and (max-height:520px)';

// ── Running the drawer's real handlers, rather than matching their source ─────
//
// A regex over manage.js passes on code that is present but wired up wrong, and
// fails on a reformat that changes nothing. These helpers lift the three
// handlers out of the file and run them against a fake DOM (the sandbox style
// used by test-manage-ui-modules.js), so the assertions are about behaviour.

/**
 * Source of the statement starting at `startIndex`, brackets matched.
 *
 * Closing back to depth 0 is not the end on its own: `function f() {…}` returns
 * to 0 at the parameter list, and an IIFE returns to 0 before its `()`. So at
 * depth 0 the next meaningful character decides — `;` ends it, a continuation
 * (`(`, `[`, `.`, `{`) keeps going, anything else means the statement ended at
 * the bracket just closed.
 */
function statementAt(src, startIndex) {
  let i = startIndex;
  let depth = 0;
  let opened = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') { depth++; opened = true; }
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (opened && depth === 0) {
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === ';') return src.slice(startIndex, j + 1);
        if ('([.{'.includes(src[j])) { opened = false; i = j; continue; }
        return src.slice(startIndex, i + 1);
      }
    }
    i++;
  }
  throw new Error('unbalanced source while slicing a statement');
}

function classList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach(n => set.add(n)),
    remove: (...names) => names.forEach(n => set.delete(n)),
    contains: name => set.has(name),
    toggle(name) { return set.has(name) ? (set.delete(name), false) : (set.add(name), true); },
  };
}

/**
 * A fake page carrying just what the drawer handlers touch. `open` seeds
 * body.nav-open; `present` lists extra element ids that should exist (absent
 * ids return null, which is how the real page behaves for closed modals).
 */
function fakePage({ open = false, present = {}, innerWidth = 390 } = {}) {
  const focused = [];
  const observers = [];
  const listeners = [];
  const elements = new Map();

  const makeElement = (id, extra = {}) => {
    const node = {
      id,
      style: {},
      attrs: {},
      classList: classList(),
      setAttribute(name, val) { this.attrs[name] = String(val); },
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
      focus() { focused.push(id); },
      contains(other) { return other === this; },
      ...extra,
    };
    elements.set(id, node);
    return node;
  };

  const body = makeElement('body');
  body.classList = classList(open ? ['nav-open'] : []);
  makeElement('nav-toggle');
  makeElement('nav');
  for (const [id, extra] of Object.entries(present)) makeElement(id, extra);

  const context = {
    console,
    Object,
    String,
    innerWidth,
    // Globals the handlers close over on the real page.
    _focusedSessionId: null,
    closeCommitDiff() { context._closed.push('commit-diff'); },
    closeNewDirectoryModal() { context._closed.push('newdir'); },
    closeFocusPanel() { context._closed.push('focus-panel'); },
    _closed: [],
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.observing = true; }
    },
    document: {
      body,
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      getElementById(id) { return elements.get(id) || null; },
    },
  };
  context.window = context;
  vm.createContext(context);

  return {
    context,
    body,
    focused,
    element: id => elements.get(id),
    run(source) { vm.runInContext(source, context); return this; },
    dispatch(type, event = {}) {
      const matched = listeners.filter(l => l.type === type);
      assert.ok(matched.length > 0, `nothing listens for "${type}"`);
      for (const l of matched) l.handler({ defaultPrevented: false, ...event });
      return this;
    },
    /** Fire every MutationObserver, as the browser would on a class change. */
    flushObservers() {
      assert.ok(observers.length > 0, 'expected a MutationObserver to be registered');
      for (const o of observers) {
        assert.ok(o.observing, 'an observer was constructed but never observe()d');
        o.callback([], o);
      }
      return this;
    },
  };
}

const ESCAPE_HANDLER = (() => {
  // Anchor inside the drawer branch: _dialog() has its own Escape handler
  // earlier in the file, and anchoring on the key check finds that one.
  const anchor = manageJs.indexOf("if (document.body.classList.contains('nav-open'))");
  assert.ok(anchor > 0, 'the global Escape handler should still close the drawer');
  const source = statementAt(manageJs, manageJs.lastIndexOf('document.addEventListener(', anchor));
  assertContains(source, "e.key === 'Escape'", 'extracted the wrong listener');
  return source;
})();

const BACKDROP_HANDLER = (() => {
  const anchor = manageJs.indexOf("e.target.id !== 'nav-toggle'");
  assert.ok(anchor > 0, 'manage.js should still close the drawer on a backdrop tap');
  return statementAt(manageJs, manageJs.lastIndexOf('document.addEventListener(', anchor));
})();

const ARIA_SYNC = (() => {
  const anchor = manageJs.indexOf('const syncNavToggleAria');
  assert.ok(anchor > 0, 'manage.js should keep aria-expanded in sync');
  return statementAt(manageJs, manageJs.lastIndexOf('(() => {', anchor));
})();

/**
 * Minimal CSS reader: flattens <style> blocks into {media, selectors, body}.
 * Deliberately not a full parser — it only needs to survive the subset used in
 * manage.html, and it beats substring matching, which happily passes on text
 * that lives under some unrelated selector.
 */
function parseCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;

  function skipBalanced() {
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
  }

  function parseBlock(media) {
    while (i < src.length) {
      const start = i;
      while (i < src.length && src[i] !== '{' && src[i] !== '}') i++;
      if (i >= src.length) return;
      if (src[i] === '}') { i++; return; }
      const prelude = src.slice(start, i).trim();
      i++; // consume '{'
      if (/^@media/.test(prelude)) {
        parseBlock(prelude.replace(/^@media\s*/, '').trim());
      } else if (prelude.startsWith('@')) {
        skipBalanced();
      } else {
        const bodyStart = i;
        skipBalanced();
        out.push({
          media,
          selectors: prelude.split(',').map(s => s.trim()).filter(Boolean),
          body: src.slice(bodyStart, i - 1),
        });
      }
    }
  }

  parseBlock(null);
  return out;
}

const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
assert.ok(styleBlocks.length > 0, 'manage.html should carry an inline <style> block');
const RULES = styleBlocks.flatMap(parseCss);

/** All values declared for `prop` on `selector` in `media`, in source order. */
function values(selector, prop, media = null) {
  const found = [];
  for (const rule of RULES) {
    if ((rule.media || null) !== media) continue;
    if (!rule.selectors.includes(selector)) continue;
    for (const decl of rule.body.split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      if (decl.slice(0, idx).trim() !== prop) continue;
      found.push(decl.slice(idx + 1).trim());
    }
  }
  return found;
}

/** Last value wins, mirroring the cascade for equally-specific declarations. */
function value(selector, prop, media = null) {
  const all = values(selector, prop, media);
  return all.length ? all[all.length - 1] : null;
}

// ── Structure: which region each thing lives in ───────────────────────────────

test('drawer is three regions and the restart button is in the fixed one', () => {
  const aside = html.indexOf('<aside id="nav"');
  const scrollOpen = html.indexOf('<div id="nav-scroll">');
  const scrollClose = html.indexOf('/#nav-scroll');
  const bottom = html.indexOf('class="nav-bottom"');
  const restart = html.indexOf('id="svc-restart-btn"');
  const asideClose = html.indexOf('</aside>');

  assert.ok(aside >= 0, '#nav should exist');
  assert.ok(scrollOpen > aside, '#nav-scroll should open inside the drawer');
  assert.ok(scrollClose > scrollOpen, '#nav-scroll should be closed');
  assert.ok(bottom > scrollClose,
    '.nav-bottom must be a SIBLING after #nav-scroll, not nested inside it');
  assert.ok(restart > bottom && restart < asideClose,
    'the restart button must live in .nav-bottom — inside the scrolling list it can scroll out of reach');
});

test('the version read-out no longer relies on margin-top:auto to sit at the bottom', () => {
  // margin-top:auto only pushes while free space is positive. Once the content
  // outgrows the drawer it silently does nothing, which is how the old layout
  // failed. The flex column pins the bottom region instead.
  assert.equal(value('.nav-foot', 'margin-top'), null,
    '.nav-foot must not re-introduce margin-top:auto');
  const versionBar = html.slice(html.indexOf('id="version-bar"'), html.indexOf('id="version-bar"') + 220);
  assert.ok(!/margin-top:\s*auto/.test(versionBar),
    '#version-bar must not re-introduce margin-top:auto');
});

// ── The flex column, at every width ──────────────────────────────────────────

test('#nav is a clipping flex column that can shrink', () => {
  assert.equal(value('#nav', 'display'), 'flex');
  assert.equal(value('#nav', 'flex-direction'), 'column');
  assert.equal(value('#nav', 'min-height'), '0');
  assert.equal(value('#nav', 'overflow'), 'hidden');
});

test('#nav-scroll is the only scrolling region and may shrink below its content', () => {
  // Without min-height:0 a flex item refuses to shrink past its content height:
  // the column grows, and the action row leaves the viewport. This single
  // declaration is the core of the fix.
  assert.equal(value('#nav-scroll', 'min-height'), '0');
  assert.equal(value('#nav-scroll', 'overflow-y'), 'auto');
  assert.match(value('#nav-scroll', 'flex'), /^1 1 auto$/);
  assert.equal(value('#nav-scroll', 'overscroll-behavior'), 'contain',
    'scrolling the list must not chain into the page behind the drawer');
});

test('.nav-bottom is pinned and opaque', () => {
  assert.match(value('.nav-bottom', 'flex'), /^0 0 auto$/);
  assert.ok(value('.nav-bottom', 'background'),
    '.nav-bottom needs a background so the list passes behind it, not through it');
});

test('long action labels shrink instead of widening the row', () => {
  // flex items default to min-width:auto, so an untranslated "Restart Service"
  // would force the row wider than the drawer rather than wrapping.
  assert.equal(value('.nav-foot .hdr-btn', 'min-width'), '0');
});

// ── Dynamic viewport + safe area ─────────────────────────────────────────────

test('safe-area inset is reserved through a variable that collapses to 0 off-device', () => {
  const decl = value(':root', '--mc-safe-bottom');
  assert.ok(decl && decl.includes('env(safe-area-inset-bottom'),
    '--mc-safe-bottom should come from env(safe-area-inset-bottom, …)');
  assert.match(decl, /0px\s*\)/,
    'it needs a 0px fallback so desktop and non-notched browsers gain no stray whitespace');
  assert.equal(value('.nav-bottom', 'padding-bottom'), 'var(--mc-safe-bottom)',
    'the action row must sit above the home indicator / gesture bar');
});

test('the mobile drawer is sized by the dynamic viewport, with fallbacks', () => {
  const heights = values('#nav', 'height', MOBILE);
  assert.ok(heights.length >= 2, 'expected a height fallback ladder, got: ' + JSON.stringify(heights));
  assert.equal(heights[heights.length - 1], '100dvh',
    'the winning declaration must be 100dvh — 100vh is the large viewport and hides the bottom behind browser chrome');
  assert.ok(heights.includes('100vh'), 'keep a 100vh rung for browsers without dvh');
  assert.ok(heights.includes('-webkit-fill-available'),
    'keep the -webkit-fill-available rung for iOS Safari < 15.4');
  assert.equal(values('#nav', 'max-height', MOBILE).pop(), '100dvh');
});

test('the fixed drawer is not over-constrained', () => {
  // top + bottom + height together is over-constrained: the height is dropped
  // and the drawer is sized to the LARGE viewport again, reviving the bug.
  assert.equal(value('#nav', 'position', MOBILE), 'fixed');
  assert.equal(value('#nav', 'top', MOBILE), '0');
  assert.equal(value('#nav', 'bottom', MOBILE), 'auto',
    'bottom must stay auto so the dvh height actually applies');
});

// ── Small viewports ──────────────────────────────────────────────────────────

test('a too-short action row scrolls itself rather than trapping the page', () => {
  assert.equal(values('.nav-bottom', 'max-height', MOBILE).pop(), '60dvh');
  assert.equal(value('.nav-bottom', 'overflow-y', MOBILE), 'auto');
  assert.equal(value('.nav-bottom', 'overscroll-behavior', MOBILE), 'contain');
});

test('landscape phones drop the version read-out, never the actions', () => {
  assert.equal(value('#nav #version-bar', 'display', SHORT), 'none');
  // The action row must NOT be hidden anywhere — that is the whole point.
  for (const media of [MOBILE, SHORT, null]) {
    assert.notEqual(value('.nav-bottom', 'display', media), 'none');
    assert.notEqual(value('.nav-foot', 'display', media), 'none');
  }
});

test('touch targets are large enough across the whole drawer range', () => {
  // The drawer appears at 860px, so a 40px floor scoped to 640px left
  // 641–860px with 30px buttons.
  const minHeight = value('#nav .hdr-btn', 'min-height', MOBILE);
  assert.ok(minHeight && parseInt(minHeight, 10) >= 40,
    `expected >=40px touch targets at ${MOBILE}, got ${minHeight}`);
});

// ── Desktop must not regress ─────────────────────────────────────────────────

test('desktop keeps the in-flow sidebar', () => {
  assert.equal(value('#nav', 'position'), 'relative');
  assert.equal(value('#nav', 'visibility'), null,
    'the drawer visibility toggle belongs to the mobile query only');
  assert.equal(value('#nav', 'transform'), null,
    'desktop must never translate the sidebar off-screen');
  assert.equal(value('.nav-bottom', 'max-height'), null,
    'the 60dvh cap is a mobile-only concession');
});

// ── Accessibility of the drawer itself ───────────────────────────────────────

test('a closed drawer leaves the tab order', () => {
  // transform alone keeps ~25 controls focusable off-screen.
  assert.equal(value('#nav', 'visibility', MOBILE), 'hidden');
  assert.equal(value('body.nav-open #nav', 'visibility', MOBILE), 'visible');
  assert.equal(value('body.nav-open #nav', 'transform', MOBILE), 'none');
  assert.match(value('#nav', 'transition', MOBILE), /visibility/,
    'transition visibility too, or the drawer blanks on the first frame of the slide-out');
});

test('the toggle advertises drawer state', () => {
  const toggle = html.slice(html.indexOf('id="nav-toggle"') - 60, html.indexOf('id="nav-toggle"') + 220);
  assertContains(toggle, 'aria-controls="nav"', 'the toggle must point at the drawer it opens');
  assertContains(toggle, 'aria-expanded="false"', 'the drawer starts closed');

  // Four call sites toggle the class (button, backdrop, setView, Escape), so
  // the sync watches the class rather than trusting each of them to report.
  const page = fakePage({ open: false }).run(ARIA_SYNC);
  assert.equal(page.element('nav-toggle').getAttribute('aria-expanded'), 'false',
    'aria-expanded should be seeded on load, not only on the first toggle');

  page.body.classList.add('nav-open');
  page.flushObservers();
  assert.equal(page.element('nav-toggle').getAttribute('aria-expanded'), 'true');

  page.body.classList.remove('nav-open');
  page.flushObservers();
  assert.equal(page.element('nav-toggle').getAttribute('aria-expanded'), 'false');
});

test('Escape closes the drawer and hands focus back', () => {
  const page = fakePage({ open: true }).run(ESCAPE_HANDLER);
  page.dispatch('keydown', { key: 'Escape' });

  assert.equal(page.body.classList.contains('nav-open'), false, 'Escape should close the drawer');
  assert.deepEqual(page.focused, ['nav-toggle'],
    'focus must return to the toggle, or the keyboard user is left on an off-screen drawer');
});

test('one Escape never dismisses two stacked layers', () => {
  // _dialog() consumes Escape in the capture phase; the drawer must not also act.
  const consumed = fakePage({ open: true }).run(ESCAPE_HANDLER);
  consumed.dispatch('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(consumed.body.classList.contains('nav-open'), true,
    'a handled Escape must leave the drawer alone');

  // A modal above the drawer closes first, and the drawer stays open.
  const stacked = fakePage({
    open: true,
    present: { 'newdir-modal': { style: { display: 'flex' } } },
  }).run(ESCAPE_HANDLER);
  stacked.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(stacked.context._closed, ['newdir']);
  assert.equal(stacked.body.classList.contains('nav-open'), true,
    'the drawer is the outermost layer, so it closes last');

  const other = fakePage({ open: true }).run(ESCAPE_HANDLER);
  other.dispatch('keydown', { key: 'a' });
  assert.equal(other.body.classList.contains('nav-open'), true, 'only Escape closes the drawer');
});

test('backdrop tap-to-close survives the restructure', () => {
  const outside = fakePage({ open: true }).run(BACKDROP_HANDLER);
  outside.dispatch('click', { target: { id: 'main' } });
  assert.equal(outside.body.classList.contains('nav-open'), false,
    'a tap on the scrim should close the drawer');

  const inside = fakePage({ open: true }).run(BACKDROP_HANDLER);
  inside.dispatch('click', { target: inside.element('nav') });
  assert.equal(inside.body.classList.contains('nav-open'), true,
    'a tap inside the drawer — e.g. on the restart button — must not close it');

  const onToggle = fakePage({ open: true }).run(BACKDROP_HANDLER);
  onToggle.dispatch('click', { target: { id: 'nav-toggle' } });
  assert.equal(onToggle.body.classList.contains('nav-open'), true,
    'the toggle owns its own close, or the two handlers cancel out');

  const desktop = fakePage({ open: true, innerWidth: 1280 }).run(BACKDROP_HANDLER);
  desktop.dispatch('click', { target: { id: 'main' } });
  assert.equal(desktop.body.classList.contains('nav-open'), true,
    'the backdrop only exists below 860px');
});

// ── The restart button's behaviour is out of scope and must stay untouched ────

test('restart wiring and its confirmation are unchanged', () => {
  assertContains(html, /id="svc-restart-btn"[^>]*onclick="restartMulticcService\(\)"/,
    'this change is layout-only; the restart handler must not be rewired');

  // The handler lives in manage-host-settings.js, not the page facade.
  const start = hostSettingsJs.indexOf('async function restartMulticcService()');
  assert.ok(start > 0, 'restartMulticcService() should still be defined in manage-host-settings.js');
  const body = statementAt(hostSettingsJs, start);
  assertContains(body, 'showConfirm(',
    'the restart confirmation prompt must remain — nothing here may make restarting one click');
  assertContains(body, "fetch('/api/restart'",
    'restart must keep going through POST /api/restart');
  assert.ok(body.indexOf('showConfirm(') < body.indexOf("fetch('/api/restart'"),
    'the confirmation must gate the request, not follow it');
});
