'use strict';
// 目录任务每页 20 条。整页只有 #empty 一个滚动口；表头离开视口、任务行仍在
// 视口内时，显示一份只读的精简标题副本。筛选与排序只存在于真实表头。
(function initAirTaskPager(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const PAGE_SIZE = 20;
  let page = 1;
  let pages = 1;
  let onChange = null;
  let pending = false;

  function measure() {
    const empty = el('empty');
    const heading = el('directory-task-real-heading');
    const list = el('directory-task-list');
    const copy = el('directory-task-sticky-copy');
    if (!empty || !heading || !list || !copy) return;
    const count = el('directory-overview-count');
    const copyCount = el('directory-task-sticky-count');
    if (count && copyCount) copyCount.textContent = count.textContent;
    const viewport = empty.getBoundingClientRect();
    const title = heading.getBoundingClientRect();
    const rows = list.getBoundingClientRect();
    const visible = !empty.classList.contains('is-terminal-mode')
      && !!list.querySelector('.directory-task-row')
      && title.bottom <= viewport.top
      && rows.bottom > viewport.top && rows.top < viewport.bottom;
    copy.classList.toggle('is-visible', visible);
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
