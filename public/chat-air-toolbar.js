// Keep the original elements and listeners; Air presents them as one toolbar.
(function () {
  'use strict';
  if (!document.body.classList.contains('air-chat')) return;
  const header = document.getElementById('header');
  if (!header || document.getElementById('chat-context-bar')) return;
  // 文案走 i18n：浏览器里用 i18n.js 的 t()，Node/旧目录回落到中文默认值。
  const tt = (key, fallback) => {
    const out = typeof window.t === 'function' ? window.t(key) : '';
    return out && out !== key ? out : fallback;
  };
  const bar = document.createElement('section');
  bar.id = 'chat-context-bar';
  bar.setAttribute('aria-label', tt('chatContextBarLabel', '工作区与运行状态'));
  header.before(bar);
  for (const id of ['worktree-bar', 'aux-classify-bar', 'header']) {
    const element = document.getElementById(id);
    if (element) bar.appendChild(element);
  }
})();
