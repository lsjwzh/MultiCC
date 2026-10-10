/**
 * Expands the two time-relative tokens in a server-rendered quota bar.
 *
 * The bar's words, colors, ordering and vendor rules all live server-side in
 * src/quota/quota-bar-view.js, rendered once and displayed verbatim by both
 * clients. Only the parts that change while nobody is fetching anything have to
 * be resolved at paint time:
 *
 *   {cd:<epochMs>}            a deadline → "42m" · "3.5h" · "3d 5h". A bar
 *                             cached before the window half below existed reads
 *                             its window back out of the segment in front of the
 *                             token, so it rolls too (see windowBefore)
 *   {cd:<epochMs>|<window>}   a deadline whose window the server knew, so a
 *                             deadline that has already passed resolves to the
 *                             NEXT reset of that window instead
 *   {ago:<epochMs>}           a timestamp → "刚刚" · "57s 前" · "3 分钟前"
 *
 * A bar is cached (localStorage here, memory in the app) and redisplayed for up
 * to 24h, so baking these in would make a bar quietly lie about how old it is.
 *
 * This file and app/lib/models/quota_bar_view.dart are the only quota code that
 * still exists twice. Both are pure arithmetic with no vendor strings, and
 * tests/test-quota-bar-parity.js + app/test/quota_bar_render_test.dart run the
 * same golden fixtures through both, so a change to one that is not mirrored in
 * the other fails on both ends.
 *
 * A second, WEB-ONLY job lives here: a bar also arrives carrying the pieces the
 * server assembled its Chinese from (textParts/titleParts, see
 * src/quota/quota-bar-view.js) so a non-Chinese UI can re-render it in its own
 * language. The app has no renderer for those pieces and displays the server's
 * bytes verbatim, so nothing below is part of the parity contract — see
 * renderQuotaParts.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuotaBarView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 时间格式的唯一来源（shared/format.js，air.html / chat.html 里先于本文件加载）。
  // Node 侧（生成金样夹具、奇偶校验测试）没有页面全局，所以两种取法都留着。
  const FMT = (typeof require === 'function' ? require('./shared/format.js') : null)
    || (typeof self !== 'undefined' && self.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || null;

  function finiteNumber(value) {
    if (value === null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // Time left, coarsening as it grows: minutes under an hour, one decimal of an
  // hour under a day, then days. Never returns '' for a real deadline, so a
  // segment's separators are safe to bake into the server-rendered string; a
  // deadline that has already passed never reaches here, because resolveText
  // re-anchors it to the next reset (or falls back to 已重置) first.
  function humanizeCountdown(ms) {
    const total = finiteNumber(ms);
    if (total === null || total < 0) return '';
    const totalH = total / 3_600_000;
    if (totalH < 1) return `${Math.max(1, Math.round(total / 60_000))}m`;
    if (totalH < 24) {
      const h = Math.round(totalH * 10) / 10;
      return `${Number.isInteger(h) ? h.toFixed(0) : h.toFixed(1)}h`;
    }
    const d = Math.floor(totalH / 24);
    const remH = Math.floor(totalH % 24);
    return remH ? `${d}d ${remH}h` : `${d}d`;
  }

  // How long ago a fetch landed. This is the number that tells the user whether
  // the bar in front of them is worth believing.
  // 这一格的位置很窄（一条限流条上并排三个窗口段），所以用紧凑档：只有「秒」那一级
  // 跟别处不同（`57s 前` 而不是 `57 秒前`），分钟以上完全同词。档位表在
  // shared/format.js，compact 只换那一级的 i18n key。
  function relativeAgo(tsMs, nowMs) {
    return FMT.formatRelativeTime(tsMs, { now: nowMs, compact: true });
  }

  // `{cd:<at>}` or, when the server knew which window the deadline belongs to,
  // `{cd:<at>|<window>}`. `{ago:<at>}` never carries a window.
  const TOKEN = /\{(cd|ago):(-?\d+)(?:\|([0-9a-z]+))?\}/g;

  // How long each window this bar meters is, keyed by the token the server
  // appends to a deadline it knows the window of. `1m` is a calendar month
  // rather than 30 days, so its entry is null and the arithmetic below goes
  // through the date instead of a fixed span.
  const WINDOW_PERIOD_MS = Object.freeze({ '5h': 5 * 3_600_000, '1wk': 7 * 86_400_000, '1m': null });
  // Enough periods for any bar that can still be on screen: the longest-lived
  // cached bar is a day old and the shortest window here is five hours.
  const MAX_ROLL_STEPS = 400;

  // The month step walks the UTC calendar, not the local one. A vendor's monthly
  // window resets on a day-of-month we do not know the zone of, and a LOCAL
  // month would additionally make the answer depend on the reader's machine: one
  // month past a date that straddles a DST change is an hour earlier or later in
  // local time, which is one hour of difference in the rendered "Xd Yh" and one
  // different golden fixture per time zone. UTC keeps the same day and time of
  // day as the deadline we were handed and answers the same everywhere.
  function advanceWindow(atMs, token, steps) {
    if (token !== '1m') return atMs + WINDOW_PERIOD_MS[token] * steps;
    const d = new Date(atMs);
    d.setUTCMonth(d.getUTCMonth() + steps);
    return d.getTime();
  }

  // The reset after a deadline that is already behind us: advance by whole
  // periods until the result is ahead of now. For every periodic window this
  // bar meters that is exactly when the next window ends.
  function nextResetAfter(atMs, token, nowMs) {
    if (WINDOW_PERIOD_MS[token] === undefined) return null;
    for (let steps = 1; steps <= MAX_ROLL_STEPS; steps++) {
      const next = advanceWindow(atMs, token, steps);
      if (next > nowMs) return next;
    }
    return null;
  }

  // A deadline that is already past is NOT "one minute left". The window has
  // rolled, and the percentage printed next to it belongs to the window that
  // just ended — a bar redisplayed from cache four hours later would otherwise
  // read "5h 93% 1m", i.e. 93% used with a minute to go, which is the most
  // misleading thing this bar can say. So a countdown is never allowed to go
  // negative: the deadline becomes the NEXT reset instead, whenever the token
  // says which window it belonged to (see resolveText). Only a token that does
  // not say falls back to naming the state rather than numbering it — which is
  // where the bare word comes from, and why it is rare. Either way the segment
  // stays non-empty, which is what keeps the separators the server baked in
  // (see humanizeCountdown) safe to expand.
  const ROLLED_WINDOW = '已重置';

  // The window of a deadline whose token does not carry one — because the bar
  // was rendered and cached by a server that predates the `|<window>` half (see
  // cdTag in src/quota/quota-bar-view.js). Those are real: a bar is persisted by
  // the server-side quota-bar cache and by localStorage, and one whose weekly
  // deadline has since passed reads `1wk 38% {cd:…}` — the exact shape that got
  // stuck on the bare word.
  //
  // The window is still in the string. Every countdown this renderer puts in a
  // bar's TEXT comes from windowSeg, which writes `<label> <remaining>% <cd>`,
  // so the cell the token directly follows names the window it belongs to.
  // Reading it back is what lets an old cached bar answer with a time like a
  // fresh one.
  //
  // Anchored to the end of everything before the token, so it only fires on a
  // label the token actually follows: a tooltip's `重置: {cd:…} 后` has words
  // there, not a percentage, and keeps the bare word (a tooltip is not worth
  // guessing a window for — the labels in one are not always even the token's,
  // e.g. the Chinese 周/月).
  const SEG_LABEL = /([A-Za-z0-9][A-Za-z0-9-]*)\s+\d+(?:\.\d+)?%\s*$/;

  // A window token this bar meters, or null. `1wk-ALL`-style labels (Claude
  // meters its weekly limit more than one way) read as the window their first
  // segment names; mirrors windowTokenOf in src/quota/quota-bar-view.js.
  function windowOfLabel(label) {
    const token = String(label || '').trim().split('-')[0];
    return Object.prototype.hasOwnProperty.call(WINDOW_PERIOD_MS, token) ? token : null;
  }

  function windowBefore(text, offset) {
    const label = SEG_LABEL.exec(text.slice(0, offset));
    return label ? windowOfLabel(label[1]) : null;
  }

  // `rolledLabel` is the localized spelling of that sentence; the default is the
  // server's own bytes, which is what the app and the golden fixtures pin.
  function resolveText(text, nowMs, rolledLabel) {
    if (typeof text !== 'string' || text.indexOf('{') < 0) return text || '';
    return text.replace(TOKEN, (_, kind, raw, window, offset) => {
      const at = Number(raw);
      if (kind !== 'cd') return relativeAgo(at, nowMs);
      const left = at - nowMs;
      if (left > 0) return humanizeCountdown(left);
      // The deadline is behind us, so the window it named has rolled. When the
      // token carries the window, the next reset is that deadline plus whole
      // periods, and saying when it is answers what the reader actually asked
      // ("how long until it resets"). A token that does not carry one is read
      // back out of the segment in front of it (see windowBefore), so a bar
      // cached before the server learned to name the window answers the same
      // way. Only a deadline with no window anywhere near it - a window this bar
      // does not meter - falls back to "已重置", the honest remainder, which is
      // still non-empty and keeps the separators baked into the server string
      // safe to expand.
      const win = window || windowBefore(text, offset);
      const next = win ? nextResetAfter(at, win, nowMs) : null;
      return next === null ? (rolledLabel || ROLLED_WINDOW) : humanizeCountdown(next - nowMs);
    });
  }

  // ── Re-rendering a bar's pieces in another language (Web only) ────────────
  // The server bakes Chinese into text/title, and it cannot know which language
  // this client is in (the choice lives in localStorage). So each bar also ships
  // the pieces those strings were assembled from: `{k, p, s, j}` — k a catalog
  // key, p its params (a param that is itself a piece nests), s the exact bytes
  // the server baked in, j the separator that precedes this piece (absent = the
  // caller's separator). Rendering with s for every piece reproduces the server
  // string byte for byte; rendering with a translator produces the other
  // language.
  //
  // `translate(key, params, fallback)` is the caller's and MUST return
  // `fallback` for a key it cannot translate. A piece is a hint, never a
  // requirement: an old cached bar, or one from a server that learned a new
  // string, still renders.
  function renderQuotaPiece(piece, translate) {
    if (!piece || typeof piece.s !== 'string') return '';
    let params = null;
    if (piece.p) {
      params = {};
      for (const name of Object.keys(piece.p)) {
        const value = piece.p[name];
        if (value === null || value === undefined) params[name] = '';
        else if (typeof value === 'object' && typeof value.s === 'string') params[name] = renderQuotaPiece(value, translate);
        else params[name] = value;
      }
    }
    if (!piece.k) return piece.s;
    const out = translate(piece.k, params, piece.s);
    return typeof out === 'string' ? out : piece.s;
  }

  function renderQuotaParts(parts, sep, translate) {
    if (!Array.isArray(parts) || !parts.length || typeof translate !== 'function') return '';
    let out = '';
    let first = true;
    for (const piece of parts) {
      if (!piece || typeof piece.s !== 'string') continue;
      if (!first) out += piece.j !== undefined ? piece.j : sep;
      out += renderQuotaPiece(piece, translate);
      first = false;
    }
    return out;
  }

  /**
   * A server-rendered bar → the strings to paint right now.
   *
   * @param {object} bar   {text, color, title, action, states}
   * @param {object} [opts] {state, now, translate, rolled} — `state` picks one
   *   of the server's alternative renders (a fetch in flight, a login window
   *   waiting on a human); an unknown state falls back to the default render
   *   rather than blanking the bar. `translate` (with `rolled`, the localized
   *   "已重置") is the Web-only localization seam: pass it and text/title are
   *   rebuilt from the bar's pieces in the client's language, leave it out and
   *   the server's own bytes are resolved, exactly as before and exactly as the
   *   app does.
   */
  function resolveQuotaBar(bar, opts) {
    if (!bar) return null;
    const o = opts || {};
    const now = finiteNumber(o.now) ?? Date.now();
    const picked = (o.state && bar.states && bar.states[o.state]) || bar;
    const pick = (plain, parts, sep) => {
      if (typeof o.translate === 'function') {
        const rebuilt = renderQuotaParts(picked[parts], sep, o.translate);
        if (rebuilt) return resolveText(rebuilt, now, o.rolled);
      }
      return resolveText(picked[plain], now, o.rolled);
    };
    return {
      text: pick('text', 'textParts', ' · '),
      color: picked.color || '#8b949e',
      title: pick('title', 'titleParts', '\n'),
      action: picked.action || null,
    };
  }

  return { resolveQuotaBar, resolveText, humanizeCountdown, relativeAgo, renderQuotaParts };
});
