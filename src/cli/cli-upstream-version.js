'use strict';

// ── What the vendor publishes right now ──
//
// `/api/cli/versions` answers "what is installed". This module answers the
// other half of "is there an update?": what is published upstream. The npm
// registry is the only uniform machine-readable source for that, and it is the
// right one for every CLI it can answer for — the vast majority of the install
// commands in `cli-capability.js`'s family `update` column are literally
// `npm install -g <pkg>`.
//
// The package map is **derived from that same column**, not written out here: a
// package name is part of "how do you upgrade this CLI", so a second copy would
// be the one that goes stale when a CLI is added. It is keyed by **family**,
// which is the unit an upgrade acts on (see the `update` column's comment) —
// so a lane id (`claude-exp`, `codex-exp`) has no package of its own, on
// purpose: neither is a thing a user installs.
//
// qoder (`curl https://qoder.cn/install | bash`) and zcode (manual desktop
// install) have no npm package and therefore no comparable source. They are
// deliberately absent rather than guessed at: the caller reports latest:null
// for them, and the UI says "can't check" instead of inventing a number.
// qoder's own `update --check` was measured on this host and returns
// "Unable to determine installation method" on a channel install, so it is not
// a fallback.
//
// Every export here is best-effort. A missing registry, a captcha, a redirect
// loop or a DNS failure resolves to null — never a throw, never a rejection —
// so one unreachable registry cannot blank the panel or fail a request.

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const { npmPackages } = require('./cli-capability');

const NPM_PACKAGES = Object.freeze(npmPackages());

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
// 兜底源：只在「主源读不出结果」时才用。
// 为什么必须有它：registry.npmjs.org 在部分网络环境是整段不可达（本机实测 5s 无响应、
// http=000，而 registry.npmmirror.com 0.12s 返回 200）。没有兜底时 latest 恒为 null，
// 「有没有新版」这一整个功能都是死的 —— 面板只剩「无法检测最新版」。
// 关键约束：读哪个源报「可升级」，就在哪个源上装（见 resolveRegistryCandidates 与
// switch-runtime 的 buildInstallEnv），否则会出现「报得出新版、却装不到」的假升级。
// MULTICC_CLI_REGISTRY_FALLBACKS='' 可整体关掉（或换成自建镜像，逗号分隔）。
const FALLBACK_REGISTRIES = Object.freeze(['https://registry.npmmirror.com/']);
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// 版本号拆成 [major, minor, patch]，附带是否带预发布后缀。非版本号一律 null，
// 让调用方把「解析不了」和「确实没有版本」分开处理。
function parseSemver(value) {
  const text = String(value == null ? '' : value).trim().replace(/^v/, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:([-+][0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: Boolean(match[4]),
  };
}

// 语义化比较：数字段优先；数字段相同时，只有「本地是预发布、上游不是」才算落后
// （1.2.3-beta → 1.2.3 是升级）。反向永不成立 —— 不能因为上游发了 beta 就把稳定版
// 报成「可升级」。
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  }
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease ? -1 : 1;
}

function normalizeRegistry(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^https?:\/\//i.test(text)) return null;
  return text.endsWith('/') ? text : `${text}/`;
}

// `registry=...` 是 npm 自己的用户级配置。npm_config_registry 只在 npm 启动的
// 子进程里才有，服务常驻进程的 env 里通常没有 —— 只看 env 会把「用 .npmrc 配了镜像」
// 的用户当成官方源用户，于是既报不出最新版，也装不上。所以这里按 npm 的顺序读一次
// 用户 .npmrc（可用 NPM_CONFIG_USERCONFIG 指定，测试里用 npmrcPath 注入）。
function readNpmrcRegistry(env = process.env, options = {}) {
  const explicit = options.npmrcPath
    || (env && (env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig))
    || path.join(options.homeDir || os.homedir(), '.npmrc');
  let text;
  try {
    text = fs.readFileSync(explicit, 'utf8');
  } catch (_) {
    return null;
  }
  for (const line of String(text).split('\n')) {
    const match = line.match(/^\s*registry\s*=\s*(.+?)\s*$/i);
    if (match) {
      const normalized = normalizeRegistry(match[1].replace(/^["']|["']$/g, ''));
      if (normalized) return normalized;
    }
  }
  return null;
}

// 国内镜像用户把 npm_config_registry 指到 npmmirror 时，最新版必须从同一个源读，
// 否则会拿官方源的最新版去比镜像里装的旧版，报出用户装不到的「可更新」。
function resolveRegistryBase(env = process.env, options = {}) {
  const fromEnv = normalizeRegistry(env && (env.npm_config_registry || env.NPM_CONFIG_REGISTRY));
  if (fromEnv) return fromEnv;
  return readNpmrcRegistry(env, options) || DEFAULT_REGISTRY;
}

// 主源 + 兜底源，按顺序尝试。第一个给出答案的源就是「报出这个新版」的源，调用方
// 要把它交给 npm 去装。
function resolveRegistryCandidates(env = process.env, options = {}) {
  const raw = env && env.MULTICC_CLI_REGISTRY_FALLBACKS;
  const fallbacks = raw == null
    ? FALLBACK_REGISTRIES
    : String(raw).split(',').map(entry => entry.trim()).filter(Boolean);
  const out = [resolveRegistryBase(env, options)];
  for (const candidate of fallbacks) {
    const normalized = normalizeRegistry(candidate);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

// scoped 包名里的 `/` 是包名的一部分，只有 @ 需要转义。
function latestUrl(pkg, registryBase) {
  return `${registryBase}${String(pkg).replace('/', '%2f')}/latest`;
}

function readJsonBody(response, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let body = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) { finish(null); response.destroy(); }
    });
    response.on('end', () => finish(body));
    response.on('error', () => finish(null));
  });
}

async function fetchLatestFrom(pkg, registryBase, options = {}) {
  const {
    timeoutMs = FETCH_TIMEOUT_MS,
    httpsImpl = https,
  } = options;
  if (!pkg || !registryBase) return null;
  const url = latestUrl(pkg, registryBase);

  const request = (target, redirectsLeft) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = httpsImpl.get(target, {
        headers: { 'User-Agent': 'multicc-cli-version-check/1.0', Accept: 'application/json' },
        timeout: timeoutMs,
      });
    } catch (_) {
      finish(null);
      return;
    }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(null); });
    req.on('error', () => finish(null));
    req.on('response', async (response) => {
      const status = Number(response.statusCode) || 0;
      const redirect = status >= 300 && status < 400 ? response.headers.location : null;
      if (redirect) {
        try { response.resume(); } catch (_) {}
        if (redirectsLeft <= 0) { finish(null); return; }
        finish(await request(new URL(redirect, target).toString(), redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        try { response.resume(); } catch (_) {}
        finish(null);
        return;
      }
      const body = await readJsonBody(response);
      if (!body) { finish(null); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) { finish(null); return; }
      const version = parsed && typeof parsed.version === 'string' ? parsed.version.trim() : '';
      finish(SEMVER.test(version.replace(/^v/, '')) ? version.replace(/^v/, '') : null);
    });
  });

  try {
    return await request(url, MAX_REDIRECTS);
  } catch (_) {
    return null;
  }
}

// 显式给 registryBase 时只问那一个源（调用方已经知道要用谁）；没给就按
// 主源 → 兜底源的顺序试，并如实回报是哪个源答的。version 为 null 时 registry
// 也是 null —— 「没答上来」不能伪装成「这个源说没有新版」。
async function fetchLatestVersionWithSource(pkg, options = {}) {
  const { registryBase, env = process.env, ...rest } = options;
  if (!pkg) return { version: null, registry: null };
  const bases = registryBase ? [registryBase] : resolveRegistryCandidates(env);
  for (const base of bases) {
    const version = await fetchLatestFrom(pkg, base, rest);
    if (version) return { version, registry: base };
  }
  return { version: null, registry: null };
}

async function fetchLatestVersion(pkg, options = {}) {
  return (await fetchLatestVersionWithSource(pkg, options)).version;
}

// 任一为空就不下结论 —— 「不知道最新版」必须与「已是最新」区分开。
function classifyUpdate(installed, latest) {
  const current = parseSemver(installed) ? String(installed).replace(/^v/, '') : null;
  const published = parseSemver(latest) ? String(latest).replace(/^v/, '') : null;
  return {
    latest: published,
    updateAvailable: Boolean(current && published && compareSemver(current, published) < 0),
  };
}

// 供 runtime 使用：只对「有 npm 源」的 CLI 取最新版，其余直接 null。键是家族。
function npmPackageFor(cli) {
  return NPM_PACKAGES[String(cli || '').trim().toLowerCase()] || null;
}

module.exports = {
  NPM_PACKAGES,
  DEFAULT_REGISTRY,
  FETCH_TIMEOUT_MS,
  parseSemver,
  compareSemver,
  FALLBACK_REGISTRIES,
  normalizeRegistry,
  resolveRegistryBase,
  resolveRegistryCandidates,
  readNpmrcRegistry,
  latestUrl,
  fetchLatestVersion,
  fetchLatestVersionWithSource,
  classifyUpdate,
  npmPackageFor,
};
