'use strict';

// 任务图谱渲染器：/api/task-graph 的 { nodes, edges } 画成力导向网络。
// 力导向引擎与 public/memory-graph.js 同构（黄金角螺旋初值 + FR 斥引模型），
// 但节点/边语义完全独立：任务节点按 classify 状态着色（P/D/W/B/E），
// provisional 半透明、canonical 实色；任务壳画成小菱形；边按类型着色
// （parent / group / merged / shell-link）。无网络副作用，纯展示。
(function initTaskGraph(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const SVGNS = 'http://www.w3.org/2000/svg';
  // 界面文案走全局 t()（i18n.js 在 manage.html 与 Air 里都先于本文件加载）。取不到就
  // 原样退回 key —— 与仓库里其它共享模块同样的兜底。包一层而不是直接抓 root.t：译文
  // 在渲染时取，别把这个 IIFE 求值那一刻的语言钉死。
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // classify 状态配色（与 CLASSIFY_DISPLAY 的语义对齐，色值取面板惯用色）。
  // labelKey 是图例上的名字（字母前缀 + 状态名做成一条，英文语序不用跟中文一样）。
  const CLASSIFY = {
    P: { c: '#6cb6ff', labelKey: 'airTaskGraphLegendP' },
    D: { c: '#3fb950', labelKey: 'airTaskGraphLegendD' },
    W: { c: '#d29922', labelKey: 'airTaskGraphLegendW' },
    B: { c: '#bc8cff', labelKey: 'airTaskGraphLegendB' },
    E: { c: '#f85149', labelKey: 'airTaskGraphLegendE' },
    null: { c: '#8b949e', labelKey: 'airTaskGraphLegendNoClassify' },
  };
  const classifyOf = (s) => CLASSIFY[s] || CLASSIFY.null;
  // 边类型配色：parent 橙 / group 青 / merged 红虚线 / 来源边蓝虚线 / shell-link 灰。
  const EDGE = {
    parent: { c: '#f0883e', dash: '', labelKey: 'airTaskGraphEdgeParent' },
    group: { c: '#3ad6c5', dash: '', labelKey: 'airTaskGraphEdgeGroup' },
    merged: { c: '#f85149', dash: '4 3', labelKey: 'airTaskGraphEdgeMerged' },
    split_from: { c: '#58a6ff', dash: '5 3', labelKey: 'airTaskGraphEdgeSplitFrom' },
    fork_from: { c: '#a371f7', dash: '5 3', labelKey: 'airTaskGraphEdgeForkFrom' },
    related: { c: '#d29922', dash: '3 3', labelKey: 'airTaskGraphEdgeRelated' },
    'shell-link': { c: '#6e7681', dash: '2 2', labelKey: 'airTaskGraphEdgeShellLink' },
  };
  const edgeOf = (t) => EDGE[t] || EDGE['shell-link'];

  let G = null;                 // { nodes, edges, meta, byId }
  let _taskRaw = null;          // 全量 payload 缓存（切项目走客户端过滤）
  const view = { tx: 0, ty: 0, scale: 1 };
  let W = 800, H = 520;
  let svg, gVp, gEdges, gNodes, canvas;
  let rafId = 0, alpha = 0;
  let dragNode = null, dragMoved = false, panning = false;
  let ptrStart = null;
  let _reqSeq = 0;

  function el(id) { return document.getElementById(id); }
  function mk(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ── 数据加载 ──────────────────────────────────────────────────────────
  window.loadTaskGraph = async function (dirId, forceRefetch) {
    canvas = el('tg-graph-canvas'); svg = el('tg-graph-svg');
    if (!canvas || !svg) { root.__taskGraphLoaded = false; return; }
    // 拖拽/缩放的指针事件原本只在 DOMContentLoaded 那次 bindGraphLifecycle 里绑，
    // 但 Air 的面板是懒渲染的：首次绑定跑的时候画布还不存在，等到用户点开这一页才
    // 被创建。bindCanvasOnce 自带 __tgBound 幂等标记，所以每次加载都补一次。
    bindCanvasOnce();
    const sel = el('tg-graph-project');
    const metaEl = el('tg-graph-meta');
    let srvMs = (_taskRaw && _taskRaw.meta && _taskRaw.meta.durationMs) || 0;
    let clientMs = 0;

    if (!_taskRaw || forceRefetch) {
      const seq = ++_reqSeq;
      if (metaEl) metaEl.textContent = t('loading');
      stopSim();
      const t0 = performance.now();
      try {
        const response = await fetch('/api/task-graph', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (seq !== _reqSeq) return; // 竞态：更晚的请求已发出
        _taskRaw = payload;
      } catch (e) {
        if (seq !== _reqSeq) return;
        root.__taskGraphLoaded = false;
        showEmpty(t('airTaskGraphLoadFailed', { msg: (e && e.message ? e.message : e) }));
        if (metaEl) metaEl.textContent = '';
        return;
      }
      clientMs = Math.round(performance.now() - t0);
      srvMs = (_taskRaw.meta && _taskRaw.meta.durationMs) || 0;
    }

    const projects = (_taskRaw.meta && _taskRaw.meta.projects) || [];
    let target = dirId;
    if (target === undefined || target === null) {
      target = (sel && sel.value) || (projects[0] && projects[0].dirId) || 'all';
    }
    if (sel) {
      const total = projects.reduce((a, p) => a + (p.count || 0), 0);
      let html = `<option value="all">${escapeHtml(t('airTaskGraphProjectAll', { n: total }))}</option>`;
      for (const p of projects) html += `<option value="${escapeHtml(p.dirId)}">${escapeHtml(p.name)} (${p.count})</option>`;
      sel.innerHTML = html;
      sel.value = target;
      if (sel.value !== target) { sel.value = 'all'; target = 'all'; }
    }

    const sub = filterPayload(_taskRaw, target);
    buildGraph(sub);
    root.__taskGraphLoaded = true;

    const nc = sub.nodes.length, ec = sub.edges.length;
    const pill = el('tg-graph-count-pill');
    if (pill) pill.textContent = nc ? t('airTaskGraphMetaCount', { nc, ec }) : '';
    if (metaEl) {
      metaEl.textContent = t('airTaskGraphMetaServer', { nc, ec, ms: srvMs })
        + (clientMs ? t('airTaskGraphMetaFetch', { ms: clientMs }) : '')
        + (_taskRaw.meta && _taskRaw.meta.truncated ? t('airTaskGraphMetaTruncated', { n: _taskRaw.meta.maxNodes }) : '');
    }
    renderLegend();

    if (!nc) { stopSim(); showEmpty(t('airTaskGraphEmpty')); return; }
    hideEmpty();

    stopSim();
    measure();
    initPositions();
    buildSvg();
    fitView();
    paint();
    const warm = Math.max(8, Math.min(60, Math.round(3600 / Math.max(nc, 1))));
    for (let i = 0; i < warm; i++) tick(0.9);
    fitView();
    paint();
    startSim(0.6);
  };

  // 客户端项目过滤（与服务端规则一致：节点 dirId 匹配，边两端都在子图内）。
  function filterPayload(raw, target) {
    if (!target || target === 'all') return { nodes: raw.nodes, edges: raw.edges, meta: raw.meta };
    const nodes = raw.nodes.filter(n => n.dirId === target);
    const ids = new Set(nodes.map(n => n.id));
    const edges = raw.edges.filter(e => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges, meta: raw.meta };
  }

  function buildGraph(payload) {
    const byId = new Map();
    const nodes = payload.nodes.map(n => {
      const m = { ...n, x: 0, y: 0, vx: 0, vy: 0, pinned: false, r: 0 };
      // 任务按度定半径；壳是配角，固定小半径。
      m.r = n.kind === 'shell' ? 3.5 : 6 + Math.min(n.degree || 0, 12) * 1.4;
      byId.set(n.id, m);
      return m;
    });
    const edges = [];
    for (const e of payload.edges) {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) continue;
      edges.push({ ...e, s, t });
    }
    G = { nodes, edges, meta: payload.meta, byId };
  }

  function measure() {
    W = svg.clientWidth || canvas.clientWidth || 800;
    H = svg.clientHeight || canvas.clientHeight || 520;
    if (W < 50) W = 800; if (H < 50) H = 520;
  }

  function initPositions() {
    const cx = W / 2, cy = H / 2, n = G.nodes.length;
    const R = Math.min(W, H) * 0.4;
    G.nodes.forEach((nd, i) => {
      const ang = i * 2.399963;
      const rad = R * Math.sqrt((i + 1) / n);
      nd.x = cx + rad * Math.cos(ang);
      nd.y = cy + rad * Math.sin(ang);
      nd.vx = nd.vy = 0;
    });
  }

  // ── 力导向一步（与 memory-graph 相同的 FR 变体）───────────────────────
  function tick(temp) {
    const nodes = G.nodes, edges = G.edges, n = nodes.length;
    if (!n) return;
    const area = W * H;
    const k = 1.1 * Math.sqrt(area / n);
    const k2 = k * k;
    const cx = W / 2, cy = H / 2;
    for (const a of nodes) { a.fx = 0; a.fy = 0; }
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.1 + 0.05; dy = 0.05; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = k2 / d2;
        const ux = dx / d, uy = dy / d;
        a.fx += ux * f; a.fy += uy * f;
        b.fx -= ux * f; b.fy -= uy * f;
      }
    }
    for (const e of edges) {
      const a = e.s, b = e.t;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      // 父子/合并比 group/shell-link 更强，家族靠得更近。
      const w = e.type === 'parent' || e.type === 'merged' ? 2.4
        : e.type === 'group' || e.type === 'split_from' || e.type === 'fork_from' ? 1.4 : 1;
      const f = (d * d) / k * (0.6 + w * 0.1);
      const ux = dx / d, uy = dy / d;
      a.fx += ux * f; a.fy += uy * f;
      b.fx -= ux * f; b.fy -= uy * f;
    }
    const maxStep = 26 * temp;
    for (const a of nodes) {
      a.fx += (cx - a.x) * 0.009;
      a.fy += (cy - a.y) * 0.009;
      if (a.pinned) continue;
      const len = Math.hypot(a.fx, a.fy) || 1;
      const step = Math.min(len, maxStep);
      a.x += (a.fx / len) * step;
      a.y += (a.fy / len) * step;
    }
  }

  function startSim(a0) {
    alpha = a0 == null ? 0.6 : a0;
    if (rafId) return;
    const loop = () => {
      tick(alpha); tick(alpha);
      paint();
      alpha *= 0.94;
      if (alpha < 0.03) { rafId = 0; return; }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  function stopSim() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }

  // ── SVG 构建 / 绘制 ───────────────────────────────────────────────────
  function buildSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const defs = mk('defs');
    const marker = mk('marker', { id: 'tg-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    marker.appendChild(mk('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6e7681' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    gVp = mk('g', { id: 'tg-graph-viewport' });
    gEdges = mk('g', { class: 'tg-edges' });
    gNodes = mk('g', { class: 'tg-nodes' });
    gVp.appendChild(gEdges); gVp.appendChild(gNodes);
    svg.appendChild(gVp);

    for (const e of G.edges) {
      const style = edgeOf(e.type);
      const line = mk('line', { class: 'tg-edge', 'marker-end': 'url(#tg-arrow)',
        stroke: style.c, 'stroke-dasharray': style.dash, 'stroke-width': 1.1 });
      e.el = line; gEdges.appendChild(line);
    }
    for (const nd of G.nodes) {
      const g = mk('g', { class: 'tg-node' });
      if (nd.kind === 'shell') {
        // 任务壳：小菱形（rotate 45° 的 rect），归档的再降透明度。
        const side = nd.r * 1.8;
        const rect = mk('rect', { x: -side / 2, y: -side / 2, width: side, height: side,
          transform: 'rotate(45)', fill: '#30363d', stroke: '#8b949e', 'stroke-width': 1,
          'fill-opacity': nd.archived ? 0.35 : 0.85 });
        g.appendChild(rect);
        nd.circle = rect;
      } else {
        const cc = classifyOf(nd.classifyState);
        const circle = mk('circle', { r: nd.r, fill: cc.c,
          stroke: nd.status === 'done' || nd.status === 'archived' ? '#6e7681' : 'rgba(0,0,0,.35)',
          'stroke-width': nd.status === 'done' || nd.status === 'archived' ? 1.4 : 1,
          // provisional 半透明（身份未锁），canonical 实色。
          'fill-opacity': nd.provisional ? 0.4 : 0.92 });
        g.appendChild(circle);
        nd.circle = circle;
      }
      const label = mk('text', { 'font-size': 10, 'text-anchor': 'middle', dy: nd.r + 11,
        fill: '#adbac7', opacity: nd.degree > 0 ? 0.95 : 0 });
      label.textContent = truncate(nd.kind === 'shell' ? nd.title : (nd.title || nd.id), 18);
      g.appendChild(label);
      g.__node = nd; nd.el = g;
      g.addEventListener('pointerdown', onNodePointerDown);
      gNodes.appendChild(g);
    }
  }

  function paint() {
    if (!G) return;
    gVp.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.scale})`);
    for (const e of G.edges) {
      const a = e.s, b = e.t;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const x2 = b.x - ux * (b.r + 5), y2 = b.y - uy * (b.r + 5);
      const x1 = a.x + ux * (a.r * 0.6), y1 = a.y + uy * (a.r * 0.6);
      e.el.setAttribute('x1', x1); e.el.setAttribute('y1', y1);
      e.el.setAttribute('x2', x2); e.el.setAttribute('y2', y2);
    }
    for (const nd of G.nodes) nd.el.setAttribute('transform', `translate(${nd.x},${nd.y})`);
  }

  function fitView() {
    if (!G.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of G.nodes) {
      minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r);
    }
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    const pad = 40;
    const s = clamp(Math.min((W - pad) / bw, (H - pad) / bh), 0.2, 2);
    view.scale = s;
    view.tx = (W - (minX + maxX) * s) / 2;
    view.ty = (H - (minY + maxY) * s) / 2;
  }

  // ── 交互：平移 / 缩放 / 节点拖拽（同 memory-graph）────────────────────
  function toLayout(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return { x: (clientX - rect.left - view.tx) / view.scale,
             y: (clientY - rect.top - view.ty) / view.scale };
  }

  function onNodePointerDown(ev) {
    ev.stopPropagation();
    const nd = ev.currentTarget.__node;
    dragNode = nd; dragMoved = false;
    ptrStart = { cx: ev.clientX, cy: ev.clientY };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (_) {}
    ev.currentTarget.addEventListener('pointermove', onNodePointerMove);
    ev.currentTarget.addEventListener('pointerup', onNodePointerUp);
    ev.currentTarget.addEventListener('pointercancel', onNodePointerUp);
  }
  function onNodePointerMove(ev) {
    if (!dragNode) return;
    if (Math.abs(ev.clientX - ptrStart.cx) + Math.abs(ev.clientY - ptrStart.cy) > 3) dragMoved = true;
    const p = toLayout(ev.clientX, ev.clientY);
    dragNode.x = p.x; dragNode.y = p.y; dragNode.pinned = true;
    paint();
    startSim(0.25);
  }
  function onNodePointerUp(ev) {
    const g = ev.currentTarget;
    g.removeEventListener('pointermove', onNodePointerMove);
    g.removeEventListener('pointerup', onNodePointerUp);
    g.removeEventListener('pointercancel', onNodePointerUp);
    try { g.releasePointerCapture(ev.pointerId); } catch (_) {}
    const nd = dragNode; dragNode = null;
    if (!dragMoved && nd) tgNodeModalOpen(nd.id); // 未拖动 = 点击
  }

  function bindCanvasOnce() {
    if (canvas.__tgBound) return; canvas.__tgBound = true;
    canvas.addEventListener('pointerdown', (ev) => {
      if (dragNode) return;
      panning = true; canvas.classList.add('panning');
      ptrStart = { sx: ev.clientX, sy: ev.clientY, tx: view.tx, ty: view.ty };
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!panning) return;
      view.tx = ptrStart.tx + (ev.clientX - ptrStart.sx);
      view.ty = ptrStart.ty + (ev.clientY - ptrStart.sy);
      paint();
    });
    const endPan = (ev) => { if (!panning) return; panning = false; canvas.classList.remove('panning');
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {} };
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
  }

  function zoomAt(sx, sy, f) {
    const ns = clamp(view.scale * f, 0.2, 4);
    const lx = (sx - view.tx) / view.scale, ly = (sy - view.ty) / view.scale;
    view.scale = ns;
    view.tx = sx - lx * ns; view.ty = sy - ly * ns;
    paint();
  }

  window.tgGraphZoom = function (f) { if (!svg) return; zoomAt(W / 2, H / 2, f); };
  window.tgGraphResetView = function () {
    if (!G) return;
    stopSim();
    for (const n of G.nodes) n.pinned = false;
    measure(); initPositions(); paint();
    const warm = Math.max(8, Math.min(60, Math.round(3600 / Math.max(G.nodes.length, 1))));
    for (let i = 0; i < warm; i++) tick(0.9);
    fitView(); paint(); startSim(0.5);
  };

  // ── 图例 / 空状态 ────────────────────────────────────────────────────
  function renderLegend() {
    const box = el('tg-graph-legend'); if (!box) return;
    const states = new Set(G ? G.nodes.filter(n => n.kind !== 'shell').map(n => n.classifyState || 'null') : []);
    const types = new Set(G ? G.edges.map(e => e.type) : []);
    let html = Object.keys(CLASSIFY)
      .filter(k => states.has(k))
      .map(k => `<span class="lg"><span class="sw" style="background:${CLASSIFY[k].c}"></span>${escapeHtml(t(CLASSIFY[k].labelKey))}</span>`)
      .join('');
    if (G && G.nodes.some(n => n.kind === 'shell')) {
      html += `<span class="lg" style="opacity:.85"><span class="sw" style="background:#30363d;border:1px solid #8b949e;transform:rotate(45deg)"></span>${escapeHtml(t('airTaskGraphShellNode'))}</span>`;
    }
    if (G && G.nodes.some(n => n.kind !== 'shell' && n.provisional)) {
      html += `<span class="lg" style="opacity:.5"><span class="sw" style="background:#8b949e;opacity:.4"></span>${escapeHtml(t('airTaskGraphLegendProvisional'))}</span>`;
    }
    html += Object.keys(EDGE)
      .filter(k => types.has(k))
      .map(k => `<span class="lg" style="opacity:.85">—<span style="color:${EDGE[k].c}">${escapeHtml(t(EDGE[k].labelKey))}</span></span>`)
      .join('');
    // 用户手动建立的关系与推导出来的边分开标注：图上看起来都是「同组」，
    // 但只有前者是用户意图。
    if (G && G.edges.some(e => e.provenance === 'user')) {
      html += `<span class="lg" style="opacity:.85">${escapeHtml(t('airTaskGraphLegendManualRelation'))}</span>`;
    }
    box.innerHTML = html;
  }
  function showEmpty(msg) {
    const e = el('tg-graph-empty'); if (!e) return;
    e.textContent = msg || t('airUsageNoData'); e.style.display = 'flex';
    if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
  }
  function hideEmpty() { const e = el('tg-graph-empty'); if (e) e.style.display = 'none'; }

  // ── 节点详情弹窗 ─────────────────────────────────────────────────────
  // 状态名（不带字母前缀）走词典：图例那条把前缀一起写死了，这里只取名字那一半。
  const CLASSIFY_NAMES = {
    P: 'airTaskGraphClassNameP', D: 'airTaskGraphClassNameD', W: 'airTaskGraphClassNameW',
    B: 'airTaskGraphClassNameB', E: 'airTaskGraphClassNameE',
  };
  window.tgNodeModalOpen = function (id) {
    if (!G) return;
    const nd = G.byId.get(id); if (!nd) return;
    const titleEl = el('tg-node-title'), idEl = el('tg-node-id');
    const tags = el('tg-node-tags'), detailEl = el('tg-node-detail');
    const linksBox = el('tg-node-links'), modal = el('tg-node-modal');
    if (!titleEl || !idEl || !tags || !detailEl || !linksBox || !modal) return;
    titleEl.textContent = nd.kind === 'shell' ? `◈ ${nd.title}` : (nd.title || nd.id);
    idEl.textContent = nd.id + (nd.dirId ? '   ·   ' + nd.dirId : '');
    tags.innerHTML = '';
    const addTag = (t) => { const s = document.createElement('span'); s.className = 'mn-tag'; s.textContent = t; tags.appendChild(s); };
    if (nd.kind === 'shell') {
      addTag(t('airTaskGraphShellNode'));
      if (nd.archived) addTag(t('statusArchived'));
      if (nd.currentTaskId) addTag(t('airTaskGraphTagCurrentTask', { id: truncate(nd.currentTaskId, 20) }));
    } else {
      addTag(nd.provisional ? t('airTaskGraphTagProvisional') : 'canonical');
      if (nd.classifyState) addTag(t('airTaskGraphTagClassify', {
        code: nd.classifyState, name: CLASSIFY_NAMES[nd.classifyState] ? t(CLASSIFY_NAMES[nd.classifyState]) : '' }));
      if (nd.status) addTag(t('airTaskGraphTagStatus', { value: nd.status }));
      if (nd.runState) addTag(t('airTaskGraphTagRunState', { value: nd.runState }));
      if (nd.workflowStage) addTag(t('airTaskGraphTagStage', { value: nd.workflowStage }));
      if (nd.origin) addTag(t('airTaskGraphTagOrigin', { value: nd.origin }));
      if (nd.deleted) addTag(t('airTaskGraphTagDeleted'));
      addTag(t('airTaskGraphTagDegree', { n: nd.degree || 0 }));
    }

    // 详情：goal 摘要 + 数据来源；任务节点附「在 Air 打开」。
    const lines = [];
    if (nd.goal) lines.push(t('airTaskGraphDetailGoal', { value: nd.goal }));
    if (nd.phase) lines.push(t('airTaskGraphDetailPhase', { value: nd.phase }));
    if (nd.parentTaskId) lines.push(t('airTaskGraphDetailParent', { value: nd.parentTaskId }));
    if (nd.groupId) lines.push(t('airTaskGraphDetailGroup', { value: nd.groupId }));
    if (nd.mergedInto) lines.push(t('airTaskGraphDetailMergedInto', { value: nd.mergedInto }));
    if (nd.separatedFromTaskId) lines.push(t('airTaskGraphDetailSeparatedFrom', { value: nd.separatedFromTaskId }));
    if (nd.forkedFromTaskId) lines.push(t('airTaskGraphDetailForkedFrom', { value: nd.forkedFromTaskId }));
    if (nd.independentFromSessionId) lines.push(t('airTaskGraphDetailIndependentFrom', { value: nd.independentFromSessionId }));
    if (nd.chatSessionId || nd.sessionId) lines.push(t('airTaskGraphDetailSession', { value: nd.chatSessionId || nd.sessionId }));
    if (nd.kind !== 'shell' && nd.sources && nd.sources.length) {
      lines.push(t('airTaskGraphDetailSources', { value: nd.sources.join(' + ') }));
    }
    detailEl.textContent = lines.length ? lines.join('\n') : t('airTaskGraphDetailNone');

    const openBtn = el('tg-node-open');
    if (openBtn) {
      if (nd.kind !== 'shell' && nd.dirId) {
        openBtn.style.display = '';
        openBtn.onclick = () => { window.open(`/air?dir=${encodeURIComponent(nd.dirId)}&task=${encodeURIComponent(nd.id)}`, '_blank', 'noopener'); };
      } else openBtn.style.display = 'none';
    }

    // 邻居（出/入边，带类型）
    linksBox.innerHTML = '';
    const out = [], inc = [];
    for (const e of G.edges) {
      if (e.source === id) out.push({ n: e.t, type: e.type, user: e.provenance === 'user' });
      else if (e.target === id) inc.push({ n: e.s, type: e.type, user: e.provenance === 'user' });
    }
    const section = (title, arr, arrow) => {
      if (!arr.length) return;
      const h = document.createElement('h4'); h.textContent = title + ' (' + arr.length + ')'; linksBox.appendChild(h);
      for (const it of arr) {
        const b = document.createElement('button');
        b.className = 'mn-link';
        const typeLabel = t(edgeOf(it.type).labelKey) + (it.user ? t('airTaskGraphManualSuffix') : '');
        b.textContent = `${arrow} [${typeLabel}] ${it.n.title || it.n.id}`;
        b.onclick = () => { tgNodeModalOpen(it.n.id); focusNode(it.n); };
        linksBox.appendChild(b);
      }
    };
    section(t('airTaskGraphSectionOut'), out, '→');
    section(t('airTaskGraphSectionIn'), inc, '←');
    if (!out.length && !inc.length) {
      const p = document.createElement('div'); p.style.cssText = 'color:var(--faint);font-size:12px';
      p.textContent = t('airTaskGraphNoLinks'); linksBox.appendChild(p);
    }
    modal.classList.add('open');
  };
  window.tgNodeModalClose = function () { const m = el('tg-node-modal'); if (m) m.classList.remove('open'); };

  function focusNode(nd) {
    view.tx = W / 2 - nd.x * view.scale;
    view.ty = H / 2 - nd.y * view.scale;
    paint();
  }

  function bindGraphLifecycle() {
    const c = el('tg-graph-canvas');
    if (c) { canvas = c; svg = el('tg-graph-svg'); bindCanvasOnce(); }
    if (!document.__multiccTaskGraphEscapeBound) {
      document.__multiccTaskGraphEscapeBound = true;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.tgNodeModalClose(); });
    }
  }
  document.addEventListener('DOMContentLoaded', bindGraphLifecycle);
  if (document.readyState !== 'loading') bindGraphLifecycle();

  root.MultiCCTaskGraph = Object.freeze({
    invalidate() {
      stopSim();
      _taskRaw = null;
      _reqSeq++;
      root.__taskGraphLoaded = false;
    },
  });
})(typeof window !== 'undefined' ? window : null);
