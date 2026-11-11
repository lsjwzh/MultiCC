'use strict';

// Regenerates native/gateway/tests/fixtures/provider-limit-history.json.
//
//   node scripts/generate-provider-limit-history-fixture.js          # verify
//   node scripts/generate-provider-limit-history-fixture.js --write  # rewrite
//
// The expectations come from the frozen Node oracle
// (tests/helpers/legacy-provider-limit-history-route.js) mounted in a real
// Express app, writing through the real napi RustQuotaHistory. The route's
// clock is pinned to one fixed `base` per run, so generatedAt/sinceMs and the
// seeded sample timestamps are the only run-dependent numbers; they are
// replaced by <now>/<since>/<at:LABEL> exactly like the Rust test does.
// Everything else is copied from the oracle byte for byte.
//
// The napi addon is resolved like the rest of the tree: MULTICC_RUST_ADDON,
// then MULTICC_RUST_PREBUILT_DIR, then native/prebuilt/<platform>-<arch>.
// Isolation: its own data root, HOME and working directory under $TMPDIR/provider-limit-history-port/.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const target = path.join(root, 'native', 'gateway', 'tests', 'fixtures', 'provider-limit-history.json');
const ORACLE_PATH = path.join(root, 'tests', 'helpers', 'legacy-provider-limit-history-route.js');
const RUNTIME_PATH = path.join(root, 'src', 'native', 'runtime.js');

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 14 * DAY;
const EXPLICIT_OFFSET = 9_000_000;

// Same scenario as the committed fixture; keep it in one place so the cases
// below read as requests, not as expected bodies.
const PROVIDERS = [
  { id: 'claude-relay', appType: 'claude', name: 'Relay', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://relay', ANTHROPIC_AUTH_TOKEN: 't' } } },
  { id: 'codex-relay', appType: 'codex', name: 'Relay', settingsConfig: { auth: { OPENAI_API_KEY: 'k' }, config: 'base_url = "https://relay/v1"\n' } },
  { id: 'claude-idle', appType: 'claude', name: 'Idle', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://idle', ANTHROPIC_AUTH_TOKEN: 't' } } },
];

const SAMPLES = [
  { label: '3h', offsetMs: 3 * 60 * 60 * 1000, appType: 'claude', providerId: 'claude-relay', summary: { kind: 'window', windows: [{ window: '5h', label: '5h', usedPercent: 10 }] } },
  { label: '2h', offsetMs: 2 * 60 * 60 * 1000, appType: 'claude', providerId: 'claude-relay', summary: { kind: 'window', windows: [{ window: '5h', label: '5h', usedPercent: 20 }] } },
  { label: '1h', offsetMs: 60 * 60 * 1000, appType: 'claude', providerId: 'claude-relay', // The kernel stores remaining = 100 - usedPercent, so 40/60 render as 60/40.
  summary: { kind: 'window', windows: [{ window: '5h', label: '5h', usedPercent: 40 }, { window: '1wk', label: '1wk', usedPercent: 60 }] } },
  { label: '90m', offsetMs: 90 * 60 * 1000, appType: 'codex', providerId: 'codex-relay', summary: { kind: 'balance', available: true, total: 12.5, currency: 'USD' } },
];

const UNAVAILABLE_CASES = [
  { name: 'GET unavailable', method: 'GET', url: '/api/providers/limit-history' },
  { name: 'GET unavailable again', method: 'GET', url: '/api/providers/limit-history?range=7d' },
];

const CASES = [
  { name: 'GET default', method: 'GET', url: '/api/providers/limit-history' },
  { name: 'GET range 7d', method: 'GET', url: '/api/providers/limit-history?range=7d' },
  { name: 'GET range 30d points 3', method: 'GET', url: '/api/providers/limit-history?range=30d&points=3' },
  { name: 'GET toString', method: 'GET', url: '/api/providers/limit-history?range=toString' },
  { name: 'GET points 0', method: 'GET', url: '/api/providers/limit-history?points=0' },
  { name: 'GET points 1', method: 'GET', url: '/api/providers/limit-history?points=1' },
  { name: 'GET explicit since', method: 'GET', url: '/api/providers/limit-history?points=2&since=<explicit>' },
  // qs numeric indexes: a single index is an array of one, two indexes become
  // NaN, index 1000 is an object; the Rust parser must mirror all three.
  { name: 'GET points index 0', method: 'GET', url: '/api/providers/limit-history?points[0]=5' },
  { name: 'GET points index 1', method: 'GET', url: '/api/providers/limit-history?points[1]=5' },
  { name: 'GET points indexes 0,1', method: 'GET', url: '/api/providers/limit-history?points[0]=5&points[1]=6' },
  { name: 'GET points index 20', method: 'GET', url: '/api/providers/limit-history?points[20]=5' },
  { name: 'GET points index 21', method: 'GET', url: '/api/providers/limit-history?points[21]=5' },
  { name: 'GET points index 1000', method: 'GET', url: '/api/providers/limit-history?points[1000]=5' },
  { name: 'GET points encoded index', method: 'GET', url: '/api/providers/limit-history?points%5B0%5D=5' },
  { name: 'GET points push', method: 'GET', url: '/api/providers/limit-history?points[]=5' },
  { name: 'GET points index and push', method: 'GET', url: '/api/providers/limit-history?points[0]=5&points[]=6' },
  { name: 'GET points nested index', method: 'GET', url: '/api/providers/limit-history?points[0][0]=5' },
  { name: 'GET since index 0', method: 'GET', url: '/api/providers/limit-history?since[0]=<explicit>' },
  { name: 'GET since object key', method: 'GET', url: '/api/providers/limit-history?since[a]=1' },
  { name: 'GET range index 0', method: 'GET', url: '/api/providers/limit-history?range[0]=7d' },
  { name: 'GET appType codex', method: 'GET', url: '/api/providers/limit-history?appType=codex' },
  { name: 'GET appType bogus', method: 'GET', url: '/api/providers/limit-history?appType=bogus' },
  { name: 'GET id relay', method: 'GET', url: '/api/providers/limit-history?id=claude-relay' },
  { name: 'GET id missing', method: 'GET', url: '/api/providers/limit-history?id=nope' },
  { name: 'HEAD default', method: 'HEAD', url: '/api/providers/limit-history' },
  { name: 'OPTIONS', method: 'OPTIONS', url: '/api/providers/limit-history' },
  { name: 'GET If-None-Match star', method: 'GET', url: '/api/providers/limit-history', headers: { 'If-None-Match': '*' } },
];

const COMMENT = [
  'Golden responses for native/gateway/tests/provider_limit_history.rs.',
  'Generated by scripts/generate-provider-limit-history-fixture.js from the frozen',
  'Node oracle (tests/helpers/legacy-provider-limit-history-route.js) with the real',
  'napi RustQuotaHistory and express pipeline. Timestamps written by the seed are',
  'replaced by <at:LABEL>; generatedAt/sinceMs by <now>/<since>. The Rust test seeds',
  'the same offsets relative to its own clock and applies the same normalization.',
];

function send(port, { method, url, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.setTimeout(10_000, () => request.destroy(new Error(`${method} ${url}: no answer within 10s`)));
    request.on('error', reject);
    request.end();
  });
}

/** Replaces one JSON property whose value is an integer, leaving null alone. */
function replaceNumber(text, prefix, replacement) {
  const start = text.indexOf(prefix);
  if (start < 0) return text;
  const valueStart = start + prefix.length;
  let end = valueStart;
  if (text[end] === '-') end += 1;
  while (end < text.length && text[end] >= '0' && text[end] <= '9') end += 1;
  if (end === valueStart) return text;
  return text.slice(0, start) + replacement + text.slice(end);
}

/** Same normalization as native/gateway/tests/provider_limit_history.rs. */
function normalize(text, base) {
  let out = replaceNumber(text, '"generatedAt":', '"generatedAt":"<now>"');
  out = replaceNumber(out, '"sinceMs":', '"sinceMs":"<since>"');
  for (const sample of SAMPLES) {
    out = out.split(String(base - sample.offsetMs)).join(`"<at:${sample.label}>"`);
  }
  return out;
}

function caseUrl(url, base) {
  return url.split('<explicit>').join(String(base - EXPLICIT_OFFSET));
}

async function collect(port, cases, base, { available }) {
  const rows = [];
  for (const definition of cases) {
    const url = caseUrl(definition.url, base);
    const response = await send(port, { method: definition.method, url, headers: definition.headers });
    const body = normalize(response.body, base);
    const parseable = response.status === 200 && response.body.startsWith('{');
    const parsed = parseable ? JSON.parse(response.body) : null;
    const row = {
      name: definition.name,
      method: definition.method,
      url: definition.url,
    };
    if (definition.headers) row.headers = definition.headers;
    row.status = response.status;
    row.available = parsed ? parsed.available : available;
    row.allow = response.headers.allow || null;
    row.cacheControl = response.headers['cache-control'] || null;
    row.contentType = response.headers['content-type'] || null;
    row.contentEncoding = response.headers['content-encoding'] || null;
    if (parsed && Number.isFinite(parsed.sinceMs)) {
      if (definition.url.includes('<explicit>')) {
        row.sinceOffsetMs = null;
        row.explicitSinceOffsetMs = base - parsed.sinceMs;
      } else {
        row.sinceOffsetMs = parsed.generatedAt - parsed.sinceMs;
        row.explicitSinceOffsetMs = null;
      }
    } else {
      row.sinceOffsetMs = null;
      row.explicitSinceOffsetMs = null;
    }
    row.points = parsed && Number.isFinite(parsed.points) ? parsed.points : null;
    row.conditional = response.status === 304;
    row.options = definition.method === 'OPTIONS';
    row.head = definition.method === 'HEAD';
    row.body = body;
    if (row.conditional) {
      row.allow = response.headers.allow || null;
      row.points = null;
      row.available = available;
    }
    rows.push(row);
  }
  return rows;
}

async function mountApp(dataRoot, historyFile, base) {
  // MULTICC_DATA_DIR is pinned by src/providers/core.js at load time.
  process.env.MULTICC_DATA_DIR = dataRoot;
  const express = require('express');
  const ORACLE = require(ORACLE_PATH);
  const providers = require(path.join(root, 'src', 'providers', 'core.js'));
  providers.enableUnifiedOfficialProviders();
  const history = ORACLE.createLegacyProviderQuotaHistory({
    file: historyFile,
    logger: { warn() {} },
  });
  const app = express();
  ORACLE.mountLegacyProviderLimitHistoryRoutes(app, {
    history,
    providers,
    now: () => base,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, history };
}

async function buildDocument(work) {
  const data = path.join(work, 'data');
  const home = path.join(work, 'home');
  const unavailable = path.join(work, 'unavailable');
  for (const dir of [work, data, home, unavailable]) fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TMPDIR = work;

  const base = Date.now();
  fs.writeFileSync(path.join(data, 'providers.json'), JSON.stringify(PROVIDERS));
  fs.writeFileSync(path.join(data, 'official-provider-selection.json'), JSON.stringify({ claude: 'global', codex: 'global' }));

  const { getNative, runNative } = require(RUNTIME_PATH);
  const historyFile = path.join(data, 'provider-quota-history.db');
  const kernel = new (getNative().RustQuotaHistory)(historyFile, RETENTION);
  for (const sample of SAMPLES) {
    await runNative(() => kernel.record(JSON.stringify({
      appType: sample.appType,
      providerId: sample.providerId,
      sampledAt: base - sample.offsetMs,
      summary: sample.summary,
    })));
  }

  const available = await mountApp(data, historyFile, base);
  let cases;
  try {
    cases = await collect(available.port, CASES, base, { available: true });
  } finally {
    await new Promise((resolve) => available.server.close(resolve));
  }

  // The unavailable store is a separate first-open failure: the adapter never
  // retries, and the route answers the same shape on every request.
  fs.writeFileSync(path.join(unavailable, 'providers.json'), JSON.stringify(PROVIDERS));
  fs.writeFileSync(path.join(unavailable, 'official-provider-selection.json'), JSON.stringify({ claude: 'global', codex: 'global' }));
  const unavailableFile = path.join(unavailable, 'provider-quota-history.db');
  fs.writeFileSync(unavailableFile, 'not a sqlite database\n');
  const offline = await mountApp(unavailable, unavailableFile, base);
  let unavailableCases;
  try {
    unavailableCases = await collect(offline.port, UNAVAILABLE_CASES, base, { available: false });
  } finally {
    await new Promise((resolve) => offline.server.close(resolve));
  }

  return {
    comment: COMMENT,
    providers: PROVIDERS,
    samples: SAMPLES,
    cases,
    unavailableCases,
  };
}

async function build() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-limit-history-port-'));
  try {
    // RustQuotaHistory owns SQLite until its native handle is finalized. The
    // child must exit before its parent removes the files on Windows.
    const child = spawnSync(process.execPath, [__filename, '--collect', work], {
      encoding: 'utf8', timeout: 120_000,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`history fixture collection failed: ${child.stderr}`);
    return JSON.parse(child.stdout);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const write = process.argv.includes('--write');
  const fixture = await build();
  const next = `${JSON.stringify(fixture, null, 2)}\n`;
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (write) {
    if (current === next) {
      console.log('provider limit history fixture already current');
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next);
    console.log(`Generated ${path.relative(root, target)} (${fixture.cases.length} cases, ${fixture.unavailableCases.length} unavailable)`);
    return;
  }
  if (current !== next) {
    console.error(`${path.relative(root, target)} is stale; run node scripts/generate-provider-limit-history-fixture.js --write`);
    process.exit(1);
  }
  console.log(`provider limit history fixture current: ${fixture.cases.length} cases, ${fixture.unavailableCases.length} unavailable`);
}

if (require.main === module) {
  const collect = process.argv[2] === '--collect';
  const run = collect
    ? buildDocument(process.argv[3]).then(fixture => process.stdout.write(JSON.stringify(fixture)))
    : main();
  run.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { build, normalize, replaceNumber, CASES, PROVIDERS, SAMPLES };
