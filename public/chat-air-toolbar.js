// Keep the original elements and listeners; Air presents them as one toolbar.
(function () {
  'use strict';
  if (!document.body.classList.contains('air-chat')) return;
  const header = document.getElementById('header');
  if (!header || document.getElementById('chat-context-bar')) return;
  const bar = document.createElement('section');
  bar.id = 'chat-context-bar';
  bar.setAttribute('aria-label', '工作区与运行状态');
  header.before(bar);
  for (const id of ['worktree-bar', 'aux-classify-bar', 'header']) {
    const element = document.getElementById(id);
    if (element) bar.appendChild(element);
  }
})();
