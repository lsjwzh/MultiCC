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
const secretAudit = require('./secret-audit');

const STORE = createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).secretsFile;

// 新建/改名一律要求「合法环境变量名」：条目会以同名环境变量注入子进程，含 '-' '.' 的名字
// 注入不了，只会静默躺在保险箱里。LEGACY_NAME_RE 只用于加载/查找/删除/改名旧条目——
// 如果 load 也收紧，旧的非法名条目会在下次 save 时被永久丢弃。
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LEGACY_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const NAME_RULE = 'name must be a valid env var identifier ([A-Za-z_][A-Za-z0-9_]*, 1-64 chars) so it can be injected as $NAME';
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
    if (!LEGACY_NAME_RE.test(name) || typeof item.value !== 'string') continue;
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

// 查找用的宽松清洗（兼容旧的非法名条目，好让它们能被查到、删除、改名）。
function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!LEGACY_NAME_RE.test(name)) return null;
  return name;
}

// 写入用的严格清洗。
function cleanNewName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return NAME_RE.test(name) ? name : null;
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
  const clean = cleanNewName(name);
  if (!clean) return { error: NAME_RULE, status: 400 };
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

// 改名：值留在进程内，不经过任何接口返回。旧名可以是非法名，新名必须合法。
function rename(from, to) {
  const oldName = cleanName(from);
  if (!oldName || !entries.has(oldName)) return { error: 'entry not found', status: 404 };
  const newName = cleanNewName(to);
  if (!newName) return { error: NAME_RULE, status: 400 };
  if (newName === oldName) return { entry: entries.get(oldName), unchanged: true };
  if (entries.has(newName)) return { error: 'target name already exists', status: 409 };
  const entry = { ...entries.get(oldName), name: newName, updatedAt: new Date().toISOString() };
  entries.delete(oldName);
  entries.set(newName, entry);
  save();
  return { entry };
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

// ── Env projection: 统一注入子进程环境变量 ──────────────────────────────────
// Every vault entry whose name is a legal env-var identifier is injected into
// spawned CLI children under the SAME name (no per-entry mapping config).
// Two guards keep the host in control of its own routing:
//   1. Names in provider/transport namespaces (ANTHROPIC_/CLAUDE_/OPENAI_/
//      CODEX_/MULTICC_) are never injected — they could hijack per-session
//      provider routing, resurrect a purged official-relay bypass, or land in
//      the per-session --settings mirror (which would copy the value to disk).
//   2. applyEnvOverlay is set-if-absent, so anything the provider stack, login
//      pins or host markers already set stays authoritative.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // 旧条目里的非法名仍靠它过滤
const ENV_EXCLUDED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'MULTICC_'];

function envOverlay() {
  const overlay = {};
  for (const [name, entry] of entries) {
    if (!ENV_NAME_RE.test(name)) continue; // '.', '-' 等名字只进保险箱，不进 env
    if (ENV_EXCLUDED_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
    overlay[name] = entry.value;
  }
  return overlay;
}

// 常驻进程的环境在 spawn 时就固定了：把「保险箱里这批变量在 env 里的当前值」压成摘要，
// 供常驻流判断「自从进程起来后保险箱变过没有」（新增/改值/删除都会让摘要变化）。
// 只返回哈希，不含明文。
function envDigest(env) {
  const names = Object.keys(envOverlay()).sort();
  if (!names.length) return '';
  const hash = require('crypto').createHash('sha256');
  for (const name of names) {
    const value = env && typeof env === 'object' && typeof env[name] === 'string' ? env[name] : '';
    hash.update(name).update('\0').update(value).update('\0');
  }
  return hash.digest('hex');
}

function applyEnvOverlay(env, context = {}) {
  if (!env || typeof env !== 'object') return env;
  const overlay = envOverlay();
  const names = Object.keys(overlay).filter(name => !(name in env));
  return secretAudit.call('env_inject', { source: 'child_env', sessionId: env.MULTICC_SESSION_ID, ...context }, names, () => {
    for (const name of names) env[name] = overlay[name];
    return env;
  });
}

function mount(app) {
  app.get('/api/secrets', (req, res) => {
    res.json(module.exports.list({ source: 'http' }));
  });
  app.post('/api/secrets', (req, res) => {
    const body = req.body || {};
    const result = module.exports.upsert({
      name: body.name,
      value: body.value,
      description: body.description,
      source: body.source === 'agent' ? 'agent' : 'user',
      sessionId: body.sessionId,
    }, { source: 'http', sessionId: body.sessionId });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.status(result.created ? 201 : 200).json({ ok: true, entry: meta(result.entry) });
  });
  app.post('/api/secrets/:name/rename', (req, res) => {
    const result = module.exports.rename(req.params.name, (req.body || {}).to, { source: 'http' });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true, entry: meta(result.entry) });
  });
  app.delete('/api/secrets/:name', (req, res) => {
    const result = module.exports.remove(req.params.name, { source: 'http' });
    if (result.error) return res.status(result.status || 404).json({ error: result.error });
    res.json(result);
  });
  // Value read for the panel's reveal action only. Named separately from the
  // list route so access logs make the value-touching calls obvious.
  app.get('/api/secrets/:name/value', (req, res) => {
    const result = module.exports.reveal(req.params.name, { source: 'http' });
    if (result.error) return res.status(result.status || 404).json({ error: result.error });
    res.json({ ok: true, name: result.entry.name, value: result.entry.value });
  });
}

load();

module.exports = {
  STORE,
  NAME_RE,
  LEGACY_NAME_RE,
  mount,
  list: context => secretAudit.call('list', context, [], safeList),
  upsert: (input, context) => secretAudit.call('upsert', context, [input?.name], () => upsert(input)),
  remove: (name, context) => secretAudit.call('remove', context, [name], () => remove(name)),
  rename: (from, to, context) => secretAudit.call('rename', context, [from, to], () => rename(from, to)),
  reveal: (name, context) => secretAudit.call('reveal', context, [name], () => reveal(name)),
  has,
  envOverlay: context => secretAudit.call('env_overlay', context, Object.keys(envOverlay()), envOverlay),
  envDigest,
  applyEnvOverlay,
  ENV_EXCLUDED_PREFIXES,
  // Test hooks — the production singleton loads once at require time.
  _resetForTests() { entries = new Map(); },
  _saveForTests: save,
  _loadForTests: load,
};
