'use strict';

// ── Remote screen（轻量远程协助）：后端选择层 ──
//
// 「🖥 屏幕」有两套实现，接口一致：
//   1. rust（默认）：src/remote-screen-rust.js —— 看护并转发到独立进程 multicc-remote
//      （native/remote/，契约见 docs/remote-screen-process.md）；
//   2. node（回退）：src/remote-screen-node.js —— 迁移前那份 Node 实现原样保留。
//
// 为什么保留两套：Rust 进程在部分平台/机器上可能编不出来或运行不起来，用户需要一条
// 不需要 Rust 工具链的退路；它同时是 Node/Rust 行为差分测试的参照实现。这是迁移期的
// 临时债，不是长期架构：等 Rust 版在发布平台稳定、设置里的切换入口撤掉之后，node 这
// 一路连同 remote-screen-node.js 及其依赖整块删除（删除条件写在该文件头）。
//
// 选择只发生在模块加载时（进程启动时读一次环境变量）：切换后端只写配置文件，不热切换、
// 不重启服务，必须手动重启才生效 —— 与 CPR 后端开关同一套语义。读取 process.env 的
// 原因也一样：server.js 启动时已把宿主 .env 载入 process.env（见 server.js 顶部），
// CPR 的 currentBackend 也是这么来的；写配置则走 host-env 的 writeEnvFile。
//
// 只 require 被选中的那一套：选 node 时绝不加载/启动 multicc-remote，选 rust 时不会
// require werift（它只在 Node 回退版的 P2P 路径里用）。

const VALID_BACKENDS = new Set(['rust', 'node']);
const DEFAULT_BACKEND = 'rust';
// 两套实现都有的调用面（server.js / connection-router / annotation-live 只该看到这些）。
// 后端私有的辅助（如 Node 版的 buildInput / agentCall、Rust 版的 _remoteBinary）留在
// 各自的实现模块上，不混进这条选择层的契约。
const CONTRACT_EXPORTS = Object.freeze([
  'mount', 'attachRfb', 'attachH264', 'handleAnnotation', 'isOwnShot',
  'capabilities', 'DIR', '_deps', '_resetForTests',
]);

// 非法值按默认（rust）处理并留一行 warn：配置写错了不该让整个「🖥 屏幕」不可用。
function resolveBackend(env = process.env) {
  const raw = String(env.MULTICC_REMOTE_SCREEN_BACKEND ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_BACKEND;
  if (VALID_BACKENDS.has(raw)) return raw;
  console.warn(`[multicc] 远程屏幕后端配置无效（MULTICC_REMOTE_SCREEN_BACKEND 只能是 rust 或 node），已按 ${DEFAULT_BACKEND} 处理`);
  return DEFAULT_BACKEND;
}

const backend = resolveBackend();
const implementation = backend === 'node'
  ? require('./remote-screen-node')
  : require('./remote-screen-rust');

// Node 回退版没有进程看护状态，也没有 Rust 版的「不可用能力」常量；补齐成同一形状，
// 免得调用方（和测试）按 backend 分支。
function nodeState() {
  return { backend: 'node', pid: null, ready: null, attempts: 0, backoffMs: 0, restartPending: false, lastError: null };
}
function unavailableCapabilities() {
  return {
    ok: true, supported: false, reason: 'remote-unavailable',
    features: { view: false, control: false, snapshot: false, annotate: false,
      stream: false, wake: false, unlock: false, elementTree: false },
    streams: { h264: false, rfb: false },
  };
}

const exported = {};
for (const name of CONTRACT_EXPORTS) exported[name] = implementation[name];
exported._state = typeof implementation._state === 'function' ? implementation._state : nodeState;
exported._unavailableCapabilities = typeof implementation._unavailableCapabilities === 'function'
  ? implementation._unavailableCapabilities : unavailableCapabilities;
// 实际生效的后端（不是配置值）：设置路由用它报告 currentBackend。
exported.backend = backend;

module.exports = exported;
