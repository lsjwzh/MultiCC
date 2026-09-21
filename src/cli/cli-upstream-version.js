'use strict';

// ── What the vendor publishes right now ──
//
// `/api/cli/versions` answers "what is installed". This module answers the
// other half of "is there an update?": what is published upstream. The npm
// registry is the only uniform machine-readable source for that, and it is the
// right one — the install command in OFFICIAL_INSTALL_SPECS is literally
// `npm install -g <pkg>` for every entry in the map below.
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

const https = require('node:https');

const NPM_PACKAGES = Object.freeze({
  claude: '@anthropic-ai/claude-code',
  'claude-exp': '@anthropic-ai/claude-agent-sdk',
  codex: '@openai/codex',
  'codex-exp': '@openai/codex',
  opencode: 'opencode-ai',
  kimi: '@moonshot-ai/kimi-code',
  codebuddy: '@tencent-ai/codebuddy-code',
  dsh: '@deepseek-ai/dsh',
});

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
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

// 国内镜像用户把 npm_config_registry 指到 npmmirror 时，最新版必须从同一个源读，
// 否则会拿官方源的最新版去比镜像里装的旧版，报出用户装不到的「可更新」。
function resolveRegistryBase(env = process.env) {
  const raw = (env && (env.npm_config_registry || env.NPM_CONFIG_REGISTRY)) || DEFAULT_REGISTRY;
  const text = String(raw).trim();
  if (!/^https?:\/\//i.test(text)) return DEFAULT_REGISTRY;
  return text.endsWith('/') ? text : `${text}/`;
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

async function fetchLatestVersion(pkg, options = {}) {
  const {
    registryBase,
    timeoutMs = FETCH_TIMEOUT_MS,
    env = process.env,
    httpsImpl = https,
  } = options;
  if (!pkg) return null;
  const url = latestUrl(pkg, registryBase || resolveRegistryBase(env));

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

// 任一为空就不下结论 —— 「不知道最新版」必须与「已是最新」区分开。
function classifyUpdate(installed, latest) {
  const current = parseSemver(installed) ? String(installed).replace(/^v/, '') : null;
  const published = parseSemver(latest) ? String(latest).replace(/^v/, '') : null;
  return {
    latest: published,
    updateAvailable: Boolean(current && published && compareSemver(current, published) < 0),
  };
}

// 供 runtime 使用：只对「有 npm 源」的 CLI 取最新版，其余直接 null。
function npmPackageFor(cli) {
  return NPM_PACKAGES[String(cli || '').trim().toLowerCase()] || null;
}

module.exports = {
  NPM_PACKAGES,
  DEFAULT_REGISTRY,
  FETCH_TIMEOUT_MS,
  parseSemver,
  compareSemver,
  resolveRegistryBase,
  latestUrl,
  fetchLatestVersion,
  classifyUpdate,
  npmPackageFor,
};
