// The directory home's new-task form is the chat's whole composer: a config
// band, a textarea, a Goal row and an action bar. That is the right size while
// you are writing a task and the wrong size the rest of the time — it is
// sticky, so on a phone it owns the bottom third of the screen for as long as
// you are reading the task list above it.
//
// So on phones it starts folded: one thin bar on the bottom edge, carrying the
// same placeholder the textarea does. Tapping it brings the whole composer back
// with the caret already in the textarea.
//
// The fold never takes anything away, and that is one rule: it does not engage
// while there is a draft or an attachment inside. Escape is the way back to the
// bar, and Escape with the box full does nothing at all — the composer the chat
// page folds on scroll has to echo a draft on its oval because it folds mid-
// sentence; this one only ever folds on purpose, so it can simply stay open.
// Desktop windows never fold: the composer has room there, and folding would be
// motion for its own sake.
(function () {
  'use strict';

  var form = document.getElementById('quick-task-form');
  var input = document.getElementById('quick-task-input');
  if (!form || !input) return;

  var files = document.getElementById('quick-task-files');
  var PHONE = window.matchMedia('(max-width: 760px)');
  // air.js dispatches this on the form once a task has been created and the box
  // has been cleared. Folding back is the other half of 创建并执行.
  var CREATED = 'air:quick-task-created';
  var HINT = '描述要完成的任务…';

  var bar = document.createElement('button');
  bar.id = 'quick-task-expand';
  bar.type = 'button';
  bar.setAttribute('aria-controls', 'quick-task-input');
  var hint = document.createElement('span');
  hint.id = 'quick-task-expand-hint';
  hint.textContent = HINT;
  bar.append(hint);
  // First child of the card: folded, this is the only thing left of it.
  form.insertBefore(bar, form.firstChild);

  function written() {
    if (input.value.trim()) return true;
    return !!(files && files.querySelectorAll('.quick-task-file').length);
  }
  function folded() { return form.classList.contains('is-folded'); }

  function fold() {
    if (!PHONE.matches || folded() || written()) return;
    form.classList.add('is-folded');
    bar.setAttribute('aria-expanded', 'false');
  }
  function unfold(focus) {
    form.classList.remove('is-folded');
    bar.setAttribute('aria-expanded', 'true');
    if (!focus) return;
    input.focus();
    // Tapping the bar means "carry on writing", not "start over".
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
  }

  bar.addEventListener('click', function () { unfold(true); });
  form.addEventListener('focusin', function (event) {
    // The bar is the fold's own control, not a field inside it: focusing it to
    // fold the composer must not immediately unfold it again.
    if (event.target === bar) return;
    unfold(false);
  });
  form.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    fold();
    // 有草稿时 fold() 什么也没做，焦点不该被抢走 —— 交给 air.js 的全局 Esc
    // （关浮层、关详情）继续处理才是对的。
    if (folded()) bar.focus();
  });
  // A created task clears the box; there is nothing left to keep open.
  form.addEventListener(CREATED, fold);

  function adopt() { if (PHONE.matches) fold(); else unfold(false); }
  window.addEventListener('resize', adopt);
  if (PHONE.addEventListener) PHONE.addEventListener('change', adopt);

  adopt();
})();
