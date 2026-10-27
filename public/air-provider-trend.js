'use strict';

// Provider 卡片上的「余量走势」。
//
// 数据来自 GET /api/providers/limit-history（采样由 native/core/src/quota_history.rs
// 持有，一行一个读数）。这里只做两件事：
//   1. 卡片内联一条迷你曲线（5 小时 / 7 天 / 1 个月 / 余额），点卡片展开详情；
//   2. 详情弹层画带坐标轴的大图、图例、当前值，并按最近一段的斜率估算用完时间。
//
// 曲线点已经是服务端降采样后的 [[epochMs, value], ...]；所有输入都当作不可信：
// 非有限数字、逆序时间、超长 label 一律丢弃。没有数据就不画，而不是画一条假线。

(function initAirProviderTrend(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ORDER = ['5h', '1wk', '1m', 'balance'];
  const COLORS = Object.freeze({
    '5h': '#2f81f7',
    '1wk': '#d29922',
    '1m': '#2ea043',
    balance: '#8b5cf6',
    default: '#8b949e',
  });
  const WINDOW_KEYS = Object.freeze({
    '5h': 'airProviderTrendWindow5h',
    '1wk': 'airProviderTrendWindow1wk',
    '1m': 'airProviderTrendWindow1m',
  });
  const MAX_POINTS = 240;
  const PROJECT_WINDOW_MS = 2 * 60 * 60 * 1000;
  const MIN_PROJECT_SPAN_MS = 10 * 60 * 1000;

  const translate = (key, params, fallback) => {
    const value = typeof root.t === 'function' ? root.t(key, params) : null;
    return value && value !== key ? value : fallback;
  };
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const svg = (tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value != null) node.setAttribute(key, String(value));
    }
    return node;
  };
  const finite = value => (Number.isFinite(Number(value)) ? Number(value) : null);

  function normalizePoints(value) {
    if (!Array.isArray(value)) return [];
    const points = [];
    for (const point of value) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const at = finite(point[0]);
      const amount = finite(point[1]);
      if (at == null || amount == null || at <= 0) continue;
      points.push([at, amount]);
    }
    points.sort((left, right) => left[0] - right[0]);
    return points.slice(-MAX_POINTS);
  }

  function normalizeResponse(response) {
    const out = new Map();
    if (!response || response.available === false) return out;
    const providers = response.providers;
    if (!providers || typeof providers !== 'object') return out;
    for (const [key, value] of Object.entries(providers)) {
      if (!value || typeof value !== 'object' || !value.series || typeof value.series !== 'object') continue;
      const series = {};
      for (const [name, item] of Object.entries(value.series)) {
        if (!item || typeof item !== 'object') continue;
        const points = normalizePoints(item.points);
        if (!points.length) continue;
        const last = points[points.length - 1];
        const unit = item.unit === 'percent' ? 'percent' : 'amount';
        series[name] = Object.freeze({
          name,
          label: typeof item.label === 'string' ? item.label.slice(0, 24) : name,
          unit,
          currency: unit === 'amount' && typeof item.unit === 'string' && item.unit !== 'amount'
            ? item.unit.slice(0, 12) : null,
          points,
          last: last[1],
          lastAt: last[0],
          resetAt: finite(item.resetAt),
        });
      }
      if (!Object.keys(series).length) continue;
      out.set(key, Object.freeze({ series: Object.freeze(series), updatedAt: finite(value.updatedAt) || 0 }));
    }
    return out;
  }

  const keyOf = provider => `${provider.appType}:${provider.id}`;

  function entryFor(trend, provider) {
    return trend && typeof trend.get === 'function' ? trend.get(keyOf(provider)) || null : null;
  }

  function orderedSeriesList(entry) {
    if (!entry || !entry.series) return [];
    return Object.values(entry.series).sort((left, right) => {
      const a = ORDER.indexOf(left.name);
      const b = ORDER.indexOf(right.name);
      return (a < 0 ? ORDER.length : a) - (b < 0 ? ORDER.length : b);
    });
  }

  function colorOf(item) {
    return COLORS[item && item.name] || COLORS.default;
  }

  function seriesLabel(item) {
    const key = WINDOW_KEYS[item.name];
    if (key) return translate(key, null, item.name);
    if (item.name === 'balance') return translate('airProviderTrendBalance', null, 'Balance');
    return item.label || item.name;
  }

  function formatAmount(value) {
    const absolute = Math.abs(value);
    const digits = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
    return value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
  }

  function seriesValue(item) {
    if (item.unit === 'percent') {
      const rounded = Math.round(item.last);
      return translate('airProviderTrendPercent', { value: rounded }, `${rounded}%`);
    }
    return `${formatAmount(item.last)}${item.currency ? ` ${item.currency}` : ''}`;
  }

  // SVG 坐标：remaining 越高越靠上。
  function sparklinePath(points, box) {
    if (!points || !points.length) return '';
    const start = points[0][0];
    const span = Math.max(1, points[points.length - 1][0] - start);
    const min = finite(box && box.min) || 0;
    const max = finite(box && box.max);
    const top = max == null || max <= min ? min + 1 : max;
    return points.map(([at, value], index) => {
      const x = points.length === 1 ? box.width : (at - start) / span * box.width;
      const ratio = Math.max(0, Math.min(1, (value - min) / (top - min)));
      const y = box.height - ratio * box.height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }

  function seriesRange(item) {
    if (item.unit === 'percent') return { min: 0, max: 100 };
    let max = 0;
    for (const [, value] of item.points) max = Math.max(max, value);
    return { min: 0, max: max > 0 ? max : 1 };
  }

  function renderInline(provider, entry, options = {}) {
    const list = orderedSeriesList(entry);
    if (!list.length) return null;
    const box = make('div', null, 'air-provider-trend');
    box.dataset.trend = keyOf(provider);
    const head = make('div', null, 'air-provider-trend-head');
    head.append(make('span', translate('airProviderTrendTitle', null, 'Quota trend'), 'air-provider-trend-title'));
    const values = make('span', null, 'air-provider-trend-values');
    for (const item of list.slice(0, 3)) {
      const chip = make('span', null, 'air-provider-trend-chip');
      const dot = make('i', null, 'air-provider-trend-dot');
      dot.style.background = colorOf(item);
      chip.append(dot, make('span', `${seriesLabel(item)} ${seriesValue(item)}`));
      values.append(chip);
    }
    head.append(values);
    const chart = svg('svg', {
      viewBox: '0 0 100 30',
      preserveAspectRatio: 'none',
      class: 'air-provider-trend-svg',
      'aria-hidden': 'true',
    });
    for (const item of list.slice(0, 3)) {
      const range = seriesRange(item);
      const path = sparklinePath(item.points, { width: 100, height: 30, min: range.min, max: range.max });
      if (!path) continue;
      if (item === list[0] && item.points.length > 2) {
        chart.append(svg('path', {
          d: `${path} L100,30 L0,30 Z`,
          fill: colorOf(item),
          'fill-opacity': 0.08,
          stroke: 'none',
        }));
      }
      chart.append(svg('path', {
        d: path,
        fill: 'none',
        stroke: colorOf(item),
        'stroke-width': 1.4,
        'vector-effect': 'non-scaling-stroke',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }));
    }
    box.append(head, chart);
    box.title = translate('airProviderTrendOpen', null, 'View trend details');
    if (typeof options.onOpen === 'function') {
      // 键盘可达：趋势块本身是一个按钮，回车/空格展开详情；卡片点击也会打开。
      box.tabIndex = 0;
      box.setAttribute('role', 'button');
      box.setAttribute('aria-haspopup', 'dialog');
      box.setAttribute('aria-label', translate('airProviderTrendOpen', null, 'View trend details'));
      box.onclick = event => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        options.onOpen();
      };
      box.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); options.onOpen(); }
      };
    }
    return box;
  }

  function formatTime(ms, locale) {
    const value = finite(ms);
    if (value == null) return '';
    try {
      return new Date(value).toLocaleString(locale || undefined, {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch (_) {
      return new Date(value).toISOString().slice(5, 16).replace('T', ' ');
    }
  }

  // Linear fit over the recent window; only a falling percent line can be
  // projected. Returns null when the reading is too short, flat, or would be
  // overtaken by the window reset.
  function projectExhaustion(item, { nowMs = Date.now() } = {}) {
    if (!item || item.unit !== 'percent' || item.points.length < 3) return null;
    const recent = item.points.filter(([at]) => at >= nowMs - PROJECT_WINDOW_MS);
    const points = recent.length >= 3 ? recent : item.points.slice(-4);
    const span = points[points.length - 1][0] - points[0][0];
    if (span < MIN_PROJECT_SPAN_MS) return null;
    const base = points[0][0];
    const n = points.length;
    let sumX = 0; let sumY = 0; let sumXY = 0; let sumXX = 0;
    for (const [at, value] of points) {
      const x = (at - base) / 60_000;
      sumX += x; sumY += value; sumXY += x * value; sumXX += x * x;
    }
    const denominator = n * sumXX - sumX * sumX;
    if (!denominator) return null;
    const slope = (n * sumXY - sumX * sumY) / denominator;
    if (!Number.isFinite(slope) || slope >= -0.01) return null;
    const lastAt = points[points.length - 1][0];
    const last = points[points.length - 1][1];
    if (last <= 0) return { etaMs: lastAt, slope };
    const etaMs = lastAt + (-last / slope) * 60_000;
    if (!Number.isFinite(etaMs) || etaMs <= lastAt) return null;
    if (item.resetAt && etaMs > item.resetAt) return null;
    return { etaMs, slope };
  }

  function buildChart(list, { nowMs = Date.now() } = {}) {
    const width = 680;
    const height = 240;
    const pad = { left: 40, right: 14, top: 14, bottom: 26 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const percentMode = list[0] && list[0].unit === 'percent';
    const projections = [];
    for (const item of list) {
      const projection = projectExhaustion(item, { nowMs });
      if (projection) projections.push({ item, ...projection });
    }
    let start = Infinity;
    let end = -Infinity;
    for (const item of list) {
      start = Math.min(start, item.points[0][0]);
      end = Math.max(end, item.points[item.points.length - 1][0]);
    }
    end = Math.max(end, nowMs);
    for (const projection of projections) {
      end = Math.max(end, Math.min(projection.etaMs, nowMs + 7 * 24 * 60 * 60 * 1000));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      end = start + 60 * 60 * 1000;
    }
    end += Math.max(60_000, (end - start) * 0.02);
    const span = end - start;
    const maxAmount = percentMode ? 100 : Math.max(1, ...list.map(item => seriesRange(item).max));
    const xFor = at => pad.left + ((at - start) / span) * innerW;
    const yFor = value => pad.top + innerH - (Math.max(0, Math.min(maxAmount, value)) / maxAmount) * innerH;

    const chart = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'air-provider-trend-chart',
      role: 'img',
    });
    const gridValues = percentMode ? [0, 25, 50, 75, 100] : [0, maxAmount / 2, maxAmount];
    for (const value of gridValues) {
      const y = yFor(value);
      chart.append(svg('line', {
        x1: pad.left, x2: width - pad.right, y1: y, y2: y,
        stroke: '#e3ebf3', 'stroke-width': 1,
      }));
      const label = svg('text', { x: pad.left - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: '#8b949e' });
      label.textContent = percentMode ? `${value}%` : formatAmount(value);
      chart.append(label);
    }
    const axisStart = svg('text', { x: pad.left, y: height - 8, 'font-size': 10, fill: '#8b949e' });
    axisStart.textContent = formatTime(start, root.getLocale?.());
    const axisEnd = svg('text', { x: width - pad.right, y: height - 8, 'text-anchor': 'end', 'font-size': 10, fill: '#8b949e' });
    axisEnd.textContent = formatTime(end, root.getLocale?.());
    chart.append(axisStart, axisEnd);

    for (const item of list) {
      const range = seriesRange(item);
      const scale = percentMode ? 100 : range.max;
      const path = sparklinePath(item.points, { width: innerW, height: innerH, min: 0, max: scale });
      if (path) {
        const shifted = path.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
          (_, x, y) => `${pad.left + Number(x)},${pad.top + Number(y)}`);
        chart.append(svg('path', {
          d: shifted,
          fill: 'none',
          stroke: colorOf(item),
          'stroke-width': 2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }));
      }
      const last = item.points[item.points.length - 1];
      chart.append(svg('circle', {
        cx: xFor(last[0]), cy: yFor(last[1]), r: 3, fill: colorOf(item),
      }));
      const projection = projections.find(entry => entry.item === item);
      if (projection) {
        chart.append(svg('line', {
          x1: xFor(last[0]), y1: yFor(last[1]),
          x2: xFor(projection.etaMs), y2: yFor(0),
          stroke: colorOf(item), 'stroke-width': 1.4, 'stroke-dasharray': '5 4', 'stroke-opacity': 0.7,
        }));
      }
    }
    return { chart, projections };
  }

  function rangeLabel(range) {
    if (range === '7d') return translate('airProviderTrendRange7d', null, '7 days');
    if (range === '30d') return translate('airProviderTrendRange30d', null, '30 days');
    return translate('airProviderTrendRange24h', null, '24 hours');
  }

  function legendBlock(list) {
    const legend = make('div', null, 'air-provider-trend-legend');
    for (const item of list) {
      const row = make('div', null, 'air-provider-trend-legend-row');
      const dot = make('i', null, 'air-provider-trend-dot');
      dot.style.background = colorOf(item);
      row.append(dot, make('span', seriesLabel(item), 'air-provider-trend-legend-label'), make('strong', seriesValue(item)));
      if (item.resetAt) {
        row.append(make('span', translate('airProviderTrendReset', { time: formatTime(item.resetAt, root.getLocale?.()) }, ''), 'air-provider-trend-legend-reset'));
      }
      legend.append(row);
    }
    return legend;
  }

  function metaLine(entry, list) {
    const points = list.reduce((sum, item) => sum + item.points.length, 0);
    if (!points) return '';
    const first = Math.min(...list.map(item => item.points[0][0]));
    const last = Math.max(...list.map(item => item.points[item.points.length - 1][0]));
    return translate('airProviderTrendSamples', {
      count: points,
      from: formatTime(first, root.getLocale?.()),
      to: formatTime(last, root.getLocale?.()),
    }, '');
  }

  function openDetail(provider, entry, options = {}) {
    if (!document.body || !provider) return null;
    const api = typeof options.api === 'function' ? options.api : null;
    const name = options.name || provider.name || provider.id;
    const dialog = make('dialog', null, 'provider-dialog service-dialog air-provider-trend-dialog');
    const form = make('form');
    form.method = 'dialog';
    const head = make('div', null, 'section-heading');
    const title = make('div');
    const heading = make('h2', `${name} · ${rangeLabel('24h')}`);
    title.append(make('span', translate('airProviderTrendDetailTitle', null, 'Quota trend'), 'eyebrow'), heading);
    const close = make('button', '×');
    close.type = 'button';
    close.onclick = () => dialog.close();
    head.append(title, close);
    const body = make('div', null, 'air-provider-trend-detail');
    form.append(head, body);
    dialog.append(form);
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();

    function paint(range, currentEntry) {
      const list = orderedSeriesList(currentEntry);
      body.replaceChildren();
      heading.textContent = `${name} · ${rangeLabel(range)}`;
      if (!list.length) {
        body.append(make('p', translate('airProviderTrendEmpty', null, 'No trend samples yet.'), 'admin-empty'));
        return;
      }
      body.append(legendBlock(list));
      const { chart, projections } = buildChart(list, { nowMs: options.now || Date.now() });
      body.append(chart);
      const captionLines = projections.map(projection => translate('airProviderTrendProjected', {
        time: formatTime(projection.etaMs, root.getLocale?.()),
      }, ''));
      if (!projections.length && list.some(item => item.unit === 'percent')) {
        captionLines.push(translate('airProviderTrendNoProjection', null, ''));
      }
      if (captionLines.some(Boolean)) {
        const caption = make('div', null, 'air-provider-trend-caption');
        for (const line of captionLines) caption.append(make('p', line));
        body.append(caption);
      }
      const meta = metaLine(currentEntry, list);
      if (meta) body.append(make('p', meta, 'air-provider-trend-meta'));
    }

    paint('24h', entry);
    if (api) {
      const query = `appType=${encodeURIComponent(provider.appType)}&id=${encodeURIComponent(provider.id)}&range=7d&points=120`;
      api(`/api/providers/limit-history?${query}`)
        .then(response => {
          const next = normalizeResponse(response).get(keyOf(provider));
          if (next && body.isConnected !== false) paint('7d', next);
        })
        .catch(error => {
          body.append(make('p', translate('airProviderTrendLoadFailed', { message: String(error && error.message || error) }, ''), 'air-provider-trend-error'));
        });
    }
    return dialog;
  }

  root.MultiCCProviderTrend = Object.freeze({
    normalizeResponse,
    entryFor,
    orderedSeriesList,
    renderInline,
    openDetail,
    sparklinePath,
    projectExhaustion,
    buildChart,
    seriesValue,
    keyOf,
  });
})(typeof window !== 'undefined' ? window : null);
