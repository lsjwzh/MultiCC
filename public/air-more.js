'use strict';

// The drawer owns only its presentation. Existing setting and host-operation
// controllers retain their nodes, requests and navigation handlers.
(function (root) {
  const panel = document.getElementById('more-panel');
  const trigger = document.getElementById('side-more');
  const status = document.getElementById('more-status');
  const close = () => {
    trigger.setAttribute('aria-expanded', 'false');
    if (panel.open) panel.close();
  };
  function open() {
    if (panel.open) return;
    if (document.body.classList.contains('console-open')) document.getElementById('console-close').click();
    document.getElementById('nav-scrim').click();
    status.textContent = '';
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
