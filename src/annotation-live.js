'use strict';

// ── Realtime annotation relay（标注实时操作通道）──
//
// chat-annotate.js 的实时操作模式：用户在标注器上画完一个标记的瞬间
// （不必点「插入」、不必发送）POST /api/annotation-live。这里按
// annotation-live.json 把标注转发给匹配的本地处理器（HTTP webhook），
// 处理器决定动作（demo 滑块、CDP 拖动、任意自定义目标）。
//
//   [{ "match": { "session": "multicc-qoder-chat-01", "src": "demo-shot" },
//      "url": "http://127.0.0.1:8899/annotation" }]
//
// match.session / match.src 是正则（缺省或空串 = 全匹配）。无配置、无命中
// 或处理器不可达时静默忽略——不落盘、不产生聊天消息、不影响常规标注。
// 与 /api/secrets 同一 localhost-trusted 信任模型（同源 POST，无 token）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createPaths } = require('./paths');

const paths = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const CONFIG = paths.root === paths.pkgRoot
  ? path.join(os.homedir(), '.multicc', 'annotation-live.json')
  : path.join(paths.root, 'annotation-live.json');

let cacheMtime = 0;
let cacheTargets = null;

// 配置热更新：mtime 未变走缓存；ENOENT / 损坏 JSON = 通道关闭（空表）。
// 自定义 configPath（单测）不走、也不污染生产缓存。
function loadTargets(configPath = CONFIG) {
  try {
    const st = fs.statSync(configPath);
    if (configPath === CONFIG && cacheTargets && cacheMtime === st.mtimeMs) return cacheTargets;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const list = Array.isArray(raw)
      ? raw.filter(t => t && typeof t.url === 'string' && /^https?:\/\//.test(t.url))
      : [];
    if (configPath === CONFIG) { cacheMtime = st.mtimeMs; cacheTargets = list; }
    return list;
  } catch {
    if (configPath === CONFIG) { cacheTargets = []; cacheMtime = 0; }
    return [];
  }
}

function regexOk(pattern, value) {
  if (pattern == null || pattern === '') return true;
  try { return new RegExp(pattern).test(value); } catch { return false; }
}

function relayTargets({ sessionId, src }, configPath = CONFIG) {
  return loadTargets(configPath).filter(t => {
    const m = t.match || {};
    return regexOk(m.session, String(sessionId || '')) && regexOk(m.src, String(src || ''));
  });
}

function mount(app) {
  app.get('/api/annotation-live', (req, res) => {
    res.json({ config: CONFIG, targets: loadTargets() });
  });
  app.post('/api/annotation-live', (req, res) => {
    const body = req.body || {};
    const payload = {
      sessionId: String(body.sessionId || ''),
      src: String(body.src || ''),
      width: Number(body.width) || 0,
      height: Number(body.height) || 0,
      kind: String(body.kind || ''),
      a: body.a || null,
      b: body.b || null,
    };
    const hits = relayTargets(payload);
    res.json({ ok: true, relayed: hits.length });
    if (!hits.length) return;
    for (const t of hits) {
      // Fire-and-forget：处理器离线/出错不影响标注器与回复。
      fetch(t.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }
  });
}

module.exports = {
  mount,
  CONFIG,
  relayTargets,
  loadTargets,
  _resetForTests() { cacheMtime = 0; cacheTargets = null; },
};
