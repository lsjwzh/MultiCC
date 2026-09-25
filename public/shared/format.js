'use strict';

// ONE source for every number the product puts in front of a reader: byte
// sizes, relative times, elapsed spans, token counts and the tone a usage
// percentage is painted with.
//
// Before this file each page carried its own arithmetic, and the copies had
// already drifted: `formatSize` existed eight times in public/ (KB with one
// decimal here, KB rounded to whole numbers there, MB with two decimals
// somewhere else, "always MB" in the iOS OTA page), relative time had four
// thresholds tables (5s / 10s / 60s / seconds-tier-absent) and three of them
// were hard-wired Chinese on a page that ships an English locale, `fmtDuration`
// produced `1m3s` on one surface and `1m 3s` on the next, and the same
// "percentage of a window" was coloured red at 80% in the chat readout and at
// 90% in the provider quota chip.
//
// Load it as a classic script, right after shared/dom-helpers.js — it publishes
// `window.MultiCCFormat` plus the individual globals so a page-local file can
// call `formatBytes(...)` without a namespace hop. Node tests require() it
// directly, which is why every function here is pure, takes the clock as an
// argument when it needs one, and never touches the DOM.
//
// The Flutter mirror is app/lib/utils/format.dart. tests/test-format-parity.js
// parses that file and fails if the two ends disagree about a table, and both
// ends run the same fixture (tests/fixtures/format-cases.json) so a change that
// is only made on one side fails on both.
//
// Deliberately NOT here: absolute wall-clock formatting (`toLocaleString()` and
// its per-page option objects — a date is a locale concern, not a unit), exact
// token counts with thousands separators (a reader comparing two exact numbers
// wants no compaction), and counting logic such as "how full is the window" —
// this file formats numbers, it does not decide which number to show.
(function attachMultiCCFormat(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MultiCCFormat = api;
    root.formatBytes = api.formatBytes;
    root.formatRelativeTime = api.formatRelativeTime;
    root.formatDuration = api.formatDuration;
    root.formatPercent = api.formatPercent;
    root.formatTokenCount = api.formatTokenCount;
    root.formatCompactTokens = api.formatCompactTokens;
    root.usageTone = api.usageTone;
    root.usageColor = api.usageColor;
  }
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  'use strict';

  // ── i18n ──────────────────────────────────────────────────────────────────
  // The pages that own a catalog call this module with window.t present; the
  // terminal page and every Node test do not. `FALLBACK` below is the zh copy,
  // so a test asserts the same words the browser shows and the golden quota-bar
  // fixture (generated in Node) stays byte-identical.
  function interpolate(text, params) {
    if (!params) return text;
    let out = text;
    for (const name of Object.keys(params)) out = out.split(`{${name}}`).join(String(params[name]));
    return out;
  }

  function translate(key, params) {
    const scope = typeof window !== 'undefined' ? window : null;
    const out = scope && typeof scope.t === 'function' ? scope.t(key, params) : '';
    if (out && out !== key) return out;
    return interpolate(RELATIVE_FALLBACK[key] || key, params);
  }

  /** null for '', null, undefined, booleans, NaN and Infinity — never for 0. */
  function finiteNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /** A token/message count: negatives and junk collapse to 0, never to NaN. */
  function count(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  const opt = (options, name, fallback) => {
    const value = options ? options[name] : undefined;
    return value === undefined || value === null ? fallback : value;
  };

  // ── Byte sizes ────────────────────────────────────────────────────────────
  // Binary units (1024). `BYTE_UNITS` is the whole vocabulary: a surface that
  // stopped at MB used to print `2048.0 MB` for a 2 GB artifact.
  const BYTE_BASE = 1024;
  const BYTE_UNITS = Object.freeze(['B', 'KB', 'MB', 'GB', 'TB', 'PB']);
  const BYTE_DEFAULT_DECIMALS = 1;
  const BYTE_DEFAULT_MAX_UNIT = 'TB';

  /**
   * `formatBytes(1536)` → `'1.5 KB'`, `formatBytes(0)` → `'0 B'`.
   *
   * Bytes are never given a decimal (`'512 B'`, not `'512.0 B'`).
   *
   * options:
   *   decimals      digits for every unit above B (default 1)
   *   unitDecimals  `{ MB: 2 }` — per-unit override, for the two surfaces whose
   *                 precision is a contract rather than a taste (see below)
   *   space         false renders `'1.5KB'`
   *   maxUnit       never promotes past this unit
   *   placeholder   returned for null / NaN / Infinity / negative
   *   zeroIsMissing treats 0 as "no value" too (an unpublished 0-byte artifact)
   *
   * `unitDecimals` earns its keep exactly twice, and both are pinned by a test:
   * the Air Ops download rows round KB to a whole number (`'512 KB'`, the same
   * figure the manage panel prints for the same file) and the agent-resources
   * panel keeps two decimals for MB so the number can be checked against `du`.
   */
  function formatBytes(bytes, options) {
    const placeholder = opt(options, 'placeholder', '');
    const value = finiteNumber(bytes);
    if (value === null || value < 0) return placeholder;
    if (value === 0 && opt(options, 'zeroIsMissing', false)) return placeholder;

    const units = opt(options, 'units', BYTE_UNITS);
    const maxUnit = opt(options, 'maxUnit', BYTE_DEFAULT_MAX_UNIT);
    const maxIndex = Math.max(0, units.indexOf(maxUnit));
    const decimals = finiteNumber(opt(options, 'decimals', BYTE_DEFAULT_DECIMALS));
    const unitDecimals = opt(options, 'unitDecimals', null) || {};

    let index = 0;
    let scaled = value;
    while (scaled >= BYTE_BASE && index < maxIndex) { scaled /= BYTE_BASE; index += 1; }

    const unit = units[index];
    const perUnit = finiteNumber(unitDecimals[unit]);
    const digits = index === 0 ? 0 : (perUnit === null ? decimals : perUnit);
    const space = opt(options, 'space', true);
    return `${scaled.toFixed(digits)}${space ? ' ' : ''}${unit}`;
  }

  // ── Relative time ─────────────────────────────────────────────────────────
  // One threshold table, walked top to bottom. `maxSeconds` is exclusive; the
  // last tier is unbounded. `divisor` turns elapsed seconds into the unit the
  // tier counts in.
  const RELATIVE_TIERS = Object.freeze([
    Object.freeze({ maxSeconds: 5, divisor: 1, tier: 'justNow' }),
    Object.freeze({ maxSeconds: 60, divisor: 1, tier: 'seconds' }),
    Object.freeze({ maxSeconds: 3600, divisor: 60, tier: 'minutes' }),
    Object.freeze({ maxSeconds: 86400, divisor: 3600, tier: 'hours' }),
    Object.freeze({ maxSeconds: Infinity, divisor: 86400, tier: 'days' }),
  ]);

  // tier → i18n key. The compact set differs from the full one in the seconds
  // tier ONLY: the quota bar sits in a strip that is already tight with three
  // window segments, so it says `57s 前` where a sentence has room for `57 秒前`.
  const RELATIVE_KEYS = Object.freeze({
    justNow: 'justNow', seconds: 'secondsAgo', minutes: 'minutesAgo',
    hours: 'hoursAgo', days: 'daysAgo',
  });
  const RELATIVE_KEYS_COMPACT = Object.freeze({
    justNow: 'justNow', seconds: 'secondsAgoCompact', minutes: 'minutesAgo',
    hours: 'hoursAgo', days: 'daysAgo',
  });
  // zh, used when there is no catalog (Node tests, the terminal page). Keeps the
  // generated quota-bar fixture identical to what the browser renders in zh.
  const RELATIVE_FALLBACK = Object.freeze({
    justNow: '刚刚',
    secondsAgo: '{n} 秒前',
    secondsAgoCompact: '{n}s 前',
    minutesAgo: '{n} 分钟前',
    hoursAgo: '{n} 小时前',
    daysAgo: '{n} 天前',
  });

  /**
   * `formatRelativeTime(Date.now() - 90_000)` → `'1 分钟前'`.
   *
   * options:
   *   now         clock injection (default Date.now())
   *   placeholder returned for a missing / zero / negative / unparseable stamp
   *   compact     use the compact seconds tier (the quota bar)
   *
   * A future stamp clamps to "just now" rather than counting backwards.
   */
  function formatRelativeTime(tsMs, options) {
    const ts = finiteNumber(tsMs);
    if (ts === null || ts <= 0) return opt(options, 'placeholder', '');
    const now = finiteNumber(opt(options, 'now', Date.now()));
    const clock = now === null ? Date.now() : now;
    const seconds = Math.max(0, Math.floor((clock - ts) / 1000));
    const keys = opt(options, 'compact', false) ? RELATIVE_KEYS_COMPACT : RELATIVE_KEYS;
    for (const tier of RELATIVE_TIERS) {
      if (seconds >= tier.maxSeconds) continue;
      const key = keys[tier.tier];
      if (tier.tier === 'justNow') return translate(key, null);
      return translate(key, { n: Math.floor(seconds / tier.divisor) });
    }
    return opt(options, 'placeholder', '');
  }

  // ── Elapsed spans ─────────────────────────────────────────────────────────
  // A measured wall-clock span: sub-second stays in ms (a tool that took 900ms
  // must not read "0.9s" next to one that took 1.1s), under a minute keeps one
  // decimal only while the number is small enough for it to mean something, and
  // past a minute the seconds are spelled out separately.
  //
  // This is NOT the localized `1分05秒` duration (formatRunDuration on the
  // Flutter side, `durationMinutesSeconds` in the catalog): that one is a
  // sentence about how long something ran, this one is a measurement suffix.
  const SPAN_MS_LIMIT = 1000;
  const SPAN_SECONDS_LIMIT = 60;
  const SPAN_DECIMAL_LIMIT = 10;

  /** `formatDuration(75000)` → `'1m 15s'`; `''` for null / negative / NaN. */
  function formatDuration(ms) {
    const value = finiteNumber(ms);
    if (value === null || value < 0) return '';
    if (value < SPAN_MS_LIMIT) return `${Math.round(value)}ms`;
    const seconds = value / 1000;
    if (seconds < SPAN_SECONDS_LIMIT) {
      return `${seconds < SPAN_DECIMAL_LIMIT ? seconds.toFixed(1) : String(Math.round(seconds))}s`;
    }
    const minutes = Math.floor(seconds / SPAN_SECONDS_LIMIT);
    const rest = Math.round(seconds - minutes * SPAN_SECONDS_LIMIT);
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }

  // ── Percentages ───────────────────────────────────────────────────────────
  /** `formatPercent(61.54)` → `'61.5%'`. Clamped to [0, 100]. */
  function formatPercent(value, options) {
    const number = finiteNumber(value);
    if (number === null) return '';
    const decimals = finiteNumber(opt(options, 'decimals', 1));
    return `${Math.max(0, Math.min(100, number)).toFixed(decimals === null ? 1 : decimals)}%`;
  }

  // ── Usage percentages ─────────────────────────────────────────────────────
  // ONE threshold table per kind, so "how full" cannot mean 80% on one surface
  // and 90% on the next. `min` is inclusive and the entries are ordered from
  // the harshest down; the last entry catches everything below.
  //
  //   quota   — a subscription / rate-limit window, as USED percent. 90/70 is
  //             the complement of the server renderer's "remaining" cut at
  //             10 / 30 (src/quota/quota-bar-view.js).
  //   context — how full the model's context window is, where the consequence
  //             of being wrong is a compaction rather than a lockout, so it
  //             warns earlier.
  //
  // The tone is the shared part; the hex is presentation and lives in
  // USAGE_COLORS (web) / AppColors (Flutter).
  const USAGE_THRESHOLDS = Object.freeze({
    quota: Object.freeze([
      Object.freeze({ min: 90, tone: 'danger' }),
      Object.freeze({ min: 70, tone: 'warning' }),
      Object.freeze({ min: 0, tone: 'calm' }),
    ]),
    context: Object.freeze([
      Object.freeze({ min: 80, tone: 'danger' }),
      Object.freeze({ min: 50, tone: 'warning' }),
      Object.freeze({ min: 0, tone: 'success' }),
    ]),
  });
  const USAGE_COLORS = Object.freeze({
    danger: '#f85149', warning: '#d29922', calm: '#58a6ff', success: '#3fb950',
  });
  const USAGE_KINDS = Object.freeze(Object.keys(USAGE_THRESHOLDS));

  /** The tone name for a used percent — one of danger / warning / calm / success. */
  function usageTone(pct, kind) {
    const table = USAGE_THRESHOLDS[kind] || USAGE_THRESHOLDS.quota;
    const number = finiteNumber(pct);
    const value = number === null ? 0 : number;
    for (const entry of table) {
      if (value >= entry.min) return entry.tone;
    }
    return table[table.length - 1].tone;
  }

  /** The web hex for the same tone (`chat-${tone}` CSS vars are derived from it). */
  function usageColor(pct, kind) {
    return USAGE_COLORS[usageTone(pct, kind)];
  }

  // ── Token counts ──────────────────────────────────────────────────────────
  // A billed token breakdown (`↑入 56 ↓出 5.2k ♻读 2.70M`): two decimals once the
  // number is in the millions, so a difference of ten thousand tokens is still
  // visible, and thousands separators below that so an exact count stays
  // readable. `min` is inclusive.
  const TOKEN_UNITS = Object.freeze([
    Object.freeze({ min: 1000000, divisor: 1000000, suffix: 'M', decimals: 2 }),
    Object.freeze({ min: 1000, divisor: 1000, suffix: 'k', decimals: 1 }),
  ]);

  /**
   * `formatTokenCount(238700)` → `'238.7k'`.
   *
   * options:
   *   dropZeroDecimal  `200000` → `'200k'` instead of `'200.0k'`; for a context
   *                    window, which is always a whole thousand, the trailing
   *                    `.0` is noise
   */
  function formatTokenCount(value, options) {
    const n = count(value);
    for (const unit of TOKEN_UNITS) {
      if (n < unit.min) continue;
      let text = (n / unit.divisor).toFixed(unit.decimals);
      if (opt(options, 'dropZeroDecimal', false)) text = text.replace(/\.0+$/, '');
      return `${text}${unit.suffix}`;
    }
    return groupedNumber(n);
  }

  /**
   * `formatCompactTokens(200000)` → `'200K'`.
   *
   * The same "how many tokens" question asked at a coarser precision: a window
   * size and an approximate context estimate are rounded figures, so a trailing
   * `.0` says precision the number does not have.
   */
  function formatCompactTokens(value) {
    const n = count(value);
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return `${n}`;
  }

  /**
   * Thousands separators without `toLocaleString`, so the output does not
   * depend on the host's ICU data — and so the Flutter mirror (which has no
   * intl dependency) can reproduce it exactly.
   */
  function groupedNumber(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return Object.freeze({
    BYTE_BASE,
    BYTE_UNITS,
    BYTE_DEFAULT_DECIMALS,
    BYTE_DEFAULT_MAX_UNIT,
    RELATIVE_TIERS,
    RELATIVE_KEYS,
    RELATIVE_KEYS_COMPACT,
    RELATIVE_FALLBACK,
    SPAN_MS_LIMIT,
    SPAN_SECONDS_LIMIT,
    SPAN_DECIMAL_LIMIT,
    TOKEN_UNITS,
    USAGE_THRESHOLDS,
    USAGE_COLORS,
    USAGE_KINDS,
    finiteNumber,
    groupedNumber,
    formatBytes,
    formatRelativeTime,
    formatDuration,
    formatPercent,
    formatTokenCount,
    formatCompactTokens,
    usageTone,
    usageColor,
  });
});
