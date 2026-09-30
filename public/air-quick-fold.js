// The directory home's new-task form is the chat's whole composer: a config
// band, a textarea, a Goal row and an action bar. That is the right size while
// you are writing a task and the wrong size the rest of the time — it is
// sticky, so it owns the bottom of the directory page for as long as you are
// reading the task list above it. On a phone that is a third of the screen; on
// a desktop window it is the last card of the page, and the task list it sits
// under is the thing with a remaining-height band to fill.
//
// So it starts folded everywhere: one thin bar on the bottom edge, carrying the
// same placeholder the textarea does. Tapping it brings the whole composer back
// with the caret already in the textarea.
//
// The fold never takes anything away, and those are the only two rules: it does
// not engage while there is a draft or an attachment inside, and it does not
// engage inside the ＋ 新任务 dialog (that dialog exists so you can write).
// Escape is the way back to the bar, and Escape with the box full does nothing
// at all — the composer the chat page folds on scroll has to echo a draft on
// its oval because it folds mid-sentence; this one only ever folds on purpose,
// so it can simply stay open.
(function () {
  'use strict';

  var form = document.getElementById('quick-task-form');
  var input = document.getElementById('quick-task-input');
  if (!form || !input) return;

  var files = document.getElementById('quick-task-files');
  // air.js dispatches this on the form once a task has been created and the box
  // has been cleared. Folding back is the other half of 创建并执行.
  var CREATED = 'air:quick-task-created';

  var bar = document.createElement('button');
  bar.id = 'quick-task-expand';
  bar.type = 'button';
  bar.setAttribute('aria-controls', 'quick-task-input');
  var hint = document.createElement('span');
  hint.id = 'quick-task-expand-hint';
  bar.append(hint);

  // The bar says what the box says. air.js rewrites the placeholder — the home
  // page has one prompt and an open task has another — and repeats its first
  // sentence here, minus the second sentence that only fits in the full box.
  function refreshHint() {
    var text = (input.placeholder || '').split(/[；;]/)[0].trim();
    if (!text) return;
    if (!/[.…]$/.test(text)) text += '…';
    hint.textContent = text;
  }
  // First child of the card: folded, this is the only thing left of it.
  form.insertBefore(bar, form.firstChild);

  function written() {
    if (input.value.trim()) return true;
    return !!(files && files.querySelectorAll('.quick-task-file').length);
  }
  function folded() { return form.classList.contains('is-folded'); }
  // 卡片被搬进「＋ 新任务」弹窗的时候不算首页那张卡：那个弹窗存在的理由就是让人写字，
  // 一条细杠在里面没有意义。
  function inDialog() {
    var slot = document.getElementById('quick-task-slot');
    return !!(slot && slot.contains(form));
  }

  // air.js 会把这整张卡片搬进侧栏那颗「＋ 新任务」的弹窗（openNewTaskComposer）。
  // 折成一条细杠在弹窗里没有意义 —— 所以打开时管它要一次展开态，关掉再交回来时按
  // 平时的规矩收回去。两条都是无条件的「请按规矩来」：下面那两个函数自己会看有没有
  // 草稿、是不是在弹窗里。搬动不改节点身份，这里抓着的一直是同一张卡。
  window.__airQuickFold = {
    fold: function () { fold(); },
    unfold: function () { unfold(false); },
  };

  // 折的条件只有两个：盒子里有东西（草稿或附件）不折、在弹窗里不折。屏宽不再是条件
  // —— 桌面这张卡同样是 sticky 的，同样压着目录列表的尾巴。
  function fold() {
    if (folded() || written() || inDialog()) return;
    refreshHint();
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

  // Opening a task rewrites the placeholder while the bar sits folded on the
  // edge; the bar has to follow it there, not only on the next fold.
  if (window.MutationObserver) new MutationObserver(refreshHint).observe(input, { attributes: true, attributeFilter: ['placeholder'] });

  // 启动、窗口尺寸变化、以及任何「事实变了」的时刻：把折叠状态跟事实对齐一次。
  // 有草稿或在弹窗里就展开，否则折回去。
  function adopt() { if (written() || inDialog()) unfold(false); else fold(); }
  window.addEventListener('resize', adopt);

  refreshHint();
  adopt();
})();
