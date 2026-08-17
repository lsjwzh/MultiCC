'use strict';

// Server-side last-known quota bar cache.
//
// This is intentionally narrower than provider-limit-cache. Provider cache is
// keyed by a configured provider identity and feeds provider pickers; several
// chat bars are account-level (OpenCode Go, Qoder, Codex OAuth) and must not be
// attached to whichever routed provider happens to be selected. This cache keeps
// only display-safe bar projections by quota-bar identity, so the web client no
// longer needs localStorage as its last-good source.

const { createStore } = require('../state-store');

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 80;

function text(value, max = 240) {
  const out = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return out.length > max ? out.slice(0, max) : out;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function hostFromBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return '';
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch (_) { return ''; }
}

function arkPlanFromBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  try {
    const p = new URL(baseUrl).pathname.toLowerCase();
    if (p.includes('/coding')) return 'coding-plan';
    if (p.includes('/plan')) return 'agent-plan';
  } catch (_) {}
  return null;
}

function normalizeBar(bar) {
  if (!bar || typeof bar !== 'object' || Array.isArray(bar)) return null;
  return {
    text: text(bar.text, 500),
    color: text(bar.color, 40),
    title: text(bar.title, 1200),
    action: bar.action == null ? null : text(bar.action, 80),
    states: bar.states && typeof bar.states === 'object' && !Array.isArray(bar.states)
      ? JSON.parse(JSON.stringify(bar.states))
      : undefined,
  };
}

function selectorKey(kind, selector = {}) {
  const k = text(kind, 40).toLowerCase();
  if (!k) return '';
  if (k === 'claude') {
    const session = text(selector.session, 180);
    return session ? `${k}:session:${session}` : `${k}:global`;
  }
  if (k === 'ark') {
    const plan = arkPlanFromBaseUrl(selector.baseUrl) || hostFromBaseUrl(selector.baseUrl) || text(selector.host, 120) || 'default';
    return `${k}:${plan}`;
  }
  if (k === 'zhipu' || k === 'kimi') {
    const host = text(selector.host, 120).toLowerCase() || hostFromBaseUrl(selector.baseUrl) || 'default';
    return `${k}:${host}`;
  }
  return k;
}

function createQuotaBarCache({ file, now = Date.now, storeFactory = createStore, logger = console } = {}) {
  if (!file || typeof file !== 'string') throw new TypeError('[quota-bar-cache] requires { file }');
  const store = storeFactory({ file, kind: 'quota-bar-cache', schemaVersion: SCHEMA_VERSION, legacyIsArray: false });
  let state = { entries: {}, updatedAt: 0 };

  function load() {
    try {
      const loaded = store.loadOrRecover();
      if (loaded && loaded.present && loaded.data && typeof loaded.data === 'object') {
        state = {
          entries: loaded.data.entries && typeof loaded.data.entries === 'object' ? loaded.data.entries : {},
          updatedAt: finite(loaded.data.updatedAt) || 0,
        };
      }
    } catch (error) {
      if (logger && logger.warn) logger.warn('[multicc/quota-bar-cache] load failed:', error.message);
    }
    return snapshot();
  }

  function save() {
    try { store.save(state); } catch (error) {
      if (logger && logger.warn) logger.warn('[multicc/quota-bar-cache] save failed:', error.message);
    }
  }

  function prune() {
    const keys = Object.keys(state.entries);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => (finite(state.entries[a] && state.entries[a].updatedAt) || 0)
      - (finite(state.entries[b] && state.entries[b].updatedAt) || 0));
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete state.entries[key];
  }

  function record(kind, result = {}, bar, selector = {}) {
    const key = selectorKey(kind, selector);
    const safeBar = normalizeBar(bar);
    if (!key || !safeBar) return null;
    const at = now();
    const status = text(result && result.status, 80) || 'ok';
    const prev = state.entries[key] || null;
    if (status === 'ok' || !prev || !prev.bar) {
      state.entries[key] = {
        key,
        kind: text(kind, 40),
        status,
        bar: safeBar,
        fetchedAt: finite(result && result.fetchedAt) || at,
        updatedAt: at,
        lastError: status === 'ok' ? null : text((result && (result.error || result.reason)) || status, 200),
        lastErrorAt: status === 'ok' ? null : at,
      };
    } else {
      state.entries[key] = {
        ...prev,
        updatedAt: at,
        lastError: text((result && (result.error || result.reason)) || status, 200),
        lastErrorAt: at,
      };
    }
    state.updatedAt = at;
    prune();
    save();
    return { ...state.entries[key] };
  }

  function get(kind, selector = {}) {
    const entry = state.entries[selectorKey(kind, selector)];
    return entry ? { ...entry, bar: normalizeBar(entry.bar) } : null;
  }

  function snapshotFor(selector = {}) {
    const bars = {};
    for (const kind of ['opencode', 'qoder', 'codex', 'claude', 'ark', 'zhipu', 'kimi']) {
      bars[kind] = get(kind, selector);
    }
    return { status: 'ok', bars, updatedAt: state.updatedAt || 0 };
  }

  function snapshot() {
    const entries = {};
    for (const [key, entry] of Object.entries(state.entries)) {
      entries[key] = { ...entry, bar: normalizeBar(entry.bar) };
    }
    return { entries, updatedAt: state.updatedAt || 0 };
  }

  load();
  return Object.freeze({ record, get, snapshot, snapshotFor, selectorKey, file });
}

module.exports = { createQuotaBarCache, selectorKey, normalizeBar };
