'use strict';

// mbrowser's snapshot renderer is a pure function over Accessibility.getFullAXTree
// output, so the whole format — which roles survive, which get a ref, how values
// and states read, and where the truncation marker lands — is pinned here without
// a browser.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderSnapshot,
  roleOf,
  nameOf,
  nodeValue,
  propertyMap,
  renderProperties,
  truncate,
  MAX_TEXT_CHARS,
  DEFAULT_MAX_CHARS,
  TRUNCATION_MARKER,
  INTERACTIVE_ROLES,
  DROP_ROLES,
} = require('../skills/multicc-browser/lib/snapshot');

function node(id, role, name, extra = {}) {
  const entry = { nodeId: id };
  if (role !== undefined) entry.role = { value: role };
  if (name !== undefined) entry.name = { value: name };
  return { ...entry, ...extra };
}

// A page shaped like a real sign-in form: a heading, promoted wrapper text, two
// identically named buttons, an input with a value, and a stateful checkbox.
function signInTree() {
  return [
    node(1, 'RootWebArea', 'Demo', { childIds: [2, 3, 4, 5, 6, 7, 8, 10] }),
    node(2, 'heading', 'Sign in', { parentId: 1, backendDOMNodeId: 101, properties: [{ name: 'level', value: { value: 2 } }] }),
    node(3, 'paragraph', '', { parentId: 1, childIds: [9] }),
    node(9, 'StaticText', 'Welcome back', { parentId: 3 }),
    node(4, 'textbox', 'Email', { parentId: 1, backendDOMNodeId: 102, value: { value: 'a@b.c' } }),
    node(5, 'button', 'Sign in', { parentId: 1, backendDOMNodeId: 103, properties: [{ name: 'disabled', value: { value: true } }] }),
    node(6, 'button', 'Sign in', { parentId: 1, backendDOMNodeId: 104 }),
    node(7, 'checkbox', 'Remember', { parentId: 1, backendDOMNodeId: 105, properties: [{ name: 'checked', value: { value: 'true' } }] }),
    node(8, 'link', 'Forgot?', { parentId: 1, backendDOMNodeId: 106 }),
    node(10, 'generic', '', { parentId: 1, childIds: [11] }),
    node(11, 'StaticText', 'Footer text', { parentId: 10 }),
  ];
}

test('role and name helpers survive the shapes Chrome actually sends', () => {
  assert.equal(roleOf(node(1, 'button', 'x')), 'button');
  assert.equal(roleOf({ role: {} }), '');
  assert.equal(roleOf(null), '');
  assert.equal(nameOf(node(1, 'button', 'x')), 'x');
  assert.equal(nameOf({ name: { value: 7 } }), '');
  assert.equal(nameOf(undefined), '');
  assert.equal(nodeValue({ value: { value: 0 } }), '0');
  assert.equal(nodeValue({ value: { value: null } }), '');
  assert.deepEqual([...propertyMap({ properties: [{ name: 'a', value: { value: 1 } }, { name: 'b' }, null] })],
    [['a', 1], ['b', undefined]]);
});

test('only interactive roles get refs, numbered in document order', () => {
  const rendered = renderSnapshot(signInTree(), { page: 'Demo', url: 'https://x.test/', tab: 'abc12345' });
  assert.equal(rendered.text.split('\n')[0], 'page: Demo — https://x.test/  [tab abc12345]');
  assert.deepEqual(Object.keys(rendered.refs), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(rendered.refs.e1, {
    backendDOMNodeId: 102, frameId: null, role: 'textbox', name: 'Email', nth: 0,
  });
  // Two buttons with the same accessible name are still distinct refs.
  assert.equal(rendered.refs.e2.nth, 0);
  assert.equal(rendered.refs.e3.nth, 1);
  assert.equal(rendered.refs.e3.backendDOMNodeId, 104);
  // A named non-interactive node (heading) is rendered but never referenced.
  assert.match(rendered.text, /- heading "Sign in" \[level=2\]$/m);
  assert.equal(Object.values(rendered.refs).some(entry => entry.role === 'heading'), false);
});

test('names, values and states are rendered on the line that owns them', () => {
  const rendered = renderSnapshot(signInTree(), {});
  assert.match(rendered.text, /- textbox "Email" \[e1\] value="a@b\.c"/);
  assert.match(rendered.text, /- button "Sign in" \[e2\] disabled/);
  assert.match(rendered.text, /- button "Sign in" \[e3\]$/m);
  assert.match(rendered.text, /- checkbox "Remember" \[e4\] checked=true/);
  assert.match(rendered.text, /- link "Forgot\?" \[e5\]$/m);
  // An unnamed wrapper is promoted instead of burning a line on `paragraph ""`.
  assert.doesNotMatch(rendered.text, /paragraph/);
  assert.doesNotMatch(rendered.text, /generic/);
  assert.doesNotMatch(rendered.text, /RootWebArea/);
  // Consecutive StaticText siblings collapse into one text line.
  assert.match(rendered.text, /- text "Welcome back"/);
  assert.match(rendered.text, /- text "Footer text"/);
});

test('interactive mode drops the header and every line without a ref', () => {
  const rendered = renderSnapshot(signInTree(), {
    page: 'Demo', url: 'https://x.test/', interactive: true,
  });
  assert.deepEqual(rendered.text.split('\n'), [
    'textbox "Email" [e1] value="a@b.c"',
    'button "Sign in" [e2] disabled',
    'button "Sign in" [e3]',
    'checkbox "Remember" [e4] checked=true',
    'link "Forgot?" [e5]',
  ]);
  assert.equal(rendered.truncated, false);
  // Same numbering as the full snapshot, so a ref taken before switching modes
  // still means the same element.
  assert.deepEqual(Object.keys(rendered.refs), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('child frames continue the numbering and never merge AX nodeIds', () => {
  const frameNodes = [
    // nodeId 1 is reused inside the frame: ids are only unique per frame.
    node(1, 'RootWebArea', 'Inner', { childIds: [2] }),
    node(2, 'button', 'Inside frame', { parentId: 1, backendDOMNodeId: 900, frameId: 'FRAME1' }),
  ];
  const rendered = renderSnapshot(signInTree(), {
    frames: [{ name: 'checkout', url: 'https://pay.test/', nodes: frameNodes }],
  });
  assert.match(rendered.text, /- iframe "checkout"/);
  assert.equal(rendered.refs.e6.backendDOMNodeId, 900);
  assert.equal(rendered.refs.e6.frameId, 'FRAME1');
  assert.match(rendered.text, /- button "Inside frame" \[e6\]/);

  const crossOrigin = renderSnapshot(signInTree(), {
    frames: [{ name: 'ads', crossOrigin: true }],
  });
  assert.match(crossOrigin.text, /- iframe "ads" \(cross-origin, not expanded\)/);
});

test('long text is truncated per line and the whole snapshot carries a marker', () => {
  const long = 'x'.repeat(MAX_TEXT_CHARS + 50);
  const rendered = renderSnapshot([node(1, 'button', long, { backendDOMNodeId: 1 })], {});
  assert.match(rendered.text, new RegExp(`"${'x'.repeat(MAX_TEXT_CHARS - 1)}…"`));

  const many = [];
  for (let index = 0; index < 200; index += 1) {
    many.push(node(index + 1, 'button', `button number ${index}`, { backendDOMNodeId: index + 1 }));
  }
  const small = renderSnapshot(many, { maxChars: 200, header: false });
  assert.equal(small.truncated, true);
  assert.equal(small.text.endsWith(TRUNCATION_MARKER), true);
  // 200 is the floor: no caller can ask for a snapshot clipped below it.
  assert.equal(small.text.length, 200 + TRUNCATION_MARKER.length);
  const wide = renderSnapshot(many, { maxChars: DEFAULT_MAX_CHARS });
  assert.equal(wide.truncated, false);
  assert.equal(wide.text.endsWith(TRUNCATION_MARKER), false);
});

test('the header can be suppressed and defaults stay documented', () => {
  assert.equal(renderSnapshot(signInTree(), { header: false }).text.startsWith('- '), true);
  assert.equal(renderSnapshot(signInTree(), {}).text.startsWith('page: (untitled)'), true);
  assert.match(renderSnapshot([], {}).text, /^page: \(untitled\)$/);
  assert.deepEqual(Object.keys(renderSnapshot([], {}).refs), []);
});

test('the exported role sets stay internally consistent', () => {
  for (const role of DROP_ROLES) assert.equal(INTERACTIVE_ROLES.has(role), false, role);
  for (const role of INTERACTIVE_ROLES) assert.equal(typeof role, 'string');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'ab…');
  assert.equal(truncate(null, 3), '');
  assert.deepEqual(renderProperties({ properties: [{ name: 'required', value: { value: true } }] }, 'textbox'), ['required']);
  assert.deepEqual(renderProperties({ properties: [{ name: 'level', value: { value: 3 } }] }, 'heading'), ['[level=3]']);
});
