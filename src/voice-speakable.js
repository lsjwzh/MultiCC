'use strict';

// What is safe to say out loud from a turn that may contain marker-shaped prose.
//
// Cross-session routing is MCP-only, so `<<dispatch>>` / `<<route>>` text is
// inert — nothing acts on it. Inert is not the same as speakable: a stale or
// mis-prompted model that still emits one would otherwise have it read out over
// the phone, task payload and target session id included. Both families are
// therefore stripped before any text reaches TTS, in all three shapes a live
// transport produces:
//
//   complete    `<<dispatch target="x">…</dispatch>>`
//   assembled   the same marker arriving one character at a time
//   truncated   a turn cut off mid-marker — an opener with no closer, or just
//               the bare prefix `<<disp`
//
// A regex only removes the first shape. The other two are cut fail-closed:
// everything from a residual opener onward is dropped rather than spoken, and a
// trailing fragment that could still grow into an opener is withheld. Callers
// that stream re-run this over the whole buffer and emit only the growth, so a
// marker still arriving character by character is never spoken early.

const MARKER_RE = /<<\s*(?:dispatch|route)\b[^>]*>[\s\S]*?<\/(?:dispatch|route)>>?/gi;
const MARKER_OPENER_RE = /<<\s*(?:dispatch|route)\b/i;
// A trailing prefix of an opener, down to a bare `<<`.
const MARKER_OPENER_TAIL_RE = /<<\s*(?:d(?:i(?:s(?:p(?:a(?:t(?:c(?:h)?)?)?)?)?)?)?|r(?:o(?:u(?:t(?:e)?)?)?)?)?$/i;

function speakableText(raw) {
  // `.replace` with a /g regex resets lastIndex itself; `.test` would not, which
  // is why this never tests these shared module-level regexes.
  let text = typeof raw === 'string' ? raw : '';
  text = text.replace(MARKER_RE, '');
  const opener = text.search(MARKER_OPENER_RE);
  if (opener >= 0) text = text.slice(0, opener);
  return text.replace(MARKER_OPENER_TAIL_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  MARKER_OPENER_RE,
  MARKER_RE,
  speakableText,
};
