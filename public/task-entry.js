(async function () {
  'use strict';
  const incoming = new URLSearchParams(location.search), query = new URLSearchParams();
  for (const key of ['task', 'shell', 'session']) if (incoming.get(key)) query.set(key, incoming.get(key));
  try {
    const response = await fetch('/api/air/resolve?' + query, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok || !/^\/air(?:\?|$)/.test(data.url)) throw new Error(data.message || data.code || '无法读取任务');
    location.replace(data.url);
  } catch (error) {
    document.getElementById('entry-status').textContent = `暂时无法打开任务：${error.message}。原记录与工作区仍保留，请刷新重试。`;
  }
})();
