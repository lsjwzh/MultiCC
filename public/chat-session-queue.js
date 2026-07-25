(function attachMultiCCChatSessionQueue(global) {
  'use strict';

  function render(rawItems, metadata = {}, documentRef = global.document) {
    const dock = documentRef?.getElementById('session-queue-dock');
    const count = documentRef?.getElementById('session-queue-count');
    const hint = documentRef?.getElementById('session-queue-hint');
    const list = documentRef?.getElementById('session-queue-list');
    if (!dock || !count || !hint || !list) return;
    const items = Array.isArray(rawItems) ? rawItems : [];
    count.textContent = String(items.length);
    dock.hidden = items.length === 0;
    hint.textContent = metadata.state === 'frozen'
      ? `已冻结：${metadata.freezeReason || '当前任务需要处理'}`
      : '当前回复完成后自动发送';
    list.replaceChildren();
    for (const [index, item] of items.entries()) {
      const row = documentRef.createElement('div');
      row.className = 'session-queue-item';
      const position = documentRef.createElement('span');
      position.className = 'session-queue-position';
      position.textContent = `${Number(item?.position) || index + 1}.`;
      const text = documentRef.createElement('div');
      text.className = 'session-queue-text';
      text.textContent = String(item?.text || '（暂存消息）');
      row.append(position, text);
      list.appendChild(row);
    }
  }

  global.MultiCCChatSessionQueue = Object.freeze({ render });
})(typeof window !== 'undefined' ? window : globalThis);
