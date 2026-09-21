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

  function terminations() {
    const sessions = ctx?.data?.sessions || [];
    return sessions.filter(session => (session.kind || 'terminal') === 'terminal' && session.dirId === dirId);
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
    list.replaceChildren(...sessions.map(session => {
      const link = node('a', null, 'directory-terminal-row');
      link.href = `/?id=${encodeURIComponent(session.id)}`;
      link.append(
        node('span', '›_', 'directory-terminal-mark'),
        node('strong', session.label || session.id),
        node('small', session.cli || ''),
      );
      return link;
    }));
  }

  function setMode(next) {
    if (next !== 'chat' && next !== 'terminal') return;
    mode = next;
    render();
  }

  // 本目录新建终端：POST /api/directories/:id/sessions（kind=terminal），CLI 用
  // 「最近用过的那套」（外壳那颗新任务输入框的同一个默认）。建好直接去那个终端页，
  // 回来的路是浏览器后退 —— 和点一行已有终端是同一种跳转。
  async function create() {
    const button = el('directory-terminal-new');
    if (creating || !dirId || !ctx) return;
    const preferred = ctx.defaultCli?.();
    const cli = [preferred, ...(ctx.data?.clis || []), 'claude'].find(value => value && value !== 'codex-exp');
    creating = true;
    if (button) button.disabled = true;
    try {
      const session = await ctx.api(`/api/directories/${encodeURIComponent(dirId)}/sessions`,
        { cli, kind: 'terminal', label: cli });
      root.location.assign(`/?id=${encodeURIComponent(session.id)}`);
    } catch (error) {
      ctx.notice?.(`新建终端失败：${error?.message || error}`);
    } finally {
      creating = false;
      if (button) button.disabled = false;
    }
  }

  el('directory-mode-chat')?.addEventListener('click', () => setMode('chat'));
  el('directory-mode-terminal')?.addEventListener('click', () => setMode('terminal'));
  el('directory-terminal-new')?.addEventListener('click', () => void create());

  root.MultiCCAirDirectoryMode = { render, setMode, currentMode: () => mode };
})(typeof window !== 'undefined' ? window : null);
