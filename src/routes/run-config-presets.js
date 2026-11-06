'use strict';

// 运行配置预设（Auto 候选池的「存为预设」）的跨端存储。
// Web 的 localStorage 与 App 的 SharedPreferences 只是缓存；这份 JSON 才是
// 权威，两端打开面板时都用 POST /merge 把本机条目并进来、拿回完整表。
// Rust（native/core/src/run_config_presets.rs）负责校验、归一化与合并；Node
// 这里只做请求解析、文件原子写和状态码映射。
const { atomicWriteJson } = require('../runtime-security');

// 归一化后最多 20 条具名 + 5 条最近；留出余量，超出的请求直接拒绝而不是截断。
const MAX_BODY_ENTRIES = 100;

function mountRunConfigPresetsRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.put !== 'function'
    || typeof app.post !== 'function') {
    throw new TypeError('[run-config-presets] Express-compatible app is required');
  }
  const file = options.file;
  if (!file || typeof file !== 'string') {
    throw new TypeError('[run-config-presets] preset storage file is required');
  }
  const fs = options.fs || require('fs');
  const write = options.write || ((target, value) => atomicWriteJson(target, value));
  // Tests inject a stub; production resolves the same addon every other Rust
  // bridge uses, once per request so a rebuilt addon needs no restart.
  const getNative = options.getNative
    || (() => require('../native/runtime').getNative());

  function unavailable(res) {
    return res.status(503).json({
      error: '运行配置预设接口尚未就绪，请更新原生模块',
      code: 'rust_backend_unavailable',
    });
  }

  function readStored() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed && parsed.presets) ? parsed.presets : [];
    } catch (_) {
      // 文件不存在、内容损坏都按空表处理：预设本来就是可重建的本机数据。
      return [];
    }
  }

  function persist(presets) {
    write(file, { version: 1, presets });
  }

  function presetList(body) {
    const list = body && typeof body === 'object' && !Array.isArray(body) ? body.presets : null;
    if (!Array.isArray(list)) return { error: 'presets 必须是数组' };
    if (list.length > MAX_BODY_ENTRIES) return { error: `presets 最多 ${MAX_BODY_ENTRIES} 条` };
    return { list };
  }

  app.get('/api/run-config/presets', (req, res) => {
    try {
      const native = getNative();
      const normalized = JSON.parse(native.normalizeRunConfigPresets(
        JSON.stringify({ presets: readStored() })));
      return res.json({ ok: true, presets: normalized && Array.isArray(normalized.presets) ? normalized.presets : [] });
    } catch (_) {
      return unavailable(res);
    }
  });

  // 整表替换：客户端的「保存 / 删除」都把完整列表发上来。
  app.put('/api/run-config/presets', (req, res) => {
    let native;
    try { native = getNative(); } catch (_) { return unavailable(res); }
    const parsed = presetList(req.body);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error, code: 'invalid_presets' });
    }
    let normalized;
    try {
      normalized = JSON.parse(native.normalizeRunConfigPresets(JSON.stringify({ presets: parsed.list })));
    } catch (error) {
      return res.status(400).json({
        error: String(error && error.message || '预设格式不正确'),
        code: 'invalid_presets',
      });
    }
    const presets = normalized && Array.isArray(normalized.presets) ? normalized.presets : [];
    try {
      persist(presets);
    } catch (_) {
      return res.status(500).json({ error: '预设保存失败', code: 'preset_store_write_failed' });
    }
    return res.json({ ok: true, presets });
  });

  // 合并：把客户端本机条目并入服务端并返回完整表（首次打开时的迁移路径）。
  app.post('/api/run-config/presets/merge', (req, res) => {
    let native;
    try { native = getNative(); } catch (_) { return unavailable(res); }
    const parsed = presetList(req.body);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error, code: 'invalid_presets' });
    }
    let normalized;
    try {
      normalized = JSON.parse(native.mergeRunConfigPresets(JSON.stringify({
        stored: readStored(),
        incoming: parsed.list,
      })));
    } catch (error) {
      return res.status(400).json({
        error: String(error && error.message || '预设格式不正确'),
        code: 'invalid_presets',
      });
    }
    const presets = normalized && Array.isArray(normalized.presets) ? normalized.presets : [];
    try {
      persist(presets);
    } catch (_) {
      return res.status(500).json({ error: '预设保存失败', code: 'preset_store_write_failed' });
    }
    return res.json({ ok: true, presets });
  });
}

module.exports = { mountRunConfigPresetsRoutes, MAX_BODY_ENTRIES };
