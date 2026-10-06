'use strict';

// ── Desktop host：这台机器上的桌面 Agent 是谁、能做什么 ──
//
// 「🖥 屏幕」的能力不来自 MultiCC 自己，而来自本机装的那个 desktop agent。
// 这里是唯一回答「能做什么」和「这件事怎么做」的地方，remote-screen.js 只消费它：
//   · profile —— 每个 OS 一份画像：传输方式、agent socket、功能矩阵、键盘修饰键
//   · macOS 独有的三件壳外调用（逻辑尺寸 / 图像处理 / 唤屏）收在这里
//
// 现在有 macOS（scripts/macos-agent/MultiCCAgent.swift）和 Linux X11
// （scripts/linux-agent/）两份 agent。Windows 还是 supported:false：路由因此干净地
// 回 platform-unsupported，前端据此把 🖥 收起来，而不是每个请求去连一个不存在的
// 管道。等 C# agent 落地，改的是这里的画像，不是路由。
//
// Agent 必须实现的 op ABI、传输约定和护栏要求见 docs/desktop-agent-protocol.md。

const os = require('os');
const path = require('path');

// 功能矩阵是前端与路由的判断依据：只按这里的名字判断，不按平台名判断。
const NO_FEATURES = Object.freeze({ view: false, control: false, snapshot: false, annotate: false, stream: false, wake: false, unlock: false, elementTree: false });
const MAC_FEATURES = Object.freeze({ view: true, control: true, snapshot: true, annotate: true, stream: true, wake: true, unlock: true, elementTree: true });
// Linux v1 没有 stream（RFB 未做，前端自动回退轮询）、没有 wake（X11 没有「唤屏」
// 这种系统调用，灭屏靠 DPMS，注入本来就会唤醒）、没有 unlock（锁屏是另一个会话的
// 窗口，够不到也不该够到）。elementTree 没有：X11 没有可访问性树 API，拿 AT-SPI
// 要另起一个总线会话，不值得为 v1 背这个包袱。
const LINUX_FEATURES = Object.freeze({ view: true, control: true, snapshot: true, annotate: true, stream: false, wake: false, unlock: false, elementTree: false });

function uid() { return typeof process.getuid === 'function' ? process.getuid() : 0; }

// 画像只描述「这台机器应该怎样」，不发起任何调用。
function profileFor(platform, { home, env = {} } = {}) {
  if (platform === 'darwin') {
    const dir = env.MULTICC_AGENT_DIR || path.join(home, '.multicc', 'agent');
    return {
      platform, label: 'macOS', supported: true, transport: 'unix',
      agentSock: env.MULTICC_AGENT_SOCK || path.join(dir, 'agent.sock'),
      rfbSock: env.MULTICC_AGENT_RFB_SOCK || path.join(dir, 'rfb.sock'),
      features: MAC_FEATURES, modifier: 'cmd',
    };
  }
  if (platform === 'win32') {
    // 计划中的 Windows agent：命名管道 + DXGI Desktop Duplication + SendInput，
    // v1 不做 unlock（安全桌面够不到，见 docs/desktop-agent-protocol.md）。
    return {
      platform, label: 'Windows', supported: false, transport: 'named-pipe',
      agentSock: env.MULTICC_AGENT_PIPE || '\\\\.\\pipe\\multicc-agent',
      rfbSock: null, features: NO_FEATURES, modifier: 'ctrl',
    };
  }
  // Linux agent：X11 走 XShm + XTEST。Wayland 只能走 portal（每次截图/注入都要
  // 用户同意弹窗，而且只给视频流不给帧），v1 不做 —— 但 supported 依然报 true：
  // Wayland 会话里 agent 会因为连不上 X server 而在 status 上明说
  // （no-display + DISPLAY 的值），这比「整个平台不支持」更好排查。
  return {
    platform: 'linux', label: 'Linux', supported: true, transport: 'unix',
    agentSock: env.MULTICC_AGENT_SOCK
      || path.join(env.XDG_RUNTIME_DIR || `/run/user/${uid()}`, 'multicc-agent', 'agent.sock'),
    rfbSock: null, features: LINUX_FEATURES, modifier: 'ctrl',
  };
}

// exec: (cmd, args, timeoutMs) => Promise<string>，由调用方注入（remote-screen.js 传的
// 是包着 deps.execFile 的 run，于是单测照旧只替换 _deps.execFile）。
// call: (req, timeoutMs) => Promise<object>，同样由调用方注入 —— Linux 的截图要走
// agent 的 snap（带 crop），而 agentCall 在 remote-screen.js 里，不进这里就等于
// desktop-host 自己要再实现一遍 socket 客户端。
function createDesktopHost({ platform = process.platform, home = os.homedir(), env = process.env, exec, call } = {}) {
  const profile = profileFor(platform, { home, env });
  const isMac = profile.platform === 'darwin';
  let logical = null;

  function unsupported() {
    return Object.assign(new Error('platform-unsupported'), { status: 503, reason: 'platform-unsupported', platform: profile.platform });
  }
  function assertSupported() { if (!profile.supported) throw unsupported(); }

  // 走错了平台的壳外调用要**响亮地**失败。这些函数看着平台无关，其实每一条都是
  // macOS 命令行工具；在 Linux 上静默调 sips 会得到一个含糊的 ENOENT，比直接说
  // 清楚「这条路在 Linux 上走 captureDirect」难查得多。
  function macOnly(name) {
    return Object.assign(new Error(`${name} 是 macOS 专有实现（调 sips/osascript）；Linux 走 host.captureDirect`),
      { status: 500, reason: 'wrong-platform-helper', platform: profile.platform });
  }

  // 逻辑点尺寸。macOS：Finder 桌面 bounds（与 mcu.sh 同法），失败按 Retina 物理宽 / 2。
  // Linux：**逻辑点 == 像素** —— GNOME/KDE 在 X11 下的缩放是切 XRandR 模式，不是
  // 把一帧更大的图缩下来，两个域本来就是同一个。如实返回物理尺寸，前端那句
  // 「图上 1px = 1pt」才成立（乘任何系数都会让坐标整体偏移）。
  // 只成功取到过才缓存；两个来源都失败时返回 0 且不缓存，下一次会重试。
  async function logicalSize(physW, physH) {
    if (!profile.supported) return { width: 0, height: 0 };
    if (logical) return logical;
    if (!isMac) return (logical = { width: physW > 0 ? physW : 0, height: physH > 0 ? physH : 0 });
    try {
      const out = await exec('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], 4000);
      const [, , w, h] = out.split(',').map(s => parseInt(s, 10));
      if (w > 0 && h > 0) return (logical = { width: w, height: h });
    } catch {}
    if (physW > 0) return (logical = { width: Math.round(physW / 2), height: Math.round(physH / 2) });
    return { width: 0, height: 0 };
  }

  // Linux 的截图：抓屏 →（可选）裁剪 → 编码，全部由 agent 一次做完，落一个文件。
  // 为什么不像 macOS 那样「agent 只落原始 PNG，服务端再拿 sips 裁和转」：X11 上
  // 没有 sips 这种一定在的命令行图像工具，硬要服务端做就得逼用户装 ImageMagick；
  // 而 agent 手里本来就攥着帧缓冲，顺手裁切 + 编码少两次全屏拷贝。
  //
  // 返回值形状与 macOS 那条路一致：width/height 是**整屏**逻辑尺寸（不是裁剪后的），
  // region 是实际生效的裁剪框（逻辑域）—— 前端要靠整屏尺寸把图上的点映射回坐标。
  async function captureDirect(out, region, { session, jpeg = false, quality = 60 } = {}) {
    assertSupported();
    if (typeof call !== 'function') throw Object.assign(new Error('agent-call-missing'), { status: 500 });
    if (isMac) throw macOnly('captureDirect');
    const req = { op: 'snap', path: out, session: session || 'remote-screen', jpeg: !!jpeg, quality };
    if (region) req.crop = { x: region.x, y: region.y, width: region.width, height: region.height };
    const r = await call(req, 15000);
    if (!r || r.ok === false) {
      const reason = (r && r.error) || 'snap-failed';
      // 裁到屏幕外面是调用方的错（400），其余是 agent 侧的问题（502）。
      throw Object.assign(new Error(reason), { status: reason === 'region-outside-screen' ? 400 : 502, agent: r });
    }
    if (r.width > 0 && r.height > 0) logical = { width: r.width, height: r.height };
    return { width: r.width, height: r.height, region: r.crop || null };
  }

  async function imageSize(file) {
    assertSupported();
    if (!isMac) throw macOnly('imageSize');
    const out = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]) || 0;
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]) || 0;
    return { w, h };
  }

  // 先按原生像素裁，再编码：局部放大因此保留原始细节（v2.4.1）。
  async function cropImage(src, area, out) {
    assertSupported();
    if (!isMac) throw macOnly('cropImage');
    await exec('sips', [src, '--cropToHeightWidth', String(area.pixelHeight), String(area.pixelWidth),
      '--cropOffset', String(area.pixelY), String(area.pixelX), '--out', out]);
  }

  async function convertImage(src, out, { jpeg = false, quality = null, resampleWidth = null } = {}) {
    assertSupported();
    if (!isMac) throw macOnly('convertImage');
    const args = ['-s', 'format', jpeg ? 'jpeg' : 'png'];
    if (jpeg && quality != null) args.push('-s', 'formatOptions', String(quality));
    if (resampleWidth) args.push('--resampleWidth', String(resampleWidth));
    await exec('sips', [...args, src, '--out', out]);
  }

  // 唤屏：macOS 是 caffeinate -u；Linux 上没有等价物（X11 的灭屏是 DPMS，
  // 一次 XTest 注入或 XResetScreenSaver 就够，而注入本来就会唤醒）。前端也不该
  // 走到这里 —— features.wake 已经是 false，路由会把按钮收起来。
  async function wakeDisplay() {
    assertSupported();
    if (!isMac) throw macOnly('wakeDisplay');
    await exec('/usr/bin/caffeinate', ['-u', '-t', '1'], 3000);
  }

  // 已缓存的主屏逻辑尺寸（出过帧之后才非空）；标注换算需要它，且不能再触发一次采样。
  function cachedLogicalSize() { return logical; }
  function reset() { logical = null; }

  function info() {
    return {
      ok: true, platform: profile.platform, label: profile.label, supported: profile.supported,
      transport: profile.transport, features: { ...profile.features }, modifier: profile.modifier,
      reason: profile.supported ? null : 'platform-unsupported',
    };
  }

  // captureDirect 只在非 macOS 上挂出来：调用方用它的**有无**判断走哪条截图路，
  // 所以 macOS 上必须真的没有，而不是挂一个「调用就抛」的壳 —— 后者会让
  // `if (host.captureDirect)` 这个判断在 macOS 上永远为真。
  return {
    profile, info, assertSupported, logicalSize, cachedLogicalSize,
    imageSize, cropImage, convertImage, wakeDisplay,
    captureDirect: isMac ? undefined : captureDirect,
    reset, unsupported,
  };
}

module.exports = { createDesktopHost, profileFor, NO_FEATURES, MAC_FEATURES, LINUX_FEATURES };
