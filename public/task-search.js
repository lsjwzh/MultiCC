'use strict';

// 任务全文检索（浏览器侧）：把搜索框接到 /api/task-board/search 上。
//
// 排序在服务端做（src/task-board/search.js 是同一份纯函数，任务板里每轮的
// excerpt 只有服务端有），这里只管三件事：
//   ① 防抖 + 结果缓存 —— 边打边搜不该把每个字符都变成一次请求；
//   ② 「当前结果是否还算数」—— 输入变了就作废，调用方回落到它自己的本地过滤，
//      所以断网、旧服务、搜索接口报错都只表现为「和以前一样按标题筛」；
//   ③ 命中片段的 DOM —— 服务端给的是「窗口文本 + 高亮区间」，客户端不重新分词。
//
// 调用方保留自己的本地过滤：本模块只提供「有全文结果时按相关度排」的覆盖层，
// 面板不会因为一次请求没回来而空掉。

(function initMultiCCTaskSearch(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCTaskSearch = api;
})(typeof window !== 'undefined' ? window : null, function createMultiCCTaskSearch(root) {
  const DEFAULT_DELAY = 150;
  const MAX_CACHE = 40;
  const DEFAULT_LIMIT = 20;

  function documentOf() {
    return root?.document || (typeof document !== 'undefined' ? document : null);
  }

  function searchPath(text, filters = {}, limit = DEFAULT_LIMIT) {
    const params = new URLSearchParams({ q: text, limit: String(limit) });
    if (filters.dirId) params.set('dirId', String(filters.dirId));
    if (filters.dirIds?.length) params.set('dirIds', filters.dirIds.join(','));
    if (filters.statuses?.length) params.set('statuses', filters.statuses.join(','));
    return `/api/task-board/search?${params.toString()}`;
  }

  function cacheKey(text, filters = {}, limit = DEFAULT_LIMIT) {
    return [text, filters.dirId || '', (filters.dirIds || []).join('+'),
      (filters.statuses || []).join('+'), limit].join('|');
  }

  /**
   * 把一个 <input> 接到全文检索上。
   *   request   —— 页面自己的带鉴权请求函数（air.js 的 api / 控制台的 api）
   *   filters() —— 查询时现算的过滤条件 { dirId, dirIds, statuses }
   *   onChange  —— 结果变化（含「回到本地过滤」）时重画
   * results() 返回 { query, hits } 或 null；null 一律表示「用你自己的本地过滤」。
   */
  function attach(input, {
    request, filters = () => ({}), onChange = () => ({}),
    delay = DEFAULT_DELAY, limit = DEFAULT_LIMIT, minLength = 1,
  } = {}) {
    if (!input || typeof input.addEventListener !== 'function') {
      throw new TypeError('task-search attach requires an input element');
    }
    if (typeof request !== 'function') throw new TypeError('task-search attach requires request()');
    const cache = new Map();
    let timer = null;
    let current = null;
    let disposed = false;

    const readQuery = () => String(input.value || '').trim();

    function remember(key, hits) {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, hits);
    }

    function schedule() {
      if (disposed) return;
      const text = readQuery();
      if (timer) { clearTimeout(timer); timer = null; }
      if (text.length < minLength) {
        current = null;
        onChange();
        return;
      }
      const key = cacheKey(text, filters(), limit);
      const cached = cache.get(key);
      // 已经有这个词的结果（比如退格退回刚搜过的查询）就立刻生效，不再等防抖。
      current = cached ? { query: text, hits: cached } : null;
      onChange();
      if (cached) return;
      timer = setTimeout(async () => {
        timer = null;
        let hits = null;
        try {
          const payload = await request(searchPath(text, filters(), limit));
          hits = Array.isArray(payload?.results) ? payload.results : [];
        } catch (_) {
          hits = null;
        }
        if (disposed) return;
        if (hits) remember(key, hits);
        // 输入已经变了：这次结果只进缓存，不驱动重画 —— 下一个词的重画由它自己的
        // 那次 oninput 负责，否则会把新查询的界面覆盖成旧查询的结果。
        if (readQuery() !== text) return;
        current = hits ? { query: text, hits } : null;
        onChange();
      }, delay);
    }

    input.addEventListener('input', schedule);
    if (readQuery()) schedule();

    return {
      results: () => current,
      refresh: schedule,
      clear() { current = null; cache.clear(); },
      destroy() {
        disposed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        input.removeEventListener('input', schedule);
      },
    };
  }

  // 命中片段：文本节点 + <mark> 区间。区间是服务端算好的窗口内偏移，这里不重新
  // 分词，也不碰 innerHTML —— 片段来自任务板（用户自己写的正文），拼 HTML 就等于
  // 把任务内容当代码执行。
  function fillSnippet(host, snippet) {
    const doc = documentOf();
    if (!host || !doc) return host;
    const text = String(snippet?.text || '');
    const ranges = Array.isArray(snippet?.ranges) ? snippet.ranges : [];
    let at = 0;
    for (const range of ranges) {
      const from = Math.max(at, Math.min(text.length, Number(range?.[0]) || 0));
      const to = Math.max(from, Math.min(text.length, Number(range?.[1]) || 0));
      if (from > at) host.append(text.slice(at, from));
      if (to > from) {
        const mark = doc.createElement('mark');
        mark.textContent = text.slice(from, to);
        host.append(mark);
      }
      at = to;
    }
    if (at < text.length) host.append(text.slice(at));
    return host;
  }

  function snippetNode(snippet, { tag = 'small', className = 'task-note task-snippet' } = {}) {
    const doc = documentOf();
    if (!doc || !String(snippet?.text || '')) return null;
    const host = doc.createElement(tag);
    if (className) host.className = className;
    return fillSnippet(host, snippet);
  }

  // 命中 id → 任务对象，按相关度（服务端顺序）排列。池子里找不到的 id（任务刚被
  // 删掉/归档到别的视图外）直接跳过，不编造行。
  function rankedTasks(results, pool) {
    const hits = results?.hits;
    if (!Array.isArray(hits) || !hits.length) return null;
    const byId = new Map();
    for (const task of Array.isArray(pool) ? pool : []) byId.set(String(task?.id), task);
    const ranked = [];
    for (const hit of hits) {
      const task = byId.get(String(hit?.taskId));
      if (task) ranked.push({ task, hit });
    }
    return ranked.length ? ranked : null;
  }

  return {
    attach,
    snippetNode,
    fillSnippet,
    rankedTasks,
    searchPath,
    DEFAULT_DELAY,
  };
});
