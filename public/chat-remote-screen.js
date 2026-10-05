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
    'accessibility-not-granted': ['rsErrAx', 'MultiCC Agent 未获辅助功能授权，无法远程操作'],
    'screen-recording-not-granted': ['rsErrSr', 'MultiCC Agent 未获屏幕录制授权，无法看到画面'],
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

  async function refreshWake(current = s) {
    if (!current || current.waking) return;
    try {
      const res = await fetch(tok('/api/remote-screen/wake'), { cache: 'no-store' });
      const data = await res.json();
      if (s !== current || current.closed || current.waking) return;
      current.wakeBtn.disabled = !res.ok || data.canWake !== true;
      current.wakeBtn.title = data.message || '唤醒并使用已保存的密码解锁屏幕';
      if (Date.now() - (current.wakeResultAt || 0) < 8000) return;
      current.wakeHint.textContent = data.screenLocked === true
        ? ('屏幕已锁定。' + (data.canWake ? '点击“唤起屏幕”恢复画面。' : data.message || '请先开启自动解锁。'))
        : (!res.ok ? '暂时无法检测锁屏状态。' : '');
    } catch {
      if (s === current && !current.closed) {
        current.wakeBtn.disabled = true;
        current.wakeHint.textContent = '暂时无法检测锁屏状态。';
      }
    }
  }

  async function wakeScreen() {
    const current = s;
    if (!current || current.waking || current.wakeBtn.disabled) return;
    current.waking = true;
    current.wakeBtn.disabled = true;
    current.wakeHint.textContent = '正在唤起屏幕，请稍候…';
    try {
      const res = await fetch(tok('/api/remote-screen/wake'), { method: 'POST' });
      const data = await res.json();
      if (s !== current || current.closed) return;
      current.wakeResultAt = Date.now();
      current.wakeHint.textContent = data.message || '唤起失败，请检查本机状态后手动重试。';
      if (res.ok && data.ok === true) {
        current.paused = false;
        current.pauseBtn.textContent = '⏸ ' + tr('rsPause', '暂停');
        // 旧流可能停在锁屏前：断开后恢复 JPEG 取帧，避免仍停在黑屏。
        if (current.rfb) {
          current.rfbIntent = true;
          current.rfb.disconnect();
          current.rfb = null;
          current.rfbWrap?.remove();
          current.rfbWrap = null;
          current.img.style.display = '';
          setControl(current.control);
        }
        kick();
        void loop();
      }
    } catch {
      if (s === current && !current.closed) { current.wakeResultAt = Date.now(); current.wakeHint.textContent = '唤起请求失败，请检查连接后手动重试。'; }
    } finally {
      current.waking = false;
      if (s === current && !current.closed) void refreshWake(current);
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

  // ── 权限门 ──
  // 远程操作要的是给 MultiCC Agent 的两个系统授权：屏幕录制（看）+ 辅助功能
  // （输入）。输入监控与 Esc 监听另行显示，不阻止已授权的画面继续出帧。
  // 打开屏幕先查一次（GET /api/system/agent-permissions，与
  // Air 全局设置「检查授权」同源），缺就出引导条，授权勾上后自动开始出帧。
  // 勾选只能在这台 Mac 上做（/open 仅本地放行），远程访客看到的是提示文案。
  async function fetchPerms() {
    try {
      const res = await fetch(tok('/api/system/agent-permissions'));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false || !data.applicable) return null;
      return data;
    } catch { return null; }
  }
  function paintPermBar(data) {
    if (!s || !s.permBar) return;
    s.permSnapshot = data;
    const ready = data.screenRecording === true && data.accessibility === true
      && data.listenAccess === true && data.escMonitorEnabled === true;
    if (ready && !s.permResult) { s.permBar.hidden = true; return; }
    s.permBar.hidden = false;
    const row = (key, label) => {
      const li = el('span', 'rs-perm-item');
      li.dataset.permission = key;
      li.append(el('span', null, `${label} ${data[key] === true ? '✓' : data[key] === false ? '✗' : '?'}`));
      if (data[key] === false && data.local) {
        li.appendChild(btn(tr('rsPermOpen', '打开设置'), '', async () => {
          await fetch(tok('/api/system/agent-permissions/open'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permission: key }),
          }).catch(() => {});
        }, 'primary'));
      }
      return li;
    };
    s.permBar.replaceChildren(
      el('span', 'rs-perm-title', tr('rsPermTitle', '远程操作权限')),
      row('screenRecording', tr('rsPermScreen', '屏幕录制')),
      row('accessibility', tr('rsPermAx', '辅助功能')),
      row('listenAccess', tr('airGlobalPermissionsInputMonitoring', '输入监控')),
      el('span', 'rs-perm-hint rs-perm-esc', data.escMonitorEnabled === true
        ? tr('airGlobalPermissionsEscEnabled', '本机 Esc 急停监听已启用；可在桌面操作期间按实体 Esc 键验证。')
        : data.escMonitorEnabled === false
          ? (data.listenAccess === false
            ? tr('airGlobalPermissionsEscNoAccess', '本机 Esc 急停不可用：请给 MultiCC Agent 开启输入监控，再重启 Agent 并复查。')
            : tr('airGlobalPermissionsEscInactive', '本机 Esc 急停监听未启用：请重启 Agent 并复查。'))
          : tr('airGlobalPermissionsEscUnknown', '无法确认本机 Esc 急停状态；请更新 Agent 后复查，暂勿依赖 Esc 叫停。')),
      el('span', 'rs-perm-result', s.permResult || ''),
      ...(!ready ? [el('span', 'rs-perm-hint', data.local
        ? tr('rsPermHint', '请给 MultiCC Agent 开启权限；已开启仍未通过时，先重启 Agent，再重新检测')
        : tr('rsPermRemote', '授权只能在这台 Mac 上完成——请回到 Mac 前操作，或在 Air 全局设置的电源卡里点「检查授权」')),
      el('span', 'rs-perm-hint', tr('airGlobalPermissionsRecovery', '授权后可能需要重启 Agent；仍未通过时先核对 App 路径。旧签名授权失效时，需移除旧条目并重新添加当前 App。重启会短暂中断桌面操作。'))] : []),
    );
    if (data.local) {
      if (data.agentApp) s.permBar.append(el('span', 'rs-perm-hint', data.agentApp));
      s.permBar.append(btn(tr('airGlobalPermissionsRestart', '重启 Agent 并重新检测'), '', async event => {
        const current = s;
        if (!current || current.permRestarting) return;
        current.permRestarting = true;
        current.permEpoch++;
        const button = event.currentTarget;
        button.disabled = true;
        current.permResult = tr('airGlobalPermissionsRestarting', '正在重启 Agent 并读取最新状态…');
        current.permBar.querySelector('.rs-perm-result').textContent = current.permResult;
        try {
          const res = await fetch(tok('/api/system/agent-permissions/restart'), { method: 'POST' });
          const reply = await res.json();
          if (!res.ok || !reply.ok) throw new Error(reply.error || 'Agent restart failed');
          if (s === current && !current.closed) {
            current.permResult = tr('airGlobalPermissionsRestarted', 'Agent 已重启，以下为重启后的检测结果。');
            current.permApply(reply);
          }
        } catch (error) {
          if (s === current && !current.closed) {
            current.permResult = tr('airGlobalPermissionsRestartFailed', '重启 Agent 失败：{message}', { message: error.message });
            paintPermBar(current.permSnapshot);
          }
        } finally { current.permRestarting = false; button.disabled = false; }
      }));
    }
  }
  async function permissionGate(start) {
    const current = s;
    if (!current) return;
    current.permEpoch = 0;
    const apply = data => {
      if (s !== current || current.closed) return;
      paintPermBar(data || {});
      // An Esc warning is independent of the capture/input permission gate.
      if (!data || (data.screenRecording && data.accessibility)) {
        if (!current.permStarted) { current.permStarted = true; start(); }
      } else if (!current.permStarted) {
        status(tr('rsPermNeed', '看屏幕需「屏幕录制」，远程操作需「辅助功能」'), true);
      }
    };
    current.permApply = apply;
    apply(await fetchPerms());
    if (s !== current || current.closed) return;
    let checking = false, lastCheck = Date.now();
    clearInterval(current.permTimer);
    current.permTimer = setInterval(async () => {
      if (s !== current || current.closed) { clearInterval(current.permTimer); return; }
      if (checking || current.permRestarting) return;
      if (current.permStarted && Date.now() - lastCheck < 10000) return;
      checking = true;
      const epoch = current.permEpoch;
      const again = await fetchPerms();
      checking = false;
      lastCheck = Date.now();
      if (!current.permRestarting && epoch === current.permEpoch) apply(again);
    }, 2000);
  }

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
    s.zoomer.appendChild(wrap);
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
      // noVNC 1.7 的构造 options 只认 credentials/shared/repeaterID/wsProtocols，
      // viewOnly / scaleViewport 是 setter-only——构造后必须显式赋值，否则
      // canvas 永远按 framebuffer 原始尺寸显示（桌面宽视口看不出，手机竖屏
      // 右侧直接被裁），且「只看」初始态会 grab 键盘并转发指针输入。
      rfb.viewOnly = true;
      rfb.scaleViewport = true;
      if (s) s.rfb = rfb;
      s.rfbWrap = wrap;
      rfb.addEventListener('connect', () => {
        if (settled || !s) { settled = true; return; }
        settled = true;
        clearTimeout(timer);
        s.img.style.display = 'none';
        status(tr('rsLiveMode', '流畅模式'));
        if (!s.screenW) void ensureScreenSize(); // 轻点精确单击的坐标域要逻辑尺寸
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

  // ── 双指捏合缩放（手机上小目标点不准）──
  // 放大态由手势层在捕获阶段独占指针：单指拖动=平移、原地轻点=精确单击
  // （两种模式最终都走 HTTP input，与 RFB 输入在 Agent 端汇合同一护栏）、
  // 快速点两下=复位。缩回 1x 后完全交还原有交互（noVNC / wirePointer）。
  const zoom = { scale: 1, tx: 0, ty: 0 };
  function applyZoom() {
    if (!s || !s.zoomer) return;
    if (zoom.scale <= 1.001) { zoom.scale = 1; zoom.tx = 0; zoom.ty = 0; }
    s.zoomer.style.transform = zoom.scale === 1
      ? '' : `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
    if (s.zoomBadge) {
      s.zoomBadge.hidden = zoom.scale === 1;
      s.zoomBadge.textContent = Math.round(zoom.scale * 100) + '%';
    }
  }
  function clampPan() {
    const st = s && s.stage;
    if (!st) return;
    zoom.tx = Math.min(0, Math.max(st.clientWidth * (1 - zoom.scale), zoom.tx));
    zoom.ty = Math.min(0, Math.max(st.clientHeight * (1 - zoom.scale), zoom.ty));
  }
  function resetZoom() { zoom.scale = 1; zoom.tx = 0; zoom.ty = 0; applyZoom(); }

  // ── 框选局部放大 ──
  // 「⛶」进入框选模式：拖一个矩形，松开把选区等比放大铺满视口——只是给现有
  // zoom 变换换一种设定方式，之后的平移 / 精确点 / 双击复位全部继承。框先经
  // 当前变换的逆映射回 zoomer 内容坐标（transform-origin 为 0 0，数学自洽），
  // 所以放大态里再框选同样成立；只看 / 可操作两态通用（纯显示层变换）。
  function setBoxSel(on) {
    if (!s || s.closed) return;
    s.boxSelOn = on;
    s.boxBtn.classList.toggle('rs-boxon', on);
    s.stage.classList.toggle('rs-boxsel', on);
    if (s.boxRect) s.boxRect.hidden = true;
    if (on) status(tr('rsBoxSelHint', '在画面上拖动圈选要放大的区域，画完自动退出'));
  }
  function applyBoxZoom(a, b) {
    const st = s.stage;
    const k = zoom.scale || 1;
    // 视口框 → zoomer 内容坐标（当前变换的逆）
    const x0 = (Math.min(a.x, b.x) - zoom.tx) / k, x1 = (Math.max(a.x, b.x) - zoom.tx) / k;
    const y0 = (Math.min(a.y, b.y) - zoom.ty) / k, y1 = (Math.max(a.y, b.y) - zoom.ty) / k;
    // 选区等比 fit 铺满视口；框得比视口还大时 min 夹到 1（=复位），上限与捏合一致
    const k2 = Math.min(5, Math.max(1, Math.min(
      st.clientWidth / Math.max(1, x1 - x0), st.clientHeight / Math.max(1, y1 - y0))));
    zoom.scale = k2;
    zoom.tx = st.clientWidth / 2 - (x0 + x1) / 2 * k2;
    zoom.ty = st.clientHeight / 2 - (y0 + y1) / 2 * k2;
    clampPan(); applyZoom();
  }

  // RFB 模式下帧循环不跑，X-Screen-Width 头拿不到；轻点走 HTTP input，其
  // 坐标域是屏幕逻辑点——Agent 只对 RFB PointerEvent 自动乘 RFB_DIV，直
  // 接用 canvas 的 framebuffer 尺寸会差 RFB_DIV 倍（点到偏左上的位置）。
  // 连上流畅模式后探一次（HEAD 走同一 GET handler，只收响应头不收图）。
  let sizeProbe = null;
  function ensureScreenSize() {
    if (s && s.screenW) return Promise.resolve(s.screenW);
    if (!sizeProbe) {
      sizeProbe = fetch(tok('/api/remote-screen/frame'), { method: 'HEAD' })
        .then(res => {
          if (s && res.ok) {
            s.screenW = Number(res.headers.get('X-Screen-Width')) || s.screenW;
            s.screenH = Number(res.headers.get('X-Screen-Height')) || s.screenH;
          }
        })
        .catch(() => {})
        .finally(() => { sizeProbe = null; });
    }
    return sizeProbe.then(() => (s ? s.screenW : 0));
  }

  // 放大态的轻点：noVNC 模式视觉归一化后乘屏幕逻辑尺寸（不是 canvas 的
  // framebuffer 尺寸），fallback 模式沿用 toScreen；HTTP input 的坐标域
  // 是屏幕逻辑点。
  async function zoomTap(ev, button) {
    let x = null, y = null;
    if (s.rfbWrap) {
      const cv = s.rfbWrap.querySelector('canvas');
      if (cv) {
        const r = cv.getBoundingClientRect();
        if (r.width && r.height) {
          const sw = s.screenW || (await ensureScreenSize()) || cv.width;
          const sh = s.screenH || Math.round(sw * cv.height / cv.width);
          x = Math.round((ev.clientX - r.left) / r.width * sw);
          y = Math.round((ev.clientY - r.top) / r.height * sh);
        }
      }
    } else if (s.img) {
      const p = toScreen(ev);
      if (p) { x = p.x; y = p.y; }
    }
    if (x == null || y == null || x < 0 || y < 0) return;
    ripple(ev.clientX, ev.clientY);
    input({ op: 'click', x, y, button: button === 2 ? 'right' : 'left' });
  }

  // 点亮「右键」后的下一次点击按右键发送；用掉即复位（按钮熄灭）。
  function takeRightOnce() {
    const on = !!(s && s.rightOnce);
    if (on) { s.rightOnce = false; s.rightBtn.classList.remove('on'); }
    return on;
  }

  function wireGestures(stage) {
    const pts = new Map();
    let pinch = null, pan = null, lastTap = 0;
    // 框选拖拽中 {id, rect, x0, y0, x1, y1}：rect 是 down 时 stage 的视口位置。
    let box = null;
    // 流畅模式「右键」待发的那一次点击 {id, x, y}。
    let rightTap = null;
    const paintBox = () => {
      if (!box || !s || !s.boxRect) return;
      s.boxRect.hidden = false;
      s.boxRect.style.left = Math.min(box.x0, box.x1) - box.rect.left + 'px';
      s.boxRect.style.top = Math.min(box.y0, box.y1) - box.rect.top + 'px';
      s.boxRect.style.width = Math.abs(box.x1 - box.x0) + 'px';
      s.boxRect.style.height = Math.abs(box.y1 - box.y0) + 'px';
    };
    // iOS Safari 的私有手势缩放会和 pointer 捏合叠乘，必须一并关掉。
    stage.addEventListener('gesturestart', ev => ev.preventDefault());
    stage.addEventListener('pointerdown', ev => {
      if (s && s.boxSelOn) {
        if (box) { // 拖拽中又落一指：取消本次框选，新指落回常规手势
          pts.delete(box.id);
          box = null;
          if (s.boxRect) s.boxRect.hidden = true;
          setBoxSel(false);
        } else { // 鼠标 / 触屏一致：画框期间独占，noVNC 与 wirePointer 都不掺和
          pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
          ev.preventDefault();
          ev.stopPropagation();
          try { stage.setPointerCapture(ev.pointerId); } catch {}
          box = {
            id: ev.pointerId, rect: stage.getBoundingClientRect(),
            x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY,
          };
          paintBox();
          return;
        }
      }
      if (s && s.rfb && s.rightOnce && !box) {
        if (rightTap) { // 待发中又落一指：取消右键，第一指留在 pts 里，
          // 与新指凑成两指照常捏合（别删 pts，删了就单指落空）
          rightTap = null;
        } else { // 流畅模式下 noVNC 只认左键：点亮「右键」后的这一次点击
          // 在这里独占（鼠标 / 触屏一致），按右键经 HTTP 发出，坐标换算与
          // 放大态归 zoomTap 一条路（屏幕逻辑域）。
          pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
          ev.preventDefault();
          ev.stopPropagation();
          try { stage.setPointerCapture(ev.pointerId); } catch {}
          rightTap = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
          return;
        }
      }
      if (ev.pointerType === 'mouse') return; // 鼠标用户不受影响，走原有交互
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const two = pts.size >= 2;
      if (!two && zoom.scale === 1) return;
      ev.preventDefault();
      ev.stopPropagation(); // 捏合/放大期间独占，noVNC 与 wirePointer 都不掺和
      try { stage.setPointerCapture(ev.pointerId); } catch {}
      if (two) {
        const [a, b] = [...pts.values()];
        pinch = {
          d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
          s: zoom.scale, tx: zoom.tx, ty: zoom.ty,
        };
        pan = null;
      } else {
        pan = { x: ev.clientX, y: ev.clientY, tx: zoom.tx, ty: zoom.ty, moved: false, at: Date.now(), button: ev.button };
      }
    }, true);
    stage.addEventListener('pointermove', ev => {
      if (!pts.has(ev.pointerId)) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (box) {
        if (ev.pointerId !== box.id) return;
        box.x1 = ev.clientX; box.y1 = ev.clientY;
        paintBox();
        return;
      }
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        zoom.scale = Math.min(5, Math.max(1, pinch.s * d / pinch.d));
        const k = zoom.scale / pinch.s; // 中点锚定：捏合前的中点内容跟随手指
        zoom.tx = (a.x + b.x) / 2 - (pinch.mx - pinch.tx) * k;
        zoom.ty = (a.y + b.y) / 2 - (pinch.my - pinch.ty) * k;
        clampPan(); applyZoom();
      } else if (pan && zoom.scale > 1) {
        const dx = ev.clientX - pan.x, dy = ev.clientY - pan.y;
        if (Math.hypot(dx, dy) > 8) pan.moved = true;
        zoom.tx = pan.tx + dx; zoom.ty = pan.ty + dy;
        clampPan(); applyZoom();
      }
    }, true);
    stage.addEventListener('pointerup', ev => {
      if (box) {
        if (ev.pointerId !== box.id) return;
        pts.delete(ev.pointerId);
        const b = box;
        box = null;
        if (s && s.boxRect) s.boxRect.hidden = true;
        setBoxSel(false);
        // 对角线太短视为误触：退出框选但不改缩放
        if (s && Math.hypot(b.x1 - b.x0, b.y1 - b.y0) >= 24) {
          applyBoxZoom(
            { x: b.x0 - b.rect.left, y: b.y0 - b.rect.top },
            { x: b.x1 - b.rect.left, y: b.y1 - b.rect.top });
        }
        return;
      }
      if (rightTap) {
        if (ev.pointerId !== rightTap.id) return;
        pts.delete(ev.pointerId);
        const r = rightTap;
        rightTap = null;
        // 拖动超过轻点阈值视为取消（不消耗「右键」，与兼容模式同语义）
        if (Math.hypot(ev.clientX - r.x, ev.clientY - r.y) <= 8) {
          takeRightOnce();
          void zoomTap(ev, 2);
        }
        return;
      }
      pts.delete(ev.pointerId);
      if (pinch && pts.size < 2) pinch = null; // 剩一指可接着平移
      if (pan && pts.size === 0) {
        const p = pan; pan = null;
        if (!p.moved && Date.now() - p.at < 600) {
          const now = Date.now();
          if (zoom.scale > 1 && now - lastTap < 350) { lastTap = 0; resetZoom(); return; }
          lastTap = now;
          // 兼容模式的放大态轻点也接「右键」（流畅模式走上面的 rightTap 分支）
          if (zoom.scale > 1) void zoomTap(ev, takeRightOnce() ? 2 : p.button);
        }
      }
    }, true);
    stage.addEventListener('pointercancel', ev => {
      if (box) {
        if (ev.pointerId !== box.id) return;
        pts.delete(ev.pointerId);
        box = null;
        if (s && s.boxRect) s.boxRect.hidden = true;
        setBoxSel(false);
        return;
      }
      if (rightTap) {
        if (ev.pointerId !== rightTap.id) return;
        pts.delete(ev.pointerId);
        rightTap = null; // 系统打断：只退出拦截，「右键」留给下一次点击
        return;
      }
      pts.delete(ev.pointerId); pinch = null; pan = null;
    }, true);
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
        ? tr('rsRfbCtrlHint', '直接在本画面上点击 / 拖动 / 打字；双指捏合可放大精确定位，快速点两下复位；本机按 Esc 可随时急停')
        : tr('rsViewHint', '只看模式：不会向本机发送任何操作。「✎ 标注」可冻结画面后标注对话');
      startHaltPoll(on);
      return;
    }
    s.keybar.hidden = !on;
    s.hint.textContent = on
      ? tr('rsControlHint', '点击=单击，拖动=拖拽，滚轮=滚动，快速点两下=双击；双指捏合可放大精确定位，点两下复位；本机按 Esc 可随时急停')
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
    s = { control: false, paused: false, closed: false, boxSelOn: false, screenW: 0, screenH: 0, status: statusEl, errAt: 0, haltTimer: 0, permTimer: 0 };
    s.modeBtn = btn('', tr('rsModeTitle', '切换只看 / 可操作'), () => setControl(!s.control));
    s.rightBtn = btn(tr('rsRightClick', '右键'), tr('rsRightClickHint', '下一次点击按右键发送（触屏用）'), () => {
      s.rightOnce = !s.rightOnce;
      s.rightBtn.classList.toggle('on', s.rightOnce);
    });
    s.boxBtn = btn('⛶', tr('rsBoxZoomTitle', '圈选一块区域局部放大'), () => setBoxSel(!s.boxSelOn));
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
    s.pauseBtn = pauseBtn;
    s.wakeBtn = btn('唤起屏幕', '需先开启自动解锁', wakeScreen, 'primary');
    s.wakeBtn.disabled = true;
    s.wakeHint = el('span', 'rs-wake-hint');
    s.unhalt = btn(tr('rsUnhalt', '解除急停'), tr('rsUnhaltTitle', '本机用户按过 Esc：确认可以继续后再解除'), () => input({ op: 'resume' }), 'warn');
    s.unhalt.hidden = true;
    const releaseBtn = btn(tr('rsRelease', '交还'), tr('rsReleaseTitle', '释放操作租约，让其它会话的 agent 立刻可以操作电脑'), () => input({ op: 'release' }));
    head.append(title, statusEl,
      s.modeBtn, s.rightBtn, s.boxBtn,
      btn('✎ ' + tr('rsAnnotate', '标注'), tr('rsAnnotateTitle', '冻结当前画面并打开标注器：开「实时透传」则标记直接在本机执行，关则录入输入框与 agent 对话'), annotate, 'primary'),
      pauseBtn, s.wakeBtn, s.unhalt, releaseBtn,
      btn('✕', tr('rsClose', '关闭'), close, 'rs-close'));
    const stage = el('div', 'rs-stage');
    s.stage = stage;
    // 缩放内层：img 与流畅模式画布都挂在这里，双指捏合只动它的 transform。
    // CSS transform 对 rect 归一化换算是透明的（视觉框与坐标同比缩放），
    // 所以 toScreen / noVNC 的坐标计算一个字都不用改。
    s.zoomer = el('div', 'rs-zoom');
    s.img = el('img', 'rs-img');
    s.img.alt = '';
    s.img.draggable = false;
    s.zoomer.appendChild(s.img);
    stage.appendChild(s.zoomer);
    s.zoomBadge = btn('', tr('rsZoomReset', '复位缩放'), () => resetZoom(), 'rs-zoombadge');
    s.zoomBadge.hidden = true;
    stage.appendChild(s.zoomBadge);
    // 框选放大时画的矩形（zoomer 之外、不随缩放移动）
    s.boxRect = el('div', 'rs-boxrect');
    s.boxRect.hidden = true;
    stage.appendChild(s.boxRect);
    resetZoom();
    s.permBar = el('div', 'rs-permbar');
    s.permBar.hidden = true;
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
    ov.append(head, s.wakeHint, s.permBar, stage, s.hint, s.keybar);
    void refreshWake();
    const current = s;
    s.wakeTimer = setInterval(() => { void refreshWake(current); }, 5000);
    document.body.appendChild(ov);
    wirePointer(stage);
    wireGestures(stage);
    setControl(false);
    statusEl.textContent = tr('rsConnecting', '正在取第一帧…');
    // 先过权限门（缺授权时引导，齐了或查不到再开始出帧）。
    await permissionGate(() => { void startRfb().then(ok => { if (!ok) loop(); }); });
  }

  function close() {
    if (!ov) return;
    const wasControl = s && s.control;
    if (s) {
      s.closed = true;
      clearTimeout(s.resumeTimer);
      clearInterval(s.haltTimer);
      clearInterval(s.permTimer);
      clearInterval(s.wakeTimer);
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

  // ── 直达链接（multicc-human-assist 求助通道的承接）──
  // agent 在聊天消息里发 `#rs=control`（hash 链接：不动 query、不重载，
  // 本任务聊天页里点开即达，无需知道 task id），或跨设备场景发完整
  // /chat.html?air=1&task=<id>&rs=1|control。两种都自动展开屏幕浮层；
  // rs=control 同时进入可操作模式（AI 解决不了、需要人上手时用）。
  // 一次性参数：触发后立刻从地址栏移除，刷新 / 重复点击不再自动弹出。
  // web 点击直接进；App 内点开走内建浏览器同一页面（原生入口等 App 新版）。
  function readRsParam() {
    try {
      const q = new URLSearchParams(location.search).get('rs');
      if (q === '1' || q === 'control') return { want: q, where: 'search' };
      const h = new URLSearchParams(location.hash.replace(/^#/, ''));
      if (h.get('rs') === '1' || h.get('rs') === 'control') return { want: h.get('rs'), where: 'hash' };
    } catch {}
    return null;
  }
  function consumeRsParam() {
    const got = readRsParam();
    if (!got) return;
    try {
      const url = new URL(location.href);
      if (got.where === 'search') url.searchParams.delete('rs');
      else url.hash = '';
      history.replaceState(null, '', url);
    } catch {}
    if (!ov) {
      void open(); // open 的同步段先建好 s，再切操作模式
      if (got.want === 'control' && s) setControl(true);
    }
  }
  function bootDirectLink() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', consumeRsParam);
    else consumeRsParam();
    // 聊天页是 SPA：hash 链接只改 # 后面，必须监听 hashchange 才能触发。
    window.addEventListener('hashchange', consumeRsParam);
  }
  bootDirectLink();
})(typeof window !== 'undefined' ? window : globalThis);
