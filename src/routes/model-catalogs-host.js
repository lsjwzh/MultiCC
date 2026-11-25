'use strict';

// 宿主端口（host port）：模型目录的 8 条公开路由已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/model_catalogs.rs）独占。路径匹配、
// 查询串解析、参数解码、状态码、响应字段与顺序、Cache-Control 和错误映射都在
// Rust；这里只剩 Node 独有的事实与副作用：
//
//   opencode|qoder|grok|commandcode|codebuddy  子进程枚举 CLI 目录 + 进程内缓存
//   provider                                     provider store 的 baseUrl/token + 3s 上游抓取
//   codex-state / codex-refresh                  官方账号目录运行时（provider store、
//                                                出口绑定、原生 codexModelsPeek/Refresh、
//                                                pending 单飞表）
//
// 每个 CLI 的查询路由和自动选线共用该 CLI 的 Rust 解析器和缓存。
//
// 这不是公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest` 拒绝任何
// 转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const { execFile } = require('node:child_process');
const { resolveCliCommands } = require('../cli-adapters/commands');
const { getNative } = require('../native/runtime');

const HOST_PATH = '/api/__host/model-catalogs';

// Node owns process lookup, execFile and callback scheduling. The native
// catalog owns parsing, freshness, fallback rows and publication of CLI reads.
const VENDOR_PORTS = {
  qoder: { bin: 'qoderclicn', arg: '--list-models', timeout: 15000, buffer: 256 * 1024,
    parse: 'parseQoderStdout', suffix: 'QoderModels', fallback: 'QODER_TIER_FALLBACK' },
  codebuddy: { bin: 'codebuddy', arg: '--help', timeout: 10000, buffer: 1024 * 1024,
    parse: 'parseCodebuddyHelp', suffix: 'CodebuddyModels', fallback: 'CODEBUDDY_MODEL_FALLBACK' },
  grok: { bin: 'grok', arg: 'models', timeout: 10000, buffer: 1024 * 1024,
    parse: 'parseGrokModels', suffix: 'GrokModels', fallback: 'GROK_MODEL_FALLBACK' },
  commandcode: { bin: 'commandcode', arg: '--list-models', timeout: 20000, buffer: 2 * 1024 * 1024,
    parse: 'parseCommandcodeList', suffix: 'CommandcodeModels', fallback: 'COMMANDCODE_MODEL_FALLBACK' },
};
const vendorCatalogs = new Map();
function getVendorCatalog(cli) {
  if (vendorCatalogs.has(cli)) return vendorCatalogs.get(cli);
  const spec = VENDOR_PORTS[cli];
  const timeout = Number(process.env[cli.toUpperCase() + '_MODELS_TIMEOUT_MS'] || spec.timeout);
  const native = new (getNative().RustVendorModelCatalog)(cli);
  const state = { cache: null, fallback: native.defaults() };
  let published = Promise.resolve();
  const api = {
    [spec.parse](input) { return native.parse(input); },
    ['peek' + spec.suffix]() { return native.peek(state); },
    ['list' + spec.suffix](callback, opts = {}) {
      if (!opts.refresh && native.isFresh(state)) {
        return setImmediate(() => callback(null, state.cache.models, 'cache'));
      }
      let bin = spec.bin;
      try {
        const cmd = resolveCliCommands()[cli];
        if (typeof cmd === 'string' && cmd) bin = cmd;
      } catch {}
      const options = { timeout, maxBuffer: spec.buffer };
      if (cli === 'qoder') options.windowsHide = true;
      execFile(bin, [spec.arg], options, (error, stdout) => {
        // Preserve child completion order while the worker pool parses stdout.
        const result = published.then(async () => {
          const listing = error ? null : await native.readListing(stdout);
          return native.finish(state, listing);
        });
        published = result.then(() => {}, () => {});
        result.then(({ models, source }) => process.nextTick(callback, null, models, source),
          error => process.nextTick(callback, error));
      });
    },
    [spec.fallback]: state.fallback,
    _setCacheForTest(at, models) { state.cache = { at, models }; },
    _resetCacheForTest() { state.cache = null; },
  };
  vendorCatalogs.set(cli, api);
  return api;
}

// 每一条 CLI 目录路由的 503 文案（退役的 mount* 里的字面量）。
const CLI_OPERATIONS = Object.freeze({
  opencode: {
    unavailable: 'opencode models unavailable',
    list: (options, callback) => require('./opencode-models').listOpenCodeModels(callback, options),
  },
  qoder: {
    unavailable: 'qoder models unavailable',
    list: (options, callback) => getVendorCatalog('qoder').listQoderModels(callback, options),
  },
  grok: {
    unavailable: 'grok models unavailable',
    list: (options, callback) => getVendorCatalog('grok').listGrokModels(callback, options),
  },
  commandcode: {
    unavailable: 'commandcode models unavailable',
    list: (options, callback) => getVendorCatalog('commandcode').listCommandcodeModels(callback, options),
  },
  codebuddy: {
    unavailable: 'codebuddy models unavailable',
    list: (options, callback) => getVendorCatalog('codebuddy').listCodebuddyModels(callback, options),
  },
});

function cliCatalog(op, refresh) {
  return new Promise(resolve => {
    const operation = CLI_OPERATIONS[op];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      operation.list({ refresh }, (err, models, source) => {
        if (err) return finish({ ok: false, error: operation.unavailable });
        return finish({ ok: true, models: Array.isArray(models) ? models : [], source: String(source || '') });
      });
    } catch (_) {
      finish({ ok: false, error: operation.unavailable });
    }
  });
}

function createModelCatalogsHost(options = {}) {
  const providerRuntime = () => (typeof options.providerRuntime === 'function'
    ? options.providerRuntime()
    : options.providerRuntime) || require('./provider-models').getSharedProviderModelsRuntime();
  const codexRuntime = () => (typeof options.codexRuntime === 'function'
    ? options.codexRuntime()
    : options.codexRuntime) || require('../codex/model-catalog').defaultRuntime;

  // 退役的 accountResponse() 前两段：线路是否存在、是否 Codex、是否官方 OAuth。
  function codexState(providerId) {
    let provider;
    try {
      provider = codexRuntime().resolveProvider(providerId);
    } catch (_) {
      return { error: true };
    }
    if (!provider) return { found: false };
    let official = false;
    try {
      const { isOfficialCodexOAuthProvider } = require('../codex/official-relay');
      official = isOfficialCodexOAuthProvider(provider);
    } catch (_) {
      official = false;
    }
    const state = { found: true, id: provider.id, appType: provider.appType, official };
    if (!official) return state;
    // peekProvider / isRefreshing 自己吞掉异常（退役路由里也是直接调用）。
    try { state.peek = codexRuntime().peekProvider(provider); } catch (_) { state.peek = null; }
    try { state.refreshing = codexRuntime().isRefreshing(provider) === true; } catch (_) { state.refreshing = false; }
    return state;
  }

  async function codexRefresh(providerId, wait, refresh) {
    try {
      const pending = codexRuntime().refreshProvider(providerId, { refresh });
      if (wait) await pending;
      else pending.catch(() => {});
    } catch (_) {
      return { error: true };
    }
    return { ok: true };
  }

  return async function handle(body) {
    const op = body && typeof body.op === 'string' ? body.op : '';
    if (Object.prototype.hasOwnProperty.call(CLI_OPERATIONS, op)) {
      return cliCatalog(op, body.refresh === true);
    }
    if (op === 'provider') {
      const result = await providerRuntime().listProviderModels(body.providerId, {
        refresh: body.refresh === true,
      });
      return { status: result.status, body: result.body };
    }
    if (op === 'codex-state') {
      const providerId = typeof body.providerId === 'string' ? body.providerId : 'codex-official';
      return codexState(providerId);
    }
    if (op === 'codex-refresh') {
      const providerId = typeof body.providerId === 'string' ? body.providerId : 'codex-official';
      return codexRefresh(providerId, body.wait === true, body.refresh === true);
    }
    return { error: true };
  };
}

function mountModelCatalogsHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[model-catalogs-host] Express-compatible app is required');
  }
  const isLocal = options.isLocal || isLocalRequest;
  const handle = createModelCatalogsHost(options);
  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    Promise.resolve(handle(body)).then(
      value => res.json(value),
      () => res.status(500).json({ error: 'host operation failed' }),
    );
  });
}

module.exports = { getVendorCatalog, mountModelCatalogsHostRoute, createModelCatalogsHost, HOST_PATH };
