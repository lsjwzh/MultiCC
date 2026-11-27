'use strict';

// Frozen session-profile normalization from 06ebf5fa, before the Rust migration.
const SESSION_MEMORY_MAX = 8000;
const MEMORY_TYPES = Object.freeze(['decision', 'gotcha', 'preference', 'todo', 'fact']);

function normalizeManualMemory(value, options = {}) {
  const maxLength = options.maxLength ?? SESSION_MEMORY_MAX;
  const now = options.now || Date.now;
  if (value == null) return { entries: null };
  if (Array.isArray(value)) {
    const entries = value
      .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim())
      .map(entry => ({
        type: MEMORY_TYPES.includes(entry.type) ? entry.type : 'fact',
        text: entry.text.trim(),
        ts: entry.ts || now(),
      }));
    const total = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    return total > maxLength
      ? { error: `memory too long (max ${maxLength} chars)` }
      : { entries };
  }
  if (typeof value === 'string' && value.trim()) {
    return value.length > maxLength
      ? { error: `memory too long (max ${maxLength})` }
      : { entries: [{ type: 'fact', text: value.trim(), ts: 0 }] };
  }
  return { entries: null };
}

module.exports = { normalizeManualMemory };
