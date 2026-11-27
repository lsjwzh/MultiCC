'use strict';

// 额度与计价簇（22 条公开路由）的 Node 宿主侧。
//
// 这 22 条路由已由 Rust 前门独占：路径与参数解码、`text(value, max)` 清洗、
// pricing 的 models 列表解析与三条 400、`?limit=` 的 parseInt 与封顶、
// `force` 的两种拼写、各厂商 status→HTTP 的状态码树、`{ ...result, bar }` 的
// 信封与键序、登录/安装的信封、额度条的 TTL/就绪/并发语义、条件请求与
// ETag/304、OPTIONS/HEAD —— 规则见 native/core/src/quota_routes.rs，
// HTTP 面见 native/gateway/src/app/quota_routes.rs。
//
// 这里只剩 Rust 看不见的进程内事实与副作用，统一走 `POST /api/__host/quota`：
//
//   pricing.*        models.dev 价格表的读取 / 一次 refresh / 模糊查询
//   *.quota          Chrome profile（CDP 驱动）、~/.codex/auth.json 与 OAuth
//                    刷新钩子、arkcli 子进程、aliyun 控制台抓取
//   *.login          managed profile 上的可见登录窗（会先停掉 headless 实例）
//   ark.login/install  arkcli 的定位、打开登录窗、`arkcli install` 安装
//   claude.quota/record  Claude 用量队列（60s 下限 + in-flight join）、
//                    5h live 窗（内存 Map）、recordClaude 记账
//   bars.state/fetch/commit  额度条的在进程缓存（quota-bar-cache 落盘）、
//                    各 kind 的抓取与 recordVendor 记账
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。

const { spawn } = require('node:child_process');

const HOST_PATH = '/api/__host/quota';

/** Marker meaning "this op has no dependency to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

// 生产依赖：全部懒加载，测试与差分脚本显式注入同名键覆盖。
function defaultDeps() {
  const { sharedPriceTable } = require('../pricing/price-table');
  const opencode = require('./opencode-quota');
  const qoder = require('./qoder-quota');
  const codex = require('./codex-quota');
  const ark = require('../native/binding').getArkQuotaHost();
  const kimi = require('./kimi-quota');
  const claude = require('./claude-usage-quota');
  const aliyun = require('./aliyun-quota');
  const { getManagedQuotaBrowser } = require('../quota-managed-browser');
  const queue = require('../quota/claude-usage-queue');
  const barState = require('../quota/claude-bar-state');
  return {
    priceTable: sharedPriceTable(),
    fetchOpenCodeUsage: opencode.fetchOpenCodeUsage,
    fetchQoderUsage: qoder.fetchQoderUsage,
    fetchCodexUsage: codex.fetchCodexUsage,
    fetchArkUsage: ark.fetchArkUsage,
    fetchKimiUsage: kimi.fetchKimiUsage,
    fetchAliyunUsage: aliyun.fetchAliyunUsage,
    loginUrl: {
      opencode: opencode.OPENCODE_AUTH_URL,
      qoder: qoder.LOGIN_PAGE_URL,
      kimi: kimi.KIMI_SUBSCRIPTION_URL,
      claude: claude.CLAUDE_USAGE_URL,
      aliyun: aliyun.ALIYUN_CONSOLE_URL,
    },
    openLogin: url => getManagedQuotaBrowser().openVisibleLogin(url),
    resolveAccountAuthFile: null,
    resolveArkcliBin: ark.resolveArkcliBin,
    installArkcli: ark.installArkcli,
    spawn,
    loadSavedCookies: qoder.loadSavedCookies,
    rememberKimiBalance: kimi.rememberKimiBalance,
    lastKimiBalance: kimi.lastKimiBalance,
    claudeUsageKey: queue.claudeUsageKey,
    readClaudeUsage: queue.readClaudeUsage,
    enqueueClaudeUsage: queue.enqueueClaudeUsage,
    readClaudeLive: barState.readClaudeLive,
    codexFetch: undefined,
    arkUsageDeps: {},
    kimiUsageDeps: {},
    aliyunUsageDeps: {},
    recordVendor: null,
    recordClaude: null,
    quotaBarCache: null,
    now: () => Date.now(),
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function createQuotaRuntime(rawDeps) {
  const deps = rawDeps || {};
  const cache = deps.quotaBarCache || null;
  const recordVendor = typeof deps.recordVendor === 'function' ? deps.recordVendor : null;
  const recordClaude = typeof deps.recordClaude === 'function' ? deps.recordClaude : null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  // 记账失败永远不影响响应（原实现的 try/catch {}）。
  async function record(payload) {
    if (!recordVendor) return;
    try { await recordVendor(payload); } catch (_) { /* 原实现同样吞掉 */ }
  }

  async function openLogin(kind) {
    await deps.openLogin(deps.loginUrl[kind]);
    return {};
  }

  // 每个 op 的返回值就是 Rust 侧重建信封所需的全部事实；抓取抛错一律折成
  // { threw: true }（各路由的兜底文案与状态码在前门），只有登录窗的失败
  // 通过 mount 的 refusal 带 code/message 出去，因为原实现直接用了它们。
  async function invoke(body) {
    switch (body.op) {
      case 'pricing.status':
        return { status: deps.priceTable.status() };
      case 'pricing.lookup':
        return {
          prices: deps.priceTable.lookupMany(body.models || []),
          status: deps.priceTable.status(),
        };
      case 'pricing.refresh':
        return { status: await deps.priceTable.refresh({ force: body.force === true }) };
      case 'pricing.search': {
        const query = typeof body.query === 'string' ? body.query : '';
        const results = query ? deps.priceTable.search(query, { limit: body.limit }) : [];
        return { results, status: deps.priceTable.status() };
      }

      case 'opencode.quota':
        try { return { result: await deps.fetchOpenCodeUsage() }; } catch (_) { return { threw: true }; }
      case 'qoder.quota':
        try { return { result: await deps.fetchQoderUsage() }; } catch (_) { return { threw: true }; }
      case 'qoder.cookies': {
        const saved = deps.loadSavedCookies();
        return { saved: saved === undefined ? null : saved };
      }
      case 'codex.quota': {
        try {
          const account = typeof body.account === 'string' ? body.account : '';
          let authFile = null;
          if (account) {
            if (typeof deps.resolveAccountAuthFile !== 'function') return { mode: 'disabled' };
            authFile = deps.resolveAccountAuthFile(account);
            if (!authFile) return { mode: 'missing' };
          }
          const result = await deps.fetchCodexUsage(undefined, {
            ...(authFile ? { authFile } : {}),
            ...(typeof deps.codexFetch === 'function' ? { fetch: deps.codexFetch } : {}),
          });
          return { result };
        } catch (_) { return { threw: true }; }
      }
      case 'ark.quota': {
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
        try {
          const result = await deps.fetchArkUsage();
          await record({ kind: 'ark', result, baseUrl });
          return { result };
        } catch (_) {
          // 兜底分支记账用的是**原始** query 值（不是上面清洗过的那个）。
          const raw = body.rawBaseUrl === undefined ? '' : body.rawBaseUrl;
          await record({
            kind: 'ark',
            result: { status: 'unavailable', error: 'ark quota fetch failed' },
            baseUrl: raw || '',
          });
          return { threw: true };
        }
      }
      case 'kimi.quota': {
        const host = typeof body.host === 'string' ? body.host : '';
        try {
          const result = await deps.fetchKimiUsage(host, now(), deps.kimiUsageDeps || {});
          const cached = deps.rememberKimiBalance(result);
          await record({ kind: 'kimi', result, host, opts: { cached } });
          return { result, cached };
        } catch (_) {
          const raw = body.rawHost === undefined ? '' : body.rawHost;
          await record({
            kind: 'kimi',
            result: { status: 'unavailable', error: 'kimi quota fetch failed' },
            host: raw || '',
          });
          return { threw: true, cached: deps.lastKimiBalance() };
        }
      }
      case 'claude.quota': {
        const session = typeof body.session === 'string' ? body.session : '';
        let entry = null;
        let failed = false;
        try {
          const key = deps.claudeUsageKey(session);
          entry = body.force === true ? await deps.enqueueClaudeUsage(key) : deps.readClaudeUsage(key);
        } catch (_) { failed = true; }
        // renderClaudeBar 自己会**重读**一次队列（enqueue 刚写入的条目就在那里），
        // 并且只读一次 Date.now()。这里把三样东西一起交给前门，让它在同一时刻渲染。
        let usage;
        let live = null;
        const at = now();
        try {
          const key = deps.claudeUsageKey(session);
          const current = deps.readClaudeUsage(key);
          if (current && current.result !== undefined) usage = current.result;
          live = deps.readClaudeLive(session, at);
        } catch (_) { failed = true; }
        return {
          threw: failed,
          entry: entry || null,
          result: entry ? entry.result : null,
          usage,
          live: live === undefined ? null : live,
          nowMs: at,
        };
      }
      case 'claude.record':
        if (recordClaude) {
          try { await recordClaude(body.session, body.result, body.text); } catch (_) { /* 原实现吞掉 */ }
        }
        return {};
      case 'aliyun.quota':
        try {
          return { result: await deps.fetchAliyunUsage(now(), deps.aliyunUsageDeps || {}) };
        } catch (_) { return { threw: true }; }

      case 'opencode.login':
        return openLogin('opencode');
      case 'qoder.login':
        return openLogin('qoder');
      case 'kimi.login':
        return openLogin('kimi');
      case 'claude.login':
        return openLogin('claude');
      case 'aliyun.login':
        return openLogin('aliyun');
      case 'ark.login': {
        const bin = deps.resolveArkcliBin();
        if (!bin) return { mode: 'needs_install' };
        try {
          const child = deps.spawn(bin.cmd, [...bin.prefix, 'auth', 'login', 'volc-sso'], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
          return { status: 'started', pid: child.pid || null };
        } catch (error) {
          return { threw: true, message: error && error.message !== undefined ? error.message : null };
        }
      }
      case 'ark.install':
        try {
          const result = await deps.installArkcli();
          if (result.ok) return { ok: true };
          return result.error === undefined ? { ok: false } : { ok: false, error: result.error };
        } catch (error) {
          return { threw: true, message: error && error.message !== undefined ? error.message : null };
        }

      case 'bars.state': {
        const selector = asObject(body.selector);
        return {
          snapshot: cache
            ? cache.snapshotFor(selector)
            : { status: 'ok', bars: {}, updatedAt: 0 },
        };
      }
      case 'bars.fetch': {
        const kind = body.kind;
        try {
          if (kind === 'ark') {
            const result = await deps.fetchArkUsage();
            await record({ kind: 'ark', result, baseUrl: body.baseUrl || '' });
            return { result };
          }
          if (kind === 'kimi') {
            const result = await deps.fetchKimiUsage(body.host || '');
            await record({ kind: 'kimi', result, host: body.host || '' });
            return { result };
          }
          if (kind === 'opencode') return { result: await deps.fetchOpenCodeUsage() };
          if (kind === 'qoder') return { result: await deps.fetchQoderUsage() };
          if (kind === 'codex') return { result: await deps.fetchCodexUsage() };
        } catch (_) { return { threw: true }; }
        return UNKNOWN;
      }
      case 'bars.commit': {
        const selector = asObject(body.selector);
        if (body.record === true && cache) {
          cache.record(body.kind, body.result, body.bar, selector);
        }
        return { cached: cache ? cache.get(body.kind, selector) : null };
      }

      default:
        return UNKNOWN;
    }
  }

  async function handle(body) {
    return invoke(asObject(body));
  }

  function mount(app) {
    const logger = deps.logger || console;
    app.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      const isLocal = typeof deps.isLocal === 'function' ? deps.isLocal : require('../native/binding').requestLocality.isLocalRequest;
      if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
      const body = asObject(req.body);
      return Promise.resolve()
        .then(() => invoke(body))
        .then(
          (value) => {
            if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
            return res.json({ ok: true, value: value === undefined ? null : value });
          },
          (error) => {
            // refusal：原实现的 catch 直接读 err.code / err.message 拼信封。
            const out = {};
            const code = error && error.code;
            const status = error && error.status;
            if (code !== undefined) out.code = String(code);
            if (status !== undefined) out.status = Number(status);
            if (error && error.message !== undefined) out.message = String(error.message);
            return res.json({ ok: false, error: out });
          },
        )
        .catch((error) => {
          // 500 会被前门翻译成 rust_backend_unavailable（见 docs/gateway.md §9）。
          logger?.error?.('[quota-host] operation failed', body.op, error);
          return res.status(500).json({ error: 'host operation failed' });
        });
    });
  }

  return { handle, mount };
}

function mountQuotaHostRoute(app, options = {}) {
  const base = defaultDeps();
  const deps = {
    ...base,
    ...options,
    loginUrl: { ...base.loginUrl, ...(options.loginUrl || {}) },
  };
  createQuotaRuntime(deps).mount(app);
}

module.exports = {
  HOST_PATH,
  defaultDeps,
  createQuotaRuntime,
  mountQuotaHostRoute,
};
