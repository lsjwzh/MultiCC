'use strict';

const path = require('node:path');
let loadedPath = null;
let loaded = null;
let loadError = null;
const counts = { search: 0, usage: 0, fallbacks: 0 };
const warned = new Set();

function modeFor(feature, override) {
  const mode = override || process.env[`MULTICC_RUST_${feature.toUpperCase()}`]
    || process.env.MULTICC_RUST_BACKEND || 'auto';
  if (['off', 'node'].includes(mode)) return 'node';
  if (['required', 'rust'].includes(mode)) return 'rust';
  if (mode !== 'auto') throw new Error('invalid_rust_backend_mode');
  return mode;
}
function addonPath() {
  return process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../../native/prebuilt'),
    `${process.platform}-${process.arch}`, 'multicc_core.node');
}
function getNative(feature, override) {
  const mode = modeFor(feature, override);
  if (mode === 'node') return null;
  const file = addonPath();
  if (file !== loadedPath) {
    loadedPath = file;
    loaded = null;
    loadError = null;
    try {
      loaded = require(file);
      if (loaded.protocolVersion?.() !== 1 || typeof loaded.buildSearchIndex !== 'function'
          || typeof loaded.computeUsage !== 'function') throw new Error('rust_protocol_mismatch');
    } catch (error) { loaded = null; loadError = error.code || 'rust_load_failed'; }
  }
  if (!loaded && mode === 'rust') throw new Error('rust_backend_unavailable');
  return loaded;
}
function fallback(feature, override, error) {
  if (modeFor(feature, override) === 'rust') throw error;
  counts.fallbacks += 1;
  if (!warned.has(feature)) {
    warned.add(feature);
    // 不输出扫描路径、输入正文或原生错误携带的用户数据。
    console.warn(`[multicc] ${feature} Rust 路径失败，已回退 Node 实现`);
  }
}
function record(feature) { counts[feature] += 1; }
function status() { return { loaded: !!loaded, loadError, ...counts }; }
// napi 把结构化错误码塞在 message 里，code 统一是 GenericFailure；还原成真实码。
function nativeCode(error) {
  if (error?.code === 'GenericFailure') {
    const code = /^([A-Za-z][A-Za-z0-9_]*)(?::|$)/.exec(String(error.message || ''))?.[1];
    if (code) error.code = code;
  }
  return error;
}

// 原生任务共用 libuv 工作池。限制并行和排队数量，避免搜索突发占满文件 I/O 线程。
let active = 0;
const waiting = [];
function runNative(operation) {
  if (active >= 2 && waiting.length >= 16) return Promise.reject(new Error('rust_queue_full'));
  return new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      Promise.resolve().then(operation).then(resolve, reject).finally(() => {
        active -= 1;
        waiting.shift()?.();
      });
    };
    if (active < 2) start(); else waiting.push(start);
  });
}
module.exports = { getNative, modeFor, fallback, record, status, runNative, nativeCode };
