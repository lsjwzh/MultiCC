(function () {
  'use strict';
  var start = document.getElementById('udid-start');
  var status = document.getElementById('udid-status');
  var input = document.getElementById('udid-value');
  var params = new URLSearchParams(location.hash.slice(1));
  var udid = params.get('udid');
  // 先移除设备信息，再绘制二维码，避免分享链接携带设备标识。
  if (params.has('udid')) history.replaceState(null, '', location.pathname + location.search);
  if (udid && /^(?:[a-f0-9]{40}|[a-f0-9]{8}-[a-f0-9]{16})$/i.test(udid)) {
    input.value = udid;
    var details = [params.get('product'), params.get('version')].filter(function (value) {
      return value && /^[a-z0-9,._ -]{1,80}$/i.test(value);
    });
    document.getElementById('udid-device').textContent = details.join(' · ');
    document.getElementById('udid-result').hidden = false;
  }
  if (location.protocol !== 'https:') {
    start.removeAttribute('href');
    start.setAttribute('aria-disabled', 'true');
    status.textContent = t('iosUdidHttps');
  } else if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    status.textContent = t('iosUdidPhoneOnly');
  }
  start.addEventListener('click', function (event) {
    if (start.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
    status.textContent = t('iosUdidOpenSettings');
  });
  document.getElementById('udid-copy').addEventListener('click', async function () {
    var copyStatus = document.getElementById('udid-copy-status');
    try {
      await navigator.clipboard.writeText(input.value);
      copyStatus.textContent = t('iosUdidCopied');
    } catch (_) {
      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
      copyStatus.textContent = t('iosUdidCopyManual');
    }
  });
})();
