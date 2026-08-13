/**
 * Expands the two time-relative tokens in a server-rendered quota bar.
 *
 * The bar's words, colors, ordering and vendor rules all live server-side in
 * src/quota/quota-bar-view.js, rendered once and displayed verbatim by both
 * clients. Only the parts that change while nobody is fetching anything have to
 * be resolved at paint time:
 *
 *   {cd:<epochMs>}   a deadline  → "42m" · "3.5h" · "3d 5h"
 *   {ago:<epochMs>}  a timestamp → "刚刚" · "57s 前" · "3 分钟前"
 *
 * A bar is cached (localStorage here, memory in the app) and redisplayed for up
 * to 24h, so baking these in would make a bar quietly lie about how old it is.
 *
 * This file and app/lib/models/quota_bar_view.dart are the only quota code that
 * still exists twice. Both are pure arithmetic with no vendor strings, and
 * tests/test-quota-bar-parity.js + app/test/quota_bar_render_test.dart run the
 * same golden fixtures through both, so a change to one that is not mirrored in
 * the other fails on both ends.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuotaBarView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function finiteNumber(value) {
    if (value === null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // Time left, coarsening as it grows: minutes under an hour, one decimal of an
  // hour under a day, then days. Never returns '' for a real deadline — a
  // deadline in the past reads as "1m", so a segment's separators are safe to
  // bake into the server-rendered string.
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
  function relativeAgo(tsMs, nowMs) {
    const ts = finiteNumber(tsMs);
    if (ts === null || ts <= 0) return '';
    const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
    if (sec < 5) return '刚刚';
    if (sec < 60) return `${sec}s 前`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return `${d} 天前`;
  }

  const TOKEN = /\{(cd|ago):(-?\d+)\}/g;

  function resolveText(text, nowMs) {
    if (typeof text !== 'string' || text.indexOf('{') < 0) return text || '';
    return text.replace(TOKEN, (_, kind, raw) => {
      const at = Number(raw);
      return kind === 'cd' ? humanizeCountdown(Math.max(0, at - nowMs)) : relativeAgo(at, nowMs);
    });
  }

  /**
   * A server-rendered bar → the strings to paint right now.
   *
   * @param {object} bar   {text, color, title, action, states}
   * @param {object} [opts] {state, now} — `state` picks one of the server's
   *   alternative renders (a fetch in flight, a login window waiting on a
   *   human); an unknown state falls back to the default render rather than
   *   blanking the bar.
   */
  function resolveQuotaBar(bar, opts) {
    if (!bar) return null;
    const o = opts || {};
    const now = finiteNumber(o.now) ?? Date.now();
    const picked = (o.state && bar.states && bar.states[o.state]) || bar;
    return {
      text: resolveText(picked.text, now),
      color: picked.color || '#8b949e',
      title: resolveText(picked.title, now),
      action: picked.action || null,
    };
  }

  return { resolveQuotaBar, resolveText, humanizeCountdown, relativeAgo };
});
