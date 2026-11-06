'use strict';

// ── Remote screen（轻量远程协助）：唯一实现是 Rust 进程 multicc-remote ──
//
// server.js / connection-router / annotation-live 只 require 本文件；这里不做任何选择，
// 直接转发到 src/remote-screen-rust.js：启动并看护 native/remote 的 multicc-remote
// 进程（契约见 docs/remote-screen-process.md），鉴权后把 HTTP / WS 原样转过去。
//
// 迁移前的 Node 回退实现（remote-screen-node.js 及其依赖）已整块删除：远控只有一种
// 实现。历史配置项 MULTICC_REMOTE_SCREEN_BACKEND 不再读取 —— 旧配置里残留的 node
// 值一律忽略，实际行为始终是 Rust。

module.exports = require('./remote-screen-rust');
