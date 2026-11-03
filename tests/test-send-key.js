'use strict';

// Per-device send-key preference (public/send-key.js): the chat composer, the
// Air quick-task box, the voice HUD and the onboarding tour all ask the same
// module on keydown, so its rules are pinned here once.
const assert = require('node:assert/strict');
const test = require('node:test');

const sendKey = require('../public/send-key.js');

function makeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    dump() { return Object.fromEntries(data); },
  };
}

function throwingStorage() {
  return {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
  };
}

function fakeWindow() {
  const events = [];
  return { events, dispatchEvent(event) { events.push(event); return true; } };
}

function instanceWith(storage, platform) {
  return sendKey.create({
    storage,
    navigator: { platform: platform || 'MacIntel' },
    window: fakeWindow(),
  });
}

function key(overrides) {
  return Object.assign({ key: 'Enter' }, overrides || {});
}

test('defaults to enter, including when storage is empty or holds junk', () => {
  assert.deepEqual(sendKey.MODES, ['enter', 'mod-enter']);
  assert.equal(sendKey.STORE_KEY, 'multicc_send_key');
  assert.equal(instanceWith(makeStorage()).get(), 'enter');
  assert.equal(instanceWith(makeStorage({ multicc_send_key: 'mod-enter' })).get(), 'mod-enter');
  assert.equal(instanceWith(makeStorage({ multicc_send_key: 'nonsense' })).get(), 'enter');
  assert.equal(instanceWith(makeStorage({ multicc_send_key: '' })).get(), 'enter');
});

test('broken storage never throws and reads as the default', () => {
  const api = instanceWith(throwingStorage());
  assert.equal(api.get(), 'enter');
  assert.doesNotThrow(() => api.set('mod-enter'));
  assert.equal(api.set('mod-enter'), 'mod-enter');
  assert.equal(api.set('junk'), 'enter');
  assert.equal(api.get(), 'enter');
});

test('enter mode: Enter sends, Shift+Enter is a newline, Cmd/Ctrl also send', () => {
  const api = instanceWith(makeStorage());
  assert.equal(api.isSend(key()), true);
  assert.equal(api.isSend(key({ shiftKey: true })), false);
  assert.equal(api.isSend(key({ ctrlKey: true })), true);
  assert.equal(api.isSend(key({ metaKey: true })), true);
  assert.equal(api.isSend(key({ ctrlKey: true, shiftKey: true })), true);
});

test('mod-enter mode: plain Enter is a newline, Cmd/Ctrl + Enter sends', () => {
  const api = instanceWith(makeStorage({ multicc_send_key: 'mod-enter' }));
  assert.equal(api.isSend(key()), false);
  assert.equal(api.isSend(key({ shiftKey: true })), false);
  assert.equal(api.isSend(key({ ctrlKey: true })), true);
  assert.equal(api.isSend(key({ metaKey: true })), true);
});

test('every non-Enter key and IME composition are ignored in both modes', () => {
  for (const mode of sendKey.MODES) {
    const api = instanceWith(makeStorage({ multicc_send_key: mode }));
    assert.equal(api.isSend(key({ key: 'a' })), false);
    assert.equal(api.isSend(key({ isComposing: true })), false);
    // Safari's IME-confirm Enter arrives with isComposing=false, keyCode 229.
    assert.equal(api.isSend(key({ keyCode: 229 })), false);
    assert.equal(api.isSend(null), false);
  }
});

test('mobile soft keyboards never send on plain Enter, but Ctrl/Cmd + Enter still does', () => {
  for (const mode of sendKey.MODES) {
    const api = instanceWith(makeStorage({ multicc_send_key: mode }));
    assert.equal(api.isSend(key(), { mobile: true }), false);
    assert.equal(api.isSend(key({ ctrlKey: true }), { mobile: true }), true);
    assert.equal(api.isSend(key({ metaKey: true }), { mobile: true }), true);
  }
});

test('modLabel reports the platform modifier', () => {
  assert.equal(instanceWith(makeStorage(), 'MacIntel').modLabel(), '⌘');
  assert.equal(instanceWith(makeStorage(), 'Win32').modLabel(), 'Ctrl');
  assert.equal(instanceWith(makeStorage(), 'Linux x86_64').modLabel(), 'Ctrl');
  const iphone = sendKey.create({ storage: makeStorage(), navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
  assert.equal(iphone.modLabel(), '⌘');
  const uaData = sendKey.create({ storage: makeStorage(), navigator: { userAgentData: { platform: 'macOS' } } });
  assert.equal(uaData.modLabel(), '⌘');
});

test('set() persists the normalized mode and dispatches a same-document event', () => {
  const storage = makeStorage();
  const win = fakeWindow();
  const api = sendKey.create({ storage, navigator: { platform: 'MacIntel' }, window: win });
  assert.equal(api.set('mod-enter'), 'mod-enter');
  assert.equal(storage.dump()[sendKey.STORE_KEY], 'mod-enter');
  assert.equal(win.events.length, 1);
  assert.equal(win.events[0].type, 'multicc-send-key-change');
  assert.equal(api.get(), 'mod-enter');
  // Unknown values fall back to the default instead of being stored as-is.
  api.set('whatever');
  assert.equal(storage.dump()[sendKey.STORE_KEY], 'enter');
});

test('syncPlaceholder swaps the i18n key and repaints from t()', () => {
  let painted = null;
  const attrs = {};
  const el = { setAttribute(name, value) { attrs[name] = value; }, placeholder: '' };
  const api = sendKey.create({
    storage: makeStorage(),
    navigator: { platform: 'MacIntel' },
    translate: (k) => { painted = k; return 'copy:' + k; },
  });
  assert.equal(api.syncPlaceholder(el), 'airQuickTaskPlaceholder');
  assert.equal(attrs['data-i18n-placeholder'], 'airQuickTaskPlaceholder');
  assert.equal(el.placeholder, 'copy:airQuickTaskPlaceholder');
  assert.equal(painted, 'airQuickTaskPlaceholder');

  api.set('mod-enter');
  assert.equal(api.syncPlaceholder(el), 'airQuickTaskPlaceholderModEnterMac');
  assert.equal(el.placeholder, 'copy:airQuickTaskPlaceholderModEnterMac');

  const windows = sendKey.create({ storage: makeStorage({ multicc_send_key: 'mod-enter' }), navigator: { platform: 'Win32' } });
  assert.equal(windows.syncPlaceholder(el), 'airQuickTaskPlaceholderModEnterCtrl');
  assert.equal(api.syncPlaceholder(null), null);
});
