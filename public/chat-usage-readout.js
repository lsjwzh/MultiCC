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
  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的沙箱里
  // 没有页面全局，也没有 require，所以三种取法都留着 —— 测试要么注入
  // MultiCCFormat，要么让它落到 require 上。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);
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

  // 文案一律走 i18n：浏览器里用 i18n.js 的 t()，Node 测试里没有它（断言按中文写），
  // 或者线上还是旧目录时，都回落到这里的中文默认值。两条路径都插值，结果一致。
  function tt(key, fallback, params) {
    const scope = typeof window !== 'undefined' ? window : null;
    const out = scope && typeof scope.t === 'function' ? scope.t(key, params) : '';
    if (out && out !== key) return out;
    return Object.keys(params || {}).reduce((text, name) => (
      text.split(`{${name}}`).join(String(params[name]))
    ), fallback);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // token 数、百分比颜色全部走全站唯一那份（shared/format.js）：
  //   · 紧凑 token 数（窗口大小、估算量）—— 两位有效数字，去尾零
  //   · 计费口径的 token 数（入/出/缓存）—— 百万两位小数，千位一位小数
  //   · 「窗口占了多少」的颜色 —— 门限表按 kind 取，上下文那条 80/50
  const compactTokens = value => FMT.formatCompactTokens(value);
  const k = value => FMT.formatTokenCount(value, { dropZeroDecimal: true });
  const pctColor = pct => FMT.usageColor(pct, 'context');

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
        text: tt('usageContextOverflow', '上下文 —'),
        title: tt('usageContextOverflowTitle',
          '本轮跨多次 API 请求合计上报 {tokens} tokens，超过 {window} 的窗口，无法据此折算单轮上下文占用。',
          { tokens: compactTokens(ctx.tokens), window: k(ctx.window) }),
        pct: 0,
        color: 'var(--faint)',
        hasBar: false,
        exact: false,
      };
    }
    if (!ctx.window) {
      return {
        text: tt('usageContextNoWindow', '上下文 {used}', { used: k(ctx.tokens) }),
        title: tt('usageContextNoWindowTitle', '当前模型的上下文窗口未知，只能给出占用量。'),
        pct: 0, color: '#8b949e', hasBar: false, exact: ctx.exact,
      };
    }
    const pct = Math.min(100, (ctx.tokens / ctx.window) * 100);
    const window = FMT.formatTokenCount(ctx.window, { dropZeroDecimal: true });
    return {
      text: ctx.exact
        ? tt('usageContextLine', '上下文 {used} / {window} · {pct}%',
          { used: k(ctx.tokens), window, pct: pct.toFixed(1) })
        : tt('usageContextLineEstimate', '上下文 ≈{used} / {window} · 约 {pct}%',
          { used: k(ctx.tokens), window, pct: pct.toFixed(1) }),
      title: tt(ctx.exact ? 'usageContextMeasuredTitle' : 'usageContextEstimatedTitle',
        ctx.exact
          ? '最近一次 API 请求实际带入的上下文（新增输入 + 缓存读 + 缓存写）。'
          : '本轮跨多次 API 请求合计上报，已剔除被重复计入的缓存读取；这是上下文占用的估算上限。'),
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
      label: tt('usageTurnBilled', '本轮计费'),
      value: tt('usageTurnBilledDetail', '新增输入 {fresh} · 缓存读 {read} · 缓存写 {write} · 输出 {out}',
        { fresh: fmt(fresh), read: fmt(read), write: fmt(write), out: fmt(out) }),
      title: tt('usageTurnBilledTitle', '这是计费口径：一轮里每次 API 请求都会把常驻前缀作为「缓存读」再算一遍，所以它远大于上下文占用。'),
    };
  }

  function providerRow(sources, formatWindow) {
    const windows = sources.providerWindows;
    if (!windows || typeof windows !== 'object') return null;
    const entries = [];
    const periods = [['today', 'usagePeriodDay', '日'], ['week', 'usagePeriodWeek', '周'], ['month', 'usagePeriodMonth', '月']];
    for (const [key, labelKey, fallback] of periods) {
      if (!windows[key]) continue;
      const text = formatWindow(windows[key]);
      if (text) entries.push(`${tt(labelKey, fallback)} ${text}`);
    }
    if (!entries.length && windows.all) {
      const text = formatWindow(windows.all);
      if (text) entries.push(tt('usagePeriodAll', '总 {v}', { v: text }));
    }
    if (!entries.length) return null;
    return {
      label: tt('usageProviderUsage', '{provider} 用量', { provider: sources.providerLabel || 'Provider' }),
      value: entries.join('\n'),
      title: tt('usageProviderUsageTitle', 'MultiCC 按供应商统计的 token 用量，与上下文占用无关。'),
    };
  }

  // 按原因统计的省略数 → [[reason, n], …]，只留正整数；非对象一律当没有。
  function omittedCountsOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value)
      .map(([reason, n]) => [reason, Math.floor(Number(n))])
      .filter(([, n]) => Number.isFinite(n) && n > 0);
  }

  // 新消息内嵌的是摘要（summary: true，只有 count，没有 sources/retained/omitted/
  // diagnostics），旧消息仍是完整对象；两种都归一成同一个形状，摘要态靠展开时
  // 拉到的明细（detailExpired / omittedCounts 也只在明细里）补全。
  function contextTraceOf(value) {
    if (!value || typeof value !== 'object' || !value.traceId || !value.currentTask) return null;
    const current = value.currentTask;
    const sources = Array.isArray(value.sources) ? value.sources.filter(source => (
      source && typeof source === 'object' && (source.id || source.taskId)
    )) : [];
    const summary = value.summary === true;
    const declared = Math.floor(Number(value.count));
    return {
      traceId: String(value.traceId),
      currentTask: {
        taskId: String(current.taskId || ''),
        taskName: String(current.taskName || current.taskId || tt('usageContextCurrent', '当前任务')),
      },
      sources,
      managedOnly: value.managedOnly === true,
      budget: value.budget, retained: value.retained || [], omitted: value.omitted || [], diagnostics: value.diagnostics || [],
      summary,
      detailExpired: value.detailExpired === true,
      omittedCounts: omittedCountsOf(value.omittedCounts),
      count: summary && Number.isFinite(declared) && declared >= 1 ? declared : 1 + sources.length,
    };
  }

  // 摘要态展开后拿到的完整明细：以摘要的 traceId / 当前任务为底，明细里有的字段覆盖，
  // 并强制不再是摘要（接口万一回了带 summary 的对象也不会再被当成待加载）。
  function expandedTraceOf(trace, full) {
    if (!trace || !trace.summary || !full || typeof full !== 'object') return trace;
    return contextTraceOf({
      ...full, summary: false, traceId: trace.traceId,
      currentTask: full.currentTask || trace.currentTask,
      budget: full.budget || trace.budget, managedOnly: full.managedOnly === true || trace.managedOnly,
    }) || trace;
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
      if (meta.turns) parts.push(tt('usageRounds', '{n} 轮', { n: meta.turns }));
      details.push({
        label: tt('usageTurnDuration', '本轮耗时'),
        value: parts.join(' · '),
        title: tt('usageTurnDurationTitle', '从提交到本轮结束的墙钟时间，以及 CLI 内部的往返轮数。'),
      });
    }

    const session = sources.sessionTokens && typeof sources.sessionTokens === 'object'
      ? sources.sessionTokens
      : null;
    const sessionTotal = session ? count(session.input) + count(session.output) : 0;
    if (sessionTotal > 0) {
      details.push({
        label: tt('usageSessionTotal', '会话累计'),
        value: tt('usageSessionTotalDetail', '{total} tokens（in {input} / out {output}）',
          { total: fmt(sessionTotal), input: fmt(session.input), output: fmt(session.output) }),
        title: tt('usageSessionTotalTitle', '整个会话累计的计费用量（含每次请求重复计入的缓存读取），不是当前上下文占用。'),
      });
    }

    const provider = providerRow(sources, formatWindow);
    if (provider) details.push(provider);

    return { summary: summaryOf(sources), details, contextTrace: contextTraceOf(sources.contextTrace) };
  }

  function summaryHtml(view) {
    const summary = view.summary;
    if (!summary.text) return '';
    const tone = summary.hasBar ? (summary.pct > 80 ? 'danger' : summary.pct > 50 ? 'warning' : 'success') : 'muted';
    const color = `var(--chat-${tone}, ${summary.color})`;
    const parts = [`<span class="usage-ctx-text" style="color:${color}">${escapeHtml(summary.text)}</span>`];
    if (summary.hasBar) {
      parts.push(`<span class="usage-ctx-meter"><span style="width:${summary.pct}%;background:${color}"></span></span>`);
    }
    if (view.contextTrace) {
      parts.push(`<span class="usage-context-link" aria-hidden="true">⌁ ${tt('usageContextSources', '引用 {n}', { n: view.contextTrace.count })}</span>`);
    }
    if (view.details.length) parts.push(`<span class="usage-ctx-more" aria-hidden="true">${tt('usageDetail', '详情')}</span>`);
    return parts.join('');
  }

  // 每个来源标签是 [i18n key, 中文默认值]：键用来查目录，值在拿不到 t() 时兜底。
  const GRAPH_KIND_LABELS = {
    parent: ['usageContextGraphParent', '图谱·父任务'],
    grandparent: ['usageContextGraphGrandparent', '图谱·祖父任务'],
    group: ['usageContextGraphGroup', '图谱·同组任务'],
    shell: ['usageContextGraphShell', '图谱·同壳前序'],
    memory: ['usageContextGraphMemory', '图谱·父任务记忆'],
    task: ['usageContextGraphTask', '任务图谱'],
  };
  const MEMORY_MODE_LABELS = {
    builtin: ['usageContextMemoryBuiltin', '记忆·预制'],
    machine: ['usageContextMemoryMachine', '记忆·机器全局'],
    cli: ['usageContextMemoryCli', '记忆·CLI'],
    shared: ['usageContextMemoryShared', '记忆·目录'],
    task: ['usageContextMemoryTask', '记忆·任务'],
    own: ['usageContextMemoryOwn', '记忆·私有'],
    skill: ['usageContextMemorySkill', '记忆·技能'],
    withdrawn: ['usageContextMemoryWithdrawn', '记忆·已撤回'],
  };

  function modeLabelOf(pair, fallbackKey, fallback) {
    return pair ? tt(pair[0], pair[1]) : tt(fallbackKey, fallback);
  }

  function modeLabel(mode) {
    if (mode === 'refilled') return tt('usageContextRefilled', '按需补取');
    const memory = /^memory:(.+)$/.exec(String(mode || ''));
    if (memory) return modeLabelOf(MEMORY_MODE_LABELS[memory[1]], 'usageContextMemoryOther', '记忆·检索');
    if (/^(task|context):/.test(mode)) return mode === 'task:current'
      ? tt('usageContextModeTaskCurrent', '当前任务信息')
      : tt('usageContextModeContext', '上下文规则与检查点');
    const graph = /^graph:(.+)$/.exec(String(mode || ''));
    if (graph) return modeLabelOf(GRAPH_KIND_LABELS[graph[1]], 'usageContextGraphTask', '任务图谱');
    return tt('usageContextImported', '初始化导入');
  }

  function sourceMessagesHtml(source) {
    if (!Array.isArray(source.messages) || !source.messages.length) return '';
    const messages = source.messages.map(message => {
      const role = message?.role === 'user'
        ? tt('usageContextRoleUser', '用户')
        : tt('usageContextRoleAssistant', '助手');
      const raw = typeof message?.content === 'string'
        ? message.content
        : JSON.stringify(message?.content ?? '');
      return `<div class="usage-context-message"><span>${role}</span>${escapeHtml(raw)}</div>`;
    }).join('');
    return `<details class="usage-context-details"><summary>${escapeHtml(tt('usageContextViewMessages', '查看 {n} 条引用消息', { n: source.messages.length }))}</summary>${messages}</details>`;
  }

  // 图谱上下文来源没有「消息」，只有实际注入的那一行节选。
  function sourceExcerptHtml(source) {
    const text = typeof source?.excerpt === 'string' ? source.excerpt.trim() : '';
    if (!text) return '';
    return `<details class="usage-context-details"><summary>${escapeHtml(tt('usageContextViewExcerpt', '查看注入节选'))}</summary>` +
      `<div class="usage-context-message"><span>${escapeHtml(tt('usageContextRoleInjected', '注入'))}</span>${escapeHtml(text)}</div></details>`;
  }

  // 来源行的灰色元信息。明细过期后部分来源只剩 id/version/reason（没有 mode），
  // 这时不编造「初始化导入 · 0 条消息」，只列实际有的几项。
  function sourceMetaOf(source) {
    const tail = `${Number(source.estimatedTokens) > 0 ? ` · ${tt('usageContextApproxTokens', '约 {n} tokens', { n: compactTokens(source.estimatedTokens) })}` : ''}` +
      `${Number(source.omittedExchanges) > 0 ? ` · ${tt('usageContextOmitted', '更早 {n} 轮未带入', { n: Number(source.omittedExchanges) })}` : ''}` +
      `${source.retained ? ` · ${tt('usageContextRetainedShort', '沿用（本轮未重发）')}` : ''}${source.truncated ? ` · ${tt('usageContextTruncated', '已截断')}` : ''}${source.version ? ` · v ${String(source.version).slice(0, 12)}` : ''}`;
    if (!source.mode) return tail.replace(/^ · /, '');
    const isGraph = /^(graph|memory|task|context):/.test(String(source.mode));
    return `${modeLabel(source.mode)}${isGraph ? '' : ` · ${tt('usageContextMessages', '{n} 条消息', { n: Number(source.messageCount) || 0 })}`}${tail}`;
  }

  // 省略原因：已知的几种给人话，没见过的原样显示（逐条清单里一直是原样）。
  const OMIT_REASON_LABELS = {
    not_relevant: ['usageContextOmitReasonNotRelevant', '与本轮无关'],
    budget: ['usageContextOmitReasonBudget', '超出上下文预算'],
    duplicate: ['usageContextOmitReasonDuplicate', '内容重复'],
    duplicate_in_native: ['usageContextOmitReasonDuplicateNative', '原生历史中已有'],
  };

  function omitReasonLabel(reason) {
    const pair = Object.prototype.hasOwnProperty.call(OMIT_REASON_LABELS, reason) ? OMIT_REASON_LABELS[reason] : null;
    return pair ? tt(pair[0], pair[1]) : String(reason);
  }

  // 省略总数。逐条清单和按原因计数可能覆盖同一批（预算类仍逐条列出），所以同一原因
  // 取两者较大值，不重复相加；没有计数时就是逐条清单的长度，和旧消息一致。
  function omittedTotal(trace) {
    if (!trace.omittedCounts.length) return trace.omitted.length;
    const counted = new Map(trace.omittedCounts);
    const listed = new Map();
    for (const item of trace.omitted) listed.set(item.reason, (listed.get(item.reason) || 0) + 1);
    let total = 0;
    for (const reason of new Set([...counted.keys(), ...listed.keys()])) {
      total += Math.max(counted.get(reason) || 0, listed.get(reason) || 0);
    }
    return total;
  }

  function omissionsHtml(trace) {
    if (!trace.omitted.length && !trace.omittedCounts.length) return '';
    const counts = trace.omittedCounts.map(([reason, n]) => (
      `<div>${escapeHtml(tt('usageContextOmittedCount', '{reason} {n} 条', { reason: omitReasonLabel(reason), n: FMT.groupedNumber(n) }))}</div>`
    )).join('');
    return `<details><summary>${escapeHtml(tt('usageContextViewOmitted', '查看省略原因'))}</summary>${counts}${trace.omitted.map(s => `<div>${escapeHtml(s.id)} · ${escapeHtml(s.reason)}</div>`).join('')}</details>`;
  }

  function contextTraceHtml(trace, detail, state) {
    if (!trace) return '';
    const sourceDetails = detail && Array.isArray(detail.sources) ? detail.sources : [];
    const byKey = new Map(sourceDetails.map(source => [source.id || `${source.mode}:${source.taskId}`, source]));
    const rows = [
      `<div class="usage-context-source"><span class="usage-context-kind">${escapeHtml(tt('usageContextCurrentNative', '当前任务 · 原生上下文'))}</span>` +
      `<strong>${escapeHtml(trace.currentTask.taskName)}</strong><code>${escapeHtml(trace.currentTask.taskId)}</code></div>`,
      ...trace.sources.map(source => {
        const full = byKey.get(source.id || `${source.mode}:${source.taskId}`) || source;
        const meta = sourceMetaOf(source);
        const name = source.taskName || source.taskId;
        return `<div class="usage-context-source">${meta ? `<span class="usage-context-kind">${escapeHtml(meta)}</span>` : ''}` +
          `${name || source.mode ? `<strong>${escapeHtml(name)}</strong>` : ''}<code>${escapeHtml(source.path || source.id || source.taskId)}</code>` +
          `${source.reason ? `<small>${escapeHtml(source.reason)}</small>` : ''}${sourceMessagesHtml(full)}${sourceExcerptHtml(full)}</div>`;
      }),
    ];
    // 摘要态：明细还没到（读取中 / 失败），这时没有沿用与省略的清单，不能把它们显示成 0。
    const pending = trace.summary === true;
    let action = '';
    if (trace.sources.length && !detail) {
      action = `<button type="button" class="usage-context-load"${state.loading ? ' disabled' : ''}>` +
        `${state.loading ? tt('usageContextLoading', '正在读取…') : tt('usageContextViewSources', '查看引用内容')}</button>`;
    }
    if (pending && state.error && !state.loading) action += `<button type="button" class="usage-context-load">${escapeHtml(tt('retry', '重试'))}</button>`;
    if (state.error) action += `<span class="usage-context-error">${escapeHtml(state.error)}</span>`;
    const status = pending && state.loading ? `<div class="usage-context-scope">${escapeHtml(tt('usageContextLoading', '正在读取…'))}</div>` : '';
    const budgetText = trace.budget ? escapeHtml(tt('usageContextBudget', '托管上下文：约 {used} / {limit} tokens', { used: Number(trace.budget.used), limit: Number(trace.budget.limit) })) : '';
    const selection = pending ? '' : ` · ${escapeHtml(tt('usageContextSelection', '沿用 {kept} 项 · 省略 {omitted} 项', { kept: trace.retained.length, omitted: omittedTotal(trace) }))}`;
    const budget = trace.budget ? `<div class="usage-context-scope">${budgetText}${selection}</div>` : '';
    const expired = trace.detailExpired ? `<div class="usage-context-scope">${escapeHtml(tt('usageContextDetailExpired', '这一轮较早，沿用与省略明细已清理，仅保留实际注入的来源'))}</div>` : '';
    const diagnostics = trace.diagnostics.map(s => `<div class="usage-context-error">${escapeHtml(s.path || '')} ${escapeHtml(s.reason)}</div>`).join('');
    return `<div class="usage-context-section"><div class="usage-context-title">${escapeHtml(tt('usageContextSourcesTitle', '⌁ 本轮引用来源'))}</div>${budget}${status}${omissionsHtml(trace)}${diagnostics}${expired}` +
      `${rows.join('')}${action}<div class="usage-context-scope">${escapeHtml(tt('usageContextManagedScope', '这里只列出 MultiCC 可验证的引用；模型原生历史、系统提示和临时工具读取不属于逐 token 拆分。'))}</div></div>`;
  }

  function detailHtml(view, traceDetail = null, traceState = {}) {
    if (!view.details.length && !view.contextTrace) return '';
    const rows = view.details.map(row => (
      `<div class="usage-detail-row"${row.title ? ` title="${escapeHtml(row.title)}"` : ''}>` +
      `<span class="usage-detail-label">${escapeHtml(row.label)}</span>` +
      `<span class="usage-detail-value">${escapeHtml(row.value).replace(/\n/g, '<br>')}</span>` +
      '</div>'
    ));
    const usage = rows.length ? `<div class="usage-detail-title">${escapeHtml(tt('usageDetailTitle', '本轮与会话用量'))}</div>${rows.join('')}` : '';
    return `${usage}${contextTraceHtml(view.contextTrace, traceDetail, traceState)}`;
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
    let traceFull = null;      // 摘要 trace 展开时拉到的完整明细（不带消息正文）
    let traceDetail = null;    // 点「查看引用内容」后拉到的明细（带消息正文 / 节选）
    let traceLoading = false;
    let traceError = '';

    // 新消息内嵌的只是摘要：先展开成完整明细再渲染；明细没到之前就是待加载的摘要。
    function shownView() {
      const trace = expandedTraceOf(view.contextTrace, traceFull);
      return trace === view.contextTrace ? view : { ...view, contextTrace: trace };
    }
    function paint() {
      if (!panel) return;
      panel.innerHTML = open ? detailHtml(shownView(), traceDetail, { loading: traceLoading, error: traceError }) : '';
      panel.style.display = open ? 'block' : 'none';
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      bar.setAttribute('aria-expanded', open ? 'true' : 'false');
      loadSummaryDetail();
    }
    // includeMessages=false 拉摘要对应的完整明细，true 才连带消息正文 / 节选。
    async function fetchTrace(includeMessages) {
      const load = deps && deps.loadContextTrace;
      const trace = view.contextTrace;
      if (typeof load !== 'function' || !trace || traceLoading) return;
      traceLoading = true;
      traceError = '';
      paint();
      let loaded = null;
      let failure = '';
      try {
        loaded = await load(trace, { includeMessages });
        if (!includeMessages && (!loaded || typeof loaded !== 'object')) failure = tt('usageContextLoadFailedShort', '引用内容读取失败');
      } catch (error) { failure = error?.message || tt('usageContextLoadFailedShort', '引用内容读取失败'); }
      // 等待期间换了一轮（render 已重置状态）：这份结果不属于现在的 trace。
      if (view.contextTrace?.traceId !== trace.traceId) return;
      traceLoading = false;
      if (failure) traceError = failure;
      else if (includeMessages) traceDetail = loaded;
      else traceFull = loaded;
      paint();
    }
    // 展开面板时摘要态自动补一次明细；失败后不自动重试（悬停抖动会反复打接口），
    // 由「重试」按钮显式再拉。
    function loadSummaryDetail() {
      if (open && view.contextTrace?.summary && !traceFull && !traceLoading && !traceError) fetchTrace(false);
    }
    function setOpen(next, pin) {
      const wanted = next && (view.details.length > 0 || !!view.contextTrace);
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
      panel.addEventListener('click', async (event) => {
        if (!event.target?.closest?.('.usage-context-load') || traceLoading || !view.contextTrace) return;
        await fetchTrace(!(view.contextTrace.summary && !traceFull));
      });
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
        const previousTraceId = view.contextTrace?.traceId || null;
        view = buildUsageView(sources);
        if ((view.contextTrace?.traceId || null) !== previousTraceId) {
          traceFull = null;
          traceDetail = null;
          traceLoading = false;
          traceError = '';
        }
        bar.innerHTML = summaryHtml(view);
        bar.title = view.summary.title || '';
        bar.setAttribute('aria-label', view.contextTrace
          ? tt('usageContextAriaCount', '上下文占用详情，{n} 个可追溯来源', { n: view.contextTrace.count })
          : tt('usageContextAria', '上下文占用详情'));
        if (!view.details.length && !view.contextTrace) { pinned = false; setOpen(false); } else paint();
      },
      isOpen: () => open,
      close: () => setOpen(false, false),
    };
  }

  return Object.freeze({ buildUsageView, createUsageReadout, compactTokens });
});
