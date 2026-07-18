'use strict';

// Memory tree and file-editor controller. Rendering is DOM-only; all requests
// and response whitelisting are delegated to MultiCCMemoryModel.
(function initMemoryController(root) {
  if (!root || !root.document || !root.MultiCCMemoryModel) return;
  const document = root.document;
  const model = root.MultiCCMemoryModel;
  const escapeHtml = model.escapeHtml;
  const formatSize = model.formatSize;
  function el(id) { return document.getElementById(id); }

  // ══════════════════════════════════════════════════════════════════════
  // 记忆树 · Memory Tree  (按 项目→公共/会话 层级梳理；显示位置、token、可编辑)
  // 复用同一记忆存储；数据来源 GET /api/memory/tree；文件读写走 /api/memory/file。
  // ══════════════════════════════════════════════════════════════════════

  // 与服务端 estimateMemTokens 保持一致：中文≈1.5 token/字，其余≈4 字符/token。
  // 仅用于编辑时的实时估算，服务端返回的 tokens 才是列表的权威值。
  function estTokens(str) {
    const s = String(str == null ? '' : str);
    if (!s.length) return 0;
    const cjk = (s.match(/[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/g) || []).length;
    return Math.max(1, Math.round(cjk * 1.5 + (s.length - cjk) / 4));
  }

  function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    } catch (_) {}
  }
  window.copyText = copyText;

  // ── 图谱 / 树状 tab 切换 ──────────────────────────────────────────────
  window.setMemTab = function (tab) {
    const isTree = tab === 'tree';
    const gp = el('mem-graph-pane'), tp = el('mem-tree-pane');
    if (gp) gp.style.display = isTree ? 'none' : '';
    if (tp) tp.style.display = isTree ? '' : 'none';
    document.querySelectorAll('#mem-tabs .mtab').forEach(b =>
      b.classList.toggle('active', b.dataset.memtab === tab));
    if (isTree && !window.__memTreeLoaded) {
      window.__memTreeLoaded = true;
      window.loadMemoryTree();
    } else if (!isTree && !window.__memGraphLoaded && typeof window.loadMemoryGraph === 'function') {
      // invalidate() marks the graph stale while preserving the last painted
      // frame. Reload as soon as the user returns to the graph tab.
      window.__memGraphLoaded = true;
      window.loadMemoryGraph();
    }
  };

  // ── 数据加载 + 渲染 ───────────────────────────────────────────────────
  let _treeData = null, _treeSeq = 0;
  window.loadMemoryTree = async function (forceRefetch) {
    const box = el('mem-tree');
    if (!box) { window.__memTreeLoaded = false; return; }
    if (_treeData && !forceRefetch) {
      renderTree(_treeData);
      window.__memTreeLoaded = true;
      return;
    }
    const seq = ++_treeSeq;
    box.innerHTML = '<div class="mt-empty">加载中…</div>';
    const statsEl = el('mem-tree-stats'); if (statsEl) statsEl.textContent = '加载中…';
    try {
      const data = await model.loadTree();
      if (seq !== _treeSeq) return; // 竞态：更晚的请求已发出
      _treeData = data;
      renderTree(data);
      window.__memTreeLoaded = true;
    } catch (e) {
      if (seq !== _treeSeq) return;
      window.__memTreeLoaded = false;
      box.innerHTML = '<div class="mt-empty">加载失败：' + escapeHtml(model.errorMessage(e)) + '</div>';
      if (statsEl) statsEl.textContent = '';
    }
  };

  function renderTree(data) {
    const box = el('mem-tree'); if (!box) return;
    const m = data.meta || {};
    const statsEl = el('mem-tree-stats');
    if (statsEl) {
      statsEl.textContent = `${m.projectCount || 0} 项目 · ${m.sessionCount || 0} 会话 · `
        + `${m.fileCount || 0} 文件 · 估算 ~${(m.tokenTotal || 0).toLocaleString()} tokens`
        + (m.truncated ? ` · 已截断至 ${m.maxFiles}` : '')
        + (m.durationMs != null ? ` · ${m.durationMs}ms` : '');
    }
    const projects = data.projects || [];
    if (!projects.length) { box.innerHTML = '<div class="mt-empty">暂无任何记忆文件。当会话把知识写进 memories/ 下的 .md 后，这里会出现层级。</div>'; return; }
    box.innerHTML = projects.map(renderProject).join('');
  }

  function tok(n) { return `<span class="mt-tok"><span class="tokn">~${(n || 0).toLocaleString()}</span> tok</span>`; }

  function renderProject(p) {
    const shared = (p.shared && p.shared.files && p.shared.files.length)
      ? renderGroup(p.shared, '公共记忆 (_shared)', 'shared', false) : '';
    const sessions = (p.sessions || [])
      .filter(s => s.files && s.files.length)
      .map(s => renderGroup(s, sessLabel(s), 'session', true)).join('');
    return `<div class="mt-proj" data-dirid="${escapeHtml(p.dirId)}">
      <div class="mt-row mt-proj-hdr" data-toggle>
        <span class="mt-caret">▶</span>
        <strong>${escapeHtml(p.name)}</strong>
        <span class="mt-count">${p.fileCount || 0} 文件 · ${(p.sessions || []).length} 会话</span>
        ${tok(p.tokens)}
      </div>
      <div class="mt-body">${shared}${sessions || '<div class="mt-empty" style="padding:10px">该项目暂无会话记忆</div>'}</div>
    </div>`;
  }

  function sessLabel(s) {
    const base = s.label && s.label !== s.sessionId ? `${s.label} · ${s.sessionId}` : s.sessionId;
    return (s.cli ? `[${s.cli}] ` : '') + base + (s.live ? '' : ' （离线）');
  }

  function renderGroup(g, label, kind, collapsed) {
    const files = (g.files || []).map(renderFileRow).join('');
    return `<div class="mt-grp mt-grp-${kind}">
      <div class="mt-row mt-grp-hdr" data-toggle>
        <span class="mt-caret">${collapsed ? '▶' : '▼'}</span>
        <span class="mt-grp-label">${escapeHtml(label)}</span>
        <span class="mt-count">${(g.files || []).length} 文件</span>
        ${tok(g.tokens)}
      </div>
      <div class="mt-body${collapsed ? '' : ' open'}">${files}</div>
    </div>`;
  }

  function renderFileRow(f) {
    return `<div class="mt-filewrap">
      <div class="mt-file" data-rel="${escapeHtml(f.rel)}" title="点击打开编辑">
        <span>📄</span>
        <span class="mt-fname">${escapeHtml(f.name)}</span>
        <span class="mt-ftitle">${escapeHtml(f.title || '')}</span>
        <span class="mt-tok"><span class="tokn">~${(f.tokens || 0).toLocaleString()}</span> tok · ${escapeHtml(formatSize(f.size))}</span>
        <button class="mt-edit" data-edit="${escapeHtml(f.rel)}">编辑</button>
      </div>
      <code class="mt-fpath" data-copy="${escapeHtml(f.path)}" title="点击复制路径">${escapeHtml(f.path)}</code>
    </div>`;
  }

  window.memTreeExpandAll = function (open) {
    document.querySelectorAll('#mem-tree .mt-body').forEach(b => b.classList.toggle('open', !!open));
    document.querySelectorAll('#mem-tree .mt-caret').forEach(c => { c.textContent = open ? '▼' : '▶'; });
  };

  // 事件委托：折叠/展开、打开编辑、复制路径。可能在 DOM 就绪前就调用，故做成
  // 幂等的具名函数，IIFE 期与 DOMContentLoaded 各调一次，谁先见到 #mem-tree 谁绑。
  function bindTree() {
    const box = el('mem-tree'); if (!box || box.__bound) return; box.__bound = true;
    box.addEventListener('click', (ev) => {
      const target = ev && ev.target;
      if (!target || typeof target.closest !== 'function') return;
      const editBtn = target.closest('[data-edit]');
      if (editBtn) { ev.stopPropagation(); openMemFileEditor(editBtn.dataset.edit); return; }
      const copyEl = target.closest('[data-copy]');
      if (copyEl) { ev.stopPropagation(); copyText(copyEl.dataset.copy); flashMsg(copyEl, '已复制'); return; }
      const file = target.closest('.mt-file');
      if (file && file.dataset.rel) { openMemFileEditor(file.dataset.rel); return; }
      const hdr = target.closest('[data-toggle]');
      if (hdr) {
        const body = hdr.nextElementSibling, caret = hdr.querySelector('.mt-caret');
        if (body && body.classList.contains('mt-body')) {
          const open = body.classList.toggle('open');
          if (caret) caret.textContent = open ? '▼' : '▶';
        }
      }
    });
  }
  bindTree();

  function flashMsg(anchorEl, text) {
    try {
      const old = anchorEl.textContent; anchorEl.textContent = text + ' ✓';
      setTimeout(() => { anchorEl.textContent = old; }, 900);
    } catch (_) {}
  }

  // ── 共享的记忆文件编辑器 ─────────────────────────────────────────────
  let _editRel = null, _editOrig = '', _fileReqSeq = 0, _mutationSeq = 0;
  let _editReadOnly = false, _editOriginalLength = 0, _editReadOnlyMessage = '';
  function setEditorReadOnly(readOnly, message) {
    _editReadOnly = !!readOnly;
    _editReadOnlyMessage = _editReadOnly ? String(message || '') : '';
    const ta = el('mem-file-ta'), save = el('mem-file-save');
    if (ta) ta.readOnly = _editReadOnly;
    if (save) save.disabled = _editReadOnly;
  }
  function oversizedFileMessage(originalLength) {
    const limit = model.MAX_FILE_CONTENT || 200000;
    return `⚠ 文件共有 ${originalLength} 字符，超过可安全编辑上限 ${limit}；`
      + `当前仅显示前 ${limit} 字符并已禁用保存，避免覆盖完整文件。`;
  }
  window.openMemFileEditor = async function (rel) {
    if (!rel) return;
    // 从图谱节点弹窗打开时，先关掉节点弹窗，避免叠层
    const nm = el('mem-node-modal'); if (nm) nm.classList.remove('open');
    const modal = el('mem-file-modal'); if (!modal) return;
    const title = el('mem-file-title'), pathEl = el('mem-file-path'), ta = el('mem-file-ta');
    const tokEl = el('mem-file-tok'), msgEl = el('mem-file-msg');
    if (!title || !pathEl || !ta || !tokEl || !msgEl) return;
    const seq = ++_fileReqSeq;
    // Opening a new editor generation invalidates every older save/delete,
    // including an operation for the same rel that is still in flight.
    _mutationSeq++;
    _editRel = rel;
    _editOrig = '';                       // 清掉上一个文件的基线，避免误判“有未保存改动”
    _editOriginalLength = 0;
    setEditorReadOnly(true, '文件仍在加载，暂不能保存。'); // 加载完成前禁止覆盖未知内容
    title.textContent = rel.split('/').pop();
    pathEl.textContent = '加载中… · ' + rel;
    ta.value = '';
    tokEl.textContent = '';
    msgEl.textContent = '';
    modal.classList.add('open');
    try {
      const d = await model.loadFile(rel);
      if (seq !== _fileReqSeq || _editRel !== rel) return;
      _editOrig = d.content || '';
      _editOriginalLength = Number(d.originalLength) || _editOrig.length;
      ta.value = _editOrig;
      pathEl.textContent = d.path || rel;
      updateEditorTok();
      if (d.readOnly || d.contentTruncated) {
        const message = oversizedFileMessage(_editOriginalLength);
        setEditorReadOnly(true, message);
        msgEl.textContent = message;
      } else {
        setEditorReadOnly(false);
      }
    } catch (e) {
      if (seq !== _fileReqSeq || _editRel !== rel) return;
      if (Number(e && e.status) === 404) {
        pathEl.textContent = '（文件不存在，保存后创建）· ' + rel;
        setEditorReadOnly(false);
        updateEditorTok();
        return;
      }
      msgEl.textContent = '读取失败：' + model.errorMessage(e);
      setEditorReadOnly(true, '文件读取失败，已禁用保存以避免覆盖未知内容。');
    }
  };
  window.memFileEditorClose = function () {
    const ta = el('mem-file-ta');
    if (ta && _editRel && ta.value !== _editOrig) {
      if (!confirm('有未保存的改动，确定关闭？')) return;
    }
    const m = el('mem-file-modal'); if (m) m.classList.remove('open');
    _fileReqSeq++;
    _mutationSeq++;
    _editRel = null; _editOrig = ''; _editOriginalLength = 0;
    setEditorReadOnly(false);
  };
  function updateEditorTok() {
    const ta = el('mem-file-ta'); const t = el('mem-file-tok');
    if (ta && t) t.textContent = '估算 ~' + estTokens(ta.value).toLocaleString() + ' tokens';
  }
  // 记忆增删后：图谱 + 树缓存全部失效，并立即刷新当前可见的那一面板（另一面板下次进入再拉）
  function afterMemChange() {
    if (root.MultiCCMemoryGraph) root.MultiCCMemoryGraph.invalidate();
    _treeData = null;
    const tp = el('mem-tree-pane'), gp = el('mem-graph-pane');
    if (tp && tp.style.display !== 'none') loadMemoryTree(true);
    else if (gp && gp.style.display !== 'none' && typeof window.loadMemoryGraph === 'function') window.loadMemoryGraph(undefined, true);
  }
  async function saveMemFile() {
    if (!_editRel) return;
    const rel = _editRel;
    const ta = el('mem-file-ta'), msg = el('mem-file-msg');
    if (!ta || !msg) return;
    if (_editReadOnly) {
      msg.textContent = _editReadOnlyMessage || '当前文件处于只读状态，不能保存。';
      return;
    }
    const content = ta.value;
    const seq = ++_mutationSeq;
    msg.textContent = '保存中…';
    try {
      const d = await model.saveFile(rel, content);
      if (seq !== _mutationSeq || _editRel !== rel) return;
      _editOrig = content;
      msg.textContent = '✓ 已保存 · ~' + (d.tokens || 0) + ' tokens';
      afterMemChange();
    } catch (e) {
      if (seq === _mutationSeq && _editRel === rel) msg.textContent = '保存失败：' + model.errorMessage(e);
    }
  }
  async function deleteMemFile() {
    if (!_editRel) return;
    const rel = _editRel;
    if (!confirm('删除记忆文件「' + rel.split('/').pop() + '」？不可恢复。')) return;
    const seq = ++_mutationSeq;
    try {
      await model.deleteFile(rel);
      if (seq !== _mutationSeq || _editRel !== rel) return;
      _editOrig = ''; _editRel = null; _editOriginalLength = 0;
      setEditorReadOnly(false);
      _fileReqSeq++;
      const m = el('mem-file-modal'); if (m) m.classList.remove('open');
      afterMemChange();
    } catch (e) {
      const msg = el('mem-file-msg');
      if (msg && seq === _mutationSeq && _editRel === rel) msg.textContent = '删除失败：' + model.errorMessage(e);
    }
  }
  document.addEventListener('DOMContentLoaded', wireEditor);
  if (document.readyState !== 'loading') wireEditor();
  function wireEditor() {
    const save = el('mem-file-save'), del = el('mem-file-del'), ta = el('mem-file-ta');
    if (save && !save.__b) { save.__b = 1; save.addEventListener('click', saveMemFile); }
    if (del && !del.__b) { del.__b = 1; del.addEventListener('click', deleteMemFile); }
    if (ta && !ta.__b) {
      ta.__b = 1;
      ta.addEventListener('input', updateEditorTok);
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveMemFile(); }
      });
    }
    bindTree(); // 兜底：首帧 DOM 可能晚于 IIFE 首次调用
    if (!document.__multiccMemoryEditorEscapeBound) {
      document.__multiccMemoryEditorEscapeBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && el('mem-file-modal') && el('mem-file-modal').classList.contains('open')) {
          window.memFileEditorClose();
        }
      });
    }
  }
  root.MultiCCMemoryController = Object.freeze({
    invalidate() { _treeData = null; _treeSeq++; root.__memTreeLoaded = false; },
  });
})(typeof window !== 'undefined' ? window : null);
