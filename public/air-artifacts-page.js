'use strict';

// ── 本目录产物（public/artifacts.html 的逻辑，public/air-artifacts-page.js）──────
// 目录首页那颗「本目录产物」按钮 window.open 打开的**一页**（同 /memo.html?dirId=…）。
// 以前这份清单是嵌在目录页里的一块（#directory-artifacts-panel）：展开会把
// 「最近任务 / Git / 新任务输入框」整段往下推，而它要回答的是「这个目录里生成出了
// 什么」—— 本来就该有自己的地址，可以单独开着、单独刷新、单独留在后台。
// App 那边也是独立一页（app/lib/screens/directory_artifacts_screen.dart），这里是 Web 的同一件事。
//
// 数据与那一格完全同源：GET /api/docs-registry?dir=<绝对路径>。顺序是服务端给的
// （永久保留 → 置顶 → 最后生成时间，见 src/docs-registry.js 的 byRetention），
// 这里不重排，只把 kind='service' 的行滤掉 —— 服务是「跑着的东西」，归「服务与文档」，
// 那一格在管理端（/manage?view=docs），页面右上角留了一扇门过去。
// 行上两颗按钮各发各的 PATCH，互不影响：🔒 permanent（唯一免掉 7 天清理与登记表
// 淘汰的承诺）/ 📌 pinned（只改排序）。
//
// 目录 id → 绝对路径：目录首页在 URL 里带的是 id（?dir=d1）。页面可以直接收
// ?dir=<绝对路径>（书签、外部链接、测试都用得上），没有才回落到 GET /api/air 查表。
(function initDirectoryArtifactsPage(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const locale = () => (typeof root.getLocale === 'function' ? root.getLocale() : undefined);
  const el = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  const params = new URLSearchParams(root.location.search);
  const dirId = params.get('dirId') || '';
  const givenPath = params.get('dir') || '';

  const listEl = el('artifacts-list');
  const statusEl = el('artifacts-status');
  const workspaceEl = el('artifacts-workspace');
  const headingEl = el('artifacts-heading');
  const refreshBtn = el('artifacts-refresh');

  // 最近一次成功的列表：刷新失败时留着它，只在状态行说一句（同 task-artifacts.js）。
  let items = [];
  // 渲染签名：轮询每 20 秒跑一次，内容没变就不重画 —— 重画会把键盘焦点和滚动位置
  // 一起冲掉（这一页是要在上面点按钮的）。
  let painted = null;
  let request = null;
  let generation = 0;
  let timer = null;
  let stopped = false;

  function setStatus(key, params) {
    if (!statusEl) return;
    const text = key ? t(key, params) : '';
    statusEl.textContent = text;
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

  // 目录 id → 绝对路径，顺带把目录名写进标题（开着好几个产物页时分得清是哪一个）。
  async function resolvePath(signal) {
    if (givenPath) return givenPath;
    if (!dirId) return null;
    const data = await fetchJson('/api/air', signal);
    const entry = (data && data.directories ? data.directories : [])
      .find(item => item && item.id === dirId);
    if (!entry) return null;
    const label = [entry.name, entry.path].filter(Boolean).join(' · ');
    if (workspaceEl) workspaceEl.textContent = label;
    if (headingEl) headingEl.title = label;
    document.title = `📦 ${entry.name || entry.id} · MultiCC`;
    return entry.path || null;
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
      // 先刷新再报信：refresh() 自己会清状态行，先写的那句提示会当场被抹掉。
      if (await refresh()) setStatus(noticeKey);
    } catch (error) {
      // 失败的提示是给人和模型都看的：HTTP 状态码原样留着（同 task-artifacts.js）。
      if (statusEl) {
        statusEl.textContent = `⚠ ${error.message}`;
        statusEl.hidden = false;
      }
    }
  }

  function action(label, onclick) {
    const button = node('button', label);
    button.type = 'button';
    button.onclick = onclick;
    return button;
  }

  function renderRow(entry) {
    const row = node('li', null, `directory-artifact-row${entry.expired ? ' is-expired' : ''}`);
    // 与 air-admin.js 同一套字形：▤ 网页 / ⌑ 文件（服务不在这一页）。
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

  function signature() {
    return items.map(entry => [entry.id, entry.title, entry.permanent, entry.pinned, entry.expired].join('\u0000')).join('\u0001');
  }

  function paint() {
    if (!listEl) return;
    listEl.replaceChildren(...items.map(renderRow));
    if (!items.length) listEl.append(node('li', t('airDirArtifactsEmpty'), 'directory-artifacts-empty'));
    painted = signature();
  }

  // 返回值是「这次刷新真的落盘了」：调用方（PATCH 之后）要据此决定要不要报那句话。
  async function refresh() {
    if (!listEl) return false;
    const current = ++generation;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const path = await resolvePath(controller.signal);
      const entries = path ? await fetchJson(`/api/docs-registry?dir=${encodeURIComponent(path)}`, controller.signal) : [];
      // 只有「还是最新那一次刷新」才允许落盘：重复点刷新会 ++generation 把在飞的
      // 那次作废，晚到的响应不能盖回旧数据。
      if (current !== generation) return false;
      items = Array.isArray(entries) ? entries.filter(entry => entry && entry.kind !== 'service') : [];
      if (signature() !== painted) paint();
      // 目录 id 查不到路径（目录被删了 / 链接是从别处抄来的）：空列表配一句话，
      // 别只留一片白。
      setStatus(path ? null : 'airUnknownDirectory');
      return true;
    } catch (error) {
      // 列表保留上一次的好数据，只在状态行说一句（同 task-artifacts.js 的失败处理）。
      if (current === generation) setStatus('airAdminLoadFailed', { message: error.message });
      return false;
    } finally { if (request === controller) request = null; }
  }

  // 20 秒轮询，只在标签页可见时跑：这一页可能被晾在后台（产物是被别处的任务写出来的，
  // 不轮询就得自己按刷新）。页面藏起来就停，重新可见时立刻补一次。
  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      if (!document.hidden) await refresh();
      schedule();
    }, 20000);
  }

  refreshBtn?.addEventListener('click', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });

  // auth-client.js 可能正在拿 URL 里的 ?token= 换 cookie（异步）：它把这件事挂在
  // window.multiccAuthReady 上，等它落地再发第一个请求，免得第一拉吃 401
  // （同 memo.html 的写法；没有 auth-client 时它就是个已兑现的 undefined）。
  const boot = () => Promise.resolve(root.multiccAuthReady).then(() => refresh()).then(schedule);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void boot(); }, { once: true });
  } else {
    void boot();
  }
  root.addEventListener('beforeunload', () => { stopped = true; clearTimeout(timer); request?.abort(); });
})(typeof window !== 'undefined' ? window : null);
