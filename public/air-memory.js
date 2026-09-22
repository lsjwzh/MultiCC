'use strict';

// Air 原生「记忆图谱」面板 —— 项目记忆的可视化网络 + 树状瀑布 + 记忆文件编辑器。
// 这一格不重写画布：力导向渲染、拖拽/缩放/平移在 memory-graph.js，树与编辑在
// memory-controller.js，取数与响应白名单在 memory-model.js（三个脚本 air.html 已按
// model → graph → controller 的顺序加载好了）。它们全部按 id 找元素，所以这个模块
// 只做三件事：
//   ① 把旧 manage 页那一格（public/manage.html 的 #mem-* 骨架）和它那段 <style>
//      原样搬进来 —— 两个弹窗也画在面板根节点里，切走时跟着一起被清掉；
//   ② 进入这一页时把面板根节点重挂到 #admin-content 上（节点常驻，模块绑在节点
//      自己身上的事件不会因为切页而丢）；
//   ③ 在面板挂上骨架之后，把三个脚本按序重放一遍（见下面的重放）。
//
// 重放：memory-model.js 在 IIFE 期就把 root.MultiCCApi 收进了闭包。Air 这张页面
// 原先没有引 api-client.js，于是模型一开始就报「Memory API client is unavailable」；
// 现在 air.html 按 model 之前的位置补上了 api-client.js（事后往 window 上补全局是
// 没用的 —— 闭包早收完了，这也是当初只能自己现写一份桩的原因，桩已随真客户端一起
// 撤掉）。重放解决的其实是另一件事：memory-controller.js 的编辑器（保存/删除/
// textarea）只在它自己的 IIFE 与 DOMContentLoaded 上绑一次，而 Air 的面板是懒渲染
// 的 —— 那两次跑的时候这些按钮还不存在，不重放就是死的。
(function initAirMemory(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  // 重放顺序不能变：graph / controller 在 IIFE 期就要求 root.MultiCCMemoryModel 在。
  const MEMORY_SCRIPTS = ['memory-model.js', 'memory-graph.js', 'memory-controller.js'];
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  // render(host, context) 每进一次面板就被调一次，回调里要用的 context 只能存这里
  // （同 air-secrets.js）；面板节点与「脚本已重放」的承诺也留在模块上。
  let context = null;
  let panel = null;
  let readyPromise = null;

  // 搬过来的样式（public/manage.html 里那一格自带的 <style>，逐行照抄）。#mem-* 那些
  // 选择器一条都没动；下面 air-memory-* 几条是给这一页在 Air 里的壳用的（旧页那套
  // .sec-head / .btn / .sec-desc 在 Air 没有定义），另外补两个 Air 没有的变量：
  // --mono（树与画布的等宽字体）和 --accent-dim（缩放按钮的悬停底色）。
  const STYLE = `
    .air-memory-panel { --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; --accent-dim: var(--blue-soft, #eaf4ff); }
    .air-memory-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .air-memory-title { margin: 0; color: var(--text); font-size: 15px; font-weight: 650; }
    .air-memory-head .line { flex: 1; height: 1px; min-width: 12px; background: var(--line); }
    .air-memory-pill { color: var(--faint); font-size: 12px; font-weight: 400; }
    .air-memory-btn { min-height: 30px; padding: 5px 11px; border: 1px solid var(--line); border-radius: 9px;
      background: #fff; color: var(--text); cursor: pointer; font-family: inherit; font-size: 11px; }
    .air-memory-btn:hover { border-color: var(--accent); color: var(--accent); }
    .air-memory-desc { max-width: 80ch; margin: 0 0 10px; color: var(--muted); font-size: 12px; line-height: 1.7; }
    .air-memory-desc b { color: var(--text); }
    .air-memory-desc code { padding: 1px 5px; border: 1px solid var(--line); border-radius: 5px;
      background: var(--bg-soft); font-family: var(--mono); font-size: 11px; }
    #mem-graph-wrap{display:flex;flex-direction:column;gap:12px}
    #mem-graph-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    #mem-graph-toolbar select{background:var(--bg-soft,#161b22);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:var(--mono);max-width:280px}
    #mem-graph-meta{font-family:var(--mono);font-size:11px;color:var(--faint)}
    #mem-graph-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted);align-items:center}
    #mem-graph-legend .lg{display:inline-flex;align-items:center;gap:5px}
    #mem-graph-legend .sw{width:11px;height:11px;border-radius:50%;display:inline-block}
    #mem-graph-canvas{position:relative;width:100%;height:min(70vh,640px);min-height:420px;
      background:radial-gradient(circle at 50% 40%,rgba(58,214,197,.05),transparent 70%),var(--bg,#0d1117);
      border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:grab}
    #mem-graph-canvas.panning{cursor:grabbing}
    #mem-graph-svg{width:100%;height:100%;display:block;touch-action:none;user-select:none}
    #mem-graph-svg text{pointer-events:none;font-family:var(--mono);fill:var(--text)}
    #mem-graph-svg .mem-node{cursor:pointer}
    #mem-graph-svg .mem-node circle{transition:stroke-width .1s,filter .1s}
    #mem-graph-svg .mem-node:hover circle{stroke:#fff;stroke-width:2.5px}
    #mem-graph-svg .mem-node:hover text{opacity:1}
    #mem-graph-svg .mem-edge{stroke:var(--line);stroke-opacity:.55}
    #mem-graph-svg .mem-node.dim,#mem-graph-svg .mem-edge.dim{opacity:.12}
    #mem-graph-empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
      flex-direction:column;gap:8px;color:var(--faint);font-size:13px;text-align:center;padding:24px}
    #mem-graph-hint{position:absolute;left:12px;bottom:10px;font-size:10px;color:var(--faint);
      font-family:var(--mono);pointer-events:none;background:rgba(0,0,0,.25);padding:3px 8px;border-radius:6px}
    .mem-zoom-btns{position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;gap:6px}
    .mem-zoom-btns button{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);
      background:var(--bg-soft,#161b22);color:var(--text);cursor:pointer;font-size:15px;line-height:1}
    .mem-zoom-btns button:hover{background:var(--accent-dim,#12312d)}
    #mem-node-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:16000;display:none;align-items:center;justify-content:center}
    #mem-node-modal.open{display:flex}
    #mem-node-card{background:var(--bg-soft,#161b22);border:1px solid var(--line);border-radius:12px;
      width:min(92vw,560px);max-height:80vh;overflow:auto;padding:18px 20px}
    #mem-node-card h3{color:var(--text);font-size:15px;margin:0 0 4px;word-break:break-word}
    #mem-node-card .mn-slug{font-family:var(--mono);font-size:11px;color:var(--faint);margin-bottom:12px;word-break:break-all}
    #mem-node-card .mn-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    #mem-node-card .mn-tag{font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.06);color:var(--muted)}
    #mem-node-card .mn-summary{color:var(--text);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--bg,#0d1117);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:12px}
    #mem-node-card .mn-links h4{color:var(--muted);font-size:11px;margin:10px 0 6px;font-weight:600}
    #mem-node-card .mn-link{display:block;width:100%;text-align:left;font-size:12px;padding:6px 9px;margin-bottom:4px;border-radius:6px;border:1px solid var(--line);background:var(--bg,#0d1117);color:var(--text);cursor:pointer;font-family:var(--mono);word-break:break-word}
    #mem-node-card .mn-link:hover{border-color:var(--accent)}
    #mem-node-card .mn-close{float:right;background:transparent;border:0;color:var(--faint);font-size:20px;cursor:pointer;line-height:1}
    /* ── node modal: storage location + tokens + edit ── */
    #mem-node-meta{margin:2px 0 12px;display:flex;flex-direction:column;gap:6px}
    #mem-node-meta .mn-path-row{display:flex;align-items:center;gap:6px}
    #mem-node-meta code{font-family:var(--mono);font-size:11px;color:var(--muted);word-break:break-all;flex:1;background:var(--bg,#0d1117);border:1px solid var(--line);border-radius:6px;padding:5px 8px}
    #mem-node-meta .mn-icobtn{flex-shrink:0;background:var(--bg-soft,#161b22);border:1px solid var(--line);border-radius:6px;color:var(--muted);cursor:pointer;font-size:12px;padding:4px 8px;line-height:1}
    #mem-node-meta .mn-icobtn:hover{border-color:var(--accent);color:var(--text)}
    #mem-node-meta .mn-statrow{display:flex;gap:14px;align-items:center;font-size:11px;color:var(--muted);font-family:var(--mono)}
    #mem-node-meta .mn-statrow b{color:var(--text)}
    #mem-node-edit{background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:12px;padding:6px 12px;cursor:pointer}
    #mem-node-edit:hover{filter:brightness(1.08)}
    /* ── graph / tree tab switcher ── */
    #mem-tabs{display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--line)}
    #mem-tabs .mtab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--muted);cursor:pointer;font-size:13px;padding:8px 14px;margin-bottom:-1px}
    #mem-tabs .mtab:hover{color:var(--text)}
    #mem-tabs .mtab.active{color:var(--text);border-bottom-color:var(--accent,#3ad6c5);font-weight:600}
    /* ── tree view ── */
    #mem-tree-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
    #mem-tree-stats{font-family:var(--mono);font-size:11px;color:var(--faint)}
    #mem-tree{border:1px solid var(--line);border-radius:12px;background:var(--bg,#0d1117);padding:6px;max-height:min(72vh,680px);overflow:auto}
    #mem-tree .mt-empty{color:var(--faint);font-size:13px;text-align:center;padding:32px}
    #mem-tree .mt-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;user-select:none}
    #mem-tree .mt-row:hover{background:rgba(255,255,255,.04)}
    #mem-tree .mt-caret{display:inline-block;width:12px;color:var(--faint);font-size:10px;transition:transform .12s;flex-shrink:0}
    #mem-tree .mt-body{display:none;margin-left:14px;border-left:1px solid var(--line);padding-left:6px}
    #mem-tree .mt-body.open{display:block}
    #mem-tree .mt-proj-hdr strong{color:var(--text);font-size:13px}
    #mem-tree .mt-grp-hdr .mt-grp-label{color:var(--text);font-size:12px;font-weight:500}
    #mem-tree .mt-grp-shared .mt-grp-label{color:#e3b341}
    #mem-tree .mt-count{color:var(--faint);font-size:11px;font-family:var(--mono)}
    #mem-tree .mt-tok{margin-left:auto;color:var(--muted);font-size:11px;font-family:var(--mono);white-space:nowrap}
    #mem-tree .mt-tok .tokn{color:#3ad6c5}
    #mem-tree .mt-file{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer}
    #mem-tree .mt-file:hover{background:rgba(58,214,197,.08)}
    #mem-tree .mt-file .mt-fname{font-family:var(--mono);font-size:12px;color:var(--text);flex-shrink:0}
    #mem-tree .mt-file .mt-ftitle{font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
    #mem-tree .mt-file .mt-fpath{display:block;font-family:var(--mono);font-size:10px;color:var(--faint);opacity:.75;margin:0 0 4px 30px;word-break:break-all}
    #mem-tree .mt-file .mt-edit{flex-shrink:0;background:var(--bg-soft,#161b22);border:1px solid var(--line);border-radius:6px;color:var(--muted);cursor:pointer;font-size:11px;padding:3px 9px}
    #mem-tree .mt-file .mt-edit:hover{border-color:var(--accent);color:var(--text)}
    /* ── shared memory-file editor overlay ── */
    #mem-file-modal{position:fixed;inset:0;background:rgba(0,0,0,.66);z-index:16050;display:none;align-items:center;justify-content:center;padding:16px}
    #mem-file-modal.open{display:flex}
    #mem-file-card{background:var(--bg-soft,#161b22);border:1px solid var(--line);border-radius:12px;width:min(94vw,860px);max-height:90vh;display:flex;flex-direction:column;padding:16px 18px;gap:10px}
    #mem-file-card .mf-head{display:flex;align-items:center;gap:10px}
    #mem-file-card .mf-title{color:var(--text);font-size:14px;font-weight:600;font-family:var(--mono);word-break:break-all}
    #mem-file-card .mf-tok{margin-left:auto;font-size:11px;color:var(--muted);font-family:var(--mono);white-space:nowrap}
    #mem-file-card .mf-close{background:transparent;border:0;color:var(--faint);font-size:20px;cursor:pointer;line-height:1}
    #mem-file-card .mf-path{font-family:var(--mono);font-size:11px;color:var(--faint);word-break:break-all}
    #mem-file-card textarea{width:100%;flex:1;min-height:340px;background:var(--bg,#0d1117);border:1px solid var(--line);border-radius:8px;color:var(--text);font-size:13px;font-family:var(--mono);padding:12px;resize:vertical;line-height:1.5}
    #mem-file-card .mf-foot{display:flex;gap:8px;align-items:center;justify-content:flex-end}
    #mem-file-card .mf-msg{margin-right:auto;font-size:12px;color:var(--faint)}
    #mem-file-card .mf-btn{border:1px solid var(--line);border-radius:6px;font-size:13px;padding:6px 14px;cursor:pointer;background:var(--bg-soft,#21262d);color:var(--text)}
    #mem-file-card .mf-del{color:#f85149}
    #mem-file-card .mf-save{background:#238636;border-color:#2ea043;color:#fff}
  `;

  // 旧页那一格的 id 骨架，逐行照搬（public/manage.html 的记忆 section + 它在 view
  // 外面的两个弹窗）。两个弹窗按规矩画在面板根节点里 —— position:fixed 不挑位置，
  // 放在这儿才能在切走时跟着面板一起被清掉。data-i18n / data-i18n-title /
  // data-i18n-placeholder 由 i18n.js 的 applyI18n 统一翻（见 localize）；只有
  // 「自己写」的文案走 airMemory* 新 key，旧 markup 自带的 key（memoryGraph /
  // refresh / loading / close / delete）原样沿用。
  // 两段长说明（sec-desc）在旧页是一整句富文本（里面带 <b>/<code> 强调），而 i18n.js
  // 只有 [data-i18n]（写 textContent）、没有 -html 变体 —— 整句挂上去会把标签冲掉。
  // 所以按强调点切成若干 <span>/<b> 片段各自带 key：dom 结构没变、textContent 与
  // 旧页逐字相同，只是把「可翻译的边界」画出来了。
  const SKELETON = `
    <div class="sec-head air-memory-head">
      <h2 class="air-memory-title"><span data-i18n="memoryGraph">记忆图谱</span> <span id="mem-graph-count-pill" class="air-memory-pill"></span></h2>
      <div class="line"></div>
      <button class="btn btn-sm air-memory-btn" onclick="loadMemoryGraph(undefined, true)" data-i18n="refresh">刷新</button>
    </div>
    <div id="mem-tabs">
      <button class="mtab active" data-memtab="graph" onclick="setMemTab('graph')">🕸 <span data-i18n="airMemoryTabGraph">图谱</span></button>
      <button class="mtab" data-memtab="tree" onclick="setMemTab('tree')">🌳 <span data-i18n="airMemoryTabTree">树状</span></button>
    </div>
    <div id="mem-graph-pane">
      <p class="sec-desc air-memory-desc"><span data-i18n="airMemoryGraphDescLead">项目记忆系统的可视化网络：每个 </span><b data-i18n="airMemoryGraphDescNode">记忆节点</b><span data-i18n="airMemoryGraphDescMid">（.md 文件）显示标题与摘要，节点之间的 </span><code>[[wikilink]]</code><span data-i18n="airMemoryGraphDescLink"> 关联构成 </span><b data-i18n="airMemoryGraphDescEdge">有向边</b><span data-i18n="airMemoryGraphDescTail">（类型 reference，强度=引用次数）。点击节点看详情，空白处按住拖拽平移，滚轮缩放。</span></p>
      <div id="mem-graph-wrap">
        <div id="mem-graph-toolbar">
          <label style="font-size:12px;color:var(--muted)"><span data-i18n="airMemoryProjectLabel">项目</span>
            <select id="mem-graph-project" onchange="loadMemoryGraph(this.value)"></select>
          </label>
          <button class="btn btn-sm air-memory-btn" onclick="memGraphResetView()" data-i18n="airMemoryResetView">重置视图</button>
          <span id="mem-graph-meta"></span>
          <div style="flex:1"></div>
          <div id="mem-graph-legend"></div>
        </div>
        <div id="mem-graph-canvas">
          <svg id="mem-graph-svg"></svg>
          <div id="mem-graph-empty"></div>
          <div id="mem-graph-hint" data-i18n="airMemoryGraphHint">拖拽平移 · 滚轮缩放 · 点击节点看详情 · 拖动节点可固定</div>
          <div class="mem-zoom-btns">
            <button onclick="memGraphZoom(1.2)" title="放大" data-i18n-title="airMemoryZoomIn">＋</button>
            <button onclick="memGraphZoom(1/1.2)" title="缩小" data-i18n-title="airMemoryZoomOut">－</button>
            <button onclick="memGraphResetView()" title="重置" data-i18n-title="airMemoryZoomReset" style="font-size:12px">⊙</button>
          </div>
        </div>
      </div>
    </div><!-- /#mem-graph-pane -->
    <div id="mem-tree-pane" style="display:none">
      <p class="sec-desc air-memory-desc"><span data-i18n="airMemoryTreeDescLead">按 </span><b data-i18n="airMemoryTreeDescLevels">机器全局（_machine）/ CLI 特有（_cli）→ 项目 → 公共（_shared）/ 技能（skills）/ 任务（tasks）/ 会话（sessions）</b><span data-i18n="airMemoryTreeDescMid"> 五层瀑布梳理全部记忆文件。每个文件显示</span><b data-i18n="airMemoryNodePath">存放位置</b><span data-i18n="airMemoryTreeDescAnd">与</span><b data-i18n="airMemoryTreeDescTokens">估算 token 数</b><span data-i18n="airMemoryTreeDescTail">，点击可随时打开编辑。token 为无依赖估算（中文≈1.5/字，其余≈4字符/token），仅作体量参考。</span></p>
      <div id="mem-tree-toolbar">
        <span id="mem-tree-stats" data-i18n="loading">加载中…</span>
        <div style="flex:1"></div>
        <button class="btn btn-sm air-memory-btn" onclick="memTreeExpandAll(true)" data-i18n="airMemoryExpandAll">展开全部</button>
        <button class="btn btn-sm air-memory-btn" onclick="memTreeExpandAll(false)" data-i18n="airMemoryCollapseAll">折叠全部</button>
        <button class="btn btn-sm air-memory-btn" onclick="loadMemoryTree(true)" data-i18n="refresh">刷新</button>
      </div>
      <div id="mem-tree"><div class="mt-empty" data-i18n="loading">加载中…</div></div>
    </div>
    <div id="mem-node-modal" onclick="if(event.target===this)memNodeModalClose()">
      <div id="mem-node-card">
        <button class="mn-close" onclick="memNodeModalClose()" title="关闭" data-i18n-title="close">×</button>
        <h3 id="mem-node-title"></h3>
        <div class="mn-slug" id="mem-node-slug"></div>
        <div id="mem-node-meta">
          <div class="mn-path-row">
            <code id="mem-node-path" title="存放位置" data-i18n-title="airMemoryNodePath"></code>
            <button class="mn-icobtn" id="mem-node-copy" title="复制路径" data-i18n-title="airMemoryCopyPath">📋</button>
          </div>
          <div class="mn-statrow">
            <span><span data-i18n="airMemoryNodeTokens">📊 估算 tokens:</span> <b id="mem-node-tokens">–</b></span>
            <span><span data-i18n="airMemoryNodeSize">📦 大小:</span> <b id="mem-node-size">–</b></span>
            <button id="mem-node-edit" style="display:none" data-i18n="airMemoryOpenEditor">📝 打开编辑</button>
          </div>
        </div>
        <div class="mn-tags" id="mem-node-tags"></div>
        <div class="mn-summary" id="mem-node-summary"></div>
        <div class="mn-links" id="mem-node-links"></div>
      </div>
    </div>
    <div id="mem-file-modal" onclick="if(event.target===this)memFileEditorClose()">
      <div id="mem-file-card">
        <div class="mf-head">
          <span class="mf-title" id="mem-file-title"></span>
          <span class="mf-tok" id="mem-file-tok"></span>
          <button class="mf-close" onclick="memFileEditorClose()" title="关闭" data-i18n-title="close">×</button>
        </div>
        <div class="mf-path" id="mem-file-path"></div>
        <textarea id="mem-file-ta" spellcheck="false" placeholder="# 记忆内容…" data-i18n-placeholder="airMemoryFilePlaceholder"></textarea>
        <div class="mf-foot">
          <span class="mf-msg" id="mem-file-msg"></span>
          <button class="mf-btn mf-del" id="mem-file-del">🗑 <span data-i18n="delete">删除</span></button>
          <button class="mf-btn" onclick="memFileEditorClose()" data-i18n="close">关闭</button>
          <button class="mf-btn mf-save" id="mem-file-save" data-i18n="airMemorySave">保存 (⌘/Ctrl+Enter)</button>
        </div>
      </div>
    </div>
  `;

  // ── i18n ──────────────────────────────────────────────────────────────
  // applyI18n 是 i18n.js 的全局（跑一次就把作用域里所有 data-i18n* 翻掉）；它在
  // DOMContentLoaded 上只翻一次「当时在页面上的东西」，而这一页是懒渲染的，所以面板
  // 画完必须自己再翻一遍。i18n.js 万一没加载就退回手翻那三组属性。
  function localize(scope) {
    if (typeof root.applyI18n === 'function') { root.applyI18n(scope); return; }
    scope.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    scope.querySelectorAll('[data-i18n-title]').forEach(node => { node.title = t(node.dataset.i18nTitle); });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(node => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = src;
      node.onload = () => resolve();
      node.onerror = () => reject(new Error('memory module failed to load: ' + src));
      document.head.appendChild(node);
    });
  }

  // 只在第一次渲染时跑一次：按序重放 model / graph / controller。重放必须在面板骨架
  // 已经挂上之后（编辑器的按钮、画布都要在那时存在），所以它挂在这里而不是模块加载期。
  function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        for (const src of MEMORY_SCRIPTS) await loadScript(src);
      })();
    }
    return readyPromise;
  }

  // ── 骨架 / 渲染 ───────────────────────────────────────────────────────
  function build() {
    const node = make('section', null, 'admin-panel air-memory-panel');
    const style = make('style');
    style.textContent = STYLE;
    const holder = make('div');
    holder.innerHTML = SKELETON; // 固定字面量（无插值），ids 与旧页那一格完全一致
    node.append(style, ...holder.childNodes);
    localize(node);
    return node;
  }

  function currentTab() {
    const active = panel && panel.querySelector('#mem-tabs .mtab.active');
    return active && active.dataset.memtab === 'tree' ? 'tree' : 'graph';
  }

  function render(host, ctx) {
    context = ctx;
    if (!panel) panel = build();
    // 节点常驻：画布拖拽、树的点击委托、编辑器的保存/删除都绑在节点自己身上，
    // 重进这一页把同一个节点挂回去，那些绑定就都还在（不必反反复复重建 DOM）。
    host.replaceChildren(panel);
    // 两个模块的「已加载」标记挂在 window 上，不是挂在 DOM 上：换了 DOM 世代就得
    // 清掉，否则切到树状 tab 会因为标记还是 true 而一个请求都不发（空面板）。
    root.__memGraphLoaded = false;
    root.__memTreeLoaded = false;
    // 重放失败也让图谱自己去试一次：它会把失败画在画布/列表里（不用这里再报一次）。
    return ensureReady()
      .catch(() => { if (context && context.notice) context.notice(t('airMemoryModulesFailed')); })
      .then(() => window.loadMemoryGraph?.());
  }

  // 工具条那颗「刷新」：先让两个模块把缓存丢掉（图谱那边还负责停掉动画帧、
  // 标记要重画），再按当前 tab 重新拉一次。
  function refresh() {
    root.MultiCCMemoryGraph?.invalidate();
    root.MultiCCMemoryController?.invalidate();
    return ensureReady()
      .catch(() => { if (context && context.notice) context.notice(t('airMemoryModulesFailed')); })
      .then(() => (currentTab() === 'tree' ? window.loadMemoryTree?.(true) : window.loadMemoryGraph?.(undefined, true)));
  }

  root.MultiCCAirMemory = Object.freeze({ render, refresh });
})(typeof window !== 'undefined' ? window : null);
