'use strict';
// 目录任务每页 20 条。整页只有 #empty 一个滚动口；表头（抬头 + 筛选，同一个
// sticky 元素）滚到滚动口顶就钉住，行继续滚，面板走完自己撒手 —— 这里不再需要
// 一个只读的粘性副本，也不再需要为它量位置。这个模块现在只管两件与分页绑在一起的
// 尺寸：
//   1. 分页时把面板撑到一个滚动口高（`.is-paged` + `min-height`），让「表头钉住」
//      那一刻「表头 + 当前页」正好盖满整屏；不超过一页时随时撤掉，退回动态高度。
//   2. 量出底部那个 sticky 输入框的高度，交给 CSS（`--quick-task-form-h`），
//      给面板留出等高的下边距 —— 页尾内容才有行程升到输入框之上。
(function initAirTaskPager(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const PAGE_SIZE = 20;
  // 页面唯一那条手机断点（air.css 里所有 ≤760px 的档都写这个数）：桌面档的面板高度
  // 由 CSS 给（min(560px, 65vh)），这里只补手机那一档，两边不能各写一个数。
  const MOBILE_QUERY = '(max-width: 760px)';
  let page = 1;
  let pages = 1;
  let onChange = null;
  let pending = false;

  function isMobile() {
    return typeof root.matchMedia === 'function' ? root.matchMedia(MOBILE_QUERY).matches : true;
  }

  function measure() {
    const empty = el('empty');
    const panel = el('directory-task-panel');
    const list = el('directory-task-list');
    if (!empty || !panel || !list) return;
    const paged = panel.classList.contains('is-paged');
    // 滚动时这个函数每帧都跑，写回同一个值也算一次样式改动，所以先比一下再写。
    // 用 clientHeight （含 #empty 自己的上下内边距）而不是视口高：滚动口不一定
    // 是整屏（桌面上还有侧栏）。
    const minHeight = paged && isMobile() ? empty.clientHeight + 'px' : '';
    if (panel.style.minHeight !== minHeight) panel.style.minHeight = minHeight;
    // 输入框的高度是动态的（折起来是一条细杠，展开是整张卡），所以每次重新量。
    const form = el('quick-task-form');
    const formH = paged && form ? Math.round(form.getBoundingClientRect().height) : 0;
    const formVar = formH > 0 ? formH + 'px' : '';
    if (empty.style.getPropertyValue('--quick-task-form-h') !== formVar) {
      if (formVar) empty.style.setProperty('--quick-task-form-h', formVar);
      else empty.style.removeProperty('--quick-task-form-h');
    }
  }

  function scheduleMeasure() {
    if (pending) return;
    pending = true;
    root.requestAnimationFrame(() => { pending = false; measure(); });
  }

  function view(rows) {
    const list = rows || [];
    pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * PAGE_SIZE;
    return { items: list.slice(start, start + PAGE_SIZE), page, pages, total: list.length };
  }

  function paint(rows) {
    const state = view(rows);
    // 分页与否决定面板是「撑满一屏、表头钉住」还是「按内容自然高度」——这一条
    // 挂在面板自己身上，CSS 那一档只写 `.is-paged`。
    const panel = el('directory-task-panel');
    if (panel) panel.classList.toggle('is-paged', state.pages > 1);
    const bar = el('directory-task-pager');
    if (bar) {
      bar.hidden = state.pages <= 1;
      const label = el('directory-task-page');
      if (label) label.textContent = translate('airTaskPageOf', { page: state.page, total: state.pages });
      const prev = el('directory-task-prev');
      const next = el('directory-task-next');
      if (prev) prev.disabled = state.page <= 1;
      if (next) next.disabled = state.page >= state.pages;
    }
    // air.js 在 paint 之后才更新计数与任务 DOM。
    scheduleMeasure();
    return state.items;
  }

  function reset() { page = 1; scheduleMeasure(); }

  function go(delta) {
    const target = page + delta;
    if (target < 1 || target > pages) return;
    page = target;
    if (onChange) onChange();
    root.requestAnimationFrame(() => {
      const empty = el('empty');
      const heading = el('directory-task-real-heading');
      if (empty && heading) {
        empty.scrollTop += heading.getBoundingClientRect().top - empty.getBoundingClientRect().top;
      }
      measure();
    });
  }

  const prev = el('directory-task-prev');
  const next = el('directory-task-next');
  if (prev) prev.onclick = () => go(-1);
  if (next) next.onclick = () => go(1);
  const empty = el('empty');
  if (empty) empty.addEventListener('scroll', scheduleMeasure, { passive: true });
  root.addEventListener('resize', scheduleMeasure);
  if (typeof root.ResizeObserver === 'function' && empty) {
    const observer = new root.ResizeObserver(scheduleMeasure);
    observer.observe(empty);
  }
  if (typeof root.MutationObserver === 'function' && empty) {
    new root.MutationObserver(scheduleMeasure).observe(empty, {
      attributes: true, attributeFilter: ['class'],
    });
  }
  scheduleMeasure();

  root.MultiCCAirTaskPager = {
    PAGE_SIZE, reset, view, paint, measure,
    bind: handler => { onChange = handler; },
  };
})(typeof window !== 'undefined' ? window : null);
