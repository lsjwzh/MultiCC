(function attachMultiCCChatLocalLinks(global) {
  'use strict';

  // Assistant output may also link to local files, either as a bare absolute path
  // (/Users/…/x.dart) or prefixed with the server origin (http://127.0.0.1:3000/Users/…)
  // because the agent knows MULTICC_BASE_URL. Opening such a link navigates to a
  // route the server does not have (404). Rewrite the href to stream the file
  // through /api/download instead, and drop the origin from the visible label so
  // the link reads as the file path it actually points at.
  const _LOCAL_LINK_RE = /^(?:file:\/\/|\/(?:tmp|Users|home|var|private|opt|Volumes|mnt|root|data)\/|[A-Za-z]:[\\/])/;

  function stripServerOrigin(value) {
    if (!/^https?:\/\//i.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.origin === location.origin) return url.pathname + url.search;
    } catch (_) { /* keep raw on malformed input */ }
    return value;
  }

  function fixupLocalFileLinks(root) {
    if (!root) return;
    const withToken = (typeof window !== 'undefined' && window.withToken) || (url => url);
    root.querySelectorAll('a[href]').forEach(link => {
      if (link.dataset.fileFixed) return;
      const raw = link.getAttribute('href') || '';
      const p = stripServerOrigin(raw);
      if (!_LOCAL_LINK_RE.test(p)) return;
      link.dataset.fileFixed = '1';
      const path = p.replace(/^file:\/\//, '');
      link.href = withToken('/api/download?path=' + encodeURIComponent(path));
      // If the link text is the whole origin-prefixed URL, trim it to the file path;
      // an already-short label (file name) stays as-is.
      if (link.textContent.includes('://')) link.textContent = path;
      link.title = path;
    });
  }

  global.MultiCCChatLocalLinks = { fixupLocalFileLinks, stripServerOrigin };
})(typeof window !== 'undefined' ? window : globalThis);