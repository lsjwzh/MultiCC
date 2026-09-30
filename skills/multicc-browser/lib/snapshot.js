'use strict';

// Accessibility-tree snapshot renderer. Pure functions over the node arrays
// returned by Accessibility.getFullAXTree, so the whole format is unit-testable
// without a browser.
//
// The output is a hybrid of DOM and AX: role + accessible name for every kept
// node, `[eN]` refs only for things a model can actually act on, and enough
// state (value/checked/disabled/…) that the model does not need a second call.

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem',
]);

const CONTENT_ROLES = new Set([
  'article', 'cell', 'columnheader', 'gridcell', 'heading', 'listitem', 'main',
  'navigation', 'region', 'rowheader',
]);

// Wrappers whose only job is layout: drop the line, promote the children.
const DROP_ROLES = new Set([
  'generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea',
]);

const TEXT_ROLES = new Set(['StaticText', 'text']);
const VALUE_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);
const MAX_TEXT_CHARS = 200;
const DEFAULT_MAX_CHARS = 12000;
const HARD_MAX_CHARS = 100000;
const TRUNCATION_MARKER = '\n[...TRUNCATED — use --interactive or scroll/text]';

function roleOf(node) {
  return node && node.role && typeof node.role.value === 'string' ? node.role.value : '';
}

function nameOf(node) {
  return node && node.name && typeof node.name.value === 'string' ? node.name.value : '';
}

function nodeValue(node) {
  if (!node || !node.value) return '';
  const value = node.value.value;
  return value === undefined || value === null ? '' : String(value);
}

function propertyMap(node) {
  const out = new Map();
  for (const entry of (node && node.properties) || []) {
    if (!entry || !entry.name) continue;
    out.set(entry.name, entry.value ? entry.value.value : undefined);
  }
  return out;
}

function truncate(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function isTextNode(node) {
  return TEXT_ROLES.has(roleOf(node));
}

function renderProperties(node, role) {
  const props = propertyMap(node);
  const parts = [];
  if (role === 'heading' && props.get('level') !== undefined) parts.push(`[level=${props.get('level')}]`);
  if (VALUE_ROLES.has(role)) {
    const value = nodeValue(node);
    if (value) parts.push(`value=${JSON.stringify(truncate(value, MAX_TEXT_CHARS))}`);
  }
  for (const key of ['checked', 'pressed', 'expanded', 'selected']) {
    const value = props.get(key);
    if (value !== undefined && value !== null) parts.push(`${key}=${value}`);
  }
  if (props.get('required') === true) parts.push('required');
  if (props.get('disabled') === true) parts.push('disabled');
  if (props.get('focused') === true) parts.push('focused');
  return parts;
}

function formatLine(role, name, ref, props) {
  const parts = [`${role} ${JSON.stringify(truncate(name, MAX_TEXT_CHARS))}`];
  if (ref) parts.push(`[e${ref}]`);
  parts.push(...props);
  return parts.join(' ');
}

// Renders one AX tree. `frames` carries already-resolved child frames so the
// same numbering continues across them (document order: main frame first).
function renderSnapshot(nodes, options = {}) {
  const {
    page = null,
    url = null,
    tab = null,
    maxChars = DEFAULT_MAX_CHARS,
    interactive = false,
    frames = [],
    header = true,
  } = options;

  const indexOf = list => {
    const map = new Map();
    for (const node of list || []) {
      if (node && node.nodeId !== undefined && node.nodeId !== null) map.set(String(node.nodeId), node);
    }
    return map;
  };
  const index = indexOf(nodes);
  // AX nodeIds are only unique inside one frame's tree, so switching frames
  // swaps the lookup map rather than merging the two.
  let active = index;

  const lines = [];
  const refs = {};
  const nthCounters = new Map();
  let refSeq = 0;

  function pushLine(text, depth) {
    lines.push({ text, depth });
  }

  function childrenOf(node) {
    const ids = (node && node.childIds) || [];
    return ids.map(id => active.get(String(id))).filter(Boolean);
  }

  function rootsOf(list, map) {
    return (list || []).filter(node => {
      const parentId = node && node.parentId !== undefined && node.parentId !== null
        ? String(node.parentId)
        : null;
      return !parentId || !map.has(parentId);
    });
  }

  function assignRef(node, role, name) {
    refSeq += 1;
    const key = `${role}\u0000${name}`;
    const nth = nthCounters.get(key) || 0;
    nthCounters.set(key, nth + 1);
    refs[`e${refSeq}`] = {
      backendDOMNodeId: node.backendDOMNodeId,
      frameId: node.frameId || null,
      role,
      name,
      nth,
    };
    return refSeq;
  }

  // Consecutive StaticText siblings collapse into a single `text` line; text
  // that merely repeats its parent's accessible name is what the parent line
  // already says.
  function renderChildren(node, depth, parentName) {
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const merged = buffer.join(' ').replace(/\s+/g, ' ').trim();
      buffer = [];
      if (!merged) return;
      if (parentName && merged === parentName) return;
      pushLine(`text ${JSON.stringify(truncate(merged, MAX_TEXT_CHARS))}`, depth);
    };
    for (const child of childrenOf(node)) {
      if (isTextNode(child)) {
        const text = nameOf(child);
        if (text) buffer.push(text);
        continue;
      }
      flush();
      visit(child, depth);
    }
    flush();
  }

  function visit(node, depth) {
    const role = roleOf(node);
    if (node.ignored === true || DROP_ROLES.has(role)) {
      renderChildren(node, depth, nameOf(node));
      return;
    }
    if (isTextNode(node)) {
      const text = nameOf(node);
      if (text) pushLine(`text ${JSON.stringify(truncate(text, MAX_TEXT_CHARS))}`, depth);
      return;
    }
    const name = nameOf(node);
    const interactiveRole = INTERACTIVE_ROLES.has(role);
    const contentRole = CONTENT_ROLES.has(role);
    // Unnamed wrappers carry no information of their own: promote the children
    // instead of burning a line on `paragraph ""`.
    if (!interactiveRole && !name) {
      renderChildren(node, depth, name);
      return;
    }
    if (contentRole && !name) {
      renderChildren(node, depth, name);
      return;
    }
    const hasBackend = typeof node.backendDOMNodeId === 'number';
    const ref = interactiveRole && hasBackend ? assignRef(node, role, name) : null;
    pushLine(formatLine(role, name, ref, renderProperties(node, role)), depth);
    renderChildren(node, depth + 1, name);
  }

  const mainRoots = rootsOf(nodes, index);
  for (const root of (mainRoots.length ? mainRoots : (nodes || []).slice(0, 1))) visit(root, 0);

  for (const frame of frames || []) {
    const label = frame.name ? `iframe ${JSON.stringify(truncate(frame.name, MAX_TEXT_CHARS))}` : 'iframe';
    if (frame.nodes && frame.nodes.length) {
      pushLine(label, 0);
      const before = lines.length;
      const frameIndex = indexOf(frame.nodes);
      const previous = active;
      active = frameIndex;
      const frameRoots = rootsOf(frame.nodes, frameIndex);
      try {
        for (const root of (frameRoots.length ? frameRoots : frame.nodes.slice(0, 1))) visit(root, 1);
      } finally {
        active = previous;
      }
      if (lines.length === before) pushLine('(no accessible content)', 1);
    } else if (frame.crossOrigin !== false) {
      pushLine(`${label} (cross-origin, not expanded)`, 0);
    }
  }

  let text;
  if (interactive) {
    text = lines.filter(line => /\[e\d+\]/.test(line.text)).map(line => line.text).join('\n');
  } else {
    const headerLine = header
      ? [`page: ${page || '(untitled)'}${url ? ` — ${url}` : ''}${tab ? `  [tab ${tab}]` : ''}`]
      : [];
    text = [...headerLine, ...lines.map(line => `${'  '.repeat(line.depth)}- ${line.text}`)].join('\n');
  }

  const limit = Math.min(Math.max(Number(maxChars) || DEFAULT_MAX_CHARS, 200), HARD_MAX_CHARS);
  let truncated = false;
  if (text.length > limit) {
    text = text.slice(0, limit) + TRUNCATION_MARKER;
    truncated = true;
  }
  return { text, refs, lines: lines.length, truncated };
}

module.exports = {
  INTERACTIVE_ROLES,
  CONTENT_ROLES,
  DROP_ROLES,
  VALUE_ROLES,
  MAX_TEXT_CHARS,
  DEFAULT_MAX_CHARS,
  HARD_MAX_CHARS,
  TRUNCATION_MARKER,
  roleOf,
  nameOf,
  nodeValue,
  propertyMap,
  truncate,
  renderProperties,
  renderSnapshot,
};
