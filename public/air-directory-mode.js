'use strict';
// 目录首页顶部那道 Chat / Terminal 切换（`air.html` 的 `#directory-mode`）。
//
// 「Terminal 放到各个目录里面、摆在前面，可以和 chat 互相切换，但两类不混在一起，
// 默认还是 chat」——这一句就是本模块的全部职责：
//   · 状态只有一份：当前是 chat 还是 terminal。它跟着**目录**走 —— 换目录、重新
//     打开 /air 都回到 chat（默认模式不该被上一次的选择记住）；
//   · 一次只显示一类：终端模式给 `#empty` 打上 `is-terminal-mode`，air.css 那条
//     规则把 Chat 那一整块（统计卡 / 最近任务 / Git / 新任务输入框）让开，
//     终端那一块上场。不是「排在一起换个位置」，是互相让位；
//   · 终端那份清单按 `dirId` 滤（服务端 `/api/air` 的 `sessions` 已经只给
//     terminal-kind，这里再按目录收一次 —— 和 App 的 `terminalSessionsOf` 同一条
//     判据）。点一行去那个终端页（`/?id=<sessionId>`，旧侧栏那一组用的同一个地址）。
//
// 为什么是独立文件：air.js 本身贴着 3000 行的行数闸门（`scripts/check-source-line-
// budget.js`），一个模块只加一行 render 调用比往主文件里塞一百行 DOM 逻辑稳。
(function initAirDirectoryMode(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  // i18n 由 i18n.js 提供；它没加载（单页/旧壳）时退回 key，不至于把界面打空。
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);

  let mode = 'chat';
  let dirId = null;
  let ctx = null;
  let creating = false;

  // air.js 每次 render 递进来的一份上下文（同 air-admin.js 的 render(mode, ctx)）：
  // 快照、当前目录、当前任务、api、notice 以及「最近用过的那套 CLI」。
  function render(context) {
    if (context) ctx = context;
    if (!ctx) return;
    const next = ctx.directoryId || null;
    // 换目录 = 回到 chat。同一个目录里的轮询刷新（每 4s）不会重置模式。
    if (next !== dirId) {
      dirId = next;
      mode = 'chat';
    }
    const empty = el('empty');
    // 打开着任务时整页被对话浮层盖着，这道切换照旧留在下面那一层 —— 不隐藏，
    // 关掉浮层回到目录页时它还是原来那个状态（默认 chat）。
    empty?.classList.toggle('is-terminal-mode', mode === 'terminal');
    paintSwitch();
    paintTerminals();
  }

  function paintSwitch() {
    for (const [name, button] of [['chat', el('directory-mode-chat')], ['terminal', el('directory-mode-terminal')]]) {
      if (!button) continue;
      button.setAttribute('aria-selected', String(mode === name));
    }
  }

  // 刚删掉的那些先在本机记一笔：`ctx.data` 是上一次快照，删完不等下一次轮询就把这一行
  // 抹掉，数字也跟着变。快照回头自然不会再带它们。
  const removed = new Set();

  function terminations() {
    const sessions = ctx?.data?.sessions || [];
    return sessions.filter(session => (session.kind || 'terminal') === 'terminal'
      && session.dirId === dirId && !removed.has(session.id));
  }

  function paintTerminals() {
    const list = el('directory-terminal-list');
    if (!list) return;
    const sessions = terminations();
    const count = el('directory-terminal-count');
    if (count) count.textContent = translate('airTerminalsCount', { n: sessions.length });
    if (!sessions.length) {
      // 空的是「这个目录还没开过终端」，不是这一页坏了 —— 任务在另一侧，切回
      // Chat 就在（两边读的是同一份快照，谁也不吃掉谁）。
      list.replaceChildren(node('p', translate('airTerminalsEmpty'), 'directory-terminal-empty'));
      return;
    }
    // 一行 = 打开那条终端的链接 + 一颗删除。删除按钮不能放进 <a> 里（嵌套可交互元素
    // 是无效 HTML，点删除会跟着跳走），所以外层是 div、里面两件并排 —— 和目录任务行
    // （`directory-task-row`）同一种结构，样式也复用 `.task-delete`。
    list.replaceChildren(...sessions.map(session => {
      const label = session.label || session.id;
      const row = node('div', null, 'directory-terminal-row');
      const link = node('a', null, 'directory-terminal-open');
      link.href = `/?id=${encodeURIComponent(session.id)}`;
      link.append(
        node('span', '›_', 'directory-terminal-mark'),
        node('strong', label),
        node('small', session.cli || ''),
      );
      const remove = node('button', translate('delete'), 'task-delete danger');
      remove.type = 'button';
      remove.dataset.action = 'delete-terminal';
      remove.setAttribute('aria-label', translate('airDeleteTerminalAria', { label }));
      remove.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        void removeTerminal(session, remove);
      };
      row.append(link, remove);
      return row;
    }));
  }

  // 删一条终端会话（`DELETE /api/sessions/:id`）。worktree 里还有未提交改动 / 未合入
  // 的提交时，服务端默认拒绝（409 + reasons），这时再问一次「仍然删除？」，同意才带
  // force 重来 —— 和目录任务行那条删除一个规矩（`deleteTaskById`）。
  async function removeTerminal(session, button) {
    if (!ctx || !session?.id) return;
    const label = session.label || session.id;
    if (!root.confirm(translate('airDeleteTerminalConfirm', { label }))) return;
    const path = `/api/sessions/${encodeURIComponent(session.id)}`;
    if (button) button.disabled = true;
    try {
      try {
        await ctx.api(path, undefined, 'DELETE');
      } catch (error) {
        const reasons = new Set([error?.code, error?.message, ...(error?.reasons || [])]);
        const findings = [
          ...(reasons.has('dirty') ? [translate('airDeleteRiskDirty')] : []),
          ...(reasons.has('unmerged') ? [translate('airDeleteRiskUnmerged')] : []),
        ];
        if (!findings.length || !root.confirm(translate('airDeleteTerminalRiskConfirm', { label, findings: findings.join('\n') }))) {
          ctx.notice?.(translate('airTerminalDeleteFailed', { error: error?.message || error }));
          return;
        }
        await ctx.api(path, { force: true }, 'DELETE');
      }
      removed.add(session.id);
      paintTerminals();
      ctx.notice?.(translate('airTerminalDeleted'));
    } catch (error) {
      ctx.notice?.(translate('airTerminalDeleteFailed', { error: error?.message || error }));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function setMode(next) {
    if (next !== 'chat' && next !== 'terminal') return;
    mode = next;
    render();
  }

  // 可选的 CLI：快照里服务端认的那一份（`/api/air` 的 `clis`）。实验车道不进
  // ——那些是 chat 专用的适配器（app-server / Agent SDK），不是给人用的交互式终端。
  function terminalClis() {
    return [...new Set((ctx?.data?.clis || [])
      .map(cli => String(cli || ''))
      .filter(cli => cli && !cli.endsWith('-exp')))];
  }

  function recentCli() { return String(ctx?.defaultCli?.() || ''); }

  // 「＋ 新终端」：**和 chat 的「AI 配置」是同一个对话框**（`air-task-settings.js` 的
  // `configuration(entry, clis, onApply)`，draft 模式）—— CLI、Provider、模型、推理
  // 强度都在那一层挑。用户明确要求终端要能像 chat 一样选线路，不是只挑一个 CLI；
  // 所以这里不再自己长一套选择 UI，把「选什么」交给那一份唯一实现。
  function openCreateDialog() {
    if (creating || !dirId || !ctx) return;
    const settings = root.MultiCCAirSettings;
    if (!settings?.configuration) return;
    const clis = terminalClis();
    settings.configuration(
      {
        // purpose 让那一层把抬头/说明换成终端口吻（同一份实现，只是不说「新任务」）。
        purpose: 'terminal',
        task: { title: translate('airNewTerminal') },
        // 打开时的默认值 = 这个目录最近用过的那套（和 chat 那颗胶囊同一个口径），
        // 但对话框里每一项都能改。
        configuration: { ...(ctx.data?.lastRuntime || {}), cli: recentCli() || clis[0] || 'claude' },
      },
      clis,
      runtime => void create(runtime),
    );
  }

  // 本目录新建终端：POST /api/directories/:id/sessions（kind=terminal）。建好直接去
  // 那个终端页，回来的路是浏览器后退 —— 和点一行已有终端是同一种跳转。
  async function create(runtime) {
    const button = el('directory-terminal-new');
    if (creating || !dirId || !ctx) return;
    const cli = String(runtime?.cli || '');
    if (!cli) return;
    creating = true;
    if (button) button.disabled = true;
    try {
      // 终端行的名字把 CLI 与模型写进去：列表里一眼看得出这一条是拿什么起的。
      // 「没选」的字段一律不发明文空串（服务端把 '' 当「显式不指定」，和省略不是
      // 一回事），所以逐项按需带上。
      const label = [cli, runtime.model || null].filter(Boolean).join(' · ');
      const session = await ctx.api(`/api/directories/${encodeURIComponent(dirId)}/sessions`, {
        cli, kind: 'terminal', label,
        ...(runtime.provider ? { provider: runtime.provider } : {}),
        ...(runtime.providerSelection ? { providerSelection: runtime.providerSelection } : {}),
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(runtime.effort ? { effort: runtime.effort } : {}),
      });
      root.location.assign(`/?id=${encodeURIComponent(session.id)}`);
    } catch (error) {
      ctx.notice?.(translate('airTerminalCreateFailed', { error: error?.message || error }));
    } finally {
      creating = false;
      if (button) button.disabled = false;
    }
  }

  el('directory-mode-chat')?.addEventListener('click', () => setMode('chat'));
  el('directory-mode-terminal')?.addEventListener('click', () => setMode('terminal'));
  el('directory-terminal-new')?.addEventListener('click', openCreateDialog);

  root.MultiCCAirDirectoryMode = { render, setMode, currentMode: () => mode };
})(typeof window !== 'undefined' ? window : null);
