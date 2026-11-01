// 「🖥 屏幕」高清流畅模式的播放端：/ws/remote-screen?mode=h264 → WebCodecs 解码 → canvas。
//
// 帧格式与 Agent / 服务端桥一致（scripts/macos-agent/MultiCCAgentH264.swift）：
// 每条 WS 二进制消息一帧 [type u8][len u32 BE][payload]；1=config JSON、2=关键帧、
// 3=普通帧（payload 前 8 字节是 µs 时间戳，后面是 Annex B）、4=pong（别的客户端的
// 心跳应答，这里不发起码率控制，直接忽略）。
//
// 这个类现在只画像素，不再碰输入（见 chat-remote-input.js）：对外只暴露
// sendPointer(mask,x,y) / sendKey(down,keysym) / releaseAll() 和
// clientToInput(clientX,clientY) 坐标映射，由输入层统一驱动。
// 仍模仿 noVNC RFB 的一小截接口（viewOnly / scaleViewport / disconnect /
// 'connect' / 'disconnect' / 'transport' 事件），宿主的画面管线不用分支。
//
// 指针坐标永远是「逻辑点」：canvas 是解码尺寸，App 设了码率上限后共享编码器会降分辨率
// （config.width/height 变小），而 config.inputWidth/inputHeight 始终是主屏逻辑尺寸。
// 所以 clientToInput() 先落到 canvas 再映射到 inputWidth/inputHeight（缺省回落到
// width/height），否则多个观看者同时看、或 App 正在限速时，网页这端的点击会落在左上角。
//
// P2P：服务端在这条 WS 上发 rtc-hello 时，这里建 RTCPeerConnection + DataChannel
// 试直连（信令仍走这条 WS，见 src/remote-screen-p2p.js）。服务端发 rtc-active 后帧改
// 从 DataChannel 来（按字节流分片，这里拼回），输入也改走直连；直连断了服务端再发
// rtc-active:false，回到 WS（中继，走现有外网通道），之后按退避重试直连。
// transport 属性 / 'transport' 事件告诉宿主当前是 'p2p' 还是 'relay'。
(function (global) {
  'use strict';

  const T_CONFIG = 1, T_KEY = 2, T_DELTA = 3, T_PONG = 4, REQ_KEY = 0x4b;
  const P2P_OPEN_TIMEOUT_MS = 10000;
  const P2P_RETRY_MS = [5000, 15000, 60000];

  class H264View extends EventTarget {
    static supported() {
      return typeof global.VideoDecoder === 'function' && typeof global.EncodedVideoChunk === 'function';
    }

    constructor(target, url) {
      super();
      this._target = target;
      this._viewOnly = true;
      this._scale = true;
      this._closed = false;
      this._connected = false;
      this._decoder = null;
      this._config = null;
      this._inputW = 0;   // 指针坐标域（主屏逻辑点），来自 config.inputWidth
      this._inputH = 0;
      this._waitKey = true;
      this._lastKeyReq = 0;
      this._errors = [];
      this._lastXY = [0, 0];
      this.stats = { frames: 0, bytes: 0, dropped: 0 };
      this.transport = 'relay';
      this._pc = null;
      this._dc = null;
      this._p2pIce = null;
      this._p2pTries = 0;
      this._p2pTimer = null;
      this._dcBuf = new Uint8Array(0);

      const canvas = document.createElement('canvas');
      canvas.tabIndex = -1;
      canvas.style.position = 'absolute';
      canvas.style.outline = 'none';
      canvas.style.touchAction = 'none';
      target.appendChild(canvas);
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d');

      canvas.addEventListener('contextmenu', ev => ev.preventDefault());
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._fit());
        this._ro.observe(target);
      }

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = ev => {
        if (typeof ev.data === 'string') { this._onSignal(ev.data); return; }
        // 直连期间 WS 上残留的帧（切换前已在路上）一律丢掉：解码顺序只认一个来源。
        if (ev.data instanceof ArrayBuffer && this.transport === 'relay') this._onMessage(ev.data);
      };
      ws.onclose = () => this._finish();
      ws.onerror = () => this._finish();
      this._ws = ws;
    }

    // 只为兼容宿主旧代码保留：画面端不再挂任何输入监听，是否可控制由输入层判断。
    get viewOnly() { return this._viewOnly; }
    set viewOnly(on) { this._viewOnly = !!on; }

    get scaleViewport() { return this._scale; }
    set scaleViewport(on) { this._scale = !!on; this._fit(); }

    get inputWidth() { return this._inputW || this._canvas.width; }
    get inputHeight() { return this._inputH || this._canvas.height; }

    disconnect() {
      try { this._ws.close(); } catch {}
      this._finish();
    }

    _finish() {
      if (this._closed) return;
      this._closed = true;
      this._p2pStop();
      try { this._ro?.disconnect(); } catch {}
      try { if (this._decoder && this._decoder.state !== 'closed') this._decoder.close(); } catch {}
      this._decoder = null;
      this.dispatchEvent(new Event('disconnect'));
    }

    // ── 输入 API（由 chat-remote-input.js 调用）─────────────────────────────
    // RFB 字节格式：[5][mask][x hi][x lo][y hi][y lo]；mask 位见 CONTRACT §2。
    sendPointer(mask, x, y) {
      if (this._closed) return;
      this._lastXY = [x, y];
      this._send([5, mask & 0xff, (x >> 8) & 255, x & 255, (y >> 8) & 255, y & 255]);
    }

    // [4][down][pad][pad][keysym u32 BE]
    sendKey(down, ks) {
      if (this._closed) return;
      this._send([4, down ? 1 : 0, 0, 0,
        (ks >>> 24) & 255, (ks >>> 16) & 255, (ks >>> 8) & 255, ks & 255]);
    }

    // 只看 / 断开 / 切模式时把可能残留的按钮放掉（键由输入层自己逐个发 up）。
    releaseAll() {
      if (this._closed) return;
      this._send([5, 0, (this._lastXY[0] >> 8) & 255, this._lastXY[0] & 255,
        (this._lastXY[1] >> 8) & 255, this._lastXY[1] & 255]);
    }

    // 页面坐标 → 输入域逻辑点。落在 canvas 之外（放大后四周黑边）时返回 null，
    // 输入层据此忽略这一指（拖动越界时不发帧，抬指仍会补最后一帧）。
    clientToInput(clientX, clientY) {
      const r = this._canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
      const jw = this._inputW || this._canvas.width;
      const jh = this._inputH || this._canvas.height;
      const x = Math.round((clientX - r.left) / r.width * jw);
      const y = Math.round((clientY - r.top) / r.height * jh);
      return { x: Math.max(0, Math.min(jw - 1, x)), y: Math.max(0, Math.min(jh - 1, y)) };
    }

    // ── 传输 ────────────────────────────────────────────────────────────────
    _send(bytes) {
      if (this._closed) return;
      const dc = this._dc;
      if (this.transport === 'p2p' && dc && dc.readyState === 'open') { dc.send(new Uint8Array(bytes)); return; }
      if (this._ws.readyState === 1) this._ws.send(new Uint8Array(bytes));
    }

    _signal(obj) {
      if (!this._closed && this._ws.readyState === 1) this._ws.send(JSON.stringify(obj));
    }

    _onSignal(text) {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || this._closed) return;
      if (msg.t === 'rtc-hello') {
        this._p2pIce = Array.isArray(msg.iceServers) ? msg.iceServers : [];
        this._p2pStart();
      } else if (msg.t === 'rtc-answer' && this._pc && typeof msg.sdp === 'string') {
        this._pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => this._p2pFail());
      } else if (msg.t === 'rtc-ice' && this._pc && msg.candidate) {
        this._pc.addIceCandidate(msg.candidate).catch(() => {});
      } else if (msg.t === 'rtc-active') {
        this._setTransport(msg.on ? 'p2p' : 'relay');
        if (!msg.on) this._p2pFail();
      }
    }

    _setTransport(kind) {
      if (kind === this.transport) return;
      this.transport = kind;
      this._dcBuf = new Uint8Array(0);
      this._waitKey = true;   // 服务端切换后先发关键帧
      this.dispatchEvent(new Event('transport'));
    }

    _p2pStart() {
      clearTimeout(this._p2pTimer);
      this._p2pTimer = null;
      if (this._closed || this._pc || !this._p2pIce || typeof global.RTCPeerConnection !== 'function') return;
      let pc;
      try { pc = new global.RTCPeerConnection({ iceServers: this._p2pIce }); } catch { return; }
      this._pc = pc;
      const dc = pc.createDataChannel('screen', { ordered: true });
      dc.binaryType = 'arraybuffer';
      this._dc = dc;
      dc.onmessage = ev => { if (this._dc === dc && this.transport === 'p2p') this._onStream(ev.data); };
      dc.onopen = () => { if (this._dc === dc) this._p2pTries = 0; };
      dc.onclose = () => { if (this._dc === dc) this._p2pFail(); };
      pc.onicecandidate = ev => { if (this._pc === pc && ev.candidate) this._signal({ t: 'rtc-ice', candidate: ev.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (this._pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) this._p2pFail();
      };
      this._p2pTimer = setTimeout(() => { if (this._pc === pc && dc.readyState !== 'open') this._p2pFail(); }, P2P_OPEN_TIMEOUT_MS);
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => { if (this._pc === pc) this._signal({ t: 'rtc-offer', sdp: pc.localDescription.sdp }); })
        .catch(() => this._p2pFail());
    }

    // 直连没打通或断了：关掉本次 peer，按退避再试；中继一直在，画面不断。
    _p2pFail() {
      const had = !!this._pc;
      this._p2pStop();
      if (this._closed || !had) return;
      if (this.transport === 'p2p') this._setTransport('relay');
      this._signal({ t: 'rtc-close' });
      const wait = P2P_RETRY_MS[this._p2pTries];
      this._p2pTries += 1;
      if (wait != null) this._p2pTimer = setTimeout(() => this._p2pStart(), wait);
    }

    _p2pStop() {
      clearTimeout(this._p2pTimer);
      this._p2pTimer = null;
      const pc = this._pc, dc = this._dc;
      this._pc = null; this._dc = null;
      try { dc?.close(); } catch {}
      try { pc?.close(); } catch {}
    }

    // DataChannel 是分片的字节流：拼回 [type][len][payload] 帧再交给 _onMessage。
    _onStream(data) {
      const chunk = new Uint8Array(data);
      let buf = this._dcBuf;
      if (buf.length) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf); merged.set(chunk, buf.length);
        buf = merged;
      } else buf = chunk;
      let off = 0;
      while (buf.length - off >= 5) {
        const len = ((buf[off + 1] << 24) >>> 0) + (buf[off + 2] << 16) + (buf[off + 3] << 8) + buf[off + 4];
        if (len > 8 * 1024 * 1024) { this._p2pFail(); return; }
        if (buf.length - off < 5 + len) break;
        this._onMessage(buf.slice(off, off + 5 + len).buffer);
        off += 5 + len;
      }
      this._dcBuf = off ? buf.slice(off) : buf;
    }

    _requestKey(force) {
      const now = Date.now();
      if (!force && now - this._lastKeyReq < 500) return;
      this._lastKeyReq = now;
      this._send([REQ_KEY]);
    }

    _onMessage(buf) {
      if (this._closed || buf.byteLength < 5) return;
      const view = new DataView(buf);
      const type = view.getUint8(0);
      const len = view.getUint32(1);
      if (5 + len > buf.byteLength) return;
      const payload = new Uint8Array(buf, 5, len);
      this.stats.bytes += buf.byteLength;
      if (type === T_PONG) return;   // 心跳应答只服务于 App 的测速，网页端不看
      if (type === T_CONFIG) { this._configure(payload); return; }
      if (type !== T_KEY && type !== T_DELTA) return;
      const dec = this._decoder;
      if (!dec || dec.state !== 'configured' || len < 8) return;
      const key = type === T_KEY;
      if (!key && (this._waitKey || dec.decodeQueueSize > 6)) {
        // 落后太多或刚复位：普通帧解不了也追不上，丢到下一个关键帧。
        this.stats.dropped += 1;
        this._waitKey = true;
        this._requestKey(false);
        return;
      }
      if (key) this._waitKey = false;
      const ts = view.getUint32(5) * 4294967296 + view.getUint32(9);
      try {
        dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: payload.subarray(8) }));
      } catch { this._decoderError(); }
    }

    async _configure(payload) {
      let cfg;
      try { cfg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      if (!cfg || !cfg.codec || !(cfg.width > 0) || !(cfg.height > 0)) return;
      // 指针域始终是逻辑点；旧 Agent 不发 input* 时它们就等于编码尺寸。
      this._inputW = cfg.inputWidth > 0 ? Math.round(cfg.inputWidth) : Math.round(cfg.width);
      this._inputH = cfg.inputHeight > 0 ? Math.round(cfg.inputHeight) : Math.round(cfg.height);
      const same = this._config && this._config.codec === cfg.codec
        && this._config.width === cfg.width && this._config.height === cfg.height;
      if (same && this._decoder && this._decoder.state === 'configured') return;
      this._config = cfg;
      // 不带 description = Annex B 码流（SPS/PPS 随关键帧内联）。
      const config = { codec: cfg.codec, codedWidth: cfg.width, codedHeight: cfg.height, optimizeForLatency: true };
      try {
        const support = await global.VideoDecoder.isConfigSupported(config);
        if (!support || !support.supported) { this.disconnect(); return; }
      } catch { this.disconnect(); return; }
      if (this._closed) return;
      try { if (this._decoder && this._decoder.state !== 'closed') this._decoder.close(); } catch {}
      this._canvas.width = cfg.width;
      this._canvas.height = cfg.height;
      this._fit();
      this._decoderConfig = config;
      this._newDecoder();
    }

    _newDecoder() {
      this._waitKey = true;
      this._decoder = new global.VideoDecoder({
        output: frame => this._draw(frame),
        error: () => this._decoderError(),
      });
      this._decoder.configure(this._decoderConfig);
      this._requestKey(true);
    }

    _decoderError() {
      if (this._closed) return;
      const now = Date.now();
      this._errors = this._errors.filter(t => now - t < 10000);
      this._errors.push(now);
      // 连续解码失败说明这台设备解不了这路码流：断开，让宿主回退到 noVNC。
      if (this._errors.length > 3) { this.disconnect(); return; }
      try { if (this._decoder && this._decoder.state !== 'closed') this._decoder.close(); } catch {}
      if (this._decoderConfig) this._newDecoder();
    }

    _draw(frame) {
      try {
        if (!this._closed) this._ctx.drawImage(frame, 0, 0, this._canvas.width, this._canvas.height);
      } finally { frame.close(); }
      this.stats.frames += 1;
      if (!this._connected && !this._closed) {
        this._connected = true;
        this.dispatchEvent(new Event('connect'));
      }
    }

    // scaleViewport：等比缩放进容器并居中；关掉时按原始尺寸贴左上。
    _fit() {
      const c = this._canvas, t = this._target;
      if (!c.width || !c.height) return;
      const tw = t.clientWidth, th = t.clientHeight;
      const k = this._scale && tw && th ? Math.min(tw / c.width, th / c.height) : 1;
      const w = Math.round(c.width * k), h = Math.round(c.height * k);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      c.style.left = (this._scale ? Math.max(0, Math.round((tw - w) / 2)) : 0) + 'px';
      c.style.top = (this._scale ? Math.max(0, Math.round((th - h) / 2)) : 0) + 'px';
    }
  }

  global.MultiCCH264View = H264View;
})(window);
