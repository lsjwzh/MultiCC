'use strict';

// /manage「工作区」面板 — worktree 休眠回收的前端。
// 后端见 src/routes/workspaces.js（GET /api/workspaces/overview、POST /api/workspaces/sweep）。
// 独立文件而非 manage.js：manage.js 是 migration-debt 棘轮文件，只减不增。

(function initWorkspacesView() {
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return;
  const api = window.MultiCCApi;
  const qs = typeof tokenQS === 'function' ? tokenQS : () => '';
  const notify = (msg, isError) => { if (typeof showToast === 'function') showToast(msg, isError); };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtIdleMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '已禁用';
    const h = ms / 3600000;
    return h >= 1 ? `${h % 1 ? h.toFixed(1) : h} 小时` : `${Math.round(ms / 60000)} 分钟`;
  }

  function renderSummary(data) {
    const el = document.getElementById('ws-summary');
    if (!el) return;
    const st = data.status || {};
    const rows = [
      `活跃 worktree：<b>${data.totals.awake}</b> · 已休眠：<b>${data.totals.hibernated}</b>`,
      `每目录活跃预算：<b>${st.awakeLimit || '不限'}</b> · 闲置阈值：<b>${esc(fmtIdleMs(st.idleMs))}</b>`,
      `清扫器：${st.stopped ? '已停止' : st.scheduled ? '运行中' : '未调度'}${st.sweeping ? '（正在清扫…）' : ''}`,
    ];
    el.innerHTML = rows.map(r => `<div style="font-size:13px;">${r}</div>`).join('');
    const cnt = document.getElementById('ws-count');
    if (cnt) cnt.textContent = `(活跃 ${data.totals.awake} / 休眠 ${data.totals.hibernated})`;
  }

  function renderDirs(data) {
    const el = document.getElementById('ws-dirs');
    if (!el) return;
    if (!data.directories.length) {
      el.innerHTML = '<div style="color:var(--faint);font-size:13px;">还没有带会话的工作目录。</div>';
      return;
    }
    el.innerHTML = data.directories.map(d => {
      const over = data.status?.awakeLimit && d.awake > data.status.awakeLimit;
      const flag = over ? ' <span style="color:#e5534b;">超预算</span>' : '';
      return `<div style="font-size:12px;font-family:var(--mono);">` +
        `<span style="color:var(--text);">${esc(d.path)}</span>${flag}<br>` +
        `<span style="color:var(--faint);">活跃 ${d.awake} · 休眠 ${d.hibernated}` +
        (d.planned ? ` · 待建 ${d.planned}` : '') + (d.transitioning ? ` · 迁移中 ${d.transitioning}` : '') +
        ` · 共 ${d.total}</span></div>`;
    }).join('');
  }

  function renderOrphans(data) {
    const el = document.getElementById('ws-orphans');
    if (!el) return;
    const report = data.orphans;
    if (!report) {
      el.innerHTML = '<div style="color:var(--faint);font-size:13px;">尚未对账（启动 45 秒后自动跑第一次，之后每天一次；也可点「清扫＋孤儿对账」）。</div>';
      return;
    }
    const head = `<div style="font-size:12px;color:var(--faint);">上次对账 ${esc(fmtTime(report.at))} · 发现 ${report.total} 个孤儿` +
      (report.deleteOrphans ? ` · 已删除 ${report.removed} 个（删除模式）` : ' · 报告模式（MULTICC_WORKTREE_ORPHAN_DELETE=1 可开删除）') + '</div>';
    if (!report.total) { el.innerHTML = head; return; }
    el.innerHTML = head + report.orphans.map(o =>
      `<div style="font-size:12px;font-family:var(--mono);">${esc(o.path)}<br>` +
      `<span style="color:var(--faint);">分支 ${esc(o.branch || '(detached)')} · 领先基线 ${o.ahead} 提交 · ${o.dirty ? '有未提交改动' : '干净'} · ` +
      (o.removed ? '<span style="color:#3fb950;">已删除</span>' : '保留') + `</span></div>`).join('');
  }

  function renderAudit(data) {
    const el = document.getElementById('ws-audit');
    if (!el) return;
    const list = data.removedIgnoredAudit || [];
    if (!list.length) {
      el.innerHTML = '<div style="color:var(--faint);font-size:13px;">还没有发生过忽略文件删除。</div>';
      return;
    }
    el.innerHTML = list.map(item => {
      const entries = (item.entries || []).map(e =>
        `<div style="font-size:11px;font-family:var(--mono);color:var(--faint);padding-left:12px;">` +
        `${esc(e.path)}${e.files != null ? `（目录，${e.files} 个文件${e.truncated ? '，已截断' : ''}）` : ''}` +
        `${e.bytes != null ? ` · ${fmtBytes(e.bytes)}` : ''}</div>`).join('');
      return `<div style="font-size:12px;"><span style="color:var(--text);">${esc(item.title || item.sessionId)}</span> ` +
        `<span style="color:var(--faint);">${esc(fmtTime(item.at))}</span></div>${entries}`;
    }).join('');
  }

  async function loadWorkspacePanel() {
    try {
      const data = await api.json('/api/workspaces/overview' + qs('?'));
      renderSummary(data); renderDirs(data); renderOrphans(data); renderAudit(data);
    } catch (err) {
      notify('工作区概览加载失败: ' + (err?.message || err), true);
    }
  }

  async function runWorkspaceSweep(withOrphans) {
    try {
      notify('清扫中…');
      const data = await api.json(`/api/workspaces/sweep${withOrphans ? '?orphans=1' : qs('?')}`, { method: 'POST' });
      const b = data.sweep || {};
      notify(`清扫完成：候选 ${b.considered || 0}，休眠 ${b.hibernated ?? b.results?.length ?? 0}，预算额外休眠 ${b.budget?.hibernated || 0}`);
      await loadWorkspacePanel();
    } catch (err) {
      notify('清扫失败: ' + (err?.message || err), true);
    }
  }

  window.loadWorkspacePanel = loadWorkspacePanel;
  window.runWorkspaceSweep = runWorkspaceSweep;
})();
