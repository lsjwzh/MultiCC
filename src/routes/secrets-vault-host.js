'use strict';

// 宿主端口（host port）：五条 `/api/secrets*` 公开路由已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/secrets_vault.rs）独占。路径匹配、
// 请求校验与响应序列化都在 Rust；这里只剩 Node 独有的保险箱事实与副作用：
// 进程内 entries 表、0600 store 的读写、secret audit、env overlay/digest。
//
// 所有 op 都走 src/secrets-vault.js 的既有 audited 导出，审计记录（operation、
// names 与 source 'http'）保持不变。本文件不持有任何值时也不把它写进日志：
// 只有 reveal 的响应会带上明文。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/secrets-vault';

// 与 src/secrets-vault.js 的私有 meta() 逐字段、逐键序一致。值是唯一被剔除的字段。
function metaOf(entry) {
  return {
    name: entry.name,
    description: entry.description || '',
    source: entry.source || 'user',
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
  };
}

function createSecretsVaultHost(vault) {
  if (!vault || typeof vault !== 'object') {
    throw new TypeError('[secrets-vault-host] vault is required');
  }

  const operations = Object.freeze({
    list: () => ({ ok: true, entries: vault.list({ source: 'http' }) }),
    upsert: body => {
      const input = { name: body.name, value: body.value, source: body.source };
      // 只在请求真的带了该键时才透传：upsert 用 `typeof description === 'string'`
      // 判断「保留旧描述」，显式 undefined 会破坏这条规则。
      if (Object.prototype.hasOwnProperty.call(body, 'description')) input.description = body.description;
      if (Object.prototype.hasOwnProperty.call(body, 'sessionId')) input.sessionId = body.sessionId;
      const result = vault.upsert(input, { source: 'http', sessionId: body.sessionId });
      if (result && result.error) {
        return { ok: false, reason: result.error === 'vault is full' ? 'full' : 'error' };
      }
      return { ok: true, entry: metaOf(result.entry), created: !!result.created };
    },
    rename: body => {
      const result = vault.rename(body.name, body.to, { source: 'http' });
      if (result && result.error) {
        return {
          ok: false,
          reason: result.error === 'entry not found' ? 'missing'
            : result.error === 'target name already exists' ? 'exists' : 'error',
        };
      }
      return { ok: true, entry: metaOf(result.entry) };
    },
    remove: body => {
      const result = vault.remove(body.name, { source: 'http' });
      if (result && result.error) {
        return { ok: false, reason: result.error === 'entry not found' ? 'missing' : 'error' };
      }
      return { ok: true };
    },
    reveal: body => {
      // The Claude/Codex routing test reads a key to prove it works; the audit
      // trail should name that feature rather than a generic HTTP read. Any
      // other value keeps the original source.
      const source = body.source === 'routing_test' ? 'routing_test' : 'http';
      const result = vault.reveal(body.name, { source });
      if (result && result.error) {
        return { ok: false, reason: result.error === 'entry not found' ? 'missing' : 'error' };
      }
      return { ok: true, name: result.entry.name, value: result.entry.value };
    },
  });

  return function handle(body) {
    const op = body && typeof body.op === 'string' ? body.op : '';
    if (!Object.prototype.hasOwnProperty.call(operations, op)) return { ok: false };
    return operations[op](body);
  };
}

function mountSecretsVaultHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[secrets-vault-host] Express-compatible app is required');
  }
  if (!options.vault) throw new TypeError('[secrets-vault-host] vault is required');
  const isLocal = options.isLocal || isLocalRequest;
  const handle = createSecretsVaultHost(options.vault);
  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    try {
      res.json(handle(body));
    } catch (_) {
      res.status(500).json({ error: 'host operation failed' });
    }
  });
}

module.exports = { mountSecretsVaultHostRoute, createSecretsVaultHost, metaOf, HOST_PATH };
