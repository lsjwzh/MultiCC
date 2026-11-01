// 「🖥 屏幕」唯一的输入层：触屏 / 鼠标 / 滚轮 / 键盘都在这里，三种画面模式只负责画像素。
//
// 宿主（chat-remote-screen.js）每一轮按当前模式给一个 adapter，本模块只管手势与键盘，
// 不认识 h264 / noVNC / HTTP 的任何细节：
//   h264   → view.sendPointer(mask,x,y) / sendKey(down,keysym) / clientToInput(cx,cy)
//   rfb    → RFB.messages.pointerEvent/keyEvent + rfb._sock.flush()（viewOnly 恒真）
//   兼容   → POST /api/remote-screen/input（pointer / click / scroll / press / type）
//
// 语义（CONTRACT §6/§7）：
//   · 一指永远是鼠标（放大态也一样）：超过 8 CSS px 才按下并开始拖拽，抬指前没超 = 单击，
//     按住 500ms 没动 = 右键；双指只做本地捏合缩放 + 平移，一根字节都不往 Mac 发。
//   · 第二根手指落下时若拖拽已经按下，先松开按钮（在最后一个点）再进入捏合。
//   · 放大态拖到画面边缘时自动平移视图，并继续把手指下的远端位置发出去。
//   · 按住任何一个按钮期间每 3 秒补一个相同样本当心跳（Agent 只续命，不再动作）。
//   · 桌面鼠标按下立刻发（左/中/右 = 0x01/0x02/0x04），悬停流式模式 ~30Hz。
//   · 滚轮两个轴都累积到 40px 一格（deltaMode 1 按 16 换算）；流式发轮齿脉冲，
//     兼容模式发 scroll 的 amount / amountX。
//   · 修饰键芯片（⇧ ⌘ ⌥ ⌃）点一下 = 一次性、连点两下 = 锁定、点亮时再点 = 释放；
//     流式模式发真的 modifier KeyEvent，兼容模式把名字塞进 HTTP 的 mods。
//   · 键盘（流式模式）自己做映射：左右修饰键按 ev.code，带 ⌘/⌃/⌥ 时取 ev.code 上的
//     基础键让 Agent 组和弦；输入法在 compositionend 后按字符发 tagged keysym。
//   · 只看模式 / 失焦 / 页面隐藏 / 断开 / 切模式 → releaseAll 把所有按下的键和按钮放掉。
(function (global) {
  'use strict';
  if (typeof document === 'undefined' || typeof global === 'undefined') return;

  const SLOP = 8;          // CSS px：一指移动超过它才按下去
  const LONG_PRESS = 500;  // ms：长按没动 = 右键
  const HEARTBEAT = 3000;  // ms：按住按钮时的心跳样本
  const HOVER_MS = 33;     // ~30Hz 悬停（流式模式画面里画的是远端光标）
  const WHEEL_NOTCH = 40;  // px 累积一格
  const CHIP_LOCK_MS = 350;
  const EDGE_MIN = 24;     // 自动平移的边带最小宽度
  const EDGE_PAN_MS = 50;
  const EDGE_STEP = 12;

  // 与 chat-remote-screen-h264.js 同一张表（tests/test-macos-agent.js 直接切这段源码
  // 在 VM 里跑，别把表拆到需要 DOM 的代码后面）。
  const KEYSYMS = {
    Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
    Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
    PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, CapsLock: 0xffe5,
    Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffe7,
  };
  // 物理修饰键按 ev.code 分左右（Agent 侧用正确的左右虚拟键真的按下）。
  const MOD_CODES = {
    ShiftLeft: 0xffe1, ShiftRight: 0xffe2,
    ControlLeft: 0xffe3, ControlRight: 0xffe4,
    AltLeft: 0xffe9, AltRight: 0xffea,
    MetaLeft: 0xffe7, MetaRight: 0xffe8,
  };
  const MODS_ORDER = ['shift', 'ctrl', 'alt', 'cmd'];
  const KEY_NAMES = {
    return: 0xff0d, enter: 0xff0d, escape: 0xff1b, esc: 0xff1b, tab: 0xff09,
    delete: 0xff08, backspace: 0xff08, space: 0x20,
    left: 0xff51, up: 0xff52, down: 0xff54, right: 0xff53,
    home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  };
  // 带 ⌘/⌃/⌥ 时用 US 布局的基础键（ev.key 会被系统换成 ⌥ 组合字符，不能直接用）。
  const CODE_CHARS = {
    KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f', KeyG: 'g',
    KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l', KeyM: 'm', KeyN: 'n',
    KeyO: 'o', KeyP: 'p', KeyQ: 'q', KeyR: 'r', KeyS: 's', KeyT: 't', KeyU: 'u',
    KeyV: 'v', KeyW: 'w', KeyX: 'x', KeyY: 'y', KeyZ: 'z',
    Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
    Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
    Space: ' ',
    Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
    Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
    NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.',
  };

  function namedKeysym(key) {
    if (KEYSYMS[key]) return KEYSYMS[key];
    const f = /^F([1-9]|1[0-2])$/.exec(key || '');
    if (f) return 0xffbe + Number(f[1]) - 1;
    return 0;
  }

  function keysymOf(ev) {
    const named = namedKeysym(ev.key);
    if (named) return named;
    const cp = ev.key && ev.key.codePointAt(0);
    // X11 Unicode keysyms must be tagged so fullwidth text cannot collide
    // with functional keys such as BackSpace (0xff08).
    if (cp && String.fromCodePoint(cp) === ev.key) return cp <= 0xff ? cp : (0x01000000 | cp);
    return 0;
  }

  // 一个字符 → keysym：换行 = Return，制表 = Tab，其余 >0xFF 一律打 tagged Unicode。
  function charKeysym(ch) {
    if (ch === '\n' || ch === '\r') return 0xff0d;
    if (ch === '\t') return 0xff09;
    const cp = ch.codePointAt(0);
    if (!cp) return 0;
    return cp <= 0xff ? cp : (0x01000000 | cp);
  }

  function splitKeys(keys) {
    return String(keys || '').split('+').map(part => part.trim()).filter(Boolean);
  }

  class RemoteInput {
    constructor(opts) {
      this._opts = opts || {};
      this._stage = opts.stage;
      this._disposed = false;
      this._pts = new Map();       // 当前按在画面上的手指/鼠标
      this._primary = null;        // 单指（或鼠标）手势
      this._pinch = null;          // 两指捏合基准
      this._multitouch = false;    // 捏合后剩下一根手指也不当鼠标，直到全部抬起
      this._box = null;            // 框选拖拽 {id,x0,y0}
      this._chips = new Map();     // name -> {state:'off'|'once'|'lock', at}
      this._physical = new Map();  // ev.code -> keysym（真的按住的修饰键）
      // keysym -> Set(来源)：'chip:shift' / 'phys:ShiftLeft'。芯片和物理键会撞同一个
      // keysym，Agent 只认「第一次 down / 最后一次 up」，所以必须按持有人合并。
      this._modHeld = new Map();
      this._heldKeys = new Map();  // ev.code -> keysym（按下过的普通键，keyup 用）
      this._mask = 0;
      this._last = null;           // 最近一次发出的远端坐标
      this._heartbeat = null;
      this._hoverTimer = null;
      this._hoverAt = 0;
      this._hoverPoint = null;
      this._wheel = { x: 0, y: 0 };
      this._wheelAt = null;
      this._wheelTimer = null;
      this._panTimer = null;
      this._panVec = null;
      this._composing = false;
      this._ime = this._buildIme();
      this._bind();
    }

    // ── 对外 API ────────────────────────────────────────────────────────────
    chipTap(name) {
      const chip = this._chips.get(name) || { state: 'off', at: 0 };
      const now = Date.now();
      let next;
      if (chip.state === 'off') next = 'once';
      else if (chip.state === 'once' && now - chip.at < CHIP_LOCK_MS) next = 'lock';
      else next = 'off';
      const adapter = this._adapter();
      // 流式模式真的按住修饰键；兼容模式只用 mods，不发键事件。
      if (adapter && adapter.kind !== 'http') {
        const ks = this._chipKeysym(name);
        if (chip.state === 'off' && next !== 'off') this._holdMod(ks, 'chip:' + name, adapter);
        else if (next === 'off') this._releaseMod(ks, 'chip:' + name, adapter);
      }
      chip.state = next;
      chip.at = now;
      this._chips.set(name, chip);
      return next;
    }

    chipState(name) {
      return (this._chips.get(name) || {}).state || 'off';
    }

    // 兼容模式给 HTTP op 带的修饰键列表（stream 模式下 Agent 已经真的按住了）。
    mods() {
      const set = new Set();
      for (const name of MODS_ORDER) {
        if ((this._chips.get(name) || {}).state && (this._chips.get(name) || {}).state !== 'off') {
          set.add(name === 'cmd' && this._modifier() === 'ctrl' ? 'ctrl' : name);
        }
      }
      return MODS_ORDER.filter(name => set.has(name));
    }

    // 键栏：'cmd+a' / 'return' / '⌘C' 那套 token。流式模式逐条发 KeyEvent，
    // 兼容模式仍走 HTTP press（Agent 自己组和弦）。
    pressKeys(keys) {
      const adapter = this._adapter();
      if (!adapter) return false;
      if (adapter.kind === 'http') {
        const result = adapter.press(keys, this.mods());
        this._releaseOnce(adapter);
        return result;
      }
      const parts = splitKeys(keys);
      if (!parts.length) return false;
      const key = parts.pop();
      const held = [];
      for (const part of parts) {
        // 先看这个 keysym 是不是已经被芯片或物理键真的按住了：按住就别再按一次
        //（否则动作结束会多送一个 up，把芯片还亮着的修饰键从 Mac 上放掉）。
        const ks = this._tokenKeysym(part);
        if (!ks) continue;
        if (this._modHeld.has(ks)) continue;
        held.push(ks);
        adapter.key(true, ks);
      }
      const ks = this._tokenKeysym(key);
      if (ks) {
        adapter.key(true, ks);
        adapter.key(false, ks);
      }
      for (let i = held.length - 1; i >= 0; i--) adapter.key(false, held[i]);
      this._releaseOnce(adapter);
      return true;
    }

    // 文本框 / 输入法：逐字符发 tagged keysym（换行 = Return，制表 = Tab）。
    sendText(text) {
      const adapter = this._adapter();
      const value = String(text == null ? '' : text);
      if (!adapter || !value) return false;
      if (adapter.kind === 'http') {
        const result = adapter.type(value);
        this._releaseOnce(adapter);
        return result;
      }
      for (const ch of Array.from(value)) {
        const ks = charKeysym(ch);
        if (!ks) continue;
        adapter.key(true, ks);
        adapter.key(false, ks);
      }
      this._releaseOnce(adapter);
      return true;
    }

    // 只看 / 失焦 / 页面隐藏 / 断开 / 切模式：把所有按下的按钮与键放掉。
    releaseAll() {
      const adapter = this._adapter(true);
      if (adapter) {
        if (this._mask && this._last) {
          try { adapter.pointer(0, this._last.x, this._last.y); } catch {}
        }
        for (const ks of this._heldKeys.values()) { try { adapter.key(false, ks); } catch {} }
        // 每个真的按住的修饰键只发一次 up：芯片和物理键撞同一个 keysym 也只算一个。
        if (adapter.kind !== 'http') {
          for (const ks of this._modHeld.keys()) { try { adapter.key(false, ks); } catch {} }
        }
      }
      this._heldKeys.clear();
      this._physical.clear();
      this._modHeld.clear();
      for (const chip of this._chips.values()) chip.state = 'off';
      this._mask = 0;
      this._last = null;
      this._clearPrimary();
      this._pinch = null;
      this._pts.clear();
      this._multitouch = false;
      this._cancelBox();
      this._stopHeartbeat();
      this._stopPan();
      clearTimeout(this._hoverTimer);
      this._hoverTimer = null;
      this._hoverPoint = null;
      clearTimeout(this._wheelTimer);
      this._wheelTimer = null;
      this._wheel.x = 0; this._wheel.y = 0;
      // 芯片状态已经全部清成 off：必须重画，否则灯还亮着但 Mac 上早放掉了。
      this._opts.onChips?.();
    }

    // 只放掉指针按钮（不动按住的键和芯片）：框选收尾 / 误触时用。
    // 框选会在手指按着按钮时启动，必须先把那个按钮在最后一点松开并停掉心跳。
    releasePointer() {
      const p = this._primary;
      if (p) {
        clearTimeout(p.timer);
        if (p.pressed && !p.rightFired) this._emitRelease(p.lastCx, p.lastCy);
        this._pts.delete(p.id);
        this._primary = null;
      } else if (this._mask && this._last) {
        // 没有手势对象但按钮还按着（理论上的残留）：用最后发出的远端坐标补一个 up。
        const adapter = this._adapter(true);
        if (adapter) { try { adapter.pointer(0, this._last.x, this._last.y); } catch {} }
      }
      this._stopHeartbeat();
      this._stopPan();
    }

    dispose() {
      if (this._disposed) return;
      this.releaseAll();
      this._disposed = true;
      const st = this._stage;
      for (const [type, fn, options] of this._installed || []) st.removeEventListener(type, fn, options);
      const doc = this._doc();
      if (doc) for (const [type, fn] of this._docInstalled || []) doc.removeEventListener(type, fn);
      if (global.removeEventListener) for (const [type, fn] of this._winInstalled || []) global.removeEventListener(type, fn);
      this._installed = this._docInstalled = this._winInstalled = null;
      this._ime?.remove?.();
      this._ime = null;
    }

    // ── 内部：adapter / 状态 ────────────────────────────────────────────────
    _doc() {
      return this._stage?.ownerDocument || global.document || null;
    }

    _modifier() {
      return (this._opts.modifier && this._opts.modifier()) || 'cmd';
    }

    _control() {
      return !!(this._opts.control && this._opts.control());
    }

    _blocked() {
      return !!(this._opts.blocked && this._opts.blocked());
    }

    // 输入层自己发键时（release / 心跳）也要能拿到 adapter；脱离控制模式后
    // releaseAll 仍要能放掉按住的键，所以 force=true 不看 control。
    _adapter(force) {
      if (this._disposed) return null;
      if (!force && (!this._control() || this._blocked())) return null;
      const adapter = this._opts.adapter && this._opts.adapter();
      return adapter || null;
    }

    _chipKeysym(name) {
      if (name === 'shift') return 0xffe1;
      if (name === 'ctrl') return 0xffe3;
      if (name === 'alt') return 0xffe9;
      if (name === 'cmd') return this._modifier() === 'ctrl' ? 0xffe3 : 0xffe7;
      return 0;
    }

    _chipNameOf(token) {
      const lower = String(token || '').toLowerCase();
      if (lower === 'cmd' || lower === 'meta') return 'cmd';
      if (lower === 'ctrl' || lower === 'control') return 'ctrl';
      if (lower === 'alt' || lower === 'option') return 'alt';
      if (lower === 'shift') return 'shift';
      return null;
    }

    // 修饰键按 keysym 记持有人：芯片和物理键可能撞同一个 keysym（⇧ 芯片 + 左 Shift）。
    // 第一个持有人才发 down，最后一个持有人走了才发 up，Agent 侧永远只按一次放一次。
    _holdMod(ks, src, adapter) {
      if (!ks) return;
      let set = this._modHeld.get(ks);
      if (!set) { set = new Set(); this._modHeld.set(ks, set); }
      if (set.has(src)) return;
      const first = set.size === 0;
      set.add(src);
      const a = adapter || this._adapter();
      if (first && a && a.kind !== 'http') { try { a.key(true, ks); } catch {} }
    }

    _releaseMod(ks, src, adapter) {
      const set = this._modHeld.get(ks);
      if (!set || !set.has(src)) return;
      set.delete(src);
      if (set.size) return;
      this._modHeld.delete(ks);
      const a = adapter || this._adapter(true);
      if (a && a.kind !== 'http') { try { a.key(false, ks); } catch {} }
    }

    _tokenKeysym(token) {
      const lower = String(token || '').toLowerCase();
      if (lower === 'cmd' || lower === 'meta') return this._modifier() === 'ctrl' ? 0xffe3 : 0xffe7;
      if (lower === 'ctrl' || lower === 'control') return 0xffe3;
      if (lower === 'alt' || lower === 'option') return 0xffe9;
      if (lower === 'shift') return 0xffe1;
      if (KEY_NAMES[lower]) return KEY_NAMES[lower];
      if (token && Array.from(token).length === 1) return charKeysym(token);
      return 0;
    }

    _setupIme() {
      const doc = this._doc();
      if (!doc || typeof doc.createElement !== 'function') return null;
      const ta = doc.createElement('textarea');
      ta.className = 'rs-ime';
      ta.setAttribute('aria-hidden', 'true');
      ta.tabIndex = -1;
      ta.autocomplete = 'off';
      ta.autocapitalize = 'off';
      ta.spellcheck = false;
      this._stage.appendChild?.(ta);
      return ta;
    }

    _buildIme() {
      try { return this._setupIme(); } catch { return null; }
    }

    _focusIme(ev) {
      if (!this._ime || ev.pointerType !== 'mouse') return;
      const adapter = this._adapter();
      // 兼容模式仍用文本框 / 键栏，不抢占焦点。
      if (!adapter || adapter.kind === 'http') return;
      try { this._ime.focus({ preventScroll: true }); } catch { try { this._ime.focus(); } catch {} }
    }

    _typingTarget(target) {
      if (!target || target === this._ime) return false;
      return !!(target.closest && target.closest('input, textarea, select, [contenteditable]'));
    }

    // ── 事件绑定 ────────────────────────────────────────────────────────────
    _bind() {
      const st = this._stage;
      if (!st) return;
      const capture = { capture: true };
      const on = (type, fn, options) => {
        st.addEventListener(type, fn, options || capture);
        (this._installed || (this._installed = [])).push([type, fn, options || capture]);
      };
      this._onDown = ev => this._pointerDown(ev);
      this._onMove = ev => this._pointerMove(ev);
      this._onUp = ev => this._pointerUp(ev);
      this._onCancel = ev => this._pointerCancel(ev);
      this._onWheel = ev => this._wheelEvent(ev);
      on('pointerdown', this._onDown);
      on('pointermove', this._onMove);
      on('pointerup', this._onUp);
      on('pointercancel', this._onCancel);
      on('lostpointercapture', this._onCancel);
      on('wheel', this._onWheel, { capture: true, passive: false });
      // iOS Safari 的私有手势缩放会和 pointer 捏合叠乘。
      on('gesturestart', ev => ev.preventDefault());
      on('contextmenu', ev => ev.preventDefault());

      const doc = this._doc();
      this._docInstalled = [];
      if (doc && typeof doc.addEventListener === 'function') {
        const add = (type, fn) => { doc.addEventListener(type, fn); this._docInstalled.push([type, fn]); };
        this._onKeyDown = ev => this._keyDown(ev);
        this._onKeyUp = ev => this._keyUp(ev);
        this._onCompositionStart = () => { this._composing = true; };
        this._onCompositionEnd = ev => this._compositionEnd(ev);
        this._onDocBlur = () => this.releaseAll();
        this._onVisibility = () => { if (doc.hidden) this.releaseAll(); };
        add('keydown', this._onKeyDown);
        add('keyup', this._onKeyUp);
        add('compositionstart', this._onCompositionStart);
        add('compositionend', this._onCompositionEnd);
        doc.addEventListener('visibilitychange', this._onVisibility);
        this._docInstalled.push(['visibilitychange', this._onVisibility]);
      }
      this._winInstalled = [];
      if (typeof global.addEventListener === 'function') {
        global.addEventListener('blur', this._onDocBlur);
        this._winInstalled.push(['blur', this._onDocBlur]);
      }
    }

    // ── 指针：分流到框选 / 捏合 / 鼠标 / 触屏 ───────────────────────────────
    // 画面上的小控件（滚轮条、复位按钮）自己收事件：输入层完全让开。
    _isUi(target) {
      return !!(target && target.closest && target.closest('.rs-wheel, .rs-zoombadge'));
    }

    _isRail(target) {
      return !!(target && target.closest && target.closest('.rs-wheel'));
    }

    _pointerDown(ev) {
      if (this._disposed || this._isUi(ev.target)) return;
      if (this._blocked() || this._opts.disabled?.()) {
        this._swallow(ev);
        return;
      }
      if (this._opts.boxSelecting && this._opts.boxSelecting() && !this._box) {
        this._swallow(ev);
        this._capture(ev);
        // 手上还按着的按钮先松开：否则框选期间心跳会一直把 Mac 的左键按住。
        this.releasePointer();
        this._pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        this._box = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY };
        this._opts.onBoxStart?.(ev.clientX, ev.clientY);
        return;
      }
      if (this._box) {
        // 框选拖拽中又落一指：取消本次框选，这一轮手势不再当鼠标。
        this._cancelBox();
        this._pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        this._multitouch = true;
        this._swallow(ev);
        return;
      }
      this._pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this._pts.size >= 2) {
        this._startPinch();
        this._swallow(ev);
        return;
      }
      this._multitouch = false;
      const adapter = this._adapter();
      if (!adapter) return; // 只看模式：捏合仍可用，单指不拦
      if (ev.pointerType === 'mouse') {
        this._switch(ev);
        this._mouseDown(ev, adapter);
      } else {
        this._switch(ev);
        this._touchDown(ev, adapter);
      }
    }

    _pointerMove(ev) {
      if (this._disposed) return;
      // 画面上的小控件（滚轮条）自己带指针捕获，移动事件别把它们抢到 stage 上。
      if (this._isUi(ev.target)) return;
      if (this._box) {
        if (ev.pointerId !== this._box.id) return;
        this._pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        this._opts.onBoxMove?.(ev.clientX, ev.clientY);
        return;
      }
      if (this._pinch) {
        if (!this._pts.has(ev.pointerId)) return;
        this._pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        this._pinchMove();
        this._swallow(ev);
        return;
      }
      const p = this._primary;
      if (!p || ev.pointerId !== p.id) {
        if (ev.pointerType === 'mouse' && !this._pts.size) {
          this._switch(ev);
          this._hover(ev);
        }
        return;
      }
      this._pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      p.lastCx = ev.clientX;
      p.lastCy = ev.clientY;
      if (p.mouse) {
        if (p.pressed) this._emitHeld(ev.clientX, ev.clientY);
        this._swallow(ev);
        return;
      }
      if (p.rightFired) { this._swallow(ev); return; }
      if (!p.pressed) {
        // 还没超过 slop：什么都不发，免得轻点先闪一下按下。
        if (Math.hypot(ev.clientX - p.downCx, ev.clientY - p.downCy) <= SLOP) return;
        clearTimeout(p.timer);
        p.pressed = true;
        // 超过 slop 就一定是拖拽：「右键」待发只作用于轻点，别把拖拽变成右键。
        p.mask = 1;
        this._press(p.mask, p.downCx, p.downCy);
        if (!p.pressed) return; // 落点不在画面上
      }
      this._emitHeld(ev.clientX, ev.clientY);
      this._edgePan(ev.clientX, ev.clientY);
      this._swallow(ev);
    }

    _pointerUp(ev) {
      if (this._disposed) return;
      if (this._box) {
        if (ev.pointerId !== this._box.id) {
          // 框选期间另一根手指抬起：把它的残留状态清干净，下一次轻点才不会变成捏合。
          this._dropStray(ev.pointerId);
          this._swallow(ev);
          return;
        }
        this._pts.delete(ev.pointerId);
        const box = this._box;
        this._box = null;
        this._opts.onBoxEnd?.(box.x0, box.y0, ev.clientX, ev.clientY);
        this._swallow(ev);
        return;
      }
      if (this._pinch) {
        this._pts.delete(ev.pointerId);
        if (this._pts.size < 2) this._pinch = null;
        if (!this._pts.size) this._multitouch = false;
        this._swallow(ev);
        return;
      }
      this._pts.delete(ev.pointerId);
      if (!this._pts.size) this._multitouch = false;
      const p = this._primary;
      if (!p || ev.pointerId !== p.id) return;
      this._primary = null;
      clearTimeout(p.timer);
      this._swallow(ev);
      if (p.rightFired) { this._stopHeartbeat(); return; }
      if (p.pressed) {
        // 拖拽：在抬指处松开按钮。
        this._emitRelease(ev.clientX, ev.clientY);
        this._opts.onTap?.(ev.clientX, ev.clientY);
      } else {
        // 轻点：在按下的落点做一次按下 + 抬起（双击由 Agent 数）。
        const right = !!this._opts.rightOnce?.();
        const mask = right ? 4 : 1;
        this._press(mask, p.downCx, p.downCy);
        this._emitRelease(p.downCx, p.downCy);
        if (right) this._opts.onRightUsed?.();
        this._opts.onTap?.(p.downCx, p.downCy);
      }
      this._releaseOnce();
    }

    _pointerCancel(ev) {
      if (this._disposed) return;
      if (this._box) {
        if (ev.pointerId === this._box.id) {
          this._pts.delete(ev.pointerId);
          this._cancelBox();
        } else {
          this._dropStray(ev.pointerId);
        }
        return;
      }
      this._pts.delete(ev.pointerId);
      const p = this._primary;
      if (p && ev.pointerId === p.id) {
        this._primary = null;
        clearTimeout(p.timer);
        if (p.pressed && !p.rightFired) this._emitRelease(p.lastCx, p.lastCy);
      }
      if (!this._pts.size) { this._pinch = null; this._multitouch = false; }
      this._stopHeartbeat();
      this._stopPan();
    }

    _swallow(ev) {
      ev.preventDefault?.();
      ev.stopPropagation?.();
    }

    _capture(ev) {
      try { this._stage.setPointerCapture?.(ev.pointerId); } catch {}
    }

    _switch(ev) {
      try { this._stage.setPointerCapture?.(ev.pointerId); } catch {}
    }

    // ── 鼠标 ────────────────────────────────────────────────────────────────
    _mouseDown(ev, adapter) {
      // 捕获阶段先截住：noVNC 自己的 mousedown/mouseup 监听（canvas 冒泡）不再执行。
      this._swallow(ev);
      this._focusIme(ev);
      let mask;
      if (ev.button === 1) mask = 2;
      else if (ev.button === 2) mask = 4;
      else if (ev.button === 0) mask = 1;
      else return;
      const pt = adapter.point(ev.clientX, ev.clientY);
      if (!pt) return;
      this._primary = { id: ev.pointerId, mouse: true, mask, pressed: true,
        lastCx: ev.clientX, lastCy: ev.clientY, downCx: ev.clientX, downCy: ev.clientY, rightFired: false };
      this._press(mask, ev.clientX, ev.clientY, pt);
    }

    // ── 触屏 ────────────────────────────────────────────────────────────────
    _touchDown(ev, adapter) {
      // 单指在画面上就是鼠标：先截住指针事件，noVNC 的触屏手势（捏合 → Ctrl+滚轮、
      // 放大后拖动 → 远端拖拽）才不会和我们的发送叠加。
      this._swallow(ev);
      const pt = adapter.point(ev.clientX, ev.clientY);
      if (!pt) return; // 点在黑边上：不是画面
      const p = { id: ev.pointerId, mouse: false, mask: 0, pressed: false, rightFired: false,
        downCx: ev.clientX, downCy: ev.clientY, lastCx: ev.clientX, lastCy: ev.clientY, timer: 0 };
      p.timer = setTimeout(() => this._longPress(), LONG_PRESS);
      this._primary = p;
    }

    _longPress() {
      const p = this._primary;
      if (!p || p.mouse || p.pressed || p.rightFired) return;
      const adapter = this._adapter();
      if (!adapter) return;
      p.rightFired = true;
      const pt = adapter.point(p.downCx, p.downCy);
      if (!pt) return;
      // 右击：按下 + 抬起同一个点；之后抬手指不再发任何东西。
      p.pressed = true;
      this._mask = 4;
      this._last = pt;
      adapter.pointer(4, pt.x, pt.y);
      adapter.pointer(0, pt.x, pt.y);
      this._mask = 0;
      this._opts.onPoint?.(pt, p.downCx, p.downCy);
      this._opts.onTap?.(p.downCx, p.downCy);
      this._releaseOnce(adapter);
      try { global.navigator?.vibrate?.(10); } catch {}
    }

    // ── 捏合（只动本地视图，不发任何字节）──────────────────────────────────
    _startPinch() {
      const p = this._primary;
      if (p) {
        clearTimeout(p.timer);
        // 已经按住左键在拖：先把按钮在最后一个点松开，再进入捏合。
        if (p.pressed && !p.rightFired) this._emitRelease(p.lastCx, p.lastCy);
        this._primary = null;
      }
      this._stopPan();
      const [a, b] = [...this._pts.values()];
      if (!a || !b) return;
      const z = this._opts.zoom?.() || { scale: 1, tx: 0, ty: 0 };
      this._multitouch = true;
      this._pinch = {
        d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        s: z.scale, tx: z.tx, ty: z.ty,
      };
    }

    _pinchMove() {
      const pinch = this._pinch;
      const pts = [...this._pts.values()];
      if (!pinch || pts.length < 2) return;
      const [a, b] = pts;
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const scale = Math.min(5, Math.max(1, pinch.s * d / pinch.d));
      const k = scale / pinch.s; // 中点锚定：捏合前的中点内容跟着手指走
      const tx = (a.x + b.x) / 2 - (pinch.mx - pinch.tx) * k;
      const ty = (a.y + b.y) / 2 - (pinch.my - pinch.ty) * k;
      this._opts.setZoom?.(scale, tx, ty);
      this._swallow({ preventDefault() {}, stopPropagation() {} });
    }

    // ── 发送样本 ────────────────────────────────────────────────────────────
    _press(mask, cx, cy, known) {
      const adapter = this._adapter();
      if (!adapter) { if (this._primary) this._primary.pressed = false; return; }
      const pt = known || adapter.point(cx, cy);
      if (!pt) { if (this._primary) this._primary.pressed = false; return; }
      this._mask = mask;
      this._last = pt;
      adapter.pointer(mask, pt.x, pt.y);
      this._opts.onPoint?.(pt, cx, cy);
      this._startHeartbeat();
    }

    _emitHeld(cx, cy) {
      const adapter = this._adapter();
      if (!adapter || !this._mask) return;
      const pt = adapter.point(cx, cy);
      if (!pt) return;
      this._last = pt;
      adapter.pointer(this._mask, pt.x, pt.y);
      this._opts.onPoint?.(pt, cx, cy);
    }

    _emitRelease(cx, cy) {
      const adapter = this._adapter();
      if (!adapter) { this._mask = 0; this._last = null; return; }
      const pt = adapter.point(cx, cy) || this._last;
      this._mask = 0;
      this._stopHeartbeat();
      if (!pt) { this._last = null; return; }
      this._last = pt;
      adapter.pointer(0, pt.x, pt.y);
      this._opts.onPoint?.(pt, cx, cy);
    }

    // 一次性芯片在动作结束后自动松开（锁定态不动）。
    _releaseOnce(adapter) {
      const a = adapter || this._adapter(true);
      let changed = false;
      for (const [name, chip] of this._chips) {
        if (chip.state !== 'once') continue;
        this._releaseMod(this._chipKeysym(name), 'chip:' + name, a);
        chip.state = 'off';
        changed = true;
      }
      if (changed) this._opts.onChips?.();
    }

    // ── 心跳 ────────────────────────────────────────────────────────────────
    _startHeartbeat() {
      if (this._heartbeat) return;
      this._heartbeat = setInterval(() => {
        const adapter = this._adapter(true);
        if (!adapter || !this._mask || !this._last) { this._stopHeartbeat(); return; }
        adapter.pointer(this._mask, this._last.x, this._last.y);
      }, HEARTBEAT);
    }

    _stopHeartbeat() {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }

    _clearPrimary() {
      if (this._primary) clearTimeout(this._primary.timer);
      this._primary = null;
    }

    // 框选占了指针时，另一根手指抬起 / 被取消：只清它自己的状态，别动正在画的框。
    _dropStray(id) {
      this._pts.delete(id);
      const p = this._primary;
      if (p && p.id === id) {
        clearTimeout(p.timer);
        this._primary = null;
        if (p.pressed && !p.rightFired) this._emitRelease(p.lastCx, p.lastCy);
      }
      if (!this._pts.size) { this._pinch = null; this._multitouch = false; }
      this._stopHeartbeat();
    }

    // ── 放大态拖到边缘：视图自己平移，同时把手下的远端位置补发一帧 ──────────
    _edgePan(cx, cy) {
      const zoom = this._opts.zoom?.();
      if (!zoom || zoom.scale <= 1) { this._stopPan(); return; }
      const r = this._opts.stageRect?.();
      if (!r || !r.width || !r.height) return;
      const bandX = Math.max(EDGE_MIN, r.width * 0.08);
      const bandY = Math.max(EDGE_MIN, r.height * 0.08);
      let dx = 0, dy = 0;
      if (cx - r.left < bandX) dx = (bandX - (cx - r.left)) / bandX;
      else if (r.left + r.width - cx < bandX) dx = -(bandX - (r.left + r.width - cx)) / bandX;
      if (cy - r.top < bandY) dy = (bandY - (cy - r.top)) / bandY;
      else if (r.top + r.height - cy < bandY) dy = -(bandY - (r.top + r.height - cy)) / bandY;
      if (!dx && !dy) { this._stopPan(); return; }
      this._panVec = { dx, dy };
      if (this._panTimer) return;
      this._panTimer = setInterval(() => this._panTick(), EDGE_PAN_MS);
    }

    _panTick() {
      const p = this._primary;
      if (!p || !p.pressed || p.rightFired) { this._stopPan(); return; }
      const v = this._panVec || { dx: 0, dy: 0 };
      this._opts.panBy?.(Math.round(v.dx * EDGE_STEP), Math.round(v.dy * EDGE_STEP));
      // 视图挪了，同一根手指下的远端坐标也变了：补一个样本保持跟手。
      this._emitHeld(p.lastCx, p.lastCy);
    }

    _stopPan() {
      clearInterval(this._panTimer);
      this._panTimer = null;
      this._panVec = null;
    }

    // ── 框选 ────────────────────────────────────────────────────────────────
    _cancelBox() {
      if (!this._box) return;
      this._pts.delete(this._box.id);
      this._box = null;
      this._opts.onBoxCancel?.();
    }

    // ── 悬停（流式模式，~30Hz）──────────────────────────────────────────────
    _hover(ev) {
      const adapter = this._adapter();
      if (!adapter || adapter.kind === 'http') return; // 兼容模式不发光标，省请求
      this._hoverPoint = { cx: ev.clientX, cy: ev.clientY };
      if (this._hoverTimer) return;
      const wait = HOVER_MS - (Date.now() - this._hoverAt);
      if (wait <= 0) { this._flushHover(); return; }
      this._hoverTimer = setTimeout(() => this._flushHover(), wait);
    }

    _flushHover() {
      clearTimeout(this._hoverTimer);
      this._hoverTimer = null;
      const adapter = this._adapter();
      if (!adapter || adapter.kind === 'http' || this._mask || !this._hoverPoint) return;
      const { cx, cy } = this._hoverPoint;
      this._hoverPoint = null;
      const pt = adapter.point(cx, cy);
      if (!pt) return;
      this._hoverAt = Date.now();
      this._last = pt;
      adapter.pointer(0, pt.x, pt.y);
    }

    // ── 滚轮：两轴都累积到 40px 一格 ────────────────────────────────────────
    _wheelEvent(ev) {
      if (this._disposed || !this._control() || this._blocked() || this._isRail(ev.target)) return;
      const adapter = this._adapter();
      if (!adapter || (!ev.deltaX && !ev.deltaY)) return;
      ev.preventDefault?.();
      ev.stopPropagation?.();
      const k = ev.deltaMode === 1 ? 16 : 1; // 行模式按 16px 一行
      this._wheel.x += ev.deltaX * k;
      this._wheel.y += ev.deltaY * k;
      this._wheelAt = { cx: ev.clientX, cy: ev.clientY };
      if (this._wheelTimer) return;
      this._wheelTimer = setTimeout(() => { this._wheelTimer = null; this._flushWheel(); }, 60);
    }

    _flushWheel() {
      const adapter = this._adapter();
      if (!adapter || !this._wheelAt) return;
      const notchesY = this._consumeNotches('y');
      const notchesX = this._consumeNotches('x');
      if (!notchesY && !notchesX) return;
      const pt = adapter.point(this._wheelAt.cx, this._wheelAt.cy);
      if (!pt) return;
      if (adapter.kind === 'http') {
        // 正 amount = 上滚（deltaY 负），正 amountX = 向左（deltaX 负）。
        adapter.scroll(-notchesY, -notchesX, pt.x, pt.y);
        return;
      }
      // 流式：每个轮齿 = mask|bit 然后 mask。8 上 / 16 下 / 32 左 / 64 右。
      const pulse = (bit, count) => {
        for (let i = 0; i < count; i++) adapter.wheel(bit, pt.x, pt.y, this._mask);
      };
      if (notchesY > 0) pulse(16, notchesY);
      else if (notchesY < 0) pulse(8, -notchesY);
      if (notchesX > 0) pulse(64, notchesX);
      else if (notchesX < 0) pulse(32, -notchesX);
    }

    _consumeNotches(axis) {
      const value = this._wheel[axis];
      const n = Math.trunc(value / WHEEL_NOTCH);
      this._wheel[axis] = value - n * WHEEL_NOTCH; // 余数留着，下一格继续累积
      return Math.max(-50, Math.min(50, n));
    }

    // ── 键盘（流式模式自己映射；兼容模式仍走文本框 / 键栏）──────────────────
    _keyDown(ev) {
      const adapter = this._adapter();
      if (!adapter || this._typingTarget(ev.target)) return;
      const modKs = MOD_CODES[ev.code];
      if (adapter.kind === 'http') return; // 兼容模式不接物理键盘
      if (modKs) {
        ev.preventDefault();
        // 自动重复不加持有人：否则按住期间会被当成第二个「按下」，抬起时反而漏 up。
        if (ev.repeat || this._physical.has(ev.code)) return;
        this._physical.set(ev.code, modKs);
        this._holdMod(modKs, 'phys:' + ev.code, adapter);
        return;
      }
      if (this._composing || ev.isComposing || ev.key === 'Process') return;
      const ks = this._physicalKeysym(ev);
      if (!ks) return;
      ev.preventDefault();
      adapter.key(true, ks);
      this._heldKeys.set(ev.code, ks); // 重复按下只覆盖同一个 keysym
    }

    _keyUp(ev) {
      const adapter = this._adapter(true);
      if (!adapter || adapter.kind === 'http') return;
      const modKs = MOD_CODES[ev.code];
      if (modKs) {
        if (!this._physical.has(ev.code)) return;
        ev.preventDefault();
        this._physical.delete(ev.code);
        this._releaseMod(modKs, 'phys:' + ev.code, adapter);
        return;
      }
      const ks = this._heldKeys.get(ev.code);
      if (!ks) return; // 没在我们这里按下过（比如焦点在文本框里）
      ev.preventDefault();
      this._heldKeys.delete(ev.code);
      adapter.key(false, ks);
      this._releaseOnce(adapter);
    }

    _physicalKeysym(ev) {
      const chord = ev.metaKey || ev.ctrlKey || ev.altKey;
      if (!chord) return keysymOf(ev);
      // 带 ⌘/⌃/⌥：功能键照旧，其余取 ev.code 上的基础键交给 Agent 组和弦。
      const named = namedKeysym(ev.key);
      if (named) return named;
      const base = CODE_CHARS[ev.code];
      return base ? charKeysym(base) : 0;
    }

    _compositionEnd(ev) {
      this._composing = false;
      const adapter = this._adapter();
      if (!adapter || adapter.kind === 'http') return;
      if (this._typingTarget(ev.target)) return;
      if (ev.data) this.sendText(ev.data);
      if (ev.target === this._ime) { try { ev.target.value = ''; } catch {} }
    }
  }

  function create(options) {
    return new RemoteInput(options);
  }

  global.MultiCCRemoteInput = Object.freeze({ create, keysymOf, charKeysym, RemoteInput, SLOP, LONG_PRESS });
})(typeof window !== 'undefined' ? window : globalThis);
