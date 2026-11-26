'use strict';

(() => {
  const sidebar = document.getElementById('sidebar');
  const edge = document.getElementById('sidebar-edge');
  const mode = document.getElementById('sidebar-mode');
  const body = document.body;
  const desktop = matchMedia('(min-width: 761px)');
  const key = 'air:sidebar-auto-hide';
  const popups = '.space-card [aria-expanded="true"]';
  let autoHide = false;
  let revealed = false;
  let closeTimer;

  try { autoHide = localStorage.getItem(key) === '1'; } catch (_) {}

  function render() {
    const floating = desktop.matches && autoHide;
    body.classList.toggle('sidebar-auto-hide', floating);
    body.classList.toggle('sidebar-revealed', floating && revealed);
    sidebar.inert = floating && !revealed;
    edge.setAttribute('aria-expanded', String(revealed));
    const label = autoHide ? 'airSidebarPin' : 'airSidebarAutoHide';
    mode.dataset.i18nTitle = mode.dataset.i18nAriaLabel = label;
    mode.title = window.t(label);
    mode.setAttribute('aria-label', mode.title);
  }

  function reveal() {
    clearTimeout(closeTimer);
    revealed = true;
    render();
  }

  function close() {
    clearTimeout(closeTimer);
    revealed = false;
    render();
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    if (!revealed) return;
    closeTimer = setTimeout(() => {
      if (sidebar.matches(':hover') || edge.matches(':hover') ||
          sidebar.querySelector(':focus-visible') || sidebar.querySelector(popups)) return;
      close();
    }, 260);
  }

  mode.addEventListener('click', () => {
    const keyboard = mode.matches(':focus-visible');
    autoHide = !autoHide;
    try { localStorage.setItem(key, autoHide ? '1' : '0'); } catch (_) {}
    close();
    if (autoHide && keyboard) edge.focus();
  });
  edge.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'touch') reveal();
  });
  edge.addEventListener('click', () => {
    reveal();
    document.getElementById('library').focus({ preventScroll: true });
  });
  sidebar.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  sidebar.addEventListener('pointerleave', scheduleClose);
  edge.addEventListener('pointerleave', scheduleClose);
  sidebar.addEventListener('focusout', scheduleClose);
  document.addEventListener('pointerdown', event => {
    if (revealed && !sidebar.contains(event.target) && !edge.contains(event.target) &&
        !sidebar.querySelector(popups)) close();
  });
  sidebar.addEventListener('keydown', event => {
    if (revealed && event.key === 'Escape' && !sidebar.querySelector(popups)) {
      event.stopPropagation();
      close();
      edge.focus();
    }
  });
  // The directory, notifications and updates panels are mounted outside the sidebar.
  new MutationObserver(scheduleClose).observe(sidebar.querySelector('.space-card'), {
    attributes: true, attributeFilter: ['aria-expanded'], subtree: true,
  });
  desktop.addEventListener('change', close);
  render();
})();
