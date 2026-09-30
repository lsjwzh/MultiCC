'use strict';

// 任务全文检索（浏览器侧）：把搜索框接到服务端的两条检索上。
//
//   ① /api/task-board/search  任务板语料（标题 / 规划 / 每轮摘录）
//   ② /api/search/messages    会话正文语料（FTS5，全量 chat_history）
//
// ② 是「只出现在对话里的词」唯一的召回路径 —— 任务板一条摘录只有一句话，长会话
// 中途换的话题从来不在板子里。两条语料的排序都在服务端做（同一份分词与 BM25），
// 会话命中由服务端附上任务 id（任务板的 refs 是唯一知道这层关系的地方），这里只管：
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

  // 会话正文那条。它不认识目录/状态，那两档口径由调用方在本地的同一份 filterTasks
  // 上收窄（命中先带上任务 id，再和任务板命中一起过筛）。
  function messagePath(text, { limit = DEFAULT_LIMIT } = {}) {
    return `/api/search/messages?${new URLSearchParams({ q: text, limit: String(limit) })}`;
  }

  function cacheKey(text, filters = {}, limit = DEFAULT_LIMIT, full = false) {
    return [text, filters.dirId || '', (filters.dirIds || []).join('+'),
      (filters.statuses || []).join('+'), limit, full ? 'full' : 'board'].join('|');
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

  /**
   * 会话命中 → 任务。服务端给的是「会话 + 片段 + 它所属的任务 id（可能多个）」，
   * 这里取池子里第一个找得到的那个任务；不属于任何任务的会话（纯对话）跳过 ——
   * 搜索框只摆任务行，摆不了「一段对话」。
   */
  function rankedMessageTasks(results, pool) {
    const hits = results?.messageHits;
    if (!Array.isArray(hits) || !hits.length) return [];
    const byId = new Map();
    for (const task of Array.isArray(pool) ? pool : []) byId.set(String(task?.id), task);
    const seen = new Set();
    const ranked = [];
    for (const hit of hits) {
      for (const id of Array.isArray(hit?.taskIds) ? hit.taskIds : []) {
        const key = String(id);
        const task = byId.get(key);
        if (!task || seen.has(key)) continue;
        seen.add(key);
        ranked.push({ task, hit, source: 'message' });
        break;
      }
    }
    return ranked;
  }

  // 两条语料合成一份顺序：任务板命中在前（那是任务自己的文字），会话命中接在后面
  // （正文里出现过查询词，但任务板的摘录里没有）。同一个任务只留它最强的那次命中。
  function rankedHits(results, pool) {
    const board = rankedTasks(results, pool) || [];
    const seen = new Set(board.map(row => String(row.task.id)));
    return [...board, ...rankedMessageTasks(results, pool).filter(row => !seen.has(String(row.task.id)))];
  }

  /**
   * 把一个 <input> 接到全文检索上。
   *   request  —— 页面自己的带鉴权请求函数（air.js 的 api / 控制台的 api）
   *   filters()—— 查询时现算的过滤条件 { dirId, dirIds, statuses }
   *   fullText()—— 这一次要不要连会话正文一起搜（false = 只搜任务板语料）
   *   onChange —— 结果变化（含「回到本地过滤」）时重画
   * results() 返回 { query, hits, messageHits } 或 null；null 一律表示「用你自己的
   * 本地过滤」。
   */
  function attach(input, {
    request, filters = () => ({}), fullText = () => false, onChange = () => ({}),
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

    function remember(key, hits, messageHits) {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, { hits, messageHits });
    }

    // 一次请求的成败单独收敛：失败返回 fallback，不让半条路挂掉拖垮另半条。
    async function fetchResults(path, fallback) {
      try {
        const payload = await request(path);
        return Array.isArray(payload?.results) ? payload.results : fallback;
      } catch (_) {
        return fallback;
      }
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
      const full = !!fullText();
      const key = cacheKey(text, filters(), limit, full);
      const cached = cache.get(key);
      // 已经有这个词的结果（比如退格退回刚搜过的查询）就立刻生效，不再等防抖。
      current = cached ? { query: text, ...cached } : null;
      onChange();
      if (cached) return;
      timer = setTimeout(async () => {
        timer = null;
        // 两条语料并行：任务板那次失败仍是 null（回落到本地标题筛选），会话那次失败
        // 只是没有会话命中 —— 搜索框不该因为一半接口不可用就整个空掉。
        const [hits, messageHits] = await Promise.all([
          fetchResults(searchPath(text, filters(), limit), null),
          full ? fetchResults(messagePath(text, { limit }), []) : Promise.resolve([]),
        ]);
        if (disposed) return;
        if (hits || messageHits.length) remember(key, hits, messageHits);
        // 输入已经变了：这次结果只进缓存，不驱动重画 —— 下一个词的重画由它自己的
        // 那次 oninput 负责，否则会把新查询的界面覆盖成旧查询的结果。
        if (readQuery() !== text) return;
        current = hits || messageHits.length ? { query: text, hits: hits || [], messageHits } : null;
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

  return {
    attach,
    snippetNode,
    fillSnippet,
    rankedTasks,
    rankedMessageTasks,
    rankedHits,
    searchPath,
    messagePath,
    DEFAULT_DELAY,
  };
});
