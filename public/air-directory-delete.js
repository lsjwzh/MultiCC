'use strict';

// ── 目录首页「删除工作区」入口（public/air-directory-delete.js）──────────────
// 工作区（= 登记在 directories.json 里的一条目录）过去只能加、不能删：设置页和
// 目录页都没有出口，想摘掉一个项目只能手工改状态文件。这个模块补的就是那一颗。
//
// 入口摆在目录工具条里、「本目录定时任务」后面（最右）。它删的是**登记**，不是
// 磁盘上的项目文件夹 —— 服务端 `DELETE /api/directories/:id` 只移除目录记录，
// 并级联销毁它名下的会话与 worktree（repo.save + sessions.destroyCascade）；
// 目录本身留在原处，所以确认文案必须把这两件事分开说清。
//
// 为什么又是独立模块、不改 air.js：public/air.js 卡在行数棘轮的天花板上
// （scripts/check-source-line-budget.js 登记的就是它当前的行数），加一行即红。
// 入口的显隐也只能从外面接：air.js 每次渲染都会写 `$('directory-memo').hidden`
// （没目录 / 不在任务视图 / 选中了某条任务时为 true），跟着它走即可，不轮询。
//
// 删除是两步确认：先问「删这个工作区？」；如果目录下还有会话，服务端会回 400 并
// 带 `sessions`，此时再问一次「连着 N 个会话一起删？」，第二次才带 force。第一次
// 失败且没有会话（或别的错）就停在那里，不自动强删。
(function initAirDirectoryDelete(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  let toggle = null;
  let busy = false;
  const dirIdOf = () => new URLSearchParams(root.location.search).get('dir');

  async function request(path, method = 'GET') {
    const response = await root.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; } catch (_) {
      throw Object.assign(new Error(t('airErrBadResponse', { status: response.status })), { status: response.status });
    }
    if (!response.ok || result.ok === false) {
      throw Object.assign(
        new Error(result.message || result.error || result.code || `HTTP ${response.status}`),
        result,
      );
    }
    return result;
  }

  async function currentDirectory() {
    const id = dirIdOf();
    if (!id) return null;
    const list = await request('/api/directories');
    const records = Array.isArray(list) ? list : [];
    return records.find(item => item && String(item.id) === id) || null;
  }

  function returnToLibrary() {
    // 被删掉的正是地址栏里那个 dir：留在原地只会看到一页空目录。air.js 的
    // popstate 处理函数就是「从地址栏重读一遍再渲染」，所以写同样的地址再派一次
    // popstate（同 air-dir-schedules.js 的做法），不整页重载。
    const url = root.MultiCCMachineScope?.navigation('/air?view=directories') || '/air?view=directories';
    if (typeof root.PopStateEvent !== 'function') { root.location.assign(url); return; }
    root.history.pushState({}, '', url);
    root.dispatchEvent(new root.PopStateEvent('popstate'));
  }

  // 两步确认的删除本体：目录卡片底栏的「快速删除」也走这里（air-directory-card.js），
  // 所以从 remove() 里抽出来导出。返回是否真的删了（用户取消 = false）。
  async function deleteDirectory(directory) {
    if (!directory) { root.alert(t('airDirDeleteMissing')); return false; }
    const name = directory.name || directory.path || directory.id;
    if (!root.confirm(t('airDirDeleteConfirm', { name }))) return false;
    const path = `/api/directories/${encodeURIComponent(directory.id)}`;
    try {
      await request(path, 'DELETE');
    } catch (error) {
      const count = Array.isArray(error.sessions) ? error.sessions.length : 0;
      if (!count) throw error;
      if (!root.confirm(t('airDirDeleteSessionsConfirm', { name, n: count }))) return false;
      await request(`${path}?force=1`, 'DELETE');
    }
    return true;
  }

  async function remove() {
    if (busy) return;
    busy = true;
    if (toggle) toggle.disabled = true;
    try {
      if (await deleteDirectory(await currentDirectory())) returnToLibrary();
    } catch (error) {
      root.alert(t('airDirDeleteFailed', { message: error?.message || String(error) }));
    } finally {
      busy = false;
      if (toggle) toggle.disabled = false;
    }
  }

  function mount() {
    const memo = document.getElementById('directory-memo');
    if (!memo || !memo.parentElement || document.getElementById('directory-delete')) return;
    toggle = node('button', null, 'directory-delete');
    toggle.type = 'button';
    toggle.id = 'directory-delete';
    toggle.setAttribute('data-i18n-title', 'airDirDelete');
    toggle.setAttribute('data-i18n-aria-label', 'airDirDelete');
    toggle.title = t('airDirDelete');
    toggle.setAttribute('aria-label', t('airDirDelete'));
    const glyph = node('span', '🗑');
    glyph.setAttribute('aria-hidden', 'true');
    // data-i18n 挂内层，不挂按钮：applyI18n() 会用 textContent 整个覆盖，挂在
    // 按钮上会把前面的图标一起冲掉（同 #directory-artifacts）。
    const label = node('span', t('airDirDelete'));
    label.setAttribute('data-i18n', 'airDirDelete');
    toggle.append(glyph, document.createTextNode(' '), label);
    toggle.onclick = () => void remove();
    const previous = document.getElementById('directory-schedules')
      || document.getElementById('directory-artifacts')
      || memo;
    previous.after(toggle);

    const observer = new root.MutationObserver(() => {
      if (!toggle) return;
      const memoNow = document.getElementById('directory-memo');
      toggle.hidden = !memoNow || memoNow.hidden;
    });
    observer.observe(memo, { attributes: true, attributeFilter: ['hidden'] });
    toggle.hidden = memo.hidden;
  }

  root.MultiCCAirDirectoryDelete = { deleteDirectory };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})(typeof window !== 'undefined' ? window : null);
