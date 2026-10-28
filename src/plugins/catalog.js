'use strict';

// Plugin catalog: the signed plugin list published at
// github.com/lsjwzh/multicc-plugins (format and rules: docs/plugin-catalog-design.md).
//
//   index.json       { schema: 1, updatedAt, plugins: [...] }
//   index.json.sig   { schema: 1, keyId, signature }  ed25519 over the exact bytes
//
// The list is fetched from GitHub or a mirror, so its content is trusted only
// when it verifies against a key pinned below; a mirror can speed it up but
// cannot change it. A list older than the cached one is refused, so a stale
// mirror cannot roll a fix back. Everything here is read-only: computing what
// this machine can run. Installing is the next step of the design.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// What plugin.json features this MultiCC understands. A plugin that needs a
// newer one ("requires.pluginApi") is shown as needing a MultiCC upgrade.
const PLUGIN_API_VERSION = 1;
const CATALOG_SCHEMA = 1;
// Keys allowed to sign index.json. To rotate, ship the new key here one
// release before the catalog switches to it, and drop the old one later.
const CATALOG_KEYS = Object.freeze({
  'catalog-2026-10': 'MCowBQYDK2VwAyEAdfDhN/oSaq1KgWb7bn7RqaT7uovSmg/5Hg6iQNEtD1I=',
});
const CATALOG_SOURCES = Object.freeze([
  'https://raw.githubusercontent.com/lsjwzh/multicc-plugins/main/index.json',
  'https://cdn.jsdelivr.net/gh/lsjwzh/multicc-plugins@main/index.json',
]);
const ASSET_URL_PREFIXES = Object.freeze(['https://github.com/', 'https://objects.githubusercontent.com/']);
const DISTRIBUTIONS = new Set(['builtin', 'optional']);
// Requirements this MultiCC can judge. An unknown one makes the release
// unsupported here (a newer MultiCC knows how to check it) instead of ignored.
const KNOWN_REQUIREMENTS = new Set(['multicc', 'pluginApi', 'agentBuild', 'platforms', 'apps', 'permissions']);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PLATFORM_KEY = /^(darwin|linux|win32)-(arm64|x64)$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const FIRST_REFRESH_MS = 15_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_INDEX_BYTES = 1024 * 1024;
const HOST_FACTS_TTL_MS = 60_000;

// ── versions ────────────────────────────────────────────────────────────

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)], pre: match[4] || '' };
}

// NaN when either side is not a version.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  }
  if (pa.pre === pb.pre) return 0;
  // A prerelease sorts before its release.
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function parseRange(range) {
  const text = String(range ?? '').trim();
  if (!text || text === '*') return [];
  const terms = [];
  for (const term of text.split(/\s+/)) {
    const match = /^(>=|<|\^|=)?(.+)$/.exec(term);
    const target = parseVersion(match[2]);
    if (!target) return null;
    terms.push({ op: match[1] || '=', target: match[2], parts: target.parts });
  }
  return terms;
}

// ">=2.13.0", "<3", "^2.13.0", ">=2.13 <3" (all terms must hold), "=1.2.0" or
// "1.2.0" (exactly), "*" or "" (any). An unparsable range is never satisfied.
function satisfies(version, range) {
  const terms = parseRange(range);
  if (!terms || !parseVersion(version)) return false;
  return terms.every(({ op, target, parts }) => {
    const c = compareVersions(version, target);
    if (op === '>=') return c >= 0;
    if (op === '<') return c < 0;
    if (op === '=') return c === 0;
    const upper = parts[0] > 0 ? `${parts[0] + 1}.0.0` : `0.${parts[1] + 1}.0`;
    return c >= 0 && compareVersions(version, upper) < 0;
  });
}

// ── list format ─────────────────────────────────────────────────────────

function str(value) {
  return typeof value === 'string' && value ? value : null;
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item) : [];
}

// Throws on a malformed requires block; the whole release is dropped then.
function checkRequires(requires) {
  if (requires == null) return null;
  if (typeof requires !== 'object' || Array.isArray(requires)) throw new Error('requires must be an object');
  for (const key of ['multicc', 'agentBuild']) {
    if (requires[key] != null && !parseRange(requires[key])) throw new Error(`requires.${key} is not a version range`);
  }
  if (requires.pluginApi != null && !(Number.isSafeInteger(requires.pluginApi) && requires.pluginApi > 0)) {
    throw new Error('requires.pluginApi must be a positive integer');
  }
  if (requires.platforms != null) {
    if (!Array.isArray(requires.platforms) || !requires.platforms.length) throw new Error('requires.platforms must be a non-empty array');
    for (const platform of requires.platforms) {
      if (!platform || !['darwin', 'linux', 'win32'].includes(platform.os)) throw new Error('requires.platforms[].os is unknown');
      if (platform.arch != null && !strings([].concat(platform.arch)).length) throw new Error('requires.platforms[].arch is invalid');
      if (platform.minOS != null && !parseVersion(platform.minOS)) throw new Error('requires.platforms[].minOS is not a version');
    }
  }
  if (requires.apps != null) {
    if (!Array.isArray(requires.apps)) throw new Error('requires.apps must be an array');
    for (const app of requires.apps) {
      if (!app || !BUNDLE_ID.test(String(app.id || ''))) throw new Error('requires.apps[].id is not a bundle id');
      if (app.minVersion != null && !parseVersion(app.minVersion)) throw new Error('requires.apps[].minVersion is not a version');
      if (app.macosPaths != null && !strings(app.macosPaths).every(p => p.startsWith('/Applications/') && p.endsWith('.app'))) {
        throw new Error('requires.apps[].macosPaths must be /Applications/*.app');
      }
    }
  }
  return requires;
}

function checkAssets(assets) {
  if (assets == null) return {};
  if (typeof assets !== 'object' || Array.isArray(assets)) throw new Error('assets must be an object');
  const out = {};
  for (const [platform, asset] of Object.entries(assets)) {
    if (!PLATFORM_KEY.test(platform)) throw new Error(`assets key ${platform} is not <os>-<arch>`);
    const url = str(asset && asset.url);
    if (!url || !ASSET_URL_PREFIXES.some(prefix => url.startsWith(prefix))) throw new Error(`assets.${platform}.url must be on github.com`);
    if (!/^[0-9a-f]{64}$/.test(String(asset.sha256 || ''))) throw new Error(`assets.${platform}.sha256 is invalid`);
    if (!(Number.isSafeInteger(asset.size) && asset.size > 0)) throw new Error(`assets.${platform}.size is invalid`);
    out[platform] = { url, sha256: asset.sha256, size: asset.size };
  }
  return out;
}

function normalizeEntry(raw) {
  if (!raw || !ID_PATTERN.test(String(raw.id || ''))) throw new Error('id is invalid');
  if (!DISTRIBUTIONS.has(raw.distribution)) throw new Error(`distribution ${raw.distribution} is unknown`);
  const entry = {
    id: raw.id,
    name: str(raw.name) || raw.id,
    nameEn: str(raw.nameEn),
    icon: str(raw.icon) || '🧩',
    category: str(raw.category),
    provides: strings(raw.provides),
    distribution: raw.distribution,
    summary: str(raw.summary) || '',
    summaryEn: str(raw.summaryEn),
    homepage: str(raw.homepage) && raw.homepage.startsWith('https://') ? raw.homepage : null,
    builtinSince: null,
    requires: null,
    releases: [],
  };
  if (entry.distribution === 'builtin') {
    if (raw.builtinSince != null && !parseVersion(raw.builtinSince)) throw new Error('builtinSince is not a version');
    entry.builtinSince = str(raw.builtinSince);
    entry.requires = checkRequires(raw.requires);
    return entry;
  }
  const releases = Array.isArray(raw.releases) ? raw.releases : [];
  for (const release of releases) {
    if (!release || !parseVersion(release.version)) throw new Error('releases[].version is not a version');
    entry.releases.push({
      version: release.version,
      publishedAt: str(release.publishedAt),
      requires: checkRequires(release.requires),
      assets: checkAssets(release.assets),
      notes: str(release.notes),
      notesEn: str(release.notesEn),
    });
  }
  if (!entry.releases.length) throw new Error('an optional plugin needs at least one release');
  entry.releases.sort((a, b) => compareVersions(b.version, a.version));
  if (raw.latest != null && !entry.releases.some(release => release.version === raw.latest)) {
    throw new Error(`latest ${raw.latest} is not one of the releases`);
  }
  return entry;
}

// A bad entry is dropped with a warning instead of failing the whole list:
// the signature already proves who wrote it, and one typo should not hide
// every other plugin. A different schema is a different format: rejected.
function parseCatalog(text) {
  const data = JSON.parse(text);
  if (!data || data.schema !== CATALOG_SCHEMA) {
    const error = new Error(`catalog schema ${data && data.schema} is not supported by this MultiCC`);
    error.code = 'CATALOG_SCHEMA';
    throw error;
  }
  if (!Number.isFinite(Date.parse(data.updatedAt))) throw new Error('catalog updatedAt is not a date');
  if (!Array.isArray(data.plugins)) throw new Error('catalog plugins must be an array');
  const plugins = [];
  const warnings = [];
  const seen = new Set();
  for (const raw of data.plugins) {
    try {
      const entry = normalizeEntry(raw);
      if (seen.has(entry.id)) throw new Error('duplicate id');
      seen.add(entry.id);
      plugins.push(entry);
    } catch (error) {
      warnings.push(`${raw && raw.id ? raw.id : '?'}: ${error.message}`);
    }
  }
  return { schema: data.schema, updatedAt: data.updatedAt, plugins, warnings };
}

function verifySignature(body, signatureText, keys = CATALOG_KEYS) {
  let envelope;
  try { envelope = JSON.parse(String(signatureText)); } catch (_) { throw new Error('signature file is not JSON'); }
  const spki = envelope && keys[envelope.keyId];
  if (!spki) throw new Error(`signature key ${envelope && envelope.keyId} is not trusted`);
  const publicKey = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
  const signature = Buffer.from(String(envelope.signature || ''), 'base64');
  if (!crypto.verify(null, Buffer.from(body), publicKey, signature)) throw new Error('signature does not match the list');
  return envelope.keyId;
}

// ── this machine ────────────────────────────────────────────────────────

function run(file, args, timeout = 3000) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
  });
}

async function macAppVersion(app) {
  const candidates = strings(app.macosPaths);
  const found = await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${app.id}"`]);
  candidates.push(...found.split('\n').filter(line => line.endsWith('.app')));
  for (const candidate of candidates) {
    const plist = path.join(candidate, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) continue;
    const id = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
    if (id !== app.id) continue;
    const version = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
    return { path: candidate, version: version || null };
  }
  return null;
}

function installedAgentBuild(rootDir) {
  try {
    const seen = require('../macos-agent-provision').sharedMacosAgentProvisioner({ rootDir }).inspect();
    return seen.installed ? seen.installed.build : null;
  } catch (_) {
    return null;
  }
}

// Facts the requirements are judged against. Cached briefly: the panel asks
// on every open, and an app lookup spawns mdfind.
function createHostFacts({
  platform = process.platform,
  arch = process.arch,
  multiccVersion,
  rootDir = path.join(__dirname, '..', '..'),
  osVersion = async () => (platform === 'darwin' ? run('/usr/bin/sw_vers', ['-productVersion']) : os.release()),
  agentBuild = async () => (platform === 'darwin' ? installedAgentBuild(rootDir) : null),
  appVersion = async app => (platform === 'darwin' ? macAppVersion(app) : null),
  now = () => Date.now(),
} = {}) {
  const version = multiccVersion || require('../../package.json').version;
  let cached = null;
  return async function hostFacts(apps = []) {
    const key = apps.map(app => app.id).sort().join(',');
    if (cached && cached.key === key && now() - cached.at < HOST_FACTS_TTL_MS) return cached.facts;
    const found = {};
    for (const app of apps) {
      const hit = await appVersion(app);
      if (hit) found[app.id] = hit;
    }
    const facts = {
      os: platform, arch, osVersion: (await osVersion()) || null, multicc: version,
      pluginApi: PLUGIN_API_VERSION, agentBuild: await agentBuild(), apps: found,
    };
    cached = { key, at: now(), facts };
    return facts;
  };
}

// The first requirement this machine does not meet, or null. Order: what can
// never change here (system, architecture), then what an upgrade fixes.
function unmetRequirement(requires, host) {
  if (!requires) return null;
  const unknown = Object.keys(requires).find(key => !KNOWN_REQUIREMENTS.has(key));
  if (unknown) return { code: 'unknownRequirement', requirement: unknown };
  if (requires.platforms) {
    const match = requires.platforms.find(platform => platform.os === host.os);
    if (!match) return { code: 'os', current: host.os, supported: requires.platforms.map(platform => platform.os) };
    const arches = match.arch == null ? null : strings([].concat(match.arch));
    if (arches && !arches.includes(host.arch)) return { code: 'arch', current: host.arch, supported: arches };
    if (match.minOS && !(compareVersions(host.osVersion, match.minOS) >= 0)) {
      return { code: 'minOS', os: host.os, required: match.minOS, current: host.osVersion || null };
    }
  }
  if (requires.multicc && !satisfies(host.multicc, requires.multicc)) {
    return { code: 'multicc', required: requires.multicc, current: host.multicc };
  }
  if (requires.pluginApi != null && !(host.pluginApi >= requires.pluginApi)) {
    return { code: 'pluginApi', required: requires.pluginApi, current: host.pluginApi };
  }
  if (requires.agentBuild) {
    if (host.agentBuild == null) return { code: 'agentMissing', required: requires.agentBuild };
    if (!satisfies(String(host.agentBuild), requires.agentBuild)) {
      return { code: 'agentBuild', required: requires.agentBuild, current: host.agentBuild };
    }
  }
  for (const app of requires.apps || []) {
    const found = host.apps && host.apps[app.id];
    const names = { app: app.id, name: str(app.name) || app.id, nameEn: str(app.nameEn) };
    if (!found) return { code: 'appMissing', ...names, required: app.minVersion || null };
    if (app.minVersion && !(compareVersions(found.version, app.minVersion) >= 0)) {
      return { code: 'appVersion', ...names, required: app.minVersion, current: found.version || null };
    }
  }
  return null;
}

function appsReferenced(catalog, installed) {
  const apps = new Map();
  const add = requires => {
    for (const app of (requires && Array.isArray(requires.apps) ? requires.apps : [])) {
      if (app && BUNDLE_ID.test(String(app.id || '')) && !apps.has(app.id)) apps.set(app.id, app);
    }
  };
  for (const entry of (catalog ? catalog.plugins : [])) {
    add(entry.requires);
    entry.releases.forEach(release => add(release.requires));
  }
  installed.forEach(plugin => add(plugin.requires));
  return [...apps.values()];
}

// ── states ──────────────────────────────────────────────────────────────

const STATE_ORDER = ['update', 'incompatible', 'builtin', 'installed', 'installable', 'unsupported'];

// One row per plugin: what the list says, what is on disk, and what this
// machine can do with it. `local` is the installed plugin (plugins.js entry).
function computeStates({ catalog, installed = [], host }) {
  const platformKey = `${host.os}-${host.arch}`;
  const byId = new Map(installed.map(plugin => [plugin.id, plugin]));
  const rows = [];
  for (const entry of (catalog ? catalog.plugins : [])) {
    const local = byId.get(entry.id) || null;
    byId.delete(entry.id);
    const row = {
      id: entry.id, name: entry.name, nameEn: entry.nameEn, icon: entry.icon, category: entry.category,
      provides: entry.provides, distribution: entry.distribution, summary: entry.summary, summaryEn: entry.summaryEn,
      homepage: entry.homepage, listed: true, local, state: null, reason: null,
      installedVersion: local ? local.version : null, candidate: null, latest: null, requires: null, notes: null, notesEn: null,
    };
    if (entry.distribution === 'builtin') {
      row.requires = (local && local.requires) || entry.requires;
      const unmet = unmetRequirement(row.requires, host);
      if (local) {
        row.state = unmet ? 'incompatible' : 'builtin';
        row.reason = unmet;
      } else {
        row.state = 'unsupported';
        row.reason = unmet || (entry.builtinSince && compareVersions(host.multicc, entry.builtinSince) < 0
          ? { code: 'builtinInNewer', required: entry.builtinSince, current: host.multicc }
          : { code: 'builtinMissing' });
      }
      rows.push(row);
      continue;
    }
    const usable = entry.releases.find(release => !unmetRequirement(release.requires, host) && release.assets[platformKey]);
    const latest = entry.releases[0];
    row.latest = latest.version;
    const shown = usable || latest;
    Object.assign(row, { requires: shown.requires, notes: shown.notes, notesEn: shown.notesEn });
    if (local) {
      const own = entry.releases.find(release => release.version === local.version);
      const unmet = unmetRequirement(local.requires || (own && own.requires), host);
      if (unmet) {
        row.state = 'incompatible';
        row.reason = unmet;
      } else if (usable && compareVersions(usable.version, local.version) > 0) {
        row.state = 'update';
        row.candidate = usable.version;
      } else {
        row.state = 'installed';
      }
    } else if (usable) {
      row.state = 'installable';
      row.candidate = usable.version;
    } else {
      row.state = 'unsupported';
      row.reason = unmetRequirement(latest.requires, host) || { code: 'noAsset', platform: platformKey };
    }
    rows.push(row);
  }
  // Installed but not on the list: a local or retired plugin. Still judged by
  // its own plugin.json, and still openable. "Built-in" is the list's word to
  // give: a folder copied into the package plugins/ (a private plugin) is not a
  // built-in just because of where it sits, and a standalone upgrade carries it
  // across (scripts/standalone-cli.js carryUserPlugins). Without the list every
  // one of them is simply installed (listed: null, nobody knows yet).
  for (const local of byId.values()) {
    const unmet = unmetRequirement(local.requires, host);
    rows.push({
      id: local.id, name: local.name, nameEn: local.nameEn, icon: local.icon, category: local.category || null,
      provides: local.provides || [], distribution: null,
      summary: local.description, summaryEn: local.descriptionEn, homepage: null, listed: catalog ? false : null, local,
      state: unmet ? 'incompatible' : 'installed', reason: unmet,
      installedVersion: local.version, candidate: null, latest: null, requires: local.requires || null, notes: null, notesEn: null,
    });
  }
  return rows.sort((a, b) => (STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)) || a.id.localeCompare(b.id));
}

// ── fetch and cache ─────────────────────────────────────────────────────

function isAllowedSource(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname));
  } catch (_) {
    return false;
  }
}

function createPluginCatalog({
  cacheDir,
  sources = CATALOG_SOURCES,
  keys = CATALOG_KEYS,
  env = process.env,
  fetch = (...args) => globalThis.fetch(...args),
  logger = console,
  now = () => Date.now(),
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  if (!cacheDir) throw new TypeError('[plugin-catalog] cacheDir is required');
  const custom = str(env.MULTICC_PLUGIN_CATALOG_URL);
  const urls = [...(custom ? [custom] : []), ...sources].filter(isAllowedSource);
  const files = {
    index: path.join(cacheDir, 'index.json'),
    sig: path.join(cacheDir, 'index.json.sig'),
    meta: path.join(cacheDir, 'meta.json'),
  };
  let current = null; // { catalog, keyId, source, fetchedAt }
  let lastError = null;
  let inflight = null;
  let timers = [];

  function accept(body, sigText) {
    const keyId = verifySignature(body, sigText, keys);
    return { catalog: parseCatalog(body.toString('utf8')), keyId };
  }

  // The cache is re-verified on every load: it sits in a user-writable folder.
  function loadCache() {
    try {
      const body = fs.readFileSync(files.index);
      const { catalog, keyId } = accept(body, fs.readFileSync(files.sig, 'utf8'));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')); } catch (_) { /* optional */ }
      current = { catalog, keyId, source: str(meta.source), fetchedAt: str(meta.fetchedAt) };
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn?.('plugin_catalog_cache_rejected', { error: error.message });
    }
    return current;
  }

  async function get(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_INDEX_BYTES) throw new Error('response too large');
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  function writeCache(body, sigText, meta) {
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const [file, data] of [[files.index, body], [files.sig, sigText], [files.meta, JSON.stringify(meta, null, 2)]]) {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, data);
      fs.renameSync(temporary, file);
    }
  }

  async function refreshOnce() {
    const failures = [];
    for (const url of urls) {
      try {
        const body = await get(url);
        const sigText = (await get(`${url}.sig`)).toString('utf8');
        const { catalog, keyId } = accept(body, sigText);
        if (current && Date.parse(catalog.updatedAt) < Date.parse(current.catalog.updatedAt)) {
          throw new Error(`older than the cached list (${catalog.updatedAt} < ${current.catalog.updatedAt})`);
        }
        const fetchedAt = new Date(now()).toISOString();
        writeCache(body, sigText, { source: url, fetchedAt, updatedAt: catalog.updatedAt, keyId });
        current = { catalog, keyId, source: url, fetchedAt };
        lastError = null;
        if (catalog.warnings.length) logger.warn?.('plugin_catalog_entries_skipped', { warnings: catalog.warnings });
        return snapshot();
      } catch (error) {
        failures.push(`${url}: ${error.message}`);
      }
    }
    lastError = { message: failures.join('; ') || 'no catalog source', at: new Date(now()).toISOString() };
    logger.warn?.('plugin_catalog_refresh_failed', { error: lastError.message });
    return snapshot();
  }

  function refresh() {
    if (!inflight) inflight = refreshOnce().finally(() => { inflight = null; });
    return inflight;
  }

  function snapshot() {
    return {
      catalog: current ? current.catalog : null,
      source: current ? current.source : null,
      fetchedAt: current ? current.fetchedAt : null,
      updatedAt: current ? current.catalog.updatedAt : null,
      error: lastError,
    };
  }

  // Timers never hold the process open; a failed refresh only logs.
  function start() {
    if (timers.length) return;
    const first = setTimeout(() => { void refresh(); }, FIRST_REFRESH_MS);
    const every = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
    first.unref?.();
    every.unref?.();
    timers = [first, every];
  }

  function stop() {
    timers.forEach(timer => clearTimeout(timer));
    timers = [];
  }

  loadCache();
  return { refresh, snapshot, start, stop, loadCache, sources: urls };
}

module.exports = {
  PLUGIN_API_VERSION, CATALOG_SCHEMA, CATALOG_KEYS, CATALOG_SOURCES, STATE_ORDER,
  parseVersion, compareVersions, satisfies, parseCatalog, verifySignature,
  unmetRequirement, appsReferenced, computeStates, createHostFacts, createPluginCatalog,
};
