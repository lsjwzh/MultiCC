'use strict';

/**
 * Interaction contract for opening a commit's diff from the /manage Git tree.
 *
 * The rows used to open on `dblclick`, which is undiscoverable — nothing on the
 * row said "double click me", and a single click did nothing at all. They now
 * open on a single click, which drags three obligations along with it:
 *
 *   - a click that ends a text selection inside the row is the user copying a
 *     hash, not asking for a diff, and must not open the modal;
 *   - a row that opens a view has to be reachable by keyboard (role + tabindex
 *     + Enter/Space), the way the chat diff card's file rows are real buttons;
 *   - a habitual double click now delivers two opens, and the second must not
 *     restart the fetch and queue a second aux summary for the commit already
 *     on screen.
 *
 * These are behaviours, not text, so the real handlers are lifted out of
 * manage.html and run against a fake DOM (the sandbox style established by
 * test-manage-mobile-nav-layout.js / test-manage-ui-modules.js). A regex would
 * pass on code that is present but wired to the wrong event.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/manage.html'), 'utf8');

/**
 * Source of the statement starting at `startIndex`, brackets matched.
 * Same reader as tests/test-manage-mobile-nav-layout.js — see the comment there
 * for why closing back to depth 0 is not on its own the end of a statement.
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

function functionSource(name) {
  const anchor = html.indexOf(`function ${name}(`);
  assert.ok(anchor > 0, `manage.html should still define ${name}()`);
  return statementAt(html, anchor);
}

// ── Fake DOM ─────────────────────────────────────────────────────────────────
// Only what these two handlers touch. `contains` walks the real child list so
// the selection guard is exercised rather than assumed.

function makeNode(tag) {
  const node = {
    tagName: tag,
    children: [],
    style: {},
    attrs: {},
    listeners: {},
    className: '',
    textContent: '',
    title: '',
    tabIndex: undefined,
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...next) {
      this.children = [];
      for (const child of next) {
        if (child && child.tagName === '#fragment') this.children.push(...child.children);
        else if (child != null) this.children.push(child);
      }
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    contains(other) {
      if (other === this) return true;
      return this.children.some(child => child.contains && child.contains(other));
    },
    fire(type, event = {}) {
      const handlers = this.listeners[type] || [];
      assert.ok(handlers.length > 0, `the row has no "${type}" handler`);
      for (const handler of handlers) handler(event);
    },
  };
  return node;
}

/** Elements are created on demand, so a missing id is a bug in the page, not here. */
function fakeDocument() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, Object.assign(makeNode('div'), { id }));
      return byId.get(id);
    },
    createElement: makeNode,
    createTextNode: value => Object.assign(makeNode('#text'), { textContent: String(value) }),
    createDocumentFragment: () => makeNode('#fragment'),
  };
}

function sandbox(extra = {}) {
  const context = {
    console,
    String,
    Object,
    Array,
    JSON,
    Date,
    Math,
    encodeURIComponent,
    Promise,
    document: fakeDocument(),
    getSelection: () => null,
    ...extra,
  };
  context.window = context;
  vm.createContext(context);
  return context;
}

const COMMIT = {
  short: 'a2b629d',
  hash: 'a2b629d1111111111111111111111111111111f',
  subject: '提交树点击 commit 开 diff 详情',
  author: 'green',
  date: '2026-07-20 10:00:00 +0800',
  refs: 'HEAD -> main, origin/main',
};

/** Renders one commit row with a stubbed openCommitDiff, and hands both back. */
function renderOneRow(overrides = {}) {
  const opened = [];
  const context = sandbox({
    openCommitDiff: (...args) => opened.push(args),
    ...overrides,
  });
  vm.runInContext(functionSource('gitTreeText'), context);
  vm.runInContext(functionSource('renderGitTree'), context);
  vm.runInContext('renderGitTree({ commits: [COMMIT] });', Object.assign(context, { COMMIT }));
  const rows = context.document.getElementById('git-tree-body').children;
  assert.equal(rows.length, 1, 'one commit should render exactly one row');
  return { row: rows[0], opened, context };
}

test('a single click on a commit row opens that commit’s diff', () => {
  const { row, opened } = renderOneRow();
  row.fire('click', {});
  assert.deepEqual(opened, [[COMMIT.short, COMMIT.subject, COMMIT.hash]]);
});

test('the row advertises itself as clickable, to the eye and to a screen reader', () => {
  const { row } = renderOneRow();
  assert.equal(row.getAttribute('role'), 'button');
  assert.equal(row.tabIndex, 0, 'a role=button that cannot be tabbed to is a lie');
  assert.equal(row.style.cursor, 'pointer');
  assert.ok(row.title.includes('diff'), 'the tooltip should say what the click does');
  const chevron = row.children.find(child => child.className === 'git-chevron');
  assert.ok(chevron, 'the row needs the chevron affordance the chat diff card uses');
});

test('a click that ends a text selection inside the row is a copy, not an open', () => {
  const { row, opened, context } = renderOneRow();
  const hashSpan = row.children.find(child => child.className === 'git-hash');
  context.getSelection = () => ({
    isCollapsed: false,
    anchorNode: hashSpan,
    toString: () => COMMIT.short,
  });
  row.fire('click', {});
  assert.deepEqual(opened, [], 'selecting the hash to copy it must not open the modal');

  // A stale selection left somewhere else on the page must not swallow the click.
  context.getSelection = () => ({
    isCollapsed: false,
    anchorNode: makeNode('div'),
    toString: () => 'text elsewhere',
  });
  row.fire('click', {});
  assert.equal(opened.length, 1, 'a selection outside the row is not this row’s business');
});

test('Enter and Space open the row from the keyboard, and nothing else does', () => {
  const { row, opened } = renderOneRow();
  const prevented = [];
  const key = k => ({ key: k, preventDefault: () => prevented.push(k) });

  row.fire('keydown', key('Tab'));
  row.fire('keydown', key('a'));
  assert.deepEqual(opened, [], 'only the activation keys open a row');

  row.fire('keydown', key('Enter'));
  row.fire('keydown', key(' '));
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[1], [COMMIT.short, COMMIT.subject, COMMIT.hash]);
  // Space is the page-scroll key; activating a row must not also scroll the list.
  assert.deepEqual(prevented, ['Enter', ' ']);
});

test('a row missing one of short/hash still opens with the identifier it has', () => {
  const opened = [];
  const context = sandbox({ openCommitDiff: (...args) => opened.push(args) });
  vm.runInContext(functionSource('gitTreeText'), context);
  vm.runInContext(functionSource('renderGitTree'), context);
  context.DATA = { commits: [{ hash: 'deadbeefdeadbeef' }] };
  vm.runInContext('renderGitTree(DATA);', context);
  context.document.getElementById('git-tree-body').children[0].fire('click', {});
  assert.deepEqual(opened, [['deadbeefdeadbeef', '', 'deadbeefdeadbeef']]);
});

// ── The double-click consequence ─────────────────────────────────────────────

/** openCommitDiff wired to a fetch that never settles, so only the guard runs. */
function commitDiffSandbox() {
  const fetched = [];
  const context = sandbox({
    fetch: (url) => { fetched.push(url); return new Promise(() => {}); },
    _gcdAbort: null,
    _gcdReqToken: 0,
    _gcdCtx: null,
    _gitTreeDir: 'dir-1',
  });
  for (const name of ['gcdClearAi', 'cancelGcdSummary', 'openCommitDiff']) {
    vm.runInContext(functionSource(name), context);
  }
  return { context, fetched };
}

test('a double click does not fetch the same commit twice', () => {
  const { context, fetched } = commitDiffSandbox();
  const open = () => context.openCommitDiff(COMMIT.short, COMMIT.subject, COMMIT.hash);

  open();
  assert.equal(fetched.length, 1);
  assert.equal(context.document.getElementById('git-commit-diff-modal').style.display, 'flex');

  open();  // the second half of the double click
  assert.equal(fetched.length, 1, 'the re-entrancy guard should have swallowed it');
  assert.equal(context._gcdReqToken, 1, 'a swallowed open must not invalidate the live fetch');
});

test('the guard is per-commit, and lifts once the modal is closed', () => {
  const { context, fetched } = commitDiffSandbox();
  context.openCommitDiff(COMMIT.short, COMMIT.subject, COMMIT.hash);

  context.openCommitDiff('ce5e7cf', 'another commit', 'ce5e7cf2222222222222222222222222222222a');
  assert.equal(fetched.length, 2, 'a different commit is a real open, not a repeat');

  // backToGitTree()/closeCommitDiff() hide the modal; re-opening must work again.
  context.document.getElementById('git-commit-diff-modal').style.display = 'none';
  context.openCommitDiff('ce5e7cf', 'another commit', 'ce5e7cf2222222222222222222222222222222a');
  assert.equal(fetched.length, 3);
});

test('the diff request carries the tree’s directory and the full hash', () => {
  const { context, fetched } = commitDiffSandbox();
  context.openCommitDiff(COMMIT.short, COMMIT.subject, COMMIT.hash);
  assert.ok(fetched[0].startsWith('/api/git/commit-diff?'), 'reuses the existing authed git route');
  assert.ok(fetched[0].includes(`dirId=${encodeURIComponent('dir-1')}`), 'dirId scopes the repo');
  assert.ok(fetched[0].includes(`hash=${COMMIT.hash}`), 'the short hash would be ambiguous');
});
