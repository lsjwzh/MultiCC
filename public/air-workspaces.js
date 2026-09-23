'use strict';

// Air 原生「工作区」面板 —— worktree 休眠回收的看板（原生 DOM，不再嵌旧 manage 页）。
// 后端契约见 src/routes/workspaces.js：
//   GET  /api/workspaces/overview        → { status, totals, directories, removedIgnoredAudit, orphans }
//   POST /api/workspaces/sweep[?orphans=1] → { ok, sweep, orphans }
//
// 这一格是最后一个还嵌着 /manage.html 的设置格，搬过来之后旧管理台整页就可以删了。
// 搬的是骨架不是像素：旧页那四张卡全靠内联 style 撑（它自己没有卡片以外的词表），
// 这里改成 Air 的 .admin-panel + 模块自带的一小段样式，颜色只用 Air v2 的词表。
//
// 两条规矩跟旧页不一样，是这次刻意改的：
//   ① 文案全部走 t()。旧页的中文是硬写的，搬进 Air 之后会立刻进 test-air-i18n-cdp
//      的扫描面 —— 漏一句就是英文模式下露一句中文。
//   ② 「清扫」是会真的删东西的动作（被 .gitignore 忽略的未知文件会被删掉并留审计），
//      所以按钮按下去期间要按住、并把结果原样写在按钮旁边，不靠 toast —— 面板重绘
//      之后 toast 早没了，而这一格的人恰恰是回来看「上次扫了什么」的。
(function initAirWorkspaces(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  let context = null;
  let styleNode = null;

  function injectStyle(host) {
    if (!styleNode) {
      styleNode = document.createElement('style');
      styleNode.textContent = `
        .air-ws-body { display: grid; gap: 7px; }
        .air-ws-line { color: var(--muted); font-size: 12px; line-height: 1.6; }
        .air-ws-line b { color: #2f536f; font-weight: 650; }
        /* 路径和分支名是要被逐字比对的东西（跟 ahead/dirty 一起决定敢不敢删），
           所以用等宽字体，且长路径必须能断行而不是把卡片撑出去。 */
        .air-ws-path { color: var(--text); font-family: var(--mono, monospace); font-size: 11.5px;
          overflow-wrap: anywhere; }
        .air-ws-sub { color: var(--faint); font-size: 10.5px; line-height: 1.6; overflow-wrap: anywhere; }
        .air-ws-item { display: grid; gap: 2px; }
        .air-ws-item + .air-ws-item { padding-top: 6px; border-top: 1px solid var(--hairline); }
        .air-ws-entry { padding-left: 12px; color: var(--faint); font-family: var(--mono, monospace);
          font-size: 10.5px; overflow-wrap: anywhere; }
        .air-ws-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 4px; }
        .air-ws-foot button { min-height: 32px; padding: 5px 11px; font-size: 11px; }
        .air-ws-status { min-width: 0; color: var(--faint); font-size: 10.5px; overflow-wrap: anywhere; }
        .air-ws-status.ok { color: #2f7d52; }
        .air-ws-status.err { color: #b34b34; }
        .air-ws-warn { color: #b34b34; font-weight: 650; }
        .air-ws-gone { color: #2f7d52; }
      `;
    }
    host.append(styleNode); // replaceChildren 会把它一起清掉，每次重绘都挂回去
  }

  function card(titleText, bodyId, eyebrow) {
    const panel = make('section', null, 'admin-panel');
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', eyebrow, 'eyebrow'), make('h3', titleText));
    head.append(title);
    const body = make('div', null, 'air-ws-body');
    body.id = bodyId;
    panel.append(head, body);
    return panel;
  }

  // ── 格式化 ─────────────────────────────────────────────────────────────
  function fmtTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // 阈值是给人判断「我的会话大概还能活多久」用的，所以跨过一小时就换成小时 ——
  // 「90 分钟」不如「1.5 小时」好估。0 / 负数在后端表示这条闸门关掉了。
  function fmtIdle(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return t('airWorkspacesIdleOff');
    const hours = ms / 3600000;
    if (hours >= 1) return t('airWorkspacesHours', { n: hours % 1 ? hours.toFixed(1) : String(hours) });
    return t('airWorkspacesMinutes', { n: String(Math.round(ms / 60000)) });
  }

  function sweeperState(status) {
    if (status.sweeping) return t('airWorkspacesSweeperBusy');
    if (status.stopped) return t('airWorkspacesSweeperStopped');
    return status.scheduled ? t('airWorkspacesSweeperOn') : t('airWorkspacesSweeperOff');
  }

  // ── 四块内容 ───────────────────────────────────────────────────────────
  function renderSummary(data) {
    const host = el('air-ws-summary');
    if (!host) return;
    const status = data.status || {};
    const rows = [
      [t('airWorkspacesTotalsAwake'), String(data.totals?.awake ?? 0),
        t('airWorkspacesTotalsAsleep'), String(data.totals?.hibernated ?? 0)],
      [t('airWorkspacesBudgetLabel'), status.awakeLimit ? String(status.awakeLimit) : t('airWorkspacesUnlimited'),
        t('airWorkspacesIdleLabel'), fmtIdle(status.idleMs)],
      [t('airWorkspacesSweeperLabel'), sweeperState(status), '', ''],
    ];
    const lines = rows.map(([labelA, valueA, labelB, valueB]) => {
      const line = make('div', null, 'air-ws-line');
      line.append(labelA, make('b', valueA));
      if (labelB) line.append(` · ${labelB}`, make('b', valueB));
      return line;
    });
    host.replaceChildren(...lines, sweepFoot());
  }

  // 两个清扫按钮画在概览卡里，不进工具条：工具条只放「离开这一页」和「重读一次」
  // （同其它原生面板），而清扫是会删文件的动作，得跟它的结果贴在一起。
  function sweepFoot() {
    const foot = make('div', null, 'air-ws-foot');
    const sweep = make('button', t('airWorkspacesSweepNow'));
    sweep.type = 'button';
    sweep.id = 'air-ws-sweep';
    sweep.onclick = () => { void runSweep(false); };
    const both = make('button', t('airWorkspacesSweepOrphans'));
    both.type = 'button';
    both.id = 'air-ws-sweep-orphans';
    both.title = t('airWorkspacesSweepOrphansHint');
    both.onclick = () => { void runSweep(true); };
    const status = make('span', '', 'air-ws-status');
    status.id = 'air-ws-sweep-status';
    foot.append(sweep, both, status);
    return foot;
  }

  function renderDirs(data) {
    const host = el('air-ws-dirs');
    if (!host) return;
    const dirs = data.directories || [];
    if (!dirs.length) return host.replaceChildren(make('p', t('airWorkspacesNoDirs'), 'admin-empty'));
    const limit = data.status?.awakeLimit;
    host.replaceChildren(...dirs.map(dir => {
      const item = make('div', null, 'air-ws-item');
      const path = make('div', dir.path, 'air-ws-path');
      // 超预算只标出来、不在这里给动作：真正的处置（休眠谁）是清扫器按 LRU 决定的，
      // 面板替它挑一个反而会让两套规则打架。
      if (limit && dir.awake > limit) path.append(' ', make('span', t('airWorkspacesOverBudget'), 'air-ws-warn'));
      const parts = [t('airWorkspacesDirAwake', { n: String(dir.awake) }),
        t('airWorkspacesDirAsleep', { n: String(dir.hibernated) })];
      if (dir.planned) parts.push(t('airWorkspacesDirPlanned', { n: String(dir.planned) }));
      if (dir.transitioning) parts.push(t('airWorkspacesDirMoving', { n: String(dir.transitioning) }));
      parts.push(t('airWorkspacesDirTotal', { n: String(dir.total) }));
      item.append(path, make('div', parts.join(' · '), 'air-ws-sub'));
      return item;
    }));
  }

  function renderOrphans(data) {
    const host = el('air-ws-orphans');
    if (!host) return;
    const report = data.orphans;
    if (!report) return host.replaceChildren(make('p', t('airWorkspacesOrphansNever'), 'admin-empty'));
    const head = make('div', null, 'air-ws-sub');
    head.textContent = t('airWorkspacesOrphansHead', { at: fmtTime(report.at), n: String(report.total) })
      + ' · ' + (report.deleteOrphans
        ? t('airWorkspacesOrphansDeleted', { n: String(report.removed) })
        : t('airWorkspacesOrphansReportOnly'));
    if (!report.total) return host.replaceChildren(head);
    host.replaceChildren(head, ...(report.orphans || []).map(orphan => {
      const item = make('div', null, 'air-ws-item');
      const sub = make('div', null, 'air-ws-sub');
      sub.append([
        t('airWorkspacesOrphanBranch', { branch: orphan.branch || t('airWorkspacesDetached') }),
        t('airWorkspacesOrphanAhead', { n: String(orphan.ahead) }),
        orphan.dirty ? t('airWorkspacesDirty') : t('airWorkspacesClean'),
      ].join(' · ') + ' · ');
      sub.append(orphan.removed
        ? make('span', t('airWorkspacesOrphanRemoved'), 'air-ws-gone')
        : make('span', t('airWorkspacesOrphanKept')));
      item.append(make('div', orphan.path, 'air-ws-path'), sub);
      return item;
    }));
  }

  function renderAudit(data) {
    const host = el('air-ws-audit');
    if (!host) return;
    const list = data.removedIgnoredAudit || [];
    if (!list.length) return host.replaceChildren(make('p', t('airWorkspacesAuditNone'), 'admin-empty'));
    host.replaceChildren(...list.map(record => {
      const item = make('div', null, 'air-ws-item');
      const head = make('div', null, 'air-ws-line');
      head.append(record.title || record.sessionId, ' ', make('span', fmtTime(record.at), 'air-ws-sub'));
      item.append(head);
      for (const entry of record.entries || []) {
        const bits = [entry.path];
        if (entry.files != null) {
          bits.push(entry.truncated
            ? t('airWorkspacesAuditDirCut', { n: String(entry.files) })
            : t('airWorkspacesAuditDir', { n: String(entry.files) }));
        }
        if (entry.bytes != null) bits.push(fmtBytes(entry.bytes));
        item.append(make('div', bits.join(' · '), 'air-ws-entry'));
      }
      return item;
    }));
  }

  // ── 读与写 ─────────────────────────────────────────────────────────────
  // 一次请求画四块：四块本来就是同一份 overview 的四个切片，拆成四次请求只会让它们
  // 互相对不上（清扫刚跑完时尤其明显）。读失败就四块一起说同一句话。
  async function load() {
    const hosts = ['air-ws-summary', 'air-ws-dirs', 'air-ws-orphans', 'air-ws-audit'];
    try {
      const data = await context.api('/api/workspaces/overview');
      renderSummary(data); renderDirs(data); renderOrphans(data); renderAudit(data);
    } catch (error) {
      const message = t('airWorkspacesLoadFailed', { message: error?.message || String(error) });
      for (const id of hosts) el(id)?.replaceChildren(make('p', message, 'admin-empty error'));
    }
  }

  async function runSweep(withOrphans) {
    const buttons = [el('air-ws-sweep'), el('air-ws-sweep-orphans')].filter(Boolean);
    const status = el('air-ws-sweep-status');
    if (!status) return;
    // 两个按钮一起按住：清扫是有副作用的，重入会让第二次跑在第一次的半截状态上。
    for (const button of buttons) button.disabled = true;
    status.textContent = t('airWorkspacesSweeping');
    status.className = 'air-ws-status';
    try {
      const data = await context.api(
        `/api/workspaces/sweep${withOrphans ? '?orphans=1' : ''}`, undefined, 'POST');
      const sweep = data?.sweep || {};
      status.textContent = t('airWorkspacesSweepDone', {
        considered: String(sweep.considered || 0),
        hibernated: String(sweep.hibernated ?? sweep.results?.length ?? 0),
        budget: String(sweep.budget?.hibernated || 0),
      });
      status.className = 'air-ws-status ok';
    } catch (error) {
      status.textContent = t('airWorkspacesSweepFailed', { message: error?.message || String(error) });
      status.className = 'air-ws-status err';
      return; // 失败时不复读：四块还是清扫前那份，重画一遍只会把这句话冲掉
    } finally {
      for (const button of buttons) button.disabled = false;
    }
    // 成功之后必须复读：刚休眠掉的会话就在这四块里，不复读等于让人看着过期的数字。
    // 但 renderSummary 会重建整条按钮行，所以那句结果要在重画之后补回去。
    const done = status.textContent;
    await load();
    const after = el('air-ws-sweep-status');
    if (after) { after.textContent = done; after.className = 'air-ws-status ok'; }
  }

  function render(host, ctx) {
    context = ctx;
    host.replaceChildren(
      card(t('airWorkspacesOverview'), 'air-ws-summary', t('airWorkspacesEyebrowState')),
      card(t('airWorkspacesDirsTitle'), 'air-ws-dirs', t('airWorkspacesEyebrowDirs')),
      card(t('airWorkspacesOrphansTitle'), 'air-ws-orphans', t('airWorkspacesEyebrowOrphans')),
      card(t('airWorkspacesAuditTitle'), 'air-ws-audit', t('airWorkspacesEyebrowAudit')),
    );
    injectStyle(host);
    return load();
  }

  root.MultiCCAirWorkspaces = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
