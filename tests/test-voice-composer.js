'use strict';

// The shared voice composer (public/voice-composer.js): the Chat page and the
// Air directory's quick-task composer must run the same dictation. Chat is the
// reference — the module is chat-composer.js's voice half, extracted — and Air
// only supplies its own input/mic and an onCommit that submits the quick form.
//
// Two of these tests drive the module directly, one drives it through the Chat
// composer (proving onCommit really is send()), and the last one is the static
// wiring contract for air.html / air.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const VOICE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'voice-composer.js'), 'utf8');
const COMPOSER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'chat-composer.js'), 'utf8');

function fakeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); },
  };
}

function fakeElement(extra = {}) {
  return Object.assign({
    classList: fakeClassList(),
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    placeholder: '',
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    focus() {},
    scrollHeight: 32,
    dataset: {},
  }, extra);
}

function input(value = '') {
  return { value, style: {}, scrollHeight: 32, focus() {} };
}

// A document whose getElementById answers the ids the voice module looks up.
function voiceDocument(ids) {
  return {
    activeElement: null,
    getElementById(id) { return ids.get(id) || null; },
    createElement() { return fakeElement(); },
    createTextNode(text) { return { textContent: text }; },
  };
}

function hudIds() {
  const ids = new Map();
  for (const id of ['voice-hud', 'vh-raw-text', 'vh-refined-text', 'vh-status-text', 'vh-cancel', 'vh-send']) {
    ids.set(id, fakeElement());
  }
  return ids;
}

function loadVoice(options) {
  const doc = options.document;
  const win = Object.assign({
    document: doc,
    navigator: { userAgent: 'test', mediaDevices: null },
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
    AbortController,
  }, options.window || {});
  const context = vm.createContext({ window: win, console, setTimeout, clearTimeout });
  vm.runInContext(VOICE_SRC, context, { filename: 'voice-composer.js' });
  return { api: win.MultiCCVoiceComposer, window: win };
}

test('the shared module exports a frozen createVoiceComposer factory', () => {
  const ids = hudIds();
  const { api } = loadVoice({ document: voiceDocument(ids) });
  assert.equal(Object.isFrozen(api), true);
  assert.equal(typeof api.createVoiceComposer, 'function');
  const composer = api.createVoiceComposer({
    document: voiceDocument(ids), navigator: {}, location: {}, autoBind: false,
    input: input(), micButton: fakeElement(), fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  });
  assert.equal(Object.isFrozen(composer), true);
  for (const name of ['startRecording', 'stopRecording', 'uploadAudioForSTT',
    'startStreamingVoice', 'commitStreamingVoice', 'cancelStreamingVoice',
    'showVoicePanel', 'closeVoicePanel', 'useVoiceText', 'fetchRefined']) {
    assert.equal(typeof composer[name], 'function', `${name} must be exposed`);
  }
});

test('a HUD commit replaces the input value and calls onCommit exactly once', async () => {
  const ids = hudIds();
  const document = voiceDocument(ids);
  const inputEl = input('原有草稿');
  const commits = [];
  const { api } = loadVoice({ document });
  const composer = api.createVoiceComposer({
    document, navigator: {}, location: {}, autoBind: false, input: inputEl,
    micButton: fakeElement(),
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    onCommit: text => commits.push(text),
  });
  ids.get('vh-raw-text').textContent = '原始识别';
  ids.get('vh-refined-text').textContent = '精修后的文本';

  await composer.commitStreamingVoice();
  assert.equal(inputEl.value, '精修后的文本', 'the HUD replaces the input, chat-style');
  assert.deepEqual(commits, ['精修后的文本'], 'onCommit fires once with the committed text');
  assert.equal(ids.get('voice-hud').classList.contains('open'), false, 'the HUD closes on commit');
});

test('a HUD commit falls back to the raw transcript when there is no refine', async () => {
  const ids = hudIds();
  const document = voiceDocument(ids);
  const inputEl = input('');
  const commits = [];
  const { api } = loadVoice({ document });
  const composer = api.createVoiceComposer({
    document, navigator: {}, location: {}, autoBind: false, input: inputEl,
    micButton: fakeElement(),
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    onCommit: text => commits.push(text),
  });
  ids.get('vh-raw-text').textContent = '只有原话';
  await composer.commitStreamingVoice();
  assert.equal(inputEl.value, '只有原话');
  assert.deepEqual(commits, ['只有原话']);
});

test('cancelling the voice HUD leaves the input and onCommit untouched', () => {
  const ids = hudIds();
  const document = voiceDocument(ids);
  const inputEl = input('别动我');
  const commits = [];
  const { api } = loadVoice({ document });
  const composer = api.createVoiceComposer({
    document, navigator: {}, location: {}, autoBind: false, input: inputEl,
    micButton: fakeElement(), onCommit: text => commits.push(text),
  });
  ids.get('voice-hud').classList.add('open');
  composer.cancelStreamingVoice();
  assert.equal(inputEl.value, '别动我', 'cancel never rewrites the input');
  assert.deepEqual(commits, [], 'cancel never commits');
  assert.equal(ids.get('voice-hud').classList.contains('open'), false);
});

test('chat-composer delegates its voice API and commit runs send()', async () => {
  const ids = hudIds();
  const document = voiceDocument(ids);
  const win = {
    document,
    navigator: { userAgent: 'test', mediaDevices: {} },
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
    AbortController,
  };
  const context = vm.createContext({ window: win, console, setTimeout, clearTimeout });
  vm.runInContext(VOICE_SRC, context, { filename: 'voice-composer.js' });
  vm.runInContext(COMPOSER_SRC, context, { filename: 'chat-composer.js' });

  const sent = [];
  const inputEl = input('');
  const composer = win.MultiCCChatComposer.createComposer({
    window: win, document, navigator: win.navigator, location: win.location,
    autoBind: false,
    elements: { input: inputEl, micButton: fakeElement() },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    isSocketOpen: () => true,
    transportSend: payload => { sent.push(payload); return true; },
    updateUi() {}, addSystemMessage() {},
  });
  ids.get('vh-raw-text').textContent = '发出去的句子原文';
  ids.get('vh-refined-text').textContent = '发出去的句子';
  await composer.commitStreamingVoice();
  assert.equal(sent.length, 1, 'onCommit is the chat send() path');
  assert.equal(sent[0].text, '发出去的句子');
  assert.equal(sent[0].inputSource, 'voice', 'a dictated send is marked as voice input');
  assert.equal(sent[0].voiceRaw, '发出去的句子原文', 'the raw ASR transcript rides along for the model');
  assert.equal(inputEl.value, '', 'send() clears the input it just filled');
});

test('chat-composer still loads (voice inert) when the shared module is absent', () => {
  const document = voiceDocument(new Map());
  const win = {
    document,
    navigator: { userAgent: 'test', mediaDevices: null },
    location: { protocol: 'http:', host: 'localhost:3000' },
  };
  const context = vm.createContext({ window: win, console, setTimeout, clearTimeout });
  // No voice-composer.js in the sandbox at all.
  vm.runInContext(COMPOSER_SRC, context, { filename: 'chat-composer.js' });
  const composer = win.MultiCCChatComposer.createComposer({
    window: win, document, navigator: win.navigator, location: win.location,
    autoBind: false, elements: { input: input('x') },
  });
  assert.equal(typeof composer.startStreamingVoice, 'function');
  assert.equal(typeof composer.cancelStreamingVoice, 'function');
  assert.equal(composer.uploadAudioForSTT({}), false, 'degraded voice stays callable and inert');
});

test('Air wires the same voice composer on its quick-task box', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'air.html'), 'utf8');
  const air = fs.readFileSync(path.join(ROOT, 'public', 'air.js'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);

  const voice = scripts.indexOf('voice-composer.js');
  const stream = scripts.indexOf('voice-stream.js');
  const airIndex = scripts.indexOf('air.js');
  assert.ok(voice !== -1, 'air.html must load voice-composer.js');
  assert.ok(stream !== -1, 'air.html must load voice-stream.js for the streaming path');
  assert.ok(voice < airIndex, 'voice-composer.js must load before air.js');
  assert.ok(stream < voice, 'the VoiceStream class must exist before the composer uses it');

  // Same HUD and refine panel markup as chat.html.
  assert.match(html, /id="voice-hud"/);
  assert.match(html, /id="vh-raw-text"/);
  assert.match(html, /id="vh-refined-text"/);
  assert.match(html, /id="voice-panel"/);
  assert.match(html, /id="mic-toast"/);
  assert.ok(html.includes('voice-composer.css'), 'the shared styles must be linked');

  // The one-shot inline dictation is gone; the composer is the only path.
  assert.equal(/toggleQuickDictation/.test(air), false, 'the old inline dictation must be removed');
  assert.match(air, /MultiCCVoiceComposer/, 'air.js must build the shared composer');
  assert.match(air, /onCommit: \(\) => \$\('quick-task-form'\)\.requestSubmit\(\)/,
    'committing voice on Air submits the quick-task form');
});
