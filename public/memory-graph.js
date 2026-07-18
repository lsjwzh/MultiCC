'use strict';

// Memory graph renderer and interaction controller. No network access lives here.
(function initMemoryGraph(root) {
  if (!root || !root.document || !root.MultiCCMemoryModel) return;
  const document = root.document;
  const model = root.MultiCCMemoryModel;
  const escapeHtml = model.escapeHtml;
  const formatSize = model.formatSize;
  const SVGNS = 'http://www.w3.org/2000/svg';
  // 节点按 type(kind) 上色。scope 通过描边区分（shared 有描边，missing 虚线）。
  const KIND = {
    project:   { c: '#3ad6c5', label: '项目' },
    feedback:  { c: '#e3b341', label: '反馈' },
    user:      { c: '#57ab5a', label: '用户' },
    reference: { c: '#6cb6ff', label: '引用' },
    index:     { c: '#8b949e', label: '索引/入口' },
    auto:      { c: '#bc8cff', label: '自动提炼' },
    note:      { c: '#79c0ff', label: '笔记' },
    missing:   { c: '#484f58', label: '未创建(悬空引用)' },
  };
  const kindOf = (t) => KIND[t] || KIND.note;

  let G = null;                 // { nodes, edges, meta, byId }
  let _memRaw = null;           // 全量 payload 缓存（切项目时客户端过滤，秒切）
  const view = { tx: 0, ty: 0, scale: 1 };
  let W = 800, H = 520;
  let svg, gVp, gEdges, gNodes, canvas;
  let rafId = 0, alpha = 0;
  let dragNode = null, dragMoved = false, panning = false;
  let ptrStart = null;          // { sx, sy, tx, ty }
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
  // 首次拉全量并缓存；项目切换走客户端过滤（秒切，无需再次请求）。刷新时 forceRefetch 重新拉取。
  window.loadMemoryGraph = async function (dirId, forceRefetch) {
    canvas = el('mem-graph-canvas'); svg = el('mem-graph-svg');
    if (!canvas || !svg) { root.__memGraphLoaded = false; return; }
    const sel = el('mem-graph-project');
    const metaEl = el('mem-graph-meta');
    let srvMs = (_memRaw && _memRaw.meta && _memRaw.meta.durationMs) || 0;
    let clientMs = 0;

    if (!_memRaw || forceRefetch) {
      const seq = ++_reqSeq;
      if (metaEl) metaEl.textContent = '加载中…';
      stopSim();
      const t0 = performance.now();
      try {
        const payload = await model.loadGraph();
        if (seq !== _reqSeq) return; // 竞态：更晚的请求已发出
        _memRaw = payload;
      } catch (e) {
        if (seq !== _reqSeq) return;
        root.__memGraphLoaded = false;
        showEmpty('加载失败：' + model.errorMessage(e));
        if (metaEl) metaEl.textContent = '';
        return;
      }
      clientMs = Math.round(performance.now() - t0);
      srvMs = (_memRaw.meta && _memRaw.meta.durationMs) || 0;
    }

    const projects = (_memRaw.meta && _memRaw.meta.projects) || [];
    // 目标项目：显式参数 > 当前选择 > 最大单项目（更贴合“项目的记忆系统”且更清晰）> 全部
    let target = dirId;
    if (target === undefined || target === null) {
      target = (sel && sel.value) || (projects[0] && projects[0].dirId) || 'all';
    }

    // 选择器（重建 + 保持当前选择）
    if (sel) {
      const total = projects.reduce((a, p) => a + (p.count || 0), 0);
      let html = `<option value="all">全部项目 (${total})</option>`;
      for (const p of projects) html += `<option value="${escapeHtml(p.dirId)}">${escapeHtml(p.name)} (${p.count})</option>`;
      sel.innerHTML = html;
      sel.value = target;
      if (sel.value !== target) { sel.value = 'all'; target = 'all'; }
    }

    // 客户端过滤到目标项目
    const sub = filterPayload(_memRaw, target);
    buildGraph(sub);
    root.__memGraphLoaded = true;

    const nc = sub.nodes.length, ec = sub.edges.length;
    const pill = el('mem-graph-count-pill');
    if (pill) pill.textContent = nc ? `· ${nc} 节点 / ${ec} 关联` : '';
    const badge = el('nav-memory-count'); if (badge) badge.textContent = (_memRaw.nodes || []).length;
    if (metaEl) {
      metaEl.textContent = `${nc} 节点 · ${ec} 边 · 服务端 ${srvMs}ms`
        + (clientMs ? ` · 拉取 ${clientMs}ms` : '')
        + (_memRaw.meta && _memRaw.meta.truncated ? ` · 已截断至 ${_memRaw.meta.maxNodes}` : '');
    }
    renderLegend();

    if (!nc) { stopSim(); showEmpty(target === 'all' ? '暂无任何记忆节点。' : '该项目暂无记忆节点。当会话把知识写进 memories/ 下的 .md 文件后，这里会出现节点与关联。'); return; }
    hideEmpty();

    stopSim(); // 切项目/刷新时先停旧动画帧，避免与新图重建竞态
    measure();
    initPositions();
    buildSvg();
    fitView();
    paint();                    // 立即按黄金螺旋初值出图，预热期间不白屏
    // 预热 tick 数按规模自适应：大图少预热，避免 O(n²) 同步循环长时间冻结主线程
    // （螺旋初值已较合理，节点越多每 tick 越贵，故次数越少）
    const warm = Math.max(8, Math.min(60, Math.round(3600 / Math.max(nc, 1))));
    for (let i = 0; i < warm; i++) tick(0.9);
    fitView();
    paint();
    startSim(0.6); // 轻微动画收敛
  };

  // 从全量 payload 过滤出单个项目的子图（记忆不跨项目，故边过滤只需两端都在集合内）
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
      m.r = 6 + Math.min(n.degree || 0, 12) * 1.4;
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
      // 沿黄金角螺旋铺开，避免全部重叠导致初期爆炸
      const ang = i * 2.399963;
      const rad = R * Math.sqrt((i + 1) / n);
      nd.x = cx + rad * Math.cos(ang);
      nd.y = cy + rad * Math.sin(ang);
      nd.vx = nd.vy = 0;
    });
  }

  // ── 力导向一步（Fruchterman–Reingold 风格，自适应 n）──────────────────
  function tick(temp) {
    const nodes = G.nodes, edges = G.edges, n = nodes.length;
    if (!n) return;
    const area = W * H;
    const k = 1.1 * Math.sqrt(area / n);   // 理想边长（略大以铺开）
    const k2 = k * k;
    const cx = W / 2, cy = H / 2;
    for (const a of nodes) { a.fx = 0; a.fy = 0; }
    // 斥力（全对）
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.1 + 0.05; dy = 0.05; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = k2 / d2;              // 与距离平方成反比，近距离更强
        const ux = dx / d, uy = dy / d;
        a.fx += ux * f; a.fy += uy * f;
        b.fx -= ux * f; b.fy -= uy * f;
      }
    }
    // 引力（边）
    for (const e of edges) {
      const a = e.s, b = e.t;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / k * (0.6 + Math.min(e.strength || 1, 4) * 0.1);
      const ux = dx / d, uy = dy / d;
      a.fx += ux * f; a.fy += uy * f;
      b.fx -= ux * f; b.fy -= uy * f;
    }
    // 向心重力（防止离散分量飘走）+ 位移冷却
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
    const marker = mk('marker', { id: 'mem-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    marker.appendChild(mk('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6e7681' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    gVp = mk('g', { id: 'mem-graph-viewport' });
    gEdges = mk('g', { class: 'mem-edges' });
    gNodes = mk('g', { class: 'mem-nodes' });
    gVp.appendChild(gEdges); gVp.appendChild(gNodes);
    svg.appendChild(gVp);

    for (const e of G.edges) {
      const line = mk('line', { class: 'mem-edge', 'marker-end': 'url(#mem-arrow)',
        'stroke-width': clamp(0.6 + (e.strength || 1) * 0.5, 0.6, 3) });
      e.el = line; gEdges.appendChild(line);
    }
    for (const nd of G.nodes) {
      const g = mk('g', { class: 'mem-node' + (nd.missing ? ' missing' : '') });
      const kc = kindOf(nd.type).c;
      const circle = mk('circle', { r: nd.r, fill: kc,
        stroke: nd.scope === 'shared' ? '#fff' : (nd.missing ? kc : 'rgba(0,0,0,.35)'),
        'stroke-width': nd.scope === 'shared' ? 1.6 : 1,
        'stroke-dasharray': nd.missing ? '2 2' : '',
        'fill-opacity': nd.missing ? 0.5 : 0.92 });
      // 标签默认只在有关联(度>0)的节点上常显，孤立节点悬停时才显示，避免密集时糊成一片
      const label = mk('text', { 'font-size': 10, 'text-anchor': 'middle', dy: nd.r + 11,
        fill: '#adbac7', opacity: nd.degree > 0 ? 0.95 : 0 });
      label.textContent = truncate(nd.title, 18);
      g.appendChild(circle); g.appendChild(label);
      g.__node = nd; nd.el = g; nd.circle = circle;
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

  // ── 交互：平移 / 缩放 / 节点拖拽 ─────────────────────────────────────
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
    if (!dragMoved && nd) memNodeModalOpen(nd.id); // 未拖动 = 点击
  }

  function bindCanvasOnce() {
    if (canvas.__memBound) return; canvas.__memBound = true;
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

  window.memGraphZoom = function (f) { if (!svg) return; zoomAt(W / 2, H / 2, f); };
  window.memGraphResetView = function () {
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
    const box = el('mem-graph-legend'); if (!box) return;
    const kinds = new Set(G ? G.nodes.map(n => n.type) : []);
    const order = ['project', 'feedback', 'user', 'reference', 'index', 'auto', 'note', 'missing'];
    box.innerHTML = order.filter(k => kinds.has(k)).map(k =>
      `<span class="lg"><span class="sw" style="background:${kindOf(k).c}"></span>${escapeHtml(kindOf(k).label)}</span>`
    ).join('') + `<span class="lg" style="opacity:.7"><span class="sw" style="background:transparent;border:1.6px solid #fff"></span>公共记忆(shared)</span>`;
  }
  function showEmpty(msg) {
    const e = el('mem-graph-empty'); if (!e) return;
    e.textContent = msg || '暂无数据'; e.style.display = 'flex';
    if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
  }
  function hideEmpty() { const e = el('mem-graph-empty'); if (e) e.style.display = 'none'; }

  // ── 节点详情弹窗 ─────────────────────────────────────────────────────
  window.memNodeModalOpen = function (id) {
    if (!G) return;
    const nd = G.byId.get(id); if (!nd) return;
    const titleEl = el('mem-node-title'), slugEl = el('mem-node-slug');
    const tags = el('mem-node-tags'), summaryEl = el('mem-node-summary');
    const linksBox = el('mem-node-links'), modal = el('mem-node-modal');
    if (!titleEl || !slugEl || !tags || !summaryEl || !linksBox || !modal) return;
    titleEl.textContent = nd.title || nd.slug;
    const scopeTxt = nd.scope === 'shared' ? '公共记忆' : nd.scope === 'session' ? ('会话私有 · ' + (nd.sessionId || '')) : nd.scope;
    slugEl.textContent = nd.file + '   ·   ' + scopeTxt;
    tags.innerHTML = '';
    const addTag = (t) => { const s = document.createElement('span'); s.className = 'mn-tag'; s.textContent = t; tags.appendChild(s); };
    addTag('类型: ' + kindOf(nd.type).label);
    addTag('作用域: ' + (nd.scope || '—'));
    addTag('关联度: ' + (nd.degree || 0));
    if (nd.missing) addTag('⚠ 悬空引用');

    // 存放位置 + token 估算 + 打开编辑
    const pathEl = el('mem-node-path'), copyBtn = el('mem-node-copy'), editBtn = el('mem-node-edit');
    if (pathEl) pathEl.textContent = nd.path || (nd.missing ? '（文件尚未创建）' : (nd.rel || '—'));
    if (el('mem-node-tokens')) el('mem-node-tokens').textContent = nd.missing ? '–' : ('~' + (nd.tokens || 0));
    if (el('mem-node-size')) el('mem-node-size').textContent = nd.missing ? '–' : formatSize(nd.size);
    if (copyBtn) copyBtn.onclick = () => { if (nd.path && root.copyText) root.copyText(nd.path); };
    if (editBtn) {
      if (nd.rel && !nd.missing) { editBtn.style.display = ''; editBtn.onclick = () => root.openMemFileEditor && root.openMemFileEditor(nd.rel); }
      else editBtn.style.display = 'none';
    }

    summaryEl.textContent = nd.summary || '（无摘要）';

    // 邻居（出/入边）
    linksBox.innerHTML = '';
    const out = [], inc = [];
    for (const e of G.edges) {
      if (e.source === id) out.push({ n: e.t, s: e.strength });
      else if (e.target === id) inc.push({ n: e.s, s: e.strength });
    }
    const section = (title, arr, arrow) => {
      if (!arr.length) return;
      const h = document.createElement('h4'); h.textContent = title + ' (' + arr.length + ')'; linksBox.appendChild(h);
      for (const it of arr) {
        const b = document.createElement('button');
        b.className = 'mn-link';
        b.textContent = arrow + ' ' + (it.n.title || it.n.slug) + (it.s > 1 ? '  ×' + it.s : '');
        b.onclick = () => { memNodeModalOpen(it.n.id); focusNode(it.n); };
        linksBox.appendChild(b);
      }
    };
    section('引用了', out, '→');
    section('被引用', inc, '←');
    if (!out.length && !inc.length) {
      const p = document.createElement('div'); p.style.cssText = 'color:var(--faint);font-size:12px';
      p.textContent = '（暂无关联，孤立节点）'; linksBox.appendChild(p);
    }
    modal.classList.add('open');
  };
  window.memNodeModalClose = function () { const m = el('mem-node-modal'); if (m) m.classList.remove('open'); };

  function focusNode(nd) {
    // 平移使目标节点居中（保持缩放）
    view.tx = W / 2 - nd.x * view.scale;
    view.ty = H / 2 - nd.y * view.scale;
    paint();
  }

  // 首次进入视图时绑定画布交互（loadMemoryGraph 里已 setView 触发；这里兜底绑定）
  function bindGraphLifecycle() {
    const c = el('mem-graph-canvas');
    if (c) { canvas = c; svg = el('mem-graph-svg'); bindCanvasOnce(); }
    if (!document.__multiccMemoryGraphEscapeBound) {
      document.__multiccMemoryGraphEscapeBound = true;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.memNodeModalClose(); });
    }
  }
  document.addEventListener('DOMContentLoaded', bindGraphLifecycle);
  // 若 DOMContentLoaded 已过，立即绑定
  if (document.readyState !== 'loading') bindGraphLifecycle();

  root.MultiCCMemoryGraph = Object.freeze({
    invalidate() {
      stopSim();
      _memRaw = null;
      _reqSeq++;
      root.__memGraphLoaded = false;
    },
  });
})(typeof window !== 'undefined' ? window : null);
