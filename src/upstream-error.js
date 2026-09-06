'use strict';

const { redact } = require('./observability');

const MAX_ERROR_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE = 2048;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// CLI errors often wrap the HTTP JSON body in a sentence and append a URL.
// Extract the balanced JSON object, honoring escaped quotes/braces, before any
// presentation truncation. Never treat arbitrary non-error JSON as an error.
function embeddedError(value) {
  const text = String(value || '').slice(0, MAX_ERROR_BYTES);
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) {
      if (char === '{') { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(start, i + 1));
        if (parsed.error || parsed.response?.error) return parsed;
      } catch (_) {}
      start = -1;
    }
  }
  return null;
}

function extractUpstreamError(value) {
  let current = value;
  if (typeof current === 'string') current = embeddedError(current) || { message: current };
  if (!object(current)) return {};
  const result = {};
  const seen = new Set();
  for (let level = 0; object(current) && level < 8 && !seen.has(current); level++) {
    seen.add(current);
    for (const key of ['message', 'code', 'type', 'param']) {
      if (typeof current[key] === 'string' && current[key]) result[key] = current[key];
    }
    const status = current.httpStatus ?? current.http_status ?? current.statusCode ?? current.status_code ?? current.upstreamStatus;
    if (Number(status) >= 400 && Number(status) <= 599) result.httpStatus = Number(status);
    const requestId = current.requestId || current.request_id;
    if (typeof requestId === 'string') result.requestId = requestId;
    const nested = current.response?.error || current.error;
    if (object(nested)) current = nested;
    else if (typeof nested === 'string') current = embeddedError(nested) || { message: nested };
    else {
      const embedded = embeddedError(current.message);
      if (!embedded) break;
      current = embedded;
    }
  }
  return result;
}

function sanitizeUpstreamText(value, secrets = [], maxLength = MAX_ERROR_MESSAGE) {
  let text = String(value || '');
  // Host OAuth account identifiers/tokens can be echoed verbatim by an upstream.
  // Known secret values are removed even without a recognizable key or prefix.
  for (const secret of [...new Set(secrets.filter(s => typeof s === 'string' && s))].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }
  return String(redact(text))
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@')
    .replace(/[A-Z]:\\[^\s]+|\/(?:Users|home|var|tmp)\/[^\s]+/g, '[PATH]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[ACCOUNT]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

function publicUpstreamError(value, { secrets = [], fallback = 'Upstream API request failed' } = {}) {
  const parsed = extractUpstreamError(value);
  const result = { message: sanitizeUpstreamText(parsed.message || fallback, secrets) || fallback };
  for (const key of ['code', 'type', 'param', 'requestId']) {
    if (typeof parsed[key] === 'string') result[key] = sanitizeUpstreamText(parsed[key], secrets, 200);
  }
  if (parsed.httpStatus) result.httpStatus = parsed.httpStatus;
  return result;
}

function publicTransportError(error, options = {}) {
  const parts = [];
  const seen = new Set();
  let code;
  for (let e = error; e && !seen.has(e) && seen.size < 5; e = e.cause) {
    seen.add(e);
    if (e.message) parts.push(String(e.message));
    if (e.code) { code = String(e.code); parts.push(code); }
  }
  return publicUpstreamError({ message: [...new Set(parts)].join(': '), code }, options);
}

async function readUpstreamError(response, { signal, timeoutMs = 2000 } = {}) {
  if (!response.body) return { message: response.statusText || `HTTP ${response.status}` };
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let interrupted = false;
  let timer;
  let stop;
  const stopped = new Promise(resolve => { stop = () => { interrupted = true; resolve({ done: true }); }; });
  timer = setTimeout(stop, timeoutMs);
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  try {
    while (length < MAX_ERROR_BYTES && !interrupted) {
      const { value, done } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      const chunk = Buffer.from(value).subarray(0, MAX_ERROR_BYTES - length);
      chunks.push(chunk);
      length += chunk.length;
    }
  } catch (_) {
    // Preserve a received error prefix even if its connection ends abruptly.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    // A broken peer must not indefinitely delay the diagnostic response.
    Promise.resolve(reader.cancel()).catch(() => {});
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return extractUpstreamError(text || response.statusText || `HTTP ${response.status}`);
}

module.exports = {
  extractUpstreamError,
  publicTransportError,
  publicUpstreamError,
  readUpstreamError,
  sanitizeUpstreamText,
};
