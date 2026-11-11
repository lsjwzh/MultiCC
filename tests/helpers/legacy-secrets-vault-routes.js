'use strict';
// 冻结的 Node 原始实现（五条 /api/secrets* 路由退役时的逐字副本），只给
// docs/rust-migration/differential/secrets-vault.js 当对照 oracle。
// 不参与生产路径，除差异测试外不要 require。
//
// 迁移后 live 模块 src/secrets-vault.js 只剩进程内保险箱、0600 store、secret
// audit 与 env overlay；路径匹配、请求校验、状态码与响应序列化由 Rust 前门
// (native/gateway/src/app/secrets_vault.rs) 独占。所以这里复制的是「退役时的
// mount(app) 函数体 + 私有 meta()」，只把 `module.exports.` 改为直接引用当前
// live 模块的 audited 导出（list/upsert/rename/remove/reveal）。
//
// Oracle-only frozen copy of the retired `/api/secrets*` handlers and the private
// `meta()` projection. It is wired to the real, current `src/secrets-vault.js`
// audited exports; it must never be used by production code. The only edit to
// the copied source is `module.exports.` -> `vault.` so the handlers reach the
// live store.

const vault = require('../../src/secrets-vault');

// Metadata-only projection — the only shape agents and list endpoints ever see.
function meta(entry) {
  return {
    name: entry.name,
    description: entry.description || '',
    source: entry.source || 'user',
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
  };
}

function mount(app) {
  app.get('/api/secrets', (req, res) => {
    res.json(vault.list({ source: 'http' }));
  });
  app.post('/api/secrets', (req, res) => {
    const body = req.body || {};
    const result = vault.upsert({
      name: body.name,
      value: body.value,
      description: body.description,
      source: body.source === 'agent' ? 'agent' : 'user',
      sessionId: body.sessionId,
    }, { source: 'http', sessionId: body.sessionId });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.status(result.created ? 201 : 200).json({ ok: true, entry: meta(result.entry) });
  });
  app.post('/api/secrets/:name/rename', (req, res) => {
    const result = vault.rename(req.params.name, (req.body || {}).to, { source: 'http' });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true, entry: meta(result.entry) });
  });
  app.delete('/api/secrets/:name', (req, res) => {
    const result = vault.remove(req.params.name, { source: 'http' });
    if (result.error) return res.status(result.status || 404).json({ error: result.error });
    res.json(result);
  });
  // Value read for the panel's reveal action only. Named separately from the
  // list route so access logs make the value-touching calls obvious.
  app.get('/api/secrets/:name/value', (req, res) => {
    const result = vault.reveal(req.params.name, { source: 'http' });
    if (result.error) return res.status(result.status || 404).json({ error: result.error });
    res.json({ ok: true, name: result.entry.name, value: result.entry.value });
  });
}

module.exports = { mount, meta };
