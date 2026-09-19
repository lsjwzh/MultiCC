'use strict';

// SakuraFrp / Nyat v4 API client + token binding + public-URL derivation.
//
// This is the control-plane companion to tunnel-sakurafrp-install.js (the
// data-plane frpc downloader). Together they enable a headless SakuraFrp setup:
// install frpc, bind the user's access token, then discover the tunnel so the
// monitor can enrich status and the base-URL picker can offer the public URL.
//
// TWO SECURITY / CORRECTNESS INVARIANTS drive this file:
//
//  1. TOKEN REDACTION. GET /user/info echoes the caller's access token back in
//     PLAINTEXT. getUserInfo() normalizes the response to an explicit allowlist
//     of fields so the token can never ride along into logs, the monitor, or the
//     UI. There is a dedicated test asserting the token substring never appears.
//
//  2. NO FABRICATED HTTPS URL. A tunnel with `auto_https` terminates TLS using a
//     certificate issued ONLY for the user's bound `*.nyat.app` subdomain. That
//     subdomain is applied for in the web dashboard and is NOT exposed by any v4
//     API endpoint (verified: /tunnels, /nodes and every /tunnel/* detail path).
//     The raw node host (e.g. frp-can.com) serves the SAME nyat.app cert, so
//     `https://<nodeHost>:<remote>` fails hostname verification. describeTunnelAccess()
//     therefore refuses to invent a public URL for auto_https tunnels and instead
//     reports `needsBoundDomain: true`; only non-TLS tunnels get a derived URL.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_BASE = 'https://api.natfrp.com/v4';

// macOS sandbox container path used by SakuraLauncher's natfrp-service. Mirrors
// the log path already relied on in tunnel-sakurafrp.js. Other platforms keep the
// launcher config elsewhere and are not auto-discovered yet (manual token paste).
const LAUNCHER_CONFIG_RELPATH = [
  'Library', 'Containers', 'com.natfrp.launcher', 'Data',
  'Library', 'Application Support', 'natfrp-service', 'config.json',
];

const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;

// Token binding source #1: auto-read the access token from an installed launcher,
// so a user who already runs SakuraLauncher needs zero copy-paste. Returns null
// (never throws) when absent/unreadable/malformed — callers fall back to manual.
function readLauncherToken({ home = os.homedir(), platform = process.platform, readFileSync = fs.readFileSync } = {}) {
  if (platform !== 'darwin') return null;
  const file = path.join(home, ...LAUNCHER_CONFIG_RELPATH);
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
  catch (_) { return null; }
  const token = typeof cfg.token === 'string' ? cfg.token.trim() : '';
  if (!TOKEN_RE.test(token)) return null;
  return {
    token,
    autoStartTunnels: Array.isArray(cfg.auto_start_tunnels) ? cfg.auto_start_tunnels.filter(id => id != null) : [],
    launcherVersion: typeof cfg.version === 'string' ? cfg.version : '',
    source: file,
  };
}

// Authenticated GET against the v4 API. HTTPS-only by construction (API_BASE),
// Bearer auth, non-2xx → throw. Injectable fetch for hermetic tests.
async function sakuraRequest(endpoint, { token, fetch = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('SakuraFrp API 需要访问密钥 (token)');
  }
  const url = API_BASE + (endpoint.startsWith('/') ? endpoint : '/' + endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'multicc' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) {
    throw new Error(`SakuraFrp ${endpoint} 响应 ${res ? res.status : '无响应'}`);
  }
  return res.json();
}

// Validate the token and return enrichment data — with the echoed token STRIPPED.
// Explicit field allowlist (not a passthrough) is the guarantee: even if the API
// adds new sensitive fields later, they won't leak.
async function getUserInfo({ token, fetch = globalThis.fetch } = {}) {
  const raw = await sakuraRequest('/user/info', { token, fetch });
  const src = raw && typeof raw === 'object' ? raw : {};
  const traffic = Array.isArray(src.traffic) ? src.traffic : [];
  const sign = src.sign && typeof src.sign === 'object' ? src.sign : {};
  const group = src.group && typeof src.group === 'object' ? src.group : {};
  return {
    id: Number.isInteger(src.id) ? src.id : null,
    name: typeof src.name === 'string' ? src.name : '',
    realname: src.realname ?? null,
    groupName: typeof group.name === 'string' ? group.name : '',
    tunnelCount: Number.isInteger(src.tunnels) ? src.tunnels : null,
    trafficUsed: Number.isInteger(traffic[0]) ? traffic[0] : null,
    trafficTotal: Number.isInteger(traffic[1]) ? traffic[1] : null,
    signed: !!sign.signed,
    signDays: Number.isInteger(sign.days) ? sign.days : null,
    // `token` is deliberately never copied out.
  };
}

async function listTunnels({ token, fetch = globalThis.fetch } = {}) {
  const raw = await sakuraRequest('/tunnels', { token, fetch });
  return Array.isArray(raw) ? raw : [];
}

async function listNodes({ token, fetch = globalThis.fetch } = {}) {
  const raw = await sakuraRequest('/nodes', { token, fetch });
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// Derive what we honestly can about a tunnel's public reachability. See the file
// header for why auto_https tunnels yield publicUrl:null + needsBoundDomain:true.
function describeTunnelAccess(tunnel, nodes) {
  if (!tunnel || typeof tunnel !== 'object') return null;
  const remote = tunnel.remote != null ? String(tunnel.remote) : '';
  const nodeId = tunnel.node != null ? String(tunnel.node) : '';
  const node = nodes && nodeId ? nodes[nodeId] : null;
  const nodeHost = node && typeof node.host === 'string' ? node.host : '';
  const extra = typeof tunnel.extra === 'string' ? tunnel.extra : '';
  const autoHttps = /auto_https/i.test(extra);
  const base = {
    tunnelId: tunnel.id ?? null,
    name: typeof tunnel.name === 'string' ? tunnel.name : '',
    type: typeof tunnel.type === 'string' ? tunnel.type : '',
    online: !!tunnel.online,
    remote,
    nodeId,
    nodeHost,
    nodeName: node && typeof node.name === 'string' ? node.name : '',
    autoHttps,
    authority: remote && nodeHost ? `${nodeHost}:${remote}` : null,
  };
  if (!remote || !nodeHost) {
    return { ...base, publicUrl: null, needsBoundDomain: false, reason: 'missing_remote_or_node_host' };
  }
  if (autoHttps) {
    return { ...base, publicUrl: null, needsBoundDomain: true, reason: 'auto_https_requires_bound_nyat_domain' };
  }
  return { ...base, publicUrl: `http://${nodeHost}:${remote}`, needsBoundDomain: false, reason: null };
}

// High-level discovery: token → pick a tunnel (explicit id, else first online,
// else first) → describe its access. `found:false` when the account has none.
async function discoverAccess({ token, fetch = globalThis.fetch, tunnelId } = {}) {
  const [tunnels, nodes] = await Promise.all([listTunnels({ token, fetch }), listNodes({ token, fetch })]);
  const pick = tunnelId != null
    ? tunnels.find(t => t && String(t.id) === String(tunnelId))
    : (tunnels.find(t => t && t.online) || tunnels[0]);
  if (!pick) return { found: false, tunnelCount: tunnels.length, access: null };
  return { found: true, tunnelCount: tunnels.length, access: describeTunnelAccess(pick, nodes) };
}

module.exports = {
  API_BASE,
  LAUNCHER_CONFIG_RELPATH,
  readLauncherToken,
  sakuraRequest,
  getUserInfo,
  listTunnels,
  listNodes,
  describeTunnelAccess,
  discoverAccess,
};
