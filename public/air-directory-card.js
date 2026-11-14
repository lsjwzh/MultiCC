'use strict';

// ── 目录卡片底栏（public/air-directory-card.js）──────────────────────────
// 目录卡片（article.directory-card）底部的一行：左边「备忘」（新标签打开
// memo.html，与过去卡片外那颗链接同款），右边「快速删除」—— 复用
// air-directory-delete.js 导出的两步确认（先问删不删，服务端报还有会话时
// 再问一次连会话一起删）。删除成功后调调用方传入的回调重画：目录库重拉
// 快照、控制台整页重渲染。
//
// 卡片外观在 article 上（.directory-card），主按钮与这条底栏都在卡片里面，
// 备忘不再孤悬在卡片框外一行。删除按钮的 click 必须 stopPropagation：
// 卡片本身可拖、主按钮可点，冒泡上去会把「删目录」变成「打开目录」。
(function initAirDirectoryCard(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  function foot(directory, onDeleted) {
    const bar = node('div', null, 'directory-card-foot');
    const memo = node('a', t('memoTitle'), 'directory-memo');
    memo.href = `/memo.html?dirId=${encodeURIComponent(directory.id)}`;
    memo.target = '_blank';
    memo.rel = 'noopener';
    memo.setAttribute('aria-label', `${directory.name} · ${t('memoTitle')}`);
    const del = node('button', null, 'directory-card-delete');
    del.type = 'button';
    del.title = t('airDirDelete');
    del.setAttribute('aria-label', `${directory.name} · ${t('airDirDelete')}`);
    del.setAttribute('data-i18n-title', 'airDirDelete');
    const glyph = node('span', '🗑');
    glyph.setAttribute('aria-hidden', 'true');
    del.append(glyph);
    let busy = false;
    del.onclick = event => {
      event.stopPropagation();
      event.preventDefault();
      if (busy) return;
      busy = true;
      del.disabled = true;
      void (async () => {
        try {
          if (await root.MultiCCAirDirectoryDelete?.deleteDirectory?.(directory)) await onDeleted?.();
        } catch (error) {
          root.alert(t('airDirDeleteFailed', { message: error?.message || String(error) }));
        } finally {
          busy = false;
          del.disabled = false;
        }
      })();
    };
    bar.append(memo, del);
    return bar;
  }

  root.MultiCCAirDirectoryCard = { foot };
})(typeof window !== 'undefined' ? window : null);
