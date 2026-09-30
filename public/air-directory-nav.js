'use strict';
// 目录的两件「秒切」小事，放在一起是因为它们读的是同一份目录清单：
//
//   · 拖拽排序：控制台「工作目录」那一栏的行可以拖着换顺序。顺序存在服务端
//     （PUT /api/directories/order —— directories.json 本身就是有序数组，服务端
//     按新顺序重排登记表），所以换设备、换浏览器、⌘K、目录库看到的都是同一个顺序。
//     松手那一刻先就地改快照里的顺序（界面不回弹），再写服务端，失败就提示并重拉。
//   · 左上角目录卡 hover 侧拉：鼠标停在侧栏那张目录卡上，旁边滑出全部目录的清单，
//     点一下就切过去，不用先开 ⌘K 或目录库。只在有真悬停的指针上启用（触屏没有
//     hover，一碰就会和「点卡片进目录首页」打架）。
//
// 为什么是独立文件：air.js 贴着行数闸门（scripts/check-source-line-budget.js），
// 这里跟 air-directory-mode.js 一样，只让 air.js 在 render 里递一份上下文进来。
(function initAirDirectoryNav(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);

  let ctx = null;

  // 把快照里的目录就地排成 ids 的顺序：服务端回来之前，再 render 一次也不会弹回去。
  function applyLocalOrder(data, ids) {
    const list = data && Array.isArray(data.directories) ? data.directories : null;
    if (!list) return;
    const rank = new Map(ids.map((id, index) => [id, index]));
    const tail = ids.length;
    list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : tail) - (rank.has(b.id) ? rank.get(b.id) : tail));
  }

  async function commitOrder(context, ids) {
    applyLocalOrder(context.data, ids);
    try {
      await context.api('/api/directories/order', { ids }, 'PUT');
    } catch (error) {
      context.notice?.(translate('airDirReorderFailed', { error: error.message }));
    }
    // 成功失败都重拉一次：成功时拿到服务端的定稿，失败时把本地乐观顺序纠正回去。
    await context.refresh?.();
  }

  // 让 list 里带 data-dir-id 的行可以拖着换位。每次 render 都会造一份新列表，
  // 所以这里不做去重登记，直接在新元素上挂。
  function sortable(list, context, rowSelector = '[data-dir-id]') {
    if (!list || !context || typeof context.api !== 'function') return;
    const order = () => [...list.querySelectorAll(rowSelector)].map(row => row.dataset.dirId);
    let dragging = null;
    let before = '';
    for (const row of list.querySelectorAll(rowSelector)) {
      row.draggable = true;
      row.title = translate('airDirDragHint');
      row.addEventListener('dragstart', event => {
        dragging = row;
        before = order().join(',');
        row.classList.add('is-dragging');
        list.classList.add('is-sorting');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          try { event.dataTransfer.setData('text/plain', row.dataset.dirId); } catch (_) { /* Safari 偶尔拒绝 */ }
        }
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('is-dragging');
        list.classList.remove('is-sorting');
        const moved = dragging;
        dragging = null;
        // 拖的中途快照刷新把整栏重画了：这份旧列表已不在页面上，它的顺序不作数。
        if (!moved || !list.isConnected) return;
        const ids = order();
        if (ids.join(',') !== before) void commitOrder(context, ids);
      });
    }
    list.addEventListener('dragover', event => {
      if (!dragging) return;
      event.preventDefault();
      const over = event.target && event.target.closest ? event.target.closest(rowSelector) : null;
      if (!over || over === dragging || !list.contains(over)) return;
      const box = over.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      list.insertBefore(dragging, after ? over.nextSibling : over);
    });
    list.addEventListener('drop', event => { if (dragging) event.preventDefault(); });
  }

  // ── 左上角目录卡的 hover 侧拉 ──
  const canHover = () => !root.matchMedia || root.matchMedia('(hover: hover) and (pointer: fine)').matches;
  let flyout = null;
  let hideTimer = null;
  let boundCard = null;

  function hideFlyout() {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (flyout) flyout.hidden = true;
  }
  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hideFlyout, 180); };

  function ensureFlyout() {
    if (flyout) return flyout;
    flyout = node('nav', null, 'directory-flyout');
    flyout.id = 'directory-flyout';
    flyout.hidden = true;
    flyout.setAttribute('aria-label', translate('airDirSwitchHeading'));
    flyout.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    flyout.addEventListener('mouseleave', scheduleHide);
    document.body.append(flyout);
    return flyout;
  }

  function paintFlyout(card) {
    const context = ctx;
    const directories = context?.data?.directories || [];
    // 只有一个目录时没什么可切的，别凭空弹一层。
    if (directories.length < 2) return false;
    const panel = ensureFlyout();
    const list = node('div', null, 'directory-flyout-list');
    for (const directory of directories) {
      const row = node('button', null, 'directory-flyout-row');
      row.type = 'button';
      row.dataset.dirId = directory.id;
      if (directory.id === context.directoryId) {
        row.classList.add('is-current');
        row.setAttribute('aria-current', 'true');
      }
      row.append(node('strong', directory.name || directory.id), node('small', directory.path || ''));
      row.onclick = () => {
        hideFlyout();
        if (directory.id !== context.directoryId) context.navigate?.(directory.id);
      };
      list.append(row);
    }
    // 侧拉里也能拖着排：和控制台那一栏写的是同一份服务端顺序。
    sortable(list, context);
    panel.replaceChildren(node('span', translate('airDirSwitchHeading'), 'directory-flyout-title'), list);
    const box = card.getBoundingClientRect();
    panel.style.left = `${Math.round(box.right + 8)}px`;
    panel.style.top = `${Math.round(box.top)}px`;
    panel.style.maxHeight = `${Math.max(160, Math.round(root.innerHeight - box.top - 16))}px`;
    panel.hidden = false;
    return true;
  }

  function bindCard() {
    const card = document.querySelector('#sidebar .space-card') || document.querySelector('.space-card');
    if (!card || card === boundCard) return;
    boundCard = card;
    card.addEventListener('mouseenter', () => {
      if (!canHover()) return;
      clearTimeout(hideTimer);
      paintFlyout(card);
    });
    card.addEventListener('mouseleave', scheduleHide);
    // 点卡片本身（进目录首页）或按 Esc 时收起，别挡着新页面。
    card.addEventListener('click', hideFlyout);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideFlyout(); });
  }

  // air.js 每次 render 递进来：快照、当前目录、api、notice、refresh、navigate。
  function render(context) {
    if (context) ctx = context;
    bindCard();
    // 侧拉开着时快照变了（别处新增/改名/排序）：就地重画，跟着最新清单走。
    if (flyout && !flyout.hidden && boundCard && !flyout.querySelector('.is-dragging')) paintFlyout(boundCard);
  }

  root.MultiCCAirDirectoryNav = { render, sortable, hideFlyout, _applyLocalOrder: applyLocalOrder };
})(typeof window !== 'undefined' ? window : null);
