'use strict';

// Canonical DOM helpers for classic-script pages (chat / index / manage /
// wechat). Load this BEFORE the first classic consumer: the manage page alone
// has ~9 scripts calling a global escapeHtml that used to be defined midway
// through manage-dashboard.js — a hidden load-order coupling this file removes.
//
// Deliberately NOT consolidated here: the self-contained module copies in
// safe-markdown, status-presentation, task-board-ui, chat-usage-readout,
// memory-model, tour and manage-workspace-setup — those are Node-requireable
// units and rendering/security boundaries that must not depend on page order.
(function attachMultiCCDomHelpers(root) {
  // Escapes all five HTML-significant characters; null/undefined render as ''.
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  // Tab identity: deterministic colour for a session name, shared by the chat
  // page and the standalone client page so the same session shows the same
  // favicon colour on both.
  const TAB_COLORS = ['#58a6ff', '#f78166', '#3fb950', '#d29922', '#bc8cff', '#f97583', '#79c0ff', '#56d364'];
  function hashTabColor(s) {
    let h = 0; for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * 31) | 0;
    return TAB_COLORS[Math.abs(h) % TAB_COLORS.length];
  }

  const api = Object.freeze({ escapeHtml, hashTabColor });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.escapeHtml = escapeHtml;
    root._hashColor = hashTabColor;
  }
})(typeof window !== 'undefined' ? window : globalThis);
