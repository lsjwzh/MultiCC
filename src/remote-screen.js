'use strict';

// ── Remote screen（轻量远程协助）──
//
// 聊天页「🖥 屏幕」浮层的服务端：看屏、操作、冻结一帧去标注。不引入 VNC/
// RustDesk——截图和输入的系统授权都已在 MultiCC Agent 里，这里只是把它的
// socket 协议（一行 JSON 进、一行 JSON 出）接成三条 HTTP 路由：
//
//   GET  /api/remote-screen/frame     主屏 JPEG，宽 = 逻辑点宽（图上 1px = 1pt，
//                                     前端坐标无需换算）；并发请求共用一次截图
//   POST /api/remote-screen/input     { op, ... }，op 白名单见 INPUT_OPS
//   POST /api/remote-screen/snapshot  冻结一帧 → { path, url }，交给标注器
//
// 标注器对 assist/remote-screen/ 下的截图画的标记由 annotation-live 直接转到
// handleAnnotation（不查 annotation-live.json）：点 = 单击、框 = 点框中心、
// 箭头 = 拖动、重新截 = 重拍；执行后把新画面写回同一文件，标注器原地刷新。
//
// 安全边界：与全站同一鉴权（远程访问要 ACCESS_TOKEN）；输入固定挂在
// 'remote-screen' 会话租约下，Agent 的锁屏拒绝 / Esc 急停 / 受保护 App 护栏
// 全部照旧生效；普通输入不开放 unlock，唤起屏幕走独立的开关校验接口。

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const { createPaths } = require('./paths');
const { parseRegion, cropGeometry } = require('./remote-screen-region');
const { createDesktopHost } = require('./desktop-host');

const SESSION = 'remote-screen';
// 落在已登记的 assistDir 下：随数据根隔离，并由 assist-snapshots 的 7 天清理兜底。
const DIR = path.join(createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).assistDir, SESSION);
// 「这台机器上的 agent 是谁、能做什么」全在 desktop-host 里；socket 路径也从画像来。
// 流式模式：Agent 的第二个 socket 上跑最小 RFB 3.8 服务（见 MultiCCAgent.swift 的
// RFB streaming server 一节）。浏览器跑原版 noVNC，经 /ws/remote-screen 到这里，
// 再桥到 rfb.sock；鉴权在 WS 层（同 /ws/chat 的 ws-ticket），Agent 侧 getpeereid
// 校验同 uid。Agent 未带该 socket（旧版本 / macOS<14）时连接失败，前端回退轮询。
const INPUT_OPS = new Set(['click', 'move', 'scroll', 'drag', 'type', 'press', 'release', 'resume', 'status']);
const KEEP_SHOTS = 20;

const deps = { agentCall, execFile, sock: null, rfbSock: null, dir: DIR };

function agentCall(req, timeoutMs = 8000) {
  return new Promise(resolve => {
    let buf = '';
    let settled = false;
    const done = value => { if (!settled) { settled = true; sock.destroy(); resolve(value); } };
    const sock = net.createConnection(deps.sock);
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'agent-timeout' }));
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try { done(JSON.parse(buf.slice(0, nl))); } catch { done({ ok: false, error: 'agent-bad-response' }); }
    });
    sock.on('error', error => done({ ok: false, error: 'agent-unreachable', detail: error.code || error.message }));
    sock.on('end', () => done({ ok: false, error: 'agent-closed' }));
  });
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    deps.execFile(cmd, args, { timeout, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function call(req, timeoutMs) { return deps.agentCall(req, timeoutMs); }

// 本机 desktop agent 的画像 + 平台相关的壳外调用（逻辑尺寸 / 图像处理 / 唤屏）全在
// desktop-host.js：以后加 Windows/Linux agent 改的是那里，不是这里。挂在 deps 上，
// 单测可以整体换掉一个假 host。
// call 也注入进去：Linux 的截图要走 agent 的 snap（抓屏 + 裁剪 + 编码一次做完），
// 而 agentCall 就在这里 —— 不注入的话 desktop-host 得自己再实现一遍 socket 客户端。
deps.host = createDesktopHost({ exec: run, call });
deps.sock = deps.host.profile.agentSock;
deps.rfbSock = deps.host.profile.rfbSock;

// Crop the lossless native screenshot FIRST; only full-screen frames are
// downsampled to logical size. Each capture owns its files (frame/snapshot
// requests may overlap), and region frames keep Retina pixels at JPEG 85.
async function capture(out, region = null) {
  deps.host.assertSupported();
  const wantJpeg = /\.jpe?g$/i.test(out);
  // Linux：agent 一次做完抓屏 + 裁剪 + 编码。macOS 那条路要分四步（snap → sips 量
  // 尺寸 → sips 裁 → sips 转），因为 macOS 的 agent 只给无损原始 PNG。
  if (deps.host.captureDirect) {
    return deps.host.captureDirect(out, region, { session: SESSION, jpeg: wantJpeg, quality: region ? 85 : 60 });
  }
  fs.mkdirSync(deps.dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(deps.dir, '.capture-'));
  try {
    const raw = path.join(work, 'raw.png');
    const r = await call({ op: 'snap', path: raw, session: SESSION }, 10000);
    if (!r || r.ok === false) throw Object.assign(new Error(r?.error || 'snap-failed'), { agent: r });
    const phys = await deps.host.imageSize(raw);
    const size = await deps.host.logicalSize(phys.w, phys.h);
    let source = raw, area = null;
    if (region) {
      area = cropGeometry(region, size, phys);
      source = path.join(work, 'crop.png');
      await deps.host.cropImage(raw, area, source);
    }
    await deps.host.convertImage(source, out, {
      jpeg: wantJpeg,
      quality: region ? 85 : 60,
      resampleWidth: !region && size.width && size.width < phys.w ? size.width : null,
    });
    return { width: size.width || phys.w, height: size.height || phys.h, region: area };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

const inflight = new Map();
let lastFrame = null;
function frame(region = null) {
  const key = JSON.stringify(region);
  if (lastFrame?.key === key && Date.now() - lastFrame.at < 120) return Promise.resolve(lastFrame);
  if (inflight.has(key)) return inflight.get(key);
  // Output files cannot be shared across different selections or snapshots.
  fs.mkdirSync(deps.dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(deps.dir, '.frame-'));
  const out = path.join(work, 'live.jpg');
  const pending = capture(out, region)
    .then(size => (lastFrame = { key, at: Date.now(), size, data: fs.readFileSync(out) }))
    .finally(() => { inflight.delete(key); fs.rmSync(work, { recursive: true, force: true }); });
  inflight.set(key, pending);
  return pending;
}

// Byte-preserving bridge with bounded queues and stalled-stream recovery.
function attachRfb(ws) {
  require('./remote-screen-rfb-bridge').attachRfbBridge(ws, { socketPath: deps.rfbSock });
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// 前端字段 → Agent 请求。只拼白名单 op 认识的字段，并强制转型。
function buildInput(body = {}) {
  const op = String(body.op || '');
  if (!INPUT_OPS.has(op)) return { error: `op not allowed: ${op || '(empty)'}` };
  const req = { op, session: SESSION };
  if (['click', 'move', 'scroll', 'drag'].includes(op)) {
    const x = num(body.x), y = num(body.y);
    if (x == null || y == null) return { error: 'x and y are required' };
    Object.assign(req, { x, y, allowSystem: true });
  }
  if (op === 'click') {
    if (body.button === 'right') req.button = 'right';
    req.count = Math.max(1, Math.min(3, num(body.count) || 1));
  }
  if (op === 'scroll') req.amount = Math.max(-50, Math.min(50, Math.round(num(body.amount) || 0)));
  if (op === 'drag') {
    const x2 = num(body.x2), y2 = num(body.y2);
    if (x2 == null || y2 == null) return { error: 'x2 and y2 are required' };
    Object.assign(req, { x2, y2, ms: Math.max(80, Math.min(3000, num(body.ms) || 300)) });
  }
  if (op === 'type') {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text || text.length > 4000) return { error: 'text is required (max 4000 chars)' };
    Object.assign(req, { text, allowTerminal: true, allowSystem: true });
  }
  if (op === 'press') {
    const keys = typeof body.keys === 'string' ? body.keys.trim() : '';
    if (!keys || keys.length > 40) return { error: 'keys is required, e.g. cmd+c' };
    Object.assign(req, { keys, allowTerminal: true, allowSystem: true });
  }
  return { req };
}

function pruneShots() {
  try {
    const shots = fs.readdirSync(deps.dir).filter(f => /^shot-\d+\.png$/.test(f)).sort();
    for (const f of shots.slice(0, Math.max(0, shots.length - KEEP_SHOTS))) {
      fs.rmSync(path.join(deps.dir, f), { force: true });
      fs.rmSync(path.join(deps.dir, f + '.json'), { force: true });
    }
  } catch {}
}

async function snapshot(region = null) {
  const file = path.join(deps.dir, `shot-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}.png`);
  const size = await capture(file, region);
  if (size.region) fs.writeFileSync(file + '.json', JSON.stringify(size.region));
  pruneShots();
  return { ok: true, path: file, ...size, url: `/api/download?path=${encodeURIComponent(file)}&inline=1` };
}

function isOwnShot(src) {
  const file = path.resolve(String(src || ''));
  return path.dirname(file) === path.resolve(deps.dir) && /^shot-\d+\.png$/.test(path.basename(file));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 标注 → 动作。a/b 是图内像素；选区使用持久化的逻辑范围与偏移。
async function handleAnnotation(payload = {}) {
  const src = path.resolve(String(payload.src || ''));
  if (!isOwnShot(src)) return { ok: false, refresh: false, text: '不是远程屏幕截图' };
  let region = null;
  try { region = parseRegion(JSON.parse(fs.readFileSync(src + '.json', 'utf8'))); } catch (error) {
    if (error.code !== 'ENOENT') return { ok: false, refresh: false, text: '选区坐标记录无效，请重新截取' };
  }
  const size = region || deps.host.cachedLogicalSize() || { width: Number(payload.width) || 0, height: Number(payload.height) || 0 };
  const scaleX = payload.width > 0 ? size.width / payload.width : 1;
  const scaleY = payload.height > 0 ? size.height / payload.height : scaleX;
  const pt = p => p && { x: Math.round((region?.x || 0) + Number(p.x) * scaleX),
    y: Math.round((region?.y || 0) + Number(p.y) * scaleY) };
  const a = pt(payload.a), b = pt(payload.b);
  let req = null;
  let text = '';
  if (payload.kind === 'point' && a) { req = { op: 'click', x: a.x, y: a.y }; text = `已点击 (${a.x}, ${a.y})`; }
  else if (payload.kind === 'box' && a && b) {
    const c = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
    req = { op: 'click', x: c.x, y: c.y }; text = `已点击框中心 (${c.x}, ${c.y})`;
  } else if (payload.kind === 'arrow' && a && b) {
    req = { op: 'drag', x: a.x, y: a.y, x2: b.x, y2: b.y, ms: 400 }; text = `已拖动 (${a.x}, ${a.y}) → (${b.x}, ${b.y})`;
  } else if (payload.kind !== 'recapture') return { ok: false, refresh: false, text: `不支持的标注：${payload.kind}` };
  if (req) {
    const built = buildInput(req);
    if (built.error) return { ok: false, refresh: false, text: built.error };
    const r = await call(built.req);
    if (!r || r.ok === false) return { ok: false, refresh: false, text: `未执行：${describe(r)}` };
    await sleep(350);
  }
  try { await capture(src, region); } catch (error) { return { ok: !!req, refresh: false, text: `${text || '重拍'}；重拍失败：${error.message}` }; }
  return { ok: true, refresh: true, text: text || '已重新截取' };
}

const REASONS = {
  'screen-locked': '屏幕已锁定',
  'user-stopped': '本机按了 Esc 急停，需先「恢复」',
  busy: '另一个会话正在操作电脑',
  'protected-app': '目标是受保护的 App（密码 / 系统设置），需本人操作',
  'accessibility-not-granted': 'MultiCC Agent 未获辅助功能授权',
  'screen-recording-not-granted': 'MultiCC Agent 未获屏幕录制授权',
  'agent-unreachable': 'MultiCC Agent 未运行',
  'platform-unsupported': '这台机器上的桌面 Agent 还不支持远程屏幕',
};
function describe(r) {
  const code = r?.reason || r?.error || 'unknown';
  return REASONS[code] || r?.hint || r?.message || code;
}

function sendError(res, error, status = 502) {
  const agent = error.agent || {};
  res.status(error.status || status).json({ ok: false, error: agent.reason || agent.error || error.message, message: describe(agent.error || agent.reason ? agent : { error: error.message }) });
}

function mount(app) {
  require('./remote-screen-wake').mountWakeRoutes(app, {
    call, wakeDisplay: () => deps.host.wakeDisplay(),
    // 用 features.wake，不是 profile.supported：唤屏是 macOS 专有的系统动作
    // （caffeinate -u），Linux 上 supported 是 true 但根本没有这件事可做。
    // 判成 supported 的话，前端会显示一个「唤起屏幕」按钮，点下去永远报
    // auto-unlock-disabled —— 一个从按钮文字上完全看不出原因的失败。
    supported: () => deps.host.profile.features.wake,
    invalidate: () => { lastFrame = null; },
  });
  // 前端据此决定显不显示 🖥、快捷键行出 ⌘ 还是 Ctrl。平台画像进程内不变，所以这是个
  // 常量回答；agent 装没装不在这里判断——那由各路由真实失败时回各自的 reason。
  app.get('/api/remote-screen/capabilities', (_req, res) => {
    res.set({ 'Cache-Control': 'no-store' });
    res.json(deps.host.info());
  });
  app.get('/api/remote-screen/frame', async (req, res) => {
    try {
      const f = await frame(parseRegion(req.query));
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Screen-Width': String(f.size.width), 'X-Screen-Height': String(f.size.height) });
      if (f.size.region) {
        const r = f.size.region;
        res.set({ 'X-Region-X': String(r.x), 'X-Region-Y': String(r.y),
          'X-Region-Width': String(r.width), 'X-Region-Height': String(r.height) });
      }
      res.end(f.data);
    } catch (error) { sendError(res, error); }
  });
  app.post('/api/remote-screen/input', async (req, res) => {
    const built = buildInput(req.body || {});
    if (built.error) { res.status(400).json({ ok: false, error: built.error }); return; }
    if (!deps.host.profile.supported) { sendError(res, deps.host.unsupported()); return; }
    const r = await call(built.req);
    if (!r || r.ok === false) { res.json({ ok: false, error: r?.reason || r?.error, message: describe(r) }); return; }
    lastFrame = null;
    res.json(r);
  });
  app.post('/api/remote-screen/snapshot', async (req, res) => {
    try { res.json(await snapshot(parseRegion(req.body))); } catch (error) { sendError(res, error); }
  });
}

module.exports = {
  mount,
  attachRfb,
  handleAnnotation,
  isOwnShot,
  buildInput,
  agentCall,
  DIR,
  capabilities: () => deps.host.info(),
  _deps: deps,
  _resetForTests() { deps.host.reset(); inflight.clear(); lastFrame = null; },
};
