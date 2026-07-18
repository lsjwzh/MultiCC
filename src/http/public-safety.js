'use strict';

const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PUBLIC_TEXT = 240;

function validCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

function safeCode(value, fallback = 'request_error') {
  return validCode(value) ? value : fallback;
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function containsSensitiveText(value) {
  const text = String(value || '');
  return /\bBearer\s+\S+/i.test(text)
    || /\b(?:token|secret|password|passwd|authorization|api[-_ ]?key|stderr|stack(?:trace)?)\b\s*(?:[:=]|\bis\b)\s*\S*/i.test(text)
    || /\bupstream\b/i.test(text)
    || /\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/i.test(text)
    || /(?:^|[\s("'`=])\/(?:[^/\s]+\/)+[^/\s]*/.test(text)
    || /[A-Za-z]:\\(?:[^\\\s]+\\)+[^\s]*/.test(text);
}

function sanitizePublicText(value, fallback = 'request_error') {
  const fallbackText = typeof fallback === 'string' && fallback.trim()
    ? fallback.trim().slice(0, MAX_PUBLIC_TEXT)
    : 'request_error';
  if (typeof value !== 'string' || !value.trim()) return fallbackText;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || containsSensitiveText(normalized)) return fallbackText;
  return normalized.slice(0, MAX_PUBLIC_TEXT);
}

function safeRelativePath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').trim();
  if (!normalized || normalized.length > MAX_PUBLIC_TEXT) return null;
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) return null;
  if (normalized.split('/').includes('..')) return null;
  if (/[\u0000-\u001f\u007f]/.test(normalized) || containsSensitiveText(normalized)) return null;
  return normalized;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeIdArray(value) {
  if (!Array.isArray(value)) return null;
  return Object.freeze([...new Set(value.filter(validId))].slice(0, 100));
}

// Compatibility output is intentionally narrow. Additions require an explicit
// boundary decision and a deterministic test; arbitrary source fields never
// pass through this function.
function sanitizeCompatibility(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return Object.freeze({});
  const out = {};
  if (typeof source.blocked === 'boolean') out.blocked = source.blocked;

  if (Array.isArray(source.reasons)) {
    const reasons = [...new Set(source.reasons.filter(validCode))].slice(0, 50);
    if (reasons.length) out.reasons = Object.freeze(reasons);
  }
  if (Array.isArray(source.conflicts)) {
    const conflicts = [...new Set(source.conflicts.map(safeRelativePath).filter(Boolean))].slice(0, 100);
    if (conflicts.length) out.conflicts = Object.freeze(conflicts);
  }
  for (const key of ['operationId', 'field', 'currentStatus']) {
    if (validId(source[key])) out[key] = source[key];
  }
  for (const key of ['queueDepth', 'retryAfter', 'retryAfterSec', 'retryAfterMs']) {
    const number = safeNumber(source[key]);
    if (number !== null) out[key] = number;
  }
  for (const key of ['sessions', 'sessionIds']) {
    const ids = safeIdArray(source[key]);
    if (ids && ids.length) out[key] = ids;
  }
  return Object.freeze(out);
}

module.exports = {
  CODE_PATTERN,
  ID_PATTERN,
  containsSensitiveText,
  safeCode,
  sanitizeCompatibility,
  sanitizePublicText,
  validCode,
  validId,
};
