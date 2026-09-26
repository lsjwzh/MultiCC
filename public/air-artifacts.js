'use strict';

// ── 目录首页「本目录产物」（public/air-artifacts.js）──────────────────────
// 「服务与文档」面板（air-admin.js 的 docs 一栏）是跨目录的一览：它回答「这台机器
// 上有哪些产物」。目录首页要回答的是另一个问题 ——「我正看着的**这个**目录里有什么」。
// 所以入口就摆在目录工具条的「备忘」旁边，点开是本目录的产物清单：
// 永久保留（🔒）在最前，其次是置顶（📌），其余按最后生成时间倒序 —— 顺序是服务端
// 给的（GET /api/docs-registry?dir=…，见 src/docs-registry.js 的 byRetention），
// 这里不重排，只把 kind='service' 的行滤掉：服务是「跑着的东西」，归服务与文档那一格。
// 行上的两颗按钮与那格里的完全同义、各自独立：🔒 永久保留（唯一能免掉 7 天清理与
// 登记表淘汰的承诺）/ 📌 置顶（只改排序）。
//
// 这个模块不改 air.js 一个字节 —— 它自己找 #directory-memo、自己建面板、自己拉数据。
(function initAirArtifacts(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const locale = () => (typeof root.getLocale === 'function' ? root.getLocale() : undefined);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  let toggle = null;
  let panel = null;
  let listEl = null;
  let statusEl = null;
  // 面板当前装的是哪个目录的数据。目录一换（air.js 是 pushState 换的，不触发
  // popstate）这份就对不上了 —— 见下面 observers 里的判定。
  let renderedDirId = null;
  // 最近一次成功的列表。刷新失败时保留它，只在状态行说一句（同 task-artifacts.js）。
  let items = [];
  let dirPaths = null;
  let request = null;
  let generation = 0;
  let opened = false;

  const dirIdOf = () => new URLSearchParams(root.location.search).get('dir');

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  // 拉数据的写法与 public/task-artifacts.js 一致：AbortController + 超时 +
  // cache:'no-store'，同一个 URL 不会吃到中间缓存。
  async function fetchJson(url, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await root.fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  // 目录 id → 绝对路径。air.js 没有把这层映射暴露出来（它是 IIFE），所以自己拉一次
  // GET /api/air，然后按 id 找。映射按 session 缓存在模块上：换目录不重复拉。
  async function dirPathOf(dirId, signal) {
    if (dirPaths && dirPaths.has(dirId)) return dirPaths.get(dirId);
    const data = await fetchJson('/api/air', signal);
    dirPaths = new Map((data && data.directories ? data.directories : [])
      .filter(entry => entry && entry.id)
      .map(entry => [entry.id, entry.path || null]));
    return dirPaths.get(dirId) || null;
  }

  async function patchEntry(entry, body, noticeKey) {
    try {
      const response = await root.fetch(`/api/docs-registry/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus(noticeKey ? t(noticeKey) : '');
      await refresh();
    } catch (error) { setStatus(`⚠ ${error.message}`); }
  }

  function action(label, onclick) {
    const button = node('button', label);
    button.type = 'button';
    button.onclick = onclick;
    return button;
  }

  function renderRow(entry) {
    const row = node('li', null, `directory-artifact-row${entry.expired ? ' is-expired' : ''}`);
    // 与 air-admin.js 同一套字形：▤ 网页 / ⌑ 文件（服务不在这一格里）。
    row.append(node('span', entry.kind === 'file' ? '⌑' : '▤', 'directory-artifact-icon'));
    const copy = node('div', null, 'directory-artifact-copy');
    const link = node('a', entry.title || entry.url || t('airAdminUntitled'));
    link.href = entry.url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const created = entry.createdAt && !Number.isNaN(+new Date(entry.createdAt))
      ? new Date(entry.createdAt).toLocaleString(locale()) : '';
    const meta = [t(entry.kind === 'file' ? 'taskArtifactsFile' : 'taskArtifactsPage'), created, entry.url || ''].filter(Boolean).join(' · ');
    copy.append(link, node('small', meta));
    const tags = node('div', null, 'directory-artifact-tags');
    if (entry.permanent) tags.append(node('span', `🔒 ${t('artifactKeepForever')}`, 'air-doc-tag permanent'));
    if (entry.pinned) tags.append(node('span', t('airAdminPinned'), 'air-doc-tag pin'));
    if (entry.expired) tags.append(node('span', t('taskArtifactsExpired'), 'air-doc-tag expired'));
    const actions = node('div', null, 'directory-artifact-actions');
    actions.append(
      action(`${entry.permanent ? '🔒 ' : ''}${t(entry.permanent ? 'artifactKeepForeverOff' : 'artifactKeepForever')}`,
        () => patchEntry(entry, { permanent: !entry.permanent }, entry.permanent ? 'docsregPermanentOff' : 'docsregPermanentOn')),
      action(entry.pinned ? t('airAdminUnpin') : t('airAdminPinned'),
        () => patchEntry(entry, { pinned: !entry.pinned }, null)),
    );
    row.append(copy, tags, actions);
    return row;
  }

  function paint() {
    if (!listEl) return;
    listEl.replaceChildren(...items.map(renderRow));
    if (!items.length) listEl.append(node('li', t('airDirArtifactsEmpty'), 'directory-artifacts-empty'));
  }

  function ensurePanel() {
    if (panel) return;
    const worktrees = document.getElementById('directory-worktrees');
    const host = document.getElementById('empty');
    panel = node('section', null, 'directory-artifacts-panel');
    panel.id = 'directory-artifacts-panel';
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'directory-artifacts-heading');
    const head = node('div', null, 'section-heading');
    const heading = node('div');
    const caption = node('span', t('airCurrentDirectory'), 'caption');
    const title = node('strong', t('airDirArtifacts'));
    title.id = 'directory-artifacts-heading';
    heading.append(caption, title);
    head.append(heading);
    const hint = node('p', t('airDirArtifactsHint'));
    hint.id = 'directory-artifacts-hint';
    statusEl = node('p', '', null);
    statusEl.id = 'directory-artifacts-status';
    statusEl.setAttribute('role', 'status');
    statusEl.hidden = true;
    listEl = node('ul', null, 'directory-artifacts-list');
    listEl.id = 'directory-artifacts-list';
    // 服务留给「服务与文档」那一格：这里只给出到那里的门。与 task-artifacts.js 的
    // 「全部服务与文档 ↗」同一条链接。
    const manage = node('a', t('taskArtifactsManage'), 'directory-artifacts-manage');
    manage.href = '/manage?view=docs';
    panel.append(head, hint, statusEl, listEl, manage);
    // 内联区块（同 #directory-worktrees 那一段）：紧跟它后面，进不了 #empty 就作罢。
    if (worktrees && worktrees.parentElement) worktrees.after(panel);
    else if (host) host.append(panel);
  }

  async function refresh() {
    ensurePanel();
    const dirId = dirIdOf();
    if (!dirId) {
      renderedDirId = null;
      items = [];
      paint();
      setStatus('');
      return;
    }
    const current = ++generation;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const path = await dirPathOf(dirId, controller.signal);
      const entries = path ? await fetchJson(`/api/docs-registry?dir=${encodeURIComponent(path)}`, controller.signal) : [];
      // 只有「还是最新那一次刷新」才允许落盘：切目录 / 关面板会 ++generation 把
      // 在飞的这次作废，晚到的响应不能盖回旧目录的数据。
      if (current !== generation) return;
      renderedDirId = dirId;
      items = Array.isArray(entries) ? entries.filter(entry => entry && entry.kind !== 'service') : [];
      paint();
      setStatus('');
    } catch (error) {
      // 列表保留上一次的好数据，只在状态行说一句（同 task-artifacts.js 的失败处理）。
      if (current === generation) setStatus(t('airAdminLoadFailed', { message: error.message }));
    } finally { if (request === controller) request = null; }
  }

  function setOpen(value) {
    opened = value;
    if (!opened) {
      if (panel) panel.hidden = true;
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    ensurePanel();
    panel.hidden = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    void refresh();
  }

  function mount() {
    const memo = document.getElementById('directory-memo');
    if (!memo || !memo.parentElement || document.getElementById('directory-artifacts')) return;
    toggle = node('button', null, null);
    toggle.type = 'button';
    toggle.id = 'directory-artifacts';
    toggle.setAttribute('data-i18n-title', 'airDirArtifactsOpen');
    toggle.setAttribute('data-i18n-aria-label', 'airDirArtifactsOpen');
    toggle.title = t('airDirArtifactsOpen');
    toggle.setAttribute('aria-label', t('airDirArtifactsOpen'));
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'directory-artifacts-panel');
    const glyph = node('span', '📦');
    glyph.setAttribute('aria-hidden', 'true');
    // data-i18n 挂在内层标签上，不挂按钮：applyI18n() 给带 data-i18n 的元素写
    // textContent，挂在按钮上会把前面的图标一起冲掉。目录工具条里「新终端」那颗
    // （air.html 的 #directory-terminal-new）就是这么分的。
    const label = node('span', t('airDirArtifacts'));
    label.setAttribute('data-i18n', 'airDirArtifacts');
    toggle.append(glyph, document.createTextNode(' '), label);
    toggle.onclick = () => setOpen(!opened);
    memo.after(toggle);

    // 为什么这里要看 DOM 而不是在 air.js 里加一行：public/air.js 卡在行数棘轮的
    // 天花板上（scripts/check-source-line-budget.js 里登记的高水位就是它当前的行数，
    // 加一行即红），所以入口的显隐只能从外面接。air.js 每次渲染都会写
    // `$('directory-memo').hidden`（没目录 / 不在任务视图 / 选中了某条任务时为 true），
    // 产物入口要跟备忘入口一模一样地出现和消失 —— 盯住这个属性就够了，不轮询。
    // 顺带盯 #directory-name 的文本：air.js 换目录走 history.pushState（不触发
    // popstate），但每次渲染都会重写侧栏那个目录名，所以「名字被重写」就是「可能
    // 换了目录」。开着面板时发现目录 id 跟面板里装的那份对不上就收起来 ——
    // 留着上一个目录的产物比收起来更容易看错。
    const observer = new root.MutationObserver(() => {
      if (!toggle) return;
      const memoNow = document.getElementById('directory-memo');
      toggle.hidden = !memoNow || memoNow.hidden;
      if (toggle.hidden) { setOpen(false); return; }
      if (opened && renderedDirId && renderedDirId !== dirIdOf()) { renderedDirId = null; setOpen(false); }
    });
    observer.observe(memo, { attributes: true, attributeFilter: ['hidden'] });
    const name = document.getElementById('directory-name');
    if (name) observer.observe(name, { childList: true, characterData: true, subtree: true });
    // 首次同步：脚本在 air.js 之前解析，那时 #directory-memo 还是 HTML 里的初始
    // 可见状态，等 air.js 第一次渲染会补一次 mutation，但这一次不能省
    // —— 目录页以外的路径（比如 /air?view=docs）本来就不该露出这个入口。
    toggle.hidden = memo.hidden;

    // 浏览器前进 / 后退与锚点跳转都会换目录（air.js 自己监听这两个事件重画）。
    for (const event of ['popstate', 'hashchange']) root.addEventListener(event, () => {
      renderedDirId = null;
      setOpen(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})(typeof window !== 'undefined' ? window : null);
