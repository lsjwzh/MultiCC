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
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { createPaths } = require('./paths');
const { parseRegion, cropGeometry } = require('./remote-screen-region');

const SESSION = 'remote-screen';
// 落在已登记的 assistDir 下：随数据根隔离，并由 assist-snapshots 的 7 天清理兜底。
const DIR = path.join(createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).assistDir, SESSION);
const SOCK = process.env.MULTICC_AGENT_SOCK || path.join(os.homedir(), '.multicc', 'agent', 'agent.sock');
// 流式模式：Agent 的第二个 unix socket 上跑最小 RFB 3.8 服务（见 MultiCCAgent.swift
// 的 RFB streaming server 一节）。浏览器跑原版 noVNC，经 /ws/remote-screen 到这里，
// 再桥到 rfb.sock；鉴权在 WS 层（同 /ws/chat 的 ws-ticket），Agent 侧 getpeereid
// 校验同 uid。Agent 未带该 socket（旧版本 / macOS<14）时连接失败，前端回退轮询。
const RFB_SOCK = process.env.MULTICC_AGENT_RFB_SOCK || path.join(path.dirname(SOCK), 'rfb.sock');
const INPUT_OPS = new Set(['click', 'move', 'scroll', 'drag', 'type', 'press', 'release', 'resume', 'status']);
const KEEP_SHOTS = 20;

const deps = { agentCall, execFile, sock: SOCK, rfbSock: RFB_SOCK, dir: DIR };

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

// 逻辑点尺寸：Finder 桌面 bounds（与 mcu.sh 同法），失败按 Retina 物理宽 / 2。
let logical = null;
async function logicalSize(physW, physH) {
  if (logical) return logical;
  try {
    const out = await run('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], 4000);
    const [, , w, h] = out.split(',').map(s => parseInt(s, 10));
    if (w > 0 && h > 0) return (logical = { width: w, height: h });
  } catch {}
  if (physW > 0) return (logical = { width: Math.round(physW / 2), height: Math.round(physH / 2) });
  return { width: 0, height: 0 };
}

async function pngSize(file) {
  const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]) || 0;
  const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]) || 0;
  return { w, h };
}

// Crop the lossless native screenshot FIRST; only full-screen frames are
// downsampled to logical size. Each capture owns its files (frame/snapshot
// requests may overlap), and region frames keep Retina pixels at JPEG 85.
async function capture(out, region = null) {
  fs.mkdirSync(deps.dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(deps.dir, '.capture-'));
  try {
    const raw = path.join(work, 'raw.png');
    const r = await call({ op: 'snap', path: raw, session: SESSION }, 10000);
    if (!r || r.ok === false) throw Object.assign(new Error(r?.error || 'snap-failed'), { agent: r });
    const phys = await pngSize(raw);
    const size = await logicalSize(phys.w, phys.h);
    let source = raw, area = null;
    if (region) {
      area = cropGeometry(region, size, phys);
      source = path.join(work, 'crop.png');
      await run('sips', [raw, '--cropToHeightWidth', String(area.pixelHeight), String(area.pixelWidth),
        '--cropOffset', String(area.pixelY), String(area.pixelX), '--out', source]);
    }
    const jpeg = /\.jpe?g$/i.test(out);
    const args = ['-s', 'format', jpeg ? 'jpeg' : 'png'];
    if (jpeg) args.push('-s', 'formatOptions', region ? '85' : '60');
    if (!region && size.width && size.width < phys.w) args.push('--resampleWidth', String(size.width));
    await run('sips', [...args, source, '--out', out]);
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

// WS ↔ RFB unix socket 字节管道。双向直通，任一端断即拆另一端；Agent 侧不可用时
// 以 1011 关闭让 noVNC 触发 disconnect → 前端回退 JPEG 轮询。
function attachRfb(ws) {
  const sock = net.createConnection(deps.rfbSock);
  const pending = [];
  let open = false;
  ws.on('message', data => { if (open) sock.write(data); else pending.push(data); });
  sock.on('connect', () => { open = true; for (const d of pending) sock.write(d); pending.length = 0; });
  sock.on('data', d => { if (ws.readyState === 1) ws.send(d); else sock.destroy(); });
  const die = () => {
    sock.destroy();
    if (ws.readyState === 1) { try { ws.close(1011, 'rfb-unavailable'); } catch {} }
  };
  sock.on('error', die);
  sock.on('close', die);
  ws.on('close', () => sock.destroy());
  ws.on('error', () => sock.destroy());
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
  const size = region || logical || { width: Number(payload.width) || 0, height: Number(payload.height) || 0 };
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
    call, wakeDisplay: () => run('/usr/bin/caffeinate', ['-u', '-t', '1'], 3000),
    invalidate: () => { lastFrame = null; },
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
  _deps: deps,
  _resetForTests() { logical = null; inflight.clear(); lastFrame = null; },
};
