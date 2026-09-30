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

// Sequential fallback chain, not a race: cheap on the outbound link and
// avoids hammering three vendors for every refresh tick.
const CANDIDATES = Object.freeze([
  {
    id: 'ipinfo',
    url: 'https://ipinfo.io/json',
    parse(body) {
      const data = JSON.parse(body);
      return typeof data.ip === 'string' ? data.ip.trim() : null;
    },
  },
  {
    id: 'ipify',
    url: 'https://api.ipify.org?format=json',
    parse(body) {
      const data = JSON.parse(body);
      return typeof data.ip === 'string' ? data.ip.trim() : null;
    },
  },
  {
    id: 'icanhazip',
    url: 'https://icanhazip.com',
    parse(body) {
      const ip = String(body).trim();
      return ip || null;
    },
  },
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

function fetchCandidate(candidate) {
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
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        done(reject, new Error(`http_${res.statusCode}`));
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

async function detectEgressIp() {
  let lastError = null;
  for (const candidate of CANDIDATES) {
    try {
      const ip = await fetchCandidate(candidate);
      return { ip, source: candidate.id };
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(`all egress-ip candidates failed (${lastError ? lastError.message : 'unknown'})`);
  error.code = 'EGRESS_IP_DETECT_FAILED';
  throw error;
}

let cache = { ip: null, checkedAt: null, error: null, source: null };
let timer = null;
let inFlight = null;

function getCachedEgressIp() {
  return { ...cache };
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
  isValidIp,
  getCachedEgressIp,
  refreshEgressIpNow,
  ensureMonitorStarted,
  stopEgressIpMonitor,
};
