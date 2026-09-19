'use strict';

// ── Sensitive-value vault（敏感信息保险箱）──
//
// One local store for API keys, tokens and other secrets the user wants agents
// to use WITHOUT the value ever passing through a chat message or an LLM API:
//
//   - Agents pop the secure dialog via the MCP tool `request_secret_input`
//     (src/router-tool-runtime.js). The web client saves the typed value
//     straight to POST /api/secrets and only a name-only confirmation ever
//     becomes a chat message.
//   - The user manages entries manually in the /manage「敏感信息」panel.
//   - `list_secrets` (MCP) and GET /api/secrets return names/descriptions
//     only; the value endpoint exists solely for the panel's reveal action.
//
// Writes are localhost-trusted exactly like the docs registry: the secure
// dialog and the panel POST here without a token. The store file is 0600 via
// atomicWriteJson and values are never logged.

const fs = require('fs');
const path = require('path');
const { createPaths } = require('./paths');
const { atomicWriteJson } = require('./runtime-security');

const STORE = createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).secretsFile;

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_VALUE_LENGTH = 64 * 1024;
const MAX_DESCRIPTION = 500;
const MAX_ENTRIES = 500;
const MAX_SOURCE = 64;

let entries = new Map(); // name -> { name, value, description, source, createdAt, updatedAt }

function load() {
  entries = new Map();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return; } // ENOENT / corrupt → empty vault, never a crash
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '');
    if (!NAME_RE.test(name) || typeof item.value !== 'string') continue;
    entries.set(name, {
      name,
      value: item.value,
      description: typeof item.description === 'string' ? item.description.slice(0, MAX_DESCRIPTION) : '',
      source: typeof item.source === 'string' ? item.source.slice(0, MAX_SOURCE) : 'user',
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      ...(typeof item.updatedBy === 'string' ? { updatedBy: item.updatedBy.slice(0, 128) } : {}),
    });
  }
}

function save() {
  atomicWriteJson(STORE, [...entries.values()]);
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!NAME_RE.test(name)) return null;
  return name;
}

// Metadata-only projection — the only shape agents and list endpoints ever see.
function meta(entry) {
  return {
    name: entry.name,
    description: entry.description || '',
    source: entry.source || 'user',
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
  };
}

function safeList() {
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).map(meta);
}

function upsert({ name, value, description, source, sessionId } = {}) {
  const clean = cleanName(name);
  if (!clean) return { error: 'name must match [A-Za-z0-9_.-] and be 1-64 chars', status: 400 };
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE_LENGTH) {
    return { error: `value is required and cannot exceed ${MAX_VALUE_LENGTH} characters`, status: 400 };
  }
  const now = new Date().toISOString();
  const existing = entries.get(clean);
  if (!existing && entries.size >= MAX_ENTRIES) {
    return { error: 'vault is full', status: 409 };
  }
  const entry = {
    name: clean,
    value,
    description: typeof description === 'string' ? description.trim().slice(0, MAX_DESCRIPTION) : (existing?.description || ''),
    source: (typeof source === 'string' && source.trim() ? source.trim() : 'user').slice(0, MAX_SOURCE),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ...(sessionId ? { updatedBy: String(sessionId).slice(0, 128) } : {}),
  };
  entries.set(clean, entry);
  save();
  return { entry, created: !existing };
}

function remove(name) {
  const clean = cleanName(name);
  if (!clean || !entries.has(clean)) return { error: 'entry not found', status: 404 };
  entries.delete(clean);
  save();
  return { ok: true };
}

function reveal(name) {
  const clean = cleanName(name);
  const entry = clean ? entries.get(clean) : null;
  if (!entry) return { error: 'entry not found', status: 404 };
  return { entry };
}

function has(name) {
  const clean = cleanName(name);
  return clean ? entries.has(clean) : false;
}

function mount(app) {
  app.get('/api/secrets', (req, res) => {
    res.json(safeList());
  });
  app.post('/api/secrets', (req, res) => {
    const body = req.body || {};
    const result = upsert({
      name: body.name,
      value: body.value,
      description: body.description,
      source: body.source === 'agent' ? 'agent' : 'user',
      sessionId: body.sessionId,
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.status(result.created ? 201 : 200).json({ ok: true, entry: meta(result.entry) });
  });
  app.delete('/api/secrets/:name', (req, res) => {
    const result = remove(req.params.name);
    if (result.error) return res.status(result.status || 404).json({ error: result.error });
    res.json(result);
  });
  // Value read for the panel's reveal action only. Named separately from the
  // list route so access logs make the value-touching calls obvious.
  app.get('/api/secrets/:name/value', (req, res) => {
    const result = reveal(req.params.name);
    if (result.error) return res.status(result.status || 404).json({ error: result.error });
    res.json({ ok: true, name: result.entry.name, value: result.entry.value });
  });
}

load();

module.exports = {
  STORE,
  NAME_RE,
  mount,
  list: safeList,
  upsert,
  remove,
  reveal,
  has,
  // Test hooks — the production singleton loads once at require time.
  _resetForTests() { entries = new Map(); },
  _saveForTests: save,
};
