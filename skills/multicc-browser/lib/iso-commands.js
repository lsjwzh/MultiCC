'use strict';

// CLI side of isolation environments (isolation.js): `envs`, `route`, the
// `iso:<id>` profile for page commands, and routing an unqualified `open` to
// the environment that already holds the site.
//
// Routing is sticky per MultiCC session: an `open` without -p that lands in an
// environment makes it this session's default until the next unqualified
// `open` routes elsewhere, so the snapshot/click that follow reach the same
// page. An explicit -p or MBROWSER_PROFILE always wins.

const P = require('./paths');
const I = require('./isolation');
const client = require('./client');

const { MbError } = P;

const READ_COMMANDS = new Set(['open', 'tabs', 'text', 'snapshot']);
const MAX_ORIGINS = 12;

function routesPath() {
  return require('path').join(P.stateDir(), 'routes.json');
}

function loadRoutes() {
  const data = P.readJson(routesPath(), null);
  return data && typeof data === 'object' && data.sessions && typeof data.sessions === 'object'
    ? data : { sessions: {} };
}

function sessionRoute(owner = client.ownerFromEnv()) {
  return loadRoutes().sessions[owner] || null;
}

function saveSessionRoute(owner, value) {
  P.ensureStateDirs();
  const data = loadRoutes();
  if (value) data.sessions[owner] = { ...value, at: Date.now() };
  else delete data.sessions[owner];
  // A day-old route is stale; never let the file grow without bound.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, entry] of Object.entries(data.sessions)) {
    if (!entry || Number(entry.at) < cutoff) delete data.sessions[key];
  }
  P.writeJson(routesPath(), data);
}

// --------------------------------------------------------------- envs / route

function controlText(entry) {
  if (entry.control === 'agent') return 'full control (MultiCC Agent gateway, private pipe)';
  if (entry.control === 'cdp') return 'full control (loopback DevTools port)';
  if (entry.control === 'read') return 'read-only (plugin page bridge: open/tabs/text/snapshot)';
  return 'not running';
}

function describe(entry, { siteLimit = 8 } = {}) {
  const used = (entry.sites || []).filter(site => site.visits > 0);
  const sites = used.length ? used : (entry.sites || []);
  const siteText = entry.sites === null
    ? `sites: unknown (${entry.sitesNote || 'not read'})`
    : `sites: ${sites.slice(0, siteLimit).map(site => `${site.site}${site.visits ? `×${site.visits}` : ''}`).join(', ') || '(none yet)'}` +
      (sites.length > siteLimit ? ` … +${sites.length - siteLimit}` : '');
  return [
    `${entry.ref}  account: ${entry.account}${entry.note ? ` (${entry.note})` : ''}`,
    `  plugin: ${entry.pluginId}  egress: ${entry.egress || '-'}  ${controlText(entry)}`,
    `  ${siteText}`,
  ].join('\n');
}

async function envs({ filter } = {}) {
  const all = await I.listEnvironments();
  let list = all;
  let routed = null;
  if (filter) {
    routed = I.route(filter, all);
    const refs = new Set(routed.candidates.map(candidate => candidate.ref));
    list = all.filter(entry => refs.has(entry.ref));
  }
  const lines = list.length
    ? list.map(entry => describe(entry))
    : [filter ? `no isolation environment has been used for ${routed.site}` : 'no isolation environments (no isolation plugin, or it has no identities)'];
  lines.push('sites come from each environment\'s own history/cookie host names; a visit is not proof the login is still valid');
  return { text: lines.join('\n\n'), environments: list.map(publicEntry), route: routed };
}

function publicEntry(entry) {
  const { sourceRevision, ...rest } = entry;
  return rest;
}

function routeText(result) {
  const lines = [`${result.host} (site ${result.site}): ${result.reason}`];
  if (result.kind === 'isolation') {
    lines.push(`→ use -p ${result.choice} — ${controlText(result.candidates[0])}`);
  } else if (result.kind === 'ambiguous') {
    for (const candidate of result.candidates) {
      lines.push(`  -p ${candidate.ref}  ${candidate.account}  visits ${candidate.visits}  ${controlText(candidate)}`);
    }
    lines.push('→ ask the user which account (wait_for_user_answer); do not pick by visit count');
  } else {
    lines.push(`→ use -p ${result.choice}`);
  }
  return lines.join('\n');
}

async function route(target) {
  const result = I.route(target, await I.listEnvironments());
  return { text: routeText(result), ...result };
}

// An unqualified `open`: route it. Returns the profile to use and a note, or
// null when it stays on the default profile. Without a reachable MultiCC
// server there is nothing to route to, which is not an error.
async function autoRoute(url) {
  let environments;
  try {
    environments = await I.listEnvironments();
  } catch (error) {
    if (error.code === 'multicc_unavailable') return { profile: null, note: null, warning: `isolation routing skipped: ${error.message}` };
    throw error;
  }
  const owner = client.ownerFromEnv();
  const result = I.route(url, environments);
  if (result.kind === 'ambiguous') {
    throw new MbError('route_ambiguous', `${routeText(result)}\n(or -p main to use the everyday Chrome for it)`);
  }
  if (result.kind === 'isolation') {
    const previous = sessionRoute(owner);
    saveSessionRoute(owner, { profile: result.choice, read: previous && previous.profile === result.choice ? previous.read : undefined });
    return { profile: result.choice, note: `routed to ${result.choice} (${result.candidates[0].account}): ${result.reason}; ` +
      'later commands in this session go there until an open routes elsewhere' };
  }
  if (sessionRoute(owner)) saveSessionRoute(owner, null);
  return { profile: null, note: null };
}

function stickyProfile() {
  const entry = sessionRoute();
  return entry && entry.profile ? entry.profile : null;
}

// ------------------------------------------------------------ page commands

// Both control transports use an attach-only daemon. Private Agent endpoints
// and legacy DevTools ports change on relaunch; retire stale daemons without
// ever closing or restarting the browser.
async function ensureIsoDaemon(entry) {
  const name = I.daemonName(entry);
  const cdpUrl = entry.control === 'agent' ? entry.wsUrl : `http://127.0.0.1:${entry.port}`;
  const existing = P.readJson(P.configPath(name), null) || {};
  if (existing.cdpUrl !== cdpUrl || !existing.iso || Boolean(existing.gateway) !== (entry.control === 'agent')) {
    P.ensureStateDirs();
    P.writeJson(P.configPath(name), {
      name,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
      attachOnly: true,
      headed: true,
      cdpUrl,
      gateway: entry.control === 'agent',
      iso: { ref: entry.ref, pluginId: entry.pluginId, profileId: entry.profileId, account: entry.account },
    });
    const running = await client.pingOnce(name);
    if (running && running.cdpUrl !== cdpUrl) {
      await client.requestOnce(P.socketPath(name), { id: 1, cmd: 'shutdown', args: { keepChrome: true } },
        { timeout: 15000 }).catch(() => {});
      await client.waitForSocketGone(P.socketPath(name), 5000);
    }
  }
  return name;
}

function readOnlyError(entry, command) {
  return new MbError('iso_read_only',
    `${command}: ${entry.ref} (${entry.account}) is read-only — the plugin started it with a private pipe and no ` +
    'DevTools port, so only open/tabs/text/snapshot work there. For clicks or typing: ask the user to do that step ' +
    'in that window, or (with their consent) use MultiCC Agent desktop control. Do not redo it in the everyday ' +
    'Chrome or another environment: that mixes the account with another profile and IP.');
}

function cleanTitle(page) {
  return `${page.title || '(untitled)'} — ${page.url}`;
}

async function readOnly(entry, command, args, flags) {
  if (!READ_COMMANDS.has(command)) throw readOnlyError(entry, command);
  const owner = client.ownerFromEnv();
  const stored = sessionRoute(owner);
  const state = stored && stored.read && stored.read.ref === entry.ref ? stored.read : { ref: entry.ref, origins: [], pages: {} };
  const remember = current => {
    const keep = stored && stored.profile ? stored.profile : entry.ref;
    saveSessionRoute(owner, { profile: keep, read: { ...state, ...current } });
  };
  const status = await I.bridge(entry, 'status', { origins: state.origins.length ? state.origins : ['https://example.com'] });
  const instanceId = status.instanceId;

  if (command === 'open') {
    const url = String(args.url || '');
    const origin = I.originOf(url);
    let parsed = null;
    try { parsed = new URL(url); } catch (_) { /* reported below */ }
    if (!origin || !parsed || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new MbError('iso_url_rejected',
        `${entry.ref} is read-only and its page bridge only opens plain https URLs without a port, query or fragment (got ${url})`);
    }
    const origins = [origin, ...state.origins.filter(item => item !== origin)].slice(0, MAX_ORIGINS);
    const opened = await I.bridge(entry, 'open-page', { url, origins: [origin], expectedInstanceId: instanceId });
    const pages = { ...state.pages, [opened.targetId]: origin };
    remember({ origins, pages, current: opened.targetId, instanceId });
    return {
      text: `open ${url} in a background tab ${String(opened.targetId).slice(0, 8)} of ${entry.ref} (${entry.account}, read-only environment)`,
      targetId: opened.targetId, environment: entry.ref, readOnly: true,
    };
  }

  const extraOrigins = String(flags.domain || '').split(',').map(item => item.trim()).filter(Boolean)
    .map(domain => I.originOf(`https://${domain.replace(/^https?:\/\//, '')}`)).filter(Boolean);
  const origins = [...new Set([...extraOrigins, ...state.origins])].slice(0, MAX_ORIGINS);

  if (command === 'tabs') {
    if (!origins.length) {
      throw new MbError('usage', `${entry.ref} is read-only: its page bridge only lists pages of named sites; use \`tabs --domain example.com\``);
    }
    const listed = await I.bridge(entry, 'pages', { origins });
    const pages = { ...state.pages };
    for (const page of listed.pages || []) pages[page.targetId] = page.origin;
    remember({ origins, pages, instanceId });
    const lines = (listed.pages || []).map(page =>
      `${String(page.targetId).slice(0, 8)} ${page.targetId === state.current ? '*' : 'page'} ${cleanTitle(page)}`);
    return { text: lines.join('\n') || `(no pages for ${origins.join(', ')})`, tabs: listed.pages || [], environment: entry.ref, readOnly: true };
  }

  // text / snapshot: read the current (or --tab) page's text.
  const wanted = flags.tab
    ? Object.keys(state.pages).find(id => id === flags.tab || id.startsWith(String(flags.tab).toUpperCase()) || id.startsWith(flags.tab))
    : state.current;
  if (!wanted) {
    throw new MbError('no_target', flags.tab
      ? `no page ${flags.tab} known in ${entry.ref}; run \`tabs --domain …\` first`
      : `no current page in ${entry.ref} for this session; \`open\` one first`);
  }
  const read = await I.bridge(entry, 'read-page', { targetId: wanted, origins: [state.pages[wanted]], expectedInstanceId: instanceId });
  const page = read.page || {};
  const max = Number(args.maxChars) > 0 ? Number(args.maxChars) : 20000;
  let body = String(page.text || '');
  const cut = body.length > max;
  if (cut) body = `${body.slice(0, max)}\n[...TRUNCATED at ${max} chars]`;
  remember({ current: wanted, instanceId });
  const header = command === 'snapshot'
    ? `page: ${cleanTitle(page)}  [${entry.ref}, read-only: page text, no element refs]\n`
    : '';
  return { text: `${header}${body}${page.truncated ? '\n[page text truncated by the bridge]' : ''}`, page, environment: entry.ref, readOnly: true };
}

async function runPageCommand(ref, command, args, flags) {
  const entry = await I.resolveEnvironment(ref);
  if (entry.control === 'stopped') {
    throw new MbError('iso_not_running',
      `${entry.ref} (${entry.account}) is not running. Starting it opens a browser window, so ask the user first; ` +
      `with their OK: \`mbrowser start ${entry.ref}\`, or they start it from the plugin.`);
  }
  if (entry.control === 'cdp' || entry.control === 'agent') {
    const name = await ensureIsoDaemon(entry);
    const result = await client.call(name, command, args, { tab: flags.tab });
    return { ...result, environment: entry.ref };
  }
  return readOnly(entry, command, args, flags);
}

// ------------------------------------------------------------- lifecycle

async function start(ref, { url } = {}) {
  const entry = await I.resolveEnvironment(ref);
  if (entry.control !== 'stopped') {
    return { text: describe(entry), environment: publicEntry(entry), launched: false };
  }
  const input = { id: entry.profileId };
  if (url) input.url = url;
  const launched = await I.runPlugin(entry.pluginId, 'launch', input);
  const after = await I.resolveEnvironment(ref).catch(() => entry);
  return {
    text: `${entry.ref} (${entry.account}) launched by ${entry.pluginId}; its window may come to the front\n${describe(after)}`,
    environment: publicEntry(after),
    launched: true,
    plugin: launched,
  };
}

async function status(ref) {
  const entry = await I.resolveEnvironment(ref);
  return { text: describe(entry), environment: publicEntry(entry) };
}

// mbrowser never stops an isolation environment; it only retires its own
// attach daemon. The instance belongs to the plugin (and its proxy relay).
async function stop(ref) {
  const entry = await I.resolveEnvironment(ref);
  const name = I.daemonName(entry);
  const running = await client.pingOnce(name);
  if (running) {
    await client.requestOnce(P.socketPath(name), { id: 1, cmd: 'shutdown', args: { keepChrome: true } },
      { timeout: 15000 }).catch(() => {});
    await client.waitForSocketGone(P.socketPath(name), 5000);
  }
  const owner = client.ownerFromEnv();
  const stored = sessionRoute(owner);
  if (stored && stored.profile === entry.ref) saveSessionRoute(owner, null);
  return {
    text: `${entry.ref}: ${running ? 'mbrowser daemon stopped' : 'no mbrowser daemon'}; the environment itself is untouched ` +
      '(stop it from the plugin if the user wants it closed)',
  };
}

module.exports = {
  READ_COMMANDS,
  routesPath,
  sessionRoute,
  saveSessionRoute,
  describe,
  envs,
  route,
  autoRoute,
  stickyProfile,
  ensureIsoDaemon,
  runPageCommand,
  start,
  status,
  stop,
};
