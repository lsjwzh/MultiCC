'use strict';

// Keyboard chords → CDP Input.dispatchKeyEvent parameters.
//
// Pure data + one parser, so the mapping is unit-testable. `commands` matters on
// macOS: a synthesized Cmd-C reaches the renderer as a key event that does not
// trigger the browser-level edit command, so cut/copy/paste/undo/selectAll must
// be named explicitly.

const { MbError } = require('./paths');

const MODIFIERS = Object.freeze({
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
});

const KEY_TABLE = {
  Enter: { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', virtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', virtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', virtualKeyCode: 36 },
  End: { key: 'End', code: 'End', virtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' },
};
for (let index = 1; index <= 12; index += 1) {
  KEY_TABLE[`F${index}`] = {
    key: `F${index}`,
    code: `F${index}`,
    virtualKeyCode: 111 + index,
  };
}
Object.freeze(KEY_TABLE);

const COMMAND_KEYS = Object.freeze({
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
});

function printableDescriptor(char, modifiers) {
  if (char === ' ') {
    return { key: ' ', code: 'Space', virtualKeyCode: 32 };
  }
  if (/^[a-z]$/i.test(char)) {
    return { key: char, code: `Key${char.toUpperCase()}`, virtualKeyCode: char.toUpperCase().charCodeAt(0) };
  }
  if (/^[0-9]$/.test(char)) {
    return { key: char, code: `Digit${char}`, virtualKeyCode: char.charCodeAt(0) };
  }
  if (char.length === 1) {
    // Punctuation: VK_UNKNOWN is fine, Chrome resolves it from `text`.
    const shifted = Boolean(modifiers & MODIFIERS.shift);
    return { key: char, code: '', virtualKeyCode: 0, shifted };
  }
  return null;
}

// 'ctrl+shift+a', 'MetaOrControl+V', 'Enter', 'F5', 'k'.
function parseChord(spec) {
  const raw = String(spec === undefined || spec === null ? '' : spec).trim();
  if (!raw) throw new MbError('usage', 'press needs a key, e.g. `press Enter` or `press ctrl+a`');
  const parts = raw.split('+').map(part => part.trim()).filter(Boolean);
  let modifiers = 0;
  let last = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'metaorcontrol' || lower === 'cmdorctrl' || lower === 'commandorcontrol') {
      // The spelling local_browser_use.py used: Cmd on macOS, Ctrl elsewhere.
      modifiers |= process.platform === 'darwin' ? MODIFIERS.meta : MODIFIERS.ctrl;
    } else if (MODIFIERS[lower] !== undefined && part !== parts[parts.length - 1]) {
      modifiers |= MODIFIERS[lower];
    } else {
      last = part;
    }
  }
  if (!last) throw new MbError('usage', `"${raw}" has modifiers but no key`);
  const named = KEY_TABLE[last] || KEY_TABLE[`${last.slice(0, 1).toUpperCase()}${last.slice(1).toLowerCase()}`];
  if (named) {
    const chord = { key: named.key, code: named.code, virtualKeyCode: named.virtualKeyCode, modifiers };
    if (named.text !== undefined && modifiers === 0) chord.text = named.text;
    return chord;
  }
  const printable = printableDescriptor(last, modifiers);
  if (!printable) throw new MbError('usage', `unsupported key "${last}"; use a named key (Enter, Tab, ArrowUp, F5, …) or one printable character`);
  const chord = {
    key: printable.key,
    code: printable.code,
    virtualKeyCode: printable.virtualKeyCode,
    modifiers,
  };
  const editing = modifiers & (MODIFIERS.ctrl | MODIFIERS.meta);
  if (editing) {
    const command = COMMAND_KEYS[printable.key.toLowerCase()];
    if (command) chord.commands = [command];
  } else {
    const shifted = modifiers & MODIFIERS.shift;
    chord.text = shifted && /^[a-z]$/i.test(printable.key) ? printable.key.toUpperCase() : printable.key;
  }
  return chord;
}

function keyEventParams(chord, type) {
  const params = {
    type,
    modifiers: chord.modifiers,
    key: chord.key,
    code: chord.code,
    windowsVirtualKeyCode: chord.virtualKeyCode,
    nativeVirtualKeyCode: chord.virtualKeyCode,
  };
  if (type === 'keyDown' || type === 'char') {
    if (chord.text !== undefined) params.text = chord.text;
    if (chord.commands) params.commands = chord.commands;
    if (!chord.commands && chord.modifiers === 0) params.unmodifiedText = chord.text || '';
  }
  return params;
}

module.exports = { MODIFIERS, KEY_TABLE, COMMAND_KEYS, parseChord, keyEventParams, printableDescriptor };
