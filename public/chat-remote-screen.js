// 「🖥 屏幕」常驻入口：实时看本机主屏、远程操作、冻结一帧去标注对话。
// 服务端见 src/remote-screen.js（取帧 / 输入 / 冻结截图三条路由）。
// 帧循环是「上一帧到了才拉下一帧」：网速慢时自动降帧，不会堆积请求。
// 独立文件：chat.html / chat.js 是行数棘轮文件。
(function (global) {
  'use strict';
  if (typeof document === 'undefined') return;

  const tr = (key, fallback, params) => {
    const out = typeof global.t === 'function' ? global.t(key, params) : '';
    if (out && out !== key) return out;
    return params ? fallback.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : fallback;
  };
  const tok = url => (typeof global.withToken === 'function' ? global.withToken(url) : url);
  const ERR_KEYS = {
    'screen-locked': ['rsErrLocked', '屏幕已锁定'],
    'user-stopped': ['rsErrStopped', '本机按了 Esc 急停，点「解除急停」后才能继续操作'],
    busy: ['rsErrBusy', '另一个会话正在操作电脑'],
    'protected-app': ['rsErrProtected', '目标是受保护的 App（密码 / 系统设置），需本人操作'],
    'agent-unreachable': ['rsErrAgent', 'MultiCC Agent 未运行'],
  };
  const errText = data => {
    const pair = ERR_KEYS[data && data.error];
    return pair ? tr(pair[0], pair[1]) : (data && (data.message || data.error)) || tr('rsErrUnknown', '操作失败');
  };
  const KEYS = [
    ['⏎', 'return'], ['Esc', 'escape'], ['Tab', 'tab'], ['⌫', 'delete'], ['Space', 'space'],
    ['←', 'left'], ['↑', 'up'], ['↓', 'down'], ['→', 'right'],
    ['⌘A', 'cmd+a'], ['⌘C', 'cmd+c'], ['⌘V', 'cmd+v'], ['⌘Z', 'cmd+z'], ['⌘Tab', 'cmd+tab'], ['⌘W', 'cmd+w'],
  ];

  let ov = null;
  let s = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function btn(text, title, onClick, cls) {
    const b = el('button', 'rs-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function status(text, isError) {
    if (!s) return;
    s.status.textContent = text || '';
    s.status.classList.toggle('err', !!isError);
    if (isError) s.errAt = Date.now();
  }

  async function input(body) {
    try {
      const res = await fetch(tok('/api/remote-screen/input'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        status(errText(data), true);
        if (s) s.unhalt.hidden = data.error !== 'user-stopped';
        return false;
      }
      if (s) s.unhalt.hidden = true;
      kick();
      return true;
    } catch (error) {
      status(String(error.message || error), true);
      return false;
    }
  }

  // ── 帧循环 ──
  async function loop() {
    if (!s || s.running) return;
    s.running = true;
    while (s && !s.paused && !document.querySelector('.annotate-overlay')) {
      const t0 = Date.now();
      try {
        const res = await fetch(tok('/api/remote-screen/frame?t=' + t0), { cache: 'no-store' });
        if (!s) break;
        if (!res.ok) {
          status(errText(await res.json().catch(() => ({}))), true);
          await sleep(1500);
          continue;
        }
        s.screenW = Number(res.headers.get('X-Screen-Width')) || s.screenW;
        s.screenH = Number(res.headers.get('X-Screen-Height')) || s.screenH;
        const url = URL.createObjectURL(await res.blob());
        if (!s) { URL.revokeObjectURL(url); break; }
        await new Promise(resolve => { s.img.onload = s.img.onerror = resolve; s.img.src = url; });
        if (s.lastUrl) URL.revokeObjectURL(s.lastUrl);
        s.lastUrl = url;
        const dt = Date.now() - t0;
        s.fps = s.fps ? s.fps * 0.7 + (1000 / dt) * 0.3 : 1000 / dt;
        // 错误提示停留 3 秒再被帧率覆盖。
        if (Date.now() - s.errAt > 3000) {
          status(`${s.screenW}×${s.screenH} · ${tr('rsFps', '{fps} 帧/秒', { fps: s.fps.toFixed(1) })}`);
        }
      } catch (error) {
        status(String(error.message || error), true);
        await sleep(1500);
      }
      if (s && s.wakeAt > Date.now()) continue;
      await sleep(Math.max(0, 200 - (Date.now() - t0)));
    }
    if (s) s.running = false;
    // 标注器盖在上面时暂停；它关了自动续上。
    if (s && !s.paused) s.resumeTimer = setTimeout(loop, 600);
  }
  // 操作后立刻拉下一帧，不等节流间隔。
  function kick() { if (s) s.wakeAt = Date.now() + 1000; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 流畅模式：原版 noVNC ← /ws/remote-screen ← Agent 的 rfb.sock ──
  // Agent 里跑最小 RFB 3.8 服务（Raw 编码、逻辑分辨率、输入走原有护栏），
  // 浏览器端直接用现成客户端：缩放 / 触屏手势 / 完整键位表都不用自己写。
  // 连不上（旧 Agent / macOS<14 / vendor 缺失）或中途断开，一律回退 JPEG 轮询。
  let rfbMod = null;
  async function startRfb() {
    if (!s || s.closed) return false;
    try { rfbMod = rfbMod || await import('/vendor/novnc/core/rfb.js'); } catch { return false; }
    const RfbClass = rfbMod && (rfbMod.RFB || rfbMod.default);
    if (!RfbClass) return false;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let url = proto + location.host + '/ws/remote-screen';
    try { if (typeof global.multiccWsUrl === 'function') url = await global.multiccWsUrl(url); } catch { return false; }
    if (!s || s.closed) return false;
    const wrap = el('div', 'rs-rfb');
    s.stage.appendChild(wrap);
    return await new Promise(resolve => {
      let settled = false;
      let rfb = null;
      const teardown = () => {
        wrap.remove();
        if (s) s.img.style.display = '';
        if (s && s.rfbWrap === wrap) s.rfbWrap = null;
        if (s && s.rfb === rfb) s.rfb = null;
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (rfb) rfb.disconnect(); } catch {}
        teardown();
        resolve(false);
      };
      const timer = setTimeout(fail, 6000);
      try { rfb = new RfbClass(wrap, url, { viewOnly: true, scaleViewport: true }); }
      catch { fail(); return; }
      if (s) s.rfb = rfb;
      s.rfbWrap = wrap;
      rfb.addEventListener('connect', () => {
        if (settled || !s) { settled = true; return; }
        settled = true;
        clearTimeout(timer);
        s.img.style.display = 'none';
        status(tr('rsLiveMode', '流畅模式'));
        if (s.control) setControl(true);
        resolve(true);
      });
      rfb.addEventListener('disconnect', () => {
        clearTimeout(timer);
        const intentional = s && s.rfbIntent;
        if (s) s.rfbIntent = false;
        teardown();
        if (!settled) { settled = true; resolve(false); return; }
        if (!intentional && s && !s.closed && !s.paused) {
          status(tr('rsFallback', '流式连接断开，已切回兼容模式'), true);
          loop();
        }
      });
    });
  }

  // 流畅模式下 RFB 输入被 Agent 拒绝时页面看不到错误（RFB 无错误通道），
  // 每 3 秒查一次状态，Esc 急停时亮出「解除急停」。
  function startHaltPoll(on) {
    if (!s) return;
    clearInterval(s.haltTimer);
    if (!on) return;
    s.haltTimer = setInterval(async () => {
      if (!s || !s.rfb || !s.control) { clearInterval(s.haltTimer); return; }
      try {
        const res = await fetch(tok('/api/remote-screen/input'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'status' }),
        });
        const data = await res.json();
        const halted = !!(data && data.control && data.control.halted);
        s.unhalt.hidden = !halted;
        if (halted) status(tr('rsErrStopped', '本机按了 Esc 急停，点「解除急停」后才能继续操作'), true);
      } catch {}
    }, 3000);
  }

  // ── 指针 → 屏幕坐标（图上 1px = 1 逻辑点）──
  function toScreen(ev) {
    const r = s.img.getBoundingClientRect();
    const iw = s.img.naturalWidth || s.screenW, ih = s.img.naturalHeight || s.screenH;
    // object-fit: contain 的实际绘制区域
    const scale = Math.min(r.width / iw, r.height / ih);
    const dw = iw * scale, dh = ih * scale;
    const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
    const x = (ev.clientX - ox) / scale * (s.screenW / iw);
    const y = (ev.clientY - oy) / scale * (s.screenH / ih);
    if (x < 0 || y < 0 || x > s.screenW || y > s.screenH) return null;
    return { x: Math.round(x), y: Math.round(y), cx: ev.clientX, cy: ev.clientY };
  }
  function ripple(cx, cy) {
    const dot = el('span', 'rs-ripple');
    dot.style.left = cx + 'px';
    dot.style.top = cy + 'px';
    ov.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  }

  function wirePointer(stage) {
    let down = null;
    let lastClick = null;
    stage.addEventListener('contextmenu', ev => ev.preventDefault());
    stage.addEventListener('pointerdown', ev => {
      if (!s.control || s.rfb) return;
      const p = toScreen(ev);
      if (!p) return;
      ev.preventDefault();
      stage.setPointerCapture(ev.pointerId);
      down = { p, button: ev.button };
    });
    stage.addEventListener('pointerup', ev => {
      if (!down) return;
      const start = down;
      down = null;
      const p = toScreen(ev) || start.p;
      if (Math.hypot(p.cx - start.p.cx, p.cy - start.p.cy) > 8) {
        ripple(p.cx, p.cy);
        input({ op: 'drag', x: start.p.x, y: start.p.y, x2: p.x, y2: p.y, ms: 350 });
        return;
      }
      const right = start.button === 2 || s.rightOnce;
      if (s.rightOnce) { s.rightOnce = false; s.rightBtn.classList.remove('on'); }
      const now = Date.now();
      const dbl = !right && lastClick && now - lastClick.at < 350 && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 6;
      lastClick = dbl ? null : { at: now, x: p.x, y: p.y };
      ripple(start.p.cx, start.p.cy);
      input({ op: 'click', x: start.p.x, y: start.p.y, button: right ? 'right' : 'left', count: dbl ? 2 : 1 });
    });
    stage.addEventListener('pointercancel', () => { down = null; });
    let acc = 0, wheelAt = null, wheelTimer = null;
    stage.addEventListener('wheel', ev => {
      if (!s.control || s.rfb) return;
      const p = toScreen(ev);
      if (!p) return;
      ev.preventDefault();
      acc += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      wheelAt = p;
      if (wheelTimer) return;
      wheelTimer = setTimeout(() => {
        wheelTimer = null;
        const amount = Math.max(-50, Math.min(50, -Math.round(acc / 40)));
        acc = 0;
        if (amount) input({ op: 'scroll', x: wheelAt.x, y: wheelAt.y, amount });
      }, 90);
    }, { passive: false });
  }

  function setControl(on) {
    s.control = on;
    s.modeBtn.textContent = on ? '🖱 ' + tr('rsControl', '可操作') : '👁 ' + tr('rsViewOnly', '只看');
    s.modeBtn.classList.toggle('on', on);
    ov.classList.toggle('rs-control', on);
    if (s.rfb) {
      // 流畅模式：指针 + 键盘都交给 noVNC，自己的 keybar 收起来。
      s.rfb.viewOnly = !on;
      s.keybar.hidden = true;
      s.hint.textContent = on
        ? tr('rsRfbCtrlHint', '直接在本画面上点击 / 拖动 / 打字；本机按 Esc 可随时急停')
        : tr('rsViewHint', '只看模式：不会向本机发送任何操作。「✎ 标注」可冻结画面后标注对话');
      startHaltPoll(on);
      return;
    }
    s.keybar.hidden = !on;
    s.hint.textContent = on
      ? tr('rsControlHint', '点击=单击，拖动=拖拽，滚轮=滚动，快速点两下=双击；本机按 Esc 可随时急停')
      : tr('rsViewHint', '只看模式：不会向本机发送任何操作。「✎ 标注」可冻结画面后标注对话');
  }

  async function annotate() {
    const annotator = global.MultiCCChatAnnotator;
    if (!annotator) return;
    status(tr('rsSnapping', '正在冻结画面…'));
    try {
      const res = await fetch(tok('/api/remote-screen/snapshot'), { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) { status(errText(data), true); return; }
      annotator.open(data.url, tr('rsTitle', '本机屏幕'));
      clearTimeout(s.resumeTimer);
      // 流畅模式下流还在跑，标注器关了不需要重新起轮询。
      if (!s.rfb) s.resumeTimer = setTimeout(loop, 600);
    } catch (error) {
      status(String(error.message || error), true);
    }
  }

  async function open() {
    if (ov) return;
    ov = el('div', 'rs-overlay');
    const head = el('div', 'rs-head');
    const title = el('span', 'rs-title', '🖥 ' + tr('rsTitle', '本机屏幕'));
    const statusEl = el('span', 'rs-status');
    s = { control: false, paused: false, closed: false, screenW: 0, screenH: 0, status: statusEl, errAt: 0, haltTimer: 0 };
    s.modeBtn = btn('', tr('rsModeTitle', '切换只看 / 可操作'), () => setControl(!s.control));
    s.rightBtn = btn(tr('rsRightClick', '右键'), tr('rsRightClickHint', '下一次点击按右键发送（触屏用）'), () => {
      s.rightOnce = !s.rightOnce;
      s.rightBtn.classList.toggle('on', s.rightOnce);
    });
    const pauseBtn = btn('⏸ ' + tr('rsPause', '暂停'), '', async () => {
      s.paused = !s.paused;
      pauseBtn.textContent = s.paused ? '▶ ' + tr('rsResume', '继续') : '⏸ ' + tr('rsPause', '暂停');
      if (s.paused) {
        if (s.rfb) {
          s.rfbIntent = true;
          try { s.rfb.disconnect(); } catch {}
          // 断流后取一帧 JPEG，让画面停在当前状态，而不是流式之前那张旧图。
          await sleep(150);
          try {
            const res = await fetch(tok('/api/remote-screen/frame'), { cache: 'no-store' });
            if (res.ok && s) {
              const url = URL.createObjectURL(await res.blob());
              await new Promise(r2 => { s.img.onload = s.img.onerror = r2; s.img.src = url; });
              if (s.lastUrl) URL.revokeObjectURL(s.lastUrl);
              s.lastUrl = url;
              status(tr('rsPause', '暂停'));
            }
          } catch {}
        }
      } else if (!(await startRfb())) loop();
    });
    s.unhalt = btn(tr('rsUnhalt', '解除急停'), tr('rsUnhaltTitle', '本机用户按过 Esc：确认可以继续后再解除'), () => input({ op: 'resume' }), 'warn');
    s.unhalt.hidden = true;
    const releaseBtn = btn(tr('rsRelease', '交还'), tr('rsReleaseTitle', '释放操作租约，让其它会话的 agent 立刻可以操作电脑'), () => input({ op: 'release' }));
    head.append(title, statusEl,
      s.modeBtn, s.rightBtn,
      btn('✎ ' + tr('rsAnnotate', '标注'), tr('rsAnnotateTitle', '冻结当前画面并打开标注器：开「实时透传」则标记直接在本机执行，关则录入输入框与 agent 对话'), annotate, 'primary'),
      pauseBtn, s.unhalt, releaseBtn,
      btn('✕', tr('rsClose', '关闭'), close, 'rs-close'));
    const stage = el('div', 'rs-stage');
    s.stage = stage;
    s.img = el('img', 'rs-img');
    s.img.alt = '';
    s.img.draggable = false;
    stage.appendChild(s.img);
    s.hint = el('div', 'rs-hint');
    s.keybar = el('div', 'rs-keybar');
    const text = el('input', 'rs-text');
    text.placeholder = tr('rsTypePlaceholder', '输入文字，发送到本机当前焦点…');
    const send = () => {
      if (!text.value) return;
      input({ op: 'type', text: text.value }).then(ok => { if (ok) text.value = ''; });
    };
    text.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); send(); } });
    s.keybar.append(text, btn(tr('rsSend', '发送'), '', send, 'primary'));
    for (const [label, keys] of KEYS) s.keybar.appendChild(btn(label, keys, () => input({ op: 'press', keys }), 'rs-key'));
    ov.append(head, stage, s.hint, s.keybar);
    document.body.appendChild(ov);
    wirePointer(stage);
    setControl(false);
    statusEl.textContent = tr('rsConnecting', '正在取第一帧…');
    if (!(await startRfb())) loop();
  }

  function close() {
    if (!ov) return;
    const wasControl = s && s.control;
    if (s) {
      s.closed = true;
      clearTimeout(s.resumeTimer);
      clearInterval(s.haltTimer);
      if (s.rfb) { s.rfbIntent = true; try { s.rfb.disconnect(); } catch {} }
      if (s.lastUrl) URL.revokeObjectURL(s.lastUrl);
    }
    s = null;
    ov.remove();
    ov = null;
    // 关掉浮层即交还租约，不让 agent 再等 120 秒。
    if (wasControl) fetch(tok('/api/remote-screen/input'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'release' }) }).catch(() => {});
  }

  function installButton() {
    if (document.getElementById('remote-screen-btn')) return;
    const anchor = document.getElementById('notify-btn');
    if (!anchor) return;
    const b = document.createElement('button');
    b.id = 'remote-screen-btn';
    b.className = 'hdr-btn';
    b.type = 'button';
    b.dataset.hdrIcon = '🖥';
    b.textContent = tr('rsButton', '屏幕');
    b.title = tr('rsButtonTitle', '实时查看本机屏幕：可标注对话，也可远程操作');
    b.addEventListener('click', open);
    anchor.before(b);
  }

  global.MultiCCRemoteScreen = Object.freeze({ open, close });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installButton);
  else installButton();
})(typeof window !== 'undefined' ? window : globalThis);
