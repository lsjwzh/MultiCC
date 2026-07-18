'use strict';

// Single fail-closed Markdown boundary for every chat rendering path. Markdown
// is enabled only when both marked and DOMPurify are available; a CDN failure
// therefore degrades to escaped plain text instead of unsanitized HTML.
(function attachSafeMarkdown(root, factory) {
  const api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCSafeMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi(root) {
  // Blob/data/file URLs are deliberately excluded. Local image previews are
  // upgraded by trusted host code after sanitization, never accepted from
  // persisted Markdown as an executable/capability-bearing URL.
  const SAFE_URI = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;
  const SANITIZE_CONFIG = Object.freeze({
    USE_PROFILES: Object.freeze({ html: true }),
    FORBID_TAGS: Object.freeze([
      'svg', 'math', 'style', 'form', 'iframe', 'object', 'embed',
      'template', 'link', 'meta', 'base',
    ]),
    FORBID_ATTR: Object.freeze([
      'style', 'srcdoc', 'formaction', 'xlink:href', 'xmlns',
    ]),
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: SAFE_URI,
    RETURN_TRUSTED_TYPE: false,
    SANITIZE_NAMED_PROPS: true,
  });

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  function render(text, dependencies = {}) {
    const source = String(text == null ? '' : text);
    if (!source) return '';
    const markdown = dependencies.marked || root.marked;
    const purifier = dependencies.DOMPurify || root.DOMPurify;
    if (!markdown || typeof markdown.parse !== 'function'
        || !purifier || typeof purifier.sanitize !== 'function') {
      return escapeHtml(source);
    }

    try {
      const parsed = markdown.parse(source);
      const sanitized = purifier.sanitize(String(parsed), SANITIZE_CONFIG);
      return typeof sanitized === 'string' ? sanitized : String(sanitized || '');
    } catch (_) {
      return escapeHtml(source);
    }
  }

  return Object.freeze({ escapeHtml, render, SANITIZE_CONFIG });
});
