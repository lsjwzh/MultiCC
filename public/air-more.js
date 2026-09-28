'use strict';

// The drawer owns only its presentation. Existing setting and host-operation
// controllers retain their nodes, requests and navigation handlers.
//
// 二级联动也归这里。一级是抽屉自己（常用设置 / 设置 / 主机），二级是「设置」那段
// 里选中那个分组的面板清单 —— 设置中心那一页的十六个面板各有一行，不必先跳进去
// 再点一次。两种摆法是**同一份 DOM**：
//   两列联动（指针 + 够宽）：二级住在 #more-flyout 那一列，一次只显示选中的一组；
//   就地折叠（窄屏 / 触屏）：把那一组整个搬回它父行下面，父行变成展开/收起。
// 之所以搬节点而不是各写一份：两份 DOM 会让「点哪一行去哪个页面」有两个答案，
// 也会让 air.js 的 [data-air-view] 接线接到两份上去。
(function (root) {
  const document = root.document;
  const panel = document.getElementById('more-panel');
  const trigger = document.getElementById('side-more');
  const status = document.getElementById('more-status');
  const flyout = document.getElementById('more-flyout');
  const flyoutTitle = document.getElementById('more-flyout-title');
  const flyoutNote = document.getElementById('more-flyout-note');
  const flyoutBody = flyout.querySelector('.more-flyout-body');
  const tree = document.getElementById('settings-tree');
  // 分组的顺序就是一级列出来的顺序（air.html 里那张表的顺序），所以只认 DOM 顺序，
  // 不在 JS 里再抄一份组名表 —— 抄一份就会和 air-admin.js 的 settingGroups 漂移。
  const parents = [...tree.querySelectorAll('.more-parent')];
  const groups = new Map(parents.map(row => [row.dataset.moreGroup, document.getElementById('more-group-' + row.dataset.moreGroup)]));
  // 断点必须和 air-more.css 里那条 @media 是同一个数字：CSS 决定长什么样，这里
  // 决定节点挂在哪，两处对不上就会出现「右边空着、内容在左边叠着」的中间态。
  const cascade = root.matchMedia('(min-width: 820px) and (hover: hover)');
  // 选中的分组。null = 二级都收着（折叠模式下点开再点回去就是它）。
  let selected = null;
  // 上一次摆成了哪种；节点只在换摆法时搬一次 —— after() 每次都会真的搬动节点，
  // 每开一次抽屉就重挂一遍会让焦点和滚动位置白跳一下。
  let layout = null;

  const labelOf = key => parents.find(row => row.dataset.moreGroup === key)?.querySelector('strong')?.textContent || '';

  function select(key) {
    selected = groups.has(key) ? key : null;
    render();
  }

  function render() {
    const twoColumn = cascade.matches;
    for (const row of parents) {
      const key = row.dataset.moreGroup;
      const on = selected === key;
      row.classList.toggle('on', on);
      row.setAttribute('aria-expanded', String(on));
      groups.get(key).hidden = !on;
    }
    // 折叠模式下二级已经搬进抽屉里了，右边那一列没有存在的理由。
    flyout.hidden = !twoColumn || selected === null;
    panel.classList.toggle('has-flyout', !flyout.hidden);
    if (!selected) return;
    flyoutTitle.textContent = labelOf(selected);
    flyoutNote.textContent = t('airSettingsPanelCount', { n: groups.get(selected).children.length });
  }

  // 换摆法：两列时二级回右边那一列，折叠时插到各自父行的紧后面。插在父行后面
  // 而不是塞进父行里面 —— 父行是个 button，按钮里放按钮，点哪一层都会先撞到外层。
  function relayout() {
    const mode = cascade.matches ? 'cascade' : 'inline';
    if (mode !== layout) {
      layout = mode;
      if (mode === 'cascade') {
        for (const group of groups.values()) flyoutBody.append(group);
      } else {
        for (const row of parents) row.after(groups.get(row.dataset.moreGroup));
      }
    }
    render();
  }

  for (const row of parents) {
    const key = row.dataset.moreGroup;
    // 悬停切换就是「联动」本身：指针扫过四个分组，右边那一列跟着换。
    row.addEventListener('pointerenter', () => { if (cascade.matches) select(key); });
    row.addEventListener('focus', () => { if (cascade.matches) select(key); });
    // 两列时点一下就是选中（再点一次没有「收起来」这回事，那一列本来就在）；
    // 折叠时点的是展开/收起，所以选中的那一组再点一次要能合上。
    row.addEventListener('click', () => {
      if (cascade.matches) select(key);
      else select(selected === key ? null : key);
    });
  }
  tree.addEventListener('keydown', event => {
    const row = event.target.closest('.more-parent, .more-leaf');
    if (!row) return;
    // → 进二级、← 回一级：两列时这是唯一不靠鼠标也能读完两级的路。
    if (event.key === 'ArrowRight' && row.classList.contains('more-parent') && cascade.matches) {
      const first = groups.get(row.dataset.moreGroup).querySelector('.more-leaf');
      if (!first) return;
      event.preventDefault();
      select(row.dataset.moreGroup);
      first.focus();
    } else if (event.key === 'ArrowLeft' && row.classList.contains('more-leaf')) {
      const owner = row.closest('.more-leaf-group');
      const parent = owner && parents.find(node => groups.get(node.dataset.moreGroup) === owner);
      if (!parent) return;
      event.preventDefault();
      parent.focus();
    }
  });
  cascade.addEventListener('change', relayout);
  relayout();

  const close = () => {
    trigger.setAttribute('aria-expanded', 'false');
    if (panel.open) panel.close();
  };
  function open() {
    if (panel.open) return;
    if (document.body.classList.contains('console-open')) document.getElementById('console-close').click();
    document.getElementById('nav-scrim').click();
    status.textContent = '';
    // 先摆好再 showModal：开着的时候宽度在过渡，第二列如果这时才出现，用户看到
    // 的是「抽屉先张开、内容后跳进来」。默认选中第一组，一进来就能看见二级有东西。
    relayout();
    if (!selected) select(parents[0].dataset.moreGroup);
    panel.showModal();
    trigger.setAttribute('aria-expanded', 'true');
    document.getElementById('more-close').focus();
    root.dispatchEvent(new Event('multicc-more-opened'));
  }
  trigger.onclick = open;
  document.getElementById('more-close').onclick = close;
  panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
  panel.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); });
  panel.addEventListener('click', event => {
    const box = panel.getBoundingClientRect();
    if (event.target === panel && (event.clientX < box.left || event.clientX > box.right ||
        event.clientY < box.top || event.clientY > box.bottom)) close();
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-air-view], #overview')) close();
  }, true);
  // Native dialog handles Escape and focus trapping. Stop Air's task-level
  // shortcuts from closing or navigating the task underneath this drawer.
  document.addEventListener('keydown', event => {
    if (!panel.open || event.target.closest('dialog') !== panel) return;
    if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
      event.stopImmediatePropagation();
      if (event.key !== 'Escape') event.preventDefault();
    }
  }, true);
  for (const id of ['notice', 'air-ops-status']) {
    const source = document.getElementById(id);
    new MutationObserver(() => {
      if (panel.open && source.textContent) status.textContent = source.textContent;
    }).observe(source, { childList: true, characterData: true, subtree: true });
  }
  root.MultiCCAirMore = { open, close };
})(window);
