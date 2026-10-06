'use strict';

// ── Desktop host：这台机器上的桌面 Agent 是谁、能做什么 ──
//
// 「🖥 屏幕」的能力不来自 MultiCC 自己，而来自本机装的那个 desktop agent。
// 这里是唯一回答「能做什么」和「这件事怎么做」的地方，remote-screen.js 只消费它：
//   · profile —— 每个 OS 一份画像：传输方式、agent socket、功能矩阵、键盘修饰键
//   · macOS 独有的三件壳外调用（逻辑尺寸 / 图像处理 / 唤屏）收在这里
//
// 现在只有 macOS 有 agent（scripts/macos-agent/MultiCCAgent.swift）。win32 / linux
// 先如实登记成 supported:false：路由因此干净地回 platform-unsupported，前端据此
// 把 🖥 收起来，而不是每个请求去连一个不存在的 socket。等 Windows(C#) / Linux(X11)
// 的 agent 落地，改的是这里的画像和同目录下的实现，不是路由。
//
// Agent 必须实现的 op ABI、传输约定和护栏要求见 docs/desktop-agent-protocol.md。

const os = require('os');
const path = require('path');

// 功能矩阵是前端与路由的判断依据：只按这里的名字判断，不按平台名判断。
const NO_FEATURES = Object.freeze({ view: false, control: false, snapshot: false, annotate: false, stream: false, wake: false, unlock: false, elementTree: false });
const MAC_FEATURES = Object.freeze({ view: true, control: true, snapshot: true, annotate: true, stream: true, wake: true, unlock: true, elementTree: true });

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
  // 计划中的 Linux agent：X11 走 XShm + XTEST；Wayland 只能走 portal（带用户同意弹窗）。
  return {
    platform: 'linux', label: 'Linux', supported: false, transport: 'unix',
    agentSock: env.MULTICC_AGENT_SOCK
      || path.join(env.XDG_RUNTIME_DIR || `/run/user/${uid()}`, 'multicc-agent', 'agent.sock'),
    rfbSock: null, features: NO_FEATURES, modifier: 'ctrl',
  };
}

// exec: (cmd, args, timeoutMs) => Promise<string>，由调用方注入（remote-screen.js 传的
// 是包着 deps.execFile 的 run，于是单测照旧只替换 _deps.execFile）。
function createDesktopHost({ platform = process.platform, home = os.homedir(), env = process.env, exec } = {}) {
  const profile = profileFor(platform, { home, env });
  let logical = null;

  function unsupported() {
    return Object.assign(new Error('platform-unsupported'), { status: 503, reason: 'platform-unsupported', platform: profile.platform });
  }
  function assertSupported() { if (!profile.supported) throw unsupported(); }

  // 逻辑点尺寸：Finder 桌面 bounds（与 mcu.sh 同法），失败按 Retina 物理宽 / 2。
  // 只成功取到过才缓存；两个来源都失败时返回 0 且不缓存，下一次会重试。
  async function logicalSize(physW, physH) {
    if (!profile.supported) return { width: 0, height: 0 };
    if (logical) return logical;
    try {
      const out = await exec('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], 4000);
      const [, , w, h] = out.split(',').map(s => parseInt(s, 10));
      if (w > 0 && h > 0) return (logical = { width: w, height: h });
    } catch {}
    if (physW > 0) return (logical = { width: Math.round(physW / 2), height: Math.round(physH / 2) });
    return { width: 0, height: 0 };
  }

  async function imageSize(file) {
    assertSupported();
    const out = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]) || 0;
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]) || 0;
    return { w, h };
  }

  // 先按原生像素裁，再编码：局部放大因此保留原始细节（v2.4.1）。
  async function cropImage(src, area, out) {
    assertSupported();
    await exec('sips', [src, '--cropToHeightWidth', String(area.pixelHeight), String(area.pixelWidth),
      '--cropOffset', String(area.pixelY), String(area.pixelX), '--out', out]);
  }

  async function convertImage(src, out, { jpeg = false, quality = null, resampleWidth = null } = {}) {
    assertSupported();
    const args = ['-s', 'format', jpeg ? 'jpeg' : 'png'];
    if (jpeg && quality != null) args.push('-s', 'formatOptions', String(quality));
    if (resampleWidth) args.push('--resampleWidth', String(resampleWidth));
    await exec('sips', [...args, src, '--out', out]);
  }

  async function wakeDisplay() {
    assertSupported();
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

  return { profile, info, assertSupported, logicalSize, cachedLogicalSize, imageSize, cropImage, convertImage, wakeDisplay, reset, unsupported };
}

module.exports = { createDesktopHost, profileFor, NO_FEATURES, MAC_FEATURES };
