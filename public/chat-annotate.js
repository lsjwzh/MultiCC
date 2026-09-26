(function attachMultiCCChatAnnotate(global) {
  'use strict';

  // 人工辅助：在聊天大图（#img-lightbox）上标注。agent 卡住时把截图发进聊天，
  // 用户点开大图 →「✎ 标注」→ 点/框/箭头 + 每处说明 → 画好标记的 PNG 进附件区、
  // 结构化文本进输入框（不直接发送）。发送走现成路径，自动带上问题卡的
  // userInputRequestId。回传格式与 App 端 image_annotate_screen.dart 逐字一致。
  // 独立文件：chat.js / chat.html 是 3000 行预算棘轮文件，只减不增。

  const MARK_COLOR = '#ff3b30';
  const MIN_DRAG_PX = 12;
  const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

  const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));
  const fmt = v => (Math.round(clamp01(v) * 1000) / 1000).toFixed(3);
  const oneLine = s => String(s || '').trim().replace(/\s*[\r\n]+\s*/g, ' ');

  // marks: [{ kind: 'point'|'box'|'arrow', a:{x,y}, b:{x,y}, note }] in natural image px.
  function serializeAnnotation({ src, width, height, marks, note }) {
    const W = Math.max(1, Number(width) || 1);
    const H = Math.max(1, Number(height) || 1);
    const lines = [`[annotation] src=${src || '-'} size=${W}x${H}`];
    (marks || []).forEach((m, i) => {
      const a = m.a || { x: 0, y: 0 };
      const b = m.b || a;
      let geo;
      if (m.kind === 'box') {
        geo = `${fmt(Math.min(a.x, b.x) / W)},${fmt(Math.min(a.y, b.y) / H)}-${fmt(Math.max(a.x, b.x) / W)},${fmt(Math.max(a.y, b.y) / H)}`;
      } else if (m.kind === 'arrow') {
        geo = `${fmt(a.x / W)},${fmt(a.y / H)}->${fmt(b.x / W)},${fmt(b.y / H)}`;
      } else {
        geo = `${fmt(a.x / W)},${fmt(a.y / H)}`;
      }
      const text = oneLine(m.note);
      lines.push(`#${i + 1} ${m.kind === 'box' || m.kind === 'arrow' ? m.kind : 'point'} ${geo}${text ? ' — ' + text : ''}`);
    });
    const overall = oneLine(note);
    if (overall) lines.push(`note: ${overall}`);
    lines.push('[/annotation]');
    return lines.join('\n');
  }

  function refreshText(src) {
    return `[annotation-refresh] src=${src || '-'}\n截图已过期或页面已变化，请重新截图后再问我。`;
  }

  // /api/download?path=<abs>&inline=1 → <abs>; anything else (blob:, chips) → ''.
  function sourcePathFromUrl(url, base) {
    try {
      const parsed = new URL(String(url || ''), base || 'http://localhost/');
      if (parsed.pathname !== '/api/download') return '';
      return parsed.searchParams.get('path') || '';
    } catch (_) {
      return '';
    }
  }

  function exportFileName(src, now) {
    const base = String(src || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '') || 'image';
    return `annotated-${base}-${now}.png`;
  }

  function ageText(lastModified, now) {
    const t = Date.parse(lastModified || '');
    if (!Number.isFinite(t)) return '';
    const min = Math.max(0, Math.round((now - t) / 60000));
    if (min < 1) return '截于刚刚';
    if (min < 60) return `截于 ${min} 分钟前`;
    return `截于 ${Math.round(min / 60)} 小时前`;
  }

  function drawMark(ctx, m, index) {
    ctx.save();
    ctx.strokeStyle = MARK_COLOR;
    ctx.fillStyle = MARK_COLOR;
    ctx.lineWidth = 5;
    let lx = m.a.x;
    let ly = m.a.y;
    if (m.kind === 'point') {
      ctx.beginPath(); ctx.arc(m.a.x, m.a.y, 22, 0, Math.PI * 2); ctx.stroke();
      lx = m.a.x + 18; ly = m.a.y - 18;
    } else if (m.kind === 'box') {
      ctx.strokeRect(m.a.x, m.a.y, m.b.x - m.a.x, m.b.y - m.a.y);
      lx = Math.min(m.a.x, m.b.x); ly = Math.min(m.a.y, m.b.y);
    } else {
      const ang = Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x);
      ctx.beginPath(); ctx.moveTo(m.a.x, m.a.y); ctx.lineTo(m.b.x, m.b.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(m.b.x, m.b.y);
      ctx.lineTo(m.b.x - 26 * Math.cos(ang - 0.4), m.b.y - 26 * Math.sin(ang - 0.4));
      ctx.lineTo(m.b.x - 26 * Math.cos(ang + 0.4), m.b.y - 26 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    }
    if (index != null) {
      ctx.beginPath(); ctx.arc(lx, ly, 16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), lx, ly + 1);
    }
    ctx.restore();
  }

  function el(doc, tag, cls, text) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Everything browser-bound lives here; the pure helpers above are unit-tested.
  function createAnnotator({ doc, win, fetchFn, withToken, getComposer, getInputEl, getSessionId, notify }) {
    let overlay = null;

    function putIntoComposer(text, file) {
      const inputEl = getInputEl();
      if (inputEl) {
        const current = String(inputEl.value || '').trim();
        inputEl.value = current ? `${current}\n\n${text}` : text;
        inputEl.dispatchEvent(new win.Event('input', { bubbles: true }));
        inputEl.focus();
      }
      const composer = getComposer();
      if (file && composer && typeof composer.uploadFile === 'function') composer.uploadFile(file);
    }

    function close() {
      if (overlay) overlay.remove();
      overlay = null;
    }

    async function open(url, name) {
      close();
      const src = sourcePathFromUrl(url, win.location && win.location.href);
      let blob;
      let lastModified = '';
      try {
        const response = await fetchFn(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        lastModified = response.headers.get('last-modified') || '';
        blob = await response.blob();
      } catch (error) {
        notify('无法加载图片用于标注：' + (error && error.message || error));
        return false;
      }
      const image = await new Promise((resolve, reject) => {
        const img = new win.Image();
        const objectUrl = win.URL.createObjectURL(blob);
        img.onload = () => { win.URL.revokeObjectURL(objectUrl); resolve(img); };
        img.onerror = () => { win.URL.revokeObjectURL(objectUrl); reject(new Error('decode failed')); };
        img.src = objectUrl;
      }).catch(() => null);
      if (!image) { notify('图片解码失败，无法标注'); return false; }
      build(image, src, name, lastModified);
      return true;
    }

    function build(image, src, name, lastModified) {
      const W = image.naturalWidth;
      const H = image.naturalHeight;
      const marks = [];
      let tool = 'point';
      let scale = 1;
      let tx = 0;
      let ty = 0;
      let draft = null;

      overlay = el(doc, 'div', 'annotate-overlay');
      const header = el(doc, 'div', 'annotate-header');
      header.append(el(doc, 'span', 'annotate-title', '标注 · ' + (name || src.split('/').pop() || '图片')));
      const age = ageText(lastModified, Date.now());
      const stale = el(doc, 'span', 'annotate-stale', age);
      const refresh = el(doc, 'button', 'annotate-btn', '页面变了，重新截');
      refresh.type = 'button';
      refresh.onclick = () => { putIntoComposer(refreshText(src), null); close(); };
      stale.append(refresh);
      const closeBtn = el(doc, 'button', 'annotate-btn annotate-close', '×');
      closeBtn.type = 'button';
      closeBtn.title = '关闭';
      closeBtn.onclick = close;
      header.append(stale, closeBtn);

      const toolbar = el(doc, 'div', 'annotate-toolbar');
      const tools = [['pan', '✋ 查看'], ['point', '① 点'], ['box', '▭ 框'], ['arrow', '➜ 箭头']];
      const toolButtons = tools.map(([key, label]) => {
        const b = el(doc, 'button', 'annotate-btn' + (key === tool ? ' on' : ''), label);
        b.type = 'button';
        b.onclick = () => { tool = key; toolButtons.forEach(x => x.classList.toggle('on', x === b)); };
        return b;
      });
      const undo = el(doc, 'button', 'annotate-btn', '↶ 撤销');
      undo.type = 'button';
      undo.onclick = () => { marks.pop(); render(); renderList(); };
      const fitBtn = el(doc, 'button', 'annotate-btn', '适配');
      fitBtn.type = 'button';
      fitBtn.onclick = fit;
      toolbar.append(...toolButtons, el(doc, 'span', 'annotate-sep'), undo, fitBtn);

      const stage = el(doc, 'div', 'annotate-stage');
      const cv = el(doc, 'canvas', 'annotate-canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const loupe = el(doc, 'canvas', 'annotate-loupe');
      loupe.width = 120; loupe.height = 120;
      const lg = loupe.getContext('2d');
      stage.append(cv, loupe);

      const hint = el(doc, 'div', 'annotate-hint', '单指：用当前工具（点=轻触，框/箭头=拖动）；双指：随时缩放平移。手指拖动时上方有放大镜。');
      const list = el(doc, 'div', 'annotate-marks');
      const noteBox = el(doc, 'div', 'annotate-note');
      const noteInput = el(doc, 'textarea');
      noteInput.placeholder = '整体说明（可选）：比如「先关掉右上角弹窗再点同意」';
      const warn = el(doc, 'div', 'annotate-warn', '⚠ 标注图和文字都会发给模型。密码/验证码不要写在这里，用「🔒 敏感信息」存进本地保险箱。');
      noteBox.append(noteInput, warn);

      const actions = el(doc, 'div', 'annotate-actions');
      const secretBtn = el(doc, 'button', 'annotate-btn', '🔒 敏感信息');
      secretBtn.type = 'button';
      secretBtn.onclick = saveSecret;
      const cancel = el(doc, 'button', 'annotate-btn', '取消');
      cancel.type = 'button';
      cancel.onclick = close;
      const done = el(doc, 'button', 'annotate-btn primary', '放进输入框');
      done.type = 'button';
      done.onclick = finish;
      actions.append(secretBtn, el(doc, 'span', 'annotate-spacer'), cancel, done);

      overlay.append(header, toolbar, stage, hint, list, noteBox, actions);
      doc.body.appendChild(overlay);

      function apply() { cv.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }
      function fit() {
        const r = stage.getBoundingClientRect();
        scale = Math.min(r.width / W, r.height / H) || 1;
        tx = (r.width - W * scale) / 2;
        ty = (r.height - H * scale) / 2;
        apply();
      }
      function toImg(e) {
        const r = stage.getBoundingClientRect();
        return {
          x: Math.max(0, Math.min(W, (e.clientX - r.left - tx) / scale)),
          y: Math.max(0, Math.min(H, (e.clientY - r.top - ty) / scale)),
        };
      }
      function render(ctx = g, withDraft = true) {
        ctx.drawImage(image, 0, 0);
        marks.forEach((m, i) => drawMark(ctx, m, i));
        if (withDraft && draft) drawMark(ctx, draft, null);
      }
      function renderList() {
        list.replaceChildren();
        const kinds = { point: '点', box: '框', arrow: '箭头' };
        marks.forEach((m, i) => {
          const row = el(doc, 'div', 'annotate-mark');
          const input = el(doc, 'input');
          input.placeholder = '这里要做什么？（可空）';
          input.value = m.note || '';
          input.oninput = () => { m.note = input.value; };
          const del = el(doc, 'button', 'annotate-btn', '✕');
          del.type = 'button';
          del.onclick = () => { marks.splice(i, 1); render(); renderList(); };
          row.append(el(doc, 'span', 'annotate-no', String(i + 1)), el(doc, 'span', 'annotate-kind', kinds[m.kind]), input, del);
          list.appendChild(row);
        });
      }
      function showLoupe(e, p) {
        if (e.pointerType !== 'touch') return;
        const r = stage.getBoundingClientRect();
        loupe.style.display = 'block';
        loupe.style.left = (e.clientX - r.left - 60) + 'px';
        loupe.style.top = (e.clientY - r.top - 150) + 'px';
        lg.clearRect(0, 0, 120, 120);
        const span = 60 / Math.max(scale, 0.01) / 2;
        lg.drawImage(cv, p.x - span / 2, p.y - span / 2, span, span, 0, 0, 120, 120);
        lg.strokeStyle = MARK_COLOR;
        lg.beginPath(); lg.moveTo(60, 48); lg.lineTo(60, 72); lg.moveTo(48, 60); lg.lineTo(72, 60); lg.stroke();
      }

      // One pointer = current tool; two pointers = pinch zoom/pan, always.
      const pointers = new Map();
      let pinch = null;
      let panFrom = null;
      stage.addEventListener('pointerdown', e => {
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, e);
        if (pointers.size >= 2) {
          draft = null; panFrom = null; loupe.style.display = 'none';
          const [a, b] = [...pointers.values()];
          pinch = {
            d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
            s: scale, tx, ty, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2,
          };
          render();
          return;
        }
        if (tool === 'pan') { panFrom = { x: e.clientX, y: e.clientY, tx, ty }; return; }
        const p = toImg(e);
        draft = { kind: tool, a: p, b: p, note: '' };
        render(); showLoupe(e, p);
      });
      stage.addEventListener('pointermove', e => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, e);
        if (pinch && pointers.size >= 2) {
          const [a, b] = [...pointers.values()];
          const r = stage.getBoundingClientRect();
          const k = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d;
          const next = Math.max(0.1, Math.min(8, pinch.s * k));
          const cx = (a.clientX + b.clientX) / 2 - r.left;
          const cy = (a.clientY + b.clientY) / 2 - r.top;
          const ox = pinch.cx - r.left;
          const oy = pinch.cy - r.top;
          tx = cx - (ox - pinch.tx) * next / pinch.s;
          ty = cy - (oy - pinch.ty) * next / pinch.s;
          scale = next;
          apply();
          return;
        }
        if (panFrom) { tx = panFrom.tx + e.clientX - panFrom.x; ty = panFrom.ty + e.clientY - panFrom.y; apply(); return; }
        if (draft) {
          const p = toImg(e);
          if (draft.kind === 'point') { draft.a = p; draft.b = p; } else draft.b = p;
          render(); showLoupe(e, p);
        }
      });
      const end = e => {
        pointers.delete(e.pointerId);
        loupe.style.display = 'none';
        if (pinch) { if (pointers.size === 0) pinch = null; return; }
        panFrom = null;
        if (!draft) return;
        const d = draft;
        draft = null;
        if (d.kind !== 'point' && Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < MIN_DRAG_PX) { render(); return; }
        marks.push(d);
        render(); renderList();
        const inputs = list.querySelectorAll('input');
        if (inputs.length && e.pointerType !== 'touch') inputs[inputs.length - 1].focus();
      };
      stage.addEventListener('pointerup', end);
      stage.addEventListener('pointercancel', end);
      stage.addEventListener('wheel', e => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        const next = Math.max(0.1, Math.min(8, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
        tx = cx - (cx - tx) * next / scale;
        ty = cy - (cy - ty) * next / scale;
        scale = next;
        apply();
      }, { passive: false });

      async function saveSecret() {
        const name = String(win.prompt('保险箱条目名（字母/数字/_.-）', 'ASSIST_SECRET') || '').trim();
        if (!name) return;
        if (!SECRET_NAME_RE.test(name)) { notify('条目名只能包含字母、数字、_ . -'); return; }
        const value = win.prompt(`输入 ${name} 的值（只存本地保险箱，不进对话）`, '');
        if (!value) return;
        try {
          const response = await fetchFn(withToken('/api/secrets'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, value, sessionId: getSessionId() || '', source: 'user' }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok !== true) throw new Error(data.error || ('HTTP ' + response.status));
        } catch (error) {
          notify('保存失败：' + (error && error.message || error));
          return;
        }
        const line = `敏感值已存入本地保险箱，环境变量名 ${name}（值不在对话里）`;
        noteInput.value = noteInput.value.trim() ? `${noteInput.value.trim()} ${line}` : line;
      }

      function finish() {
        const text = serializeAnnotation({ src, width: W, height: H, marks, note: noteInput.value });
        if (!marks.length) {
          putIntoComposer(text, null);
          close();
          return;
        }
        const out = el(doc, 'canvas');
        out.width = W; out.height = H;
        render(out.getContext('2d'), false);
        out.toBlob(blob => {
          const file = blob ? new win.File([blob], exportFileName(src, Date.now()), { type: 'image/png' }) : null;
          if (!file) notify('标注图导出失败，只放入了文字');
          putIntoComposer(text, file);
          close();
        }, 'image/png');
      }

      render();
      renderList();
      win.requestAnimationFrame(fit);
    }

    function install() {
      const lightbox = doc.getElementById('img-lightbox');
      if (!lightbox || lightbox.querySelector('.lb-annotate')) return false;
      const button = el(doc, 'button', 'lb-annotate', '✎ 标注');
      button.type = 'button';
      button.title = '在图上标注并写操作说明';
      button.addEventListener('click', event => {
        event.stopPropagation();
        const img = lightbox.querySelector('img');
        const url = img && img.getAttribute('src');
        if (!url) return;
        const name = lightbox.querySelector('.lb-name')?.textContent || '';
        lightbox.classList.remove('show');
        open(url, name);
      });
      lightbox.appendChild(button);
      return true;
    }

    return Object.freeze({ install, open, close });
  }

  const api = Object.freeze({
    serializeAnnotation, refreshText, sourcePathFromUrl, exportFileName, ageText, createAnnotator,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatAnnotate = api;

  // Browser auto-wire. chat.js's top-level `chatComposer` / `_sessionName` are
  // shared global lexical bindings, resolved lazily at click time.
  if (typeof document !== 'undefined' && typeof window !== 'undefined' && global === window) {
    const annotator = createAnnotator({
      doc: document,
      win: window,
      fetchFn: (...args) => window.fetch(...args),
      withToken: url => (typeof window.withToken === 'function' ? window.withToken(url) : url),
      // eslint-disable-next-line no-undef
      getComposer: () => (typeof chatComposer !== 'undefined' ? chatComposer : null),
      getInputEl: () => document.getElementById('input'),
      // eslint-disable-next-line no-undef
      getSessionId: () => (typeof _sessionName !== 'undefined' ? _sessionName : ''),
      notify: text => { if (typeof window.addSystemMsg === 'function') window.addSystemMsg(text); else window.alert(text); },
    });
    global.MultiCCChatAnnotator = annotator;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => annotator.install());
    else annotator.install();
  }
})(typeof window !== 'undefined' ? window : globalThis);
