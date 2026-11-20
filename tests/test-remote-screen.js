'use strict';

// Tests for the browser-side 「🖥 屏幕」layer: public/chat-remote-input.js,
// public/chat-remote-screen.js and the h264 adapter, driven in a VM.
//
// The Node hop this file used to sit beside — src/remote-screen.js starting and
// supervising the multicc-remote process, then relaying HTTP and WS — has been
// deleted. The Rust front door owns /api/remote-screen/* and /ws/remote-screen
// now, and that behaviour is pinned by native/gateway/tests/remote_child.rs,
// remote_screen.rs, ws_remote_screen.rs and remote_screen_wiring.rs. Nothing
// here covers supervision any more; only what the browser actually sends.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-screen-test-'));
process.env.MULTICC_DATA_DIR = tmp;
process.env.MULTICC_AGENT_DIR = path.join(tmp, 'agent');

// ── 共享输入层（public/chat-remote-input.js）──
// 它只认 DOM 事件 + adapter 回调，所以给一个最小 DOM 就能在 VM 里精确断言
// 「这一指到底发了什么」。三种画面模式的字节格式由各自的 adapter 用例守着。
function inputHarness(opts = {}) {
  const vm = require('node:vm');
  const stageListeners = new Map();
  const docListeners = new Map();
  const addTo = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const dropFrom = (map, type, fn) => {
    const list = map.get(type) || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  };
  const makeClassList = () => {
    const set = new Set();
    return {
      add: name => set.add(name),
      remove: name => set.delete(name),
      contains: name => set.has(name),
      toggle: (name, on) => { if (on == null ? !set.has(name) : on) set.add(name); else set.delete(name); },
    };
  };
  const makeNode = tag => ({
    tagName: String(tag).toUpperCase(), className: '', textContent: '', style: {}, dataset: {}, hidden: false,
    children: [], classList: makeClassList(),
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { addTo(this._listeners || (this._listeners = new Map()), type, fn); },
    removeEventListener(type, fn) { dropFrom(this._listeners || new Map(), type, fn); },
    setAttribute() {}, remove() {}, focus() {}, blur() {}, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
  });
  const document = {
    hidden: false, readyState: 'complete',
    createElement: tag => makeNode(tag),
    addEventListener(type, fn) { addTo(docListeners, type, fn); },
    removeEventListener(type, fn) { dropFrom(docListeners, type, fn); },
  };
  const stage = makeNode('div');
  stage.ownerDocument = document;
  stage.addEventListener = (type, fn) => addTo(stageListeners, type, fn);
  stage.removeEventListener = (type, fn) => dropFrom(stageListeners, type, fn);
  stage.setPointerCapture = () => {};
  stage.appendChild = child => { stage.children.push(child); return child; };
  const window = {
    document, navigator: {}, crypto: { randomUUID: () => 'viewer' },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const context = { window, document, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, console };
  vm.runInNewContext(fs.readFileSync('public/chat-remote-input.js', 'utf8'), context);
  assert.ok(window.MultiCCRemoteInput, 'input layer must publish MultiCCRemoteInput');
  const sent = { pointer: [], key: [], wheel: [], setZoom: [], panBy: [] };
  const adapter = Object.assign({
    kind: opts.kind || 'rfb',
    point: opts.point || ((cx, cy) => ({ x: Math.round(cx), y: Math.round(cy) })),
    pointer(mask, x, y) { sent.pointer.push([mask, x, y]); },
    wheel(bit, x, y, held) { sent.wheel.push([bit, x, y, held]); },
    key(down, ks) { sent.key.push([down ? 1 : 0, ks]); },
  }, opts.adapter || {});
  const input = window.MultiCCRemoteInput.create(Object.assign({
    stage,
    modifier: () => opts.modifier || 'cmd',
    control: () => (opts.control ? opts.control() : true),
    adapter: () => adapter,
    zoom: () => opts.zoom || { scale: 1, tx: 0, ty: 0 },
    setZoom: (scale, tx, ty) => sent.setZoom.push([scale, tx, ty]),
    panBy: (dx, dy) => sent.panBy.push([dx, dy]),
    stageRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  }, opts.extra || {}));
  const fire = (type, ev) => { for (const fn of [...(stageListeners.get(type) || [])]) fn(ev); };
  const fireDoc = (type, ev) => { for (const fn of [...(docListeners.get(type) || [])]) fn(ev); };
  return { input, sent, fire, fireDoc, stage, document, window, MultiCCRemoteInput: window.MultiCCRemoteInput };
}

const pev = (type, pointerId, clientX, clientY, extra = {}) => ({
  type, pointerId, pointerType: 'touch', button: 0, buttons: 0, clientX, clientY,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.stopped = true; },
  ...extra,
});
const kev = (type, extra = {}) => ({
  type, code: 'KeyA', key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  preventDefault() { this.defaultPrevented = true; }, ...extra,
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('two fingers only pinch locally: the Mac receives no pointer at all', () => {
  const h = inputHarness();
  h.fire('pointerdown', pev('pointerdown', 1, 100, 100));
  h.fire('pointerdown', pev('pointerdown', 2, 200, 100));
  h.fire('pointermove', pev('pointermove', 1, 80, 100));
  h.fire('pointermove', pev('pointermove', 2, 240, 100));
  h.fire('pointerup', pev('pointerup', 1, 80, 100));
  h.fire('pointerup', pev('pointerup', 2, 240, 100));
  assert.deepEqual(h.sent.pointer, []);
  assert.ok(h.sent.setZoom.length > 0, 'the local view still zooms');
});

test('a live drag is released before a second finger turns the gesture into pinch', () => {
  const h = inputHarness();
  h.fire('pointerdown', pev('pointerdown', 1, 100, 100));
  h.fire('pointermove', pev('pointermove', 1, 130, 100));
  assert.deepEqual(h.sent.pointer, [[1, 100, 100], [1, 130, 100]]);
  h.fire('pointerdown', pev('pointerdown', 2, 250, 100)); // 第二指：先松开按钮
  assert.deepEqual(h.sent.pointer[2], [0, 130, 100]);
  h.fire('pointermove', pev('pointermove', 1, 90, 100));
  h.fire('pointermove', pev('pointermove', 2, 300, 100));
  assert.equal(h.sent.pointer.length, 3, 'pinch sends nothing after the release');
});

test('a 500ms touch hold without moving is a right click and its lift sends nothing more', async () => {
  const h = inputHarness();
  h.fire('pointerdown', pev('pointerdown', 1, 300, 200));
  await pause(520);
  assert.deepEqual(h.sent.pointer, [[4, 300, 200], [0, 300, 200]]);
  h.fire('pointerup', pev('pointerup', 1, 300, 200));
  assert.equal(h.sent.pointer.length, 2);
});

test('one finger stays the mouse when zoomed: it drags instead of panning the view', () => {
  const h = inputHarness({ zoom: { scale: 2, tx: -100, ty: 0 } });
  h.fire('pointerdown', pev('pointerdown', 1, 100, 100));
  h.fire('pointermove', pev('pointermove', 1, 104, 102)); // 未超过 slop
  assert.deepEqual(h.sent.pointer, []);
  h.fire('pointermove', pev('pointermove', 1, 120, 110));
  assert.deepEqual(h.sent.pointer[0], [1, 100, 100], 'press happens at the down point');
  h.fire('pointermove', pev('pointermove', 1, 400, 500));
  h.fire('pointerup', pev('pointerup', 1, 400, 500));
  assert.deepEqual(h.sent.pointer.at(-1), [0, 400, 500]);
  assert.deepEqual(h.sent.setZoom, [], 'one finger never changes the local zoom');
});

test('a tap inside slop is a click at the down point; a drag is never a click', () => {
  const h = inputHarness();
  h.fire('pointerdown', pev('pointerdown', 1, 50, 60));
  h.fire('pointermove', pev('pointermove', 1, 55, 63));
  h.fire('pointerup', pev('pointerup', 1, 55, 63));
  assert.deepEqual(h.sent.pointer, [[1, 50, 60], [0, 50, 60]]);
});

test('right-once turns the next tap into a right click and is consumed once', () => {
  let armed = true;
  const h = inputHarness({ extra: { rightOnce: () => armed, onRightUsed: () => { armed = false; } } });
  h.fire('pointerdown', pev('pointerdown', 1, 70, 80));
  h.fire('pointerup', pev('pointerup', 1, 70, 80));
  assert.deepEqual(h.sent.pointer, [[4, 70, 80], [0, 70, 80]]);
  h.fire('pointerdown', pev('pointerdown', 1, 90, 80));
  h.fire('pointerup', pev('pointerup', 1, 90, 80));
  assert.deepEqual(h.sent.pointer.slice(2), [[1, 90, 80], [0, 90, 80]]);
});

test('desktop mouse presses left/middle/right immediately with the RFB mask bits', () => {
  const h = inputHarness();
  const mev = (type, button, buttons) => pev(type, 9, 120, 140, { pointerType: 'mouse', button, buttons });
  h.fire('pointerdown', mev('pointerdown', 2, 2)); // right
  h.fire('pointerup', mev('pointerup', 2, 0));
  h.fire('pointerdown', mev('pointerdown', 1, 4)); // middle
  h.fire('pointerup', mev('pointerup', 1, 0));
  h.fire('pointerdown', mev('pointerdown', 0, 1)); // left
  h.fire('pointermove', mev('pointermove', 0, 1));
  h.fire('pointerup', mev('pointerup', 0, 0));
  assert.deepEqual(h.sent.pointer.map(sample => sample[0]), [4, 0, 2, 0, 1, 1, 0]);
});

test('sticky chips emit real modifier KeyEvents and one-shot chips release after the action', () => {
  const h = inputHarness();
  assert.equal(h.input.chipTap('cmd'), 'once');
  assert.deepEqual(h.sent.key, [[1, 0xffe7]]);
  h.input.pressKeys('cmd+a');
  assert.deepEqual(h.sent.key.slice(1), [[1, 97], [0, 97], [0, 0xffe7]]);
  assert.equal(h.input.chipState('cmd'), 'off', 'one-shot chip is used up');
  h.input.chipTap('shift');
  h.input.chipTap('shift'); // 连点两下 = 锁定
  assert.equal(h.input.chipState('shift'), 'lock');
  h.input.pressKeys('shift+Tab');
  assert.equal(h.input.chipState('shift'), 'lock', 'locked chip survives the action');
  assert.deepEqual(h.sent.key.slice(-2), [[1, 0xff09], [0, 0xff09]]);
  h.input.chipTap('shift');
  assert.equal(h.input.chipState('shift'), 'off');
  assert.deepEqual(h.sent.key.at(-1), [0, 0xffe1]);
});

test('mods() reports sticky modifiers for the HTTP adapter and follows the host keyboard', () => {
  const h = inputHarness({ modifier: 'ctrl' });
  h.input.chipTap('cmd');
  h.input.chipTap('shift');
  assert.deepEqual([...h.input.mods()], ['shift', 'ctrl']);
  assert.deepEqual(h.sent.key, [[1, 0xffe3], [1, 0xffe1]]);
});

test('text box sends tagged Unicode, Return and Tab over the stream channel', () => {
  const h = inputHarness();
  h.input.sendText('中\tA\n');
  assert.deepEqual(h.sent.key, [
    [1, 0x01004e2d], [0, 0x01004e2d],
    [1, 0xff09], [0, 0xff09],
    [1, 65], [0, 65],
    [1, 0xff0d], [0, 0xff0d],
  ]);
});

test('physical keyboard maps by ev.code, keeps left/right modifiers, and waits for compositionend', () => {
  const h = inputHarness();
  h.fireDoc('keydown', kev('keydown', { code: 'KeyA', key: 'a' }));
  h.fireDoc('keyup', kev('keyup', { code: 'KeyA', key: 'a' }));
  assert.deepEqual(h.sent.key, [[1, 97], [0, 97]]);
  // ⌥+a 在 Mac 上 ev.key 是「å」：必须取 ev.code 的基础键 a，交给 Agent 组和弦。
  h.fireDoc('keydown', kev('keydown', { code: 'KeyA', key: 'å', altKey: true }));
  h.fireDoc('keyup', kev('keyup', { code: 'KeyA', key: 'å', altKey: true }));
  assert.deepEqual(h.sent.key.slice(2), [[1, 97], [0, 97]]);
  h.fireDoc('keydown', kev('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  h.fireDoc('keyup', kev('keyup', { code: 'ShiftLeft', key: 'Shift' }));
  assert.deepEqual(h.sent.key.slice(4), [[1, 0xffe1], [0, 0xffe1]]);
  h.fireDoc('compositionstart', kev('compositionstart'));
  h.fireDoc('keydown', kev('keydown', { key: 'Process', isComposing: true }));
  assert.equal(h.sent.key.length, 6, 'nothing is sent while composing');
  h.fireDoc('compositionend', kev('compositionend', { data: '中文' }));
  assert.deepEqual(h.sent.key.slice(6), [
    [1, 0x01004e2d], [0, 0x01004e2d], [1, 0x01006587], [0, 0x01006587],
  ]);
});

test('releaseAll lifts held buttons, keys and chips (view-only / blur / mode switch)', () => {
  const h = inputHarness();
  h.fireDoc('keydown', kev('keydown', { code: 'KeyA', key: 'a' }));
  h.input.chipTap('alt');
  h.fire('pointerdown', pev('pointerdown', 1, 200, 150));
  h.fire('pointermove', pev('pointermove', 1, 220, 150));
  h.input.releaseAll();
  const tail = h.sent.pointer.slice(-1)[0];
  assert.deepEqual(tail, [0, 220, 150]);
  assert.deepEqual(h.sent.key.slice(-2), [[0, 97], [0, 0xffe9]]);
  assert.equal(h.input.mods().length, 0);
});

test('box-select started during a live drag releases the button and the next tap stays a click', () => {
  let boxOn = false;
  let started = 0, ended = 0;
  const h = inputHarness({ extra: {
    boxSelecting: () => boxOn,
    onBoxStart: () => { started += 1; },
    onBoxEnd: () => { ended += 1; },
  } });
  h.fire('pointerdown', pev('pointerdown', 1, 100, 100));
  h.fire('pointermove', pev('pointermove', 1, 130, 100));
  assert.deepEqual(h.sent.pointer, [[1, 100, 100], [1, 130, 100]]);
  assert.ok(h.input._heartbeat, 'a live drag keeps the heartbeat alive');
  boxOn = true;
  h.fire('pointerdown', pev('pointerdown', 2, 250, 120)); // 第二指开始框选
  assert.deepEqual(h.sent.pointer.at(-1), [0, 130, 100], 'the held button is released at the last point');
  assert.equal(h.input._heartbeat, null, 'the heartbeat stops with the press');
  assert.equal(started, 1);
  h.fire('pointerup', pev('pointerup', 1, 130, 100)); // 原来那根手指抬起（框选还在）
  assert.deepEqual(h.sent.pointer.at(-1), [0, 130, 100], 'a stray lift sends nothing');
  h.fire('pointermove', pev('pointermove', 2, 320, 200));
  h.fire('pointerup', pev('pointerup', 2, 320, 200)); // 框选结束
  assert.equal(ended, 1);
  assert.equal(h.input._pts.size, 0, 'the stray pointer left no residue behind');
  boxOn = false;
  h.sent.pointer.length = 0;
  h.fire('pointerdown', pev('pointerdown', 3, 60, 70));
  h.fire('pointerup', pev('pointerup', 3, 60, 70));
  assert.deepEqual(h.sent.pointer, [[1, 60, 70], [0, 60, 70]], 'the next tap is a click, not a pinch');
  assert.deepEqual(h.sent.setZoom, [], 'no local pinch was triggered');
});

test('a cancelled or too-small box selection releases a live pointer', () => {
  const { probe } = webHarness();
  let released = 0;
  const state = { closed: false, regionLoading: false, boxSelOn: true, boxFrom: { x: 1, y: 1 },
    boxBtn: { classList: { toggle() {} } }, boxRect: { hidden: false },
    stage: { classList: { toggle() {} }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    input: { releasePointer() { released += 1; } } };
  probe.set(state);
  probe.boxFinish(50, 50, 60, 58); // 对角线 12.8 < 24：误触
  assert.equal(released, 1, 'the short-diagonal finish releases the held button');
  assert.equal(state.boxSelOn, false);
  state.boxSelOn = true;
  probe.boxCancel();
  assert.equal(released, 2, 'cancel releases too');
});

test('releaseAll repaints the chips and a following ⌘C sends cmd down / c / cmd up', () => {
  let paints = 0;
  const h = inputHarness({ extra: { onChips: () => { paints += 1; } } });
  h.input.chipTap('cmd');
  assert.equal(h.input.chipState('cmd'), 'once');
  assert.deepEqual(h.sent.key, [[1, 0xffe7]]);
  h.input.releaseAll();
  assert.equal(h.input.chipState('cmd'), 'off');
  assert.deepEqual(h.sent.key, [[1, 0xffe7], [0, 0xffe7]]);
  assert.equal(paints, 1, 'releaseAll repaints the chip row');
  h.input.chipTap('cmd');
  h.input.pressKeys('cmd+c');
  assert.deepEqual(h.sent.key.slice(2), [[1, 0xffe7], [1, 99], [0, 99], [0, 0xffe7]]);
  assert.equal(h.input.chipState('cmd'), 'off', 'the one-shot chip is used up exactly once');
});

test('a locked chip survives a physical modifier press/release and auto-repeat', () => {
  const h = inputHarness();
  h.input.chipTap('shift');
  h.input.chipTap('shift'); // 连点两下 = 锁定
  assert.equal(h.input.chipState('shift'), 'lock');
  assert.deepEqual(h.sent.key, [[1, 0xffe1]]);
  h.fireDoc('keydown', kev('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  h.fireDoc('keydown', kev('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true, repeat: true }));
  assert.deepEqual(h.sent.key, [[1, 0xffe1]], 'the same keysym is held once; auto-repeat adds nothing');
  h.fireDoc('keyup', kev('keyup', { code: 'ShiftLeft', key: 'Shift' }));
  assert.deepEqual(h.sent.key, [[1, 0xffe1]], 'the physical up does not release the locked chip');
  assert.equal(h.input.chipState('shift'), 'lock');
  h.input.chipTap('shift');
  assert.equal(h.input.chipState('shift'), 'off');
  assert.deepEqual(h.sent.key.at(-1), [0, 0xffe1]);
});

test('releasing a chip while the physical modifier is down sends no up', () => {
  const h = inputHarness();
  h.fireDoc('keydown', kev('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
  assert.deepEqual(h.sent.key, [[1, 0xffe1]]);
  h.input.chipTap('shift'); // once（同一个 keysym 已经按住，不再发 down）
  h.input.chipTap('shift'); // lock
  h.input.chipTap('shift'); // 点亮时再点 = 释放
  assert.equal(h.input.chipState('shift'), 'off');
  assert.deepEqual(h.sent.key, [[1, 0xffe1]], 'the chip release is swallowed while the physical key holds Shift');
  h.fireDoc('keyup', kev('keyup', { code: 'ShiftLeft', key: 'Shift' }));
  assert.deepEqual(h.sent.key.at(-1), [0, 0xffe1]);
});

test('wheel accumulates 40px per notch on both axes and pulses RFB wheel masks', () => {
  const h = inputHarness();
  const wheel = (deltaX, deltaY) => ({ deltaX, deltaY, deltaMode: 0, clientX: 300, clientY: 300,
    preventDefault() {}, stopPropagation() {}, target: h.stage });
  h.fire('wheel', wheel(0, 120));
  return pause(120).then(() => {
    assert.deepEqual(h.sent.wheel, [[16, 300, 300, 0], [16, 300, 300, 0], [16, 300, 300, 0]]);
    h.fire('wheel', wheel(-90, 0));
    return pause(120);
  }).then(() => {
    assert.deepEqual(h.sent.wheel.slice(3), [[32, 300, 300, 0], [32, 300, 300, 0]]);
  });
});

test('the H.264 view is display-only and exposes the stream input API', () => {
  const src = fs.readFileSync('public/chat-remote-screen-h264.js', 'utf8');
  assert.doesNotMatch(src, /addEventListener\('keydown'/);
  assert.doesNotMatch(src, /_onPointer|_onWheel|_onKey/);
  for (const name of ['sendPointer', 'sendKey', 'releaseAll', 'clientToInput']) {
    assert.match(src, new RegExp('\\b' + name + '\\('), name + ' must stay public for the input layer');
  }
  assert.match(src, /get inputWidth\(\)/);
  assert.match(src, /get inputHeight\(\)/);
});

test('vendored noVNC still exposes the message helpers the web input layer writes through', () => {
  const src = fs.readFileSync('public/vendor/novnc/core/rfb.js', 'utf8');
  assert.match(src, /RFB\.messages = \{/, 'noVNC upgrade moved the message helpers');
  assert.match(src, /keyEvent\(sock, keysym, down\)/);
  assert.match(src, /pointerEvent\(sock, x, y, mask\)/);
  assert.match(src, /this\._sock = new Websock\(\)/);
  const host = fs.readFileSync('public/chat-remote-screen.js', 'utf8');
  assert.match(host, /messages\.pointerEvent\(view\._sock/);
  assert.match(host, /messages\.keyEvent\(view\._sock/);
  assert.match(host, /s\.rfb\.viewOnly = true;/);
});

test('chat.html loads the shared input layer between the viewer and the host', () => {
  const html = fs.readFileSync('public/chat.html', 'utf8');
  const input = html.indexOf('chat-remote-input.js');
  assert.ok(input > 0, 'chat.html must include chat-remote-input.js');
  assert.ok(input > html.indexOf('chat-remote-screen-h264.js'));
  assert.ok(input < html.indexOf('"chat-remote-screen.js"'));
});

test('the keybar and text box stay usable in every control mode, including stream modes', () => {
  const { probe } = webHarness();
  const state = {
    control: false, chips: [], hint: { textContent: '' }, keybar: { hidden: true },
    modeBtn: { textContent: '', classList: { toggle() {} } }, rfb: { viewOnly: true }, unhalt: {},
  };
  probe.set(state);
  probe.setControl(true);
  assert.equal(state.keybar.hidden, false, 'smooth stream: keybar / text box visible in control mode');
  assert.equal(state.rfb.viewOnly, true, 'noVNC itself stays view-only; the shared layer sends input');
  probe.setControl(false);
  assert.equal(state.keybar.hidden, true, 'view-only hides the keybar');
  clearInterval(state.haltTimer);
  state.rfb = null;
  probe.setControl(true);
  assert.equal(state.keybar.hidden, false, 'compatibility / H.264 modes show it too');
  clearInterval(state.haltTimer);
});

test('the HTTP adapter merges sticky chip modifiers into its ops', async () => {
  const { context, probe } = webHarness();
  const state = { control: true, screenW: 400, screenH: 200, unhalt: {}, input: { mods: () => ['shift', 'cmd'] },
    img: { naturalWidth: 400, naturalHeight: 200, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) } };
  probe.set(state);
  const sent = [];
  context.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; };
  const adapter = probe.httpAdapter();
  adapter.press('cmd+a');
  adapter.scroll(-2, 1, 30, 40);
  await pause(20);
  assert.deepEqual(sent, [
    { op: 'press', keys: 'cmd+a', mods: ['shift', 'cmd'] },
    { op: 'scroll', x: 30, y: 40, amount: -2, amountX: 1, mods: ['shift', 'cmd'] },
  ]);
});

// ── 浏览器侧（public/chat-remote-screen.js）：与 Rust 迁移无关，原样保留 ──

// Execute the actual browser functions with controlled geometry and transport.
function webHarness() {
  const vm = require('node:vm');
  const window = { addEventListener() {} };
  const document = { readyState: 'loading', addEventListener() {}, querySelector() { return null; },
    createElement() { return { style: {}, remove() {} }; } };
  const context = { window, document, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, fetch: null };
  let source = fs.readFileSync('public/chat-remote-screen.js', 'utf8');
  // 钩子按源码文本改这一行：导出表一变，这里就得跟着变（少了它就是 probe 未定义，
  // 两个用例一起红 —— 这正是「让测试自己告诉你它被改坏了」的那条线）。
  source = source.replace('global.MultiCCRemoteScreen = Object.freeze({ open, close, openMode });',
    'global.probe = { toScreen, applyBoxZoom, loop, resetZoom, httpAdapter, adapterFor, boxFinish, boxCancel, setControl, set: value => { s = value; ov = { appendChild() {}, classList: { toggle() {} } }; }, zoom };');
  vm.runInNewContext(source, context);
  return { context, probe: window.probe };
}

test('http adapter streams before lift and coalesces motion behind a slow request', async () => {
  const { context, probe } = webHarness();
  const state = {
    control: true, screenW: 400, screenH: 200, unhalt: {},
    img: { naturalWidth: 400, naturalHeight: 200, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) },
  };
  probe.set(state);
  const sent = [];
  let finish;
  context.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const adapter = probe.httpAdapter();
  adapter.pointer(1, 50, 50);
  assert.equal(sent.length, 1, 'press has left the browser before the lift');
  assert.deepEqual([sent[0].op, sent[0].mask, sent[0].x], ['pointer', 1, 50]);
  adapter.pointer(1, 80, 50);
  adapter.pointer(1, 100, 50);
  adapter.pointer(1, 120, 50);
  adapter.pointer(0, 130, 50);
  finish();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.map(sample => [sample.mask, sample.x]), [[1, 50], [1, 120], [0, 130]]);
  assert.ok(sent.every(sample => sample.op === 'pointer'));
});

test('http adapter retains dragging when an older Agent lacks the pointer protocol', async () => {
  const { context, probe } = webHarness();
  const state = { control: true, screenW: 400, screenH: 200, unhalt: {},
    img: { naturalWidth: 400, naturalHeight: 200, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) } };
  probe.set(state);
  const sent = [];
  context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    return { ok: true, json: async () => body.op === 'pointer'
      ? { ok: false, error: 'unknown op: pointer' } : { ok: true } };
  };
  const adapter = probe.httpAdapter();
  adapter.pointer(1, 50, 50);
  adapter.pointer(1, 100, 50);
  adapter.pointer(0, 120, 50);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.map(body => body.op), ['pointer', 'drag']);
  assert.deepEqual([sent[1].x, sent[1].x2], [50, 120]);
});

test('http adapter sends right/middle presses as click.button, never as a left drag', async () => {
  const { context, probe } = webHarness();
  const state = { control: true, screenW: 400, screenH: 200, unhalt: {},
    img: { naturalWidth: 400, naturalHeight: 200, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) } };
  probe.set(state);
  const sent = [];
  context.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; };
  const adapter = probe.httpAdapter();
  adapter.pointer(4, 40, 60);
  adapter.pointer(4, 90, 90);
  adapter.pointer(0, 100, 100);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, [{ op: 'click', x: 40, y: 60, button: 'right' }]);
  adapter.pointer(2, 10, 10);
  adapter.pointer(0, 10, 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent[1], { op: 'click', x: 10, y: 10, button: 'middle' });
});

test('web crops use image letterboxing and nested origins; view-only sends no input', async () => {
  const { context, probe } = webHarness();
  const state = {
    screenW: 1000, screenH: 500, viewRegion: { x: 200, y: 100, width: 400, height: 200 },
    region: null, regionEpoch: 0, running: true, closed: false, control: false,
    img: { naturalWidth: 800, naturalHeight: 400, style: {}, getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 400 }) },
    stage: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
    zoomer: { style: {} }, zoomBadge: {}, modeBtn: { classList: { toggle() {} } },
    keybar: {}, hint: {}, status: { classList: { toggle() {} } }, pauseBtn: {},
  };
  probe.set(state);
  const p = probe.toScreen({ clientX: 210, clientY: 220 });
  assert.deepEqual([p.x, p.y], [400, 200]);
  assert.equal(probe.toScreen({ clientX: 210, clientY: 50 }), null, 'letterbox does not map to an input');
  context.fetch = () => { throw new Error('view-only must not send'); };
  // Image occupies stage y=100..300. Selecting its middle quarter crops at the source.
  await probe.applyBoxZoom({ x: 100, y: 150 }, { x: 300, y: 250 });
  assert.deepEqual(Object.values(state.region), [300, 150, 200, 100]);
  assert.equal(state.regionLoading, true, 'input is blocked until the new crop arrives');
  assert.equal(probe.zoom.scale, 1, 'source crop is fitted, not CSS-enlarged from old pixels');
});

test('web discards late full-screen frames after a selection and uses returned region geometry', async () => {
  const { context, probe } = webHarness();
  let finishOld;
  const state = { region: null, regionEpoch: 0, screenW: 1000, screenH: 500,
    paused: false, closed: false, errAt: 0, status: { classList: { toggle() {} } }, img: {} };
  probe.set(state);
  const paths = [];
  context.fetch = url => {
    paths.push(url);
    if (paths.length === 1) return new Promise(resolve => { finishOld = resolve; });
    return Promise.resolve({ ok: true, headers: new Headers({ 'X-Screen-Width': '1000', 'X-Screen-Height': '500',
      'X-Region-X': '100', 'X-Region-Y': '50', 'X-Region-Width': '200', 'X-Region-Height': '100' }), blob: async () => new Blob(['img']) });
  };
  Object.defineProperty(state.img, 'src', { set() { state.paused = true; state.img.onload(); } });
  const pending = probe.loop();
  state.region = { x: 100, y: 50, width: 200, height: 100 }; state.regionEpoch++; state.regionLoading = true;
  finishOld({ ok: true, headers: new Headers(), blob() { throw new Error('obsolete full-screen frame must be discarded'); } });
  await pending;
  assert.ok(paths[1].includes('x=100'));
  assert.deepEqual(Object.values(state.viewRegion), [100, 50, 200, 100]);
  assert.equal(state.regionLoading, false);
  URL.revokeObjectURL(state.lastUrl);
});

test('AI snap-hires requests source coordinates without resizing the result', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(tmp, 'mcu-'));
  const agent = path.join(dir, 'agent');
  const log = path.join(dir, 'calls');
  fs.writeFileSync(agent, `#!/bin/bash
if [ "$1" = status ]; then echo '{"accessibility":true,"screenRecording":true}'; else printf '%s\\n' "$@" > "$MCU_TEST_LOG"; touch "$2"; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sips'), `#!/bin/bash
case "$2" in pixelWidth) echo 'pixelWidth: 800';; pixelHeight) echo 'pixelHeight: 480';; *) exit 9;; esac
`, { mode: 0o755 });
  const out = path.join(dir, 'detail.png');
  const result = execFileSync('bash', ['skills/multicc-computer-use/scripts/mcu.sh', 'snap-hires', out, '400', '240', '100', '80'], {
    encoding: 'utf8', env: { ...process.env, MCU_BACKEND: '', MULTICC_AGENT_BIN: agent, MCU_TEST_LOG: log, PATH: dir + path.delimiter + process.env.PATH },
  });
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['snap', out, '100', '80', '400', '240']);
  assert.match(result, /logical origin=100,80 size=400x240; pixels=800x480/);
});
