'use strict';

// The line under the composer answers one question at a glance: how full is the
// context. Everything else a turn reports — the provider's token windows, the
// session's cumulative billing, how long the turn ran — is real but secondary,
// so it lives in a panel the reader opens (hover on a pointer device, tap on a
// touch one) instead of competing for the same row as the number that matters.
//
// Two things are deliberately absent from the default line:
//
//  · Money. The CLI prices every turn with Anthropic's table even when the
//    traffic was routed to a third-party provider, so its USD figure is not
//    this session's cost and cannot be turned into one here. A number nobody
//    can act on does not belong on a status line.
//  · Subscription limits. Those are windows against an account, not against
//    this conversation's context; they have their own rows above.
(function attachChatUsageReadout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatUsageReadout = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  function tokenReadout() {
    const scope = typeof window !== 'undefined' ? window : globalThis;
    if (scope && scope.MultiCCChatTokenReadout) return scope.MultiCCChatTokenReadout;
    if (typeof require === 'function') {
      try { return require('./chat-token-readout.js'); } catch (_) { return null; }
    }
    return null;
  }

  function count(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function compactTokens(value) {
    const n = count(value);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(n);
  }

  function k(value) {
    return `${(count(value) / 1000).toFixed(1)}k`;
  }

  function pctColor(pct) {
    if (pct > 80) return '#f85149';
    if (pct > 50) return '#d29922';
    return '#3fb950';
  }

  /**
   * How much of the window this conversation is using, and how sure we are.
   *
   * `requestUsage` is one API request's own report, so it is a measurement.
   * Falling back to the turn total means falling back to an estimate, and the
   * two are labelled differently rather than blended into one confident-looking
   * number.
   */
  function contextState(sources) {
    const readout = tokenReadout();
    const window = count(sources.contextWindow);
    const exact = readout ? readout.requestContext(sources.requestUsage) : 0;
    if (exact > 0) return { tokens: exact, window, exact: true, usable: true };

    const turn = readout
      ? readout.turnContext(sources.turnUsage, window)
      : { total: 0, aggregated: false, withinWindow: true };
    if (!turn.total) return { tokens: 0, window, exact: true, usable: false };
    if (!turn.aggregated) return { tokens: turn.total, window, exact: true, usable: true };
    // A turn that summed several requests: the once-per-request buckets are an
    // upper bound, and past the window even that bound says nothing.
    return { tokens: turn.total, window, exact: false, usable: turn.withinWindow };
  }

  function summaryOf(sources) {
    const ctx = contextState(sources);
    if (!ctx.tokens) return { text: '', title: '', pct: 0, color: '', hasBar: false, exact: true };
    if (!ctx.usable) {
      return {
        text: '上下文 —',
        title: `本轮跨多次 API 请求合计上报 ${compactTokens(ctx.tokens)} tokens，超过 ${k(ctx.window)} 的窗口，无法据此折算单轮上下文占用。`,
        pct: 0,
        color: 'var(--faint)',
        hasBar: false,
        exact: false,
      };
    }
    if (!ctx.window) {
      return {
        text: `上下文 ${k(ctx.tokens)}`,
        title: '当前模型的上下文窗口未知，只能给出占用量。',
        pct: 0, color: '#8b949e', hasBar: false, exact: ctx.exact,
      };
    }
    const pct = Math.min(100, (ctx.tokens / ctx.window) * 100);
    const window = `${(ctx.window / 1000).toFixed(0)}k`;
    return {
      text: ctx.exact
        ? `上下文 ${k(ctx.tokens)} / ${window} · ${pct.toFixed(1)}%`
        : `上下文 ≈${k(ctx.tokens)} / ${window} · 约 ${pct.toFixed(1)}%`,
      title: ctx.exact
        ? '最近一次 API 请求实际带入的上下文（新增输入 + 缓存读 + 缓存写）。'
        : '本轮跨多次 API 请求合计上报，已剔除被重复计入的缓存读取；这是上下文占用的估算上限。',
      pct,
      color: pctColor(pct),
      hasBar: true,
      exact: ctx.exact,
    };
  }

  function turnRow(sources, fmt) {
    const usage = sources.turnUsage;
    if (!usage || typeof usage !== 'object') return null;
    const fresh = count(usage.input_tokens);
    const read = count(usage.cache_read_input_tokens);
    const write = count(usage.cache_creation_input_tokens);
    const out = count(usage.output_tokens);
    if (fresh + read + write + out === 0) return null;
    return {
      label: '本轮计费',
      value: `新增输入 ${fmt(fresh)} · 缓存读 ${fmt(read)} · 缓存写 ${fmt(write)} · 输出 ${fmt(out)}`,
      title: '这是计费口径：一轮里每次 API 请求都会把常驻前缀作为「缓存读」再算一遍，所以它远大于上下文占用。',
    };
  }

  function providerRow(sources, formatWindow) {
    const windows = sources.providerWindows;
    if (!windows || typeof windows !== 'object') return null;
    const entries = [];
    for (const [key, prefix] of [['today', '日'], ['week', '周'], ['month', '月']]) {
      if (!windows[key]) continue;
      const text = formatWindow(windows[key]);
      if (text) entries.push(`${prefix} ${text}`);
    }
    if (!entries.length && windows.all) {
      const text = formatWindow(windows.all);
      if (text) entries.push(`总 ${text}`);
    }
    if (!entries.length) return null;
    return {
      label: `${sources.providerLabel || 'Provider'} 用量`,
      value: entries.join('\n'),
      title: 'MultiCC 按供应商统计的 token 用量，与上下文占用无关。',
    };
  }

  /**
   * @returns {{summary:{text:string,title:string,pct:number,color:string,
   *            hasBar:boolean,exact:boolean},
   *            details:Array<{label:string,value:string,title:string}>}}
   */
  function buildUsageView(input) {
    const sources = input && typeof input === 'object' ? input : {};
    const fmt = typeof sources.formatTokens === 'function' ? sources.formatTokens : compactTokens;
    const formatWindow = typeof sources.formatWindow === 'function'
      ? sources.formatWindow
      : () => '';
    const details = [];

    const turn = turnRow(sources, fmt);
    if (turn) details.push(turn);

    const meta = sources.turnMeta && typeof sources.turnMeta === 'object' ? sources.turnMeta : null;
    if (meta && (meta.durationText || meta.turns)) {
      const parts = [];
      if (meta.durationText) parts.push(meta.durationText);
      if (meta.turns) parts.push(`${meta.turns} 轮`);
      details.push({ label: '本轮耗时', value: parts.join(' · '), title: '从提交到本轮结束的墙钟时间，以及 CLI 内部的往返轮数。' });
    }

    const session = sources.sessionTokens && typeof sources.sessionTokens === 'object'
      ? sources.sessionTokens
      : null;
    const sessionTotal = session ? count(session.input) + count(session.output) : 0;
    if (sessionTotal > 0) {
      details.push({
        label: '会话累计',
        value: `${fmt(sessionTotal)} tokens（in ${fmt(session.input)} / out ${fmt(session.output)}）`,
        title: '整个会话累计的计费用量（含每次请求重复计入的缓存读取），不是当前上下文占用。',
      });
    }

    const provider = providerRow(sources, formatWindow);
    if (provider) details.push(provider);

    return { summary: summaryOf(sources), details };
  }

  function summaryHtml(view) {
    const summary = view.summary;
    if (!summary.text) return '';
    const parts = [`<span class="usage-ctx-text" style="color:${summary.color}">${escapeHtml(summary.text)}</span>`];
    if (summary.hasBar) {
      parts.push(`<span class="usage-ctx-meter"><span style="width:${summary.pct}%;background:${summary.color}"></span></span>`);
    }
    if (view.details.length) parts.push('<span class="usage-ctx-more" aria-hidden="true">详情</span>');
    return parts.join('');
  }

  function detailHtml(view) {
    if (!view.details.length) return '';
    const rows = view.details.map(row => (
      `<div class="usage-detail-row"${row.title ? ` title="${escapeHtml(row.title)}"` : ''}>` +
      `<span class="usage-detail-label">${escapeHtml(row.label)}</span>` +
      `<span class="usage-detail-value">${escapeHtml(row.value).replace(/\n/g, '<br>')}</span>` +
      '</div>'
    ));
    return `<div class="usage-detail-title">本轮与会话用量</div>${rows.join('')}`;
  }

  /**
   * Binds the view to two elements: the always-visible context line, and the
   * panel that holds everything else. Hover opens the panel on pointer devices;
   * a click pins it, which is also the only way in on touch.
   */
  function createUsageReadout(deps) {
    const bar = deps && deps.bar;
    const panel = deps && deps.panel;
    if (!bar) return null;
    const doc = (deps && deps.document) || (typeof document !== 'undefined' ? document : null);
    let view = { summary: { text: '' }, details: [] };
    let open = false;
    let pinned = false;

    function paint() {
      if (!panel) return;
      panel.innerHTML = open ? detailHtml(view) : '';
      panel.style.display = open ? 'block' : 'none';
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      bar.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function setOpen(next, pin) {
      const wanted = next && view.details.length > 0;
      if (pin !== undefined) pinned = wanted ? pin : false;
      if (wanted === open) { paint(); return; }
      open = wanted;
      paint();
    }

    bar.addEventListener('mouseenter', () => setOpen(true));
    bar.addEventListener('mouseleave', () => { if (!pinned) setOpen(false); });
    bar.addEventListener('click', () => setOpen(!pinned, !pinned));
    bar.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!pinned, !pinned); }
      else if (event.key === 'Escape') setOpen(false, false);
    });
    if (panel) {
      panel.addEventListener('mouseenter', () => { if (open) setOpen(true); });
      panel.addEventListener('mouseleave', () => { if (!pinned) setOpen(false); });
    }
    if (doc) {
      doc.addEventListener('click', (event) => {
        if (!pinned) return;
        const target = event.target;
        if (bar.contains?.(target) || panel?.contains?.(target)) return;
        setOpen(false, false);
      }, true);
    }

    return {
      render(sources) {
        view = buildUsageView(sources);
        bar.innerHTML = summaryHtml(view);
        bar.title = view.summary.title || '';
        if (!view.details.length) { pinned = false; setOpen(false); } else paint();
      },
      isOpen: () => open,
      close: () => setOpen(false, false),
    };
  }

  return Object.freeze({ buildUsageView, createUsageReadout, compactTokens });
});
