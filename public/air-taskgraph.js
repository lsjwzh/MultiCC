'use strict';

// Air 原生「任务图谱」面板 —— 旧 manage 页 Task Graph 那一格的 id 骨架 + 样式，
// 搬成 Air 的原生页（不再嵌旧 manage 的 iframe）。
//
// 力导向画布本身不在这份文件里，也**不该**在这儿重写：它还是 public/task-graph.js
// 那个自包含渲染器（window.loadTaskGraph / tgGraphZoom / tgGraphResetView /
// tgNodeModalOpen / tgNodeModalClose），它全部按 id 找元素 —— 图例、空态、节点弹窗、
// 缩放按钮各认各的 id。所以这份文件只做三件事：
//   ① 把那一格的 id 骨架原样建出来（少一个 id，画布就哑一片）；
//   ② 把它的 <style> 一起带过来（那些 #tg-* / .tg-zoom-btns 选择器不住在 air.css 里，
//      少一段画布就塌 —— 选择器一个字没改，只补了两个 Air 缺失的设计变量，见下）；
//   ③ 建完调一次 loadTaskGraph()，并给 refresh() 一条「清缓存 + 强制重拉」的路。
//
// 它是控制台工具格（也是设置中心第一组）的一格，所以返回目标是控制台，工具条
// （返回 + 刷新）由 air-admin.js 统一装，这里只画正文 —— 同保险箱、Goal 那几页。
//
// 文案边界：这份文件自己写的字（标题、说明、项目、缩放按钮、画布提示）全部走 t()；
// task-graph.js 内部的文案（「加载中…」「暂无任务节点。…」、图例里的类型词、节点弹窗
// 里的标签）仍然是它自己硬编码的中文 —— 这次搬家没动它一行，改词要走它自己的提交。
(function initAirTaskgraph(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  // render/refresh 每进一次面板都会重画，回调里要用的 context 只能存这儿 ——
  // 它由 air.js / air-admin.js 每次渲染递进来（同 air-goal.js 的规矩）。
  let context = null;

  // 样式跟着面板走：air.css 不认识这些 #tg-* 选择器，而这一格只有这个文件是主人。
  // 节点只建一次并缓存 —— 重画时是把它移过去，不是再插一份到文档里。
  let styleNode = null;
  function style() {
    if (styleNode) return styleNode;
    styleNode = document.createElement('style');
    styleNode.textContent = `
      /* Air 的调色板里没有这两个 token（旧 manage 页有），但搬过来的 #tg-* 规则
         直接引用它们：--mono 缺了 var() 整条声明作废（等宽字体没了），
         --accent-dim 缺了就退回那个深墨绿的兜底色，浅色主题上会糊成一块。
         补在面板这一层，只影响这一格，不动 air.css。 */
      .air-taskgraph { --mono: ui-monospace, SFMono-Regular, Menlo, monospace; --accent-dim: #e6f1ff; }
      .air-taskgraph-desc { margin: 0 0 14px; max-width: 860px; color: var(--muted); font-size: 11.5px; line-height: 1.7; }
      .air-taskgraph-pill { color: var(--faint); font-weight: 400; font-size: 12px; }
      .air-taskgraph-spacer { flex: 1; }
      .air-taskgraph-project { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
      #tg-graph-wrap{display:flex;flex-direction:column;gap:12px}
      #tg-graph-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      #tg-graph-toolbar select{background:var(--bg-soft,#161b22);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:var(--mono);max-width:280px}
      #tg-graph-meta{font-family:var(--mono);font-size:11px;color:var(--faint)}
      #tg-graph-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted);align-items:center}
      #tg-graph-legend .lg{display:inline-flex;align-items:center;gap:5px}
      #tg-graph-legend .sw{width:11px;height:11px;border-radius:50%;display:inline-block}
      #tg-graph-canvas{position:relative;width:100%;height:min(70vh,640px);min-height:420px;
        background:radial-gradient(circle at 50% 40%,rgba(240,136,62,.05),transparent 70%),var(--bg,#0d1117);
        border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:grab}
      #tg-graph-canvas.panning{cursor:grabbing}
      #tg-graph-svg{width:100%;height:100%;display:block;touch-action:none;user-select:none}
      #tg-graph-svg text{pointer-events:none;font-family:var(--mono);fill:var(--text)}
      #tg-graph-svg .tg-node{cursor:pointer}
      #tg-graph-svg .tg-node:hover circle,#tg-graph-svg .tg-node:hover rect{stroke:#fff;stroke-width:2.5px}
      #tg-graph-svg .tg-node:hover text{opacity:1}
      #tg-graph-empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
        flex-direction:column;gap:8px;color:var(--faint);font-size:13px;text-align:center;padding:24px}
      #tg-graph-hint{position:absolute;left:12px;bottom:10px;font-size:10px;color:var(--faint);
        font-family:var(--mono);pointer-events:none;background:rgba(0,0,0,.25);padding:3px 8px;border-radius:6px}
      .tg-zoom-btns{position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;gap:6px}
      .tg-zoom-btns button{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);
        background:var(--bg-soft,#161b22);color:var(--text);cursor:pointer;font-size:15px;line-height:1}
      .tg-zoom-btns button:hover{background:var(--accent-dim,#12312d)}
      #tg-node-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:16000;display:none;align-items:center;justify-content:center}
      #tg-node-modal.open{display:flex}
      #tg-node-card{background:var(--bg-soft,#161b22);border:1px solid var(--line);border-radius:12px;
        width:min(92vw,560px);max-height:80vh;overflow:auto;padding:18px 20px}
      #tg-node-card h3{color:var(--text);font-size:15px;margin:0 0 4px;word-break:break-word}
      #tg-node-card .mn-slug{font-family:var(--mono);font-size:11px;color:var(--faint);margin-bottom:12px;word-break:break-all}
      #tg-node-card .mn-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
      #tg-node-card .mn-tag{font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.06);color:var(--muted)}
      #tg-node-card .mn-summary{color:var(--text);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--bg,#0d1117);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:12px}
      #tg-node-card .mn-links h4{color:var(--muted);font-size:11px;margin:10px 0 6px;font-weight:600}
      #tg-node-card .mn-link{display:block;width:100%;text-align:left;font-size:12px;padding:6px 9px;margin-bottom:4px;border-radius:6px;border:1px solid var(--line);background:var(--bg,#0d1117);color:var(--text);cursor:pointer;font-family:var(--mono);word-break:break-word}
      #tg-node-card .mn-link:hover{border-color:var(--accent)}
      #tg-node-card .mn-close{float:right;background:transparent;border:0;color:var(--faint);font-size:20px;cursor:pointer;line-height:1}
      #tg-node-open{background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:12px;padding:6px 12px;cursor:pointer;margin-bottom:12px}
      #tg-node-open:hover{filter:brightness(1.08)}
    `;
    return styleNode;
  }

  function button(text, handler, className = '', title = '') {
    const node = make('button', text, className);
    node.type = 'button';
    if (title) node.title = title;
    node.onclick = handler;
    return node;
  }

  function build() {
    const panel = make('section', null, 'admin-panel air-taskgraph');
    panel.append(style());
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    // 计数徽标还是旧页那个 id：#tg-graph-count-pill 由 loadTaskGraph 自己写。
    const pill = make('span', '', 'air-taskgraph-pill');
    pill.id = 'tg-graph-count-pill';
    title.append(make('span', 'TASKGRAPH', 'eyebrow'), make('h3', t('airTaskGraph')), pill);
    head.append(title);
    panel.append(head, make('p', t('airTaskgraphDesc'), 'air-taskgraph-desc'));

    const wrap = make('div');
    wrap.id = 'tg-graph-wrap';
    const toolbar = make('div');
    toolbar.id = 'tg-graph-toolbar';
    const projectField = make('label', null, 'air-taskgraph-project');
    projectField.append(make('span', t('airTaskgraphProject')));
    const project = make('select');
    project.id = 'tg-graph-project';
    // 切项目只换子图，payload 还是那一份（task-graph.js 的客户端过滤）。
    project.onchange = () => root.loadTaskGraph(project.value);
    projectField.append(project);
    const meta = make('span');
    meta.id = 'tg-graph-meta';
    const legend = make('div');
    legend.id = 'tg-graph-legend';
    toolbar.append(projectField,
      button(t('airTaskgraphResetView'), () => root.tgGraphResetView()),
      meta, make('div', null, 'air-taskgraph-spacer'), legend);

    const canvas = make('div');
    canvas.id = 'tg-graph-canvas';
    // 必须走 SVG 命名空间：task-graph.js 往里塞的是 createElementNS 建的 <g>/<line>。
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.id = 'tg-graph-svg';
    const empty = make('div');
    empty.id = 'tg-graph-empty';
    const hint = make('div', t('airTaskgraphHint'));
    hint.id = 'tg-graph-hint';
    const zoom = make('div', null, 'tg-zoom-btns');
    zoom.append(
      button('＋', () => root.tgGraphZoom(1.2), '', t('airTaskgraphZoomIn')),
      button('－', () => root.tgGraphZoom(1 / 1.2), '', t('airTaskgraphZoomOut')),
      button('⊙', () => root.tgGraphResetView(), '', t('airTaskgraphResetView')),
    );
    canvas.append(svg, empty, hint, zoom);
    wrap.append(toolbar, canvas);
    panel.append(wrap);

    // 节点详情弹窗：内容全由 task-graph.js 的 tgNodeModalOpen 填，这里只保证
    // 每个 id 都在、点空白处能关（旧页写的是 inline onclick，Air 这边统一接线）。
    const modal = make('div');
    modal.id = 'tg-node-modal';
    modal.onclick = ev => { if (ev.target === modal) root.tgNodeModalClose(); };
    const card = make('div');
    card.id = 'tg-node-card';
    const close = make('button', '×', 'mn-close');
    close.type = 'button';
    close.onclick = () => root.tgNodeModalClose();
    const nodeTitle = make('h3');
    nodeTitle.id = 'tg-node-title';
    const nodeId = make('div', null, 'mn-slug');
    nodeId.id = 'tg-node-id';
    const nodeTags = make('div', null, 'mn-tags');
    nodeTags.id = 'tg-node-tags';
    const nodeOpen = make('button', t('airTaskgraphOpenInAir'));
    nodeOpen.id = 'tg-node-open';
    nodeOpen.type = 'button';
    nodeOpen.style.display = 'none';
    const nodeDetail = make('div', null, 'mn-summary');
    nodeDetail.id = 'tg-node-detail';
    const nodeLinks = make('div', null, 'mn-links');
    nodeLinks.id = 'tg-node-links';
    card.append(close, nodeTitle, nodeId, nodeTags, nodeOpen, nodeDetail, nodeLinks);
    modal.append(card);
    panel.append(modal);

    return panel;
  }

  // task-graph.js 把「这一次到底加载成功没有」挂在 root.__taskGraphLoaded 上（失败
  // 时它自己会把话说在画布的空态里）。画布有 min(70vh,640px) 高，失败信息很容易落在
  // 屏幕外，所以再往右下角说一句 —— 同保险箱/Goal 那几页的失败回执。
  function reportIfFailed() {
    if (root.__taskGraphLoaded === false) context?.notice(t('airTaskgraphLoadFailed'));
  }

  function render(host, ctx) {
    context = ctx;
    host.replaceChildren(build());
    // 画布是懒渲染的：loadTaskGraph 第一件事就是按 id 找 canvas/svg，所以这句
    // 必须放在 replaceChildren 之后 —— 面板没进文档它谁也不认识。
    return root.loadTaskGraph().then(reportIfFailed);
  }

  function refresh() {
    // 「刷新」的语义是重读一次，不是重画旧的：先清掉 task-graph.js 那份 payload
    // 缓存（顺带停掉正在跑的模拟），再让它强制重拉 /api/task-graph。
    root.MultiCCTaskGraph?.invalidate();
    return root.loadTaskGraph(undefined, true).then(reportIfFailed);
  }

  root.MultiCCAirTaskgraph = Object.freeze({ render, refresh });
})(typeof window !== 'undefined' ? window : null);
