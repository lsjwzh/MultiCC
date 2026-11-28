'use strict';

// Detects this machine's current public/egress IP so provider records can be
// pinned to it (see egress-ip-policy.js). The chat-turn admission gate that
// consumes this module is a synchronous call in a deliberately-synchronous
// pipeline (durable-delivery ordering), so a real network round-trip cannot
// happen inline with a message. Instead this module keeps a background
// refresh loop (short interval) and exposes a synchronous cache read; the
// gate reads whatever the last refresh found. The loop only starts once
// something actually asks (see ensureMonitorStarted), so machines with no
// egress-IP-restricted provider never make this background call.

const https = require('https');

const REQUEST_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 8 * 1024;
const REFRESH_INTERVAL_MS = 2000;
// One refresh tries at most this many services before giving up, so a bad network
// costs a bounded wait rather than a walk through the whole list.
const MAX_ATTEMPTS = 4;
// A service that failed sits out for a while instead of being retried on the next
// tick. Plain failures back off 30s, 1m, 2m ... up to 10 minutes; a refusal that
// says "you are asking too much" (429, 403 ...) sits out 15 minutes, because free
// IP-echo services meter by day or month and retrying every 2s only keeps it hot.
const COOLDOWN_BASE_MS = 30 * 1000;
const COOLDOWN_MAX_MS = 10 * 60 * 1000;
const COOLDOWN_REFUSED_MS = 15 * 60 * 1000;

// Parsers: every service answers in one of three shapes.
const asText = body => String(body).trim().split(/\s+/)[0] || null;
const asJson = body => {
  const data = JSON.parse(body);
  return typeof data.ip === 'string' ? data.ip.trim() : null;
};
// Cloudflare's /cdn-cgi/trace is `key=value` lines; the address is `ip=`.
const asTrace = body => {
  const match = /^ip=(.+)$/m.exec(String(body));
  return match ? match[1].trim() : null;
};

// Only services that answer from the same side of the network as the providers do.
// Domestic (CN) echo services are left out on purpose: under a split-routing VPN they
// are reached DIRECT and report the home IP, while api.anthropic.com is reached
// through the proxy and sees the proxy's — an allowlist checked against the wrong one
// would pass or fail for the wrong reason.
//
// Ordered by how much headroom they have, not by preference: each refresh starts one
// service further along (round-robin), so load spreads evenly and no single free tier
// takes 43,000 requests a day. The two that meter hardest are last.
const CANDIDATES = Object.freeze([
  { id: 'cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: asTrace },
  { id: 'cloudflare-1111', url: 'https://1.1.1.1/cdn-cgi/trace', parse: asTrace },
  { id: 'aws', url: 'https://checkip.amazonaws.com', parse: asText },
  { id: 'ipify', url: 'https://api.ipify.org?format=json', parse: asJson },
  { id: 'icanhazip', url: 'https://icanhazip.com', parse: asText },
  { id: 'ifconfig-me', url: 'https://ifconfig.me/ip', parse: asText },
  { id: 'ifconfig-co', url: 'https://ifconfig.co/ip', parse: asText },
  { id: 'ip-sb', url: 'https://api.ip.sb/ip', parse: asText },
  { id: 'ident-me', url: 'https://ident.me', parse: asText },
  { id: 'seeip', url: 'https://api.seeip.org/jsonip', parse: asJson },
  { id: 'ipecho', url: 'https://ipecho.net/plain', parse: asText },
  { id: 'wtfismyip', url: 'https://wtfismyip.com/text', parse: asText },
  { id: 'ipwho', url: 'https://ipwho.is/', parse: asJson },
  { id: 'ipinfo', url: 'https://ipinfo.io/json', parse: asJson },
  { id: 'ipapi', url: 'https://ipapi.co/ip/', parse: asText },
]);

function isValidIp(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v)) {
    return v.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  if (v.includes(':') && /^[0-9a-fA-F:]+$/.test(v)) return true;
  return false;
}

// `family` 4 forces an IPv4 lookup. Services differ in whether they answer over v4 or
// v6 on a dual-stack host; mixing them would make the reported address flip between
// families, and an allowlist match would flap with it.
function fetchCandidate(candidate, family = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const req = https.get(candidate.url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': 'multicc-egress-ip-check' },
      ...(family ? { family } : {}),
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        const error = new Error(`http_${res.statusCode}`);
        error.status = res.statusCode;
        done(reject, error);
        return;
      }
      let body = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          done(reject, new Error('response_too_large'));
          return;
        }
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        try {
          const ip = candidate.parse(body);
          if (!isValidIp(ip)) { done(reject, new Error('invalid_ip')); return; }
          done(resolve, ip);
        } catch (error) {
          done(reject, error);
        }
      });
      res.on('error', (error) => done(reject, error));
    });
    req.on('timeout', () => { req.destroy(); done(reject, new Error('timeout')); });
    req.on('error', (error) => done(reject, error));
  });
}

// The detector keeps its own memory of which services have been failing, so a
// refresh never spends its time on one that is known to be refusing us.
function createDetector({
  candidates = CANDIDATES, fetcher = fetchCandidate, now = Date.now, maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const health = new Map(candidates.map(candidate => [candidate.id, { failures: 0, until: 0, lastError: null }]));
  let cursor = 0;

  const refused = error => error && (error.status === 429 || error.status === 403 || error.status === 402 || error.status === 451);

  function punish(candidate, error) {
    const entry = health.get(candidate.id);
    entry.failures += 1;
    entry.lastError = error && error.message ? error.message : String(error);
    const wait = refused(error)
      ? COOLDOWN_REFUSED_MS
      : Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (entry.failures - 1));
    entry.until = now() + wait;
  }

  // Who to ask this time: rotate the start so load spreads, drop services that are
  // cooling down, and if every one of them is, probe the two closest to recovering
  // rather than going dark.
  function plan() {
    const start = cursor % candidates.length;
    cursor = (cursor + 1) % candidates.length;
    const rotated = candidates.slice(start).concat(candidates.slice(0, start));
    const ready = rotated.filter(candidate => health.get(candidate.id).until <= now());
    if (ready.length) return ready;
    return rotated.slice().sort((x, y) => health.get(x.id).until - health.get(y.id).until).slice(0, 2);
  }

  // `record: false` is for the retry of services that just failed on this very
  // refresh: it must not count that failure a second time.
  async function pass(order, family, { record = true } = {}) {
    let lastError = null;
    for (const candidate of order.slice(0, maxAttempts)) {
      try {
        const ip = await fetcher(candidate, family);
        const entry = health.get(candidate.id);
        entry.failures = 0;
        entry.until = 0;
        entry.lastError = null;
        return { ip, source: candidate.id };
      } catch (error) {
        lastError = error;
        if (record) punish(candidate, error);
      }
    }
    throw lastError || new Error('no candidates');
  }

  async function detect() {
    const order = plan();
    let lastError = null;
    try {
      return await pass(order, 4);
    } catch (error) {
      lastError = error;
    }
    // An IPv6-only network answers nothing over v4. Only then is an unconstrained
    // lookup worth a try, and only against the first two services.
    try {
      return await pass(order.slice(0, 2), 0, { record: false });
    } catch (error) {
      lastError = error || lastError;
    }
    const failure = new Error(`all egress-ip candidates failed (${lastError ? lastError.message : 'unknown'})`);
    failure.code = 'EGRESS_IP_DETECT_FAILED';
    throw failure;
  }

  function snapshot() {
    const at = now();
    return candidates.map(candidate => {
      const entry = health.get(candidate.id);
      return { id: candidate.id, failures: entry.failures, coolingDown: entry.until > at, retryInMs: Math.max(0, entry.until - at), lastError: entry.lastError };
    });
  }

  return { detect, snapshot };
}

const detector = createDetector();

function detectEgressIp() {
  return detector.detect();
}

let cache = { ip: null, checkedAt: null, error: null, source: null };
let timer = null;
let inFlight = null;

function getCachedEgressIp() {
  return { ...cache };
}

// Per-service health, for diagnostics: which are cooling down and why.
function getEgressIpSources() {
  return detector.snapshot();
}

function refreshEgressIpNow() {
  if (inFlight) return inFlight;
  inFlight = detectEgressIp()
    .then(({ ip, source }) => {
      cache = { ip, checkedAt: Date.now(), error: null, source };
      return cache;
    })
    .catch((error) => {
      cache = { ip: cache.ip, checkedAt: cache.checkedAt, error: error.message || String(error), source: cache.source };
      return cache;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function ensureMonitorStarted(options = {}) {
  if (timer) return;
  const interval = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : REFRESH_INTERVAL_MS;
  refreshEgressIpNow().catch(() => {});
  timer = setInterval(() => { refreshEgressIpNow().catch(() => {}); }, interval);
  if (timer.unref) timer.unref();
}

function stopEgressIpMonitor() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  CANDIDATES,
  createDetector,
  getEgressIpSources,
  isValidIp,
  getCachedEgressIp,
  refreshEgressIpNow,
  ensureMonitorStarted,
  stopEgressIpMonitor,
};
