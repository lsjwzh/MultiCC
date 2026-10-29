'use strict';

// MultiCC browser-isolation plugins (chrome-proxy-launcher and anything that
// speaks the same commands): each keeps one isolated Chrome per identity, with
// its own user-data-dir, its own egress IP and, usually, one login account.
// mbrowser finds them, says which accounts and sites each environment holds,
// and routes work for a site to the environment that already has it.
//
// An environment is addressed as `iso:<profileId>` (or `iso:<pluginId>/<id>`
// when two plugins share an id). How far mbrowser can drive it depends on how
// the plugin started it:
//   cdp      the instance listens on a loopback DevTools port: full control,
//            through a daemon that attaches like `attach` (never launches,
//            stops or restarts it)
//   read     the plugin's own launch only opens a private pipe; the plugin's
//            read bridge (multicc-browser-read-v1) can list pages, read a
//            page's text and open a background tab — nothing else
//   stopped  not running; only an explicit `start iso:…` asks the plugin to
//            launch it (that opens a window, so never as a side effect)
//
// Plugins are reached through the MultiCC server's plugin API, the same path
// the plugin UI uses; mbrowser never runs plugin binaries itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const P = require('./paths');
const CH = require('./chrome');
const { portOpen } = require('./main-chrome');

const { MbError } = P;

const ISO_PREFIX = 'iso:';
const READ_PROTOCOL = 'multicc-browser-read-v1';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const API_TIMEOUT_MS = 40000;
// Hosts whose registrable domain is three labels deep.
const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.tw',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.au', 'net.au', 'co.nz', 'com.sg', 'com.my',
  'co.in', 'com.br', 'com.mx', 'com.tr', 'co.za', 'co.id', 'com.vn', 'com.ph',
]);

function isIsoRef(name) {
  return typeof name === 'string' && name.startsWith(ISO_PREFIX);
}

function parseIsoRef(ref) {
  const body = String(ref || '').slice(ISO_PREFIX.length);
  const parts = body.split('/');
  const [pluginId, profileId] = parts.length === 2 ? parts : [null, parts[0]];
  if (parts.length > 2 || !ID_RE.test(profileId || '') || (pluginId !== null && !ID_RE.test(pluginId))) {
    throw new MbError('usage', `invalid isolation environment ${JSON.stringify(ref)}: use iso:<id> or iso:<plugin>/<id> (see \`mbrowser envs\`)`);
  }
  return { pluginId, profileId };
}

// The daemon behind a `cdp` environment needs a profile-shaped name for its
// socket, lock and log.
function daemonName(env) {
  const plain = `iso-${env.profileId}`;
  if (P.isValidName(plain)) return plain;
  const digest = crypto.createHash('sha1').update(`${env.pluginId}/${env.profileId}`).digest('hex').slice(0, 16);
  return `iso-${digest}`;
}

// ------------------------------------------------------------------ plugin API

function baseUrl(env = process.env) {
  return String(env.MULTICC_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

async function api(pathname, { body, env = process.env, timeoutMs = API_TIMEOUT_MS } = {}) {
  const url = `${baseUrl(env)}${pathname}`;
  let response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new MbError('multicc_unavailable',
      `cannot reach the MultiCC server at ${baseUrl(env)} (${error.cause ? error.cause.code || error.cause.message : error.message}); ` +
      'isolation environments are found through it');
  }
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* not JSON */ }
  if (!response.ok || !payload || payload.error) {
    const detail = payload && payload.error ? payload.error : `HTTP ${response.status}`;
    throw new MbError('plugin_error', `${pathname}: ${detail}`);
  }
  return payload;
}

// A plugin is an isolation plugin when it can list identities, launch them and
// answer the page-read bridge.
function isIsolationPlugin(plugin) {
  const commands = Array.isArray(plugin && plugin.commands) ? plugin.commands : [];
  return ['list', 'launch', 'browser-read'].every(command => commands.includes(command));
}

async function isolationPlugins(options = {}) {
  const payload = await api('/api/plugins', options);
  return (payload.plugins || []).filter(isIsolationPlugin)
    .map(plugin => ({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || null }));
}

function runPlugin(pluginId, command, input, options = {}) {
  return api(`/api/plugins/${encodeURIComponent(pluginId)}/run`,
    { ...options, body: input === undefined ? { command } : { command, input } });
}

// ------------------------------------------------------------ environment data

function dataRoot(pluginId, env = process.env) {
  if (env.MBROWSER_ISO_DATA_ROOT) return path.join(path.resolve(env.MBROWSER_ISO_DATA_ROOT), pluginId);
  return path.join(env.HOME || os.homedir(), '.multicc', 'plugins-data', pluginId);
}

function siteOf(host) {
  const clean = String(host || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!clean || /^[\d.]+$/.test(clean) || clean.includes(':')) return clean;
  const labels = clean.split('.');
  if (labels.length <= 2) return clean;
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(SECOND_LEVEL.has(lastTwo) ? -3 : -2).join('.');
}

let sqlite;
function sqliteModule() {
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
  }
  return sqlite;
}

function openImmutable(mod, file) {
  return new mod.DatabaseSync(`file:${encodeURI(file)}?immutable=1`, { readOnly: true });
}

function tally(rows, map, key) {
  for (const row of rows) {
    const site = siteOf(row.host);
    if (!site) continue;
    const entry = map.get(site) || { site, visits: 0, cookies: 0 };
    entry[key] += Number(row.n || 0);
    map.set(site, entry);
  }
}

// Which sites an environment has been used for. Two local databases, read
// for host names and counts only, opened `immutable` so a running Chrome is
// neither locked nor disturbed:
//   History  top-level pages the user actually opened there (the signal:
//            ad-tech cookies from embedded frames never show up here)
//   Cookies  host column only — values stay encrypted and are never read
// Either says "used for this site"; whether it is still logged in has to be
// checked on the page.
function profileSites(userDataDir) {
  const mod = sqliteModule();
  if (!mod) return { sites: null, reason: 'node:sqlite unavailable (Node 22.13+ needed)' };
  const map = new Map();
  const problems = [];
  const sources = [
    ['History', 'visits', "SELECT substr(url, instr(url, '://') + 3) AS rest, SUM(visit_count) AS n FROM urls WHERE url LIKE 'http%' GROUP BY rest"],
    ['Cookies', 'cookies', 'SELECT host_key AS host, COUNT(*) AS n FROM cookies GROUP BY host_key'],
  ];
  for (const [name, key, sql] of sources) {
    const file = path.join(userDataDir, 'Default', name);
    if (!fs.existsSync(file)) continue;
    let db;
    try {
      db = openImmutable(mod, file);
      let rows = db.prepare(sql).all();
      if (key === 'visits') {
        rows = rows.map(row => ({ host: String(row.rest || '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^[^@]*@/, ''), n: row.n }));
      }
      tally(rows, map, key);
    } catch (error) {
      problems.push(`${name} unreadable: ${error.message}`);
    } finally {
      try { if (db) db.close(); } catch (_) { /* ignore */ }
    }
  }
  const sites = [...map.values()]
    .sort((a, b) => b.visits - a.visits || b.cookies - a.cookies || a.site.localeCompare(b.site));
  return { sites, reason: problems.length ? problems.join('; ') : null };
}

// The read bridge only answers a caller that names the identity exactly as
// the plugin last saved it (plugins/chrome-proxy-launcher/src/read_bridge.rs
// source_revision).
function sourceRevision(profile, subscriptions) {
  let subscription = null;
  if (profile.subscription && profile.subscription.id) {
    const source = (subscriptions || []).find(entry => entry.id === profile.subscription.id);
    if (source) subscription = { id: source.id, updatedAt: source.updatedAt, sourceBytes: source.sourceBytes };
  }
  return { profileCreatedAt: profile.createdAt, profileUpdatedAt: profile.updatedAt, subscription, confidence: 'public_metadata' };
}

async function controlOf(profile, userDataDir) {
  if (!profile.running) return { control: 'stopped' };
  const active = CH.readsDevToolsActivePort(userDataDir);
  // DevToolsActivePort outlives a pipe-only relaunch, so the port must answer
  // and the process holding the profile must be the running instance.
  if (active && await portOpen(active.port)) {
    const holder = CH.singletonLockHolder(userDataDir);
    if (!holder || !profile.pid || holder === profile.pid) {
      return { control: 'cdp', port: active.port, wsUrl: `ws://127.0.0.1:${active.port}${active.wsPath}` };
    }
  }
  return { control: 'read' };
}

async function listEnvironments({ env = process.env, sites = true } = {}) {
  const plugins = await isolationPlugins({ env });
  const out = [];
  for (const plugin of plugins) {
    const listing = await runPlugin(plugin.id, 'list', undefined, { env });
    const subscriptions = listing.subscriptions || [];
    for (const profile of listing.profiles || []) {
      if (!profile || !ID_RE.test(String(profile.id || ''))) continue;
      const userDataDir = path.join(dataRoot(plugin.id, env), 'chrome-profiles', profile.id);
      const control = await controlOf(profile, userDataDir);
      const used = sites ? profileSites(userDataDir) : { sites: null, reason: 'not read' };
      out.push({
        ref: `${ISO_PREFIX}${profile.id}`,
        pluginId: plugin.id,
        pluginName: plugin.name,
        profileId: profile.id,
        account: profile.name || profile.id,
        note: profile.note || '',
        egress: profile.egressText || profile.egressType || '',
        running: Boolean(profile.running),
        pid: profile.pid || null,
        ...control,
        userDataDir,
        sites: used.sites,
        sitesNote: used.reason,
        sourceRevision: sourceRevision(profile, subscriptions),
      });
    }
  }
  // Two plugins can carry the same id; such refs must name the plugin.
  const counts = new Map();
  for (const entry of out) counts.set(entry.profileId, (counts.get(entry.profileId) || 0) + 1);
  for (const entry of out) {
    if (counts.get(entry.profileId) > 1) entry.ref = `${ISO_PREFIX}${entry.pluginId}/${entry.profileId}`;
  }
  return out;
}

async function resolveEnvironment(ref, options = {}) {
  const { pluginId, profileId } = parseIsoRef(ref);
  const all = await listEnvironments({ ...options, sites: false });
  const matches = all.filter(entry => entry.profileId === profileId && (!pluginId || entry.pluginId === pluginId));
  if (!matches.length) {
    throw new MbError('no_environment', `no isolation environment ${ref}; \`mbrowser envs\` lists them`);
  }
  if (matches.length > 1) {
    throw new MbError('usage', `${ref} is ambiguous: ${matches.map(entry => `${ISO_PREFIX}${entry.pluginId}/${entry.profileId}`).join(', ')}`);
  }
  return matches[0];
}

// ---------------------------------------------------------------------- routing

function hostOf(target) {
  const value = String(target || '').trim();
  if (!value || /^(?:about|file|data|javascript|chrome):/i.test(value)) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch (_) {
    return null;
  }
}

// Isolation environments come first — they exist to keep an account on its
// own profile and IP. One match is a decision; several are a question for the
// user (never "the one with the most cookies"); none falls back to `fallback`.
function route(target, environments, { fallback = 'main' } = {}) {
  const host = hostOf(target);
  if (!host) throw new MbError('usage', `route needs an http(s) URL or a domain, got ${JSON.stringify(target)}`);
  const site = siteOf(host);
  // A visit (top-level page in History) is what counts; cookies alone only
  // count for an environment whose history cannot be read, since embedded
  // ad and analytics frames leave cookies for sites nobody opened.
  const candidates = [];
  for (const entry of environments) {
    const hit = (entry.sites || []).find(item => item.site === site);
    if (!hit) continue;
    const historyKnown = (entry.sites || []).some(item => item.visits > 0);
    if (hit.visits > 0 || (!historyKnown && hit.cookies > 0)) candidates.push({ entry, hit });
  }
  candidates.sort((a, b) => b.hit.visits - a.hit.visits || b.hit.cookies - a.hit.cookies);
  const shaped = candidates.map(({ entry, hit }) => ({
    ref: entry.ref, account: entry.account, note: entry.note, plugin: entry.pluginId,
    egress: entry.egress, control: entry.control, visits: hit.visits, cookies: hit.cookies,
  }));
  if (shaped.length === 1) {
    return { host, site, choice: shaped[0].ref, kind: 'isolation', control: shaped[0].control, candidates: shaped,
      reason: `the only isolation environment that has been used for ${site} (${shaped[0].account})` };
  }
  if (shaped.length > 1) {
    return { host, site, choice: null, kind: 'ambiguous', candidates: shaped,
      reason: `${shaped.length} isolation environments have ${site}; the user picks the account` };
  }
  return { host, site, choice: fallback, kind: 'fallback', candidates: [],
    reason: `no isolation environment has ${site}` };
}

// ------------------------------------------------------------ read-only bridge

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.port ? parsed.origin : null;
  } catch (_) {
    return null;
  }
}

async function bridge(environment, action, extra = {}, options = {}) {
  const input = {
    protocol: READ_PROTOCOL,
    requestId: crypto.randomUUID(),
    profileId: environment.profileId,
    sourceRevision: environment.sourceRevision,
    action,
    ...extra,
  };
  let result;
  try {
    result = await runPlugin(environment.pluginId, 'browser-read', input, options);
  } catch (error) {
    // The instance answered but refused: most often a supervisor started by an
    // older plugin build whose bridge speaks an earlier request shape.
    if (error.code === 'plugin_error') {
      throw new MbError('iso_read_failed',
        `${environment.ref} (${environment.account}) refused the page-bridge ${action} request (${error.message.replace(/^.*?: /, '')}). ` +
        'If this instance was started before the plugin was last updated, it needs one relaunch from the plugin; ' +
        'ask the user — do not restart it yourself.');
    }
    throw error;
  }
  if (result.available === false) {
    throw new MbError(result.reason === 'session_upgrade_required' ? 'iso_restart_required' : 'iso_unavailable',
      `${environment.ref} (${environment.account}): ${result.message || result.reason || 'page bridge unavailable'}` +
      (result.reason === 'session_upgrade_required'
        ? ' — the instance predates the page bridge; ask the user to close and relaunch it from the plugin'
        : ''));
  }
  return result;
}

module.exports = {
  ISO_PREFIX,
  READ_PROTOCOL,
  isIsoRef,
  parseIsoRef,
  daemonName,
  baseUrl,
  isIsolationPlugin,
  isolationPlugins,
  runPlugin,
  dataRoot,
  siteOf,
  hostOf,
  profileSites,
  sourceRevision,
  controlOf,
  listEnvironments,
  resolveEnvironment,
  route,
  originOf,
  bridge,
};
