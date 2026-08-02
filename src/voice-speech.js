'use strict';

const LEGACY_MARKER_BLOCK = /<<\s*(dispatch|route)\b[^>]*>[\s\S]*?<\/\s*\1\s*>>?/gi;
const LEGACY_MARKER_CLOSE = /<\/\s*(?:dispatch|route)\s*>>?/gi;
const INTERNAL_INSTRUCTION_BLOCK = /<qwen_audio_agent_backend_instructions>[\s\S]*?<\/qwen_audio_agent_backend_instructions>/gi;
const INTERNAL_REQUEST_ENVELOPE = /<qwen_audio_agent_request>[\s\S]*?<\/qwen_audio_agent_request>/gi;

function stripTruncatedLegacyMarker(text) {
  let value = String(text || '');
  for (;;) {
    const markerStart = value.lastIndexOf('<<');
    if (markerStart < 0) return value;
    const suffix = value.slice(markerStart + 2).trimStart().toLowerCase();
    const token = suffix.split(/[\s=>]/, 1)[0];
    const markerLike = !token
      || 'dispatch'.startsWith(token)
      || 'route'.startsWith(token)
      || token.startsWith('dispatch')
      || token.startsWith('route');
    if (!markerLike) return value;
    value = value.slice(0, markerStart);
  }
}

// One final, pure egress gate for every string that can reach TTS. It removes
// retired control syntax after the complete response has been assembled, so a
// marker split across any number of transport chunks cannot escape. Values that
// identify Host-owned routing state are supplied by the caller and redacted too.
function sanitizeVoiceSpeech(raw, { privateValues = [] } = {}) {
  let text = String(raw || '')
    .replace(INTERNAL_INSTRUCTION_BLOCK, '')
    .replace(INTERNAL_REQUEST_ENVELOPE, '')
    .replace(LEGACY_MARKER_BLOCK, '')
    .replace(LEGACY_MARKER_CLOSE, '');
  text = stripTruncatedLegacyMarker(text);
  for (const value of privateValues) {
    const secret = String(value || '').trim();
    if (secret) text = text.split(secret).join('');
  }
  // Paths are never useful spoken output. Keep this deliberately limited to
  // absolute filesystem forms so ordinary slash-separated prose survives.
  text = text
    .replace(/\/(?:Users|home|tmp|var|private|opt|Volumes)\/[^\s，。！？；：]+/g, '')
    .replace(/[A-Za-z]:\\[^\s，。！？；：]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return text;
}

module.exports = {
  sanitizeVoiceSpeech,
  stripTruncatedLegacyMarker,
};
