(function () {
  'use strict';
  const key = 'multicc:chat-layout';
  const defaults = { limited: false, maxWidth: 1200 };
  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return { limited: value?.limited === true, maxWidth: Number.isFinite(value?.maxWidth)
        ? Math.min(2400, Math.max(640, value.maxWidth)) : defaults.maxWidth };
    } catch (_) { return { ...defaults }; }
  }
  function apply(value) {
    document.documentElement.style.setProperty('--chat-content-max-width', value.limited ? `${value.maxWidth}px` : '100%');
    for (const frame of document.querySelectorAll('iframe')) {
      try { frame.contentWindow?.MultiCCChatLayout?.apply(value); } catch (_) {}
    }
  }
  function open() {
    if (document.querySelector('.chat-layout-dialog')) return;
    const original = read(), draft = { ...original }, dialog = document.createElement('dialog');
    dialog.className = 'chat-layout-dialog';
    dialog.innerHTML = '<form method="dialog"><h2>聊天宽度</h2><p>默认铺满可用空间。宽屏时可限制最大宽度，消息与输入区会一起居中。</p>'
      + '<label class="chat-layout-toggle"><input type="checkbox" name="limited">限制最大宽度</label>'
      + '<label>最大宽度 <output></output><input name="width" type="range" min="640" max="2400" step="40" aria-label="最大宽度"></label>'
      + '<div class="chat-layout-actions"><button type="button" name="reset">恢复默认</button><button value="cancel">取消</button><button value="save">保存</button></div></form>';
    const form = dialog.querySelector('form'), toggle = form.elements.limited, range = form.elements.width, output = dialog.querySelector('output');
    function render() {
      toggle.checked = draft.limited; range.value = draft.maxWidth; range.disabled = !draft.limited;
      output.textContent = `${draft.maxWidth} px`; apply(draft);
    }
    toggle.onchange = () => { draft.limited = toggle.checked; render(); };
    range.oninput = () => { draft.maxWidth = Number(range.value); render(); };
    form.elements.reset.onclick = () => { Object.assign(draft, defaults); render(); };
    function finish(save) {
      if (save) {
        try { localStorage.setItem(key, JSON.stringify(draft)); } catch (_) {}
        apply(draft);
      } else apply(original);
      dialog.close();
      dialog.remove();
    }
    form.onsubmit = event => { event.preventDefault(); finish(event.submitter?.value === 'save'); };
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    document.body.append(dialog); render(); dialog.showModal();
  }
  window.MultiCCChatLayout = { open, apply, read };
  apply(read());
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) apply(read()); });
  document.addEventListener('click', event => { if (event.target.closest('[data-chat-layout]')) open(); });
})();
