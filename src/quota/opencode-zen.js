'use strict';

// OpenCode Zen/Go subscription usage, read straight from the vendor API.
//
// The Go plan is the only official OpenCode subscription whose remaining quota
// MultiCC can show, and for a long time the only known source was the
// server-rendered Zen console (see ../routes/opencode-quota.js): drive a Chrome
// that holds the user's opencode.ai login, scrape the SolidStart hydration
// literal out of the HTML. That works, but it depends on a browser session that
// silently expires — the profile cookie outlives the server-side session, so the
// scrape degrades to needs_login weeks later and the bar goes red for a reason
// the user cannot see.
//
// The subscription key is a much better source, and it is already on disk: the
// CLI stores it either as an OAuth/api credential in auth.json (after
// `opencode auth login`) or as a provider apiKey in opencode.json (the shape
// users hand-write for the Go gateway). With it, one authenticated GET returns
// the same three windows the console renders:
//
//   GET https://opencode.ai/zen/go/v1/usage
//   → {"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"<ISO>"},
//               "weekly":{...},"monthly":{...}}}
//
// Verified against the live gateway: 200 with a Go key, 401 AuthError with a
// bogus one, 404 on every other guessed path (/limits, /subscription, /balance,
// /credits) and on the non-Go /zen/v1 base. `percent` is USED percent, matching
// the scraped `usagePercent`, so the bar renderer needs no changes.
//
// This module never touches the network for discovery: reading two small JSON
// files is cheaper than a browser launch and, unlike a cookie, a key does not
// rot without the request telling us.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ZEN_BASE_URL = 'https://opencode.ai/zen/go/v1';
const USAGE_PATH = '/usage';
const TIMEOUT_MS = Number(process.env.OPENCODE_QUOTA_TIMEOUT_MS || 10000);
// Only these provider ids can hold a Zen credential. Matching loosely would
// hand an OpenRouter or Anthropic key to opencode.ai, which is both useless and
// a credential leak to the wrong host.
const ZEN_PROVIDER_ID = /opencode|zen/i;
const ZEN_BASE_URL = /opencode\.ai\/zen/i;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// opencode.json is JSONC in the wild (the CLI ships a commented template), so
// strip // and /* */ before parsing. Naive stripping is safe here: a URL inside
// a string is the only `//` that could be mistaken for a comment, and losing it
// only costs us that one candidate.
function readJsonc(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  const cleaned = String(raw)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

function pushCredential(out, seen, credential) {
  const apiKey = typeof credential.apiKey === 'string' ? credential.apiKey.trim() : '';
  if (!apiKey || seen.has(apiKey)) return;
  seen.add(apiKey);
  out.push({ ...credential, apiKey });
}

// auth.json — what `opencode auth login` writes. Shape per provider id:
//   { type:'api',   key:{ apiKey } }          — a pasted Zen API key
//   { type:'oauth', access, refresh, expiry } — an OAuth session; `access` is
//                                              the bearer the console uses
// Both are worth trying: which one the gateway accepts is the server's call, not
// ours to guess.
function credentialsFromAuthJson(home, env) {
  const files = [
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    path.join(home, '.cache', 'opencode', 'auth.json'),
    env.OPENCODE_AUTH_FILE,
  ].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const file of files) {
    const parsed = readJson(file);
    if (!parsed || typeof parsed !== 'object') continue;
    for (const [id, entry] of Object.entries(parsed)) {
      if (!ZEN_PROVIDER_ID.test(id) || !entry || typeof entry !== 'object') continue;
      const apiKey = entry.type === 'api'
        ? (entry.key && (entry.key.apiKey || entry.key.key))
        : entry.access || entry.apiKey;
      pushCredential(out, seen, {
        apiKey,
        baseUrl: null,
        source: `auth.json:${id}`,
        expiresAt: finite(entry.expiry),
      });
    }
    if (out.length) break; // newest location wins; the cache copy is legacy
  }
  return out;
}

// opencode.json — the provider block users hand-write for the Go gateway, which
// is where a subscription key lives when nobody ran `opencode auth login`.
// The baseURL comes with it, so a key scoped to /zen/go/v1 is queried there
// rather than at our default.
function credentialsFromConfigJson(home, env) {
  const files = [
    env.OPENCODE_CONFIG_FILE,
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  ].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const file of files) {
    const parsed = /\.jsonc$/i.test(file) ? readJsonc(file) : (readJson(file) || readJsonc(file));
    const providers = parsed && typeof parsed === 'object' ? parsed.provider : null;
    if (!providers || typeof providers !== 'object') continue;
    for (const [id, entry] of Object.entries(providers)) {
      const options = entry && typeof entry === 'object' ? entry.options : null;
      if (!options || typeof options !== 'object') continue;
      const baseUrl = typeof options.baseURL === 'string' ? options.baseURL.trim() : '';
      // A declared base URL must point at the Zen gateway; with none declared the
      // provider id has to be Zen-named. Either way a DeepSeek/OpenRouter key
      // sitting in the same file is never picked up.
      if (baseUrl ? !ZEN_BASE_URL.test(baseUrl) : !ZEN_PROVIDER_ID.test(id)) continue;
      pushCredential(out, seen, {
        apiKey: options.apiKey,
        baseUrl: baseUrl || null,
        source: `opencode.json:${id}`,
        expiresAt: null,
      });
    }
    if (out.length) break;
  }
  return out;
}

/**
 * Every Zen credential we can find, most explicit first. Empty when OpenCode is
 * not configured with an official subscription — the caller then falls back to
 * the browser scrape.
 */
function discoverZenCredentials(options = {}) {
  const env = options.env || process.env;
  const home = options.home || homeDir(env);
  const found = [];
  const seen = new Set();

  const overrideKey = typeof env.OPENCODE_ZEN_API_KEY === 'string' ? env.OPENCODE_ZEN_API_KEY.trim() : '';
  if (overrideKey) {
    pushCredential(found, seen, {
      apiKey: overrideKey,
      baseUrl: typeof env.OPENCODE_ZEN_BASE_URL === 'string' && env.OPENCODE_ZEN_BASE_URL.trim()
        ? env.OPENCODE_ZEN_BASE_URL.trim()
        : null,
      source: 'env',
      expiresAt: null,
    });
  }
  for (const credential of credentialsFromAuthJson(home, env)) pushCredential(found, seen, credential);
  for (const credential of credentialsFromConfigJson(home, env)) pushCredential(found, seen, credential);
  return found;
}

// Where to ask for usage, given one credential. Its own base first (a Go key is
// only valid under /zen/go/v1), then the default base, because an auth.json
// OAuth credential carries no base URL at all.
function usageUrlsFor(credential) {
  const urls = [];
  const add = (base) => {
    if (typeof base !== 'string') return;
    const trimmed = base.replace(/\/+$/, '');
    if (!trimmed) return;
    const url = `${trimmed}${USAGE_PATH}`;
    if (!urls.includes(url)) urls.push(url);
  };
  add(credential && credential.baseUrl);
  add(DEFAULT_ZEN_BASE_URL);
  return urls;
}

/**
 * The gateway's `{percent, resetsAt}` windows as the bar renderer's
 * `{usagePercent, resetInSec}` windows. resetInSec is a duration relative to
 * `now` because that is what the renderer anchors to fetchedAt to build a
 * countdown; resetsAt is absolute, so the conversion happens here, once.
 */
function normalizeUsage(payload, nowMs) {
  const usage = payload && typeof payload === 'object' ? payload.usage : null;
  if (!usage || typeof usage !== 'object') return null;
  const windowOf = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const percent = finite(raw.percent);
    if (percent === null) return null;
    const resetsAt = typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : null;
    const resetInSec = Number.isFinite(resetsAt)
      ? Math.max(0, Math.round((resetsAt - nowMs) / 1000))
      : null;
    return {
      status: typeof raw.status === 'string' && raw.status ? raw.status : 'ok',
      usagePercent: percent,
      resetInSec,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    };
  };
  const rolling = windowOf(usage.rolling);
  const weekly = windowOf(usage.weekly);
  const monthly = windowOf(usage.monthly);
  if (!rolling && !weekly && !monthly) return null;
  return { rolling, weekly, monthly, useBalance: null };
}

/**
 * Subscription usage over the Zen API. null means no credential was found on
 * disk, which is the caller's cue to scrape the console in a browser instead. A
 * credential the gateway rejects is NOT null: it comes back as no_auth with the
 * per-endpoint diagnosis, so the caller can decide whether a browser session
 * would still be worth trying rather than guessing why nothing arrived.
 */
async function fetchZenGoUsage(options = {}) {
  const nowMs = finite(options.now) !== null ? Number(options.now) : Date.now();
  const fetchImpl = options.fetch || globalThis.fetch;
  const credentials = Array.isArray(options.credentials)
    ? options.credentials
    : discoverZenCredentials(options);
  if (!credentials.length) return null;

  const timeoutMs = finite(options.timeoutMs) !== null ? Number(options.timeoutMs) : TIMEOUT_MS;
  const rejections = [];
  for (const credential of credentials) {
    for (const url of usageUrlsFor(credential)) {
      let res;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: 'application/json' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
      } catch (err) {
        rejections.push(`${url}: ${(err && err.message) || 'request failed'}`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        rejections.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        rejections.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      let payload;
      try {
        payload = await res.json();
      } catch (_) {
        rejections.push(`${url}: non-JSON body`);
        continue;
      }
      const usage = normalizeUsage(payload, nowMs);
      if (!usage) {
        rejections.push(`${url}: no usage windows in response`);
        continue;
      }
      return {
        status: 'ok',
        source: `zen-api:${credential.source}`,
        url,
        fetchedAt: nowMs,
        usage,
      };
    }
  }
  return {
    status: 'no_auth',
    source: 'zen-api',
    error: `opencode Zen API key 被拒或未找到用量（${rejections.slice(0, 3).join('；') || '无候选端点'}）。请在 opencode.ai 控制台重新生成 Zen/Go key，或更新 ~/.config/opencode/opencode.json 里的 apiKey。`,
  };
}

module.exports = {
  DEFAULT_ZEN_BASE_URL,
  discoverZenCredentials,
  credentialsFromAuthJson,
  credentialsFromConfigJson,
  usageUrlsFor,
  normalizeUsage,
  fetchZenGoUsage,
};
