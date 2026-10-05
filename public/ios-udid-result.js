(function () {
  'use strict';
  var button = document.getElementById('udid-copy');
  if (!button) return;
  button.addEventListener('click', async function () {
    var input = document.getElementById('udid-value');
    var status = document.getElementById('udid-copy-status');
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = '已复制';
    } catch (_) {
      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
      status.textContent = '请长按选中的内容复制。';
    }
  });
})();
