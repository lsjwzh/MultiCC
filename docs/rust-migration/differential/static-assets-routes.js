'use strict';
// Differential run for the static-asset rules retired from
// src/routes/static-assets.js and now answered by
// native/gateway/src/app/static_assets_routes.rs (rules in
// native/core/src/static_assets_routes.rs):
//
//   GET|HEAD  /manage  /manage.html        -> 302 /air?view=…
//   GET|HEAD  /dashboard  /dashboard.html  -> 302 /air?view=overview…
//   GET|HEAD  /air  /air.html?view=planner -> 302 /air?view=overview…
//   GET|HEAD  *.{apk,ipa}                  -> 404 Cache-Control: no-store
//
//   node docs/rust-migration/differential/static-assets-routes.js <repo> <gateway>
//
// The Node side mounts the FROZEN oracle (tests/helpers/
// legacy-static-assets-routes.js, a byte-for-byte copy of the module at the
// parent of the retirement commit) over an empty public/ directory. Requests
// the retired module would have passed on therefore land on a marker
// middleware (`599 node-fell-through`). The Rust side forwards every request
// it does not claim to a PROXY v1 stub that answers `599 forwarded` and logs
// each URL, so a fallback is proven twice: the oracle fell through and the
// front door did not claim it.
//
// Claimed cases must be byte-for-byte identical (status, body, headers per
// lib.view). The run also proves it fails when the rules are wrong: with
// MULTICC_STATIC_ASSETS_MUTATION=whitelist-drop|alias-wrong|param-order the
// gateway perturbs one constant on the wire and this script must exit red.
// The parent run spawns those three variants and prints their results.
//
// Four counts are printed at the end: corpus total, byte-identical, claimed,
// fallback.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { run } = require('./lib');

const HDR = { Host: 'localhost', 'X-Request-Id': 'diff-sa-1' };
const HTML = { ...HDR, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const JSON_ONLY = { ...HDR, Accept: 'application/json' };
const ANY = { ...HDR, Accept: '*/*' };

const VIEWS = [
  'overview', 'schedules', 'docs', 'memory', 'plugins', 'settings', 'voice', 'goal', 'aux',
  'provider', 'global', 'push', 'tunnel', 'bridges', 'resources', 'skillsync', 'storage',
];
const MANAGE_VIEWS = VIEWS.concat([
  'cron', 'tasks', 'planner', 'bogus', '', '__proto__', 'constructor', 'toString',
]);
const PARAMS = [
  'token=t1&external=e1&dir=d1&task=k1',
  'token=&external=&dir=&task=',
  'token=a&token=b&external=a&external=b',
  'token[a]=1&dir[a]=1&task[a]=1',
  'external=e1&task=k1&dir=d1&token=t1',
  'token=a%20b%26c&dir=%E4%B8%AD%E6%96%87&task=%7E%21*%27%28%29',
];

const MANAGE_PATHS = ['/manage', '/manage.html'];
const DASH_PATHS = ['/dashboard', '/dashboard.html'];
const AIR_PATHS = ['/air', '/air.html'];

// `/multicc.apk` in any casing is claimed earlier by the release-history
// cluster (the retired `mountApkDownload` sat in front of this module), so it
// lives in the release-history corpus; every other `.apk`/`.ipa` spelling is
// this guard's.
const GUARD_NAMES = [
  '/x.apk', '/x.APK', '/x.ipa', '/a.b.ipa', '/nested/other.apk', '/plugins/x/y.apk',
  '/x%2Eapk', '/%61pk.APK', '/multicc-ios.IPA', '/nested%2Fother.apk',
  '/x%zz.apk', '/a.b.c.apk', '/dir/x.apk?download=1', '/.apk', '/ipa.IPA',
  '/x.apk?token=t', '/x.ipa?dir=d', '/a/b/c/d.ipa', '/public/webcc.apk',
];

/** The marker middleware's exact answer, with and without a HEAD body. */
const isNodeFallthrough = v => v.status === 599
  && (v.body === 'node-fell-through'
    || (v.body === '' && v.headers['content-length'] === String('node-fell-through'.length)));
/** The PROXY stub's exact answer, with and without a HEAD body. */
const isRustForward = v => v.status === 599
  && (v.body === 'forwarded' || (v.body === '' && v.headers['content-length'] === '9'));

/** URLs recorded for the fallback set; every one must reach the PROXY stub. */
const fallbackUrls = new Set();
/** Each fallback case's expected shapes, for the finalize audit. */
const fallbackMatchers = new Map();

function corpus() {
  const cases = [];
  const add = (name, request) => cases.push([name, request]);
  const get = (name, url, headers = HDR) => add(name, { method: 'GET', url, headers });
  const head = (name, url, headers = HDR) => add(name, { method: 'HEAD', url, headers });
  const options = (name, url) => add(name, { method: 'OPTIONS', url, headers: HDR });
  // A request the front door must keep forwarding: the oracle falls through,
  // the Rust upstream sees it. Both predicates are exact.
  const fallback = (name, request, matchers = { node: isNodeFallthrough, rust: isRustForward }) => {
    fallbackUrls.add(request.url);
    fallbackMatchers.set(name, matchers);
    cases.push([name, request, { expectedDifference: matchers }]);
  };

  // ── /manage: the alias table, the 17-name allowlist and the fallback ──────
  for (const p of MANAGE_PATHS) {
    for (const view of MANAGE_VIEWS) {
      const label = `manage ${p} view=${view || '(empty)'}`;
      get(`claimed:${label}`, `${p}?view=${encodeURIComponent(view)}`);
      get(`claimed:${label} + params`, `${p}?view=${encodeURIComponent(view)}&token=t1&external=e1&dir=d1&task=k1`);
      get(`claimed:${label} + empty values`, `${p}?view=${encodeURIComponent(view)}&token=&external=&dir=&task=`);
    }
  }
  for (const p of MANAGE_PATHS) {
    for (const params of PARAMS) {
      get(`claimed:manage ${p} ?${params}`, `${p}?view=docs&${params}`);
    }
    for (const focus of ['aux', 'other', '']) {
      get(`claimed:manage ${p} focus=${focus || '(empty)'}`, `${p}?focus=${focus}`);
    }
    get(`claimed:manage ${p} focus=aux&view=docs`, `${p}?focus=aux&view=docs`);
    get(`claimed:manage ${p} accept html`, `${p}?view=docs`, HTML);
    get(`claimed:manage ${p} accept json only`, `${p}?view=docs`, JSON_ONLY);
    get(`claimed:manage ${p} accept any`, `${p}?view=docs`, ANY);
    head(`claimed:manage HEAD ${p}`, `${p}?view=storage&token=t`);
    head(`claimed:manage HEAD ${p} empty view`, `${p}?view=`);
  }
  get('claimed:manage mixed case + trailing slash', '/Manage.HTML/?view=docs');
  get('claimed:manage trailing slash', '/manage/?view=docs');

  // ── /dashboard: the fixed overview and its own parameter order ────────────
  for (const p of DASH_PATHS) {
    get(`claimed:dashboard ${p} bare`, p);
    for (const params of PARAMS) {
      get(`claimed:dashboard ${p} ?${params}`, `${p}?${params}`);
    }
    head(`claimed:dashboard HEAD ${p}`, `${p}?dir=d&task=k`);
    get(`claimed:dashboard ${p} accept html`, `${p}?token=t`, HTML);
    get(`claimed:dashboard ${p} accept json only`, `${p}?token=t`, JSON_ONLY);
  }
  get('claimed:dashboard mixed case + trailing slash', '/Dashboard.HTML/');
  get('claimed:dashboard view is ignored', '/dashboard?view=docs&token=t');

  // ── /air: only ?view=planner is claimed ───────────────────────────────────
  for (const p of AIR_PATHS) {
    get(`claimed:air ${p} planner`, `${p}?view=planner`);
    for (const params of PARAMS) {
      get(`claimed:air ${p} planner ?${params}`, `${p}?view=planner&${params}`);
    }
    head(`claimed:air HEAD ${p} planner`, `${p}?view=planner&dir=d`);
    get(`claimed:air ${p} planner accept html`, `${p}?view=planner&token=t`, HTML);
    get(`claimed:air ${p} planner accept json only`, `${p}?view=planner`, JSON_ONLY);
  }
  get('claimed:air trailing slash planner', '/air/?view=planner');

  // ── the global `.apk` / `.ipa` guard ──────────────────────────────────────
  for (const name of GUARD_NAMES) {
    get(`claimed:guard GET ${name}`, name);
    head(`claimed:guard HEAD ${name}`, name);
  }

  // ── Express's automatic OPTIONS for the registered paths ──────────────────
  for (const p of [...MANAGE_PATHS, ...DASH_PATHS, ...AIR_PATHS]) {
    options(`claimed:options ${p}`, p);
  }
  options('claimed:options /manage/', '/manage/');
  options('claimed:options /air.html/', '/air.html/');

  // ── Fallbacks: everything the retired module passed on ────────────────────
  for (const url of [
    '/air', '/air?view=overview', '/air?view=docs', '/air?view=planner&view=docs',
    '/air?view[a]=planner', '/air?view=', '/air?focus=aux', '/Air?view=overview',
  ]) {
    fallback(`fallback:${url}`, { method: 'GET', url, headers: HDR });
  }
  for (const url of ['/air', '/air.html?view=settings']) {
    fallback(`fallback:HEAD ${url}`, { method: 'HEAD', url, headers: HDR });
  }
  for (const [method, url] of [
    ['POST', '/manage'], ['POST', '/dashboard'], ['PUT', '/air?view=planner'],
    ['DELETE', '/y.ipa'], ['POST', '/x.apk'],
    ['POST', '/multicc-ios.ipa'], ['PATCH', '/plugins/x.apk'],
  ]) {
    fallback(`fallback:${method} ${url}`, { method, url, headers: HDR, body: '{}' });
  }
  // An OPTIONS request that matches no registered route: Express's automatic
  // answer has no method list, so the app's final handler 404s it.
  fallback(
    'fallback:OPTIONS /x.apk (no route layers)',
    { method: 'OPTIONS', url: '/x.apk', headers: HDR },
    {
      node: v => v.status === 404 && !v.headers.location && !v.headers.allow,
      rust: isRustForward,
    },
  );
  // `/multicc-ios.ipa` has no route anywhere; `/multicc.apk` (and its case
  // and trailing-slash variants) is the release-history cluster's, so its
  // fallbacks moved to that corpus with it.
  for (const url of ['/multicc-ios.ipa']) {
    fallback(`fallback:GET ${url}`, { method: 'GET', url, headers: HDR });
    fallback(`fallback:HEAD ${url}`, { method: 'HEAD', url, headers: HDR });
  }
  for (const url of [
    '/x.apk/', '/foo.apk.txt', '/x.apx', '/apk', '/manage//', '/manage/extra',
    '/dashboardextra', '/air/extra', '/manage.htmlx',
  ]) {
    fallback(`fallback:edge ${url}`, { method: 'GET', url, headers: HDR });
  }
  for (const url of ['/x.apk/']) {
    fallback(`fallback:edge HEAD ${url}`, { method: 'HEAD', url, headers: HDR });
  }

  return cases;
}

/** The PROXY v1 stub: every unclaimed request is logged and answered 599. */
function upstream(repo, rootDir, work) {
  const log = path.join(work, 'forwarded.jsonl');
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const fs = require('node:fs');
const path = require('node:path');
const repo = ${JSON.stringify(repo)};
const log = ${JSON.stringify(log)};
// The front door's auth gate needs a live control channel before it answers;
// the real child opens it in src/gateway-child.js.
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
const server = http.createServer((req, res) => {
  fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url }) + '\\n');
  if (req.url.split('?')[0] === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' }); res.end('ok'); return;
  }
  res.writeHead(599, { 'Content-Type': 'text/plain', 'Content-Length': '9' }); res.end('forwarded');
});
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.on('error', () => {}); let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\\r\\n'); if (end < 0) return;
    socket.removeListener('data', onData); socket.pause();
    const rest = buffered.subarray(end + 2); if (rest.length) socket.unshift(rest);
    server.emit('connection', socket); socket.resume();
  };
  socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
}

/** Coverage the corpus must actually exercise, by case-name prefix. */
const REQUIRED = [
  'claimed:manage /manage view=overview',
  'claimed:manage /manage view=schedules',
  'claimed:manage /manage view=storage',
  'claimed:manage /manage view=cron',
  'claimed:manage /manage view=tasks',
  'claimed:manage /manage view=planner',
  'claimed:manage /manage view=bogus',
  'claimed:manage /manage view=__proto__',
  'claimed:manage /manage view=constructor',
  'claimed:manage /manage focus=aux',
  'claimed:manage /manage focus=other',
  'claimed:manage /manage ?token=t1&external=e1&dir=d1&task=k1',
  'claimed:manage /manage.html ?token=a&token=b&external=a&external=b',
  'claimed:manage /manage ?token[a]=1&dir[a]=1&task[a]=1',
  'claimed:manage /manage ?token=a%20b%26c&dir=%E4%B8%AD%E6%96%87&task=%7E%21*%27%28%29',
  'claimed:manage /manage accept html',
  'claimed:manage HEAD /manage',
  'claimed:manage mixed case + trailing slash',
  'claimed:dashboard /dashboard bare',
  'claimed:dashboard /dashboard ?external=e1&task=k1&dir=d1&token=t1',
  'claimed:dashboard HEAD /dashboard',
  'claimed:dashboard view is ignored',
  'claimed:air /air planner',
  'claimed:air /air planner ?token=t1&external=e1&dir=d1&task=k1',
  'claimed:air HEAD /air planner',
  'claimed:air trailing slash planner',
  'claimed:guard GET /x.apk',
  'claimed:guard HEAD /x.APK',
  'claimed:guard GET /plugins/x/y.apk',
  'claimed:guard GET /nested%2Fother.apk',
  'claimed:guard GET /x%2Eapk',
  'claimed:options /manage',
  'claimed:options /air',
  'fallback:/air',
  'fallback:/air?view=docs',
  'fallback:/air?view=planner&view=docs',
  'fallback:POST /manage',
  'fallback:DELETE /y.ipa',
  'fallback:OPTIONS /x.apk (no route layers)',
  'fallback:GET /multicc-ios.ipa',
  'fallback:edge /x.apk/',
  'fallback:edge /foo.apk.txt',
];

function finalize({ views, work }) {
  const problems = [];
  const claimed = views.filter(v => v.name.startsWith('claimed:'));
  const fallbacks = views.filter(v => v.name.startsWith('fallback:'));
  const total = views.length;
  let identical = 0;
  for (const v of claimed) {
    if (JSON.stringify(v.node) === JSON.stringify(v.rust)) {
      identical++;
    } else {
      problems.push(`claimed mismatch: ${v.name}\n  node ${JSON.stringify(v.node)}\n  rust ${JSON.stringify(v.rust)}`);
    }
  }
  for (const v of fallbacks) {
    const matchers = fallbackMatchers.get(v.name) || { node: isNodeFallthrough, rust: isRustForward };
    if (matchers.node(v.node) !== true) {
      problems.push(`fallback not seen by the oracle: ${v.name}`);
    }
    if (matchers.rust(v.rust) !== true) {
      problems.push(`fallback claimed by the front door: ${v.name}`);
    }
  }
  // Every fallback URL must show up in the PROXY stub's log: the front door
  // forwarded it, not merely declined to answer it.
  const logPath = path.join(work, 'forwarded.jsonl');
  const forwarded = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  for (const url of fallbackUrls) {
    if (!forwarded.some(entry => entry.url === url)) {
      problems.push(`fallback url never reached the PROXY stub: ${url}`);
    }
  }
  const missing = REQUIRED.filter(name => !views.some(v => v.name === name));
  for (const name of missing) problems.push(`corpus lost a required case: ${name}`);
  if (total < 300) problems.push(`corpus too small: ${total} < 300`);
  if (claimed.length === 0) problems.push('no claimed cases');
  if (fallbacks.length === 0) problems.push('no fallback cases');
  if (identical !== claimed.length) problems.push(`only ${identical}/${claimed.length} claimed cases are byte-identical`);
  console.log(`[static-assets] corpus total=${total}; byte-identical=${identical}; claimed=${claimed.length}; fallback=${fallbacks.length}`);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    return { ok: false, problems };
  }
  return { ok: true };
}

const MUTATIONS = ['whitelist-drop', 'alias-wrong', 'param-order'];

let upstreamText = '';

const spec = {
  name: 'static-assets',
  mount(app, ctx) {
    const publicDir = path.join(ctx.work, 'node-public');
    fs.mkdirSync(publicDir, { recursive: true });
    const legacy = require(path.join(ctx.repo, 'tests/helpers/legacy-static-assets-routes'));
    legacy.createStaticAssetsRoutes({ express: ctx.express, fs: require('node:fs'), path: require('node:path'), publicDir }).mountRoutes(app);
    // Anything the retired module passed on dies here with a marker body.
    // OPTIONS is left to the app's automatic answer, exactly like Node.
    app.use((req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      res.status(599).type('text/plain').send('node-fell-through');
    });
    upstreamText = upstream(ctx.repo, ctx.work, ctx.work);
  },
  get upstream() {
    return upstreamText;
  },
  corpus,
  finalize,
  gatewayEnv() {
    const mutation = process.env.MULTICC_STATIC_ASSETS_MUTATION;
    return mutation ? { MULTICC_STATIC_ASSETS_MUTATION: mutation } : {};
  },
};

async function main() {
  const argv = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (process.argv.includes('--mutation-run')) {
    const ok = await run(spec, argv);
    process.exit(ok ? 0 : 1);
  }
  const ok = await run(spec, argv);
  let mutationsOk = true;
  for (const mutation of MUTATIONS) {
    const child = spawnSync(
      process.execPath,
      [__filename, ...argv, '--mutation-run'],
      { env: { ...process.env, MULTICC_STATIC_ASSETS_MUTATION: mutation }, encoding: 'utf8' },
    );
    const detected = child.status === 1 && /^\{"name":/m.test(child.stdout || '');
    if (!detected) mutationsOk = false;
    console.log(`[static-assets] mutation ${mutation}: ${detected ? 'detected (run turned red)' : 'NOT DETECTED'} (exit ${child.status})`);
    if (!detected) {
      console.error((child.stdout || '').split('\n').slice(-8).join('\n'));
      console.error((child.stderr || '').split('\n').slice(-8).join('\n'));
    }
  }
  process.exit(ok && mutationsOk ? 0 : 1);
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { corpus, spec, finalize };
